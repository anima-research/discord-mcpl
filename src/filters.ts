import { readFileSync, statSync, existsSync } from 'node:fs';
import { writeJsonFile } from './persisted-json.js';
import { createHash } from 'node:crypto';

export interface DiscordFilters {
  guildIds?: string[];
  guildChannels?: Record<string, string[]>;
  dmUsers?: string[];
  suppressedReactionEmojis?: string[];
}

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

export function loadFiltersFile(path: string): DiscordFilters | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
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

export function saveFiltersFile(path: string, filters: DiscordFilters): void {
  writeJsonFile(path, normalizeFilters(filters));
}

export function filtersFileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

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
    const legacyPresent = env.DISCORD_SUPPRESS_REACTION_EMOJIS !== undefined;
    const legacySeed = parseSuppressionEnvTokens(env.DISCORD_SUPPRESS_REACTION_EMOJIS);
    const baselineSeed = parseSuppressionEnvTokens(env.DISCORD_SUPPRESSED_REACTIONS_BASELINE);
    let seeded = filters;
    let seedNote = '';
    if (legacyPresent) {
      seeded = { ...filters, suppressedReactionEmojis: legacySeed };
      seedNote = legacySeed.length
        ? ` (incl. ${legacySeed.length} suppressed-reaction entries from DISCORD_SUPPRESS_REACTION_EMOJIS — the file key is now authoritative)`
        : ' (DISCORD_SUPPRESS_REACTION_EMOJIS is present but empty — written as an explicit empty suppression key: operator chose none)';
    } else if (baselineSeed.length) {
      seeded = { ...filters, suppressedReactionEmojis: baselineSeed };
      seedNote = ` (incl. ${baselineSeed.length} suppressed-reaction entries from DISCORD_SUPPRESSED_REACTIONS_BASELINE — the file key is now authoritative)`;
    }
    try {
      saveFiltersFile(filtersFile, seeded);
      filters = seeded;
      console.error(`[discord-mcpl] filters file seeded from env -> ${filtersFile}${seedNote}`);
    } catch (err) {
      console.error(`[discord-mcpl] could not seed filters file ${filtersFile}:`, (err as Error).message);
    }
  }
  return { filters, fileBroken };
}

/** One missing observation is grace: a non-atomic editor may be mid-replace.
 *  A file restored from a backup can carry different bytes under an
 *  identical mtime, so a vanished file that reappears forces a reload. */
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

/*
 * Hosts mark inference refusals by reacting to the triggering message with a
 * category emoji; letting those reactions back into an agent's context feeds
 * the refusal back into the windows that are refusing. The Agent Framework
 * owns the refusal-category-to-reaction map, and host composition injects the
 * set as DISCORD_SUPPRESSED_REACTIONS_BASELINE. A running process's
 * environment can't be changed from outside it, so
 * DISCORD_SUPPRESS_REACTION_EMOJIS is read once, at startup.
 */

/** Discord may send a reaction emoji with or without VS-16 (U+FE0F), and a
 *  custom emoji may be configured with or without its colons. */
export function normalizeReactionEmoji(emoji: string): string {
  return emoji.replace(/\uFE0F/g, '').trim().replace(/^:|:$/g, '');
}

/** Discord snowflakes are 64-bit decimal ids; every real one is 17–20 digits. */
const SNOWFLAKE = /^\d{17,20}$/;

export function parseSuppressionEnvTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => normalizeReactionEmoji(s));
}

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
   *  stale: the desired state is unreadable or missing, and the last-known-good
   *  whitelists are still enforced, for this process only; the suppression
   *  status says what suppression enforces. unavailable: unreadable or missing
   *  with no good parse this process: the whitelists run on the environment
   *  fallback, and reactions are withheld. env-static: no
   *  DISCORD_FILTERS_FILE; the filters came from the environment at startup
   *  and can't change without a restart. */
  status: 'live' | 'stale' | 'unavailable' | 'env-static';
  desiredState?: 'ok' | 'invalid' | 'missing';
  effectiveDigest: string | null;
  loadedAt?: string;
  staleSince?: string;
}

export interface ReactionSuppressionBaselineDelta {
  baselineCount: number;
  missingCount: number;
  additionalCount: number;
}

export interface ReactionSuppressionStatus {
  /** not-configured: no suppression anywhere. configured-empty: an explicitly
   *  empty list in the file, or an empty legacy variable where it overrides
   *  the baseline. active: entries are being
   *  enforced. stale: the plane broke after a good load with entries, and those
   *  last-known-good entries are still enforced. unavailable: every reaction is
   *  withheld until the file is repaired. */
  status: 'not-configured' | 'configured-empty' | 'active' | 'stale' | 'unavailable';
  protectionActive: boolean;
  effectiveCount: number;
  effectiveDigest: string | null;
  suppressingAllReactions?: true;
  /** baseline-default: no operator configuration exists anywhere, so the
   *  host-injected baseline is in force. */
  source: 'file' | 'legacy-env' | 'baseline-default' | 'none';
  legacyEnvIgnored?: true;
  deprecated?: true;
  baselineDelta?: ReactionSuppressionBaselineDelta;
}

interface CompiledSet {
  tokens: string[];
  matchSet: Set<string>;
  idSet: Set<string>;
  digest: string;
}

function compileTokens(tokens: string[]): CompiledSet {
  const normalized = [...new Set(tokens.map(normalizeReactionEmoji).filter(Boolean))];
  return {
    tokens,
    matchSet: new Set(normalized),
    idSet: new Set(normalized.filter((t) => SNOWFLAKE.test(t))),
    digest: sha256(JSON.stringify([...normalized].sort())),
  };
}

export class DiscordFiltersState {
  private readonly fileConfigured: boolean;
  private effectiveF: DiscordFilters | null = null;
  private planeDigest: string | null = null;
  private loadedAt: string | null = null;
  private broken: { since: string; desired: 'invalid' | 'missing' } | null = null;

  private keyPresent = false;
  private suppression: CompiledSet | null = null;
  private readonly legacySet: CompiledSet | null;
  private readonly legacyPresent: boolean;
  private readonly baselineSet: CompiledSet | null;
  private warnedLegacyIgnored = false;
  private baselineDelta: ReactionSuppressionBaselineDelta | undefined;
  private lastMissingBaselineDigest: string | null = null;

  constructor(opts?: { fileConfigured?: boolean; legacyEnv?: string; baselineEnv?: string }) {
    this.fileConfigured = opts?.fileConfigured ?? !!process.env.DISCORD_FILTERS_FILE;
    const legacyRaw =
      opts && 'legacyEnv' in opts ? opts.legacyEnv : process.env.DISCORD_SUPPRESS_REACTION_EMOJIS;
    this.legacyPresent = legacyRaw !== undefined;
    const legacyTokens = parseSuppressionEnvTokens(legacyRaw);
    this.legacySet = legacyTokens.length ? compileTokens(legacyTokens) : null;
    const baselineRaw =
      opts && 'baselineEnv' in opts ? opts.baselineEnv : process.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE;
    const baselineTokens = parseSuppressionEnvTokens(baselineRaw);
    this.baselineSet = baselineTokens.length ? compileTokens(baselineTokens) : null;
  }

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
    this.updateBaselineDelta();
  }

  markBroken(desired: 'invalid' | 'missing'): boolean {
    if (this.broken) {
      this.broken.desired = desired;
      return false;
    }
    this.broken = { since: new Date().toISOString(), desired };
    return true;
  }

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

  private warnLegacyIgnoredOnce(): void {
    if (this.warnedLegacyIgnored || !this.keyPresent || !this.legacySet) return;
    this.warnedLegacyIgnored = true;
    console.error(
      `[discord-mcpl] reaction-suppression: DISCORD_SUPPRESS_REACTION_EMOJIS is set (${this.legacySet.matchSet.size} tokens) ` +
        'but the filters file suppressedReactionEmojis key is authoritative — the env is IGNORED, not merged. ' +
        'Fold its entries into the filters file and unset the env (alias retires per issue #16).',
    );
  }

  private updateBaselineDelta(): void {
    if (!this.suppression || !this.baselineSet) {
      this.baselineDelta = undefined;
      this.lastMissingBaselineDigest = null;
      return;
    }
    const missing = [...this.baselineSet.matchSet].filter((t) => !this.suppression!.matchSet.has(t));
    const additional = [...this.suppression.matchSet].filter((t) => !this.baselineSet!.matchSet.has(t));
    this.baselineDelta = {
      baselineCount: this.baselineSet.matchSet.size,
      missingCount: missing.length,
      additionalCount: additional.length,
    };
    const missingDigest = missing.length ? sha256(JSON.stringify(missing.sort())) : null;
    if (missingDigest && missingDigest !== this.lastMissingBaselineDigest) {
      console.error(
        `[discord-mcpl] reaction-suppression: filters file key is missing ${missing.length} entries ` +
          'present in the injected baseline — the file is authoritative; add them if the omission was not deliberate. ' +
          'Compare the operator file with DISCORD_SUPPRESSED_REACTIONS_BASELINE; entries are omitted from diagnostics.',
      );
    }
    this.lastMissingBaselineDigest = missingDigest;
  }

  private effectiveSet(): CompiledSet | null {
    if (this.keyPresent) return this.suppression;
    if (this.legacyPresent) return this.legacySet;
    return this.baselineSet;
  }

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
      const baselineDelta = this.baselineDelta ? { baselineDelta: { ...this.baselineDelta } } : {};
      if (this.broken) {
        return {
          status: 'stale',
          protectionActive: true,
          effectiveCount: n,
          effectiveDigest: this.suppression!.digest,
          source: 'file',
          ...legacyIgnored,
          ...baselineDelta,
        };
      }
      return {
        status: n > 0 ? 'active' : 'configured-empty',
        protectionActive: n > 0,
        effectiveCount: n,
        effectiveDigest: n > 0 ? this.suppression!.digest : null,
        source: 'file',
        ...legacyIgnored,
        ...baselineDelta,
      };
    }
    if (this.legacyPresent) {
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
      if (this.baselineSet) {
        return {
          status: 'configured-empty',
          protectionActive: false,
          effectiveCount: 0,
          effectiveDigest: null,
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
    if (this.baselineSet) {
      return {
        status: 'active',
        protectionActive: true,
        effectiveCount: this.baselineSet.matchSet.size,
        effectiveDigest: this.baselineSet.digest,
        source: 'baseline-default',
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
