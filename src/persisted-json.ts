/**
 * The server's small persisted JSON files: the muted channels, the reaction
 * channels and the watermarks, and the filters file. Each is rewritten whole
 * after every change, so three things matter:
 * - A save writes a temp file beside the old one and renames it over, so a
 *   process crash partway through can't leave a torn file. The new file keeps
 *   the old one's permissions, as an in-place write did, so a private file
 *   stays private. There's no fsync, so a power loss can still leave an empty
 *   file on some filesystems. The reader then moves that aside like any other
 *   unusable file.
 * - A file that can't be read, or isn't the shape its store expects, is moved
 *   aside before the store starts empty. The next save then writes a fresh
 *   file, and leaves the old one for an operator to recover. That includes a
 *   passing read error, such as EIO or EMFILE, where the content may be fine:
 *   the store then runs without its entries until the file is restored.
 * - If even the move fails, nothing saves over that file until a restart
 *   reads it again: its store runs in memory meanwhile. Nothing is destroyed
 *   either way.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Files that couldn't be read or moved aside: saving over them would destroy them. */
const unsaveable = new Set<string>();

/** Write `value` as JSON, whole or not at all. Throws on failure. */
export function writeJsonFile(path: string, value: unknown): void {
  if (unsaveable.has(path)) {
    throw new Error(`${path} couldn't be read or moved aside, so it isn't saved over until a restart reads it again`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  const tmp = `${path}.tmp`;
  // Created with the old file's mode, so the temp file is never more open than its target; the chmod covers a stale
  // temp file a crash left, which writeFileSync's mode doesn't change, and any bits the umask took off.
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** The file's parsed contents, or undefined when there's no file or it was
 *  unusable. An unusable file is moved to `<path>.unreadable-<time>`, and
 *  console.error names both paths. If the move fails, the file is left as it
 *  is and isn't saved over (writeJsonFile). `what` names the store. */
export function readJsonFile<T>(path: string, what: string, isShape: (value: unknown) => value is T): T | undefined {
  if (!existsSync(path)) return undefined;
  let problem: string;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (isShape(parsed)) return parsed;
    problem = 'not the shape this store expects';
  } catch (err) {
    problem = (err as Error).message;
  }
  const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(path, aside);
    console.error(`[discord-mcpl] Couldn't load ${what} from ${path} (${problem}). Moved it to ${aside}, and starting with none.`);
  } catch (err) {
    unsaveable.add(path);
    console.error(
      `[discord-mcpl] Couldn't load ${what} from ${path} (${problem}), or move it aside (${(err as Error).message}). ` +
        'Starting with none, and nothing is saved over that file until a restart reads it again.',
    );
  }
  return undefined;
}

export const isJsonArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
