/**
 * The server's small persisted JSON files: the muted channels, the reaction
 * channels and the watermarks. Each is read once and then rewritten whole
 * after every change, so two things matter:
 * - A save writes a temp file beside the old one and renames it over, so a
 *   process crash partway through can't leave a torn file. There's no fsync,
 *   so a power loss can still leave an empty file on some filesystems. The
 *   reader then moves that aside like any other unusable file.
 * - A file that can't be read, or isn't the shape its store expects, is moved
 *   aside before the store starts empty. The next save then writes a fresh
 *   file, and leaves the old one for an operator to recover. That includes a
 *   passing read error, such as EIO or EMFILE, where the content may be fine:
 *   the store then runs without its entries until the file is restored.
 *   Nothing is destroyed either way.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write `value` as JSON, whole or not at all. Throws on failure. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** The file's parsed contents, or undefined when there's no file or it was
 *  unusable. An unusable file is moved to `<path>.unreadable-<time>`, and
 *  console.error names both paths. `what` names the store in that line. */
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
    console.error(
      `[discord-mcpl] Couldn't load ${what} from ${path} (${problem}), or move it aside (${(err as Error).message}). Starting with none.`,
    );
  }
  return undefined;
}

export const isJsonArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
