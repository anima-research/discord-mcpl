/**
 * The hourly ceiling bounds what a wave of new accounts DMing the bot can
 * cause: each would get its one notice, an unbounded burst of outbound DMs,
 * which is the pattern Discord's anti-spam watches bot accounts for.
 */
import { mkdir, open, readFile, rename, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DM_NOTICE_TEXT =
  'Automatic delivery notice: this connection did not forward your DM because this sender is outside ' +
  'its configured contacts. It sends this notice at most once per 24 hours.';

export const DM_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DM_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DM_NOTICE_HOURLY_CEILING = 10;
export const DM_NOTICE_CEILING_WINDOW_MS = 60 * 60 * 1000;

const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE_RE = /^\d{1,20}$/;

/** The smallest snowflake Discord could assign at `ms` (epoch milliseconds). */
export function snowflakeAt(ms: number): string {
  const offset = BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS;
  return (offset > 0n ? offset << 22n : 0n).toString();
}

/** When Discord assigned a snowflake, as epoch ms. */
function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

const laterSnowflake = (a: string, b: string): string => (BigInt(a) >= BigInt(b) ? a : b);

export function resolveDmNoticesPath(botUserId: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DISCORD_DM_NOTICES_FILE?.trim();
  if (override) return override;
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'discord-mcpl', botUserId, 'dm-notices.json');
}

export type DmNoticeOutcome = 'pending' | 'sent' | 'failed' | 'unknown';

export interface DmNoticeInterruption {
  authorId: string;
  messageId: string;
  at: number;
}

interface LastNotice {
  messageId: string;
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
  enabled: boolean;
  senders: Record<string, SenderState>;
}

export type DmNoticeDecision =
  | 'notify'
  | 'silenced'
  | 'suspended'
  | 'before-floor'
  | 'already-handled'
  | 'rate-limited'
  | 'ceiling-reached';

export interface DmNoticeStatus {
  path: string | null;
  persisted: boolean;
  enabled: boolean | null;
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
      // Within Date's range, so an interrupted reservation's time can be printed.
      if (typeof n.at !== 'number' || Number.isNaN(new Date(n.at).getTime())) return null;
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
  private file: NoticeFile | null = null;
  private path: string | null = null;
  private error: string | null = 'not opened yet';
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sync: (handle: FileHandle, what: 'file' | 'directory') => Promise<void>;
  private readonly onInterrupted: (i: DmNoticeInterruption) => void;

  constructor(opts: {
    now?: () => number;
    sync?: (handle: FileHandle, what: 'file' | 'directory') => Promise<void>;
    onInterrupted?: (i: DmNoticeInterruption) => void;
  } = {}) {
    this.now = opts.now ?? Date.now;
    this.sync = opts.sync ?? ((handle) => handle.sync());
    this.onInterrupted = opts.onInterrupted ?? (() => {});
  }

  private serially<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  open(path: string): Promise<void> {
    return this.serially(() => this.load(path));
  }

  private async load(path: string): Promise<void> {
    this.path = path;
    this.file = null;
    this.error = 'opening';
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
      await this.commit({ version: 1, floorId: snowflakeAt(this.now()), enabled: false, senders: {} });
      return;
    }
    let parsed: NoticeFile | null = null;
    try {
      parsed = parseNoticeFile(JSON.parse(text));
    } catch {
    }
    if (!parsed) {
      this.error = `${path} is not a valid DM notice state file`;
      return;
    }
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
      const next: NoticeFile = {
        ...file,
        senders: { ...file.senders, [authorId]: { ...prev, lastNotice: { ...prev.lastNotice, outcome } } },
      };
      const error = await this.commit(next);
      if (error) this.file = next;
      return error;
    });
  }

  setEnabled(enabled: boolean): Promise<string | null> {
    return this.serially(async () => {
      if (!this.file && this.path) await this.load(this.path);
      if (!this.file) throw new Error(`DM notice state is unavailable: ${this.error ?? 'no path'}`);
      const floorId = enabled && !this.file.enabled
        ? laterSnowflake(this.file.floorId, snowflakeAt(this.now()))
        : this.file.floorId;
      const next: NoticeFile = { ...this.file, enabled, floorId };
      const error = await this.commit(next);
      if (error && this.file !== next) throw new Error(`could not save the DM notice setting: ${error}`);
      return error;
    });
  }

  decide(messageId: string, authorId: string): Promise<DmNoticeDecision> {
    return this.serially(async () => {
      if (!this.file && this.path) await this.load(this.path);
      const file = this.file;
      if (!file) return 'suspended';
      const now = this.now();
      const horizon = now - DM_NOTICE_RETENTION_MS;
      const floorId = laterSnowflake(file.floorId, snowflakeAt(horizon));
      if (!SNOWFLAKE_RE.test(messageId) || BigInt(messageId) < BigInt(floorId)) return 'before-floor';
      const prev = file.senders[authorId];
      if (prev && BigInt(messageId) <= BigInt(prev.lastHandledId)) return 'already-handled';
      if (!file.enabled) return 'silenced';

      const inWindow = prev?.lastNotice !== undefined && now - prev.lastNotice.at < DM_NOTICE_WINDOW_MS;
      const atCeiling =
        !inWindow &&
        Object.values(file.senders).filter(
          (s) => s.lastNotice !== undefined && now - s.lastNotice.at < DM_NOTICE_CEILING_WINDOW_MS,
        ).length >= DM_NOTICE_HOURLY_CEILING;
      if (atCeiling && !prev) return 'ceiling-reached';
      const reserve = !inWindow && !atCeiling;
      const lastNotice: LastNotice | undefined = reserve
        ? { messageId, at: now, outcome: 'pending' }
        : prev?.lastNotice;
      const senders: Record<string, SenderState> = {};
      for (const [id, s] of Object.entries(file.senders)) {
        if (Math.max(snowflakeTime(s.lastHandledId), s.lastNotice?.at ?? -Infinity) >= horizon) senders[id] = s;
      }
      senders[authorId] = { lastHandledId: messageId, ...(lastNotice ? { lastNotice } : {}) };
      const next: NoticeFile = { ...file, floorId, senders };
      if (await this.commit(next)) {
        if (reserve) {
          const handled: SenderState = {
            lastHandledId: messageId,
            ...(prev?.lastNotice ? { lastNotice: prev.lastNotice } : {}),
          };
          const withdrawn: NoticeFile = { ...next, senders: { ...senders, [authorId]: handled } };
          await this.commit(withdrawn);
          this.file = withdrawn;
        }
        return 'suspended';
      }
      if (reserve) return 'notify';
      return inWindow ? 'rate-limited' : 'ceiling-reached';
    });
  }

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

  /** The content is flushed before it takes the old file's place, and the
   *  rename is flushed with its directory, except on Windows, which can't flush
   *  one. A 0600 file, in a directory created 0700 when it doesn't exist. */
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
