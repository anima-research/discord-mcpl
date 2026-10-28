import {
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  TextChannel,
  DMChannel,
  ChannelType,
  MessageType,
  AttachmentBuilder,
  SnowflakeUtil,
  type Message,
  type PartialMessage,
  type Channel,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
  type ChatInputCommandInteraction,
  type ApplicationCommandDataResolvable,
  type GatewayThreadListSyncDispatchData,
  type TextBasedChannel,
  cleanContent as discordCleanContent,
} from 'discord.js';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { dbg } from './debug-log.js';

import {
  buildCandidates,
  formatChannelLabel,
  isNameAddressableKind,
  isSnowflake,
  isThreadLabelShape,
  parseChannelRef,
  resolveChannelName,
  threadLabelRefusal,
  type ChannelCandidate,
  type ResolveResult,
} from './channel-names.js';
import { channelLabelFor, mcplChannelId } from './channels.js';
import { INVALID_FORM_BODY, MISSING_ACCESS, UNKNOWN_CHANNEL } from './discord-errors.js';
import { errorValue, nameValue } from './source-header.js';

interface NameView {
  (name: string): ChannelCandidate[];
  uncertainGuilds(): { readonly named: ReadonlySet<string>; readonly any: boolean };
}

const FETCH_TRIES = 3;

function* channelsNamed(channels: Iterable<GuildBasedChannel>, key: string): Iterable<GuildBasedChannel> {
  for (const c of channels) if (c.name?.toLowerCase() === key) yield c;
}

export interface ChannelChange {
  addressChanged: boolean;
  admitted: boolean;
}

export type ThreadsSyncedHandler = (
  guildId: string,
  covered: ReadonlySet<string> | null,
  listed: ReadonlySet<string>,
  dropped: ReadonlySet<string>,
) => void;

/** Maximum attachments Discord accepts on a single message. */
const MAX_DISCORD_ATTACHMENTS = 10;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 0xD800–0xDBFF is a UTF-16 high surrogate, the first half of a pair. */
function hardCut(text: string, limit: number): number {
  let cut = 0;
  for (const { index } of GRAPHEMES.segment(text)) {
    if (index > limit) break;
    cut = index;
  }
  if (cut > 0) return cut;
  const unit = text.charCodeAt(limit - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? limit - 1 : limit;
}

export interface DmSendFailure {
  dmChannel?: { id: string; recipientName: string };
}

const MEMBER_LIST_CAP = 200;

export interface OutgoingFile {
  path: string;
  name?: string;
  description?: string;
}

/**
 * discord.js reads each path lazily, at send time, so a file it can't read
 * would fail after the parts before it posted.
 */
function buildAttachments(files?: unknown): AttachmentBuilder[] {
  if (!files) return [];
  if (!Array.isArray(files)) {
    throw new Error(
      `Nothing was sent: "files" must be a list of files, each as {"path": "<its path>"}, and this call gave ` +
        `${kindOfValue(files)}.`,
    );
  }
  if (files.length > MAX_DISCORD_ATTACHMENTS) {
    throw new Error(
      `Nothing was sent: this call gave ${files.length} files, and Discord takes at most ${MAX_DISCORD_ATTACHMENTS} ` +
        `in one message. Send ${MAX_DISCORD_ATTACHMENTS} or fewer, and the rest in another message.`,
    );
  }
  return files.map((f: unknown, i) => {
    const file = (f && typeof f === 'object' ? f : {}) as Partial<OutgoingFile>;
    if (typeof file.path !== 'string' || !file.path.trim()) {
      const hint = typeof f === 'string'
        ? f.trim() ? `: give it as {"path": ${JSON.stringify(f.trim())}}` : ', and this one is blank'
        : f && typeof f === 'object' && !Array.isArray(f) ? '' : `, and this call gave ${kindOfValue(f)}`;
      throw new Error(
        `Nothing was sent: files[${i}] needs "path", the path of a file on the machine running discord-mcpl, as a ` +
          `non-empty string${hint}.`,
      );
    }
    for (const key of ['name', 'description'] as const) {
      const value: unknown = file[key];
      const asText = key === 'description' && (typeof value === 'number' || value === true);
      if (value && typeof value !== 'string' && !asText) {
        throw new Error(
          `Nothing was sent: files[${i}].${key} must be a string, and this call gave ${kindOfValue(value)}. Give it in quotes, ` +
            `or leave it out${key === 'name' ? ' to use the file\'s own name' : ''}.`,
        );
      }
    }
    const read = resolvePath(file.path);
    const problem = unattachable(read);
    if (problem) {
      throw new Error(
        `Nothing was sent: ${JSON.stringify(file.path)}${read === file.path ? '' : ` (read as ${read})`} ${problem} ` +
          'on the machine running discord-mcpl. Give the path of a file there that it can read.',
      );
    }
    const name = file.name && file.name.trim() ? file.name : basename(file.path);
    const attachment = new AttachmentBuilder(file.path, { name });
    if (file.description) attachment.setDescription(String(file.description));
    return attachment;
  });
}

export function kindOfValue(value: unknown): string {
  return Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function unattachable(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return "isn't a file";
    accessSync(path, fsConstants.R_OK);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? "doesn't exist" : `can't be read (${code ?? (err as Error).message})`;
  }
}

export interface DiscordAdapterConfig {
  token: string;
  guildIds?: string[];
  guildChannels?: Record<string, string[]>;
  dmUsers?: string[];
}

export const DM_REFUSALS_HELD = 100;

export interface DmRefusal {
  messageId: string;
  channelId: string;
  authorId: string;
  origin: 'live' | 'sweep';
}

export interface DiscordAttachment {
  id: string;
  name: string;
  /** Discord CDN URL (signed; expires after a while). */
  url: string;
  /** When `url` stops working, as ISO 8601 UTC, read from its signed `ex`
   *  parameter. Absent when the URL carries no readable one. Fetching the
   *  message again gives a freshly signed URL. */
  expiresAt?: string;
  contentType: string | null;
  size: number;
  forwardedSnapshotIndex?: number;
}

/** Discord threads are channels, so a message posted in one has the thread
 *  as its channel. discord.js `message.thread` is another conversation: the
 *  thread a message started. */
export interface ThreadPlace {
  threadId?: string;
  threadName?: string;
  threadParentName?: string | null;
}

export interface ChannelMeta extends ThreadPlace {
  name: string | null;
  guildId: string | null;
  guildName: string | null;
  isDM: boolean | null;
}

export interface DiscordMessageData extends ThreadPlace {
  id: string;
  content: string;
  cleanContent: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  channelId: string;
  channelName: string | null;
  guildId: string | null;
  guildName: string | null;
  replyToId?: string;
  replyToUserId?: string | null;
  replyToUserName?: string | null;
  mentions: string[];
  /** Discord renders a mention of the bot's managed role identically to a user ping. */
  mentionsBotRole?: boolean;
  attachments: DiscordAttachment[];
  reactions?: ReactionSummary[];
  timestamp: Date;
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  memberCount: number;
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: 'text' | 'announcement' | 'voice' | 'stage' | 'category' | 'thread' | 'forum' | 'unknown';
  parentId?: string;
  label: string;
  topic?: string;
}

const TOPIC_LIMIT = 300;

function channelTopic(channel: unknown): string | undefined {
  const topic = (channel as { topic?: unknown }).topic;
  if (typeof topic !== 'string' || !topic.trim()) return undefined;
  const chars = Array.from(topic);
  return chars.length > TOPIC_LIMIT ? `${chars.slice(0, TOPIC_LIMIT - 1).join('')}…` : topic;
}

export interface ChannelFacts {
  id: string;
  guildId: string;
  guildName: string | null;
  type: DiscordChannelInfo['type'];
  name: string | null;
  parentId?: string | null;
  parentName?: string | null;
  archived?: boolean;
  /** For an archived thread, when Discord archived it (its
   *  `archive_timestamp`, in ms), when the cache knows: a message posted
   *  after it unarchived the thread, and one posted before it didn't. */
  archivedAt?: number;
  nameResolves?: boolean;
}

export interface DiscordMemberInfo {
  id: string;
  username: string;
  displayName: string;
  isBot: boolean;
}

export const LATEST_FROM_WINDOW = 100;
const LATEST_FROM_WARMUP_RETRY_MS = 10 * 60_000;
/** One page of List Thread Members, should Discord page a listing without with_member. */
const THREAD_MEMBER_PAGE = 100;

export type LatestFromResult =
  | { ok: true; message: HistoryMessage; authorId: string; authorLabel: string }
  | { ok: false; message: string };

export interface DiscordChannelMembers {
  channelId: string;
  channelName: string | null;
  /** A thread's members are those who joined it, Discord's own notion of
   *  thread membership: a public thread may be readable by others with access
   *  to its channel. */
  scope: 'guild-channel' | 'thread-joined' | 'dm';
  total: number;
  members: DiscordMemberInfo[];
  truncated: boolean;
  note?: string;
  unresolved?: number;
  /** Set when Discord returned exactly one page of a thread's joined members,
   *  so there may be more than listed. */
  possiblyIncomplete?: true;
}

export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  /** The author's display name: their server nickname or global display
   *  name as discord.js resolves it (the member's, else the account's global
   *  name), else the username. */
  authorDisplayName?: string;
  isBot: boolean;
  /** Set on a system notice (a pin, a join, a thread start…): a message
   *  discord.js counts as system, which nobody wrote as a message. */
  system?: true;
  content: string;
  /** The text the agent reads (resolveVisibleContent): mentions named by mentionNamedContent, a forward's text and notes, a system notice's text; raw content stands in when the message's channel isn't in discord.js's cache. */
  cleanContent: string;
  attachments: DiscordAttachment[];
  mentionsBot: boolean;
  reactions?: ReactionSummary[];
  timestamp: Date;
}

export interface ReactionSummary {
  emoji: string;
  emojiId: string | null;
  token: string;
  count: number;
  me: boolean;
}

export interface DiscordEmojiInfo {
  id: string;
  name: string;
  animated: boolean;
  token: string;
  reactionArg: string;
  guildId: string;
  guildName: string | null;
}

export interface ReactionEvent extends ThreadPlace {
  action: 'add' | 'remove';
  channelId: string;
  messageId: string;
  guildId: string | null;
  emoji: string;
  emojiId: string | null;
  token: string;
  userId: string;
  userName: string;
  onOwnMessage: boolean;
  messageAuthorId: string | null;
  messageSnippet: string | null;
  timestamp: Date;
}

/** A guild thread the client knows only partly: built from an event that
 *  carried its type but not its channel, so discord.js keeps its parentId
 *  null until a thread event or a fetch fills it in. */
function threadChannelUnknown(channel: unknown): boolean {
  const c = channel as { isThread?: () => boolean; parentId?: string | null } | null | undefined;
  return !!c && typeof c.isThread === 'function' && c.isThread() && c.parentId == null;
}

function renderCustomEmojis(text: string): string {
  return text.replace(/<a?:(\w+):\d+>/g, (_full, name: string) => `:${name}:`);
}

const REACTION_SNIPPET_MAX = 80;

export function buildReactionSnippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const collapsed = renderCustomEmojis(text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > REACTION_SNIPPET_MAX
    ? `${collapsed.slice(0, REACTION_SNIPPET_MAX - 1)}…`
    : collapsed;
}

interface ForwardSnapshot {
  content?: string | null;
  attachments?: { size: number; values?(): IterableIterator<unknown> } | null;
  embeds?: { length: number } | null;
}

/** Discord forwards carry their body in `messageSnapshots` (discord.js ≥14.16), not `content`. */
export function buildForwardedContent(
  baseContent: string,
  snapshots: Iterable<ForwardSnapshot>,
): string {
  const parts: string[] = [];
  for (const snap of snapshots) {
    const text =
      typeof snap.content === 'string' && snap.content.trim().length > 0
        ? renderCustomEmojis(snap.content)
        : null;
    const attachmentCount = snap.attachments?.size ?? 0;
    const notes: string[] = [];
    if (attachmentCount > 0) {
      notes.push(`[${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}]`);
    }
    if (!text && (snap.embeds?.length ?? 0) > 0) notes.push('[embed]');
    const body = [...notes, text].filter(Boolean).join(' ');
    parts.push(`[forwarded message] ${body || '[no text content]'}`);
  }
  if (parts.length === 0) return baseContent;
  const forwarded = parts.join('\n');
  return baseContent.trim().length > 0 ? `${baseContent}\n${forwarded}` : forwarded;
}

export interface MessageEventInfo extends ThreadPlace {
  guildId: string | null;
  authorId?: string;
  /** A deletion may name no author, so a DM delete carries the conversation's other party. */
  dmRecipientId?: string;
  dmPartyUnknown?: string;
  authorName?: string;
  /** Edit time (ISO) when Discord supplies it: distinguishes one edit of a
   *  message from the next (RFC-006 occurrence identity). */
  editedAt?: string;
  cleanContent?: string;
  address?: AddressFacts;
}

export interface AddressFacts {
  mentions: string[];
  mentionsBotRole: boolean;
  replyToUserId: string | null;
  isBot: boolean;
}

export type EditForwardDecision =
  | 'forward'
  | 'no-content'
  | 'self'
  | 'not-an-edit'
  | 'unchanged';

/**
 * Discord emits MESSAGE_UPDATE for more than content edits: link-preview and
 * embed refreshes re-send old messages with `edited_timestamp` still null.
 */
export function editForwardDecision(
  oldMsg: { partial?: boolean; content?: string | null } | null | undefined,
  newMsg: {
    content?: string | null;
    editedTimestamp?: number | null;
    guildId?: string | null;
    author?: { id: string } | null;
  },
  opts: { selfId?: string | null },
): EditForwardDecision {
  if (!newMsg.content) return 'no-content';
  // A deferred slash-command reply arrives as an edit of the bot's own message.
  if (opts.selfId && newMsg.author?.id === opts.selfId) return 'self';
  if (!newMsg.editedTimestamp) return 'not-an-edit';
  if (oldMsg && !oldMsg.partial && typeof oldMsg.content === 'string' && oldMsg.content === newMsg.content) {
    return 'unchanged';
  }
  return 'forward';
}

// discord.js 14.26.5's cleanContent token pattern (src/util/Util.js), so a
// message's tokens are found as discord.js finds them, in one scan.
const DISCORD_TOKEN = /<(?:(?<type>@[!&]?|#)|(?:\/(?<commandName>[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai} ]+):)|(?:a?:(?<emojiName>[\w]+):))(?<id>\d{17,19})>/gu;

export function mentionNamedContent(m: { content?: string | null; cleanContent?: string | null; channel?: unknown }): string | null | undefined {
  const channel = m.channel as TextBasedChannel | null | undefined;
  if (typeof m.content !== 'string' || !channel || !('client' in channel)) return m.cleanContent;
  const guild = 'guild' in channel ? channel.guild : null;
  return m.content.replaceAll(DISCORD_TOKEN, (match, type: string | undefined, _command: unknown, _emoji: unknown, id: string) => {
    if (!type) return discordCleanContent(match, channel);
    if (type === '#') {
      const mentioned = channel.client.channels.cache.get(id) as { name?: string | null } | undefined;
      return mentioned ? `#${typeof mentioned.name === 'string' ? nameValue(mentioned.name) : mentioned.name}` : match;
    }
    if (type === '@&') {
      if (channel.type === ChannelType.DM) return match;
      const role = guild?.roles.cache.get(id);
      return role ? `@${nameValue(role.name)}` : match;
    }
    const member = guild?.members.cache.get(id);
    if (member) return `@${nameValue(member.displayName)}`;
    const user = channel.client.users.cache.get(id);
    return user ? `@${nameValue(user.displayName)}` : match;
  });
}

/** mentionNamedContent gives null when the message's channel isn't in
 *  discord.js's cache, so raw content stands in. Discord
 *  system messages (member joins, boosts, pins…) carry no content, so their
 *  text is made from `message.type`, as the human client renders them. */
export function resolveVisibleContent(m: {
  content: string;
  cleanContent?: string | null;
  channel?: unknown;
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
  type?: MessageType;
}): string {
  const cleaned = mentionNamedContent(m);
  let base =
    typeof cleaned === 'string' && cleaned.length > 0
      ? cleaned
      : m.content;
  if (base.length === 0 && m.type !== undefined && m.type !== MessageType.Default) {
    base = systemMessageText(m.type);
  }
  return m.messageSnapshots && m.messageSnapshots.size > 0
    ? buildForwardedContent(base, m.messageSnapshots.values())
    : base;
}

function extractReactions(m: Message): ReactionSummary[] {
  const cache = m.reactions?.cache;
  if (!cache || cache.size === 0) return [];
  return [...cache.values()].map((r) => {
    const e = r.emoji;
    const custom = Boolean(e.id);
    return {
      emoji: custom ? `:${e.name}:` : e.name ?? '?',
      emojiId: e.id ?? null,
      token: custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? '',
      count: r.count,
      me: r.me,
    };
  });
}

export interface MentionCandidate {
  id: string;
  aliases: string[];
  kind: 'user' | 'role';
}

/** `@everyone` and `@here` are left as they are: Discord handles them itself. */
export function applyMentionCandidates(
  content: string,
  candidates: MentionCandidate[],
): string {
  if (candidates.length === 0) return content;
  return content.replace(/@([A-Za-z0-9_.][A-Za-z0-9_.-]*)/g, (whole, handle) => {
    const lower = String(handle).toLowerCase();
    if (lower === 'everyone' || lower === 'here') return whole;
    const matches = (kind: 'user' | 'role') =>
      candidates.filter(
        (c) => c.kind === kind && c.aliases.some((a) => a.toLowerCase() === lower),
      );
    const users = matches('user');
    if (users.length === 1) return `<@${users[0].id}>`;
    if (users.length === 0) {
      const roles = matches('role');
      if (roles.length === 1) return `<@&${roles[0].id}>`;
    }
    return whole;
  });
}

export class DiscordAdapter {
  private client: Client;

  get rawClient(): Client {
    return this.client;
  }
  private token: string;
  private guildIds?: string[];
  private guildChannels?: Map<string, Set<string>>;
  private dmUsers?: Set<string>;
  private latestFromWarmupFailures = new Map<string, number>();
  private messageEventDeliveries = new Map<string, Promise<void>>();
  private threadLookups = new Map<string, Promise<void>>();
  private stale = new Map<string, { guildId: string }>();
  private fetchesOut = new Map<string, Set<{ overtaken: boolean }>>();
  private slashCommandHandler?: (interaction: ChatInputCommandInteraction) => void;
  private guildCommandDefs?: ApplicationCommandDataResolvable[];

  private messageHandler?: (msg: DiscordMessageData) => void;
  private editHandler?: (
    channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo,
  ) => void;
  private deleteHandler?: (channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo) => void;
  private editAccept?: (channelId: string) => boolean;
  private deleteAccept?: (channelId: string) => boolean;
  private reactionHandler?: (ev: ReactionEvent) => void;
  private dmRefusedHandler?: (ev: DmRefusal) => void;
  private heldDmRefusals: DmRefusal[] = [];
  private readyHandler?: () => void;
  private channelCreateHandler?: (channel: ChannelFacts) => void;
  private channelUpdateHandler?: (channel: ChannelFacts, change: ChannelChange) => void;
  private channelDeleteHandler?: (guildId: string, channelId: string, threadIds: string[]) => void;
  private threadUpdateHandler?: (thread: ChannelFacts) => void;
  private threadDeleteHandler?: (guildId: string, threadId: string) => void;
  private channelRefreshedHandler?: (channelId: string) => void;
  private channelStaleHandler?: (channelId: string) => void;
  private guildCreateHandler?: (guildId: string, channels: ChannelFacts[]) => void;
  private guildDeleteHandler?: (guildId: string) => void;
  private guildAvailableHandler?: (guildId: string, channels: ChannelFacts[], present: ReadonlySet<string>) => void;
  private guildRenameHandler?: (guildId: string) => void;
  private threadsSyncedHandler?: ThreadsSyncedHandler;
  private applyingThreadSync?: { data: GatewayThreadListSyncDispatchData; held: Map<string, string | null> };

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.guildIds = config.guildIds;
    if (config.guildChannels) {
      this.guildChannels = new Map(
        Object.entries(config.guildChannels).map(([g, chans]) => [g, new Set(chans)]),
      );
    }
    if (config.dmUsers?.length) {
      this.dmUsers = new Set(config.dmUsers);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        // Privileged. Without it Discord sends no GUILD_MEMBERS_CHUNK, so
        // guild.members.fetch() rejects at discord.js's chunk timeout, and no
        // member add, update or remove events keep the cache fresh.
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildEmojisAndStickers,
        // @discordjs/voice's handshake reads the gateway's VOICE_STATE_UPDATE,
        // which Discord sends only with this intent.
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });

    this.installThreadSyncScope();
    this.setupEvents();
  }

  async connect(): Promise<void> {
    // The gateway's READY fills guilds.cache, so this resolves only after it.
    await new Promise<void>((resolve, reject) => {
      if (this.client.isReady()) { resolve(); return; }
      this.client.once('ready', () => resolve());
      this.client.login(this.token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  get isConnected(): boolean {
    return this.client.isReady();
  }

  get botUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this.messageHandler = handler;
  }

  onMessageEdit(
    handler: (channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo) => void,
    accept?: (channelId: string) => boolean,
  ): void {
    this.editHandler = handler;
    this.editAccept = accept;
  }

  onMessageDelete(
    handler: (channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo) => void,
    accept?: (channelId: string) => boolean,
  ): void {
    this.deleteHandler = handler;
    this.deleteAccept = accept;
  }

  onReaction(handler: (ev: ReactionEvent) => void): void {
    this.reactionHandler = handler;
  }

  onDmRefused(handler: (ev: DmRefusal) => void): void {
    this.dmRefusedHandler = handler;
    for (const ev of this.heldDmRefusals.splice(0)) handler(ev);
  }

  private refuseDm(ev: DmRefusal): void {
    if (this.dmRefusedHandler) {
      this.dmRefusedHandler(ev);
    } else if (this.heldDmRefusals.length < DM_REFUSALS_HELD) {
      this.heldDmRefusals.push(ev);
    } else {
      console.error(
        `[discord-mcpl] DM refused by the DM allowlist (${ev.origin}) before refusals were handled, past the ` +
          `${DM_REFUSALS_HELD} held until then: sender ${ev.authorId}, message ${ev.messageId}; no notice`,
      );
    }
  }

  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }

  onSlashCommand(handler: (interaction: ChatInputCommandInteraction) => void): void {
    this.slashCommandHandler = handler;
  }

  /** Per guild: Discord applies guild commands at once, unlike global ones. */
  async registerGuildCommands(commands: ApplicationCommandDataResolvable[]): Promise<void> {
    this.guildCommandDefs = commands;
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) continue;
      try {
        await guild.commands.set(commands);
      } catch (err) {
        console.error(
          `[discord-mcpl] Failed to register commands in guild ${guild.id}:`,
          (err as Error).message,
        );
      }
    }
  }

  getFilters(): { guildIds?: string[]; guildChannels?: Record<string, string[]>; dmUsers?: string[] } {
    return {
      guildIds: this.guildIds ? [...this.guildIds] : undefined,
      guildChannels: this.guildChannels
        ? Object.fromEntries([...this.guildChannels].map(([g, s]) => [g, [...s]]))
        : undefined,
      dmUsers: this.dmUsers ? [...this.dmUsers] : undefined,
    };
  }

  updateFilters(filters: {
    guildIds?: string[];
    guildChannels?: Record<string, string[]>;
    dmUsers?: string[];
  }): { addedGuilds: string[]; removedGuilds: string[] } {
    const before = this.guildIds;
    this.guildIds = filters.guildIds?.length ? [...filters.guildIds] : undefined;
    this.guildChannels =
      filters.guildChannels && Object.keys(filters.guildChannels).length
        ? new Map(Object.entries(filters.guildChannels).map(([g, chans]) => [g, new Set(chans)]))
        : undefined;
    this.dmUsers = filters.dmUsers?.length ? new Set(filters.dmUsers) : undefined;

    const allowed = (ids: string[] | undefined, gid: string): boolean =>
      !ids?.length || ids.includes(gid);
    const addedGuilds: string[] = [];
    const removedGuilds: string[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      const was = allowed(before, guild.id);
      const now = allowed(this.guildIds, guild.id);
      if (!was && now) addedGuilds.push(guild.id);
      else if (was && !now) removedGuilds.push(guild.id);
    }

    if (this.guildCommandDefs) {
      for (const gid of addedGuilds) {
        this.client.guilds.cache
          .get(gid)
          ?.commands.set(this.guildCommandDefs)
          .catch((err: Error) => {
            console.error(
              `[discord-mcpl] Failed to register commands in newly-allowed guild ${gid}:`,
              err.message,
            );
          });
      }
    }
    return { addedGuilds, removedGuilds };
  }

  onChannelCreate(handler: (channel: ChannelFacts) => void): void {
    this.channelCreateHandler = handler;
  }

  onChannelUpdate(handler: (channel: ChannelFacts, change: ChannelChange) => void): void {
    this.channelUpdateHandler = handler;
  }

  /** Discord sends no threadDelete for the threads under a deleted channel,
   *  and discord.js drops along with it only those its threads cache holds. */
  onChannelDelete(handler: (guildId: string, channelId: string, threadIds: string[]) => void): void {
    this.channelDeleteHandler = handler;
  }

  onThreadUpdate(handler: (thread: ChannelFacts) => void): void {
    this.threadUpdateHandler = handler;
  }

  /** discord.js reports `threadDelete` only for a thread it has cached
   *  (threads never reach `channelDelete`): with the default caches, a live
   *  thread the bot can see is, and an archived one is swept from the cache by
   *  the hourly sweeper once it has been archived for more than four hours. */
  onThreadDelete(handler: (guildId: string, threadId: string) => void): void {
    this.threadDeleteHandler = handler;
  }

  /** Discord syncs a guild's threads (discord.js `threadListSync`) when the
   *  bot gains access to a channel, covering the channels in its
   *  `channel_ids`, or the whole guild when it names none. discord.js drops
   *  the live threads its covered channels' threads caches hold that the sync
   *  doesn't list, without a threadDelete for each. An omitted thread may only
   *  have been archived. */
  onThreadsSynced(handler: ThreadsSyncedHandler): void {
    this.threadsSyncedHandler = handler;
  }

  onChannelRefreshed(handler: (channelId: string) => void): void {
    this.channelRefreshedHandler = handler;
  }

  onChannelStale(handler: (channelId: string) => void): void {
    this.channelStaleHandler = handler;
  }

  onGuildCreate(handler: (guildId: string, channels: ChannelFacts[]) => void): void {
    this.guildCreateHandler = handler;
  }

  /** Fired when the bot leaves a guild or is removed from it (discord.js
   *  `guildDelete`). discord.js drops the guild's channels from its caches
   *  without a channelDelete for each. They still exist, and the guild's
   *  guildCreate brings them back if the bot rejoins. An outage is
   *  `guildUnavailable` instead, and keeps the guild cached. */
  onGuildDelete(handler: (guildId: string) => void): void {
    this.guildDeleteHandler = handler;
  }

  /** Discord doesn't replay what happened while a guild was away, so this
   *  hands over what the guild has now. discord.js refills
   *  `guild.channels.cache` from the guild's payload; channels and threads
   *  the payload no longer lists stay in the client-wide cache. */
  onGuildAvailable(handler: (guildId: string, channels: ChannelFacts[], present: ReadonlySet<string>) => void): void {
    this.guildAvailableHandler = handler;
  }

  onGuildRename(handler: (guildId: string) => void): void {
    this.guildRenameHandler = handler;
  }

  private staleParentOf(channel: unknown): string | null {
    const thread = channel as { isThread?: () => boolean; parentId?: string | null } | null | undefined;
    if (!thread?.isThread?.() || !thread.parentId) return null;
    return this.isStale(thread.parentId) ? thread.parentId : null;
  }

  async lookUpStaleParent(channelId: string): Promise<void> {
    const thread = this.client.channels.cache.get(channelId) as { guildId?: string | null } | undefined;
    const guildId = thread?.guildId ?? null;
    const staleParent = guildId && this.guildAdmitted(guildId) ? this.staleParentOf(thread) : null;
    if (guildId && staleParent) await this.lookUpChannel(guildId, staleParent);
  }

  ingressFactsNotCurrent(channelId: string): string | null {
    const channel = this.client.channels.cache.get(channelId) as
      | { isThread?: () => boolean; parentId?: string | null }
      | undefined;
    if (channel?.isThread?.()) {
      if (channel.parentId == null) return "its channel isn't known";
      return this.isStale(channel.parentId) ? `its channel ${channel.parentId} is still stale after its lookup` : null;
    }
    return this.isStale(channelId) ? "it's still stale after its lookup" : null;
  }

  private guildAdmitted(guildId: string): boolean {
    return !this.guildIds?.length || this.guildIds.includes(guildId);
  }

  async refreshStale(guildId?: string): Promise<void> {
    const listed = [...this.stale].filter(([id, mark]) => {
      if (guildId !== undefined && mark.guildId !== guildId) return false;
      const channel = this.client.guilds.cache.get(mark.guildId)?.channels.cache.get(id);
      return channel !== undefined && !channel.isThread();
    });
    await Promise.all(listed.map(([id]) => this.refetchChannel(id).catch((err: unknown) => {
      dbg('stale:refresh-failed', { channelId: id, error: (err as Error).message });
    })));
  }

  channelAdmitted(guildId: string, channelId: string, parentId: string | null): boolean {
    return this.guildAdmitted(guildId) && this.channelAllowed(guildId, channelId, parentId);
  }

  /** The client's cache holds every guild the bot is in, one that's
   *  unavailable in an outage included. A guild the bot leaves takes the
   *  channels its own cache holds, with their threads, out of the client's,
   *  but not a channel it had stopped listing, or that channel's threads. */
  hasGuild(guildId: string): boolean {
    return this.client.guilds.cache.has(guildId);
  }

  /** Discord refuses content over its per-message limit (DiscordAPIError 50035). */
  private splitForDiscord(text: string, limit = 1900): string[] {
    if (!text) return [];
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.5) cut = hardCut(rest, limit);
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  /** The nonce is enforced, so a retry of the REST client's within a few
   *  minutes of a lost response gets the first message back instead of
   *  posting a second. */
  async sendDmNotice(channelId: string, content: string, nonce: string): Promise<{ messageId: string }> {
    const channel = await this.channelById(channelId).catch((err: unknown) => {
      throw Object.assign(
        new Error(`could not look up channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`),
        { notPosted: true },
      );
    });
    // A DM has no server, so discord.js returns null for one only when it
    // can't build its kind: that one cause, and nothing retries the notice.
    if (!channel) throw Object.assign(unhandledKind(channelId, 'nothing was sent'), { notPosted: true });
    if (!('send' in channel)) {
      throw Object.assign(noMessagesHere(channel, channelId, 'nothing was sent'), { notPosted: true });
    }
    const sent = await (channel as DMChannel).send({
      content,
      allowedMentions: { parse: [] },
      nonce,
      enforceNonce: true,
    });
    return { messageId: sent.id };
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string; files?: OutgoingFile[]; requireReplyTarget?: boolean },
  ): Promise<{ messageId: string }> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was sent');
    if (!('send' in channel)) throw noMessagesHere(channel, channelId, 'nothing was sent');
    const resolved = await this.resolveOutgoingMentions(channel, content);
    const attachments = buildAttachments(options?.files);
    const chunks = this.splitForDiscord(resolved);
    if (chunks.length === 0 && attachments.length > 0) chunks.push('');
    let lastId = '';
    const posted: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await (channel as TextChannel | DMChannel).send({
        content: chunks[i] || undefined,
        // discord.js sends fail_if_not_exists from the client's failIfNotExists
        // option, true by default, so a reply to a message that's gone fails
        // rather than posting unthreaded.
        reply: i === 0 && options?.replyTo
          ? { messageReference: options.replyTo, ...(options.requireReplyTarget ? { failIfNotExists: true } : {}) }
          : undefined,
        files: isLast && attachments.length > 0 ? attachments : undefined,
        // Each part carries a nonce of its own that Discord enforces: the REST
        // client sends a part again after a 5xx, a timeout or a reset
        // connection, and if the first attempt posted, Discord answers a
        // repeat sent within a few minutes with that message instead of
        // posting another.
        nonce: SnowflakeUtil.generate().toString(),
        enforceNonce: true,
      }).catch((err: unknown) => {
        throw withPostedParts(err, posted, chunks, attachments.length > 0, Boolean(options?.replyTo));
      });
      posted.push(sent.id);
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  private async resolveRecipientId(recipient: string): Promise<string> {
    const raw = recipient.trim().replace(/^@/, '');
    if (/^\d{17,20}$/.test(raw)) return raw;
    const target = raw.toLowerCase();
    const selfId = this.client.user?.id;
    const matches = new Map<string, string>();
    for (const guild of this.client.guilds.cache.values()) {
      for (const member of guild.members.cache.values() as IterableIterator<GuildMember>) {
        if (member.user.id === selfId || member.user.bot) continue;
        const aliases = [
          member.nickname,
          (member.user as User & { globalName?: string | null }).globalName,
          member.user.displayName,
          member.user.username,
        ];
        if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === target)) {
          matches.set(member.user.id, member.user.username);
        }
      }
    }
    // Someone who DMed the bot may share no server with it, so open DM channels' recipients are matched too.
    for (const channel of this.client.channels.cache.values()) {
      const recipient = (channel as { recipient?: User }).recipient;
      if (!recipient || recipient.id === selfId || recipient.bot) continue;
      const aliases = [
        (recipient as User & { globalName?: string | null }).globalName,
        recipient.displayName,
        recipient.username,
      ];
      if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === target)) {
        matches.set(recipient.id, recipient.username);
      }
    }
    if (matches.size === 1) return [...matches.keys()][0]!;
    if (matches.size === 0) {
      throw new Error(
        `No Discord member matches "${recipient}". Pass a numeric user ID, or the exact ` +
          `@username / display name of someone in a shared server.`,
      );
    }
    throw new Error(
      `"${recipient}" is ambiguous — ${matches.size} members match ` +
        `(${[...matches.values()].slice(0, 5).map(nameValue).join(', ')}). Use the numeric user ID.`,
    );
  }

  async sendDM(
    userId: string,
    content: string,
    options?: { files?: OutgoingFile[] },
  ): Promise<{ messageId: string; channelId: string; recipientName: string }> {
    const resolvedId = await this.resolveRecipientId(userId);
    const user = await this.client.users.fetch(resolvedId);
    const dm = await user.createDM();
    const recipientName = user.username;
    try {
      const resolved = await this.resolveOutgoingMentions(dm, content);
      const attachments = buildAttachments(options?.files);
      const chunks = this.splitForDiscord(resolved);
      if (chunks.length === 0 && attachments.length > 0) chunks.push('');
      let lastId = '';
      const posted: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const sent = await user.send({
          content: chunks[i] || undefined,
          files: isLast && attachments.length > 0 ? attachments : undefined,
          nonce: SnowflakeUtil.generate().toString(),
          enforceNonce: true,
        }).catch((err: unknown) => {
          throw withPostedParts(err, posted, chunks, attachments.length > 0, false);
        });
        posted.push(sent.id);
        lastId = sent.id;
      }
      return { messageId: lastId, channelId: dm.id, recipientName };
    } catch (err) {
      if (err && typeof err === 'object') Object.assign(err, { dmChannel: { id: dm.id, recipientName } });
      throw err;
    }
  }

  getCachedDmRecipientName(channelId: string): string | null {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.DM) return null;
    try {
      const recipient = (channel as DMChannel).recipient;
      return recipient ? recipient.username : null;
    } catch {
      return null; // reading the recipient needs the logged-in user
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was edited');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'nothing was edited');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const resolved = await this.resolveOutgoingMentions(channel, content);
    await msg.edit(resolved);
  }

  /** Discord pings only for the bracket syntax (`<@id>`, `<@&id>`), not for an
   *  `@handle`. A `<@&id>` pings only when the role is mentionable or the bot
   *  has Mention Everyone; otherwise it renders as a role link. */
  private async resolveOutgoingMentions(
    channel: unknown,
    content: string,
  ): Promise<string> {
    const selfId = this.client.user?.id;
    const candidates: MentionCandidate[] = [];

    const ch = channel as { guild?: Guild; recipient?: User };
    if (ch.guild) {
      for (const member of ch.guild.members.cache.values() as IterableIterator<GuildMember>) {
        if (member.user.id === selfId) continue;
        const aliases = [
          member.nickname,
          (member.user as User & { globalName?: string | null }).globalName,
          member.user.displayName,
          member.user.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: member.user.id, aliases, kind: 'user' });
      }
      // The default @everyone role's id is the guild's, and Discord pings @everyone itself.
      for (const role of ch.guild.roles.cache.values() as IterableIterator<Role>) {
        if (role.id === ch.guild.id) continue;
        if (typeof role.name === 'string' && role.name.length > 0) {
          candidates.push({ id: role.id, aliases: [role.name], kind: 'role' });
        }
      }
    } else if (ch.recipient) {
      if (ch.recipient.id !== selfId) {
        const aliases = [
          (ch.recipient as User & { globalName?: string | null }).globalName,
          ch.recipient.displayName,
          ch.recipient.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: ch.recipient.id, aliases, kind: 'user' });
      }
    }

    return applyMentionCandidates(content, candidates);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was deleted');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'nothing was deleted');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.delete();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'no reaction was added');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'no reaction was added');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.react(this.resolveReactionEmoji(emoji, msg.guild));
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'no reaction was removed');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'no reaction was removed');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const selfId = this.client.user?.id;
    if (!selfId) throw new Error('Discord bot user is not ready');

    const resolved = this.resolveReactionEmoji(emoji, msg.guild);
    const customId = resolved.match(/(?:<a?:\w+:|^\w+:)(\d+)>?$/)?.[1];
    const bare = emoji.trim().replace(/^:+|:+$/g, '');
    const reaction = msg.reactions.cache.find((candidate) =>
      candidate.emoji.id === customId
      || candidate.emoji.name === emoji.trim()
      || candidate.emoji.name === bare
      || candidate.emoji.toString() === emoji.trim());
    if (!reaction) return;
    await reaction.users.remove(selfId);
  }

  /** discord.js's react() can't resolve a bare custom-emoji name, so ':name:'
   *  or 'name' becomes a cached emoji's 'name:id'. */
  private resolveReactionEmoji(emoji: string, guild: Guild | null): string {
    const trimmed = emoji.trim();
    if (/^<a?:\w+:\d+>$/.test(trimmed) || /^\w+:\d+$/.test(trimmed)) return trimmed;
    const bare = trimmed.replace(/^:+|:+$/g, '');
    if (/^\w{2,}$/.test(bare)) {
      const found =
        guild?.emojis.cache.find((e) => e.name === bare) ??
        this.client.emojis.cache.find((e) => e.name === bare);
      if (found) return found.identifier;
    }
    return trimmed;
  }

  private async handleReactionEvent(
    action: 'add' | 'remove',
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (!this.reactionHandler) return;
    try {
      if (user.id === this.client.user?.id) return;
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const msg = full.message;
      const guildId = msg.guildId ?? null;
      await this.pendingCreatesIn(msg.channelId);
      if (guildId && !this.guildAdmitted(guildId)) return;
      if (guildId && (threadChannelUnknown(msg.channel) || this.isStale(msg.channelId))) {
        await this.lookUpChannel(guildId, msg.channelId);
      }
      const staleParent = guildId ? this.staleParentOf(msg.channel) : null;
      if (guildId && staleParent) await this.lookUpChannel(guildId, staleParent);
      // msg.channel resolves through the client cache, so it's what the
      // lookup left there.
      const parentId =
        msg.channel && 'parentId' in msg.channel
          ? ((msg.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(guildId, msg.channelId, parentId)) return;
      const reactor = user.partial ? await user.fetch().catch(() => user) : user;
      const e = full.emoji;
      const custom = Boolean(e.id);
      const authorId = msg.author?.id ?? null;
      const resolvedMsg = msg.partial ? await msg.fetch().catch(() => null) : msg;
      const snippetSource = resolvedMsg
        ? (mentionNamedContent(resolvedMsg) ?? resolvedMsg.content)
        : null;
      this.reactionHandler({
        action,
        channelId: msg.channelId,
        messageId: msg.id,
        guildId,
        ...this.threadPlace(msg.channel, msg.channelId),
        emoji: custom ? `:${e.name}:` : e.name ?? '?',
        emojiId: e.id ?? null,
        token: custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? '',
        userId: reactor.id,
        userName: reactor.username ?? reactor.id,
        onOwnMessage: authorId != null && authorId === this.client.user?.id,
        messageAuthorId: authorId,
        messageSnippet: buildReactionSnippet(snippetSource),
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('[discord-mcpl] reaction event failed:', (err as Error).message);
    }
  }

  async fetchHistory(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string; nothing?: string },
  ): Promise<HistoryMessage[]> {
    const nothing = options?.nothing ?? 'nothing was read';
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, nothing);
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, nothing);
    // Discord caps one fetch at 100 messages and discord.js doesn't paginate,
    // so this walks back a page at a time with `before`. Discord takes only
    // one of before, after and around, so the watermark is checked per message.
    const requested = options?.limit ?? 50;
    const after = options?.after;
    const collected: HistoryMessage[] = [];
    let before = options?.before;

    while (collected.length < requested) {
      const pageLimit = Math.min(100, requested - collected.length);
      const fetchOpts: { limit: number; before?: string } = { limit: pageLimit };
      if (before) fetchOpts.before = before;
      const page = await (channel as TextChannel).messages.fetch(fetchOpts);
      if (page.size === 0) break;

      const pageArr = [...page.values()].sort((a, b) =>
        b.id.localeCompare(a.id, 'en-US-u-kn-true'),
      );

      let hitWatermark = false;
      for (const m of pageArr) {
        if (after && this.snowflakeLte(m.id, after)) {
          hitWatermark = true;
          break;
        }
        const cleanContent = renderCustomEmojis(resolveVisibleContent(m));
        collected.push({
          id: m.id,
          authorId: m.author.id,
          authorName: m.author.username,
          authorDisplayName: m.member?.displayName ?? m.author.displayName,
          isBot: m.author.bot,
          ...(m.system ? { system: true as const } : {}),
          content: cleanContent,
          cleanContent,
          attachments: mapAllAttachments(m),
          reactions: extractReactions(m),
          mentionsBot: this.messageMentionsBot(m),
          timestamp: m.createdAt,
        });
        if (collected.length >= requested) break;
      }

      if (hitWatermark) break;
      if (page.size < pageLimit) break;
      const oldest = pageArr[pageArr.length - 1];
      if (!oldest) break;
      before = oldest.id;
    }

    return collected;
  }

  /** Discord's `around` returns the target message and about half the window
   *  on either side, in one fetch capped at 100. */
  async fetchAround(
    channelId: string,
    messageId: string,
    limit = 50,
  ): Promise<HistoryMessage[]> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was read');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'nothing was read');
    const pageLimit = Math.min(100, Math.max(1, limit));
    const page = await (channel as TextChannel).messages.fetch({
      around: messageId,
      limit: pageLimit,
    });
    const collected: HistoryMessage[] = [...page.values()].map((m) => {
      const cleanContent = renderCustomEmojis(resolveVisibleContent(m));
      return {
        id: m.id,
        authorId: m.author.id,
        authorName: m.author.username,
        authorDisplayName: m.member?.displayName ?? m.author.displayName,
        isBot: m.author.bot,
        ...(m.system ? { system: true as const } : {}),
        content: cleanContent,
        cleanContent,
        attachments: mapAllAttachments(m),
        reactions: extractReactions(m),
        mentionsBot: this.messageMentionsBot(m),
        timestamp: m.createdAt,
      };
    });
    // discord.js returns the `around` window unsorted; present oldest → newest.
    collected.sort((a, b) => a.id.localeCompare(b.id, 'en-US-u-kn-true'));
    return collected;
  }

  async lookUpServedChannel(guildSegment: string, channelId: string): Promise<
    | { kind: 'guild'; facts: ChannelFacts }
    | { kind: 'dm'; recipientId: string; recipientName: string }
    | { kind: 'uncertain' }
    | null
  > {
    let channel: Channel | null;
    try {
      channel = await this.channelById(channelId);
    } catch (err) {
      return lookUpFailure(channelId, err);
    }
    if (!channel) return null;
    if (guildSegment === 'dm') {
      if (channel.type !== ChannelType.DM) return null;
      // discord.js holds a DM it has seen a message in as whole, whatever
      // recipients it recorded, and when the bot's own message was the first
      // it saw there, it recorded only the bot, so its recipientId getter
      // gives the bot's id.
      let recipientId = this.dmOtherParty(channel);
      if (!recipientId) {
        try {
          recipientId = this.dmOtherParty(await this.refetchChannel(channelId));
        } catch (err) {
          return lookUpFailure(channelId, err);
        }
      }
      if (!recipientId || (this.dmUsers && !this.dmUsers.has(recipientId))) return null;
      const recipient = this.client.users.resolve(recipientId) ?? (await this.client.users.fetch(recipientId).catch(() => null));
      if (this.dmUsers && !this.dmUsers.has(recipientId)) return null;
      return { kind: 'dm', recipientId, recipientName: recipient?.username ?? recipientId };
    }
    if (!('guildId' in channel) || channel.guildId !== guildSegment) return null;
    const staleParent = this.staleParentOf(channel);
    if (staleParent) await this.lookUpChannel(channel.guildId, staleParent);
    if (this.isStale(channelId) || (staleParent !== null && this.isStale(staleParent))) return { kind: 'uncertain' };
    const facts = this.channelFacts(channel);
    if (!facts) return null;
    if (!isListedKind(facts.type) && facts.type !== 'thread') return null;
    if (!this.channelAdmitted(facts.guildId, facts.id, facts.parentId ?? null)) return null;
    return { kind: 'guild', facts };
  }

  /** A thread the client knows only partly is fetched past the cache, which would hand back that same partial. */
  async getChannelMeta(channelId: string): Promise<ChannelMeta> {
    return this.extractChannelMeta(await this.channelById(channelId), channelId);
  }

  private async channelById(channelId: string): Promise<Channel | null> {
    const cached = this.client.channels.cache.get(channelId);
    if (cached && !cached.partial && !threadChannelUnknown(cached) && !this.isStale(channelId)) return cached;
    return this.refetchChannel(channelId, { force: cached !== undefined });
  }

  getCachedChannelMeta(channelId: string): ChannelMeta | null {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel) return null;
    return this.extractChannelMeta(channel, channelId);
  }

  private knownName(channelId: string, name: unknown): string | null {
    return typeof name === 'string' && name.length > 0 && !this.isStale(channelId) ? name : null;
  }

  private extractChannelMeta(channel: unknown, channelId: string): ChannelMeta {
    if (!channel) return { name: null, guildId: null, guildName: null, isDM: null };
    const c = channel as {
      name?: string;
      guildId?: string | null;
      guild?: { name?: string };
      isDMBased?: () => boolean;
    };
    const guildId = c.guildId ?? null;
    const isDM = typeof c.isDMBased === 'function' ? c.isDMBased() : guildId ? false : null;
    return {
      name: this.knownName(channelId, c.name),
      guildId,
      guildName: c.guild?.name ?? null,
      isDM,
      ...this.threadPlace(channel, channelId),
    };
  }

  /** The parent is looked up by parentId rather than through discord.js
   *  `ThreadChannel.parent`, which goes through the thread's guild and throws
   *  when it has none. */
  private threadPlace(channel: unknown, channelId: string): ThreadPlace {
    const c = channel as { isThread?: () => boolean; name?: string | null; parentId?: string | null } | null | undefined;
    if (!c || typeof c.isThread !== 'function' || !c.isThread()) return {};
    const parent = c.parentId
      ? (this.client.channels.cache.get(c.parentId) as { name?: string } | undefined)
      : undefined;
    const threadName = this.knownName(channelId, c.name);
    return {
      threadId: channelId,
      ...(threadName !== null ? { threadName } : {}),
      threadParentName: c.parentId ? this.knownName(c.parentId, parent?.name) : null,
    };
  }

  getCachedChannelFacts(channelId: string): ChannelFacts | null {
    return this.channelFacts(this.client.channels.cache.get(channelId));
  }

  getCachedChannelFactsFor(channelIds: Iterable<string>): Map<string, ChannelFacts> {
    const names = this.nameView();
    const result = new Map<string, ChannelFacts>();
    for (const channelId of channelIds) {
      const facts = this.channelFacts(this.client.channels.cache.get(channelId), names);
      if (facts) result.set(channelId, facts);
    }
    return result;
  }

  /** discord.js's `ThreadChannel.parent` goes through the thread's guild and
   *  throws when it has none, so a thread's parent is looked up by id. */
  private channelFacts(channel: unknown, names?: NameView): ChannelFacts | null {
    const c = channel as {
      id?: string; guildId?: string | null; type?: number; name?: string | null;
      parentId?: string | null; archived?: boolean | null; archiveTimestamp?: number | null;
    } | null | undefined;
    if (!c?.id || !c.guildId) return null;
    const type = mapChannelType(c.type);
    const named = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const parent = type === 'thread' && c.parentId
      ? (this.client.channels.cache.get(c.parentId) as { name?: string } | undefined)
      : undefined;
    const facts: ChannelFacts = {
      id: c.id,
      guildId: c.guildId,
      guildName: named(this.client.guilds.cache.get(c.guildId)?.name),
      type,
      name: this.knownName(c.id, c.name),
      parentId: c.parentId ?? null,
      parentName: c.parentId ? this.knownName(c.parentId, parent?.name) : null,
      archived: type === 'thread' && c.archived === true,
    };
    if (facts.archived && typeof c.archiveTimestamp === 'number' && Number.isFinite(c.archiveTimestamp)) {
      facts.archivedAt = c.archiveTimestamp;
    }
    if (isNameAddressableKind(type) && facts.name && facts.guildName) {
      const resolved = this.resolveAmong(formatChannelLabel(facts.name, facts.guildName), names ?? this.nameView(facts.name));
      facts.nameResolves = resolved.ok && resolved.id === facts.id;
    }
    return facts;
  }

  /** Snowflakes are 64-bit, past a Number's exact range, so they're compared by numeric collation. */
  private snowflakeLte(a: string, b: string): boolean {
    return a.localeCompare(b, 'en-US-u-kn-true') <= 0;
  }

  private messageMentionsBot(m: Message): boolean {
    const botId = this.client.user?.id;
    if (!botId) return false;
    return (
      m.mentions.users.has(botId) ||
      m.mentions.repliedUser?.id === botId ||
      m.mentions.roles.some((r) => (r as { tags?: { botId?: string } }).tags?.botId === botId)
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  }

  getGuildName(guildId: string): string {
    return this.client.guilds.cache.get(guildId)?.name ?? guildId;
  }

  async getDmChannelInfo(
    channelId: string,
  ): Promise<{ recipientId: string; recipientName: string } | null> {
    try {
      const channel = await this.channelById(channelId);
      if (!channel || channel.type !== ChannelType.DM) return null;
      const dm = channel as DMChannel;
      const recipient =
        dm.recipient ?? (dm.recipientId ? await this.client.users.fetch(dm.recipientId) : null);
      if (!recipient) return null;
      return { recipientId: recipient.id, recipientName: recipient.username };
    } catch {
      return null;
    }
  }

  private memberFetchTimeoutMs = 30_000;

  private async warmGuildMemberCache(guild: Guild): Promise<boolean> {
    if (guild.memberCount > 0 && guild.members.cache.size >= guild.memberCount) return true;
    const TIMEOUT_MS = this.memberFetchTimeoutMs;
    const fetchP = guild.members.fetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `guild.members.fetch() timed out after ${TIMEOUT_MS}ms for "${guild.name}". ` +
                'GuildMembers intent must be enabled in BOTH the Discord Developer ' +
                "Portal (Bot → Privileged Gateway Intents) AND the discord.js client's " +
                'intents array. The client side is set; check the portal side.',
            ),
          ),
        TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([fetchP, timeoutP]);
      console.error(
        `[discord-mcpl] member cache warmed for "${guild.name}" (${guild.members.cache.size} members)`,
      );
      return true;
    } catch (err) {
      console.error(
        `[discord-mcpl] member cache warm-up failed for "${guild.name}": ${(err as Error).message}`,
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async describeChannel(
    channelId: string,
  ): Promise<{ label: string; channelName?: string; guildName?: string; isDM: boolean }> {
    try {
      const channel = await this.channelById(channelId);
      if (!channel) return { label: channelId, isDM: false };
      const ch = channel as { guild?: Guild; recipient?: User; name?: string };
      if (ch.guild) {
        const channelName = typeof ch.name === 'string' ? ch.name : undefined;
        const guildName = ch.guild.name;
        return {
          label: channelName
            ? `#${channelName} in ${guildName}`
            : `channel ${channelId} in ${guildName}`,
          channelName,
          guildName,
          isDM: false,
        };
      }
      if (ch.recipient) {
        const u = ch.recipient as User & { globalName?: string | null };
        const name = u.globalName ?? u.displayName ?? u.username ?? u.id;
        return { label: `DM with @${name}`, isDM: true };
      }
      return { label: channelId, isDM: false };
    } catch {
      return { label: channelId, isDM: false };
    }
  }

  async listGuilds(): Promise<DiscordGuildInfo[]> {
    return this.client.guilds.cache.map((g: Guild) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
    }));
  }

  /** GUILD_CREATE lists every channel of a guild and updates follow, so the
   *  guild's own cache is whole while the guild is available. */
  async listChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild?.channels) {
      throw new Error(`Guild ${guildId} not found`);
    }
    const unavailable = () => new Error(
      `Nothing was listed: server ${guildId} is unavailable in a Discord outage, so its channels can't be listed until ` +
        "it's back. The same call can list them then.",
    );
    if (!guild.available) throw unavailable();
    await this.refreshStale(guildId);
    if (!guild.available) throw unavailable();
    const names = this.nameView();
    const result: DiscordChannelInfo[] = [];
    guild.channels.cache.forEach((c: GuildBasedChannel) => {
      if (!c.isThread()) {
        if (this.isStale(c.id)) return;
        if (!this.channelAllowed(guildId, c.id, c.parentId)) return;
        const facts = this.channelFacts(c, names);
        const topic = channelTopic(c);
        result.push({
          id: c.id,
          name: c.name,
          type: mapChannelType(c.type),
          parentId: c.parentId ?? undefined,
          label: facts ? channelLabelFor(facts) : mcplChannelId(guildId, c.id),
          ...(topic ? { topic } : {}),
        });
      }
    });
    return result;
  }


  resolveChannelRef(ref: string): ResolveResult {
    return this.resolveAmong(ref, this.nameView());
  }

  private resolveAmong(ref: string, names: NameView): ResolveResult {
    const parsed = parseChannelRef(ref);
    if (!parsed) {
      return { ok: false, reason: 'not-found', message: `Unusable channel reference: "${ref}"` };
    }
    if (parsed.kind === 'id') return { ok: true, id: parsed.id };
    if (isThreadLabelShape(parsed.name)) return threadLabelRefusal(ref);
    const uncertain = names.uncertainGuilds();
    if (parsed.guild === undefined ? uncertain.any : uncertain.named.has(parsed.guild.toLowerCase())) {
      const where = parsed.guild === undefined ? 'a server this name could mean' : 'that server';
      return {
        ok: false, reason: 'ambiguous',
        message: `Nothing was done: ${ref} can't be resolved by name right now, since Discord's current facts for a channel in ${where} aren't known (its latest fetch failed or was overtaken by a change), so its current name may be this one. Address the channel by its id instead: until that fetch succeeds, each channel the name could mean there is shown by its id wherever its label would be, and list_channels lists the others with their ids.`,
      };
    }
    return resolveChannelName(parsed, names(parsed.name));
  }

  private uncertainGuildNames(): { named: Set<string>; any: boolean } {
    const named = new Set<string>();
    let any = false;
    for (const [id, { guildId }] of this.stale) {
      if (!this.guildAdmitted(guildId)) continue;
      const guild = this.client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(id);
      if (!guild || !channel || !isNameAddressableKind(mapChannelType(channel.type))) continue;
      any = true;
      if (guild.name) named.add(guild.name.toLowerCase());
    }
    return { named, any };
  }

  private nameView(only?: string): NameView {
    const key = only?.toLowerCase();
    const channelsOf = (g: Guild): Iterable<GuildBasedChannel> =>
      key === undefined ? g.channels.cache.values() : channelsNamed(g.channels.cache.values(), key);
    let byName: Map<string, ChannelCandidate[]> | undefined;
    let uncertain: { named: Set<string>; any: boolean } | undefined;
    const view = ((name: string) => {
      if (!byName) {
        byName = new Map();
        const candidates = buildCandidates(
          // A guild known only by id has no name yet (discord.js's stub).
          [...this.client.guilds.cache.values()].map((g) => ({
            id: g.id, name: g.name ?? '', channels: channelsOf(g),
          })),
          {
            ...(this.guildIds?.length ? { guildIds: this.guildIds } : {}),
            mapType: mapChannelType,
            allowed: (gid, cid, pid) => this.channelAllowed(gid, cid, pid),
          },
        );
        for (const c of candidates) {
          const key = c.name.toLowerCase();
          const group = byName.get(key);
          if (group) group.push(c);
          else byName.set(key, [c]);
        }
      }
      return byName.get(name.toLowerCase()) ?? [];
    }) as NameView;
    view.uncertainGuilds = () => (uncertain ??= this.uncertainGuildNames());
    return view;
  }

  async listChannelMembers(
    channelId: string,
    opts: { cap?: boolean; withPermission?: bigint; warmups?: Map<string, boolean> } = {},
  ): Promise<DiscordChannelMembers> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'no members were listed');
    const warm = async (guild: Guild): Promise<boolean> => {
      let warmed = opts.warmups?.get(guild.id);
      if (warmed === undefined) {
        warmed = await this.warmGuildMemberCache(guild);
        opts.warmups?.set(guild.id, warmed);
      }
      return warmed;
    };

    const toInfo = (m: GuildMember): DiscordMemberInfo => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
      isBot: m.user.bot,
    });
    const finish = (
      channelName: string | null,
      scope: DiscordChannelMembers['scope'],
      members: DiscordMemberInfo[],
      note?: string,
    ): DiscordChannelMembers => {
      members.sort(
        (a, b) =>
          Number(a.isBot) - Number(b.isBot) ||
          a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }),
      );
      return {
        channelId,
        channelName,
        scope,
        total: members.length,
        members: opts.cap === false ? members : members.slice(0, MEMBER_LIST_CAP),
        truncated: opts.cap !== false && members.length > MEMBER_LIST_CAP,
        ...(note ? { note } : {}),
      };
    };
    const filterDenied = () =>
      new Error(
        `Channel ${channelId} is outside this residence's configured channel filters — ` +
        'filters bound inspection as well as delivery.',
      );

    if (channel.type === ChannelType.DM) {
      const dm = channel as DMChannel;
      const recipient = dm.recipient ?? (dm.recipientId ? await this.client.users.fetch(dm.recipientId) : null);
      const me = this.client.user;
      const members: DiscordMemberInfo[] = [];
      for (const u of [recipient, me]) {
        if (!u) continue;
        members.push({ id: u.id, username: u.username, displayName: u.displayName ?? u.username, isBot: u.bot });
      }
      return finish(null, 'dm', members);
    }

    if (channel.isThread()) {
      const guild = channel.guild;
      if (!this.channelAllowed(guild?.id ?? channel.guildId, channelId, channel.parentId)) {
        throw filterDenied();
      }
      // Discord documents List Thread Members as paged only with with_member,
      // which this call doesn't pass, so it should return every joined
      // member. Its limit has a default of 100 all the same, and nothing here
      // shows which holds, so a listing of exactly one page may be cut short.
      const threadMembers = await channel.members.fetch();
      const pageFull = threadMembers.size === THREAD_MEMBER_PAGE;
      await warm(guild);
      let unresolved = 0;
      const members = [...threadMembers.values()].map((tm) => {
        const gm = guild.members.cache.get(tm.id);
        if (!gm) unresolved++;
        return gm ? toInfo(gm) : { id: tm.id, username: tm.id, displayName: tm.id, isBot: false };
      });
      const listed = finish(
        this.knownName(channelId, channel.name),
        'thread-joined',
        members,
        'Joined members only. Users with access to the parent channel may be able to read a public thread without joining it.' +
          (pageFull ? ` Discord returned exactly one page (${THREAD_MEMBER_PAGE}) of joined members, so there may be more.` : ''),
      );
      return {
        ...listed,
        ...(unresolved > 0 ? { unresolved } : {}),
        ...(pageFull ? { possiblyIncomplete: true as const } : {}),
      };
    }

    if ('members' in channel && 'guild' in channel) {
      const guildChannel = channel as GuildBasedChannel & { members: Map<string, GuildMember> };
      const parentId = (guildChannel as { parentId?: string | null }).parentId;
      if (!this.channelAllowed(guildChannel.guild.id, channelId, parentId)) {
        throw filterDenied();
      }
      // discord.js's members getter computes View Channel over the member cache
      // (for a voice or stage channel, it lists who is connected), so a partial
      // cache gives a partial list.
      const warmed = await warm(guildChannel.guild);
      if (!warmed) {
        throw new Error(
          'Guild member cache warm-up failed or timed out — a member list computed now ' +
          'would be silently incomplete. Check the GuildMembers privileged intent ' +
          '(Developer Portal → Bot → Privileged Gateway Intents).',
        );
      }
      const members = [...guildChannel.members.values()]
        .filter((m) => opts.withPermission === undefined
          || (guildChannel as GuildBasedChannel & { permissionsFor(m: GuildMember): Readonly<PermissionsBitField> | null })
            .permissionsFor(m)?.has(opts.withPermission) === true)
        .map(toInfo);
      return finish(this.knownName(channelId, guildChannel.name), 'guild-channel', members);
    }

    throw new Error(`Channel ${channelId} has no queryable membership (type ${channel.type})`);
  }

  async resolveLatestFrom(channelId: string, ref: string): Promise<LatestFromResult> {
    const raw = ref.trim();
    const bare = raw.replace(/^@/, '').trim();
    if (!bare) return { ok: false, message: 'latestFrom names no one; nothing was done.' };
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was done');
    const refused = await this.latestFromFilterRefusal(channel, channelId);
    if (refused) return { ok: false, message: refused };
    const guildId = 'guildId' in channel && channel.guildId ? channel.guildId : null;
    const window = await this.fetchHistory(channelId, { limit: LATEST_FROM_WINDOW, nothing: 'nothing was done' });
    if (window.length === 0) {
      return { ok: false, message: 'This channel has no messages, so latestFrom has nothing to choose from; nothing was done.' };
    }
    const newestFirst = [...window].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
    const span = `the ${newestFirst.length} most recent messages here (${newestFirst[newestFirst.length - 1].timestamp.toISOString()} to ${newestFirst[0].timestamp.toISOString()})`;
    const displayOf = (m: HistoryMessage): string => m.authorDisplayName ?? m.authorName;
    const mention = /^<@!?(\d{17,20})>$/.exec(raw);
    let authorId: string;
    let authorLabel: string;
    if (mention || isSnowflake(bare)) {
      authorId = mention ? mention[1] : bare;
      const seen = newestFirst.find((m) => m.authorId === authorId);
      authorLabel = seen ? displayOf(seen) : authorId;
    } else {
      const name = bare.toLowerCase();
      const matches = new Map<string, { label: string; username?: string; isBot: boolean }>();
      let identities: DiscordMemberInfo[];
      let unresolved = 0;
      let incomplete = false;
      const warmups = new Map<string, boolean>();
      const failedAt = guildId ? this.latestFromWarmupFailures.get(guildId) : undefined;
      const rememberedFailure = failedAt !== undefined && Date.now() - failedAt < LATEST_FROM_WARMUP_RETRY_MS;
      if (guildId && rememberedFailure) warmups.set(guildId, false);
      try {
        const lists = [await this.listChannelMembers(channelId, { cap: false, warmups })];
        if (lists[0].scope === 'thread-joined') {
          // A thread is readable beyond its joined members, so a name must be
          // unique among those readers as well: for a public thread, everyone
          // who can view its parent; for a private one, the parent's viewers
          // who can manage threads there (administrators included).
          if (!channel.isThread()) throw new Error(`channel ${channelId} was listed as a thread but isn't one`);
          if (!channel.parentId) throw new Error(`thread ${channelId} has no parent channel`);
          lists.push(await this.listChannelMembers(channel.parentId, {
            cap: false,
            warmups,
            ...(channel.type === ChannelType.PrivateThread
              ? { withPermission: PermissionsBitField.Flags.ManageThreads }
              : {}),
          }));
        }
        identities = lists.flatMap((l) => l.members);
        for (const l of lists) {
          unresolved += Math.max(
            l.unresolved ?? 0,
            l.members.filter((m) => m.username === m.id && m.displayName === m.id).length,
          );
          if (l.possiblyIncomplete) incomplete = true;
        }
      } catch (err) {
        return {
          ok: false,
          message: `"${raw}" can't be checked for people sharing that name: this channel's member list is unavailable (${errorValue(err)}). Use their numeric user id; nothing was done.`,
        };
      } finally {
        const outcome = guildId ? warmups.get(guildId) : undefined;
        if (guildId && outcome === true) this.latestFromWarmupFailures.delete(guildId);
        else if (guildId && outcome === false && !rememberedFailure) this.latestFromWarmupFailures.set(guildId, Date.now());
      }
      if (unresolved > 0) {
        return {
          ok: false,
          message: `"${raw}" can't be checked for people sharing that name: ${unresolved} member(s) here couldn't be resolved to names. Use their numeric user id; nothing was done.`,
        };
      }
      if (incomplete) {
        return {
          ok: false,
          message: `"${raw}" can't be checked for people sharing that name: Discord returned exactly one page (${THREAD_MEMBER_PAGE}) of this thread's members, so there may be more. Use their numeric user id; nothing was done.`,
        };
      }
      for (const m of identities) {
        if (m.username.toLowerCase() === name || m.displayName.toLowerCase() === name) {
          matches.set(m.id, { label: m.displayName, username: m.username, isBot: m.isBot });
        }
      }
      for (const m of newestFirst) {
        if (matches.has(m.authorId)) continue;
        if (m.authorName.toLowerCase() === name || displayOf(m).toLowerCase() === name) {
          matches.set(m.authorId, { label: displayOf(m), username: m.authorName, isBot: m.isBot });
        }
      }
      if (matches.size === 0) {
        return { ok: false, message: `No one named "${raw}" is in this channel or among ${span}. Use their numeric user id; nothing was done.` };
      }
      if (matches.size > 1) {
        const choices = [...matches].slice(0, 10)
          .map(([id, m]) => `${nameValue(m.label)}${m.username ? ` (@${nameValue(m.username)})` : ''}${m.isBot ? ' [bot]' : ''} = ${id}`)
          .join('; ');
        return { ok: false, message: `"${raw}" matches ${matches.size} people here: ${choices}. Use the numeric user id; nothing was done.` };
      }
      const [[id, only]] = [...matches];
      authorId = id;
      authorLabel = only.label;
    }
    const target = newestFirst.find((m) => m.authorId === authorId && !m.system);
    if (!target) {
      return {
        ok: false,
        message: `No message from ${nameValue(authorLabel)} among ${span}; nothing was done. latestFrom never reaches further back or picks another author.`,
      };
    }
    const refusedNow = await this.latestFromFilterRefusal(channel, channelId);
    if (refusedNow) return { ok: false, message: refusedNow };
    return { ok: true, message: target, authorId, authorLabel };
  }

  private async latestFromFilterRefusal(channel: Channel, channelId: string): Promise<string | null> {
    const guildId = 'guildId' in channel && channel.guildId ? channel.guildId : null;
    if (guildId && this.guildIds?.length && !this.guildIds.includes(guildId)) {
      return `Channel ${channelId} is in a server outside this residence's configured guild filter, which bounds reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`;
    }
    if (!this.channelAllowed(guildId, channelId, 'parentId' in channel ? channel.parentId : null)) {
      return `Channel ${channelId} is outside this residence's configured channel filters, which bound reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`;
    }
    if (channel.type === ChannelType.DM && this.dmUsers) {
      let other = this.dmOtherParty(channel);
      if (!other) {
        const unconfirmed = (why: string) =>
          `This DM's other party couldn't be confirmed (${why}), so latestFrom can't check it against this residence's configured DM users and can't choose a message there; nothing was done.`;
        try {
          other = this.dmOtherParty(await this.client.channels.fetch(channelId, { force: true }));
        } catch (err) {
          return unconfirmed(`looking up its DM channel failed: ${errorValue(err)}`);
        }
        if (!other) return unconfirmed('Discord names no recipient for its DM channel');
      }
      if (!this.dmUsers.has(other)) {
        return `This DM is with someone outside this residence's configured DM users, which bound reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`;
      }
    }
    return null;
  }

  async listEmojis(guildId?: string): Promise<DiscordEmojiInfo[]> {
    const guilds: Guild[] = [];
    if (guildId) {
      guilds.push(await this.client.guilds.fetch(guildId));
    } else {
      guilds.push(...this.client.guilds.cache.values());
    }
    const out: DiscordEmojiInfo[] = [];
    for (const g of guilds) {
      let emojis = g.emojis.cache;
      if (emojis.size === 0) {
        emojis = await g.emojis.fetch().catch(() => emojis);
      }
      emojis.forEach((e) => {
        if (!e.name) return;
        out.push({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          token: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
          reactionArg: `:${e.name}:`,
          guildId: g.id,
          guildName: g.name,
        });
      });
    }
    return out;
  }

  async createTextChannel(
    guildId: string,
    name: string,
    categoryId?: string,
  ): Promise<DiscordChannelInfo> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) throw new Error(`Guild ${guildId} not found`);
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    const madeAs = created.name;
    // discord.js puts the POST's reply in the cache whenever it lands, over
    // anything the gateway reported of the new channel meanwhile, such as a
    // rename.
    const channel = ((await this.refetchChannel(created.id).catch((err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
        throw new Error(
          `Channel ${created.id} was created, but Discord says it no longer exists: it was deleted since, so there's ` +
            'no channel to use. create_text_channel can make it again.',
        );
      }
      dbg('create-channel:refetch-failed', { channelId: created.id, error: (err as Error).message });
      this.markStale(created.id, guildId);
      return null;
    })) ?? created) as typeof created;
    const facts = this.channelFacts(channel);
    return {
      id: channel.id,
      name: this.knownName(channel.id, channel.name) ?? madeAs,
      type: 'text',
      parentId: channel.parentId ?? undefined,
      label: facts ? channelLabelFor(facts) : mcplChannelId(guildId, channel.id),
    };
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was deleted');
    if ('delete' in channel) {
      await (channel as TextChannel).delete();
    } else {
      throw new Error(`Channel ${channelId} cannot be deleted`);
    }
  }

  getPostingChannels(): ChannelFacts[] {
    const names = this.nameView();
    const result: ChannelFacts[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) continue;
      result.push(...this.guildPostingChannels(guild, names));
    }
    return result;
  }

  private guildPostingChannels(guild: Guild, names: NameView = this.nameView()): ChannelFacts[] {
    const result: ChannelFacts[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!isListedKind(mapChannelType(channel.type))) continue;
      if (this.isStale(channel.id)) continue;
      if (!this.channelAllowed(guild.id, channel.id, channel.parentId)) continue;
      const facts = this.channelFacts(channel, names);
      if (facts) result.push(facts);
    }
    return result;
  }

  private pendingCreatesIn(channelId: string): Promise<void> | undefined {
    return this.threadLookups.get(channelId);
  }

  /** A missing guild id is not evidence of a DM: uncached guild messages can lack it too. */
  private async messageEventInfo(
    message: Message | PartialMessage,
    opts: { dmParty?: boolean } = {},
  ): Promise<MessageEventInfo | null> {
    const pendingCreates = this.pendingCreatesIn(message.channelId);
    if (pendingCreates) await pendingCreates;
    const authorId = message.author?.id;
    const authorName = message.author?.username;
    let channel: Channel | null | undefined = message.channel ?? this.client.channels.cache.get(message.channelId);
    let guildId = message.guildId ?? (channel && 'guildId' in channel ? channel.guildId : null);
    // While a lookup is pending, the cached entry can be replaced (the guild
    // removed and joined again builds a new thread object), so the channel is
    // read from the cache again after it.
    if (guildId && !this.guildAdmitted(guildId)) return null;
    if (guildId && (threadChannelUnknown(channel) || this.isStale(message.channelId))) {
      await this.lookUpChannel(guildId, message.channelId);
      channel = this.client.channels.cache.get(message.channelId) ?? channel;
    }
    const staleParent = guildId ? this.staleParentOf(channel) : null;
    if (guildId && staleParent) await this.lookUpChannel(guildId, staleParent);
    // The fetch is forced, since discord.js would otherwise hand back a cached partial.
    const needsParent = guildId
      && !(channel && 'parentId' in channel)
      && !this.channelAllowed(guildId, message.channelId);
    if ((!guildId && !channel?.isDMBased()) || needsParent) {
      channel = await this.refetchChannel(message.channelId);
      guildId ??= channel && 'guildId' in channel ? channel.guildId : null;
    }
    if (!guildId && !channel?.isDMBased()) {
      dbg('messageEvent:drop', { msgId: message.id, channelId: message.channelId, reason: 'unknown-channel' });
      return null;
    }
    if (guildId && this.guildIds?.length && !this.guildIds.includes(guildId)) return null;
    const parentId = channel && 'parentId' in channel ? channel.parentId : null;
    if (!this.channelAllowed(guildId, message.channelId, parentId)) return null;
    // The cache can't always name a DM's other party: a deletion of an uncached
    // message names no author, a channel known only by its id carries no
    // recipient, and discord.js counts a cached DM channel as complete once it
    // has seen a message there, whatever recipients it recorded, which may be
    // only the bot. So then Discord is asked, past the cache.
    let dmRecipientId: string | undefined;
    let dmPartyUnknown: string | undefined;
    if (opts.dmParty && !guildId && channel?.isDMBased()) {
      dmRecipientId = authorId && authorId !== this.client.user?.id ? authorId : this.dmOtherParty(channel);
      if (!dmRecipientId && this.dmUsers) {
        try {
          const fetched = await this.client.channels.fetch(message.channelId, { force: true });
          dmRecipientId = this.dmOtherParty(fetched);
          if (!dmRecipientId) dmPartyUnknown = 'Discord names no recipient for its DM channel';
        } catch (err) {
          dmPartyUnknown = `looking up its DM channel failed (${(err as Error).message})`;
        }
      }
    }
    return {
      guildId: guildId ?? null,
      ...this.threadPlace(channel, message.channelId),
      authorId,
      authorName,
      ...(dmRecipientId ? { dmRecipientId } : {}),
      ...(dmPartyUnknown ? { dmPartyUnknown } : {}),
    };
  }

  /** A DM channel's recipient other than the bot, read from discord.js's
   *  `recipientIds`. Its `recipientId` getter won't do here: it throws when
   *  no recipient was ever recorded, and returns the bot's own id when the
   *  bot is the only one recorded. */
  private dmOtherParty(channel: unknown): string | undefined {
    const ids = (channel as { recipientIds?: Array<string | undefined> } | null)?.recipientIds;
    return ids?.find((id) => !!id && id !== this.client.user?.id);
  }

  private forwardMessageEvent(
    message: Message | PartialMessage,
    forward: (info: MessageEventInfo) => void,
    opts: { dmParty?: boolean } = {},
  ): Promise<void> {
    const messageId = message.id;
    const previous = this.messageEventDeliveries.get(messageId) ?? Promise.resolve();
    const pending = Promise.allSettled([previous, this.messageEventInfo(message, opts)]).then(([, result]) => {
      if (result.status === 'rejected') throw result.reason;
      if (result.value) forward(result.value);
    });
    const settled = pending.catch(() => {});
    this.messageEventDeliveries.set(messageId, settled);
    void settled.then(() => {
      if (this.messageEventDeliveries.get(messageId) === settled) this.messageEventDeliveries.delete(messageId);
    });
    return pending;
  }

  private async handleMessageUpdate(oldMsg: Message | PartialMessage, newMsg: Message | PartialMessage): Promise<void> {
    const decision = editForwardDecision(oldMsg, newMsg, { selfId: this.client.user?.id });
    if (decision !== 'forward') {
      if (decision !== 'no-content' && decision !== 'self') {
        dbg('messageUpdate:drop', { msgId: newMsg.id, channelId: newMsg.channelId, reason: decision });
      }
      return;
    }
    if (this.editAccept && !this.editAccept(newMsg.channelId)) {
      dbg('messageUpdate:drop', { msgId: newMsg.id, channelId: newMsg.channelId, reason: 'ingress-filtered' });
      return;
    }
    const content = newMsg.content!;
    const { channelId, id: messageId } = newMsg;
    // RFC-006: an edit's occurrence identity and its replacing rendering need the edit time and the mention-resolved body.
    const editedAt = newMsg.editedTimestamp ? new Date(newMsg.editedTimestamp).toISOString() : undefined;
    const cleanContent = mentionNamedContent(newMsg) ?? undefined;
    // Whom the message addresses as edited, from the update's own payload: an
    // edit can add a mention or take one away. Where that isn't known, the
    // address is left out rather than read as ambient: a partial message
    // (discord.js lacks its author or its content), or a reply whose
    // target's author Discord didn't send, since it wasn't fetched or was
    // deleted (Discord's docs on `referenced_message`).
    const replyTargetUnknown = newMsg.type === MessageType.Reply && !newMsg.mentions?.repliedUser;
    const address = newMsg.partial || replyTargetUnknown ? undefined : this.addressFacts(newMsg);
    await this.forwardMessageEvent(newMsg, (info) => {
      if (!info.guildId && this.dmUserRefused(info.authorId)) {
        dbg('messageUpdate:drop', { msgId: messageId, channelId, reason: info.authorId ? 'dm-not-allowed' : 'dm-party-unknown' });
        return;
      }
      this.editHandler?.(channelId, messageId, content, !info.guildId, { ...info, editedAt, cleanContent, ...(address ? { address } : {}) });
    });
  }

  private async handleMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (this.deleteAccept && !this.deleteAccept(message.channelId)) {
      dbg('messageDelete:drop', { msgId: message.id, channelId: message.channelId, reason: 'ingress-filtered' });
      return;
    }
    const { channelId, id: messageId } = message;
    await this.forwardMessageEvent(message, (info) => {
      if (!info.guildId && this.dmUserRefused(info.dmRecipientId)) {
        if (info.dmRecipientId) {
          dbg('messageDelete:drop', { msgId: messageId, channelId, reason: 'dm-not-allowed' });
          return;
        }
        dbg('messageDelete:drop', { msgId: messageId, channelId, reason: 'dm-party-unknown' });
        console.error(
          `[discord-mcpl] Withheld the deletion of message ${messageId} in DM channel ${channelId}: ` +
            `${info.dmPartyUnknown ?? 'its other party is unknown'}, and the DM allowlist refuses what it can't attribute.`,
        );
        return;
      }
      this.deleteHandler?.(channelId, messageId, !info.guildId, info);
    }, { dmParty: true });
  }

  /** discord.js's threadListSync event carries the threads a sync lists, but
   *  not the channels it covers (`channel_ids`). Its ThreadListSync action
   *  applies a sync and emits the event before it returns, so the action is
   *  wrapped. The raw packet can't stand in for it: a packet queued before the
   *  client is ready is applied after newer ones. */
  private installThreadSyncScope(): void {
    const action = (this.client as unknown as {
      actions?: { ThreadListSync?: { handle(data: GatewayThreadListSyncDispatchData): unknown } };
    }).actions?.ThreadListSync;
    if (!action || typeof action.handle !== 'function') {
      throw new Error('discord.js actions.ThreadListSync.handle is missing; thread sync reconciliation requires its payload');
    }
    const handle = action.handle;
    action.handle = (data) => {
      const previous = this.applyingThreadSync;
      // discord.js drops threads as it applies the sync, so what the client
      // held, and under which channels, is read first.
      const held = new Map<string, string | null>();
      for (const channel of this.client.channels.cache.values()) {
        if (!channel.isThread() || channel.guildId !== data.guild_id || channel.archived) continue;
        held.set(channel.id, channel.parentId);
      }
      this.applyingThreadSync = { data, held };
      try {
        return handle.call(action, data);
      } finally {
        this.applyingThreadSync = previous;
      }
    };
  }

  private setupEvents(): void {
    this.watchReports();
    this.client.on('messageCreate', (message: Message) => {
      const base = {
        msgId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        messageType: message.type,
        attachmentCount: message.attachments.size,
        mentionCount: message.mentions.users.size,
      };
      dbg('gateway:message-create', base);

      const waiting = this.pendingCreatesIn(message.channelId);
      const admittedGuild = message.guildId !== null && this.guildAdmitted(message.guildId);
      const lookUp = admittedGuild && (threadChannelUnknown(message.channel) || this.isStale(message.channelId));
      const parentLookUp = admittedGuild ? this.staleParentOf(message.channel) : null;
      if (waiting || lookUp || parentLookUp) {
        const next = (waiting ?? (lookUp ? this.lookUpChannel(message.guildId!, message.channelId) : Promise.resolve()))
          .then(async () => {
            const parentId = this.staleParentOf(this.client.channels.cache.get(message.channelId));
            if (parentId && admittedGuild) await this.lookUpChannel(message.guildId!, parentId);
          })
          .then(() => this.acceptMessage(message, base))
          .catch((err) => console.error('[discord-mcpl] Failed to deliver a thread message:', (err as Error).message));
        this.threadLookups.set(message.channelId, next);
        void next.finally(() => {
          if (this.threadLookups.get(message.channelId) === next) this.threadLookups.delete(message.channelId);
        });
        return;
      }
      this.acceptMessage(message, base);
    });

    this.client.on('messageUpdate', (oldMsg, newMsg) => {
      void this.handleMessageUpdate(oldMsg, newMsg).catch((err) => {
        console.error(
          `[discord-mcpl] Failed to forward the edit of message ${newMsg.id} in channel ${newMsg.channelId}:`,
          (err as Error).message,
        );
      });
    });

    const forwardDelete = (message: Message | PartialMessage): void => {
      void this.handleMessageDelete(message).catch((err) => {
        console.error(
          `[discord-mcpl] Failed to forward the deletion of message ${message.id} in channel ${message.channelId}:`,
          (err as Error).message,
        );
      });
    };
    this.client.on('messageDelete', forwardDelete);
    this.client.on('messageDeleteBulk', (messages) => {
      for (const message of messages.values()) forwardDelete(message);
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      void this.handleReactionEvent('add', reaction, user);
    });

    this.client.on('messageReactionRemove', (reaction, user) => {
      void this.handleReactionEvent('remove', reaction, user);
    });

    this.client.on('channelCreate', (channel) => {
      // A category or forum holds no messages itself, and threads never reach channelCreate.
      if (!isListedKind(mapChannelType(channel.type))) return;
      const facts = this.channelFacts(channel);
      if (!facts) return;
      if (this.guildIds?.length && !this.guildIds.includes(facts.guildId)) return;
      if (!this.channelAllowed(facts.guildId, facts.id, facts.parentId)) return;
      this.channelCreateHandler?.(facts);
    });

    // A deleted channel's threads go with it. discord.js drops them from its
    // caches without a threadDelete for each, but the deleted channel still
    // lists the ones it held.
    this.client.on('channelDelete', (channel) => {
      if ('guildId' in channel && channel.guildId) {
        const threadIds = 'threads' in channel ? [...channel.threads.cache.keys()] : [];
        for (const id of [channel.id, ...threadIds]) this.stale.delete(id);
        this.channelDeleteHandler?.(channel.guildId, channel.id, threadIds);
      }
    });

    this.client.on('threadUpdate', (_oldThread, newThread) => {
      // Discord reported the thread as it is now, and discord.js patched the cache with it.
      this.stale.delete(newThread.id);
      const facts = this.channelFacts(newThread);
      if (facts) this.threadUpdateHandler?.(facts);
    });

    this.client.on('threadDelete', (thread) => {
      this.stale.delete(thread.id);
      if (thread.guildId) this.threadDeleteHandler?.(thread.guildId, thread.id);
    });

    this.client.on('threadListSync', (threads, guild) => {
      const applying = this.applyingThreadSync;
      const scope = applying?.data.guild_id === guild.id ? applying : undefined;
      // Only discord.js's ThreadListSync action gives the sync's payload. A throw
      // here would end the process from inside the gateway's packet handling.
      if (!scope) {
        console.error(`[discord-mcpl] A sync of server ${guild.id}'s threads came outside discord.js's ThreadListSync action, so the channels it covers aren't known; nothing it omits is forgotten.`);
      }
      const covered = scope ? (scope.data.channel_ids ? new Set(scope.data.channel_ids) : null) : new Set<string>();
      const listed = new Set(threads.keys());
      // discord.js drops only the threads its covered channels' threads caches
      // held; one held outside them, such as a partial a threadUpdate patched
      // since, stays in its cache.
      const dropped = new Set<string>();
      for (const [id, parentId] of scope?.held ?? []) {
        if (listed.has(id) || !(covered === null || (parentId !== null && covered.has(parentId)))) continue;
        dropped.add(id);
        this.forgetCached(id);
      }
      for (const id of listed) this.stale.delete(id);
      this.threadsSyncedHandler?.(guild.id, covered, listed, dropped);
    });

    this.client.on('guildUpdate', (oldGuild, newGuild) => {
      if (oldGuild.name === newGuild.name) return;
      if (this.guildIds?.length && !this.guildIds.includes(newGuild.id)) return;
      this.guildRenameHandler?.(newGuild.id);
    });

    this.client.on('ready', () => {
      this.readyHandler?.();
      for (const guild of this.client.guilds.cache.values()) {
        void this.warmGuildMemberCache(guild);
      }
    });

    // channelCreate fires only for channels created after the join, so a new guild's existing channels are surfaced here.
    this.client.on('guildCreate', (guild) => {
      // A guild left and joined again can leave its old channels in the
      // client-wide cache, as a return does.
      this.markUnlisted(guild);
      void this.warmGuildMemberCache(guild);
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      if (this.guildCommandDefs) {
        guild.commands.set(this.guildCommandDefs).catch((err: Error) => {
          console.error(`[discord-mcpl] Failed to register commands in new guild ${guild.id}:`, err.message);
        });
      }
      this.guildCreateHandler?.(guild.id, this.guildPostingChannels(guild));
    });

    this.client.on('guildDelete', (guild) => {
      for (const [id, mark] of this.stale) if (mark.guildId === guild.id) this.stale.delete(id);
      this.guildDeleteHandler?.(guild.id);
    });

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (
        this.guildIds?.length &&
        interaction.guildId &&
        !this.guildIds.includes(interaction.guildId)
      ) {
        return;
      }
      this.slashCommandHandler?.(interaction);
    });

    this.client.on('channelUpdate', (oldChannel, newChannel) => {
      const wasStale = this.stale.delete(newChannel.id);
      if (!('guild' in newChannel)) return;
      if (!isListedKind(mapChannelType(newChannel.type)) && !holdsPosts(newChannel.type)) return;
      const guild = newChannel.guild;
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      const admitted = this.channelAllowed(guild.id, newChannel.id, newChannel.parentId);
      const facts = this.channelFacts(newChannel);
      const old = oldChannel as { name?: string | null; type?: number; parentId?: string | null };
      const addressChanged = wasStale || old.name !== newChannel.name || old.type !== newChannel.type || old.parentId !== newChannel.parentId;
      if (facts) this.channelUpdateHandler?.(facts, { addressChanged, admitted });
    });

    this.client.on('guildAvailable', (guild) => {
      this.markUnlisted(guild);
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      this.guildAvailableHandler?.(guild.id, this.guildPostingChannels(guild), new Set(guild.channels.cache.keys()));
    });

    this.client.on('error', (err: Error) => {
      dbg('gateway:client-error', { error: err.message });
      console.error('[discord-mcpl] Client error:', err.message);
    });

    this.client.on('warn', (message: string) => {
      dbg('gateway:warn', { message });
    });

    this.client.on('shardReady', (shardId, unavailableGuilds) => {
      dbg('gateway:shard-ready', {
        shardId,
        unavailableGuilds: unavailableGuilds?.size ?? 0,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      dbg('gateway:shard-disconnect', {
        shardId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardReconnecting', (shardId) => {
      dbg('gateway:shard-reconnecting', {
        shardId,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardResume', (shardId, replayedEvents) => {
      dbg('gateway:shard-resume', {
        shardId,
        replayedEvents,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardError', (err, shardId) => {
      dbg('gateway:shard-error', {
        shardId,
        error: err.message,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
      console.error(`[discord-mcpl] Gateway shard ${shardId} error:`, err.message);
    });

    this.client.on('invalidated', () => {
      dbg('gateway:invalidated', {
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
      console.error('[discord-mcpl] Gateway session invalidated');
    });
  }

  /** Guild channels are always cached under the GUILDS intent, so a thread's
   *  channel's category is read from the client's channel cache. */
  private channelAllowed(
    guildId: string | null | undefined,
    channelId: string,
    parentId?: string | null,
  ): boolean {
    if (!guildId || !this.guildChannels) return true;
    const allowed = this.guildChannels.get(guildId);
    if (!allowed) return true;
    if (parentId != null && !allowed.has(channelId) && !allowed.has(parentId)) {
      const parent = this.client.channels.cache.get(parentId) as { parentId?: string | null } | undefined;
      if (parent?.parentId != null && !this.isStale(parentId) && allowed.has(parent.parentId)) return true;
    }
    return allowed.has(channelId) || (parentId != null && allowed.has(parentId));
  }

  private acceptMessage(message: Message, base: Record<string, unknown>): void {
    const dropReason = this.messageFilterReason(message);
    if (dropReason) {
      dbg('gateway:message-create-drop', { ...base, reason: dropReason });
      if (dropReason === 'dm-user-not-allowed') {
        this.refuseDm({
          messageId: message.id,
          channelId: message.channelId,
          authorId: message.author.id,
          origin: 'live',
        });
      }
      return;
    }
    try {
      this.messageHandler?.(this.convertMessage(message));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      dbg('gateway:message-create-error', { ...base, error });
      console.error('[discord-mcpl] Failed to convert Discord message:', error);
    }
  }

  /** Forced, since discord.js would otherwise return the cached object. The
   *  REST client's own timeout and retries bound each attempt (15 s a try,
   *  three retries, by default), though a rate limit's Retry-After waits can
   *  hold events waiting behind it longer. */
  private async lookUpChannel(guildId: string, channelId: string): Promise<void> {
    try {
      await this.refetchChannel(channelId);
    } catch (err) {
      // A thread known only partly isn't in its channel's threads.cache, so
      // when it goes with its channel, for which Discord sends no threadDelete,
      // nothing else reports its deletion.
      if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
        dbg('gateway:channel-lookup-gone', { channelId });
        this.threadDeleteHandler?.(guildId, channelId);
        return;
      }
      const error = (err as Error).message;
      dbg('gateway:channel-lookup-failed', { channelId, error });
      console.error(
        `[discord-mcpl] Couldn't look up channel ${channelId} past the cache (${error}). ` +
          "Its events are decided on what the cache holds: where its guild has a channel list, a thread whose parent channel isn't known passes only if it's listed itself, and they go unnamed unless it's registered.",
      );
    }
  }

  /** discord.js patches the cached channel with the reply, so a reply older
   *  than something Discord reported while the fetch was out can overwrite
   *  newer facts. */
  private async refetchChannel(channelId: string, { force = true }: { force?: boolean } = {}): Promise<Channel | null> {
    for (let tries = 1; ; tries++) {
      const fetch = { overtaken: false };
      let out = this.fetchesOut.get(channelId);
      if (!out) this.fetchesOut.set(channelId, (out = new Set()));
      out.add(fetch);
      let channel: Channel | null;
      try {
        channel = await this.client.channels.fetch(channelId, { force: force || tries > 1 });
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) this.channelGone(channelId);
        throw err;
      } finally {
        out.delete(fetch);
        if (out.size === 0) this.fetchesOut.delete(channelId);
      }
      if (!fetch.overtaken) {
        if (this.stale.delete(channelId)) this.channelRefreshedHandler?.(channelId);
        return channel;
      }
      const guildId = channel && 'guildId' in channel ? channel.guildId : null;
      if (guildId) this.markStale(channelId, guildId);
      dbg('gateway:fetch-overtaken', { channelId, tries, last: tries === FETCH_TRIES });
      if (tries === FETCH_TRIES) return channel;
    }
  }

  private markStale(channelId: string, guildId: string): void {
    if (this.stale.has(channelId)) return;
    this.stale.set(channelId, { guildId });
    this.channelStaleHandler?.(channelId);
  }

  private overtake(channelId: string): void {
    for (const fetch of this.fetchesOut.get(channelId) ?? []) fetch.overtaken = true;
  }

  private channelGone(channelId: string): void {
    const held = this.client.channels.cache.get(channelId) as
      | { guildId?: string | null; threads?: { cache: Map<string, unknown> } }
      | undefined;
    const guildId = held?.guildId ?? null;
    const threadIds = [...(held?.threads?.cache.keys() ?? [])];
    this.forgetCached(channelId);
    if (guildId) this.channelDeleteHandler?.(guildId, channelId, threadIds);
  }

  /** discord.js's own removal of a deleted channel drops the threads its
   *  threads cache holds too, and a failed fetch leaves all of it. Read by ids, since a thread's parent
   *  getter throws when it has no guild. */
  private forgetCached(channelId: string): void {
    type Held = { guildId?: string | null; parentId?: string | null; threads?: { cache: Map<string, unknown> } };
    const held = this.client.channels.cache.get(channelId) as Held | undefined;
    const ids = [channelId, ...(held?.threads?.cache.keys() ?? [])];
    const guild = held?.guildId ? this.client.guilds.cache.get(held.guildId) : undefined;
    const parent = held?.parentId ? (this.client.channels.cache.get(held.parentId) as Held | undefined) : undefined;
    for (const id of ids) {
      this.stale.delete(id);
      this.client.channels.cache.delete(id);
      guild?.channels.cache.delete(id);
    }
    parent?.threads?.cache.delete(channelId);
  }

  /** Read as the gateway dispatches them, before discord.js applies them:
   *  discord.js emits threadUpdate and channelUpdate only for a channel it
   *  holds. Discord sends a thread's create when the bot learns of the thread,
   *  not only when it's made. */
  private watchReports(): void {
    for (const event of [
      GatewayDispatchEvents.ChannelCreate, GatewayDispatchEvents.ChannelUpdate,
      GatewayDispatchEvents.ThreadCreate, GatewayDispatchEvents.ThreadUpdate, GatewayDispatchEvents.ThreadDelete,
    ]) {
      this.client.ws.on(event, (data: { id?: unknown }) => {
        if (typeof data?.id === 'string') this.overtake(data.id);
      });
    }
    for (const event of [GatewayDispatchEvents.GuildCreate, GatewayDispatchEvents.ThreadListSync, GatewayDispatchEvents.ChannelDelete]) {
      this.client.ws.on(event, () => {
        for (const fetches of this.fetchesOut.values()) for (const fetch of fetches) fetch.overtaken = true;
      });
    }
  }

  /** discord.js refills a guild's own cache from its payload (Guild._patch)
   *  and keeps the rest in the client-wide cache with the facts they had. A
   *  later threadUpdate only patches such a thread (ChannelUpdateAction) and a
   *  fetch adds it with no guild (ChannelManager.fetch), so neither puts it
   *  back in its guild's cache. */
  private markUnlisted(guild: Guild): void {
    for (const [id, mark] of this.stale) if (mark.guildId === guild.id) this.stale.delete(id);
    let marked = 0;
    for (const channel of this.client.channels.cache.values()) {
      const c = channel as { id: string; guildId?: string | null };
      if (c.guildId !== guild.id || guild.channels.cache.has(c.id)) continue;
      this.stale.set(c.id, { guildId: guild.id });
      marked++;
    }
    if (marked > 0) dbg('gateway:guild-unlisted', { guildId: guild.id, marked });
  }

  isStale(channelId: string): boolean {
    return this.stale.has(channelId);
  }

  async inspectionRefusal(channelId: string): Promise<string | null> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was read');
    if (channel.isDMBased()) return null;
    const guildId = 'guildId' in channel ? channel.guildId : null;
    const parentId = 'parentId' in channel ? channel.parentId : null;
    if (this.channelAllowed(guildId, channelId, parentId)) return null;
    return (
      `Channel ${channelId} is outside this residence's configured channel filters — ` +
      'filters bound inspection as well as delivery. Nothing was read.'
    );
  }

  /** Without Read Message History, Discord answers a read of a channel's
   *  messages with none, not a refusal. A thread's permissions are its
   *  parent's. */
  async readsMessageHistory(channelId: string): Promise<boolean> {
    const channel = await this.channelById(channelId);
    if (!channel) return false;
    if (channel.isDMBased()) return true;
    const me = channel.guild.members.me;
    return me !== null && (channel as GuildBasedChannel & { permissionsFor(m: GuildMember): Readonly<PermissionsBitField> | null })
      .permissionsFor(me)?.has(PermissionsBitField.Flags.ReadMessageHistory) === true;
  }

  private messageFilterReason(message: Message): string | null {
    const parentId =
      message.channel && 'parentId' in message.channel
        ? ((message.channel as { parentId?: string | null }).parentId ?? null)
        : null;
    return this.ingressReason({
      authorId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      parentId,
    });
  }

  private ingressReason(m: {
    authorId: string;
    guildId: string | null | undefined;
    channelId: string;
    parentId?: string | null;
  }): string | null {
    if (m.authorId === this.client.user?.id) return 'self-authored';
    if (this.guildIds?.length && m.guildId && !this.guildIds.includes(m.guildId)) {
      return 'guild-not-allowed';
    }
    if (!m.guildId && this.dmUserRefused(m.authorId)) {
      return 'dm-user-not-allowed';
    }
    if (m.guildId && !this.channelAllowed(m.guildId, m.channelId, m.parentId)) {
      return 'channel-not-allowed';
    }
    return null;
  }

  private dmUserRefused(userId: string | undefined): boolean {
    return !!this.dmUsers && (!userId || !this.dmUsers.has(userId));
  }

  dmUserAdmitted(userId: string): boolean {
    return !this.dmUserRefused(userId);
  }

  historyIngressReason(channelId: string, guildId: string | null, authorId: string): string | null {
    const channel = this.client.channels.cache.get(channelId) as { parentId?: string | null } | undefined;
    return this.ingressReason({ authorId, guildId, channelId, parentId: channel?.parentId ?? null });
  }

  private convertMessage(message: Message): DiscordMessageData {
    const channel = message.channel as { name?: string } | null;
    const channelName = this.knownName(message.channelId, channel?.name);
    const guildName = message.guild?.name ?? null;
    const content = resolveVisibleContent(message);
    // A forward's reference points at its origin message, with reference type Forward.
    const refType = (message.reference as { type?: number } | null)?.type ?? 0;
    return {
      id: message.id,
      content,
      cleanContent: content,
      authorId: message.author.id,
      authorName: message.author.username,
      channelId: message.channelId,
      channelName,
      guildId: message.guildId ?? null,
      guildName,
      // `message.thread` is the thread a message started, not the one it was posted in.
      ...this.threadPlace(message.channel, message.channelId),
      replyToId: refType === 0 ? (message.reference?.messageId ?? undefined) : undefined,
      replyToUserName: message.mentions.repliedUser?.username ?? null,
      ...this.addressFacts(message),
      attachments: mapAllAttachments(message),
      timestamp: message.createdAt,
    };
  }

  private addressFacts(message: Message): AddressFacts {
    return {
      // mentions.repliedUser is the user the reply targets; mentions.users holds
      // them only when the reply pings them or the body mentions them.
      replyToUserId: message.mentions.repliedUser?.id ?? null,
      mentions: message.mentions.users.map((u) => u.id),
      mentionsBotRole: message.mentions.roles.some(
        (r) => (r as { tags?: { botId?: string } }).tags?.botId === this.client.user?.id,
      ),
      isBot: message.author.bot,
    };
  }
}

/** The author of a Discord system message is its subject (the joining
 *  member authors the UserJoin message). */
function systemMessageText(type: MessageType): string {
  switch (type) {
    case MessageType.UserJoin:
      return '[joined the server]';
    case MessageType.GuildBoost:
      return '[boosted the server]';
    case MessageType.GuildBoostTier1:
    case MessageType.GuildBoostTier2:
    case MessageType.GuildBoostTier3:
      return '[boosted the server to a new tier]';
    case MessageType.ChannelPinnedMessage:
      return '[pinned a message to this channel]';
    case MessageType.ChannelFollowAdd:
      return '[followed a channel into this one]';
    case MessageType.RecipientAdd:
      return '[added someone to the group]';
    case MessageType.RecipientRemove:
      return '[removed someone from the group]';
    case MessageType.ChannelNameChange:
      return '[changed the channel name]';
    case MessageType.ThreadCreated:
      return '[started a thread]';
    case MessageType.AutoModerationAction:
      return '[automod action]';
    default:
      return `[system message: type ${type}]`;
  }
}

function mapAttachments(message: { attachments?: { values?(): IterableIterator<unknown> } }): DiscordAttachment[] {
  const coll = message.attachments;
  if (!coll || typeof coll.values !== 'function') return [];
  const out: DiscordAttachment[] = [];
  for (const a of coll.values() as IterableIterator<{
    id: string; name: string | null; url: string; contentType: string | null; size: number;
  }>) {
    const expiry = attachmentUrlExpiry(a.url);
    out.push({
      id: a.id,
      name: a.name ?? a.id,
      url: a.url,
      ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
      contentType: a.contentType ?? null,
      size: typeof a.size === 'number' ? a.size : 0,
    });
  }
  return out;
}

/** A Discord CDN URL's signed `ex` parameter is its expiry, in Unix seconds as hex. */
export function attachmentUrlExpiry(url: string): Date | null {
  let ex: string | null;
  try {
    ex = new URL(url).searchParams.get('ex');
  } catch {
    return null;
  }
  if (!ex || !/^[0-9a-f]+$/i.test(ex)) return null;
  const expiry = new Date(Number.parseInt(ex, 16) * 1000);
  return Number.isFinite(expiry.getTime()) ? expiry : null;
}

export interface PostedParts {
  ids: string[];
  of: number;
  failed: string;
  next?: string;
  files: boolean;
  reply: boolean;
}

function withPostedParts(err: unknown, posted: string[], chunks: string[], files: boolean, reply: boolean): unknown {
  if (err && typeof err === 'object') {
    const k = posted.length;
    Object.assign(err, {
      postedParts: {
        ids: [...posted],
        of: chunks.length,
        failed: chunks[k],
        ...(k + 1 < chunks.length ? { next: chunks[k + 1] } : {}),
        files,
        reply,
      } satisfies PostedParts,
    });
  }
  return err;
}

/** Snapshot attachments keep their original CDN URLs, signed like any other. */
export function mapAllAttachments(m: {
  attachments?: { values?(): IterableIterator<unknown> };
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
}): DiscordAttachment[] {
  const out = mapAttachments(m);
  if (m.messageSnapshots && m.messageSnapshots.size > 0) {
    const seen = new Set(out.map((a) => a.id));
    let snapshotIndex = 0;
    for (const snap of m.messageSnapshots.values()) {
      snapshotIndex++;
      for (const att of mapAttachments({ attachments: snap.attachments ?? undefined })) {
        if (seen.has(att.id)) continue;
        seen.add(att.id);
        out.push({ ...att, forwardedSnapshotIndex: snapshotIndex });
      }
    }
  }
  return out;
}

function lookUpFailure(channelId: string, err: unknown): null | { kind: 'uncertain' } {
  const status = (err as { status?: unknown } | null)?.status;
  const code = (err as { code?: unknown } | null)?.code;
  const refused = code === UNKNOWN_CHANNEL || code === MISSING_ACCESS || code === INVALID_FORM_BODY
    || status === 403 || status === 404;
  dbg('lookUpServedChannel:failed', { channelId, refused, error: err instanceof Error ? err.message : String(err) });
  return refused ? null : { kind: 'uncertain' };
}

export function isListedKind(type: DiscordChannelInfo['type']): boolean {
  return type === 'text' || type === 'announcement' || type === 'voice' || type === 'stage';
}

export function holdsNoMessages(type: DiscordChannelInfo['type']): boolean {
  return type === 'category' || type === 'forum';
}

export function holdsPosts(type: ChannelType | undefined): boolean {
  return type === ChannelType.GuildForum || type === ChannelType.GuildMedia;
}

/** discord.js returns no channel for an id Discord answered for when it has
 *  no class for the channel's type, or when the channel's server isn't in
 *  its cache. In discord.js 14.26.5, READY puts every server the bot is in
 *  into that cache, unavailable ones included, and GUILD_CREATE adds one it
 *  joins later, so a server is missing only until the gateway delivers it,
 *  or once the bot has left it. */
function channelUnusable(channelId: string, nothing: string): Error {
  return new Error(
    `Channel ${channelId} exists, but this adapter can't use it, so ${nothing}. Either it's a kind of channel ` +
      "this version of the adapter can't handle, which only an operator updating the adapter can change, or its " +
      'server is still loading on this connection, in which case the same call may work in a moment.',
  );
}

function unhandledKind(channelId: string, nothing: string): Error {
  return new Error(
    `Channel ${channelId} exists, but it's a kind of channel this version of the adapter can't handle, so ${nothing}. ` +
      'Only an operator updating the adapter can change that.',
  );
}

const HOLDS_NO_MESSAGES: Record<number, string> = {
  4: 'a category',
  14: 'a directory channel',
  15: 'a forum',
  16: 'a media channel',
};

function noMessagesHere(channel: { type: number; guildId?: string | null }, channelId: string, nothing: string): Error {
  const kind = HOLDS_NO_MESSAGES[channel.type];
  if (!kind) {
    return new Error(
      `Channel ${channelId} is a kind of channel (type ${channel.type}) that this adapter can't read or send to, so ${nothing}. ` +
        'Only an operator updating the adapter can change that.',
    );
  }
  const after = holdsPosts(channel.type)
    ? " Its posts are threads, and no tool here lists them, so a post's id comes only from a message posted in it or a link to it. " +
      "A post's messages are written through that id, and read through it where the configured channel filters allow."
    : channel.type === 4
      ? ` The channels in it that the configured channel filters allow are the ones list_channels for server ${channel.guildId} shows with ${channelId} as their parent.`
      : ' It lists servers, and nothing here can read it or send to it.';
  return new Error(`Channel ${channelId} is ${kind}, which holds no messages, so ${nothing}.${after}`);
}

export function mapChannelType(type: number | undefined): DiscordChannelInfo['type'] {
  switch (type) {
    case ChannelType.GuildText: return 'text';
    case ChannelType.GuildVoice: return 'voice';
    case ChannelType.GuildCategory: return 'category';
    case ChannelType.GuildAnnouncement: return 'announcement';
    case ChannelType.AnnouncementThread:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread: return 'thread';
    case ChannelType.GuildStageVoice: return 'stage';
    case ChannelType.GuildForum: return 'forum';
    case ChannelType.GuildMedia:
    default: return 'unknown';
  }
}
