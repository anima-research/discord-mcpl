/**
 * The server owns its persisted files while it runs: a save writes over
 * whatever is at the path then, so to edit or restore one, an operator stops
 * the server first.
 *
 * A file that isn't exactly what its store writes (not JSON, the wrong shape,
 * or entries the store doesn't write) is copied aside first, to
 * `<file>.unreadable-<hash>`, named by its content (or by the time, when a
 * copy of that name already holds other bytes), and then rewritten with the
 * entries its store can use. A file that can't be read at all stays as it
 * is, and nothing saves over it until it's read again.
 *
 * A save replaces a plain file the server owns through a temp file and a
 * rename, so a process crash partway through can't leave a torn file. There's
 * no fsync, so on some filesystems a power loss can still leave it empty. A
 * symlink, a file with other hard links or another owner, a file whose group
 * the temp file can't be given, and a file whose directory or filesystem
 * refuses the temp file or the rename (permissions, a read-only or
 * cross-device mount, an unsupported operation) are written in place, where a
 * crash partway through can tear the file. A full disk fails the save. Extended attributes
 * and a POSIX ACL on the file itself are lost at its first replacement, so a
 * store that needs them should be a symlink to its file, which is written in
 * place.
 */
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { dbg } from './debug-log.js';

const unsaveable = new Map<string, string>();
/** EINVAL is chown's, for a group the user namespace doesn't map. */
const WRITE_IN_PLACE_ON = new Set([
  'EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'ENAMETOOLONG', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL',
]);
const loggedInPlace = new Set<string>();

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

function lstatIfThere(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  const refused = unsaveable.get(path);
  if (refused !== undefined) {
    throw new Error(`${path} ${refused}, so nothing is saved over it until it's read again`);
  }
  const text = JSON.stringify(value, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const old = lstatIfThere(path);
  const ownUid = process.getuid?.();
  // A rename would turn a symlink into a plain file, split a hard link, or
  // take another user's file over, so only a plain file the server owns, with
  // no other name, is replaced.
  if (old && !(old.isFile() && old.nlink === 1 && (ownUid === undefined || old.uid === ownUid))) {
    const why = old.isSymbolicLink()
      ? 'a symlink'
      : !old.isFile()
        ? 'not a plain file'
        : old.nlink > 1
          ? 'other hard links'
          : 'another owner';
    dbg('persisted-json:in-place', { path, why });
    writeFileSync(path, text);
    return;
  }
  if (old) accessSync(path, constants.W_OK);
  const mode = old ? old.mode & 0o7777 : undefined;
  const tmp = `${path}.tmp`;
  try {
    // A stale temp file keeps its own mode and owner, so it's never reused.
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'wx', mode ?? 0o666);
    try {
      // The group and mode go on before the content. The temp file is in the
      // server's group and takes the old file's: for a group the server isn't
      // in that fails (EPERM), and so does one its user namespace doesn't map
      // (EINVAL), so the file is written in place.
      if (old && ownUid !== undefined) fchownSync(fd, ownUid, old.gid);
      // Then the whole mode, which the umask trimmed, after the chown, which
      // clears setuid. Writing the content then clears set-id bits as a
      // write in place would, so the file keeps what an in-place save kept.
      if (mode !== undefined) fchmodSync(fd, mode);
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    const code = errorCode(err) ?? '';
    if (!WRITE_IN_PLACE_ON.has(code)) throw err;
    if (!loggedInPlace.has(path)) {
      loggedInPlace.add(path);
      console.error(
        `[discord-mcpl] Saving ${path} in place, since it can't be replaced (${code}), ` +
          'so a crash partway through a save could tear it. Logged once for this path.',
      );
    }
    dbg('persisted-json:in-place', { path, why: code });
    writeFileSync(path, text);
  }
}

export interface Usable<T> {
  value: T | null;
  unusable: string | null;
}

export const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function usableIds(value: unknown): Usable<string[]> {
  if (!Array.isArray(value)) return { value: null, unusable: 'not a list' };
  const ids = value.filter(isId);
  const others = value.length - ids.length;
  return { value: ids, unusable: others ? `${others} of its ${value.length} entries aren't ids` : null };
}

export interface Read<T> {
  value: T;
  held: boolean;
}

export function readJsonFile<T>(
  path: string,
  what: string,
  usable: (value: unknown) => Usable<T>,
  empty: T,
): Read<T> {
  unsaveable.delete(path);
  let bytes: Buffer;
  let mode: number;
  try {
    const fd = openSync(path, 'r');
    try {
      mode = fstatSync(fd).mode;
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { value: empty, held: true };
    unsaveable.set(path, "couldn't be read");
    console.error(
      `[discord-mcpl] Couldn't read ${what} from ${path} (${(err as Error).message}). ` +
        "Starting with none, and nothing is saved over that file until it's read again.",
    );
    dbg('persisted-json:unreadable', { what, path, error: (err as Error).message });
    return { value: empty, held: false };
  }
  let found: Usable<T>;
  try {
    // An editor's byte-order mark isn't part of the JSON.
    found = usable(JSON.parse(bytes.toString('utf-8').replace(/^\uFEFF/, '')));
  } catch {
    found = { value: null, unusable: 'not valid JSON' }; // JSON.parse's own message quotes the file's text
  }
  if (found.unusable === null && found.value !== null) return { value: found.value, held: true };
  const problem = found.unusable ?? 'nothing it can use';
  const value = found.value ?? empty;
  let aside: string;
  try {
    aside = copyAside(path, bytes, mode & 0o777);
  } catch (err) {
    unsaveable.set(path, "couldn't be copied aside");
    console.error(
      `[discord-mcpl] Couldn't use ${what} in ${path} as it is (${problem}), or copy it aside ` +
        `(${(err as Error).message}). Starting with what it could use, and nothing is saved over that file ` +
        "until it's read again.",
    );
    dbg('persisted-json:copy-failed', { what, path, problem, error: (err as Error).message });
    return { value, held: false };
  }
  try {
    writeJsonFile(path, value);
  } catch (err) {
    unsaveable.set(path, "couldn't be rewritten after its copy was kept");
    console.error(
      `[discord-mcpl] Couldn't use ${what} in ${path} as it is (${problem}). Kept a copy at ${aside}, but ` +
        `couldn't rewrite the file (${(err as Error).message}). Starting with what it could use, and nothing is ` +
        "saved over the file until it's read again.",
    );
    dbg('persisted-json:rewrite-failed', { what, path, aside, problem, error: (err as Error).message });
    return { value, held: false };
  }
  console.error(
    `[discord-mcpl] Couldn't use ${what} in ${path} as it is (${problem}). Kept a copy at ${aside}, ` +
      (found.value === null
        ? 'emptied the file, and starting with none. '
        : 'rewrote the file with the entries it could use, and starting with those. ') +
      'To restore the copy, stop the server first: a running server saves over its file.',
  );
  dbg('persisted-json:copied-aside', { what, path, aside, problem });
  return { value, held: true };
}

function copyAside(path: string, bytes: Buffer, mode: number): string {
  const byContent = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  if (writeNewFile(byContent, bytes, mode)) return byContent;
  if (readFileSync(byContent).equals(bytes)) {
    const fd = openSync(byContent, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return byContent;
  }
  const byTime = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (!writeNewFile(byTime, bytes, mode)) throw Object.assign(new Error(`${byTime} already exists`), { code: 'EEXIST' });
  return byTime;
}

function writeNewFile(to: string, bytes: Buffer, mode: number): boolean {
  let fd: number;
  try {
    fd = openSync(to, 'wx', mode);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    try {
      fchmodSync(fd, mode); // the bits the umask took
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      rmSync(to, { force: true });
    } catch {
    }
    throw err;
  }
  try {
    const dirFd = openSync(dirname(to), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Not every filesystem can flush a directory; the copy's own data is.
  }
  return true;
}

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
