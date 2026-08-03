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
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DiscordFilters {
  /** Allowed guild ids. Unset = all guilds. */
  guildIds?: string[];
  /** Per-guild channel whitelist. A guild with no entry = all its channels. */
  guildChannels?: Record<string, string[]>;
  /** Allowed DM author ids. Unset = all DM users. */
  dmUsers?: string[];
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

/* ------------------------------------------------------------------------- *
 * Reaction-emoji matching (shared normalization)
 *
 * Hosts mark inference refusals by reacting to the triggering message with a
 * category emoji. Letting those reactions re-enter agent context feeds
 * classifier-meta back into the very windows that are refusing: a
 * self-amplifying loop, observed cross-agent (Mythos 2026-08-03).
 *
 * The 2026-08-03 emergency containment lived here as a parallel filter
 * (DISCORD_SUPPRESS_REACTION_EMOJIS helpers). That surface is gone: the env
 * var now feeds ReservedReactionsPolicy (reserved-reactions.ts) as a
 * deprecated legacy source, and ONLY the normalization below remains — the
 * single implementation of the legacy matching semantics, consumed by the
 * policy's labeled legacy adapter.
 * ------------------------------------------------------------------------- */

/** Normalize a reaction emoji for legacy-source matching: strip VS-16
 *  (U+FE0F) so "☣️" and "☣" compare equal, and strip surrounding colons so a
 *  custom emoji matches whether configured as ":sigil:" or "sigil". */
export function normalizeReactionEmoji(emoji: string): string {
  return emoji.replace(/\uFE0F/g, '').trim().replace(/^:|:$/g, '');
}
