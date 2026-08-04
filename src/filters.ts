/**
 * Discord event filters (guild/channel whitelist + DM user whitelist) with
 * optional hot-reload from a JSON file.
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
 *     "dmUsers": ["555"]
 *   }
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
   *  they live in this file, below the model line. See ReactionSuppression
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

/** Load + validate the filters file. Returns null when the file is missing or
 *  unparseable — callers keep the previous filters (fail-safe, never fail-open). */
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
    if (Array.isArray(r.suppressedReactionEmojis)) {
      out.suppressedReactionEmojis = r.suppressedReactionEmojis.map(String);
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
 *   the key so the env stays the live (legacy) source. */
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

/* ------------------------------------------------------------------------- *
 * Reaction suppression (issue #21, folded into this plane per PR #13 review)
 *
 * Hosts mark inference refusals by reacting to the triggering message with a
 * category emoji. Letting those reactions re-enter agent context feeds
 * classifier-meta back into the very windows that are refusing: a
 * self-amplifying loop, observed cross-agent (Mythos 2026-08-03).
 *
 * The suppression list lives in THIS file's plane as
 * `suppressedReactionEmojis` — one config plane, one reload lifecycle, one
 * matcher (ReactionSuppression below). The 2026-08-03 emergency env
 * (DISCORD_SUPPRESS_REACTION_EMOJIS) seeds the file on first
 * materialization and otherwise survives as a deprecated legacy source
 * with its exact original semantics until fleet inventory shows migrated
 * files (issue #16).
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
 *  materialization and by the deprecated live legacy-env source. */
export function parseSuppressionEnvTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => normalizeReactionEmoji(s));
}

export interface ReactionSuppressionStatus {
  /** not-configured: no suppression anywhere — reported plainly, never
   *  implying protection. configured-empty: the file key exists with zero
   *  entries (deliberate operator clear; mechanism present, protection
   *  not). active: entries are being enforced. stale: the file broke after
   *  a good load and the last-known-good entries are STILL ENFORCED —
   *  process-lifetime only, they do not survive a restart. unavailable:
   *  the file is unreadable with no usable previous set, so every reaction
   *  is being withheld. */
  status: 'not-configured' | 'configured-empty' | 'active' | 'stale' | 'unavailable';
  /** True whenever reactions are actually being withheld from the model
   *  (enforced entries, a stale LKG set, or the withhold-everything
   *  failure posture); false when nothing is suppressed. */
  protectionActive: boolean;
  /** Distinct entries currently enforced (post-normalization). */
  effectiveCount: number;
  /** Full machine digest (`sha256:<hex>`) of the normalized enforced set;
   *  null when nothing is enforced. Lets an operator correlate the running
   *  state against the file without any glyph leaving the file plane.
   *  Deliberately no revision counter: the plane is an mtime-polled file
   *  with no durable monotonic source, and inventing one here would imply
   *  more than the poller provides. */
  effectiveDigest: string | null;
  /** When the current effective set was applied, in this process. */
  loadedAt?: string;
  /** The filters file is currently unparseable/unreadable — the DESIRED
   *  state cannot be determined from disk. Present on every status shape
   *  while the file is broken, whatever the enforcement posture. */
  desiredState?: 'invalid';
  /** status 'stale' only: when the file broke. The enforced set predates
   *  this moment and lives only as long as the process. */
  staleSince?: string;
  /** status 'unavailable' only: the withhold-everything posture is on. */
  suppressingAllReactions?: true;
  source: 'file' | 'legacy-env' | 'none';
  /** The deprecated DISCORD_SUPPRESS_REACTION_EMOJIS env is set but the
   *  file key is authoritative — the env is ignored, never unioned. */
  legacyEnvIgnored?: true;
  /** Source is the deprecated env alias; migrate to the file key. */
  deprecated?: true;
}

interface CompiledSet {
  /** Raw tokens exactly as configured — carried through filters_update
   *  rewrites, never surfaced in status/diagnostics. */
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
    digest: 'sha256:' + createHash('sha256').update(JSON.stringify([...normalized].sort())).digest('hex'),
  };
}

/**
 * Reaction-suppression state, fed by the DiscordFilters plane.
 *
 * This class holds no file I/O of its own: the existing filters lifecycle
 * (env seed → DISCORD_FILTERS_FILE → 3s mtime poller → filters_update)
 * drives it through applyFilters()/markUnavailable(). One config plane, one
 * reload path, one matcher.
 *
 * Sources, in precedence order:
 * - file key present (even empty): sole authority. A concurrently-set
 *   legacy env is IGNORED — never unioned — with a glyph-free warning.
 *   Unioning would let stale hidden config silently broaden suppression
 *   and make the reviewed file non-authoritative.
 * - file key absent, DISCORD_SUPPRESS_REACTION_EMOJIS set: the deprecated
 *   compatibility source, preserving the 2026-08-03 emergency filter's
 *   exact semantics (re-read per decision so env edits apply without
 *   restart). Pre-existing filter files that lack the key stay on this
 *   source — there is no surprise rewrite of an operator's file; the alias
 *   retires only once fleet inventory shows migrated files (issue #16).
 * - neither: honestly off.
 *
 * Failure posture when the filters file breaks (markUnavailable), decided
 * by what the last GOOD parse established:
 * - key present with entries → 'stale': keep enforcing the last-known-good
 *   set (stale correct suppression beats none). Process-lifetime only — a
 *   restart into a still-broken file lands in 'unavailable', not here.
 * - key present but empty → 'unavailable': withhold ALL reactions. An
 *   empty set is deliberately not a fallback: it suppresses nothing, so
 *   keeping it would fail open on the expected deployment sequence (ship
 *   the key empty, then typo the first real entries).
 * - key absent → the file never carried suppression, so its brokenness
 *   says nothing about suppression intent: the live env source (or
 *   nothing) continues, with desiredState:'invalid' reported.
 * - never parsed (broken at startup) → 'unavailable': intent is unknowable
 *   and a configured plane must not fail open. This widens a whitelist
 *   typo's blast radius to reactions — accepted: the failure is loud,
 *   message delivery is unaffected, and history surfaces carry an explicit
 *   reactionsUnavailable marker instead of a false "none".
 */
export class ReactionSuppression {
  /** A successful parse has been applied at least once this process. */
  private loadedOnce = false;
  /** The last successfully-parsed filters had the suppression key. */
  private keyPresent = false;
  private current: CompiledSet | null = null;
  private loadedAt: string | null = null;
  private broken: { since: string; reason: string } | null = null;
  private warnedLegacyIgnored = false;

  /** Deprecated env source, compiled lazily and cached by raw value. */
  private readonly legacyEnvReader: () => string | undefined;
  private legacyRaw: string | undefined | null = null;
  private legacyCompiled: CompiledSet | null = null;

  constructor(legacyEnvReader?: () => string | undefined) {
    this.legacyEnvReader = legacyEnvReader ?? (() => process.env.DISCORD_SUPPRESS_REACTION_EMOJIS);
  }

  /** Apply a successfully-parsed DiscordFilters. Called at startup, from
   *  the poller on every good reload, and after filters_update saves. */
  applyFilters(filters: DiscordFilters): void {
    this.loadedOnce = true;
    this.broken = null;
    const list = filters.suppressedReactionEmojis;
    this.keyPresent = list !== undefined;
    const compiled = list !== undefined ? compileTokens(list) : null;
    if (compiled?.digest !== this.current?.digest) this.loadedAt = new Date().toISOString();
    this.current = compiled;
    this.warnLegacyIgnoredOnce();
  }

  /** The filters file changed but could not be parsed (or was unreadable at
   *  startup while configured). Enforcement posture per the class doc. */
  markUnavailable(reason: string): void {
    if (!this.broken) this.broken = { since: new Date().toISOString(), reason };
  }

  /** Raw tokens for carrying the key through a filters-file rewrite —
   *  filters_update must not drop an operator's suppression entries when it
   *  saves whitelist changes. undefined = key not present in the last good
   *  parse. */
  fileTokens(): string[] | undefined {
    return this.keyPresent ? this.current?.tokens ?? [] : undefined;
  }

  private legacyEnv(): CompiledSet | null {
    const raw = this.legacyEnvReader();
    if (raw !== this.legacyRaw) {
      this.legacyRaw = raw;
      const tokens = parseSuppressionEnvTokens(raw);
      this.legacyCompiled = tokens.length ? compileTokens(tokens) : null;
    }
    return this.legacyCompiled;
  }

  /** The set currently being matched against, if any: the file key when
   *  present (including a stale LKG), else the live legacy env. */
  private effective(): CompiledSet | null {
    if (this.keyPresent) return this.current;
    return this.legacyEnv();
  }

  /** Glyph-free once-per-process warning that the env alias is being
   *  ignored because the file key is authoritative. */
  private warnLegacyIgnoredOnce(): void {
    if (this.warnedLegacyIgnored || !this.keyPresent) return;
    const legacy = this.legacyEnv();
    if (!legacy) return;
    this.warnedLegacyIgnored = true;
    console.error(
      `[discord-mcpl] reaction-suppression: DISCORD_SUPPRESS_REACTION_EMOJIS is set (${legacy.matchSet.size} tokens) ` +
        'but the filters file suppressedReactionEmojis key is authoritative — the env is IGNORED, not merged. ' +
        'Fold its entries into the filters file and unset the env (alias retires per issue #16).',
    );
  }

  /** True when the withhold-everything failure posture is on: the filters
   *  file is broken and the last good parse left no usable set to enforce
   *  (or never happened). */
  suppressAll(): boolean {
    if (!this.broken) return false;
    if (!this.loadedOnce) return true;
    if (!this.keyPresent) return false; // known absence: env (or nothing) continues
    return !(this.current && this.current.matchSet.size > 0);
  }

  isSuppressed(reaction: { emojiId?: string | null; emoji: string }): boolean {
    const set = this.effective();
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

  status(): ReactionSuppressionStatus {
    this.warnLegacyIgnoredOnce();
    const invalid = this.broken ? { desiredState: 'invalid' as const } : {};
    const loaded = this.loadedAt ? { loadedAt: this.loadedAt } : {};

    if (this.suppressAll()) {
      return {
        status: 'unavailable',
        protectionActive: true,
        effectiveCount: 0,
        effectiveDigest: null,
        suppressingAllReactions: true,
        source: this.keyPresent ? 'file' : 'none',
        ...invalid,
        ...loaded,
      };
    }

    if (this.keyPresent) {
      const n = this.current?.matchSet.size ?? 0;
      const legacyIgnored = this.legacyEnv() ? { legacyEnvIgnored: true as const } : {};
      if (this.broken) {
        // Stale: the file broke after a good load; the LKG set is still
        // enforced. suppressAll() already routed the unusable-LKG cases
        // away, so n > 0 here.
        return {
          status: 'stale',
          protectionActive: true,
          effectiveCount: n,
          effectiveDigest: this.current!.digest,
          staleSince: this.broken.since,
          source: 'file',
          ...invalid,
          ...loaded,
          ...legacyIgnored,
        };
      }
      return {
        status: n > 0 ? 'active' : 'configured-empty',
        protectionActive: n > 0,
        effectiveCount: n,
        effectiveDigest: n > 0 ? this.current!.digest : null,
        source: 'file',
        ...loaded,
        ...legacyIgnored,
      };
    }

    const legacy = this.legacyEnv();
    if (legacy) {
      return {
        status: 'active',
        protectionActive: true,
        effectiveCount: legacy.matchSet.size,
        effectiveDigest: legacy.digest,
        source: 'legacy-env',
        deprecated: true,
        ...invalid,
      };
    }
    return {
      status: 'not-configured',
      protectionActive: false,
      effectiveCount: 0,
      effectiveDigest: null,
      source: 'none',
      ...invalid,
    };
  }
}
