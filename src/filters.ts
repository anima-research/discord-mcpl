/**
 * Discord event filters (guild/channel whitelist + DM user whitelist +
 * operator-maintained reaction suppression) with optional hot-reload from a
 * JSON file.
 *
 * Precedence: when DISCORD_FILTERS_FILE is set and the file exists, the file
 * wins over the DISCORD_GUILD_ID / DISCORD_DM_USERS env vars. When
 * DISCORD_FILTERS_FILE is set but the file does not exist yet, it is seeded
 * from the env values — so from then on, edits (by hand, by ops tooling, or
 * by the agent via the `filters_update` tool) are hot-applied within seconds,
 * no restart required.
 *
 * Semantics (unchanged from the env-only implementation):
 *   - guildIds unset/empty          -> ALL guilds allowed
 *   - guildChannels[gid] unset      -> all channels in that guild
 *   - dmUsers unset/empty           -> ALL DM users allowed
 *
 * File schema:
 *   {
 *     "guildIds": ["111", "222"],
 *     "guildChannels": { "222": ["333", "444"] },
 *     "dmUsers": ["555"],
 *     "suppressedReactionEmojis": ["<emoji>", "<custom emoji snowflake>"]
 *   }
 *
 * The plane has ONE desired/effective/status lifecycle (DiscordFiltersState
 * below), shared by the whitelists and the suppression key alike: guild/DM
 * state goes stale under exactly the same failures (unparseable rewrite,
 * deleted file) as suppression does, so staleness is a property of the
 * plane, not of any one key.
 */
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface DiscordFilters {
  /** Allowed guild ids. Unset = all guilds. */
  guildIds?: string[];
  /** Per-guild channel whitelist. A guild with no entry = all its channels. */
  guildChannels?: Record<string, string[]>;
  /** Allowed DM author ids. Unset = all DM users. */
  dmUsers?: string[];
  /** Reaction markers excluded from every model-visible surface (issue #21):
   *  live reaction events, fetched-history summaries, backscroll metadata.
   *  Entries match by the shared normalization below (VS-16/colon strip);
   *  numeric snowflake entries additionally match custom emojis by id.
   *
   *  Operator-write only: filters_update cannot carry this field, so the
   *  configured glyphs never transit an agent turn in either direction —
   *  they live in this file, below the model line. See DiscordFiltersState
   *  for status/failure semantics. */
  suppressedReactionEmojis?: string[];
}

/** Drop empty arrays/objects so "unset" and "empty" stay one state (= unrestricted). */
export function normalizeFilters(f: DiscordFilters): DiscordFilters {
  const out: DiscordFilters = {};
  if (f.guildIds?.length) out.guildIds = [...new Set(f.guildIds)];
  if (f.guildChannels) {
    const gc: Record<string, string[]> = {};
    for (const [g, chans] of Object.entries(f.guildChannels)) {
      if (chans?.length && out.guildIds?.includes(g)) gc[g] = [...new Set(chans)];
    }
    if (Object.keys(gc).length) out.guildChannels = gc;
  }
  if (f.dmUsers?.length) out.dmUsers = [...new Set(f.dmUsers)];
  if (f.suppressedReactionEmojis) {
    // Unlike the whitelist keys, an explicitly-empty list is PRESERVED, not
    // collapsed to unset. Delivery semantics are identical (nothing is
    // suppressed either way), but status reporting distinguishes "no one
    // ever configured this" from "an operator deliberately wrote zero
    // entries" — deployment checks must not mistake the mechanism's
    // presence for a real marker set, and must not mistake a deliberate
    // clear for a never-configured plane.
    const seen = new Set<string>();
    out.suppressedReactionEmojis = f.suppressedReactionEmojis.filter((t) => {
      const key = normalizeReactionEmoji(t);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return out;
}

/** Parse DISCORD_GUILD_ID / DISCORD_DM_USERS. Entry syntax for guilds:
 *  `guildId` (all channels) or `guildId:chanId+chanId` (only those). */
export function parseFiltersFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordFilters {
  const filters: DiscordFilters = {};
  const rawGuilds = env.DISCORD_GUILD_ID?.split(',').map((s) => s.trim()).filter(Boolean);
  if (rawGuilds?.length) {
    filters.guildIds = [];
    for (const entry of rawGuilds) {
      const [gid, chans] = entry.split(':', 2);
      filters.guildIds.push(gid);
      if (chans) {
        (filters.guildChannels ??= {})[gid] = chans
          .split('+')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
  }
  const dmUsers = env.DISCORD_DM_USERS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (dmUsers?.length) filters.dmUsers = dmUsers;
  return normalizeFilters(filters);
}

/** Load + validate the filters file. Returns null when the file is missing,
 *  unparseable, or carries a wrong-typed safety field — callers keep the
 *  previous filters (fail-safe, never fail-open).
 *
 *  The whitelist keys tolerate loose shapes (a wrong-typed whitelist fails
 *  toward "unrestricted", which is the env-unset default and visible in
 *  filters_get). suppressedReactionEmojis does NOT: it is safety-bearing,
 *  and a wrong-typed value degrading to "key absent" would silently drop
 *  active protection (or silently re-enable the deprecated env source). A
 *  present-but-not-string[] key therefore invalidates the whole load. */
export function loadFiltersFile(path: string): DiscordFilters | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const out: DiscordFilters = {};
    if (Array.isArray(r.guildIds)) out.guildIds = r.guildIds.map(String).filter(Boolean);
    if (r.guildChannels && typeof r.guildChannels === 'object' && !Array.isArray(r.guildChannels)) {
      out.guildChannels = {};
      for (const [g, chans] of Object.entries(r.guildChannels as Record<string, unknown>)) {
        if (Array.isArray(chans)) out.guildChannels[g] = chans.map(String).filter(Boolean);
      }
    }
    if (Array.isArray(r.dmUsers)) out.dmUsers = r.dmUsers.map(String).filter(Boolean);
    if ('suppressedReactionEmojis' in r) {
      const v = r.suppressedReactionEmojis;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
      out.suppressedReactionEmojis = v as string[];
    }
    return normalizeFilters(out);
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) so the poller never reads a half-written file. */
export function saveFiltersFile(path: string, filters: DiscordFilters): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalizeFilters(filters), null, 2) + '\n');
  renameSync(tmp, path);
}

export function filtersFileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Resolve the filters in force at startup.
 *
 * - no file configured: env whitelists (suppression, if any, will ride the
 *   legacy env source);
 * - file exists and parses: the file, whole;
 * - file exists but does not parse: env whitelists and fileBroken=true —
 *   the file is NOT overwritten. It belongs to the operator, and it may
 *   hold a suppressedReactionEmojis key the env seed wouldn't recreate;
 * - file absent: first materialization — seed it from the env whitelists
 *   plus DISCORD_SUPPRESS_REACTION_EMOJIS as the suppression key (that
 *   env's one-time migration into the plane). Only a durably-written seed
 *   claims file authority: if the write fails, the returned filters omit
 *   the key so the env stays the (legacy) source. */
export function resolveStartupFilters(
  filtersFile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { filters: DiscordFilters; fileBroken: boolean } {
  let filters = parseFiltersFromEnv(env);
  let fileBroken = false;
  if (!filtersFile) return { filters, fileBroken };
  if (existsSync(filtersFile)) {
    const fromFile = loadFiltersFile(filtersFile);
    if (fromFile) {
      filters = fromFile;
      console.error(`[discord-mcpl] filters loaded from ${filtersFile}`);
    } else {
      fileBroken = true;
      console.error(
        `[discord-mcpl] filters file ${filtersFile} exists but cannot be parsed — NOT overwriting it. ` +
          'Running on env whitelists; reaction suppression fails closed until the file is repaired.',
      );
    }
  } else {
    const suppressSeed = parseSuppressionEnvTokens(env.DISCORD_SUPPRESS_REACTION_EMOJIS);
    const seeded = suppressSeed.length
      ? { ...filters, suppressedReactionEmojis: suppressSeed }
      : filters;
    try {
      saveFiltersFile(filtersFile, seeded);
      filters = seeded;
      console.error(
        `[discord-mcpl] filters file seeded from env -> ${filtersFile}` +
          (suppressSeed.length
            ? ` (incl. ${suppressSeed.length} suppressed-reaction entries from DISCORD_SUPPRESS_REACTION_EMOJIS — ` +
              'the file key is now authoritative; unset the env after verifying)'
            : ''),
      );
    } catch (err) {
      console.error(`[discord-mcpl] could not seed filters file ${filtersFile}:`, (err as Error).message);
    }
  }
  return { filters, fileBroken };
}

/** Poll-cycle interpreter for the filters file's presence/mtime, so the
 *  poller can tell an atomic-rename blink from a real deletion and can
 *  force a reload when a vanished file reappears with a preserved mtime
 *  (restored-from-backup files can carry different bytes under identical
 *  timestamps).
 *
 *  One missing observation is grace (a non-atomic editor mid-replace);
 *  persistent absence is a real state the plane must witness — a deleted
 *  desired config reporting as healthy is exactly disk≠process with no
 *  witness. */
export class FiltersFilePollTracker {
  private lastMtime: number | null;
  private missedPolls = 0;

  constructor(initialMtime: number | null) {
    this.lastMtime = initialMtime;
  }

  observe(mtime: number | null): 'none' | 'missing' | 'reload' {
    if (mtime === null) {
      this.missedPolls++;
      return this.missedPolls >= 2 ? 'missing' : 'none';
    }
    const reappeared = this.missedPolls > 0;
    this.missedPolls = 0;
    if (!reappeared && mtime === this.lastMtime) return 'none';
    this.lastMtime = mtime;
    return 'reload';
  }
}

/* ------------------------------------------------------------------------- *
 * Plane state + reaction suppression (issue #21, folded per PR #13 review)
 *
 * Hosts mark inference refusals by reacting to the triggering message with a
 * category emoji. Letting those reactions re-enter agent context feeds
 * classifier-meta back into the very windows that are refusing: a
 * self-amplifying loop, observed cross-agent (Mythos 2026-08-03).
 *
 * The suppression list lives in this plane as `suppressedReactionEmojis`.
 * The 2026-08-03 emergency env (DISCORD_SUPPRESS_REACTION_EMOJIS) seeds the
 * file on first materialization and otherwise survives as a deprecated
 * PROCESS-STATIC source: it is read once at startup, and changing it
 * requires a restart — a running process's environment cannot be edited
 * from outside, so no hot-apply is claimed for it. Hot reload belongs to
 * the file plane alone. The alias retires once fleet inventory shows
 * migrated files (issue #16).
 * ------------------------------------------------------------------------- */

/** Normalize a reaction emoji for suppression matching: strip VS-16
 *  (U+FE0F) so "☣️" and "☣" compare equal, and strip surrounding colons so a
 *  custom emoji matches whether configured as ":sigil:" or "sigil". */
export function normalizeReactionEmoji(emoji: string): string {
  return emoji.replace(/\uFE0F/g, '').trim().replace(/^:|:$/g, '');
}

/** Discord snowflakes are 64-bit decimal ids; every real one is 17–20
 *  digits. A numeric suppression entry gains id matching for custom emojis
 *  without losing its literal string match (an emoji *name* that happens to
 *  be digits still matches by name). */
const SNOWFLAKE = /^\d{17,20}$/;

/** Comma-separated env value → raw suppression tokens. Unset, empty, and
 *  all-separators all mean "no tokens" — the emergency filter's
 *  backward-compatible OFF. Used both to seed the filters file on first
 *  materialization and by the deprecated process-static legacy source. */
export function parseSuppressionEnvTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => normalizeReactionEmoji(s));
}

/** JSON.stringify with recursively sorted object keys, so the plane digest
 *  is stable across key ordering. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

export interface FiltersPlaneStatus {
  /** live: file configured, last parse applied, desired state readable.
   *  stale: desired state is unreadable/missing; the last-known-good
   *  filters (whitelists AND suppression alike) are still enforced —
   *  process-lifetime only, they do not survive a restart. unavailable:
   *  desired state is unreadable/missing and no good parse ever happened
   *  this process (whitelists run on the env fallback; reactions are
   *  withheld). env-static: no DISCORD_FILTERS_FILE — filters came from
   *  env at startup and cannot change without a restart. */
  status: 'live' | 'stale' | 'unavailable' | 'env-static';
  /** What the on-disk desired state looks like right now. Only present
   *  when a filters file is configured. */
  desiredState?: 'ok' | 'invalid' | 'missing';
  /** Full machine digest (`sha256:<hex>`) of the normalized effective
   *  filters — the whole plane, not any one key. Null before the first
   *  good parse. Deliberately no revision counter: the plane is an
   *  mtime-polled file with no durable monotonic source. */
  effectiveDigest: string | null;
  /** When the current effective filters were applied, in this process. */
  loadedAt?: string;
  /** When the desired state became unreadable/missing (stale/unavailable). */
  staleSince?: string;
}

export interface ReactionSuppressionStatus {
  /** not-configured: no suppression anywhere — reported plainly, never
   *  implying protection. configured-empty: the file key exists with zero
   *  entries (deliberate operator clear). active: entries are being
   *  enforced. stale: the plane broke after a good load and the
   *  last-known-good entries are still enforced. unavailable: the
   *  withhold-everything posture (see suppressingAllReactions). Plane-level
   *  facts (desiredState, staleSince, loadedAt) live on the plane status,
   *  not here. */
  status: 'not-configured' | 'configured-empty' | 'active' | 'stale' | 'unavailable';
  /** True whenever reactions are actually being withheld from the model. */
  protectionActive: boolean;
  /** Distinct entries currently enforced (post-normalization). */
  effectiveCount: number;
  /** Full `sha256:` digest of the normalized enforced set; null when
   *  nothing is enforced. Redacted by construction — never the entries. */
  effectiveDigest: string | null;
  /** status 'unavailable' only: the plane is broken with no usable prior
   *  set, so every reaction is withheld until the file is repaired. */
  suppressingAllReactions?: true;
  source: 'file' | 'legacy-env' | 'none';
  /** The deprecated DISCORD_SUPPRESS_REACTION_EMOJIS env is set but the
   *  file key is authoritative — the env is ignored, never unioned. */
  legacyEnvIgnored?: true;
  /** Source is the deprecated env alias; migrate to the file key. */
  deprecated?: true;
}

interface CompiledSet {
  /** Raw tokens exactly as configured — never surfaced in status. */
  tokens: string[];
  matchSet: Set<string>;
  idSet: Set<string>;
  digest: string;
}

function compileTokens(tokens: string[]): CompiledSet {
  const normalized = tokens.map(normalizeReactionEmoji).filter(Boolean);
  return {
    tokens,
    matchSet: new Set(normalized),
    idSet: new Set(normalized.filter((t) => SNOWFLAKE.test(t))),
    digest: sha256(JSON.stringify([...normalized].sort())),
  };
}

/**
 * One desired/effective/status state for the whole Discord filters plane,
 * plus the reaction-suppression projection derived from it.
 *
 * This class holds no file I/O of its own: the filters lifecycle (env seed
 * → DISCORD_FILTERS_FILE → 3s mtime poller → filters_update) drives it
 * through applyParsed()/markBroken(). Guild/DM whitelists and the
 * suppression key share one staleness model because they fail together —
 * an unparseable rewrite or deleted file makes ALL of them stale, and
 * reporting that per-plane (not per-key) is what keeps disk≠process from
 * hiding.
 *
 * Suppression sources, in precedence order:
 * - file key present (even empty): sole authority. A concurrently-set
 *   legacy env is IGNORED — never unioned — with a glyph-free warning.
 * - file key absent, DISCORD_SUPPRESS_REACTION_EMOJIS set at startup: the
 *   deprecated compatibility source (process-static snapshot; changing the
 *   env requires a restart). Pre-existing filter files that lack the key
 *   stay on this source — no surprise rewrite of an operator's file.
 * - neither: honestly off.
 *
 * Failure posture when the plane breaks (markBroken), decided by what the
 * last GOOD parse established:
 * - good parse exists, key had entries → suppression 'stale': keep
 *   enforcing the last-known-good set. Process-lifetime only.
 * - good parse exists, key was empty → 'unavailable': withhold ALL
 *   reactions. An empty set is deliberately not a fallback — it suppresses
 *   nothing, so keeping it would fail open on the expected deployment
 *   sequence (ship the key empty, then typo the first real entries).
 * - good parse exists, key absent → the file never carried suppression, so
 *   its brokenness says nothing about suppression intent: the env snapshot
 *   (or nothing) continues; the plane status carries the invalid/missing
 *   fact.
 * - no good parse ever (broken at startup) → 'unavailable': intent is
 *   unknowable and a configured plane must not fail open. Whitelists run
 *   on the env fallback meanwhile; this widens a whitelist typo's blast
 *   radius to reactions — accepted: the failure is loud, message delivery
 *   is unaffected, and history surfaces carry an explicit
 *   reactionsUnavailable marker instead of a false "none".
 */
export class DiscordFiltersState {
  private readonly fileConfigured: boolean;
  private effectiveF: DiscordFilters | null = null;
  private planeDigest: string | null = null;
  private loadedAt: string | null = null;
  private broken: { since: string; desired: 'invalid' | 'missing' } | null = null;

  /** Suppression derivation over the effective filters. */
  private keyPresent = false;
  private suppression: CompiledSet | null = null;
  /** Deprecated env source, snapshotted once — process-static. */
  private readonly legacySet: CompiledSet | null;
  private warnedLegacyIgnored = false;

  constructor(opts?: { fileConfigured?: boolean; legacyEnv?: string }) {
    this.fileConfigured = opts?.fileConfigured ?? !!process.env.DISCORD_FILTERS_FILE;
    const raw =
      opts && 'legacyEnv' in opts ? opts.legacyEnv : process.env.DISCORD_SUPPRESS_REACTION_EMOJIS;
    const tokens = parseSuppressionEnvTokens(raw);
    this.legacySet = tokens.length ? compileTokens(tokens) : null;
  }

  /** Apply a successfully-parsed DiscordFilters. Called at startup, from
   *  the poller on every good reload, and after filters_update saves. */
  applyParsed(filters: DiscordFilters): void {
    this.broken = null;
    const normalized = normalizeFilters(filters);
    const digest = sha256(stableStringify(normalized));
    if (digest !== this.planeDigest) this.loadedAt = new Date().toISOString();
    this.planeDigest = digest;
    this.effectiveF = normalized;
    const list = normalized.suppressedReactionEmojis;
    this.keyPresent = list !== undefined;
    this.suppression = list !== undefined ? compileTokens(list) : null;
    this.warnLegacyIgnoredOnce();
  }

  /** The desired state on disk is unreadable ('invalid') or the file is
   *  gone ('missing'). Effective state is retained as last-known-good.
   *  Returns true on the transition (callers log once, not per poll). */
  markBroken(desired: 'invalid' | 'missing'): boolean {
    if (this.broken) {
      this.broken.desired = desired;
      return false;
    }
    this.broken = { since: new Date().toISOString(), desired };
    return true;
  }

  /** The effective filters (normalized), or null before any good parse. */
  effectiveFilters(): DiscordFilters | null {
    return this.effectiveF;
  }

  planeStatus(): FiltersPlaneStatus {
    if (!this.fileConfigured) {
      return { status: 'env-static', effectiveDigest: this.planeDigest, ...(this.loadedAt ? { loadedAt: this.loadedAt } : {}) };
    }
    const loaded = this.loadedAt ? { loadedAt: this.loadedAt } : {};
    if (this.broken) {
      return {
        status: this.effectiveF ? 'stale' : 'unavailable',
        desiredState: this.broken.desired,
        effectiveDigest: this.planeDigest,
        staleSince: this.broken.since,
        ...loaded,
      };
    }
    return { status: 'live', desiredState: 'ok', effectiveDigest: this.planeDigest, ...loaded };
  }

  /** Glyph-free once-per-process warning that the env alias is being
   *  ignored because the file key is authoritative. */
  private warnLegacyIgnoredOnce(): void {
    if (this.warnedLegacyIgnored || !this.keyPresent || !this.legacySet) return;
    this.warnedLegacyIgnored = true;
    console.error(
      `[discord-mcpl] reaction-suppression: DISCORD_SUPPRESS_REACTION_EMOJIS is set (${this.legacySet.matchSet.size} tokens) ` +
        'but the filters file suppressedReactionEmojis key is authoritative — the env is IGNORED, not merged. ' +
        'Fold its entries into the filters file and unset the env (alias retires per issue #16).',
    );
  }

  /** The set currently matched against, if any: the file key when present
   *  (including a stale LKG), else the startup env snapshot. */
  private effectiveSet(): CompiledSet | null {
    if (this.keyPresent) return this.suppression;
    return this.legacySet;
  }

  /** True when the withhold-everything failure posture is on: the plane is
   *  broken and the last good parse left no usable set (or never
   *  happened). Known key-absence does NOT withhold — the env snapshot (or
   *  nothing) continues, and the plane status carries the broken fact. */
  suppressAll(): boolean {
    if (!this.broken) return false;
    if (!this.effectiveF) return true;
    if (!this.keyPresent) return false;
    return !(this.suppression && this.suppression.matchSet.size > 0);
  }

  isSuppressed(reaction: { emojiId?: string | null; emoji: string }): boolean {
    const set = this.effectiveSet();
    if (!set) return false;
    if (reaction.emojiId && set.idSet.has(reaction.emojiId)) return true;
    return set.matchSet.has(normalizeReactionEmoji(reaction.emoji));
  }

  /** Project a reaction list for model-visible output. `unavailable` is set
   *  when suppression happened for plane-failure reasons — callers surface
   *  a structured flag rather than an empty list that falsely means
   *  "none". */
  project<T extends { emojiId?: string | null; emoji: string }>(
    reactions: T[] | undefined,
  ): { reactions: T[]; unavailable: boolean } {
    if (this.suppressAll()) return { reactions: [], unavailable: true };
    if (!reactions || reactions.length === 0) return { reactions: reactions ?? [], unavailable: false };
    return { reactions: reactions.filter((r) => !this.isSuppressed(r)), unavailable: false };
  }

  suppressionStatus(): ReactionSuppressionStatus {
    this.warnLegacyIgnoredOnce();
    if (this.suppressAll()) {
      return {
        status: 'unavailable',
        protectionActive: true,
        effectiveCount: 0,
        effectiveDigest: null,
        suppressingAllReactions: true,
        source: this.keyPresent ? 'file' : 'none',
      };
    }
    if (this.keyPresent) {
      const n = this.suppression?.matchSet.size ?? 0;
      const legacyIgnored = this.legacySet ? { legacyEnvIgnored: true as const } : {};
      if (this.broken) {
        // suppressAll() already routed the unusable-LKG cases away, so the
        // stale set has entries and stays enforced.
        return {
          status: 'stale',
          protectionActive: true,
          effectiveCount: n,
          effectiveDigest: this.suppression!.digest,
          source: 'file',
          ...legacyIgnored,
        };
      }
      return {
        status: n > 0 ? 'active' : 'configured-empty',
        protectionActive: n > 0,
        effectiveCount: n,
        effectiveDigest: n > 0 ? this.suppression!.digest : null,
        source: 'file',
        ...legacyIgnored,
      };
    }
    if (this.legacySet) {
      return {
        status: 'active',
        protectionActive: true,
        effectiveCount: this.legacySet.matchSet.size,
        effectiveDigest: this.legacySet.digest,
        source: 'legacy-env',
        deprecated: true,
      };
    }
    return {
      status: 'not-configured',
      protectionActive: false,
      effectiveCount: 0,
      effectiveDigest: null,
      source: 'none',
    };
  }
}
