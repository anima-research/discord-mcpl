/**
 * Name-based channel addressing.
 *
 * WHY
 * Send tools require the raw channel snowflake verbatim. Models *regenerate*
 * these token-by-token rather than copying them, and snowflakes are worst-case
 * objects for that: pure digit sequences, no semantic redundancy, no checksum.
 * Three observed failure modes (see the feature request in the memory repo,
 * `shared/projects/channel_addressing_patch.md`):
 *
 *   1. Mangled id      — blends two in-context ids. Bounces loudly. Annoying.
 *   2. Stale default   — id-less send falls back to "most recent channel",
 *                        which is state, and state goes stale. SILENT.
 *   3. Wrong-valid-id  — plucks a real-but-wrong id from context. SILENT.
 *
 * The silent ones are the dangerous ones.
 *
 * DESIGN: accept back the string we already print.
 * `toDescriptor` (channels.ts) already labels channels `#name (GuildName)`, and
 * the server already announces channels to agents in that form. So this adds no
 * new naming scheme — anything visible in a channel listing becomes pasteable
 * into a send. Display form == address form.
 *
 * Guild qualification matters more than it looks. Bare `#general` collides
 * across guilds, and a bot in several servers hits that constantly rather than
 * rarely — so "hard-error on ambiguity" alone would send agents straight back to
 * snowflakes exactly as the channel count grows. The qualified form always
 * resolves, and the ambiguity error quotes qualified labels (addresses, not
 * snowflakes) so even the failure hands you something usable.
 *
 * NO FUZZY MATCHING. Exact name, case-insensitive, leading `#` optional. A
 * "did you mean" would reintroduce silent wrong-room delivery in friendlier
 * packaging, which is failure mode 3 with better manners.
 *
 * This module is deliberately free of discord.js so it can be unit-tested
 * without a gateway connection; the adapter supplies live candidates.
 */

/** Discord snowflakes are 17-20 digits. Anything all-digits in that range is
 *  treated as an id and passed through untouched (backwards compatible). */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/** A channel the bot can currently see, already filtered by the allowlist. */
export interface ChannelCandidate {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
}

/** `#name (GuildName)` — the same string `toDescriptor` produces. */
export function channelLabel(c: ChannelCandidate): string {
  return `#${c.name} (${c.guildName})`;
}

export type ChannelRef =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string; guild?: string };

/**
 * Parse an incoming channelId argument.
 *
 * Accepted:
 *   `123456789012345678`            -> id (passthrough)
 *   `discord:<guildId>:<channelId>` -> id (the existing MCPL composite)
 *   `#general` / `general`          -> name, unqualified
 *   `#general (Separatrix)`         -> name, guild-qualified
 *
 * Returns null for input that is neither a usable id nor a plausible name.
 */
export function parseChannelRef(raw: string): ChannelRef | null {
  const value = raw.trim();
  if (!value) return null;

  if (isSnowflake(value)) return { kind: 'id', id: value };

  // Existing MCPL composite: discord:<guildId>:<channelId>. Matched with the
  // SAME predicate as parseMcplChannelId (channels.ts) and deliberately no
  // stricter -- an extra isSnowflake check here would reject composites the
  // rest of the codebase accepts, e.g. wherever ids are not Discord-shaped.
  const parts = value.split(':');
  if (parts.length === 3 && parts[0] === 'discord') {
    return { kind: 'id', id: parts[2] };
  }

  // `#name (Guild)` — guild in trailing parens. Guild names can contain almost
  // anything, so match the LAST parenthesised group and take the rest as name.
  const qualified = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(value);
  if (qualified && qualified[2].trim()) {
    const name = stripHash(qualified[1]);
    if (name) return { kind: 'name', name, guild: qualified[2].trim() };
  }

  const name = stripHash(value);
  return name ? { kind: 'name', name } : null;
}

function stripHash(value: string): string {
  return value.trim().replace(/^#/, '').trim();
}

export type ResolveResult =
  | { ok: true; id: string; matched: ChannelCandidate }
  | { ok: false; reason: 'not-found' | 'ambiguous'; message: string };

/**
 * Resolve a parsed name against live candidates.
 *
 * The caller MUST have already applied the channel allowlist — disallowed
 * channels must not reach here, both so a name cannot address a channel the
 * allowlist excludes, and so a forbidden `#general` cannot manufacture a
 * spurious collision with a permitted one.
 */
export function resolveChannelName(
  ref: { name: string; guild?: string },
  candidates: ChannelCandidate[],
): ResolveResult {
  const wantName = ref.name.toLowerCase();
  const wantGuild = ref.guild?.toLowerCase();

  let matches = candidates.filter((c) => c.name.toLowerCase() === wantName);
  if (wantGuild) {
    matches = matches.filter((c) => c.guildName.toLowerCase() === wantGuild);
  }

  if (matches.length === 1) return { ok: true, id: matches[0].id, matched: matches[0] };

  if (matches.length === 0) {
    const near = candidates.filter((c) => c.name.toLowerCase() === wantName);
    if (wantGuild && near.length) {
      // The name exists, but not in the guild asked for. Say so precisely —
      // this is a different mistake from "no such channel" and deserves a
      // different message.
      return {
        ok: false,
        reason: 'not-found',
        message:
          `No channel #${ref.name} in a guild named "${ref.guild}". ` +
          `That name exists elsewhere: ${near.map(channelLabel).join(', ')}`,
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      message:
        `No visible channel named #${ref.name}` +
        (ref.guild ? ` in "${ref.guild}"` : '') +
        `. Use list_channels to see what is addressable.`,
    };
  }

  // Ambiguous. Quote the QUALIFIED LABELS rather than raw ids: those are
  // themselves valid addresses, so the error hands back something usable
  // instead of forcing a fall back to snowflakes.
  return {
    ok: false,
    reason: 'ambiguous',
    message:
      `#${ref.name} is ambiguous — ${matches.length} channels match. ` +
      `Re-send with one of: ${matches.map((c) => `"${channelLabel(c)}"`).join(', ')}`,
  };
}

/** How a send was addressed. Logged so drift incidents have receipts rather
 *  than being reconstructed from memory after the fact. */
export type AddressingPath = 'explicit-id' | 'name-resolved' | 'default-aim';
