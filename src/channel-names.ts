/** Discord snowflakes are 17-20 digits. */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

export interface ChannelCandidate {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  /** A stock Discord server ships a voice channel named "General" beside text
   *  #general, and matching is case-insensitive. */
  type: 'text' | 'announcement' | 'voice' | 'stage' | 'forum' | 'unknown';
}

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

export function isThreadLabelShape(name: string): boolean {
  return /(?:^|\s)›\s/.test(name);
}

export function channelLabel(c: ChannelCandidate): string {
  return formatChannelLabel(c.name, c.guildName);
}

export type ChannelRef =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string; guild?: string };

export function parseChannelRef(raw: string): ChannelRef | null {
  const value = raw.trim();
  if (!value) return null;

  if (isSnowflake(value)) return { kind: 'id', id: value };

  const parts = value.split(':');
  if (parts.length === 3 && parts[0] === 'discord') {
    return { kind: 'id', id: parts[2] };
  }

  const qualified = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(value);
  if (qualified && qualified[2].trim()) {
    const name = stripHash(qualified[1]);
    if (name) return { kind: 'name', name, guild: qualified[2].trim() };
  }

  const name = stripHash(value);
  return name ? { kind: 'name', name } : null;
}

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
  | { ok: true; id: string; matched?: ChannelCandidate }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'thread-label'; message: string };

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
    const kinds = [...SENDABLE];
    const reached = `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]} channel`;
    const none = (where: string) =>
      `No ${reached} that the configured channel filters allow is named #${ref.name}${where}, ` +
      'and a #name reaches only those.';
    const byId = "list_channels shows a server's channels with their ids, and a channel of any other kind, such as a " +
      'category or a forum, is given by its id instead.';
    const near = candidates.filter((c) => c.name.toLowerCase() === wantName);
    if (wantGuild && near.length) {
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

export type AddressingPath = 'explicit-id' | 'name-resolved';


export interface ChannelLike {
  id: string;
  name: string;
  type: number | undefined;
  parentId: string | null;
}

export interface GuildLike {
  id: string;
  name: string;
  channels: Iterable<ChannelLike | null | undefined>;
}

const TEXTLIKE: ReadonlySet<string> = new Set(['text', 'announcement']);

/** Channel kinds that can receive a message. Categories and forum roots
 *  aren't sendable, a media channel holds its posts as threads, thread names
 *  aren't unique even within one channel, and a stage channel has a text
 *  chat, as a voice channel does. */
const SENDABLE: ReadonlySet<string> = new Set([...TEXTLIKE, 'voice', 'stage']);

export function isNameAddressableKind(kind: string): boolean {
  return SENDABLE.has(kind);
}

export function buildCandidates(
  guilds: Iterable<GuildLike>,
  opts: {
    guildIds?: string[];
    mapType: (type: number | undefined) => string;
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
