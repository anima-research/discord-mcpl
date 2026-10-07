/**
 * Sender notices for DMs the DM allowlist refuses.
 *
 * A refused DM is never forwarded to the agent. Without a notice the sender
 * can't tell a contact filter from a resident ignoring them, so the connector
 * tells them once. This module holds the durable per-sender state that keeps
 * the notice to once per message and at most once a day per sender, across
 * restarts, reconnect catch-up and duplicate gateway events:
 *
 *   - floorId: when the connector began handling refusals with this state,
 *     as a Discord snowflake. A message older than that never notifies, on
 *     any path: a gateway event can carry an older message as well as the
 *     catch-up sweep can, and deploying this mustn't notify everyone whose
 *     DMs were refused before. The server captures the boundary when it is
 *     constructed, before it handles any refusal, so a state file created
 *     later still uses it.
 *   - per sender, lastHandledId: the newest refused message already handled.
 *     A message whose id isn't newer never notifies again.
 *   - per sender, lastNotice: the last notice's message, when it was
 *     reserved, and its outcome. It's reserved (persisted, outcome
 *     "pending") BEFORE the send and settled to sent / failed / unknown
 *     after. A reservation found still pending when the state is opened
 *     was interrupted (say, by a crash after dispatch): it becomes unknown,
 *     is reported once, and is never retried.
 *
 * The same file holds the resident's on/off setting for notices (on unless
 * deliberately turned off with filters_update setDmNotice), so the choice
 * survives restarts whether or not a filters file is configured.
 *
 * The state lives in its own file, separate from the filters file. If it
 * can't be read or written, notices are suspended rather than sent without a
 * durable limit; refusals themselves are unaffected.
 *
 * The file is read and written asynchronously, so a slow disk never stalls
 * the gateway, and the state's operations (open, decide, recordOutcome,
 * setEnabled) run one at a time, in the order they were called: each sees the
 * state the one before it left. Every change rewrites the whole file, which
 * holds one small entry per sender ever refused.
 */
import { mkdir, open, readFile, rename, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DM_NOTICE_TEXT =
  'Automatic delivery notice: this connection did not forward your DM because this sender is outside ' +
  'its configured contacts. It sends this notice at most once per 24 hours.';

export const DM_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE_RE = /^\d{1,20}$/;

/** The smallest snowflake Discord could assign at `ms` (epoch milliseconds). */
export function snowflakeAt(ms: number): string {
  const offset = BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS;
  return (offset > 0n ? offset << 22n : 0n).toString();
}

/** Where the notice state lives: DISCORD_DM_NOTICES_FILE when set, else
 *  $XDG_STATE_HOME/discord-mcpl/<bot user id>/dm-notices.json, falling back
 *  to ~/.local/state. Keyed by bot id so several bots on one host don't
 *  share a rate limit. */
export function resolveDmNoticesPath(botUserId: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DISCORD_DM_NOTICES_FILE?.trim();
  if (override) return override;
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'discord-mcpl', botUserId, 'dm-notices.json');
}

export type DmNoticeOutcome = 'pending' | 'sent' | 'failed' | 'unknown';

/** A reservation found still pending when the state was opened. */
export interface DmNoticeInterruption {
  authorId: string;
  messageId: string;
  /** When it was reserved (epoch ms). */
  at: number;
}

interface LastNotice {
  messageId: string;
  /** When it was reserved (epoch ms); its 24-hour window starts here. */
  at: number;
  outcome: DmNoticeOutcome;
}

interface SenderState {
  lastHandledId: string;
  lastNotice?: LastNotice;
}

const OUTCOMES = new Set<string>(['pending', 'sent', 'failed', 'unknown']);

interface NoticeFile {
  version: 1;
  floorId: string;
  /** The resident's setting: false = refused DMs get no notice. */
  enabled: boolean;
  senders: Record<string, SenderState>;
}

/** What happened to one refused DM's notice. `notify` means the reservation
 *  is persisted and the caller should send now. */
export type DmNoticeDecision =
  | 'notify'
  | 'silenced'
  | 'suspended'
  | 'before-floor'
  | 'already-handled'
  | 'rate-limited';

export interface DmNoticeStatus {
  path: string | null;
  persisted: boolean;
  /** The resident's setting, or null while the state can't be read. */
  enabled: boolean | null;
  /** Why notices are suspended, when they are. */
  error?: string;
}

function parseNoticeFile(raw: unknown): NoticeFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.floorId !== 'string' || !SNOWFLAKE_RE.test(r.floorId)) return null;
  if (typeof r.enabled !== 'boolean') return null;
  if (typeof r.senders !== 'object' || r.senders === null || Array.isArray(r.senders)) return null;
  const senders: Record<string, SenderState> = {};
  for (const [id, v] of Object.entries(r.senders as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) return null;
    const s = v as Record<string, unknown>;
    if (typeof s.lastHandledId !== 'string' || !SNOWFLAKE_RE.test(s.lastHandledId)) return null;
    let lastNotice: LastNotice | undefined;
    if (s.lastNotice !== undefined) {
      const n = s.lastNotice as Record<string, unknown> | null;
      if (typeof n !== 'object' || n === null) return null;
      if (typeof n.messageId !== 'string' || !SNOWFLAKE_RE.test(n.messageId)) return null;
      if (typeof n.at !== 'number' || !Number.isFinite(n.at)) return null;
      if (typeof n.outcome !== 'string' || !OUTCOMES.has(n.outcome)) return null;
      lastNotice = { messageId: n.messageId, at: n.at, outcome: n.outcome as DmNoticeOutcome };
    }
    senders[id] = { lastHandledId: s.lastHandledId, ...(lastNotice ? { lastNotice } : {}) };
  }
  return { version: 1, floorId: r.floorId, enabled: r.enabled, senders };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A write that failed after the new file replaced the old one: the file
 *  holds the new state, but its directory couldn't be flushed, so the
 *  replacement may not survive a host crash. */
class UnflushedReplace extends Error {}

export class DmNoticeState {
  /** The state as the file holds it (see commit), or null while it can't be read. */
  private file: NoticeFile | null = null;
  private path: string | null = null;
  private floorAt: number | undefined;
  private error: string | null = 'not opened yet (the bot user id is not known)';
  /** Settles when the last operation called so far has finished. */
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sync: (handle: FileHandle, what: 'file' | 'directory') => Promise<void>;
  private readonly onInterrupted: (i: DmNoticeInterruption) => void;

  /** `onInterrupted` hears about each reservation found still pending when
   *  the state is opened, every time it is opened (startup, or a reopen once
   *  a broken file is repaired). `now` and `sync` (which flushes the state
   *  file, or its directory after the rename) are injectable for tests. */
  constructor(opts: {
    now?: () => number;
    sync?: (handle: FileHandle, what: 'file' | 'directory') => Promise<void>;
    onInterrupted?: (i: DmNoticeInterruption) => void;
  } = {}) {
    this.now = opts.now ?? Date.now;
    this.sync = opts.sync ?? ((handle) => handle.sync());
    this.onInterrupted = opts.onInterrupted ?? (() => {});
  }

  /** Run `op` once every operation called before it has finished. */
  private serially<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Open the state at `path`. A new file gets its floor at `floorAt` (the
   *  caller's startup boundary, epoch ms), else now; an existing file keeps
   *  its own. An unreadable or invalid file is left untouched and suspends
   *  notices until an operator repairs or removes it; the next decision or
   *  setting change tries it again. */
  open(path: string, opts: { floorAt?: number } = {}): Promise<void> {
    return this.serially(() => this.load(path, opts.floorAt));
  }

  private async load(path: string, floorAt?: number): Promise<void> {
    this.floorAt = floorAt ?? this.floorAt;
    this.path = path;
    this.file = null;
    let text: string | null = null;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.error = errorText(err);
        return;
      }
    }
    if (text === null) {
      await this.commit({ version: 1, floorId: snowflakeAt(this.floorAt ?? this.now()), enabled: true, senders: {} });
      return;
    }
    let parsed: NoticeFile | null = null;
    try {
      parsed = parseNoticeFile(JSON.parse(text));
    } catch {
      // not JSON: invalid, as below
    }
    if (!parsed) {
      this.error = `${path} is not a valid DM notice state file`;
      return;
    }
    // A reservation still pending was interrupted between reserving and
    // recording its outcome: settle it as unknown (never retried), and report
    // it once the file says so. Until then the state stays closed, so the
    // next use tries again.
    const pending = Object.entries(parsed.senders).filter(([, v]) => v.lastNotice?.outcome === 'pending');
    if (!pending.length) {
      this.file = parsed;
      this.error = null;
      return;
    }
    const senders = { ...parsed.senders };
    for (const [authorId, v] of pending) {
      senders[authorId] = { ...v, lastNotice: { ...v.lastNotice!, outcome: 'unknown' } };
    }
    await this.commit({ ...parsed, senders });
    if (!this.file) return;
    for (const [authorId, v] of pending) {
      this.onInterrupted({ authorId, messageId: v.lastNotice!.messageId, at: v.lastNotice!.at });
    }
  }

  status(): DmNoticeStatus {
    return {
      path: this.path,
      persisted: this.file !== null && this.error === null,
      enabled: this.file ? this.file.enabled : null,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Settle a reserved notice's outcome. Resolves to null once that is
   *  durable, else to why not. If the file couldn't be replaced, the
   *  reservation stays pending there and is reported as interrupted
   *  (unknown) the next time the state is opened. */
  recordOutcome(
    authorId: string,
    messageId: string,
    outcome: Exclude<DmNoticeOutcome, 'pending'>,
  ): Promise<string | null> {
    return this.serially(async () => {
      const file = this.file;
      const prev = file?.senders[authorId];
      if (!file || !prev?.lastNotice || prev.lastNotice.messageId !== messageId) {
        return 'its reservation is no longer in the notice state';
      }
      return this.commit({
        ...file,
        senders: { ...file.senders, [authorId]: { ...prev, lastNotice: { ...prev.lastNotice, outcome } } },
      });
    });
  }

  /** Save the resident's setting. Rejects when it didn't take effect, so the
   *  caller can say so. Resolves to null once it is durable, or to why it
   *  may not be: the file was replaced, so the setting is in effect, but its
   *  directory couldn't be flushed. */
  setEnabled(enabled: boolean): Promise<string | null> {
    return this.serially(async () => {
      if (!this.file && this.path) await this.load(this.path);
      if (!this.file) throw new Error(`DM notice state is unavailable: ${this.error ?? 'no path'}`);
      const next: NoticeFile = { ...this.file, enabled };
      const error = await this.commit(next);
      if (error && this.file !== next) throw new Error(`could not save the DM notice setting: ${error}`);
      return error;
    });
  }

  /**
   * Decide one refused DM's notice and record it durably. Every refusal the
   * state can see advances its sender's lastHandledId, silenced or not, so a
   * later catch-up of the same message can't notify. A `notify` result is
   * returned only after the reservation is durable; while the file can't be
   * written durably, notices are suspended (checked again on the next
   * refusal).
   */
  decide(messageId: string, authorId: string): Promise<DmNoticeDecision> {
    return this.serially(async () => {
      // A file that couldn't be opened may have been repaired or removed since.
      if (!this.file && this.path) await this.load(this.path);
      const file = this.file;
      if (!file) return 'suspended';
      const silenced = !file.enabled;
      if (!SNOWFLAKE_RE.test(messageId) || BigInt(messageId) < BigInt(file.floorId)) return 'before-floor';
      const prev = file.senders[authorId];
      if (prev && BigInt(messageId) <= BigInt(prev.lastHandledId)) return 'already-handled';

      const now = this.now();
      const inWindow = prev?.lastNotice !== undefined && now - prev.lastNotice.at < DM_NOTICE_WINDOW_MS;
      const reserve = !silenced && !inWindow;
      const lastNotice: LastNotice | undefined = reserve
        ? { messageId, at: now, outcome: 'pending' }
        : prev?.lastNotice;
      const next: NoticeFile = {
        ...file,
        senders: {
          ...file.senders,
          [authorId]: { lastHandledId: messageId, ...(lastNotice ? { lastNotice } : {}) },
        },
      };
      if (await this.commit(next)) return silenced ? 'silenced' : 'suspended';
      if (silenced) return 'silenced';
      return reserve ? 'notify' : 'rate-limited';
    });
  }

  /** Write `next` and make it the state. The state always matches what the
   *  file holds: a write that failed before replacing the file changes
   *  nothing, and one that replaced the file but couldn't flush its
   *  directory still leaves `next` as the state (this is the file's only
   *  writer, so a reread would return the same), with the error kept until
   *  a later write is durable. Resolves to null once `next` is durable, else
   *  to the error. */
  private async commit(next: NoticeFile): Promise<string | null> {
    try {
      await this.write(next);
      this.file = next;
      this.error = null;
      return null;
    } catch (err) {
      if (err instanceof UnflushedReplace) this.file = next;
      this.error = errorText(err);
      return this.error;
    }
  }

  /** Durable replace: the new content is flushed before it takes the old
   *  file's place, and the rename is flushed with its directory, so a
   *  reservation that returned has survived a host crash. Private to the
   *  bot's user (0600 file, 0700 directory). A failure before the rename
   *  leaves the old file in place; one after it is an UnflushedReplace. */
  private async write(file: NoticeFile): Promise<void> {
    if (!this.path) throw new Error('DM notice state has no path');
    const path = this.path;
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.chmod(0o600); // a stale tmp keeps its old mode otherwise
      // writeFile on a handle loops until every byte is written, so a short
      // write can't pass for a durable reservation.
      await handle.writeFile(JSON.stringify(file, null, 2) + '\n');
      await this.sync(handle, 'file');
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    if (process.platform === 'win32') return;
    try {
      const dirHandle = await open(dir, 'r');
      try {
        await this.sync(dirHandle, 'directory');
      } finally {
        await dirHandle.close();
      }
    } catch (err) {
      throw new UnflushedReplace(
        `${path} was replaced, but flushing its directory failed, so the change may not survive a host crash: ${errorText(err)}`,
      );
    }
  }
}
