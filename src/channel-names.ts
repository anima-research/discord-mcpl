/** Discord snowflakes are 17-20 digits. */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/** A channel the bot can currently see, already filtered by the allowlist. */
export interface ChannelCandidate {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  /** A stock Discord server ships a voice channel named "General" beside text
   *  #general, and matching is case-insensitive. */
  type: 'text' | 'announcement' | 'voice' | 'stage' | 'forum' | 'unknown';
}

/**
 * THE canonical `#name (GuildName)` formatter. Display form == address form is
 * the load-bearing claim of this whole module: the string a listing prints must
 * be the string a send accepts. That invariant cannot survive being reimplemented
 * per call site — a divergence anywhere silently makes labels unpasteable, and no
 * test would catch it because each side would agree with itself. So every
 * producer of this string (toDescriptor, the adapter's listing and event paths)
 * routes through here.
 *
 * Takes the two fields rather than a ChannelCandidate so callers holding a
 * discord.js channel, a DiscordChannelInfo, or nothing but two strings can all
 * use it.
 */
export function formatChannelLabel(name: string, guildName: string): string {
  return `#${name} (${guildName})`;
}

/**
 * A voice or stage channel's name may hold spaces and `›`, so a voice room
 * named `general › design-chat` would match a thread label as a name.
 */
export function formatThreadLabel(parentName: string | null | undefined, threadName: string, guildName: string): string {
  return `${parentName ? `#${parentName} ` : ''}› ${threadName} (${guildName})`;
}

/** Whether a name has a thread label's shape: `parent › thread`, or
 *  `› thread` when the parent isn't known (formatThreadLabel). */
export function isThreadLabelShape(name: string): boolean {
  return /(?:^|\s)›\s/.test(name);
}

/** `#name (GuildName)` for a resolver candidate. */
export function channelLabel(c: ChannelCandidate): string {
  return formatChannelLabel(c.name, c.guildName);
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

/**
 * True when the string can ONLY have been a name attempt: `#`-prefixed, or the
 * `name (Guild)` qualified form. Distinguishes "the caller meant a name" from
 * "this is an opaque id from some non-Discord adapter" — a bare token like
 * `c1` is genuinely ambiguous between the two, and adapters predating name
 * addressing may legitimately use such ids.
 *
 * Used to decide how hard to fail when no resolver is available: refuse
 * explicit name syntax (we know what was meant and cannot honour it), pass an
 * opaque token through unchanged (exactly the pre-feature behaviour, so no
 * regression). Strictly better information where we are sure; unchanged where
 * we are not.
 */
export function looksLikeExplicitName(raw: string): boolean {
  const value = raw.trim();
  if (!value || isSnowflake(value)) return false;
  const parts = value.split(':');
  if (parts.length === 3 && parts[0] === 'discord') return false;
  return value.startsWith('#') || /\([^()]*\)\s*$/.test(value);
}

function stripHash(value: string): string {
  return value.trim().replace(/^#/, '').trim();
}

export type ResolveResult =
  /** `matched` is absent when the input was already an id (nothing was looked
   *  up), present when a name resolved. Optional-on-the-success-arm rather
   *  than a union with a `matched?: undefined` member, which said the same
   *  thing less legibly. */
  | { ok: true; id: string; matched?: ChannelCandidate }
  /** `thread-label`: the name had a thread label's shape, which is refused
   *  before anything else about it (formatThreadLabel says why). */
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'thread-label'; message: string };

/** The refusal of a reference whose name has a thread label's shape
 *  (isThreadLabelShape), quoting the reference as it was given. A label's
 *  shape says nothing about any server, so the refusal is the same whatever
 *  is known of them. */
export function threadLabelRefusal(given: string): ResolveResult {
  return {
    ok: false,
    reason: 'thread-label',
    message:
      `Nothing was done: "${given}" has a thread label's shape (#parent › thread), and thread labels are ` +
      'display-only, never matched as names. Address the thread by its id instead, discord:<server id>:<thread id> ' +
      'or its numeric id, which is shown with the label wherever the label is. A channel whose name has this shape ' +
      'is addressed by id too.',
  };
}

/**
 * Resolve a parsed name against live candidates.
 *
 * The caller MUST have already applied the channel allowlist — disallowed
 * channels must not reach here, both so a name cannot address a channel the
 * allowlist excludes, and so a forbidden `#general` cannot manufacture a
 * spurious collision with a permitted one. It MUST also have refused a name
 * with a thread label's shape (threadLabelRefusal), which as a name could
 * reach a voice or stage room whose name has the same shape.
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

  // "General" the voice channel beside #general the text channel is the stock
  // Discord layout. Announcement channels are ordinary message channels that
  // support crossposting, so they count as text here.
  if (matches.length > 1) {
    const sendable = matches.filter((c) => TEXTLIKE.has(c.type));
    if (sendable.length === 1) matches = sendable;
  }

  if (matches.length === 1) return { ok: true, id: matches[0].id, matched: matches[0] };

  if (matches.length === 0) {
    // Candidates are only the SENDABLE kinds, so a channel of another kind,
    // such as a category or a forum, may well have this name. The text says
    // what a #name reaches, named from SENDABLE so it follows the rule, and
    // how any other channel is given.
    const kinds = [...SENDABLE];
    const reached = `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]} channel`;
    const none = (where: string) =>
      `No ${reached} that the configured channel filters allow is named #${ref.name}${where}, ` +
      'and a #name reaches only those.';
    const byId = "list_channels shows a server's channels with their ids, and a channel of any other kind, such as a " +
      'category or a forum, is given by its id instead.';
    const near = candidates.filter((c) => c.name.toLowerCase() === wantName);
    if (wantGuild && near.length) {
      // The name exists, but not in the guild asked for. Say so precisely —
      // this is a different mistake from "no such channel" and deserves a
      // different message.
      return {
        ok: false,
        reason: 'not-found',
        message:
          `${none(` in a guild named "${ref.guild}"`)} ` +
          `That name exists elsewhere: ${near.map(channelLabel).join(', ')}. ${byId}`,
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      message: `${none(ref.guild ? ` in "${ref.guild}"` : '')} ${byId}`,
    };
  }

  // Ambiguous. Quote qualified LABELS, because those are themselves valid
  // addresses and hand the caller something pasteable. But when two matches
  // share a label — same name, same guild, different type or category — the
  // label cannot separate them and a label-only message is a DEAD END: every
  // suggestion is identical and re-sending any of them returns this same
  // error, forcing the fall back to a regenerated snowflake that this whole
  // feature exists to prevent. In that case the id is the only distinguishing
  // fact, so include it. Ids are a co-equal address form, not a shameful one.
  // Discord lets two channels in one server share a name, so two matches can share a label.
  const labels = matches.map(channelLabel);
  const labelsDistinguish = new Set(labels).size === matches.length;
  const options = matches
    .map((c) => (labelsDistinguish
      ? `"${channelLabel(c)}"`
      : `"${channelLabel(c)}" [${c.type}] (id ${c.id})`))
    .join(', ');
  return {
    ok: false,
    reason: 'ambiguous',
    message: `#${ref.name} is ambiguous — ${matches.length} channels match. Re-send with one of: ${options}`,
  };
}

/** How a send was addressed, for the send log. Only the paths this module can
 *  actually observe: a tool call either carried an id or carried a name.
 *
 *  Deliberately NOT including 'default-aim'. Failure mode 2 (an id-less send
 *  falling through to most-recent-channel) is real and is the reason the
 *  original feature request asked for three-way telemetry — but this change
 *  does not touch that path, so a variant here would be permanently unassigned
 *  and would imply coverage that does not exist. Wiring it belongs with
 *  whatever addresses the default-aim path itself. */
export type AddressingPath = 'explicit-id' | 'name-resolved';


// ── Candidate building ───────────────────────────────────────────────────────
// Extracted from DiscordAdapter so the security-relevant step — applying the
// allowlist BEFORE matching — is testable without a gateway connection. Review
// note that prompted this: coverage was inverted relative to risk, all of it on
// the pure matcher and none on the filter that decides what is addressable.

/** Structural shape of a discord.js channel, narrowed to what we need. */
export interface ChannelLike {
  id: string;
  name: string;
  type: number | undefined;
  parentId: string | null;
}

/** Structural shape of a discord.js guild, narrowed to what we need. */
export interface GuildLike {
  id: string;
  name: string;
  channels: Iterable<ChannelLike | null | undefined>;
}

/** Ordinary message channels. Separate from SENDABLE because these are also
 *  what the ambiguity tie-break prefers over a same-named voice channel. */
const TEXTLIKE: ReadonlySet<string> = new Set(['text', 'announcement']);

/** Channel kinds that can receive a message. Categories and forum roots
 *  aren't sendable, a media channel holds its posts as threads, thread names
 *  aren't unique even within one channel, and a stage channel has a text
 *  chat, as a voice channel does. */
const SENDABLE: ReadonlySet<string> = new Set([...TEXTLIKE, 'voice', 'stage']);

/** Whether a channel kind can be addressed by NAME. Exported so the mapping
 *  from Discord's type numbers to addressability is testable end to end —
 *  the announcement regression lived in that mapping, not in the matcher, and
 *  a test over a locally-reimplemented mapType would not have caught it. */
export function isNameAddressableKind(kind: string): boolean {
  return SENDABLE.has(kind);
}

export function buildCandidates(
  guilds: Iterable<GuildLike>,
  opts: {
    /** Guild allowlist. Empty/undefined = all guilds. */
    guildIds?: string[];
    mapType: (type: number | undefined) => string;
    /** MUST be the same predicate the listing surfaces use. Applied before
     *  matching so a name can never reach an excluded channel, and an excluded
     *  channel cannot manufacture a spurious collision with a permitted one. */
    allowed: (guildId: string, channelId: string, parentId: string | null) => boolean;
  },
): ChannelCandidate[] {
  const out: ChannelCandidate[] = [];
  for (const guild of guilds) {
    if (opts.guildIds?.length && !opts.guildIds.includes(guild.id)) continue;
    for (const c of guild.channels) {
      if (!c) continue;
      const kind = opts.mapType(c.type);
      if (!SENDABLE.has(kind)) continue;
      if (!opts.allowed(guild.id, c.id, c.parentId)) continue;
      out.push({
        id: c.id,
        name: c.name,
        guildId: guild.id,
        guildName: guild.name,
        type: kind as ChannelCandidate['type'],
      });
    }
  }
  return out;
}
