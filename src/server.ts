import type * as net from 'node:net';
import { createHash } from 'node:crypto';
import {
  McplConnection,
  textContent,
  method,
  ERR_FEATURE_SET_NOT_ENABLED,
  ERR_UNKNOWN_FEATURE_SET,
  ERR_UNKNOWN_CHANNEL,
  ERR_CHANNEL_OPEN_FAILED,
  ERR_CHECKPOINT_NOT_FOUND,
} from '@animalabs/mcpl-core';
import { formatAgentDateTime, resolveAgentTimeZone, resolveTimestampStyle } from './timezone.js';

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McplCapabilities,
  McplInitializeParams,
  McplInitializeResult,
  InitializeCapabilities,
  FeatureSetsUpdateParams,
  PushEventParams,
  PushEventResult,
  ChannelsRegisterParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  ChannelsListResult,
  StateRollbackParams,
  StateRollbackResult,
  ChannelDescriptor,
  ContentBlock,
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
} from '@animalabs/mcpl-core';

import type { ChannelFacts, DiscordAdapter, DiscordMessageData, DiscordAttachment, HistoryMessage, OutgoingFile, ReactionSummary, MessageEventInfo, DmRefusal, DmSendFailure, MentionsField, PostedParts, ThreadPlace } from './discord-adapter.js';
import { LATEST_FROM_WINDOW, attachmentUrlExpiry, holdsNoMessages, isListedKind, kindOfValue } from './discord-adapter.js';
import { DM_NOTICE_TEXT, DmNoticeState, resolveDmNoticesPath, type DmNoticeDecision } from './dm-notices.js';

const LATEST_FROM_EXCERPT = 80;
import type { ChatInputCommandInteraction } from 'discord.js';
import { agentJson, errorValue, headerValue, labelValue, mediaTypeValue, nameValue, quotedLabel, quotedValue, renderSourceHeader, senderText, urlValue } from './source-header.js';
import { ApplicationCommandOptionType, MessageFlags } from 'discord.js';
import {
  boundedReply,
  controlOutcomeUnknown,
  describeCancel,
  describeMarkers,
  describeRetract,
  hostCount,
  describeHideMarks,
  HIDE_MARKS_NOT_ADDED,
  HIDE_MARKS_OPTION,
  hideMarksAt,
  hostRefusal,
  isCancelReceipt,
  isRetractReceipt,
  isView,
  MARKS_OPTION,
  PROBE_AGAIN,
  readHiddenRefs,
  readMarksChoice,
  renderEntry,
  renderListPage,
  summarizeControl,
  summarizeMarkers,
  surgeryOutcomeUnknown,
  unreadable,
  unreadableControl,
  unreadableSurgery,
  type BoundedReply,
  type HiddenRef,
} from './awareness-marks.js';
import { toolDefinitions } from './tools.js';
import { withToolClasses } from './tool-classes.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import {
  ChannelManager,
  INVALID_PARAMS,
  RequestRefusal,
  channelLabelFor,
  dmLabel,
  typeName,
  mcplChannelId,
  parseMcplChannelId,
  resolveOpenTarget,
  toDescriptor,
  toDmDescriptor,
} from './channels.js';
import {
  channelLabel,
  isNameAddressableKind,
  isSnowflake,
  looksLikeExplicitName,
  parseChannelRef,
  type AddressingPath,
} from './channel-names.js';
import { UNKNOWN_CHANNEL, explainDiscordError, type ExplainContext } from './discord-errors.js';
import { saveFiltersFile, loadFiltersFile, DiscordFiltersState, type DiscordFilters } from './filters.js';
import { StateTracker } from './state.js';
import { existsSync, readFileSync } from 'node:fs';
import { isId, isJsonObject, readJsonFile, usableIds, writeJsonFile, type Usable } from './persisted-json.js';
import sharp from 'sharp';
import { dbg } from './debug-log.js';
import {
  advertisedRetryWindowMs,
  answerClass,
  errorRejection,
  isAuthorityRefusal,
  incomingOutcome,
  isContentRejection,
  pushOutcome,
  summarizeAttachments,
  withoutInlineMedia,
  type ForwardOutcome,
} from './incoming-results.js';

// TypeScript copies the manifest into dist. The module-relative path works
// in both source and built layouts, independently of the working directory.
const packageJson: typeof import('../package.json') = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const INSPECTION_TOOLS: ReadonlySet<string> = new Set(['fetch_history', 'fetch_around']);

export const ID_ARGUMENTS: readonly string[] = [
  'channelId', 'messageId', 'userId', 'guildId', 'categoryId', 'before', 'after', 'latestFrom',
  'addGuilds', 'removeGuilds', 'setDmUsers',
];

const holdsNumber = (value: unknown): boolean =>
  typeof value === 'number' || (Array.isArray(value) && value.some((item) => typeof item === 'number'));

const listed = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('');

const withMentions = <T extends object>(result: T, report: MentionsField | undefined): T | (T & MentionsField) =>
  report ? { ...result, ...report } : result;

type ChannelOpenRequest = ChannelsOpenParams & {
  channelId?: string;
  history?: { limit: number; beforeMessageId?: string; sinceLastSeen?: boolean };
};

type ChannelOpenResponse = ChannelsOpenResult & {
  history?: ChannelsIncomingParams['messages'];
  historyTruncated?: boolean;
};

interface ChannelRefresh {
  visible: number;
  added: Array<{ id: string; label: string }>;
  note: string;
}

interface ChannelAcknowledgeRequest {
  channelId: string;
  messageId: string;
  intent: string;
  value?: string;
}

function errorText(err: unknown): string {
  try {
    const carried = (err as { message?: unknown } | null | undefined)?.message;
    return typeof carried === 'string' && carried !== '' ? carried : String(err);
  } catch {
    return `[an unprintable ${typeof err}]`;
  }
}

function lastVisibleLines(lastVisible: unknown, ifAbsent?: string): string[] {
  if (!isJsonObject(lastVisible)) return ifAbsent ? [ifAbsent] : [];
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const who = text(lastVisible.participant) ?? text(lastVisible.role) ?? '?';
  const preview = lastVisible.preview;
  if (typeof preview === 'string' && preview !== '') {
    return [`Last message now visible to the agent — **${who}**:`, `> ${preview.replace(/\n/g, '\n> ')}`];
  }
  return [
    `Last message now visible to the agent — **${who}**: ` +
      (preview === undefined || preview === null || preview === '' ? '*(empty message)*' : "*(a preview this server can't read)*"),
  ];
}

function messagePlace(channelName: string | null | undefined, thread: ThreadPlace): { channel: string | null; thread: string | null } {
  return thread.threadId
    ? { channel: thread.threadParentName ?? null, thread: thread.threadName ?? thread.threadId }
    : { channel: channelName ?? null, thread: null };
}

/** No MCPL threadId: that names a thread within a channel, and a Discord
 *  thread is its own channel, already named by the channel id. */
function threadFields(thread: ThreadPlace): { threadName?: string; threadParentName?: string } {
  if (!thread.threadId) return {};
  return {
    ...(thread.threadName ? { threadName: thread.threadName } : {}),
    ...(thread.threadParentName ? { threadParentName: thread.threadParentName } : {}),
  };
}

function addressFlags(
  facts: { mentions: string[]; mentionsBotRole?: boolean; replyToUserId?: string | null },
  botId: string | null,
): { isExplicitMention: boolean; isReplyToBot: boolean; isMention: boolean } {
  const isExplicitMention = (botId !== null && facts.mentions.includes(botId)) || facts.mentionsBotRole === true;
  // Discord's "ping replied user" toggle controls only whether the bot
  // appears in mentions; the reply itself is addressed to the bot either way.
  const isReplyToBot = botId !== null && facts.replyToUserId === botId;
  return { isExplicitMention, isReplyToBot, isMention: isExplicitMention || isReplyToBot };
}

/** MCPL RFC-001 address tags, umbrellas included, so a host needs no
 *  implication expansion. The host's wake gate routes on these. */
function addressTags(flags: { isExplicitMention: boolean; isReplyToBot: boolean; isMention: boolean }, isDM: boolean, isBot: boolean): string[] {
  const tags: string[] = [];
  if (flags.isExplicitMention) tags.push('chat:mention');
  if (flags.isReplyToBot) tags.push('chat:reply');
  if (isDM) tags.push('chat:dm', 'chat:private');
  tags.push(flags.isMention || isDM ? 'chat:addressed' : 'chat:ambient');
  tags.push(isBot ? 'chat:from-bot' : 'chat:from-human');
  return tags;
}

/** The place tag every lane gives a message posted in a thread: `chat:thread`
 *  (the host documents it as "Occurred in a thread"). */
function threadTags(thread: ThreadPlace): string[] {
  return thread.threadId ? ['chat:thread'] : [];
}

function knowsLessThan(d: ChannelDescriptor, known: ChannelDescriptor): boolean {
  const names = (x: ChannelDescriptor) => (x.metadata ?? {}) as { channelName?: string; guildName?: string; parentName?: string };
  const now = names(d);
  const then = names(known);
  return (['channelName', 'guildName', 'parentName'] as const).some((k) => then[k] !== undefined && now[k] === undefined);
}

type GuildDelivery = { id: string; registered: true } | { id: string | undefined; registered: false };

interface SavedTally {
  anchorId: string;
  talliedThrough?: string;
  messages: number;
  characters: number;
}

interface SavedWatermarks {
  watermarks?: Record<string, string>;
  dmChannels?: string[];
  missed?: Record<string, SavedTally>;
  owed?: Record<string, OwedMessage[]>;
}

interface OwedMessage {
  id: string;
  uncertain?: true;
  edit?: true;
  tries?: number;
}
const OWED_PER_CHANNEL_MAX = 50;
const OWED_DELIVERY_TRIES = 3;
const OWED_RETRY_COOLDOWN_MS = 5 * 60_000;

function usableWatermarks(value: unknown): Usable<SavedWatermarks> {
  if (!isJsonObject(value)) return { value: null, unusable: 'not an object' };
  let others = 0;
  const out: SavedWatermarks = {};
  for (const [key, entries] of Object.entries(value)) {
    if (key === 'watermarks' && isJsonObject(entries)) {
      out.watermarks = {};
      for (const [channel, id] of Object.entries(entries)) {
        if (isId(channel) && isId(id)) out.watermarks[channel] = id;
        else others++;
      }
    } else if (key === 'dmChannels' && Array.isArray(entries)) {
      out.dmChannels = entries.filter(isId);
      others += entries.length - out.dmChannels.length;
    } else if (key === 'missed' && isJsonObject(entries)) {
      out.missed = {};
      for (const [channel, tally] of Object.entries(entries)) {
        if (
          isId(channel) &&
          isJsonObject(tally) &&
          typeof tally.anchorId === 'string' &&
          (tally.talliedThrough === undefined || typeof tally.talliedThrough === 'string') &&
          Number.isFinite(tally.messages) &&
          Number.isFinite(tally.characters)
        ) {
          const { anchorId, talliedThrough, messages, characters, ...extra } = tally;
          out.missed[channel] = {
            anchorId,
            ...(talliedThrough === undefined ? {} : { talliedThrough }),
            messages,
            characters,
          } as SavedTally;
          others += Object.keys(extra).length;
        } else {
          others++;
        }
      }
    } else if (key === 'owed' && isJsonObject(entries)) {
      out.owed = {};
      for (const [channel, list] of Object.entries(entries)) {
        if (!isId(channel) || !Array.isArray(list)) { others++; continue; }
        const usable: OwedMessage[] = [];
        for (const item of list) {
          if (isJsonObject(item) && isId(item.id)
            && (item.uncertain === undefined || item.uncertain === true)
            && (item.edit === undefined || item.edit === true)
            && (item.tries === undefined || (Number.isInteger(item.tries) && (item.tries as number) >= 0))) {
            usable.push({
              id: item.id as string,
              ...(item.uncertain ? { uncertain: true as const } : {}),
              ...(item.edit ? { edit: true as const } : {}),
              ...(item.tries ? { tries: item.tries as number } : {}),
            });
          } else {
            others++;
          }
        }
        if (usable.length > 0) out.owed[channel] = usable;
      }
    } else {
      others++;
    }
  }
  return { value: out, unusable: others ? `${others} ${others === 1 ? 'entry' : 'entries'} the store doesn't write` : null };
}

const unsavedNote = (store: string, failure: string | null): string =>
  failure ? ` The ${store} couldn't be saved (${failure}), so as it stands now it wouldn't survive a restart.` : '';

function fellShort(value: unknown): string {
  return value === undefined || value === null
    ? ', and this call gave none'
    : typeof value === 'string'
      ? ', and this call gave it blank'
      : ` as a string, and this call gave ${kindOfValue(value)}`;
}

function channelIdRequired(tool: string, value: unknown, nothing = 'Nothing was done'): Error {
  return new Error(
    `${nothing}: ${tool} needs channelId${fellShort(value)}. Give the channel's id in quotes, such as ` +
      '"123456789012345678", or, for a text, announcement, voice or stage channel, its #name. list_channels with ' +
      "guildId, a server's id from list_guilds, lists the channels there that the configured filters allow, with " +
      'their ids.',
  );
}

function requiredChannelId(tool: string, value: unknown, nothing?: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw channelIdRequired(tool, value, nothing);
}

function requiredUserId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(
    `Nothing was sent: send_dm needs userId${fellShort(value)}. Give the recipient's id in quotes, such as ` +
      '"123456789012345678", or their name: @username or display name.',
  );
}

function messageContent(tool: string, value: unknown): string {
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'string') return value;
  throw new Error(
    `Nothing was sent: ${tool} takes content as a string, and this call gave ${kindOfValue(value)}. Give the message's ` +
      'text in quotes, or, to send only files, leave content out and give files.',
  );
}

function requireContentOrFiles(content: string, files: OutgoingFile[] | undefined): void {
  if ((!content || !content.trim()) && (!files || files.length === 0)) {
    throw new Error('Nothing was sent: the message is empty. Give it "content", "files", or both.');
  }
}

/** Whether a request's error is Discord refusing it: a 4xx, an answer
 *  Discord gave after evaluating the request. Anything else leaves open
 *  whether the request took effect: a 5xx, a timeout or a lost connection
 *  doesn't show whether Discord acted on it, and the REST client sends it
 *  again after a 5xx, a timeout or a reset connection, up to three times.
 *  No 429 reaches here: the REST client waits one out and sends again. */
function refusedByDiscord(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const REST_QUOTED = 40;
function restBegins(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= REST_QUOTED) return text;
  const head = chars.slice(0, REST_QUOTED);
  let cut = REST_QUOTED;
  for (let i = REST_QUOTED - 1; i >= REST_QUOTED / 2; i--) {
    if (/\s/.test(head[i])) {
      cut = i;
      break;
    }
  }
  return head.slice(0, cut).join('');
}

function postedPartsNote(p: PostedParts, refused: boolean, history: boolean): string {
  const k = p.ids.length;
  const tell = 'someone who can see the channel can tell';
  if (p.of === 1) {
    if (refused) return '';
    return "Whether this message posted is unknown, since Discord didn't answer it with a refusal. " + (history
      ? "Calling again could post it a second time, so check the channel's latest messages (fetch_history) before " +
        'sending again.'
      : `That can't be checked from here: sending it again risks a second copy, and not sending it risks it missing; ${tell}.`);
  }
  const parts = (n: number) => `first${n === 1 ? '' : ` ${n}`} of the ${p.of} parts this message was split into`;
  if (k === 0 && refused) return `Discord refused the ${parts(1)}, so none of it posted.`;
  const rest = (part: string) => `rest${p.files ? ', files included,' : ''} begins with ${quotedValue(restBegins(part))}`;
  const after = p.next ? `the ${rest(p.next)}` : 'the whole message posted';
  const again = `Calling again with the whole message could post ${k <= 1 ? 'the first part' : `those ${k} parts`} a second time`;
  const asSent = 'Quoted words are from the text as sent, where a mention reads <@id>, or <@&id> for a role.';
  const nothingAfter = p.next ? '; nothing after it posted' : '';
  if (refused) {
    const carriedFiles = p.files && k === p.of - 1;
    return `The ${parts(k)} posted before this failure: ${p.ids.join(', ')}. Discord refused the next part, so the rest ` +
      `didn't post. The ${rest(p.failed)}. ${asSent} ${again}${carriedFiles ? '.' : ', so when you send again, send only the rest.'}`;
  }
  if (k === 0) {
    return `Whether the ${parts(1)} posted is unknown, since Discord didn't answer it with a refusal${nothingAfter}. ` +
      `If it didn't post, nothing did; if it did, ${after}. ${asSent} ` + (history
        ? `${again}, so check the channel's latest messages (fetch_history) before sending again.`
        : "Whether the first part posted can't be checked from here: sending the whole message again could post it " +
          `twice, and sending from the part after it could leave it out; ${tell}.`);
  }
  return `The ${parts(k)} posted before this failure: ${p.ids.join(', ')}. Whether the next part posted is unknown, since ` +
    `Discord didn't answer it with a refusal${nothingAfter}. If it didn't post, the ${rest(p.failed)}; if it ` +
    `did, ${after}. ${asSent} ${again}` +
    (history
      ? ", so send only the rest, once the channel's latest messages (fetch_history) show whether the next part posted."
      : ". Whether the next part posted can't be checked from here: " + (p.next
        ? 'sending the rest from that part could post it twice, and sending from the one after it could leave it out'
        : 'sending it again could post it twice, and not sending it could leave it out') + `; ${tell}.`);
}

/** ChapterX-style Discord bots send `m continue` as a no-op trigger to wake
 *  their model and delete the message at once, but messageCreate fires before
 *  the delete propagates, so the message would otherwise be delivered. */
const CHX_NOOP_PREFIX = 'm continue';

const CLOSED_CHANNEL_NOTE =
  "<system>While this channel isn't open, a message from it reaches you as it's posted when it mentions you or the " +
  'role Discord created for you, or replies to one of your messages. Opening it brings its other messages as they ' +
  'arrive.</system>\n';

const AGENT_TIME_ZONE = resolveAgentTimeZone();
const AGENT_TIMESTAMP_STYLE = resolveTimestampStyle();

/** Anthropic downscales an image whose long edge is over 1568 px or whose
 *  cost would be over 1568 visual tokens (2576 px and 4784 tokens on Claude 4.7
 *  and later models). */
const IMAGE_LONG_EDGE_MAX = 1568;
const IMAGE_JPEG_QUALITY = 85;
/** Anthropic accepts up to 5 MB of base64 per image on Amazon Bedrock and
 *  10 MB on its own API; base64 adds a third, so this raw cap stays under the
 *  smaller limit. */
const IMAGE_OUTPUT_RAW_CAP = 3.5 * 1024 * 1024;
/** sharp's own pixel limit, not this cap, guards the decoded bitmap against
 *  decompression bombs. */
const IMAGE_FETCH_CEILING = 25 * 1024 * 1024;

const MAX_TEXT_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_ATTACHMENT_INLINE_MAX_BYTES = 5120;

interface NormalizedImage {
  data: string;
  mimeType: string;
}

async function normalizeImageForInference(
  buf: Buffer,
  declaredCt: string | null,
): Promise<NormalizedImage | null> {
  try {
    const meta = await sharp(buf, { animated: true }).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const isAnimated = (meta.pages ?? 1) > 1;
    // The pass-through fast paths below may only emit formats the model API
    // accepts. sharp also reads SVG, TIFF, AVIF and HEIF, which fall through to
    // the re-encode.
    const API_SAFE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);
    const apiSafe = API_SAFE_FORMATS.has(meta.format ?? '');

    if (isAnimated) {
      return apiSafe && buf.length <= IMAGE_OUTPUT_RAW_CAP
        ? { data: buf.toString('base64'), mimeType: `image/${meta.format}` }
        : null;
    }

    if (apiSafe && longest > 0 && longest <= IMAGE_LONG_EDGE_MAX && buf.length <= IMAGE_OUTPUT_RAW_CAP) {
      return { data: buf.toString('base64'), mimeType: `image/${meta.format}` };
    }

    // resize() with withoutEnlargement is a no-op when the image is already within bounds but over the byte cap.
    const resizeOpts = { width: IMAGE_LONG_EDGE_MAX, height: IMAGE_LONG_EDGE_MAX, fit: 'inside' as const, withoutEnlargement: true };
    const base = () => sharp(buf).resize(resizeOpts);

    let out: Buffer;
    let mimeType: string;
    if (meta.hasAlpha) {
      out = await base().png({ compressionLevel: 9 }).toBuffer();
      mimeType = 'image/png';
    } else {
      out = await base().jpeg({ quality: IMAGE_JPEG_QUALITY }).toBuffer();
      mimeType = 'image/jpeg';
    }

    if (out.length > IMAGE_OUTPUT_RAW_CAP) {
      out = await sharp(buf)
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 70 })
        .toBuffer();
      mimeType = 'image/jpeg';
      if (out.length > IMAGE_OUTPUT_RAW_CAP) return null;
    }

    return { data: out.toString('base64'), mimeType };
  } catch {
    return null;
  }
}

interface CreateMemory {
  settled: Promise<void>;
  resolve: () => void;
  done: boolean;
  /** Coalescing scope the create used (RFC-006): a channel id, or null for feature-set scope. */
  scope?: string | null;
  render?: { prefix: string; replyMarker: string; location: string; authorName: string; attachments: ContentBlock[] };
  edits: number;
}
const RECENT_CREATES_MAX = 512;
/** RFC-006 §3.1's retry window for a host that advertises event coalescing
 *  without one: an hour. */
const DEFAULT_RETRY_WINDOW_MS = 3_600_000;
const DELETED_CHANNELS_KEPT = 1000;
const RECENT_CREATE_ATTACHMENT_BYTES = 64 * 1024;

function rememberedAttachments(blocks: ContentBlock[]): ContentBlock[] {
  if (Buffer.byteLength(JSON.stringify(blocks)) <= RECENT_CREATE_ATTACHMENT_BYTES) return blocks;
  return [textContent('[attachments as in the original message]')];
}

/** RFC-006 `coalesce` member, which mcpl-core's PushEventParams doesn't type. */
interface CoalesceMember {
  key: string;
  channelId?: string;
  retract?: boolean;
  initial?: boolean;
}
type CoalescedPushEventParams = PushEventParams & { coalesce?: CoalesceMember };
type CoalescedIncomingMessage = ChannelsIncomingParams['messages'][number] & { eventId?: string; coalesce?: CoalesceMember };

/** Normalize the host's `eventCoalescing` advertisement (RFC-006 §10). */
export function parseHostCoalescing(
  advertised: unknown,
): { pushEvents: boolean; channelsIncoming: boolean; channelScopedPush: boolean } | null {
  if (advertised === true) return { pushEvents: true, channelsIncoming: true, channelScopedPush: true };
  if (!advertised || typeof advertised !== 'object') return null;
  const o = advertised as Record<string, unknown>;
  return {
    pushEvents: o.pushEvents === true,
    channelsIncoming: o.channelsIncoming === true,
    channelScopedPush: o.channelScopedPush === true,
  };
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export class DiscordMcplServer {
  private conn: McplConnection | null = null;

  private subscribedChannels = new Set<string>();
  private subscriptionsLoaded = false;

  private reactionChannels = new Set<string>();
  private reactionChannelsLoaded = false;
  private reactionChannelsUnsaved = false;

  /** Resolved when the connection's first featureSets/update has been
   *  processed: the signal that the §5.3 policy is settled, so pushes land
   *  inside the granted window. */
  private policyAnswered: Promise<void>;
  private resolvePolicyAnswered!: () => void;
  private policyGateUsed = false;
  private policyGraceMs = 20_000;

  readonly filtersState = new DiscordFiltersState();

  private mutedChannels = new Set<string>();
  private mutedLoaded = false;
  private mutedUnsaved = false;

  private forwardedWatermark = new Map<string, string>();
  private readonly owed = new Map<string, OwedMessage[]>();
  /** discord.js can't enumerate past DM channels, so the reconnect sweep needs
   *  a remembered list of the DMs to scan again. */
  private dmChannelIds = new Set<string>();
  private missedTally = new Map<
    string,
    { anchorId: string; talliedThrough: string; messages: number; characters: number }
  >();
  private watermarkLoaded = false;
  private watermarkSaveFailure: string | null = null;
  private sweepDone = false;

  private get catchupLimit(): number {
    const raw = process.env.DISCORD_CATCHUP_LIMIT;
    if (!raw) return 3000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 3000;
  }

  private get backscrollLimit(): number {
    const raw = process.env.DISCORD_BACKSCROLL_LIMIT;
    if (!raw) return 80;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 80;
  }

  private inlineCapWarnedFor?: string;
  private get attachmentInlineMaxBytes(): number {
    const raw = process.env.DISCORD_ATTACHMENT_INLINE_MAX_BYTES;
    if (!raw) return DEFAULT_ATTACHMENT_INLINE_MAX_BYTES;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      if (this.inlineCapWarnedFor !== raw) {
        this.inlineCapWarnedFor = raw;
        console.error(
          `[discord-mcpl] DISCORD_ATTACHMENT_INLINE_MAX_BYTES=${JSON.stringify(raw)} is not a non-negative integer — using default ${DEFAULT_ATTACHMENT_INLINE_MAX_BYTES}`,
        );
      }
      return DEFAULT_ATTACHMENT_INLINE_MAX_BYTES;
    }
    return Math.min(n, MAX_TEXT_BYTES);
  }

  private get backscrollChannelLimits(): Map<string, number> {
    const out = new Map<string, number>();
    const raw = process.env.DISCORD_BACKSCROLL_CHANNELS;
    if (!raw) return out;
    for (const part of raw.split(',')) {
      const [id, nStr] = part.trim().split(':');
      const n = parseInt(nStr ?? '', 10);
      if (id && Number.isFinite(n) && n >= 0 && n <= 10000) out.set(id, n);
    }
    return out;
  }

  private backscrollLimitFor(channelId: string): number {
    return this.backscrollChannelLimits.get(channelId) ?? this.backscrollLimit;
  }

  private capHistoryLimit(channelId: string, requested: number): number {
    const cap = this.backscrollChannelLimits.get(channelId);
    return cap === undefined ? requested : Math.min(requested, cap);
  }

  private lastChannelId: string | null = null;
  private lastInboundMessageId: string | null = null;
  private sentInCurrentTurn = false;

  private get stickyReplyEnabled(): boolean {
    const raw = process.env.DISCORD_STICKY_REPLY;
    if (raw === undefined) return true;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  }
  private mcplEnabled = false;
  private hostCoalescing: { pushEvents: boolean; channelsIncoming: boolean; channelScopedPush: boolean } | null = null;
  private readonly recentCreates = new Map<string, CreateMemory>();
  private editSeq = 0;
  private retryDelaysMs: readonly number[] = [1_000, 5_000, 30_000];
  private reconnectWaitMs = 60_000;
  private hostRetryWindowMs: number | undefined;
  private readyConn: McplConnection | null = null;
  private readonly readyWaiters = new Set<() => void>();
  private waitingForHost = 0;
  private maxWaitingForHost = 64;
  private mutationSeq = 0;
  private readonly mutationsInFlight = new Map<string, { latest: number; unsettled: number }>();
  private enabledFeatureSets = new Set<string>();
  private channelManager = new ChannelManager();
  private unannouncedRemovals = new Set<string>();
  /** Snowflakes aren't reused, so an id here stays deleted. */
  private deletedChannels = new Set<string>();
  private stateTracker = new StateTracker();

  constructor(
    private discord: DiscordAdapter,
    /** Voice output (MCPL SPEC 14.3 consumer). Null: voice isn't configured,
     *  so the handshake declares no channels.streaming. */
    private voice: import('./voice.js').VoiceOutput | null = null,
  ) {
    this.policyAnswered = new Promise((resolve) => {
      this.resolvePolicyAnswered = resolve;
    });
    this.voice?.onReport((r) => this.handleVoiceReport(r));
  }

  private handleVoiceReport(r: import('./voice.js').UtteranceReport): void {
    if (!this.conn || !this.mcplEnabled) return;
    if (r.status === 'spoken' && r.unvoicedText.length === 0) return;
    const interrupted = r.status === 'interrupted';
    const expired = r.status === 'expired';
    const failed = r.status === 'failed';
    const secs = (r.playedMs / 1000).toFixed(1);
    const who = r.interruptedBy
      ? `@${r.interruptedBy.username ? nameValue(r.interruptedBy.username) : r.interruptedBy.userId}${r.interruptedBy.bot ? ' (bot)' : ''}`
      : null;
    const tail = r.voicedText.length > 120 ? `…${r.voicedText.slice(-120)}` : r.voicedText;
    const head = r.unvoicedText.length > 400 ? `${r.unvoicedText.slice(0, 400)}…` : r.unvoicedText;
    const approx = r.estimated ? ' (boundary approximate)' : '';
    const rest = r.restUnvoiced ? '\nWhat you went on to say in that reply wasn\'t voiced either.' : '';
    const line = expired
      ? `[voice] Your spoken message waited ${(r.queuedMs / 1000).toFixed(0)}s for the channel to clear and was dropped UNSPOKEN — nothing was heard (and nothing was billed).\n` +
        `Not said: "${head}"\n(The text was still delivered in the text channel as usual. Say it again — possibly shorter — only if it still needs saying.)`
      : interrupted
        ? `[voice] Your spoken message was interrupted by ${who} after ${secs}s${approx}.\n` +
          `Heard up to: "${tail}"\nNOT heard: "${head}"` + rest
        : failed
          ?
            (r.playedMs > 0
              ? `[voice] Your spoken message was stopped after ${secs}s${approx} (${r.failure ?? 'playback failed'}).\n`
              : `[voice] Your spoken message couldn't be played (${r.failure ?? 'playback failed'}) — nothing was heard.\n`) +
            (r.playedMs > 0 && tail ? `Heard up to: "${tail}"\n` : '') +
            (head ? `NOT heard: "${head}"\n` : '') +
            (rest ? `${rest.slice(1)}\n` : '') +
            '(The text was still delivered in the text channel as usual.)'
        : `[voice] Your spoken message was cut short by a synthesis error after ${secs}s${approx}.\n` +
          `Heard up to: "${tail}"\nNOT heard: "${head}"\n(The text was still delivered in the text channel as usual.)`;
    this.conn.sendRequest(method.PUSH_EVENT, {
      featureSet: 'discord.messaging',
      eventId: `discord_voice_${r.status}_${r.inferenceId}`,
      timestamp: new Date().toISOString(),
      origin: {
        source: 'discord',
        mcplChannelId: r.channelId,
        inferenceId: r.inferenceId,
        playedMs: r.playedMs,
        queuedMs: r.queuedMs,
        billedChars: r.billedChars,
        estimated: r.estimated,
        ...(r.interruptedBy ? {
          interruptedById: r.interruptedBy.userId,
          interruptedByName: r.interruptedBy.username,
          interruptedByBot: r.interruptedBy.bot,
        } : {}),
      } as Record<string, unknown>,
      // RFC-001 tags: hosts route and gate on these.
      tags: [expired ? 'voice:expired' : interrupted ? 'voice:interrupted' : failed ? 'voice:failed' : 'voice:truncated'],
      payload: { content: [textContent(line)] },
    } satisfies PushEventParams).catch(() => {});
  }

  async setupSlashCommands(): Promise<void> {
    this.discord.onSlashCommand((interaction) => {
      // Not awaited, and on Node ≥ 15 an unhandled rejection ends the process.
      // Discord refuses a late reply ("Unknown interaction" once its 3-second
      // acknowledgment window has passed).
      void this.handleSlashCommand(interaction).catch((err) => {
        console.error(
          `[discord-mcpl] /${interaction.commandName} failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    });
    await this.discord.registerGuildCommands([
      {
        name: 'undo',
        description: "Undo the agent's last turn(s) — admin only",
        options: [
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'messages',
            description: 'Number of context messages to remove (any participant; default 1)',
            required: false,
            min_value: 1,
            max_value: 50,
          },
          MARKS_OPTION,
        ],
      },
      {
        name: 'hide',
        description: 'Remove a message (or range) from the agent context by link — admin only',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'message',
            description: 'Message link (or ID) to remove',
            required: true,
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'to',
            description: 'End of range: a second message link/ID (inclusive)',
            required: false,
          },
          HIDE_MARKS_OPTION,
        ],
      },
      {
        name: 'marks',
        description: "The host's 💤 awareness marks: list, cancel or retract — admin only",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'action',
            description: 'What to do',
            required: true,
            choices: [
              { name: 'list', value: 'list' },
              { name: 'cancel', value: 'cancel' },
              { name: 'retract', value: 'retract' },
            ],
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'target',
            description: 'A batch or retract id (list: show it in full); retract also takes "all"',
            required: false,
          },
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'page',
            description: 'list: which page of the ledger (newest first; default 1)',
            required: false,
            min_value: 1,
          },
        ],
      },
      {
        name: 'nudge',
        description: 'Run the agent on its current context — no new events — admin only',
      },
      {
        name: 'unstick',
        description: 'Rewind blocked turns and re-run until the model stops refusing — admin only',
        options: [
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'max',
            description: 'Max rewind/retry attempts (default 3)',
            required: false,
            min_value: 1,
            max_value: 10,
          },
        ],
      },
    ]);
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== 'undo' &&
      interaction.commandName !== 'hide' &&
      interaction.commandName !== 'unstick' &&
      interaction.commandName !== 'nudge' &&
      interaction.commandName !== 'marks'
    ) {
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const admins = (process.env.DISCORD_ADMIN_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!admins.includes(interaction.user.id)) {
      dbg('slash:unauthorized', { command: interaction.commandName, userId: interaction.user.id });
      await interaction.reply({ content: `Not authorized to use /${interaction.commandName}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'hide') {
      await this.handleHideCommand(interaction);
      return;
    }

    if (interaction.commandName === 'unstick') {
      await this.handleUnstickCommand(interaction);
      return;
    }

    if (interaction.commandName === 'nudge') {
      await this.handleNudgeCommand(interaction);
      return;
    }

    if (interaction.commandName === 'marks') {
      await this.handleMarksCommand(interaction);
      return;
    }

    const messages = interaction.options.getInteger('messages') ?? 1;
    const marks = readMarksChoice(interaction);
    const marksChosen = marks === 'addressed' || marks === 'all';
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot undo.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:undo', { messages, marks, userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply();

    // A host whose undo can't take a marks choice places 💤 marks that follow
    // branches, re-applied on every switch, with no frozen audience and no
    // cancel, so such a host is refused outright.
    const support = await this.hostMarksSupport(conn);
    if (support !== true) {
      await this.acknowledge(interaction, boundedReply(support === false
        ? "⚠️ Undo refused: this host can't make awareness marks a choice — its undo places 💤 marks that " +
          'follow branches. Upgrade the host (an agent framework with the `marks` host command) to undo from Discord.'
        : `⚠️ Undo not sent: couldn't learn whether this host makes awareness marks a choice (${support.reason}). ` +
          `Nothing was changed. ${PROBE_AGAIN}`));
      return;
    }

    let result: unknown;
    try {
      result = await conn.sendRequest(
        'host/command',
        {
          command: 'undo',
          messages,
          ...(marks ? { marks } : {}),
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      );
    } catch (err) {
      dbg('slash:undo-failed', { error: errorText(err) });
      await this.acknowledge(
        interaction,
        boundedReply(surgeryOutcomeUnknown('Undo', marksChosen, errorText(err))),
        surgeryOutcomeUnknown('Undo', marksChosen),
      );
      return;
    }

    const answer: Record<string, unknown> = isJsonObject(result) ? result : {};
    if (answer.ok === false) {
      await this.acknowledge(interaction, boundedReply(hostRefusal('Undo', answer), answer));
      return;
    }
    if (answer.ok !== true) {
      await this.acknowledge(
        interaction,
        boundedReply(unreadableSurgery('undo', result, marksChosen), result),
        surgeryOutcomeUnknown('Undo', marksChosen),
      );
      return;
    }

    const removed = hostCount(answer.messagesRemoved);
    const lines = [
      removed === undefined
        ? '🗑️ Undo applied (branched; old branch preserved); the number of context messages removed was not given.'
        : `🗑️ Removed the last **${removed}** context message${removed === 1 ? '' : 's'} (branched; old branch preserved).`,
      describeMarkers(answer.markers),
      ...lastVisibleLines(answer.lastVisible, '(Could not render the post-undo context preview.)'),
    ];
    await this.acknowledge(
      interaction,
      boundedReply(lines.join('\n'), result),
      `🗑️ Undo applied: ${removed === undefined ? 'the number of context messages removed was not given' : `removed ${removed} context message${removed === 1 ? '' : 's'}`}. ` +
        summarizeMarkers(answer.markers),
    );
  }

  private async acknowledge(
    interaction: ChatInputCommandInteraction,
    reply: BoundedReply,
    outcome?: string,
  ): Promise<void> {
    try {
      await interaction.editReply(reply);
    } catch (err) {
      dbg('slash:reply-failed', { error: errorText(err) });
      try {
        await interaction.editReply(boundedReply(
          `${outcome ? `${outcome} ` : ''}(The full reply couldn't be shown: ${errorText(err)}.)`,
        ));
      } catch (again) {
        console.error(
          `[discord-mcpl] /${interaction.commandName}: Discord refused its reply twice (${errorText(again)})` +
            (outcome ? `, so the operator wasn't told: ${outcome}` : '.'),
        );
      }
    }
  }

  /**
   * agent-framework answers a host command it lacks with "Unknown host command"
   * (at every revision checked, from 2ea26ffea, where host/command arrived, to
   * #250's 915ad4be); a host with the `marks` verb answers anything else
   * (agent-framework#250 refuses the missing action).
   */
  private async hostMarksSupport(conn: McplConnection): Promise<boolean | { reason: string }> {
    let answer: unknown;
    try {
      answer = await conn.sendRequest('host/command', { command: 'marks' }, 15000);
    } catch (err) {
      return { reason: errorText(err) };
    }
    const error = isJsonObject(answer) && typeof answer.error === 'string' ? answer.error : '';
    const supported = !/unknown host command/i.test(error);
    dbg('slash:marks-support', { supported });
    return supported;
  }

  private async handleMarksCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = interaction.options.getString('action', true);
    const target = interaction.options.getString('target')?.trim() || undefined;
    const page = interaction.options.getInteger('page') ?? 1;
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action !== 'list' && !target) {
      await interaction.reply({
        content: action === 'retract'
          ? '`/marks action:retract` needs a target: a batch id, or `all`.'
          : '`/marks action:cancel` needs a target: a batch id or a retract request id.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    dbg('slash:marks', { action, target, userId: interaction.user.id });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const support = await this.hostMarksSupport(conn);
    if (support !== true) {
      await this.acknowledge(interaction, boundedReply(support === false
        ? "This host doesn't have awareness-mark controls (no `marks` host command). Upgrade the host to use `/marks`."
        : `Couldn't learn whether this host has awareness-mark controls (${support.reason}). Nothing was sent. ${PROBE_AGAIN}`));
      return;
    }
    let result: unknown;
    try {
      result = await conn.sendRequest(
        'host/command',
        {
          command: 'marks',
          action,
          ...(target && action !== 'list' ? { target } : {}),
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      );
    } catch (err) {
      dbg('slash:marks-failed', { action, error: errorText(err) });
      if (action === 'list') {
        await this.acknowledge(interaction, boundedReply(`⚠️ /marks action:list failed: ${errorText(err)}`));
      } else {
        await this.acknowledge(
          interaction,
          boundedReply(controlOutcomeUnknown(action, target, errorText(err))),
          controlOutcomeUnknown(action, target),
        );
      }
      return;
    }
    const response: Record<string, unknown> = isJsonObject(result) ? result : {};
    if (response.ok === false) {
      await this.acknowledge(interaction, boundedReply(hostRefusal(`/marks action:${action}`, response), response));
      return;
    }
    if (response.ok !== true) {
      if (action === 'list') {
        await this.acknowledge(interaction, boundedReply(unreadable('/marks action:list', result), result));
      } else {
        await this.acknowledge(
          interaction,
          boundedReply(unreadableControl(action, target, result), result),
          controlOutcomeUnknown(action, target),
        );
      }
      return;
    }
    const whole = response.awareness === undefined;
    const answer = whole ? result : response.awareness;
    if (action === 'list') {
      const views = Array.isArray(answer) && answer.every(isView) ? answer : null;
      if (!views) {
        await this.acknowledge(interaction, boundedReply(unreadable(whole ? '/marks action:list' : 'the ledger', answer), answer));
        return;
      }
      if (target) {
        const shown = views.filter((v) => v.id === target);
        await this.acknowledge(interaction, boundedReply(renderEntry(views, target), shown.length ? shown : undefined));
        return;
      }
      await this.acknowledge(interaction, renderListPage(views, page));
      return;
    }
    const text = action === 'cancel' && isCancelReceipt(answer)
      ? describeCancel(answer)
      : action === 'retract' && isRetractReceipt(answer)
        ? describeRetract(answer)
        : unreadable(`/marks action:${action}`, answer);
    await this.acknowledge(interaction, boundedReply(text, answer), summarizeControl(action, target, answer));
  }

  /**
   * Parse a Discord message link or raw ID into a message id.
   * Accepts:
   *   https://discord.com/channels/<guild>/<channel>/<messageId>
   *   <channel>-<messageId>  (the "Copy ID" with shift on some clients)
   *   a bare 17–20 digit snowflake
   */
  private parseMessageRef(input: string): string | null {
    const s = input.trim();
    const link = s.match(/channels\/\d+\/\d+\/(\d+)/);
    if (link) return link[1];
    const dashed = s.match(/^\d+-(\d+)$/);
    if (dashed) return dashed[1];
    if (/^\d{17,20}$/.test(s)) return s;
    return null;
  }

  private async handleHideCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const fromRaw = interaction.options.getString('message', true);
    const toRaw = interaction.options.getString('to');
    const fromMessageId = this.parseMessageRef(fromRaw);
    if (!fromMessageId) {
      await interaction.reply({
        content: `Could not parse a message link/ID from \`${fromRaw}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    let toMessageId: string | undefined;
    if (toRaw) {
      const parsed = this.parseMessageRef(toRaw);
      if (!parsed) {
        await interaction.reply({ content: `Could not parse \`${toRaw}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      toMessageId = parsed;
    }

    // A hide's 💤 is this server's own: the host places none for a hide and
    // refuses a choice there, so the request carries none, on any host.
    const marking = readMarksChoice(interaction) === 'all';
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot hide.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:hide', { fromMessageId, toMessageId, marking, userId: interaction.user.id });
    await interaction.deferReply();

    let result: unknown;
    try {
      result = await conn.sendRequest(
        'host/command',
        {
          command: 'hide',
          fromMessageId,
          toMessageId,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      );
    } catch (err) {
      dbg('slash:hide-failed', { error: errorText(err) });
      await this.acknowledge(
        interaction,
        boundedReply(surgeryOutcomeUnknown('Hide', false, errorText(err)) + (marking ? `\n${HIDE_MARKS_NOT_ADDED}` : '')),
        surgeryOutcomeUnknown('Hide', false) + (marking ? ` ${HIDE_MARKS_NOT_ADDED}` : ''),
      );
      return;
    }

    const answer: Record<string, unknown> = isJsonObject(result) ? result : {};
    if (answer.ok === false) {
      await this.acknowledge(interaction, boundedReply(hostRefusal('Hide', answer), answer));
      return;
    }
    if (answer.ok !== true) {
      await this.acknowledge(
        interaction,
        boundedReply(unreadableSurgery('hide', result, false, marking ? HIDE_MARKS_NOT_ADDED : undefined), result),
        surgeryOutcomeUnknown('Hide', false) + (marking ? ` ${HIDE_MARKS_NOT_ADDED}` : ''),
      );
      return;
    }

    const n = hostCount(answer.hidden);
    const reply = (marks: string | undefined): string => [
      n === undefined
        ? "🙈 Hide applied (redacted in place); the number of messages removed from the agent's context was not given."
        : `🙈 Removed **${n}** message${n === 1 ? '' : 's'} from the agent's context (redacted in place).`,
      ...(marks ? [marks] : []),
      ...lastVisibleLines(answer.lastVisible),
    ].join('\n');
    const short = (marks: string | undefined): string =>
      `🙈 Hide applied: ${n === undefined ? 'the number of messages removed was not given' : `removed ${n} message${n === 1 ? '' : 's'} from the agent's context`}.` +
        (marks ? ` ${marks}` : '');
    const refs = marking ? readHiddenRefs(answer.hiddenRefs) : undefined;
    const first = refs === undefined ? undefined : hideMarksAt(refs);
    await this.acknowledge(interaction, boundedReply(reply(first), result), short(first));
    if (!Array.isArray(refs) || refs.length === 0) return;
    const marks = await this.markHidden(refs);
    await this.acknowledge(interaction, boundedReply(reply(marks), result), short(marks));
  }

  /**
   * discord.js's REST queue sends one channel's reaction requests one at a
   * time, within Discord's limits. A request that failed may still have
   * landed, so only what Discord confirmed is counted.
   */
  private async markHidden(refs: HiddenRef[]): Promise<string> {
    let confirmed = 0;
    let firstError: string | undefined;
    await Promise.all(refs.map(async (ref) => {
      const parsed = parseMcplChannelId(ref.channelId);
      try {
        await this.discord.addReaction(parsed ? parsed.channelId : ref.channelId, ref.messageId, '💤');
        confirmed++;
      } catch (err) {
        firstError ??= errorText(err);
        dbg('slash:hide-react-failed', { messageId: ref.messageId, error: errorText(err) });
      }
    }));
    return describeHideMarks(confirmed, refs.length, firstError);
  }

  /**
   * The host only acknowledges /unstick here, and posts the outcome to this
   * channel when the chain resolves.
   */
  private async handleUnstickCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const max = interaction.options.getInteger('max') ?? undefined;
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot unstick.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:unstick', { max, userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply();

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'unstick',
          maxRewinds: max,
          channelId: interaction.channelId,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as { ok?: boolean; error?: string; started?: boolean; cap?: number };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Unstick failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      await interaction.editReply(
        `🔧 Unsticking the agent — rewinding blocked turn(s) and re-running ` +
          `(up to **${result.cap ?? max ?? 3}**). I'll post the result here.`,
      );
    } catch (err) {
      dbg('slash:unstick-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Unstick failed: ${(err as Error).message}`);
    }
  }

  private async handleNudgeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot nudge.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:nudge', { userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'nudge',
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as { ok?: boolean; error?: string; agentStatus?: string };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Nudge failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      const when = result.agentStatus === 'idle'
        ? 'running now'
        : `queued behind the current turn (agent is ${result.agentStatus ?? 'busy'})`;
      await interaction.editReply(
        `👉 Nudged — the agent takes a turn on its current context, no new events (${when}).`,
      );
    } catch (err) {
      dbg('slash:nudge-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Nudge failed: ${(err as Error).message}`);
    }
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    this.readyConn = null;
    if (this.policyGateUsed) {
      this.policyAnswered = new Promise((resolve) => { this.resolvePolicyAnswered = resolve; });
    }
    this.policyGateUsed = true;

    // The connection emits 'error' for a line that isn't JSON, for a
    // listener's throw, and once for the stream error that closes it. With no
    // listener, EventEmitter throws it from the stream's own callback, where
    // nothing here can catch it, and the process exits. Logged instead, so a
    // bad line costs only itself and the loop reads on.
    const onConnectionError = (err: unknown) => {
      console.error('[discord-mcpl] Connection error:', errorText(err));
      dbg('connection:error', { error: errorText(err) });
    };
    conn.on('error', onConnectionError);

    const rs = this.filtersState.suppressionStatus();
    if (rs.status === 'not-configured') {
      console.error(
        '[discord-mcpl] reaction-suppression: not configured (no suppressedReactionEmojis in the filters file, ' +
          'no DISCORD_SUPPRESS_REACTION_EMOJIS) — reaction suppression NOT active',
      );
    } else if (rs.status === 'configured-empty') {
      console.error(
        '[discord-mcpl] reaction-suppression: suppressedReactionEmojis is present but EMPTY — mechanism wired, NO reactions suppressed',
      );
    } else if (rs.source === 'legacy-env') {
      console.error(
        `[discord-mcpl] reaction-suppression: running on DEPRECATED DISCORD_SUPPRESS_REACTION_EMOJIS (${rs.effectiveCount} entries, ` +
          'process-static — changing it needs a restart) — move the entries into the filters file suppressedReactionEmojis key ' +
          'and unset the env (alias retires per issue #16)',
      );
    } else if (rs.source === 'baseline-default') {
      console.error(
        `[discord-mcpl] reaction-suppression: host-injected protective baseline in force (${rs.effectiveCount} entries, ` +
          'no operator configuration present) — an explicit suppressedReactionEmojis key in the filters file overrides it',
      );
    } else if (rs.status === 'unavailable') {
      console.error(
        '[discord-mcpl] reaction-suppression: filters file is configured but unreadable and no usable set was ever loaded — ' +
          'ALL model-visible reactions are withheld until the file is repaired',
      );
    }

    this.setupDiscordForwarding();

    try {
      await this.handleInitialize();

      // Nothing may run between initialize and the main loop. A 0.5 host sends its
      // §5.3 initial policy as a featureSets/update request right after
      // initialize, with a 15 s timeout, and rejects this server's own requests
      // (-32002) until its policy is established. So channel registration and the
      // sweep run concurrently with the loop, gated on the policy being answered
      // (a 20 s grace covers pre-0.5 hosts that never send it), registration
      // before the sweep, so pushes land on registered channels inside the
      // granted window.
      void (async () => {
        await Promise.race([
          this.policyAnswered,
          // unref: a pending grace timer must never hold the process open.
          new Promise((r) => {
            const t = setTimeout(r, this.policyGraceMs);
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
        if (this.conn !== conn) return;
        if (this.mcplEnabled) {
          try {
            await this.syncChannelsWithHost();
          } catch (err) {
            console.error('[discord-mcpl] Channel registration failed:', errorText(err));
          }
        }
        this.markReady(conn);
        void this.deliverOwed(conn).catch((err) => {
          console.error('[discord-mcpl] Delivering owed messages failed:', errorText(err));
        });
        try {
          await this.runReconnectSweep();
        } catch (err) {
          console.error('[discord-mcpl] Reconnect catch-up sweep failed:', errorText(err));
        }
      })().catch((err) => {
        // Nothing above should reach here; if anything does, an unhandled
        // rejection would end the process.
        console.error('[discord-mcpl] Background start-up work failed:', errorText(err));
      });

      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          try {
            await this.handleRequest(msg.request);
          } catch (err) {
            console.error(`[discord-mcpl] request ${msg.request.method} was not answered:`, err);
            dbg('handleRequest:unanswered', { method: msg.request.method, error: errorText(err) });
          }
        } else {
          try {
            this.handleNotification(msg.notification);
          } catch (err) {
            console.error(
              `[discord-mcpl] notification ${msg.notification.method} failed:`,
              err,
            );
            dbg('handleNotification:error', {
              method: msg.notification.method,
              error: errorText(err),
              stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined,
            });
          }
        }
      }
    } catch (err) {
      // stderr, like every log line here: on the stdio transport, stdout is
      // the protocol channel, and a line there that isn't JSON is an error
      // to the host.
      if ((err as { name?: unknown } | null | undefined)?.name === 'ConnectionClosedError') {
        console.error('[discord-mcpl] Client disconnected');
      } else {
        console.error('[discord-mcpl] Connection error:', err);
      }
    } finally {
      this.conn = null;
      this.readyConn = null;
      conn.close();
    }
  }

  /** MCP lets a client ping before initialize, so a ping is answered. */
  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;

    let msg = await conn.nextMessage();
    while (msg.type !== 'request' || msg.request.method !== 'initialize') {
      if (msg.type === 'notification') {
        console.error(`[discord-mcpl] ${msg.notification.method} before initialize: dropped`);
      } else if (msg.request.method === 'ping') {
        conn.sendResponse(msg.request.id, {});
      } else {
        console.error(`[discord-mcpl] ${msg.request.method} before initialize: refused`);
        conn.sendError(msg.request.id, -32002, `Server not initialized: send initialize before ${msg.request.method}`);
      }
      msg = await conn.nextMessage();
    }

    const params = msg.request.params as McplInitializeParams | undefined;

    const clientMcpl = params?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = clientMcpl !== undefined;
    this.hostCoalescing = parseHostCoalescing((clientMcpl as { eventCoalescing?: unknown } | undefined)?.eventCoalescing);
    this.hostRetryWindowMs = advertisedRetryWindowMs((clientMcpl as { eventCoalescing?: unknown } | undefined)?.eventCoalescing);
    dbg('handleInitialize', {
      mcplEnabled: this.mcplEnabled,
      clientName: params?.clientInfo?.name,
      clientMcpl: clientMcpl ? 'present' : 'absent',
    });

    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      // MCPL's object form (McplChannelCapabilities) when voice is enabled:
      // `streaming: true` opts this server into the host's routed outgoing deltas
      // (channels/outgoing/chunk, SPEC 14.3). Without voice, the legacy boolean:
      // the host then streams nothing here. mcpl-core's type lags the spec's
      // object form, hence the cast.
      channels: (this.voice ? { register: true, publish: true, streaming: true } : true) as unknown as boolean,
      rollback: true,
      // The legacy array form on the wire (feature-sets.ts).
      featureSets: featureSets as unknown as McplCapabilities['featureSets'],
      // No contextHooks.afterInference: agent-framework routes a plain-text reply
      // itself, publishing text-only turns to the locus via channels/publish.
    };

    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && {
        experimental: { mcpl: serverCaps },
      }),
    };

    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'discord-mcpl', version: packageJson.version },
    };

    if (this.mcplEnabled) {
      for (const fs of featureSets) {
        this.enabledFeatureSets.add(fs.name);
      }
    }

    conn.sendResponse(msg.request.id, result);
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'ping': {
          // MCP: the receiver answers a ping promptly, with an empty result.
          conn.sendResponse(req.id, {});
          break;
        }

        case 'tools/list': {
          // Each tool carries its MCPL RFC-008 classes in _meta["mcpl/class"].
          conn.sendResponse(req.id, { tools: toolDefinitions.map(withToolClasses) });
          break;
        }

        case 'tools/call': {
          const result = await this.handleToolCall(
            params.name as string,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_LIST: {
          const result: ChannelsListResult = {
            channels: this.channelManager.getAll(),
          };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_OPEN: {
          const openP = params as unknown as ChannelOpenRequest;
          const result = await this.handleChannelOpen(openP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_CLOSE: {
          const closeP = params as unknown as ChannelsCloseParams;
          const result = this.handleChannelClose(closeP);
          conn.sendResponse(req.id, result);
          break;
        }

        case 'channels/acknowledge': {
          const ack = params as unknown as ChannelAcknowledgeRequest;
          const result = await this.handleChannelAcknowledge(ack);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_PUBLISH: {
          const pubP = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pubP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.STATE_ROLLBACK: {
          const rollbackP = params as unknown as StateRollbackParams;
          const result = await this.handleRollback(rollbackP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.FEATURE_SETS_UPDATE: {
          // §5.3/§6.7's request form of a host's policy update, which awaits a
          // degradation receipt. Everything this server declares runs on plain tool and
          // channel machinery, so there's nothing to degrade.
          this.applyFeatureSetsUpdate(params as unknown as FeatureSetsUpdateParams);
          conn.sendResponse(req.id, { accepted: true });
          break;
        }

        case 'context/afterInference': {
          // An older host may still call afterInference, so it's answered as a no-op.
          // The literal wire string: mcpl-core's method map no longer has
          // method.CONTEXT_AFTER_INFERENCE.
          await this.handleAfterInference(params);
          conn.sendResponse(req.id, { featureSet: 'discord.messaging' });
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      if (err instanceof RequestRefusal) {
        console.error(`[discord-mcpl] ${req.method} refused (${err.code}): ${err.message}`);
        dbg('handleRequest:refused', { method: req.method, code: err.code, error: err.message });
        conn.sendError(req.id, err.code, err.message);
        return;
      }
      const e = err instanceof Error ? err : undefined;
      const message = errorText(err);
      const isToolsCall = req.method === 'tools/call';
      const toolName = isToolsCall
        ? ((req.params as Record<string, unknown>)?.name as string | undefined)
        : undefined;
      const toolArgs = isToolsCall
        ? ((req.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined)
        : undefined;
      console.error(
        `[discord-mcpl] handleRequest error: method=${req.method}`,
        toolName ? `tool=${toolName}` : '',
        e?.stack ?? message,
      );
      dbg('handleRequest:error', {
        method: req.method,
        tool: toolName,
        args: toolArgs
          ? Object.fromEntries(
              Object.entries(toolArgs).map(([k, v]) => [
                k,
                typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v,
              ]),
            )
          : undefined,
        error: message,
        errorName: e?.name,
        stack: e?.stack?.split('\n').slice(0, 8).join('\n'),
      });
      conn.sendError(req.id, -32603, message);
    }
  }

  private applyFeatureSetsUpdate(p: FeatureSetsUpdateParams): void {
    if (typeof p !== 'object' || p === null) {
      throw new Error('featureSets/update: params must be an object');
    }
    const names = (field: 'enabled' | 'disabled'): string[] => {
      const list: unknown = p[field];
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || !list.every((name) => typeof name === 'string')) {
        throw new Error(`featureSets/update: ${field} must be a list of feature-set names`);
      }
      return list;
    };
    const enabled = names('enabled');
    const disabled = names('disabled');
    for (const name of enabled) this.enabledFeatureSets.add(name);
    for (const name of disabled) this.enabledFeatureSets.delete(name);
    this.resolvePolicyAnswered();
  }

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        // §6.7's notification form: hosts before 0.5 send every policy update this
        // way, so it gets the same body as the request form.
        this.applyFeatureSetsUpdate(notif.params as FeatureSetsUpdateParams);
        break;
      }

      // SPEC 14.3: outgoing streaming is advisory, and the authoritative delivery
      // is channels/publish. Chunks feed voice synthesis, and complete finalizes
      // the utterance; nothing here sends text.
      case method.CHANNELS_OUTGOING_CHUNK: {
        const p = notif.params as ChannelsOutgoingChunkParams;
        this.voice?.handleChunk(p.inferenceId, p.channelId, p.delta);
        break;
      }

      case method.CHANNELS_OUTGOING_COMPLETE: {
        // SPEC §14.5: delivery is never a side effect of a lifecycle event, only of
        // channels/publish, so complete sends no text.
        const p = notif.params as ChannelsOutgoingCompleteParams;
        dbg('outgoing/complete:finalized', { inferenceId: p.inferenceId, channelId: p.channelId });
        this.voice?.handleComplete(p.inferenceId);
        break;
      }

      case 'channels/typing':
      case 'notifications/typing': {
        const p = notif.params as { channelId?: string; op?: 'start' | 'stop' };
        // Discord has no explicit "stop typing" — the indicator auto-expires a
        // few seconds after the last trigger. So we act only on 'start' (and a
        // missing op counts as start); 'stop' is a no-op.
        if (p.channelId && p.op !== 'stop') {
          const parsed = parseMcplChannelId(p.channelId);
          if (parsed) {
            this.discord.sendTyping(parsed.channelId).catch(() => {});
          }
        }
        break;
      }

      case 'notifications/initialized':
        console.error('[discord-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
        break;

      default:
        break;
    }
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: unknown }> {
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !isEnabled(fs, this.enabledFeatureSets)) {
      return {
        content: [textContent(
          `${name} is turned off here: this host has disabled the "${fs}" feature set it belongs to, ` +
            "so the call didn't run, and calling it again won't change that. " +
            'If you need it, ask whoever runs this host.',
        )],
        isError: true,
      };
    }

    const declared = toolDefinitions.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
    const numbered = ID_ARGUMENTS.filter((key) => Object.hasOwn(declared, key) && holdsNumber(args[key]));
    if (numbered.length > 0) {
      return {
        content: [textContent(
          'Nothing was done: ids must be strings in quotes, since a number past 2^53 can lose its last digits. ' +
            `This call sent a number at ${listed(numbered)}, which arrived as ` +
            `${listed(numbered.map((key) => JSON.stringify(args[key])))}.`,
        )],
        isError: true,
      };
    }

    let explain: ExplainContext = {};
    if (typeof args.channelId === 'string' && args.channelId.trim()) {
      const given = args.channelId;
      const path: AddressingPath = isSnowflake(given.trim()) ? 'explicit-id' : 'name-resolved';
      const noResolver = typeof this.discord.resolveChannelRef !== 'function';
      if (path === 'name-resolved' && noResolver && looksLikeExplicitName(given)) {
        dbg('channel:resolver-unavailable', { tool: name, given });
        return {
          content: [textContent(
            `Cannot address a channel by name here: this adapter has no channel ` +
            `resolver, so "${given}" cannot be turned into a channel id. Pass the ` +
            `numeric channel id instead.`,
          )],
          isError: true,
        };
      }
      if (path === 'name-resolved' && !noResolver) {
        if (parseChannelRef(given)?.kind === 'name') await this.discord.refreshStale();
        const resolved = this.discord.resolveChannelRef(given);
        if (!resolved.ok) {
          dbg('channel:resolve-failed', { tool: name, given, reason: resolved.reason });
          return { content: [textContent(resolved.message)], isError: true };
        }
        dbg('channel:resolved', {
          tool: name,
          given,
          channelId: resolved.id,
          label: resolved.matched ? channelLabel(resolved.matched) : undefined,
        });
        args = { ...args, channelId: resolved.id };
        explain = { channelGiven: given };
      } else {
        dbg('channel:addressing', { tool: name, path, channelId: given });
      }
    }

    if (INSPECTION_TOOLS.has(name)) {
      if (typeof args.channelId !== 'string' || args.channelId.trim().length === 0) {
        return { content: [textContent(channelIdRequired(name, args.channelId, 'Nothing was read').message)], isError: true };
      }
      let refusal: string | null;
      try {
        refusal = await this.discord.inspectionRefusal(args.channelId);
      } catch (err) {
        return { content: [textContent(explainDiscordError(err, args, explain))], isError: true };
      }
      if (refusal) {
        dbg('channel:inspection-refused', { tool: name, channelId: args.channelId });
        return { content: [textContent(refusal)], isError: true };
      }
    }

    try {
      const result = await this.executeToolCall(name, args);

      if (fs === 'discord.messaging') {
        const cpId = this.stateTracker.createCheckpoint();
        return {
          content: [textContent(typeof result === 'string' ? result : agentJson(result))],
          state: { checkpoint: cpId },
        };
      }

      return {
        content: [textContent(typeof result === 'string' ? result : agentJson(result))],
      };
    } catch (err) {
      return {
        content: [textContent(explainDiscordError(err, args, explain))],
        isError: true,
      };
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'send_message': {
        const channelId = args.channelId as string;
        const content = messageContent(name, args.content);
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        let result: Awaited<ReturnType<DiscordAdapter['sendMessage']>>;
        try {
          result = await this.discord.sendMessage(channelId, content, { files });
        } catch (err) {
          throw await this.withAttemptedDestination(err, channelId);
        }
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        return withMentions(await this.augmentSendResult(result.messageId, channelId, shifted), result.report);
      }

      case 'reply_message': {
        const channelId = args.channelId as string;
        const content = messageContent(name, args.content);
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const { messageId: replyTo, target } = await this.resolveTargetMessage(channelId, args);
        let result: Awaited<ReturnType<DiscordAdapter['sendMessage']>>;
        try {
          result = await this.discord.sendMessage(
            channelId,
            content,
            { replyTo, files, ...(target ? { requireReplyTarget: true } : {}) },
          );
        } catch (err) {
          throw await this.withAttemptedDestination(err, channelId);
        }
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        const receipt = await this.augmentSendResult(result.messageId, channelId, shifted);
        return withMentions(target ? { ...receipt, target } : receipt, result.report);
      }

      case 'send_dm': {
        const userId = requiredUserId(args.userId);
        const content = messageContent(name, args.content);
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        let result: Awaited<ReturnType<DiscordAdapter['sendDM']>>;
        try {
          result = await this.discord.sendDM(
            userId,
            content,
            { files },
          );
        } catch (err) {
          const resolved = (err as DmSendFailure | null)?.dmChannel;
          if (resolved) throw await this.withAttemptedDestination(err, resolved.id, { recipientName: resolved.recipientName });
          if (err instanceof Error) {
            err.message += `\n\nAttempted destination: a DM with ${quotedValue(String(args.userId))}; no DM channel was resolved, so no message was sent.`;
          }
          throw err;
        }
        const shifted = this.markOutboundSend(result.channelId);
        return withMentions(
          await this.augmentSendResult(result.messageId, result.channelId, shifted, { recipientName: result.recipientName }),
          result.report,
        );
      }

      case 'add_reaction': {
        const channelId = args.channelId as string;
        const { messageId, target } = await this.resolveTargetMessage(channelId, args);
        await this.discord.addReaction(channelId, messageId, args.emoji as string);
        return target ? { result: 'Reaction added', target } : 'Reaction added';
      }

      case 'remove_reaction': {
        const channelId = args.channelId as string;
        const { messageId, target } = await this.resolveTargetMessage(channelId, args);
        await this.discord.removeReaction(channelId, messageId, args.emoji as string);
        return target ? { result: 'Reaction removed', target } : 'Reaction removed';
      }

      case 'edit_message':
        await this.discord.editMessage(
          args.channelId as string,
          args.messageId as string,
          args.content as string,
        );
        return 'Message edited';

      case 'delete_message':
        await this.discord.deleteMessage(
          args.channelId as string,
          args.messageId as string,
        );
        return 'Message deleted';

      case 'list_guilds':
        return await this.discord.listGuilds();

      case 'list_channels':
        return await this.discord.listChannels(args.guildId as string);

      case 'list_channel_members':
        return await this.discord.listChannelMembers(args.channelId as string);

      case 'list_emojis':
        return await this.discord.listEmojis(args.guildId as string | undefined);

      case 'set_reaction_visibility': {
        const channelId = requiredChannelId('set_reaction_visibility', args.channelId);
        this.ensureReactionChannelsLoaded();
        const visible = args.visible as boolean;
        const changed = visible !== this.reactionChannels.has(channelId);
        if (visible) this.reactionChannels.add(channelId);
        else this.reactionChannels.delete(channelId);
        const unsaved = changed || this.reactionChannelsUnsaved ? this.saveReactionChannels() : null;
        const note = unsavedNote('reaction channel list', unsaved);
        if (!visible) return `Reaction visibility OFF for channel ${channelId}.` + note;
        return (
          (this.isChannelMuted(channelId)
            ? `Reaction visibility ON for channel ${channelId}, but the channel is muted: its reactions reach you once unmute_channel lifts the mute (they never wake you).`
            : `Reaction visibility ON for channel ${channelId}. Reactions there now appear in your context as they happen (they never wake you).`) + note
        );
      }

      case 'refresh_channels':
        await this.discord.refreshStale();
        return this.refreshChannels();

      case 'fetch_history':
        return this.withProvenance(args.channelId as string, this.projectHistoryReactions(await this.discord.fetchHistory(
          args.channelId as string,
          {
            limit: this.capHistoryLimit(args.channelId as string, (args.limit as number) ?? 50),
            ...(args.before ? { before: args.before as string } : {}),
            ...(args.after ? { after: args.after as string } : {}),
          },
        )));

      case 'fetch_around':
        return this.withProvenance(args.channelId as string, this.projectHistoryReactions(await this.discord.fetchAround(
          args.channelId as string,
          args.messageId as string,
          this.capHistoryLimit(args.channelId as string, (args.limit as number) ?? 50),
        )));

      case 'create_text_channel':
        return await this.discord.createTextChannel(
          args.guildId as string,
          args.name as string,
          args.categoryId as string | undefined,
        );

      case 'delete_channel':
        await this.discord.deleteChannel(args.channelId as string);
        return 'Channel deleted';

      case 'subscribe_channel': {
        throw new Error(
          "Nothing was done: subscribe_channel is retired. Use the host's channel_open tool with the channel's id: " +
            'discord:<server id>:<channel id>, or discord:dm:<channel id> for a DM.',
        );
      }

      case 'unsubscribe_channel': {
        throw new Error(
          "Nothing was done: unsubscribe_channel is retired. Use the host's channel_close tool with the channel's id: " +
            'discord:<server id>:<channel id>, or discord:dm:<channel id> for a DM.',
        );
      }

      case 'mute_channel': {
        const channelId = requiredChannelId('mute_channel', args.channelId);
        this.ensureMutedLoaded();
        const wasNew = !this.mutedChannels.has(channelId);
        this.mutedChannels.add(channelId);
        const unsaved = wasNew || this.mutedUnsaved ? this.saveMuted() : null;
        this.ensureSubscriptionsLoaded();
        this.subscribedChannels.delete(channelId);
        this.ensureReactionChannelsLoaded();
        const reactionsUnsaved = this.reactionChannels.delete(channelId) ? this.saveReactionChannels() : null;
        for (const channel of this.channelManager.getOpen()) {
          if (parseMcplChannelId(channel.id)?.channelId === channelId) this.channelManager.close(channel.id);
        }
        return (
          (wasNew
            ? `Muted channel ${channelId}: no ambient, no wake on mention/reply, and it will not auto-subscribe you back in. Reverse with unmute_channel("${channelId}").`
            : `Channel ${channelId} was already muted.`) +
          unsavedNote('muted channel list', unsaved) +
          unsavedNote('reaction channel list', reactionsUnsaved)
        );
      }

      case 'unmute_channel': {
        const channelId = requiredChannelId('unmute_channel', args.channelId);
        this.ensureSubscriptionsLoaded();
        this.ensureMutedLoaded();
        const removed = this.mutedChannels.delete(channelId);
        const unsaved = removed || this.mutedUnsaved ? this.saveMuted() : null;
        const compositeId = this.channelManager.getAll()
          .find((channel) => parseMcplChannelId(channel.id)?.channelId === channelId)?.id;
        const target = compositeId ? `channelId "${compositeId}"` : 'its MCPL channel id';
        if (removed && compositeId && this.channelManager.isOpen(compositeId)) {
          this.subscribeRawChannel(channelId);
          return `Unmuted channel ${channelId}. It is open, so its traffic and direct addresses reach you again.` +
            unsavedNote('muted channel list', unsaved);
        }
        return (
          (removed
            ? `Unmuted channel ${channelId}. Direct addresses will reach you again. Ordinary traffic requires channel_open with ${target}. If the host still shows it as open, use channel_close then channel_open with the same id to reconcile.`
            : `Channel ${channelId} was not muted.`) + unsavedNote('muted channel list', unsaved)
        );
      }

      case 'list_subscriptions': {
        this.ensureSubscriptionsLoaded();
        this.ensureWatermarkLoaded();
        const missed = [...this.missedTally.entries()]
          .filter(([, t]) => t.messages > 0)
          .map(([channelId, t]) => ({
            ...this.resolveChannelMeta(channelId),
            missedMessages: t.messages,
            missedCharacters: t.characters,
          }))
          .sort((a, b) => b.missedCharacters - a.missedCharacters);
        return {
          channels: [...this.subscribedChannels].sort(),
          count: this.subscribedChannels.size,
          unsubscribedWithBacklog: missed,
          note:
            this.subscribedChannels.size === 0
              ? 'No ambient subscriptions. Mentions and DMs are always delivered.'
              : 'Ambient messages from these channels are delivered. Mentions and DMs always come through regardless.',
        };
      }

      case 'channel_missed': {
        const channelId = requiredChannelId('channel_missed', args.channelId, 'Nothing was read');
        this.ensureSubscriptionsLoaded();
        this.ensureWatermarkLoaded();
        if (this.isChannelMuted(channelId)) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: false,
            muted: true,
            note: `Muted: nothing posted in this channel is delivered to you as it's posted, mentions and replies included, until unmute_channel("${channelId}") lifts the mute. Opening it doesn't.`,
          };
        }
        if (this.subscribedChannels.has(channelId)) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: true,
            missedMessages: 0,
            missedCharacters: 0,
            note: 'Currently subscribed — ambient messages are being delivered, nothing is being missed.',
          };
        }
        const tally = this.missedTally.get(channelId);
        if (!tally) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: false,
            tracked: false,
            note: 'Not tracking this channel. A missed-ambient tally starts only after you unsubscribe from a channel you were subscribed to.',
          };
        }
        return {
          ...this.resolveChannelMeta(channelId),
          subscribed: false,
          tracked: true,
          missedMessages: tally.messages,
          missedCharacters: tally.characters,
          sinceMessageId: tally.anchorId || null,
          note:
            'Ambient messages (non-mention, non-DM) you have missed in this channel since you unsubscribed. ' +
            'Mentions and DMs were still delivered and are not counted. Counts cover the bot\'s online time plus ' +
            'an on-reconnect backfill of downtime gaps. Reopen with channel_open to start receiving these again.',
        };
      }

      case 'filters_get': {
        const f = this.discord.getFilters();
        const path = process.env.DISCORD_FILTERS_FILE;
        return {
          hotAdjustable: !!path,
          filtersFile: path ?? null,
          guildIds: f.guildIds ?? null,
          guildChannels: f.guildChannels ?? null,
          dmUsers: f.dmUsers ?? null,
          dmNotice: this.dmNoticeState().status(),
          plane: this.filtersState.planeStatus(),
          reactionSuppression: {
            ...this.filtersState.suppressionStatus(),
            writable: false,
            whyNotWritable:
              'Suppression entries are operator-maintained in the filters file until a host-level ' +
              'semantic-key facility lands; a referential update surface (suppress-by-key, no literal ' +
              'markers) arrives with it. The entries are never echoed here by design.',
            note:
              'Some reactions on your account are placed by the host, not by you — "me": true on a ' +
              'reaction is not evidence you authored it. A "stale" status means the last-known-good ' +
              'set is still enforced but only for this process lifetime; it does not survive a restart.',
          },
          note:
            'null = unrestricted. These filters gate which Discord events reach you; ' +
            'they are not Discord-side permissions — the bot must also be a member of a guild to see it.' +
            (path
              ? ''
              : ' Hot whitelist updates are disabled: set DISCORD_FILTERS_FILE in the environment (one restart) to enable ' +
                'them. filters_update setDmNotice works without it.'),
        };
      }

      case 'filters_update':
        return await this.filtersUpdate(args);

      default:
        throw new Error(`There's no Discord tool "${name}", so nothing ran. Call one of the Discord tools listed for you.`);
    }
  }

  private async resolveTargetMessage(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<{ messageId: string; target?: Record<string, unknown> }> {
    const selector = (value: unknown, name: string): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string') throw new Error(`${name} must be a string or null; nothing was done.`);
      return value;
    };
    const messageId = selector(args.messageId, 'messageId');
    const latestFrom = selector(args.latestFrom, 'latestFrom');
    if (messageId !== undefined && latestFrom !== undefined) {
      throw new Error('Give messageId or latestFrom, not both; nothing was done.');
    }
    if (messageId === undefined && latestFrom === undefined) {
      throw new Error('Give exactly one of messageId or latestFrom; nothing was done.');
    }
    if (messageId !== undefined) {
      if (!messageId.trim()) throw new Error('messageId is blank, so it names no message; nothing was done.');
      return { messageId: messageId.trim() };
    }
    if (!latestFrom!.trim()) throw new Error('latestFrom is blank, so it names no one; nothing was done.');
    const r = await this.discord.resolveLatestFrom(channelId, latestFrom!);
    if (!r.ok) throw new Error(r.message);
    const text = Array.from(r.message.cleanContent.replace(/\s+/g, ' ').trim());
    return {
      messageId: r.message.id,
      target: {
        messageId: r.message.id,
        author: { id: r.authorId, name: r.authorLabel },
        discordChannelId: channelId,
        timestamp: r.message.timestamp.toISOString(),
        excerpt: text.length > LATEST_FROM_EXCERPT ? `${text.slice(0, LATEST_FROM_EXCERPT - 1).join('')}…` : text.join(''),
        selectedBy:
          `latestFrom "${latestFrom}": their newest message among the ${LATEST_FROM_WINDOW} most recent ` +
          'in this channel when this call ran (not a claim about what you have seen)',
      },
    };
  }

  private async filtersUpdate(args: Record<string, unknown>): Promise<unknown> {
    if (args.setDmNotice != null && typeof args.setDmNotice !== 'boolean') {
      throw new Error('setDmNotice must be true or false. Nothing was changed.');
    }
    const shown = (value: unknown): string => JSON.stringify(value) ?? String(value);
    const ID = /^[^\s:+,]+$/;
    const id = (text: string): string | undefined => (ID.test(text.trim()) ? text.trim() : undefined);
    const entry = (text: string): { text: string; gid: string; channels?: string[] } | undefined => {
      const colon = text.indexOf(':');
      const gid = id(colon < 0 ? text : text.slice(0, colon));
      if (gid === undefined) return undefined;
      if (colon < 0) return { text, gid };
      const channels = text.slice(colon + 1).split('+').filter((part) => part.trim()).map(id);
      if (!channels.length || channels.includes(undefined)) return undefined;
      return { text, gid, channels: channels as string[] };
    };
    const listOf = <T>(key: string, what: string, read: (text: string) => T | undefined): T[] | undefined => {
      const value = args[key];
      if (value == null) return undefined;
      if (!Array.isArray(value)) {
        throw new Error(`${key} takes a list of ${what}, not ${shown(value)}. Nothing was changed.`);
      }
      return value.map((item) => {
        const parsed = typeof item === 'string' ? read(item) : undefined;
        if (parsed === undefined) {
          const why = typeof item === 'string' ? "isn't one" : "isn't a string";
          throw new Error(`${key} takes a list of ${what}, and ${shown(item)} ${why}. Nothing was changed.`);
        }
        return parsed;
      });
    };
    const ids = (kind: string) => `${kind} ids, each a string with no spaces, colons, commas or plus signs`;
    const addGuilds = listOf(
      'addGuilds',
      'entries, each a server id alone, for all its channels, or a server id with the channel ids to add ' +
        '("serverId:channelId+channelId")',
      entry,
    ) ?? [];
    const removeGuilds = listOf('removeGuilds', ids('server'), id) ?? [];
    const setDmUsers = listOf('setDmUsers', ids('user'), id);
    const setDmNotice = (args.setDmNotice ?? undefined) as boolean | undefined;
    const applyNotice = async (notes: string[]): Promise<void> => {
      if (setDmNotice === undefined) return;
      const unconfirmed = await this.dmNoticeState().setEnabled(setDmNotice);
      notes.push(
        setDmNotice
          ? 'Senders whose DMs the whitelist refuses will get the automatic delivery notice (at most once per 24 hours each).'
          : 'Refused DMs are now dropped without any notice to their senders. A notice already reserved and being sent still goes out.',
      );
      if (unconfirmed) notes.push(`The notice setting is in effect but not confirmed durable: ${unconfirmed}`);
    };
    const filterChange = addGuilds.length > 0 || removeGuilds.length > 0 || setDmUsers !== undefined;
    if (setDmNotice !== undefined && !filterChange) {
      const notes: string[] = [];
      await applyNotice(notes);
      return { applied: { dmNotice: this.dmNoticeState().status().enabled }, notes };
    }
    const path = process.env.DISCORD_FILTERS_FILE;
    if (!path) {
      throw new Error(
        'Hot filter updates are disabled: DISCORD_FILTERS_FILE is not set. ' +
          'Set it in the environment and restart once to enable.',
      );
    }
    if (!existsSync(path)) {
      throw new Error(
        `The filters file is MISSING on disk (${path}). Refusing to recreate it from process memory — ` +
          'an operator should restore the file (or restart to re-seed it); hot reload then applies it within seconds.',
      );
    }
    const current = loadFiltersFile(path);
    if (!current) {
      throw new Error(
        'The filters file exists but cannot be parsed. Refusing to overwrite it — ' +
          'an operator should repair the JSON (it hot-reloads, no restart needed), then retry this update.',
      );
    }
    const next: DiscordFilters = {
      guildIds: current.guildIds ? [...current.guildIds] : undefined,
      guildChannels: current.guildChannels
        ? Object.fromEntries(Object.entries(current.guildChannels).map(([g, c]) => [g, [...c]]))
        : undefined,
      dmUsers: current.dmUsers ? [...current.dmUsers] : undefined,
      suppressedReactionEmojis: current.suppressedReactionEmojis,
    };
    const notes: string[] = [];

    if ((addGuilds.length || removeGuilds.length) && !next.guildIds?.length) {
      next.guildIds = (await this.discord.listGuilds()).map((g) => g.id);
      notes.push(
        'Guild filter was unrestricted; materialized it as the list of all current guilds before applying your change.',
      );
    }
    for (const { text: entry, gid, channels: wanted } of addGuilds) {
      if (!next.guildIds!.includes(gid)) next.guildIds!.push(gid);
      if (wanted) {
        const existing = next.guildChannels?.[gid];
        if (existing) {
          (next.guildChannels ??= {})[gid] = [...new Set([...existing, ...wanted])];
        } else if (!current.guildIds?.includes(gid)) {
          (next.guildChannels ??= {})[gid] = wanted;
        } else {
          notes.push(
            `Guild ${gid} already allows all channels; the channel list on "${entry}" is a no-op.`,
          );
        }
      } else if (next.guildChannels?.[gid]) {
        delete next.guildChannels[gid];
        notes.push(`Guild ${gid}: channel restriction removed — all channels now allowed.`);
      }
    }
    for (const gid of removeGuilds) {
      next.guildIds = next.guildIds!.filter((g) => g !== gid);
      if (next.guildChannels) delete next.guildChannels[gid];
    }
    if (removeGuilds.length && !next.guildIds!.length) {
      throw new Error(
        `Removing ${removeGuilds.join(', ')} would leave no server listed, and an empty server list admits every ` +
          'server the bot is in. To narrow what you hear, keep another server listed: add one you want to hear ' +
          "(addGuilds) in the same call. With no other server to keep, this tool can't stop that one's events. " +
          'Nothing was changed.',
      );
    }

    if (setDmUsers !== undefined) {
      next.dmUsers = setDmUsers.length ? setDmUsers : undefined;
      if (!setDmUsers.length) notes.push('DM whitelist cleared — DMs from ANYONE are now delivered.');
    }

    saveFiltersFile(path, next);
    const diff = this.discord.updateFilters(next);
    this.filtersState.applyParsed(next);
    const refreshed = this.applyFilterChange(diff);
    console.error(
      `[discord-mcpl] filters updated via tool (guilds +${diff.addedGuilds.length}/-${diff.removedGuilds.length})`,
    );

    try {
      await applyNotice(notes);
    } catch (err) {
      notes.push(`The whitelist change was applied, but the notice setting was not: ${(err as Error).message}`);
    }

    const applied = this.discord.getFilters();
    if (diff.removedGuilds.length) {
      notes.push(
        'Removed guilds stop delivering events immediately, but their channels stay listed on the host until restart, under their ids.',
      );
    }
    return {
      applied: {
        guildIds: applied.guildIds ?? null,
        guildChannels: applied.guildChannels ?? null,
        dmUsers: applied.dmUsers ?? null,
        dmNotice: this.dmNoticeState().status().enabled,
      },
      guildsNowDelivering: diff.addedGuilds,
      guildsStoppedDelivering: diff.removedGuilds,
      newChannelsRegistered: refreshed?.added ?? [],
      notes,
    };
  }

  applyReloadedFilters(next: DiscordFilters): ReturnType<DiscordAdapter['updateFilters']> {
    const diff = this.discord.updateFilters(next);
    this.filtersState.applyParsed(next);
    this.applyFilterChange(diff);
    return diff;
  }

  private applyFilterChange(diff: { addedGuilds: string[] }): ChannelRefresh | null {
    const refreshed = diff.addedGuilds.length ? this.refreshChannels() : null;
    this.rederiveChannels(this.channelManager.getAll());
    return refreshed;
  }

  /** A send receipt says nothing about where later plain speech will go: the host owns that routing. */
  private async augmentSendResult(
    messageId: string,
    channelId: string,
    _shifted: boolean,
    dm?: { recipientName: string },
  ): Promise<{ messageId: string; channelId: string | null; discordChannelId: string; channelLabel: string | null }> {
    const p = this.channelProvenance(channelId, dm);
    return { messageId, channelId: p.channelId, discordChannelId: channelId, channelLabel: p.channelLabel };
  }

  private async withAttemptedDestination(err: unknown, discordChannelId: string, dm?: { recipientName: string }): Promise<unknown> {
    if (!(err instanceof Error)) return err;
    const p = this.channelProvenance(discordChannelId, dm);
    const where = p.channelId
      ? `${p.channelId}${p.channelLabel ? ` · ${labelValue(p.channelLabel)}` : ''} (Discord channel ${discordChannelId})`
      : `Discord channel ${discordChannelId}`;
    const posted = (err as { postedParts?: PostedParts }).postedParts;
    const refused = refusedByDiscord(err);
    const note = posted
      ? postedPartsNote(posted, refused, !refused && await this.historyReadable(discordChannelId))
      : '';
    const partly = note ? `\n\n${note}` : '';
    err.message = `${err.message}\n\nAttempted destination: ${where}.${partly}`;
    return err;
  }

  /** Without Read Message History, Discord answers a read of a channel's
   *  messages with none, which would read as nothing posted. */
  private async historyReadable(channelId: string): Promise<boolean> {
    if (this.mcplEnabled && !isEnabled(featureSetForTool('fetch_history')!, this.enabledFeatureSets)) return false;
    if (this.capHistoryLimit(channelId, 1) === 0) return false;
    try {
      return (await this.discord.inspectionRefusal(channelId)) === null && await this.discord.readsMessageHistory(channelId);
    } catch {
      return false;
    }
  }

  private channelProvenance(
    discordChannelId: string,
    dm?: { recipientName: string },
  ): { channelId: string | null; channelLabel: string | null; source: string } {
    let canonical: string | null;
    let fallbackLabel: string | null = null;
    const dmId = mcplChannelId('dm', discordChannelId);
    const isDM = dm !== undefined
      || this.channelManager.get(dmId) !== undefined
      || this.dmChannelIds.has(discordChannelId)
      || this.discord.getCachedChannelMeta?.(discordChannelId)?.isDM === true;
    if (isDM) {
      canonical = dmId;
      const recipient = dm?.recipientName
        ?? this.discord.getCachedDmRecipientName?.(discordChannelId)
        ?? ((this.channelManager.get(dmId)?.metadata as { recipientName?: string } | undefined)?.recipientName ?? null);
      if (recipient) fallbackLabel = dmLabel(recipient);
    } else {
      const meta = this.resolveChannelMeta(discordChannelId);
      canonical = meta.mcplChannelId;
      const facts = this.discord.getCachedChannelFacts?.(discordChannelId);
      if (facts) fallbackLabel = channelLabelFor(facts);
    }
    const label = (canonical ? this.channelManager.get(canonical)?.label : undefined) ?? fallbackLabel;
    const id = canonical ?? `discord:?:${discordChannelId}`;
    return {
      channelId: canonical,
      channelLabel: label ?? null,
      source: renderSourceHeader(id, label),
    };
  }

  private withProvenance<T extends object>(discordChannelId: string, items: T[]): Array<
    { source: string; channelId: string | null; channelLabel: string | null } & T
  > {
    const p = this.channelProvenance(discordChannelId);
    return items.map((item) => ({ source: p.source, channelId: p.channelId, channelLabel: p.channelLabel, ...item }));
  }


  private markOutboundSend(channelId: string): boolean {
    const prev = this.lastChannelId;
    const shifted = prev !== null && prev !== channelId;
    this.lastChannelId = channelId;
    this.lastInboundMessageId = null;
    this.sentInCurrentTurn = true;
    return shifted;
  }

  /** An older host may still call afterInference; it's answered as a no-op,
   *  since agent-framework now routes plain-text turns itself. */
  private async handleAfterInference(_params: unknown): Promise<void> {
    this.sentInCurrentTurn = false;
    dbg('afterInference:noop', { reason: 'sticky-retired-host-owns-routing' });
  }

  private subscriptionsFile(): string | undefined {
    const p = process.env.DISCORD_SUBSCRIPTIONS_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  private ensureSubscriptionsLoaded(): void {
    if (this.subscriptionsLoaded) return;
    this.subscriptionsLoaded = true;
    const path = this.subscriptionsFile();
    if (!path || !existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.length > 0 && !this.isChannelMuted(id)) this.subscribedChannels.add(id);
        }
      }
      dbg('subscriptions:loaded', { count: this.subscribedChannels.size, path });
    } catch (err) {
      console.error('[discord-mcpl] Failed to load subscriptions:', (err as Error).message);
      dbg('subscriptions:load-failed', { error: (err as Error).message, path });
    }
  }

  private isChannelSubscribed(channelId: string): boolean {
    this.ensureSubscriptionsLoaded();
    return this.subscribedChannels.has(channelId);
  }

  private reactionChannelsFile(): string | undefined {
    const p = process.env.DISCORD_REACTION_CHANNELS_FILE;
    if (p && p.length > 0) return p;
    const sub = this.subscriptionsFile();
    return sub ? sub.replace(/(\.json)?$/i, '.reactions.json') : undefined;
  }

  private ensureReactionChannelsLoaded(): void {
    if (this.reactionChannelsLoaded) return;
    this.reactionChannelsLoaded = true;
    const path = this.reactionChannelsFile();
    if (!path) return;
    const read = readJsonFile(path, 'reaction channels', usableIds, []);
    for (const id of read.value) this.reactionChannels.add(id);
    this.reactionChannelsUnsaved = !read.held;
    dbg('reaction-channels:loaded', { count: this.reactionChannels.size, path });
  }

  private saveReactionChannels(): string | null {
    const path = this.reactionChannelsFile();
    if (!path) return null;
    try {
      writeJsonFile(path, [...this.reactionChannels].sort());
      this.reactionChannelsUnsaved = false;
      return null;
    } catch (err) {
      this.reactionChannelsUnsaved = true;
      console.error('[discord-mcpl] Failed to save reaction channels:', (err as Error).message);
      dbg('reaction-channels:save-failed', { error: (err as Error).message, path });
      return (err as Error).message;
    }
  }

  private shouldEnterContext(
    channelId: string,
    opts: { isMention?: boolean; isDM?: boolean; guildId?: string | null } = {},
  ): boolean {
    if (this.isChannelMuted(channelId)) return false;
    return Boolean(opts.isMention)
      || Boolean(opts.isDM)
      || (opts.guildId != null && this.channelManager.isDiscordChannelOpen(opts.guildId, channelId))
      || this.isChannelSubscribed(channelId);
  }

  private mutedFile(): string | undefined {
    const explicit = process.env.DISCORD_MUTED_CHANNELS_FILE;
    if (explicit && explicit.length > 0) return explicit;
    const sub = this.subscriptionsFile();
    if (!sub) return undefined;
    return sub.replace(/\.json$/i, '') + '.muted.json';
  }

  private ensureMutedLoaded(): void {
    if (this.mutedLoaded) return;
    this.mutedLoaded = true;
    const path = this.mutedFile();
    if (!path) return;
    const read = readJsonFile(path, 'muted channels', usableIds, []);
    for (const id of read.value) this.mutedChannels.add(id);
    this.mutedUnsaved = !read.held;
    dbg('muted:loaded', { count: this.mutedChannels.size, path });
  }

  private saveMuted(): string | null {
    const path = this.mutedFile();
    if (!path) return null;
    try {
      writeJsonFile(path, [...this.mutedChannels].sort());
      this.mutedUnsaved = false;
      return null;
    } catch (err) {
      this.mutedUnsaved = true;
      console.error('[discord-mcpl] Failed to save muted channels:', (err as Error).message);
      dbg('muted:save-failed', { error: (err as Error).message, path });
      return (err as Error).message;
    }
  }

  private isChannelMuted(channelId: string): boolean {
    this.ensureMutedLoaded();
    return this.mutedChannels.has(channelId);
  }

  private watermarkFile(): string | undefined {
    const p = process.env.DISCORD_WATERMARK_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  private ensureWatermarkLoaded(): void {
    if (this.watermarkLoaded) return;
    this.watermarkLoaded = true;
    const path = this.watermarkFile();
    if (!path) return;
    const { value: saved } = readJsonFile(path, 'watermarks', usableWatermarks, {});
    for (const [chan, id] of Object.entries(saved.watermarks ?? {})) this.forwardedWatermark.set(chan, id);
    for (const id of saved.dmChannels ?? []) this.dmChannelIds.add(id);
    for (const [chan, list] of Object.entries(saved.owed ?? {})) {
      const byId = new Map<string, OwedMessage>();
      for (const item of list) {
        const known = byId.get(item.id);
        if (!known) { byId.set(item.id, { ...item }); continue; }
        if (item.uncertain) known.uncertain = true;
        if (!item.edit) delete known.edit;
        const tries = Math.max(known.tries ?? 0, item.tries ?? 0);
        if (tries > 0) known.tries = tries;
      }
      const kept = [...byId.values()].slice(-OWED_PER_CHANNEL_MAX);
      if (kept.length > 0) this.owed.set(chan, kept);
    }
    for (const [chan, tally] of Object.entries(saved.missed ?? {})) {
      this.missedTally.set(chan, {
        anchorId: tally.anchorId,
        talliedThrough: tally.talliedThrough ?? tally.anchorId,
        messages: tally.messages,
        characters: tally.characters,
      });
    }
    dbg('watermark:loaded', {
      channels: this.forwardedWatermark.size,
      dms: this.dmChannelIds.size,
      missed: this.missedTally.size,
      path,
    });
  }

  private saveWatermark(): void {
    const path = this.watermarkFile();
    if (!path) return;
    try {
      const out = {
        watermarks: Object.fromEntries(
          [...this.forwardedWatermark.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
        dmChannels: [...this.dmChannelIds].sort(),
        missed: Object.fromEntries(
          [...this.missedTally.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
        ...(this.owed.size > 0
          ? { owed: Object.fromEntries([...this.owed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) }
          : {}),
      };
      writeJsonFile(path, out);
      if (this.watermarkSaveFailure !== null) console.error('[discord-mcpl] Saved watermarks again.');
      this.watermarkSaveFailure = null;
    } catch (err) {
      const failure = (err as Error).message;
      if (failure !== this.watermarkSaveFailure) {
        console.error(
          '[discord-mcpl] Failed to save watermarks:',
          failure,
          '(logged again only if the reason changes; a later success is logged too)',
        );
      }
      this.watermarkSaveFailure = failure;
      dbg('watermark:save-failed', { error: failure, path });
    }
  }

  private resolveChannelMeta(channelId: string): {
    channelId: string;
    mcplChannelId: string | null;
    channelName: string | null;
    guildId: string | null;
    guildName: string | null;
    metadataResolved: boolean;
  } {
    if (this.dmChannelIds.has(channelId)) {
      const desc = this.channelManager.get(mcplChannelId('dm', channelId));
      const recipient =
        (desc?.metadata as { recipientName?: string } | undefined)?.recipientName ?? null;
      return {
        channelId,
        mcplChannelId: mcplChannelId('dm', channelId),
        channelName: recipient,
        guildId: null,
        guildName: null,
        metadataResolved: recipient !== null,
      };
    }
    const cached = this.discord.getCachedChannelMeta(channelId);
    if (cached?.guildId) {
      return {
        channelId,
        mcplChannelId: mcplChannelId(cached.guildId, channelId),
        channelName: cached.name,
        guildId: cached.guildId,
        guildName: cached.guildName,
        metadataResolved: cached.name !== null,
      };
    }
    for (const desc of this.channelManager.getAll()) {
      const addr = desc.address as { guildId?: string; channelId?: string } | undefined;
      if (addr?.channelId === channelId && addr.guildId && addr.guildId !== 'dm') {
        const names = desc.metadata as { channelName?: string; guildName?: string } | undefined;
        return {
          channelId,
          mcplChannelId: desc.id,
          channelName: names?.channelName ?? null,
          guildId: addr.guildId,
          guildName: names?.guildName ?? null,
          metadataResolved: names?.channelName !== undefined,
        };
      }
    }
    dbg('channel-meta:unresolved', { channelId });
    return {
      channelId,
      mcplChannelId: null,
      channelName: null,
      guildId: null,
      guildName: null,
      metadataResolved: false,
    };
  }

  private projectHistoryReactions<T extends { reactions?: ReactionSummary[] }>(
    msgs: T[],
  ): Array<T & { reactionsUnavailable?: true }> {
    return msgs.map((m) => {
      const proj = this.filtersState.project(m.reactions);
      return {
        ...m,
        reactions: proj.reactions,
        ...(proj.unavailable ? { reactionsUnavailable: true as const } : {}),
      };
    });
  }

  private renderReactionState(reactions: ReactionSummary[] | undefined): string {
    const proj = this.filtersState.project(reactions);
    if (reactions === undefined || proj.unavailable) return ' [reactions: unavailable]';
    if (proj.reactions.length === 0) return '';
    const parts = proj.reactions.map(
      (r) => `${r.emoji} x${r.count}${r.me ? ' (incl. me)' : ''}`,
    );
    return ` [reactions: ${parts.join(', ')}]`;
  }

  private missedPlaceAttrs(
    meta: { name?: string | null; guildName?: string | null } & ThreadPlace | null | undefined,
    channelId: string,
    isDM: boolean,
  ): string[] {
    const place = messagePlace(meta?.name ?? undefined, meta ?? {});
    const attrs: string[] = [];
    if (place.channel) attrs.push(`channel=${quotedLabel(`#${place.channel}`)}`);
    if (place.thread) attrs.push(`thread=${quotedLabel(place.thread)}`);
    attrs.push(`channelId="${channelId}"`);
    if (meta?.guildName) attrs.push(`guild=${quotedLabel(meta.guildName)}`);
    else if (isDM) attrs.push('dm="true"');
    return attrs;
  }

  private missedLine(m: HistoryMessage, mark: string): string {
    const ts = formatAgentDateTime(m.timestamp, AGENT_TIME_ZONE, AGENT_TIMESTAMP_STYLE);
    const att =
      m.attachments && m.attachments.length > 0
        ? ` [attachments: ${m.attachments.map((a) => nameValue(a.name)).join(', ')}]`
        : '';
    return `[${ts ? `${ts} ` : ''}id=${m.id}] ${nameValue(m.authorName)}${mark}${att}${this.renderReactionState(m.reactions)}: ${senderText(m.cleanContent)}`;
  }

  private owe(channelId: string, messageId: string, how: { uncertain: boolean; edit?: boolean }): void {
    this.ensureWatermarkLoaded();
    const list = this.owed.get(channelId) ?? [];
    const known = list.find((o) => o.id === messageId);
    if (known) {
      this.owedRevs.set(known, (this.owedRevs.get(known) ?? 0) + 1);
      if (how.uncertain) known.uncertain = true;
      if (!how.edit) delete known.edit;
    } else {
      list.push({ id: messageId, ...(how.uncertain ? { uncertain: true as const } : {}), ...(how.edit ? { edit: true as const } : {}) });
    }
    while (list.length > OWED_PER_CHANNEL_MAX) {
      const dropped = list.shift()!;
      console.error(`[discord-mcpl] Gave up message ${dropped.id} in channel ${channelId}: more than ${OWED_PER_CHANNEL_MAX} messages there are owed.`);
    }
    this.owed.set(channelId, list);
    this.saveWatermark();
    console.error(`[discord-mcpl] ${how.edit ? 'The edit of message' : 'Message'} ${messageId} in channel ${channelId} is owed: it is delivered when a host connection is ready or the host takes messages there again, unless it is given up.`);
    dbg('owed:added', { channelId, messageId, ...how, owed: list.length });
  }

  private forgetOwedEntries(channelId: string, entries: readonly OwedMessage[]): void {
    const list = this.owed.get(channelId);
    if (!list) return;
    this.forgetOwed(channelId, list.filter((o) => entries.includes(o)).map((o) => o.id));
  }

  private forgetOwed(channelId: string, ids: readonly string[]): void {
    const list = this.owed.get(channelId);
    if (!list) return;
    const left = list.filter((o) => !ids.includes(o.id));
    if (left.length === list.length) return;
    if (left.length > 0) {
      this.owed.set(channelId, left);
    } else {
      this.owed.delete(channelId);
      this.owedTried.delete(channelId);
    }
    this.saveWatermark();
  }

  private readonly owedRevs = new WeakMap<OwedMessage, number>();

  private readonly owedDelivering = new Set<string>();
  private readonly owedRerun = new Map<string, McplConnection>();
  private readonly owedTried = new Map<string, { conn: McplConnection; failedAt: number }>();

  private async deliverOwed(conn: McplConnection): Promise<void> {
    this.ensureWatermarkLoaded();
    for (const channelId of [...this.owed.keys()]) {
      if (this.conn !== conn || conn.isClosed) return;
      await this.deliverOwedIn(conn, channelId, 'ready');
    }
  }

  private async deliverOwedIn(conn: McplConnection, channelId: string, trigger: 'ready' | 'live'): Promise<void> {
    if (this.owedDelivering.has(channelId)) {
      if (trigger === 'ready') this.owedRerun.set(channelId, conn);
      return;
    }
    if (trigger === 'live' && conn !== this.readyConn) return;
    const tried = this.owedTried.get(channelId);
    if (trigger === 'live' && tried?.conn === conn && Date.now() - tried.failedAt < OWED_RETRY_COOLDOWN_MS) return;
    this.owedDelivering.add(channelId);
    try {
      const list = [...(this.owed.get(channelId) ?? [])];
      if (list.length === 0) return;
      if (!this.mcplEnabled || !isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      const startRevs = new Map(list.map((o) => [o, this.owedRevs.get(o) ?? 0]));
      const forgetAsRead = (entries: readonly OwedMessage[]): void => {
        this.forgetOwedEntries(channelId, entries.filter((o) => (this.owedRevs.get(o) ?? 0) === startRevs.get(o)));
      };
      const giveUp = (entries: readonly OwedMessage[], why: string): void => {
        if (entries.length === 0) return;
        console.error(`[discord-mcpl] Gave up ${entries.length} owed message(s) in channel ${channelId}: ${why}.`);
        dbg('owed:given-up', { channelId, ids: entries.map((o) => o.id), why });
        forgetAsRead(entries);
      };
      const notThisTime = (entries: readonly OwedMessage[], why: string, final = false): void => {
        const ended = this.conn !== conn || conn.isClosed;
        const counts = !ended;
        if (!ended) this.owedTried.set(channelId, { conn, failedAt: Date.now() });
        const givenUp: OwedMessage[] = [];
        for (const owed of entries) {
          if (counts) owed.tries = (owed.tries ?? 0) + 1;
          if (final || (owed.tries ?? 0) >= OWED_DELIVERY_TRIES) givenUp.push(owed);
        }
        this.saveWatermark();
        if (givenUp.length > 0) forgetAsRead(givenUp);
        console.error(
          `[discord-mcpl] Couldn't deliver ${entries.length} owed message(s) in channel ${channelId}: ${why}` +
            (givenUp.length === entries.length ? '; given up.' : givenUp.length > 0
              ? `; ${givenUp.length} given up, the rest tried again later.` : '; tried again later.'),
        );
        dbg('owed:not-delivered', { channelId, ids: entries.map((o) => o.id), why, givenUp: givenUp.map((o) => o.id) });
      };
      if (this.isChannelMuted(channelId)) {
        giveUp(list, 'the channel is muted');
        return;
      }

      const have = new Map<string, HistoryMessage>();
      const windows: Array<[bigint, bigint]> = [];
      const covered = (id: string): boolean => {
        const n = snowflake(id);
        return n !== null && windows.some(([lo, hi]) => n >= lo && n <= hi);
      };
      for (const owed of [...list].sort((a, b) => compareSnowflakes(a.id, b.id))) {
        if (have.has(owed.id) || covered(owed.id)) continue;
        let page: HistoryMessage[];
        try {
          page = await this.discord.fetchAround(channelId, owed.id, 100);
        } catch (err) {
          if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
            giveUp(list, "Discord doesn't know the channel");
            const deletedFrom = this.guildOfChannel(channelId);
            if (deletedFrom) {
              this.channelDeleted(deletedFrom, channelId);
            } else {
              const tallied = this.missedTally.delete(channelId);
              if (this.forwardedWatermark.delete(channelId) || tallied) this.saveWatermark();
            }
          } else {
            notThisTime(list, `couldn't read them from Discord (${errorText(err)})`);
          }
          return;
        }
        for (const m of page) have.set(m.id, m);
        const ns = page.map((m) => snowflake(m.id)).filter((n): n is bigint => n !== null);
        if (ns.length > 0) windows.push([ns.reduce((a, b) => (b < a ? b : a)), ns.reduce((a, b) => (b > a ? b : a))]);
      }
      const gone = list.filter((o) => !have.has(o.id));
      if (gone.length > 0) {
        giveUp(gone, 'Discord no longer has them');
      }
      let found = list.filter((o) => have.has(o.id)).map((owed) => ({ owed, m: have.get(owed.id)! }));
      if (found.length === 0) return;

      let meta = this.discord.getCachedChannelMeta(channelId);
      let lookupFailure: string | null = null;
      if (!meta || (meta.threadId && meta.threadParentName === null) || this.discord.isStale(channelId)) {
        const cached = meta;
        meta = (await this.discord.getChannelMeta(channelId).catch((err) => {
          lookupFailure = errorText(err);
          return null;
        })) ?? cached;
      }
      const isDM = this.dmChannelIds.has(channelId) || meta?.isDM === true;
      const guildId = isDM ? null : (meta?.guildId ?? null);
      if (!isDM && !guildId) {
        notThisTime(found.map(({ owed }) => owed),
          `neither its guild nor DM identity could be resolved${lookupFailure ? ` (its lookup failed: ${lookupFailure})` : ''}`);
        return;
      }
      if (guildId) await this.discord.lookUpStaleParent(channelId);
      if (lookupFailure) {
        console.error(
          `[discord-mcpl] Couldn't look up channel ${channelId} for its owed messages (${lookupFailure}). They are placed and ` +
            'filtered by what the cache knew of it, and may go out without its names.',
        );
      }
      const reasons = new Map(found.map(({ m }) => [m.id, this.discord.historyIngressReason(channelId, guildId, m.authorId)]));
      const refused = found.filter(({ m }) => reasons.get(m.id) !== null);
      if (refused.some(({ m }) => reasons.get(m.id) === 'channel-not-allowed')) {
        const notCurrent = this.discord.ingressFactsNotCurrent(channelId);
        if (notCurrent) {
          notThisTime(found.map(({ owed }) => owed),
            `the channel filters would withhold them, but that answer rests on facts that aren't current (${notCurrent})`);
          return;
        }
      }
      for (const { m } of refused) {
        if (reasons.get(m.id) === 'dm-user-not-allowed') {
          this.handleDmRefusal({ messageId: m.id, channelId, authorId: m.authorId, origin: 'sweep' });
        }
      }
      giveUp(refused.map(({ owed }) => owed), 'the filters refuse them now');
      found = found.filter((f) => !refused.includes(f));
      const shut = found.filter(({ m }) => !this.shouldEnterContext(channelId, { isDM, guildId, isMention: m.mentionsBot }));
      giveUp(shut.map(({ owed }) => owed), "their channel doesn't take them now (closed or unsubscribed since, and they don't address the agent)");
      found = found.filter((f) => !shut.includes(f));
      if (found.length === 0) return;
      found.sort((a, b) => a.m.timestamp.getTime() - b.m.timestamp.getTime());

      const guildDelivery = !isDM && guildId ? this.registerGuildDelivery(guildId, channelId) : undefined;
      const mcplId = isDM
        ? this.registerDmDelivery(channelId, { id: found[0].m.authorId, name: found[0].m.authorName })
        : guildDelivery?.id;
      const closedNote = guildDelivery && guildId ? this.closedChannelNote(guildId, channelId, guildDelivery) : '';
      const thread: ThreadPlace = meta ?? {};
      const hadMention = isDM || found.some(({ m }) => m.mentionsBot);
      const attrs = this.missedPlaceAttrs(meta, channelId, isDM);
      attrs.push(`count="${found.length}"`, 'reason="undelivered"');
      const lines = found.map(({ m, owed }) => this.missedLine(m,
        `${m.mentionsBot ? ' (mention)' : ''}${owed.edit ? ' (edited)' : ''}${owed.uncertain ? ' (may have arrived already)' : ''}`));
      const block = [
        `<missed ${attrs.join(' ')}>`,
        "[The host didn't take these messages when they were sent; this is how Discord has them now.]",
        ...lines,
        '</missed>',
      ].join('\n');
      const payloadText = `${closedNote}${block}`;
      const digest = createHash('sha256').update(payloadText).digest('hex').slice(0, 16);
      const revs = new Map(found.map(({ owed }) => [owed, this.owedRevs.get(owed) ?? 0]));
      const sentBeforeReady = conn !== this.readyConn;
      let outcome: SendOutcome;
      try {
        outcome = pushOutcome(await conn.sendRequest(method.PUSH_EVENT, {
          featureSet: 'discord.messaging',
          eventId: `discord_owed_${channelId}_${digest}`,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId,
            guildId: meta?.guildId ?? null,
            guildName: meta?.guildName ?? undefined,
            ...(mcplId ? { mcplChannelId: mcplId } : {}),
            channelName: meta?.name ?? undefined,
            ...threadFields(thread),
            isMention: hadMention,
            isDM,
          } as Record<string, unknown>,
          ...(threadTags(thread).length > 0 ? { tags: threadTags(thread) } : {}),
          payload: { content: [textContent(payloadText)] },
        } satisfies PushEventParams));
      } catch (err) {
        outcome = sendErrorOutcome(err);
      }
      if (outcome.kind === 'accepted' || outcome.kind === 'no-result') {
        this.owedTried.delete(channelId);
        this.forgetOwedEntries(channelId, found.filter(({ owed }) => (this.owedRevs.get(owed) ?? 0) === revs.get(owed)).map(({ owed }) => owed));
        console.error(`[discord-mcpl] Delivered ${found.length} owed message(s) in channel ${channelId}.`);
        dbg('owed:delivered', { channelId, ids: found.map(({ owed }) => owed.id), result: outcome.kind });
        return;
      }
      const answer = answerClass(outcome);
      const notYet = sentBeforeReady && isAuthorityRefusal(outcome);
      notThisTime(found.map(({ owed }) => owed), describeOutcome(outcome, 'push/event'), !notYet && (answer === 'final' || answer === 'unknown-channel'));
    } finally {
      this.owedDelivering.delete(channelId);
      const again = this.owedRerun.get(channelId);
      if (again) {
        this.owedRerun.delete(channelId);
        if (this.conn === again) {
          void this.deliverOwedIn(again, channelId, 'ready').catch((err) => {
            console.error('[discord-mcpl] Delivering owed messages failed:', errorText(err));
          });
        }
      }
    }
  }

  private async runReconnectSweep(): Promise<void> {
    if (this.sweepDone) return;
    this.sweepDone = true;
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    if (!this.watermarkFile()) {
      dbg('sweep:skip', { reason: 'no-watermark-file' });
      return;
    }
    this.ensureSubscriptionsLoaded();
    this.ensureWatermarkLoaded();
    const botId = this.discord.botUserId;

    const candidates = new Set<string>([
      ...this.forwardedWatermark.keys(),
      ...this.subscribedChannels,
      ...this.dmChannelIds,
    ]);

    let delivered = 0;
    for (const channelId of candidates) {
      if (this.isChannelMuted(channelId)) {
        dbg('sweep:skip', { channelId, reason: 'muted' });
        continue;
      }
      const watermark = this.forwardedWatermark.get(channelId);
      if (!watermark) continue;
      const isSubscribed = this.subscribedChannels.has(channelId);

      let msgs: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        msgs = await this.discord.fetchHistory(channelId, {
          limit: this.catchupLimit,
          after: watermark,
        });
      } catch (err) {
        dbg('sweep:fetch-failed', { channelId, error: errorText(err) });
        if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
          const guildId = this.guildOfChannel(channelId);
          if (guildId) {
            this.channelDeleted(guildId, channelId);
          } else {
            const tallied = this.missedTally.delete(channelId);
            if (this.forwardedWatermark.delete(channelId) || tallied) this.saveWatermark();
          }
        }
        continue;
      }
      msgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      msgs = msgs.filter((m) => m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX));
      if (msgs.length === 0) continue;

      const newestId = msgs[msgs.length - 1].id;

      let meta = this.discord.getCachedChannelMeta(channelId);
      let lookupFailure = null as string | null;
      if (!meta || (meta.threadId && meta.threadParentName === null) || this.discord.isStale(channelId)) {
        const cached = meta;
        meta = (await this.discord.getChannelMeta(channelId).catch((err) => {
          lookupFailure = errorText(err);
          dbg('sweep:channel-meta-failed', { channelId, error: lookupFailure });
          return null;
        })) ?? cached;
      }
      const isDM = this.dmChannelIds.has(channelId) || meta?.isDM === true;
      const guildId = isDM ? null : (meta?.guildId ?? null);
      if (!isDM && !guildId) {
        dbg('sweep:identity-unresolved', { channelId });
        console.error(
          `[discord-mcpl] Catch-up held back channel ${channelId}: neither its guild nor DM identity could be ` +
            `resolved${lookupFailure ? ` (its lookup failed: ${lookupFailure})` : ''}, so its missed messages ` +
            'were not delivered. It is tried again at the next start, unless a message forwarded live in it ' +
            'before then moves its watermark past them.',
        );
        continue;
      }
      if (guildId) await this.discord.lookUpStaleParent(channelId);

      const refusedDms: typeof msgs = [];
      const withheld = new Map<string, number>();
      msgs = msgs.filter((m) => {
        const reason = this.discord.historyIngressReason(channelId, guildId, m.authorId);
        if (reason === 'dm-user-not-allowed') refusedDms.push(m);
        else if (reason) withheld.set(reason, (withheld.get(reason) ?? 0) + 1);
        return reason === null;
      });
      const filtered = withheld.get('channel-not-allowed');
      const notCurrent = filtered ? this.discord.ingressFactsNotCurrent(channelId) : null;
      if (notCurrent) {
        dbg('sweep:held-facts-not-current', { channelId, filtered, notCurrent });
        console.error(
          `[discord-mcpl] Catch-up held back channel ${channelId}: the channel filters would withhold its ` +
            `${filtered} missed message(s), but that answer rests on facts that aren't current ` +
            `(${notCurrent}${lookupFailure ? `; channel ${channelId}'s own lookup failed: ${lookupFailure}` : ''}), so they were not ` +
            'delivered. It is tried again at the next start, unless a message forwarded live in it before then ' +
            'moves its watermark past them.',
        );
        continue;
      }
      if (lookupFailure) {
        console.error(
          `[discord-mcpl] Catch-up couldn't look up channel ${channelId} (${lookupFailure}). Its missed messages ` +
            'are placed and filtered by what the cache knew of it, and any that are delivered may go out without its names.',
        );
      }
      const refusalsDecided = refusedDms.map(
        (m) => this.handleDmRefusal({ messageId: m.id, channelId, authorId: m.authorId, origin: 'sweep' }).decided,
      );
      const advance = async () => {
        if (refusalsDecided.length) await this.awaitSweepDecisions(channelId, refusalsDecided);
        if (guildId && this.deletedLately(guildId, channelId)) return;
        const current = this.forwardedWatermark.get(channelId);
        if (!current || newestId.localeCompare(current, 'en-US-u-kn-true') > 0) {
          this.forwardedWatermark.set(channelId, newestId);
          // Saved at once: the process can end before the sweep does, since the stdio transport exits when its host goes.
          this.saveWatermark();
        }
      };
      for (const [reason, count] of withheld) {
        if (reason === 'self-authored') continue;
        console.error(
          `[discord-mcpl] Catch-up withheld ${count} missed message(s) in channel ${channelId}: ${reason} ` +
            '(the live filters refuse them)',
        );
      }
      if (msgs.length === 0) {
        await advance();
        continue;
      }

      const VICINITY = 7;
      const keepAll = isDM || isSubscribed;
      const mentionCount = msgs.filter((m) => m.mentionsBot).length;
      let kept: typeof msgs;
      if (keepAll) {
        kept = msgs;
      } else {
        const keepIdx = new Set<number>();
        for (let i = 0; i < msgs.length; i++) {
          if (!msgs[i].mentionsBot) continue;
          for (let j = Math.max(0, i - VICINITY); j <= Math.min(msgs.length - 1, i + VICINITY); j++) {
            keepIdx.add(j);
          }
        }
        kept = [...keepIdx].sort((a, b) => a - b).map((i) => msgs[i]);
      }
      if (kept.length === 0) {
        await advance();
        continue;
      }
      const hadMention = isDM || mentionCount > 0;

      const thread: ThreadPlace = meta ?? {};
      const attrs = this.missedPlaceAttrs(meta, channelId, isDM);
      attrs.push(`count="${keepAll ? kept.length : mentionCount}"`);
      if (!keepAll) attrs.push(`lines="${kept.length}"`);
      attrs.push(`reason="${isDM ? 'dm' : hadMention ? 'mention' : 'backscroll'}"`);
      const lines = kept.map((m) => this.missedLine(m, m.mentionsBot ? ' (mention)' : ''));
      const block = [
        `<missed ${attrs.join(' ')}>`,
        ...lines,
        '</missed>',
      ].join('\n');

      // MCPL RFC-011 §3: the channel a push delivers from is registered before the push names it.
      const guildDelivery = !isDM && guildId ? this.registerGuildDelivery(guildId, channelId) : undefined;
      const sweptMcplId = isDM
        ? this.registerDmDelivery(channelId, { id: kept[0].authorId, name: kept[0].authorName })
        : guildDelivery?.id;
      const closedNote = guildDelivery && guildId ? this.closedChannelNote(guildId, channelId, guildDelivery) : '';

      try {
        await conn.sendRequest(method.PUSH_EVENT, {
          featureSet: 'discord.messaging',
          eventId: `discord_missed_${channelId}_${newestId}`,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId,
            guildId: meta?.guildId ?? null,
            guildName: meta?.guildName ?? undefined,
            ...(sweptMcplId ? { mcplChannelId: sweptMcplId } : {}),
            channelName: meta?.name ?? undefined,
            ...threadFields(thread),
            isMention: hadMention,
            isDM,
          } as Record<string, unknown>,
          ...(threadTags(thread).length > 0 ? { tags: threadTags(thread) } : {}),
          payload: { content: [textContent(`${closedNote}${block}`)] },
        } satisfies PushEventParams);
      } catch (err) {
        dbg('sweep:send-failed', { channelId, error: errorText(err) });
        continue;
      }
      await advance();
      delivered++;
    }

    await this.backfillMissedTallies();

    this.saveWatermark();
    dbg('sweep:done', { channelsDelivered: delivered, scanned: candidates.size });
    if (delivered > 0) {
      console.error(
        `[discord-mcpl] Reconnect catch-up: delivered missed messages from ${delivered} channel(s)`,
      );
    }
  }

  private async backfillMissedTallies(): Promise<void> {
    if (this.missedTally.size === 0) return;
    const botId = this.discord.botUserId;
    for (const [channelId, tally] of this.missedTally) {
      if (!tally.talliedThrough) continue;
      let msgs: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        msgs = await this.discord.fetchHistory(channelId, {
          limit: this.catchupLimit,
          after: tally.talliedThrough,
        });
      } catch (err) {
        dbg('missed-backfill:fetch-failed', { channelId, error: errorText(err) });
        continue;
      }
      const ambient = msgs.filter(
        (m) => !m.mentionsBot && m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX),
      );
      if (ambient.length > 0) {
        tally.messages += ambient.length;
        tally.characters += ambient.reduce((n, m) => n + m.cleanContent.length, 0);
      }
      if (msgs.length > 0) {
        const newest = msgs.reduce((a, b) =>
          a.id.localeCompare(b.id, 'en-US-u-kn-true') >= 0 ? a : b,
        );
        tally.talliedThrough = newest.id;
      }
      dbg('missed-backfill:channel', {
        channelId,
        added: ambient.length,
        messages: tally.messages,
        characters: tally.characters,
      });
    }
  }

  /** A host may keep a server's channels across a reconnect (agent-framework
   *  keeps them until it drops the server), so channels forgotten while no
   *  host was connected are announced as removed after it. */
  private async syncChannelsWithHost(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) {
      dbg('syncChannelsWithHost:skip', { reason: !conn ? 'no-conn' : 'mcpl-disabled' });
      return;
    }
    for (const facts of this.discord.getPostingChannels()) {
      this.channelManager.register(this.guildDescriptor(facts));
    }
    const channels = this.channelManager.getAll();
    dbg('syncChannelsWithHost', { count: channels.length, ids: channels.map((d) => d.id) });
    if (channels.length > 0) {
      const regParams: ChannelsRegisterParams = { channels };
      try {
        await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
        dbg('syncChannelsWithHost:sent', { count: channels.length });
      } catch (err) {
        console.error('[discord-mcpl] Failed to register channels:', errorText(err));
        dbg('syncChannelsWithHost:send-failed', { error: errorText(err) });
      }
    }
    if (conn.isClosed) return;
    const removed = [...this.unannouncedRemovals].filter((id) => !this.channelManager.get(id));
    this.unannouncedRemovals.clear();
    if (removed.length > 0) {
      dbg('syncChannelsWithHost:removed', { removed });
      conn.sendNotification(method.CHANNELS_CHANGED, { removed });
    }
  }

  private guildDescriptor(facts: ChannelFacts): ChannelDescriptor {
    return toDescriptor(facts, this.isChannelSubscribed(facts.id), this.backscrollLimitFor(facts.id));
  }

  private registerChannels(descriptors: ChannelDescriptor[]): { added: ChannelDescriptor[]; updated: ChannelDescriptor[] } {
    const added: ChannelDescriptor[] = [];
    const updated: ChannelDescriptor[] = [];
    for (const d of descriptors) {
      const known = this.channelManager.get(d.id);
      if (known && knowsLessThan(d, known)) continue;
      if (!known) added.push(d);
      else if (known.label !== d.label || JSON.stringify(known.metadata) !== JSON.stringify(d.metadata)) updated.push(d);
      this.channelManager.register(d);
      this.unannouncedRemovals.delete(d.id);
    }
    if ((added.length > 0 || updated.length > 0) && this.conn && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, {
        ...(added.length > 0 ? { added } : {}),
        ...(updated.length > 0 ? { updated } : {}),
      });
    }
    return { added, updated };
  }

  private forgetChannels(ids: string[]): void {
    const removed = ids.filter((id) => this.channelManager.unregister(id));
    if (removed.length === 0) return;
    if (this.conn && !this.conn.isClosed && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { removed });
    } else {
      for (const id of removed) this.unannouncedRemovals.add(id);
    }
  }

  private rederiveChannels(descriptors: ChannelDescriptor[]): void {
    this.registerChannels(this.derivedNow(descriptors));
  }

  private derivedNow(descriptors: ChannelDescriptor[]): ChannelDescriptor[] {
    const channelIdOf = (d: ChannelDescriptor) => (d.address as { channelId?: string } | undefined)?.channelId;
    const staleNamed = descriptors.filter((d) => {
      const channelId = channelIdOf(d);
      return channelId !== undefined && this.discord.isStale(channelId) && d.label !== d.id;
    });
    const channelIds = descriptors
      .map(channelIdOf)
      .filter((id): id is string => id !== undefined && !this.discord.isStale(id));
    const facts = this.discord.getCachedChannelFactsFor(channelIds);
    return [
      ...[...facts.values()].map((f) => this.guildDescriptor(f)),
      ...staleNamed.map((d) => ({ ...d, label: d.id })),
    ];
  }

  private threadAdmissionKnown(thread: { parentId?: string | null }): boolean {
    return !thread.parentId || !this.discord.isStale(thread.parentId);
  }

  private threadReported(thread: ChannelFacts): void {
    const id = mcplChannelId(thread.guildId, thread.id);
    if (!this.channelManager.get(id)) return;
    if (thread.archived) this.forgetChannels([id]);
    else if (this.threadAdmissionKnown(thread)) this.registerOrForgetThread(thread);
  }

  private registerOrForgetThread(thread: ChannelFacts): void {
    const id = mcplChannelId(thread.guildId, thread.id);
    if (this.discord.channelAdmitted(thread.guildId, thread.id, thread.parentId ?? null)) {
      this.registerChannels([this.guildDescriptor(thread)]);
    } else {
      this.forgetChannels([id]);
    }
  }

  private rederiveNamed(which: { name: string | null } | 'every'): void {
    const named = which === 'every' ? undefined : which.name?.toLowerCase();
    this.rederiveChannels(this.channelManager.getAll().filter((d) => {
      const m = d.metadata as { channelType?: string; channelName?: string } | undefined;
      if (!m?.channelType || !isNameAddressableKind(m.channelType) || !m.channelName) return false;
      return which === 'every' || d.label === d.id || m.channelName.toLowerCase() === named;
    }));
  }

  /** Discord doesn't replay what happened while a guild was away. */
  private guildReturned(guildId: string, channels: ChannelFacts[], present: ReadonlySet<string>): void {
    const listed = new Set(channels.map((c) => c.id));
    this.forgetChannels(this.registeredInGuild(guildId).filter((d) => {
      const channelId = (d.address as { channelId: string }).channelId;
      const type = (d.metadata as { channelType?: string } | undefined)?.channelType;
      return !present.has(channelId)
        || (type !== undefined && isListedKind(type as ChannelFacts['type']) && !listed.has(channelId))
        || (type === 'thread' && !this.admitted(d));
    }).map((d) => d.id));
    this.registerChannels(channels.map((c) => this.guildDescriptor(c)));
    this.rederiveChannels(this.registeredInGuild(guildId));
    this.rederiveNamed('every');
  }

  private registeredThreadsOf(channelId: string): ChannelDescriptor[] {
    return this.channelManager.getAll().filter((d) => {
      const m = d.metadata as { channelType?: string; parentId?: string } | undefined;
      return m?.channelType === 'thread' && m.parentId === channelId;
    });
  }

  private registeredInGuild(guildId: string): ChannelDescriptor[] {
    return this.channelManager.getAll().filter((d) => (d.address as { guildId?: string } | undefined)?.guildId === guildId);
  }

  private admitted(d: ChannelDescriptor): boolean {
    const address = d.address as { guildId?: string; channelId?: string } | undefined;
    if (!address?.guildId || !address.channelId || address.guildId === 'dm') return true;
    const parentId = (d.metadata as { parentId?: string | null } | undefined)?.parentId ?? null;
    return this.discord.channelAdmitted(address.guildId, address.channelId, parentId);
  }

  private guildOfChannel(channelId: string): string | undefined {
    const cached = this.discord.getCachedChannelFacts(channelId)?.guildId;
    if (cached) return cached;
    const address = this.channelManager.getAll()
      .map((d) => d.address as { guildId?: string; channelId?: string } | undefined)
      .find((a) => a?.channelId === channelId);
    return address?.guildId && address.guildId !== 'dm' ? address.guildId : undefined;
  }

  /** A channel's own parent is its category, whose channels outlive it. */
  private deletedLately(guildId: string, channelId: string): boolean {
    if (this.deletedChannels.has(channelId)) return true;
    const facts = this.discord.getCachedChannelFacts(channelId);
    const known = this.channelManager.get(mcplChannelId(guildId, channelId))?.metadata as
      { channelType?: string; parentId?: string } | undefined;
    const parentId = facts
      ? (facts.type === 'thread' ? facts.parentId : null)
      : (known?.channelType === 'thread' ? known.parentId : null);
    return !!parentId && this.deletedChannels.has(parentId);
  }

  /**
   * A message's channel is always in discord.js's cache, as a partial at least,
   * until it's removed. Discord unarchives a thread when a message is posted
   * in it, so a message posted after a thread's archive time came from a live
   * thread. Leaving a guild takes the channels its cache holds, with their threads, out
   * of the client's cache, but not a channel the guild had stopped listing, or
   * that channel's threads. Categories and forums hold no messages.
   */
  private registerGuildDelivery(
    guildId: string,
    channelId: string,
    opts: { postedAt?: number } = {},
  ): GuildDelivery {
    const withheld = (reason: string, named?: string): GuildDelivery => {
      dbg('registry:withheld', { guildId, channelId, reason, named: named !== undefined });
      return { id: named, registered: false };
    };
    if (!this.discord.hasGuild(guildId)) return withheld('guild-left');
    if (this.deletedLately(guildId, channelId)) return withheld('deleted');
    const id = mcplChannelId(guildId, channelId);
    const facts = this.discord.getCachedChannelFacts(channelId);
    if (facts && holdsNoMessages(facts.type)) return { id: undefined, registered: false };
    const named = this.channelManager.get(id) ? id : undefined;
    if (!facts) return withheld('uncached', named);
    if (this.discord.isStale(channelId)) return withheld('stale', named);
    if (!this.discord.channelAdmitted(guildId, channelId, facts.parentId ?? null)) return withheld('not-admitted', named);
    const unarchived = opts.postedAt !== undefined && facts.archivedAt !== undefined && opts.postedAt > facts.archivedAt;
    if (facts.archived && !unarchived) return withheld('archived', named);
    this.registerChannels([this.guildDescriptor(facts)]);
    return { id, registered: true };
  }

  private closedChannelNote(guildId: string, channelId: string, delivery: GuildDelivery): string {
    return delivery.registered
      && this.shouldEnterContext(channelId, { isMention: true, isDM: false, guildId })
      && !this.shouldEnterContext(channelId, { isDM: false, guildId })
      ? CLOSED_CHANNEL_NOTE : '';
  }

  private registerDmDelivery(channelId: string, peer: { id?: string; name?: string }): string | undefined {
    const id = mcplChannelId('dm', channelId);
    if (peer.name) {
      this.registerChannels([toDmDescriptor(channelId, peer.name, false, this.backscrollLimitFor(channelId), peer.id)]);
      return id;
    }
    return this.channelManager.get(id) ? id : undefined;
  }

  /** Discord sends no threadDelete for the threads under a deleted channel. */
  private channelDeleted(guildId: string, channelId: string, threadIds: string[] = []): void {
    const ids = [...new Set([
      channelId,
      ...threadIds,
      ...this.registeredThreadsOf(channelId).map((d) => (d.address as { channelId: string }).channelId),
    ])];
    for (const id of ids) {
      this.deletedChannels.delete(id);
      this.deletedChannels.add(id);
    }
    while (this.deletedChannels.size > DELETED_CHANNELS_KEPT) {
      this.deletedChannels.delete(this.deletedChannels.values().next().value as string);
    }
    this.ensureWatermarkLoaded();
    let pruned = false;
    for (const id of ids) {
      if (this.forwardedWatermark.delete(id)) pruned = true;
      if (this.missedTally.delete(id)) pruned = true;
      if (this.owed.delete(id)) pruned = true;
      this.owedTried.delete(id);
    }
    if (pruned) this.saveWatermark();
    this.forgetChannels(ids.map((id) => mcplChannelId(guildId, id)));
    this.rederiveNamed({ name: null });
  }

  private refreshChannels(): ChannelRefresh {
    const descriptors = this.discord.getPostingChannels().map((facts) => this.guildDescriptor(facts));
    const { added } = this.registerChannels(descriptors);
    dbg('refreshChannels', { visible: descriptors.length, added: added.length });
    return {
      visible: descriptors.length,
      added: added.map((d) => ({ id: d.id, label: d.label })),
      note:
        added.length > 0
          ? `Registered ${added.length} newly-visible channel(s).`
          : 'No new channels — the host already knows about every visible channel.',
    };
  }

  private async handleChannelOpen(params: ChannelOpenRequest): Promise<ChannelOpenResponse> {
    const target = resolveOpenTarget(params, this.channelManager.getAll());
    if (target.kind === 'refused') throw new RequestRefusal(target.code, target.reason);
    const parsed = parseMcplChannelId(target.kind === 'registered' ? target.channel.id : target.id);
    if (!parsed) throw new Error(`Invalid Discord channel ID: ${target.kind === 'registered' ? target.channel.id : target.id}`);
    const lookedUp = target.kind === 'registered' ? null : await this.lookUpServedTarget(target, params.type);
    const desc = target.kind === 'registered' ? target.channel : lookedUp!.desc;
    const unregistered = () => new RequestRefusal(
      ERR_UNKNOWN_CHANNEL,
      `${desc.id} was unregistered while this open was in progress (deleted, archived, in a server the bot left, ` +
        'or no longer admitted by the filters). Nothing was opened. A thread archived meanwhile opens again when ' +
        'it is opened by its id.',
    );
    const goneMeanwhile = (): RequestRefusal | null => {
      if (!lookedUp) return this.channelManager.get(desc.id) ? null : unregistered();
      if (this.notServed(parsed.channelId, lookedUp.facts)) {
        return new RequestRefusal(
          ERR_UNKNOWN_CHANNEL,
          `${desc.id} was deleted, or the bot left its server, while this open was in progress. Nothing was opened.`,
        );
      }
      if (lookedUp.dmRecipientId !== undefined && !this.discord.dmUserAdmitted(lookedUp.dmRecipientId)) {
        return new RequestRefusal(
          ERR_UNKNOWN_CHANNEL,
          `The DM list stopped admitting ${desc.id}'s recipient while this open was in progress. Nothing was opened. ` +
            'Opening it is refused while the DM list leaves its recipient out.',
        );
      }
      return null;
    };
    const requested = params.history?.limit ?? 0;
    let backscroll: { messages: Awaited<ReturnType<DiscordAdapter['fetchHistory']>>; truncated: boolean } | null = null;
    if (requested > 0) {
      const filtersRefusal = async (): Promise<string | null> => {
        let refusal: string | null;
        try {
          refusal = await this.discord.inspectionRefusal(parsed.channelId);
        } catch (err) {
          const gone = goneMeanwhile();
          if (gone) throw gone;
          throw new RequestRefusal(
            ERR_CHANNEL_OPEN_FAILED,
            `${desc.id} couldn't be checked against the channel filters, so nothing was opened: ${errorValue(err)}`,
          );
        }
        if (refusal) {
          const gone = goneMeanwhile();
          if (gone) throw gone;
        }
        return refusal;
      };
      const refusal = await filtersRefusal();
      if (refusal) {
        dbg('channel-open:inspection-refused', { channelId: desc.id });
        throw new RequestRefusal(ERR_CHANNEL_OPEN_FAILED, `${refusal} Nothing was opened.`);
      }
      const limit = this.capHistoryLimit(parsed.channelId, Math.min(500, Math.max(0, requested)));
      if (params.history?.sinceLastSeen) this.ensureWatermarkLoaded();
      let messages: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        messages = await this.discord.fetchHistory(parsed.channelId, {
          limit,
          ...(params.history?.beforeMessageId ? { before: params.history.beforeMessageId } : {}),
          ...(params.history?.sinceLastSeen
            ? { after: this.forwardedWatermark.get(parsed.channelId) }
            : {}),
        });
      } catch (err) {
        const gone = goneMeanwhile();
        if (gone) throw gone;
        throw new RequestRefusal(
          ERR_CHANNEL_OPEN_FAILED,
          `${desc.id}'s history couldn't be fetched, so nothing was opened: ${errorValue(err)}`,
        );
      }
      if (await filtersRefusal()) {
        dbg('channel-open:inspection-refused-after-fetch', { channelId: desc.id });
        throw new RequestRefusal(
          ERR_CHANNEL_OPEN_FAILED,
          `The channel filters stopped admitting ${desc.id} while its history was fetched, so none of it is returned. ` +
            'Nothing was opened. Asking again with history is refused while the filters leave it out.',
        );
      }
      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      backscroll = { messages, truncated: requested > limit };
    }

    const gone = goneMeanwhile();
    if (gone) throw gone;
    if (lookedUp && !this.channelManager.get(desc.id)) {
      const now = this.derivedNow([desc])[0] ?? desc;
      this.registerChannels([now]);
      const name = (now.metadata as { channelName?: string } | undefined)?.channelName;
      if (name) this.rederiveNamed({ name });
    }
    const opened = this.channelManager.open(desc.id);
    if (!opened) throw unregistered();
    const result: ChannelOpenResponse = { channel: opened };
    if (backscroll) {
      result.history = this.projectHistoryReactions(backscroll.messages).map((message) => ({
        channelId: opened.id,
        channelLabel: opened.label,
        messageId: message.id,
        author: { id: message.authorId, name: message.authorName },
        timestamp: message.timestamp.toISOString(),
        content: [textContent(`${nameValue(message.authorName)}: ${senderText(message.cleanContent)}`)],
        metadata: {
          isBot: message.isBot,
          attachments: message.attachments,
          reactions: message.reactions ?? [],
          backscroll: true,
          ...(message.reactionsUnavailable ? { reactionsUnavailable: true } : {}),
        },
      }));
      result.historyTruncated = backscroll.truncated;
    }
    this.subscribeRawChannel(parsed.channelId);
    return result;
  }

  private async lookUpServedTarget(
    target: { id: string; via: string },
    type: unknown,
  ): Promise<{ desc: ChannelDescriptor; facts: ChannelFacts | null; dmRecipientId?: string }> {
    const parsed = parseMcplChannelId(target.id)!;
    const found = await this.discord.lookUpServedChannel(parsed.guildId, parsed.channelId);
    if (!found || this.notServed(parsed.channelId, found.kind === 'guild' ? found.facts : null)) {
      throw new RequestRefusal(
        ERR_UNKNOWN_CHANNEL,
        parsed.guildId === 'dm'
          ? `No DM this server serves matches ${target.via}: Discord doesn't know it or won't show it to this bot, ` +
            'it isn\'t a DM, or the DM list doesn\'t admit its recipient. Nothing was opened.'
          : `No channel this server serves matches ${target.via}: Discord doesn't know it or won't show it to this bot, ` +
            'it\'s in another server than the id names, it was deleted lately or is in a server the bot left, or it ' +
            'isn\'t a channel messages are posted in or a thread that the filters admit. Nothing was opened. ' +
            'list_channels with a server\'s id lists the channels this server serves there.',
      );
    }
    if (found.kind === 'uncertain') {
      throw new RequestRefusal(
        ERR_CHANNEL_OPEN_FAILED,
        `${target.via} can't be opened right now: Discord's current facts for it, or for the channel it's a thread of, ` +
          "aren't known (the latest fetch failed or was overtaken by a change). Nothing was opened; another open fetches it again.",
      );
    }
    const desc = found.kind === 'dm'
      ? toDmDescriptor(parsed.channelId, found.recipientName, false, this.backscrollLimitFor(parsed.channelId), found.recipientId)
      : this.guildDescriptor(found.facts);
    if (desc.id !== target.id) {
      throw new RequestRefusal(
        ERR_UNKNOWN_CHANNEL,
        `No channel this server serves matches ${target.via}: looking it up found another channel, ${desc.id}. Nothing was opened.`,
      );
    }
    if (desc.type !== type) {
      throw new RequestRefusal(INVALID_PARAMS, `${target.via} is a ${desc.type} channel, not ${typeName(String(type))}. Nothing was opened.`);
    }
    return found.kind === 'guild' ? { desc, facts: found.facts } : { desc, facts: null, dmRecipientId: found.recipientId };
  }

  /** The bot may leave a guild during a lookup, and discord.js keeps a channel
   *  the guild had stopped listing past the leave. A channel outlives its
   *  deleted category. */
  private notServed(channelId: string, facts: ChannelFacts | null): boolean {
    if (this.deletedChannels.has(channelId)) return true;
    if (!facts) return false;
    return !this.discord.hasGuild(facts.guildId)
      || (facts.type === 'thread' && !!facts.parentId && this.deletedChannels.has(facts.parentId));
  }

  private handleChannelClose(params: ChannelsCloseParams): ChannelsCloseResult {
    const desc = this.channelManager.get(params.channelId);
    const parsed = parseMcplChannelId(params.channelId);
    const wasOpen = this.channelManager.close(params.channelId);
    if (parsed) {
      this.unsubscribeRawChannel(parsed.channelId);
    }
    return { closed: wasOpen || desc !== undefined };
  }

  private async handleChannelAcknowledge(params: ChannelAcknowledgeRequest): Promise<{
    acknowledged: boolean;
    representation?: string;
    reason?: string;
  }> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      return { acknowledged: false, reason: `Invalid Discord channel ID: ${params.channelId}` };
    }
    const representation = params.value?.trim() || '👀';
    try {
      await this.discord.addReaction(parsed.channelId, params.messageId, representation);
      return { acknowledged: true, representation };
    } catch (error) {
      return { acknowledged: false, reason: errorValue(error) };
    }
  }

  private subscribeRawChannel(channelId: string): void {
    if (this.isChannelMuted(channelId)) return;
    this.ensureSubscriptionsLoaded();
    if (!this.subscribedChannels.has(channelId)) {
      this.subscribedChannels.add(channelId);
    }
    this.ensureReactionChannelsLoaded();
    if (!this.reactionChannels.has(channelId)) {
      this.reactionChannels.add(channelId);
      this.reactionChannelsUnsaved = true;
    }
    this.ensureWatermarkLoaded();
    if (this.missedTally.delete(channelId)) this.saveWatermark();
  }

  private unsubscribeRawChannel(channelId: string): void {
    this.ensureSubscriptionsLoaded();
    const removed = this.subscribedChannels.delete(channelId);
    this.ensureReactionChannelsLoaded();
    if (this.reactionChannels.delete(channelId)) this.saveReactionChannels();
    if (removed) {
      this.ensureWatermarkLoaded();
      const anchor = this.forwardedWatermark.get(channelId) ?? '';
      this.missedTally.set(channelId, {
        anchorId: anchor,
        talliedThrough: anchor,
        messages: 0,
        characters: 0,
      });
      this.saveWatermark();
    }
  }

  private async handlePublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult & Partial<MentionsField>> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      throw new Error(`Invalid channel ID: ${params.channelId}`);
    }

    const text = params.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!text) {
      dbg('handlePublish:skip', { channelId: params.channelId, reason: 'empty-text' });
      return { delivered: false, messageId: undefined };
    }

    dbg('handlePublish', { channelId: params.channelId, textLen: text.length, preview: text.slice(0, 80) });
    const result = await this.discord.sendMessage(parsed.channelId, text);
    this.stateTracker.recordSent(result.messageId, parsed.channelId, text);
    dbg('handlePublish:sent', { channelId: params.channelId, messageId: result.messageId });

    return withMentions({ delivered: true, messageId: result.messageId }, result.report);
  }

  private async handleRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    if (params.featureSet !== 'discord.messaging') {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: `Feature set '${params.featureSet}' does not support rollback`,
      };
    }

    const toDelete = this.stateTracker.rollback(params.checkpoint);
    if (toDelete === null) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: 'Checkpoint not found',
      };
    }

    let deleted = 0;
    for (const msg of toDelete) {
      try {
        await this.discord.deleteMessage(msg.channelId, msg.discordMessageId);
        deleted++;
      } catch {
      }
    }

    return {
      checkpoint: params.checkpoint,
      success: true,
      reason: deleted < toDelete.length
        ? `Rolled back (${deleted}/${toDelete.length} messages deleted)`
        : undefined,
    };
  }

  private messageEventOrigin(
    channelId: string,
    messageId: string,
    info: MessageEventInfo | undefined,
    registeredId: string | undefined,
  ): Record<string, unknown> {
    const guildId = info?.guildId ?? null;
    return {
      source: 'discord',
      channelId,
      ...(guildId ? { guildId } : {}),
      ...(registeredId ? { mcplChannelId: registeredId } : {}),
      ...threadFields(info ?? {}),
      messageId,
      ...(info?.authorId ? { authorId: info.authorId } : {}),
      ...(info?.authorName ? { authorName: info.authorName } : {}),
    };
  }

  private registerEventChannel(channelId: string, isDM: boolean, info: MessageEventInfo | undefined): string | undefined {
    if (isDM) {
      const peer = info?.authorId !== undefined && info.authorId !== this.discord.botUserId ? info : undefined;
      return this.registerDmDelivery(
        channelId,
        peer ? { id: peer.authorId, name: peer.authorName } : { id: info?.dmRecipientId },
      );
    }
    return info?.guildId
      ? this.registerGuildDelivery(info.guildId, channelId).id
      : undefined;
  }

  /** RFC-006 §3.2: a subject outside channel scope stays in feature-set scope,
   *  which still coalesces as long as every occurrence uses the same scope. */
  private coalesceChannelScope(guildId: string | null, channelId: string): string | undefined {
    if (!this.hostCoalescing?.channelScopedPush) return undefined;
    const id = mcplChannelId(guildId ?? 'dm', channelId);
    return this.channelManager.get(id) ? id : undefined;
  }

  private subjectScope(messageId: string, guildId: string | null, channelId: string): string | undefined {
    const mem = this.recentCreates.get(messageId);
    if (mem?.scope !== undefined) return mem.scope ?? undefined;
    return this.coalesceChannelScope(guildId, channelId);
  }

  private afterCreate(messageId: string, then: () => void): Promise<void> | void {
    const mem = this.recentCreates.get(messageId);
    if (mem && !mem.done) return mem.settled.then(then);
    then();
  }

  private async forwardMessageEdit(channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo): Promise<void> {
    if (!this.conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    if (!this.shouldEnterContext(channelId, { isDM, guildId: info?.guildId })) {
      dbg('handleMessageEdit:drop', { channelId, messageId, reason: this.isChannelMuted(channelId) ? 'muted' : 'not-open-or-subscribed' });
      return;
    }
    const admitted = this.conn;
    await this.afterCreate(messageId, () => this.sendMessageEdit(admitted, channelId, messageId, newContent, isDM, info));
  }

  private mutationConn(admitted: McplConnection): McplConnection | null {
    if (this.conn === admitted && !admitted.isClosed) return admitted;
    return this.readyNow();
  }

  private holdForHost(kind: 'edit' | 'delete', channelId: string, messageId: string, send: (conn: McplConnection) => void): void {
    void this.waitForHost(Date.now() + this.reconnectWaitMs).then((ready) => {
      if (typeof ready === 'string') {
        dbg(kind === 'edit' ? 'handleMessageEdit:drop' : 'handleMessageDelete:drop', { channelId, messageId, reason: 'no-ready-connection', why: ready });
        return;
      }
      send(ready);
    });
  }

  private sendMessageEdit(admitted: McplConnection, channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo): void {
    const conn = this.mutationConn(admitted);
    if (!conn) {
      this.holdForHost('edit', channelId, messageId, (ready) => this.sendMessageEdit(ready, channelId, messageId, newContent, isDM, info));
      return;
    }
    const registeredId = this.registerEventChannel(channelId, isDM, info);
    const scope = this.subjectScope(messageId, info?.guildId ?? null, channelId);
    const mem = this.recentCreates.get(messageId);
    const timestamp = info?.editedAt ?? new Date().toISOString();
    const who = info?.authorName ? `${nameValue(info.authorName)}: ` : '';
    // An edit may replace the unread create (RFC-006 §4.1), so it must be as self-contained as the create was.
    const render = this.hostCoalescing?.pushEvents ? mem?.render : undefined;
    const content: ContentBlock[] = render
      ? [textContent(`${render.prefix}${render.replyMarker}${render.location}${nameValue(render.authorName)} [edited]: ${senderText(info?.cleanContent ?? newContent)}`), ...render.attachments]
      : [textContent(`[message edited] ${who}${senderText(newContent)}`)];
    const params: CoalescedPushEventParams = {
      featureSet: 'discord.messaging',
      // The occurrence id (RFC-006 §3.1): a second edit of one message is a new
      // occurrence. The counter keeps two edits that share a millisecond distinct.
      eventId: `discord_edit_${messageId}_${timestamp}_${mem ? ++mem.edits : ++this.editSeq}`,
      timestamp,
      origin: this.messageEventOrigin(channelId, messageId, info, registeredId),
      tags: [
        'chat:edited',
        ...(info?.address ? addressTags(addressFlags(info.address, this.discord.botUserId), isDM, info.address.isBot) : []),
        ...threadTags(info ?? {}),
      ],
      payload: { content },
      // RFC-006: replace the unread original; append once it was read.
      ...(this.hostCoalescing?.pushEvents
        ? { coalesce: { key: `message:${messageId}`, ...(scope ? { channelId: scope } : {}) } }
        : {}),
    };
    this.noteMutationOutcome('edit', messageId, channelId, registeredId ?? channelId, registeredId, conn, params);
  }

  private async forwardMessageDelete(channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo): Promise<void> {
    if (!this.conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    if (!this.shouldEnterContext(channelId, { isDM, guildId: info?.guildId })) {
      dbg('handleMessageDelete:drop', { channelId, messageId, reason: this.isChannelMuted(channelId) ? 'muted' : 'not-open-or-subscribed' });
      return;
    }
    const admitted = this.conn;
    await this.afterCreate(messageId, () => this.sendMessageDelete(admitted, channelId, messageId, isDM, info));
  }

  private sendMessageDelete(admitted: McplConnection, channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo): void {
    const conn = this.mutationConn(admitted);
    if (!conn) {
      this.holdForHost('delete', channelId, messageId, (ready) => this.sendMessageDelete(ready, channelId, messageId, isDM, info));
      return;
    }
    const registeredId = this.registerEventChannel(channelId, isDM, info);
    const scope = this.subjectScope(messageId, info?.guildId ?? null, channelId);
    const timestamp = new Date().toISOString();
    const params: CoalescedPushEventParams = {
      featureSet: 'discord.messaging',
      eventId: `discord_delete_${messageId}_${timestamp}_${++this.editSeq}`,
      timestamp,
      origin: this.messageEventOrigin(channelId, messageId, info, registeredId),
      tags: ['chat:deleted', ...threadTags(info ?? {})],
      // The deletion notice (RFC-006 §6): a coalescing host leaves it out only when it knows no model read a version of the message.
      payload: { content: [textContent(`[message deleted] ${messageId}${info?.authorName ? ` by @${nameValue(info.authorName)}` : ''}`)] },
      ...(this.hostCoalescing?.pushEvents
        ? { coalesce: { key: `message:${messageId}`, retract: true, ...(scope ? { channelId: scope } : {}) } }
        : {}),
    };
    this.noteMutationOutcome('delete', messageId, channelId, registeredId ?? channelId, registeredId, conn, params);
  }

  private readonly dmNotices = new DmNoticeState({
    onInterrupted: (i) =>
      console.error(
        `[discord-mcpl] DM notice to sender ${i.authorId} for message ${i.messageId} (reserved ` +
          `${new Date(i.at).toISOString()}) was interrupted before its outcome was recorded; ` +
          'outcome unknown, not retried',
      ),
  });
  private dmNoticesOpening: Promise<void> | null = null;
  private sweepDecisionWaitMs = 30_000;

  async setupDmRefusals(): Promise<void> {
    this.discord.onDmRefused((ev) => {
      void this.handleDmRefusal(ev).settled;
    });
    this.dmNoticeState();
    await this.dmNoticesOpening;
  }

  private async awaitSweepDecisions(channelId: string, decided: Promise<unknown>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ranOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.sweepDecisionWaitMs);
    });
    const late = await Promise.race([Promise.allSettled(decided).then(() => false), ranOut]);
    clearTimeout(timer);
    if (late) {
      console.error(
        `[discord-mcpl] Catch-up moved past channel ${channelId} with refused DMs still being decided after ` +
          `${this.sweepDecisionWaitMs / 1000}s: the notice state's disk hasn't answered. They're decided when it does.`,
      );
    }
  }

  private dmNoticeState(): DmNoticeState {
    if (!this.dmNoticesOpening) {
      const override = process.env.DISCORD_DM_NOTICES_FILE?.trim();
      const botId = this.discord.botUserId;
      if (override || botId) {
        this.dmNoticesOpening = this.dmNotices.open(resolveDmNoticesPath(botId ?? '', process.env));
      }
    }
    return this.dmNotices;
  }

  private handleDmRefusal(ev: DmRefusal): { decided: Promise<DmNoticeDecision>; settled: Promise<void> } {
    const state = this.dmNoticeState();
    const decided = state.decide(ev.messageId, ev.authorId);
    const settled = decided
      .then(async (decision) => {
        let outcome: string = decision;
        if (decision === 'notify') {
          let result: 'sent' | 'failed' | 'unknown' = 'sent';
          let detail = '';
          try {
            // The nonce is the reservation's own identity: Discord answers a repeat within a few minutes with the message already made.
            await this.discord.sendDmNotice(ev.channelId, DM_NOTICE_TEXT, `dmn${ev.messageId}`);
          } catch (err) {
            // Only a definite rejection counts as failed: the send never started, or
            // Discord refused the request. A 5xx, a timeout or a lost connection may have
            // posted it, so it's unknown.
            const e = err as { notPosted?: unknown; message?: unknown };
            const rejected = e.notPosted === true || refusedByDiscord(err);
            result = rejected ? 'failed' : 'unknown';
            detail = `: ${String(e.message ?? err)}`;
          }
          const unsaved = await state.recordOutcome(ev.authorId, ev.messageId, result);
          outcome = `${result}${detail}${unsaved ? `; its outcome was not saved durably (${unsaved})` : ''}`;
        } else if (decision === 'suspended') {
          outcome = `suspended (${state.status().error ?? 'its reservation could not be made durable, so it was withdrawn'})`;
        }
        console.error(
          `[discord-mcpl] DM refused by the DM allowlist (${ev.origin}): sender ${ev.authorId}, ` +
            `message ${ev.messageId}; notice ${outcome}`,
        );
      })
      .catch((err) => {
        console.error(
          `[discord-mcpl] Handling the refused DM from sender ${ev.authorId} (message ${ev.messageId}) failed:`,
          (err as Error).message,
        );
      });
    return { decided, settled };
  }

  private setupDiscordForwarding(): void {
    this.discord.onMessage((msg) => {
      this.handleDiscordMessage(msg).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord message:', err);
      });
    });

    const acceptMutation = (channelId: string) => !this.isChannelMuted(channelId);
    this.discord.onMessageEdit((channelId, messageId, newContent, isDM, info) => {
      void this.forwardMessageEdit(channelId, messageId, newContent, isDM, info).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord edit:', err);
      });
    }, acceptMutation);

    this.discord.onMessageDelete((channelId, messageId, isDM, info) => {
      void this.forwardMessageDelete(channelId, messageId, isDM, info).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord delete:', err);
      });
    }, acceptMutation);

    this.discord.onReaction((ev) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      // A reaction in a thread names the thread in its origin but keeps the
      // reaction tags only, so a host gate rule keyed on chat:thread doesn't start
      // matching its reactions. SPEC §16.2 defines `chat:reaction` and
      // `chat:reaction-remove` as distinct tags.
      this.ensureReactionChannelsLoaded();
      if (!this.reactionChannels.has(ev.channelId)) return;
      if (this.isChannelMuted(ev.channelId)) {
        dbg('reaction:drop', { channelId: ev.channelId, messageId: ev.messageId, action: ev.action, reason: 'muted' });
        return;
      }
      if (
        this.filtersState.suppressAll() ||
        this.filtersState.isSuppressed({ emojiId: ev.emojiId ?? null, emoji: ev.emoji })
      ) {
        dbg('reaction:suppressed', {
          channelId: ev.channelId,
          messageId: ev.messageId,
          action: ev.action,
        });
        return;
      }
      const verb = ev.action === 'add' ? 'reacted' : 'removed a reaction';
      const target = ev.onOwnMessage ? 'your message' : `message ${ev.messageId}`;
      const quoted = ev.messageSnippet ? ` — ${senderText(ev.messageSnippet)}` : '';
      const line = `[reaction] @${nameValue(ev.userName)} ${verb} ${ev.emoji} on ${target}${quoted}`;
      const reactionChannelId = mcplChannelId(ev.guildId ?? 'dm', ev.channelId);
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_reaction_${ev.action}_${ev.messageId}_${ev.emojiId ?? ev.emoji}_${ev.userId}_${ev.timestamp.getTime()}`,
        timestamp: ev.timestamp.toISOString(),
        origin: {
          source: 'discord',
          channelId: ev.channelId,
          messageId: ev.messageId,
          guildId: ev.guildId,
          ...(this.channelManager.get(reactionChannelId) ? { mcplChannelId: reactionChannelId } : {}),
          reactorId: ev.userId,
          reactorName: ev.userName,
          emoji: ev.emoji,
          emojiToken: ev.token,
          onOwnMessage: ev.onOwnMessage,
          action: ev.action,
          ...threadFields(ev),
        } as Record<string, unknown>,
        tags: [ev.action === 'add' ? 'chat:reaction' : 'chat:reaction-remove'],
        payload: { content: [textContent(line)] },
      } satisfies PushEventParams).catch(() => {});
    });

    this.discord.onChannelCreate((channel) => {
      this.registerChannels([this.guildDescriptor(channel)]);
      this.rederiveNamed({ name: channel.name });
    });

    this.discord.onChannelUpdate((channel, change) => {
      const id = mcplChannelId(channel.guildId, channel.id);
      if (!change.admitted) {
        const gone = [id, ...this.registeredThreadsOf(channel.id).filter((d) => !this.admitted(d)).map((d) => d.id)];
        this.forgetChannels(gone.filter((g) => this.channelManager.get(g)));
      } else if (isListedKind(channel.type)) {
        this.registerChannels([this.guildDescriptor(channel)]);
      }
      if (change.addressChanged) {
        this.rederiveChannels(this.registeredThreadsOf(channel.id));
        this.rederiveNamed({ name: channel.name });
      }
    });

    // channelCreate covers only channels created after the join, so a new guild's existing channels are registered here.
    this.discord.onGuildCreate((guildId, channels) => {
      const { added } = this.registerChannels(channels.map((c) => this.guildDescriptor(c)));
      this.rederiveNamed('every');
      dbg('onGuildCreate', { guildId, total: channels.length, added: added.length });
    });

    this.discord.onGuildDelete((guildId) => {
      this.forgetChannels(this.registeredInGuild(guildId).map((d) => d.id));
      this.rederiveNamed('every');
    });

    // Discord doesn't replay what happened while a guild was away.
    this.discord.onGuildAvailable((guildId, channels, present) => this.guildReturned(guildId, channels, present));

    this.discord.onGuildRename((guildId) => {
      this.rederiveChannels(this.registeredInGuild(guildId));
      this.rederiveNamed('every');
    });

    this.discord.onThreadUpdate((thread) => this.threadReported(thread));

    this.discord.onChannelStale((channelId) => {
      const registered = this.channelManager.getAll()
        .filter((d) => (d.address as { channelId?: string } | undefined)?.channelId === channelId);
      if (registered.length > 0) this.rederiveChannels(registered);
      this.rederiveNamed('every');
    });

    this.discord.onChannelDelete((guildId, channelId, threadIds) => this.channelDeleted(guildId, channelId, threadIds));
    this.discord.onThreadDelete((guildId, threadId) => this.channelDeleted(guildId, threadId));
    // Discord's thread sync covers the channels it names, or the whole guild when it names none.
    this.discord.onThreadsSynced((guildId, covered, listed, dropped) => {
      const channelOf = (d: ChannelDescriptor) => (d.address as { channelId: string }).channelId;
      const threads = this.registeredInGuild(guildId)
        .filter((d) => (d.metadata as { channelType?: string } | undefined)?.channelType === 'thread');
      const omitted = (d: ChannelDescriptor): boolean => {
        if (listed.has(channelOf(d))) return false;
        const parentId = (d.metadata as { parentId?: string } | undefined)?.parentId;
        return covered === null || dropped.has(channelOf(d)) || (parentId !== undefined && covered.has(parentId));
      };
      this.forgetChannels(threads.filter(omitted).map((d) => d.id));
      for (const d of threads) {
        if (!listed.has(channelOf(d))) continue;
        const facts = this.discord.getCachedChannelFacts(channelOf(d));
        if (facts) this.threadReported(facts);
      }
    });
    this.discord.onChannelRefreshed((channelId) => {
      const facts = this.discord.getCachedChannelFacts(channelId);
      if (!facts) return;
      const id = mcplChannelId(facts.guildId, channelId);
      const admitted = this.discord.channelAdmitted(facts.guildId, channelId, facts.parentId ?? null);
      if (facts.type === 'thread') {
        this.threadReported(facts);
        return;
      }
      if (!admitted) {
        const gone = [id, ...this.registeredThreadsOf(channelId).filter((d) => !this.admitted(d)).map((d) => d.id)];
        this.forgetChannels(gone.filter((g) => this.channelManager.get(g)));
      } else if (isListedKind(facts.type)) {
        this.registerChannels([this.guildDescriptor(facts)]);
      }
      this.rederiveChannels(this.registeredThreadsOf(channelId));
      this.rederiveNamed({ name: facts.name });
    });
  }

  /** Images are inlined as base64 because Discord's CDN URLs expire. */
  private async buildAttachmentBlocks(attachments: DiscordAttachment[]): Promise<ContentBlock[]> {
    const TEXT_EXT =
      /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|bash|zsh|toml|ini|cfg|conf|sql|diff|patch|env)$/i;
    const fmt = (n: number) =>
      n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
    const fetchWithTimeout = async (url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        return await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    const fetchTextCapped = async (
      url: string,
      maxBytes: number,
      ms = FETCH_TIMEOUT_MS,
    ): Promise<{ text: string; overflow: boolean; bytesRead: number }> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new HttpStatusError(res.status);
        if (!res.body) {
          return { text: '', overflow: true, bytesRead: 0 };
        }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let retained = 0;
        let bytesRead = 0;
        let overflow = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.length;
          const room = maxBytes + 1 - retained;
          const take = value.length > room ? value.subarray(0, room) : value;
          chunks.push(take);
          retained += take.length;
          if (retained > maxBytes) {
            overflow = true;
            break;
          }
        }
        if (overflow) {
          void reader.cancel().catch(() => {});
          return { text: '', overflow: true, bytesRead };
        }
        return { text: Buffer.concat(chunks).toString('utf8'), overflow: false, bytesRead };
      } finally {
        clearTimeout(timer);
      }
    };

    const AGGREGATE_FETCH_BUDGET = 40 * 1024 * 1024;
    let fetchBudgetLeft = AGGREGATE_FETCH_BUDGET;

    const multiSnapshot = attachments.some((a) => (a.forwardedSnapshotIndex ?? 0) > 1);
    const fwd = (att: DiscordAttachment) =>
      att.forwardedSnapshotIndex === undefined
        ? ''
        : multiSnapshot ? ` (forwarded #${att.forwardedSnapshotIndex})` : ' (forwarded)';

    // A Discord CDN URL is signed and stops working at its `ex` time, so each
    // marker says when, and the message says once how to get a fresh one.
    let linksExpire = false;
    const link = (att: DiscordAttachment) => {
      const url = urlValue(att.url);
      const expiry = attachmentUrlExpiry(att.url);
      if (!expiry) return url;
      linksExpire = true;
      return `${url} (link expires ${expiry.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
    };

    const inlineCap = this.attachmentInlineMaxBytes;
    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      const name = nameValue(att.name);
      const ct = (att.contentType || '').toLowerCase();
      const isImage = ct.startsWith('image/');
      const isText =
        ct.startsWith('text/') ||
        TEXT_EXT.test(att.name) ||
        (att.contentType === null && att.size > 0 && att.size <= MAX_TEXT_BYTES);
      try {
        if (!isImage && isText && att.size > inlineCap) {
          blocks.push(textContent(
            `[attachment: ${name}${fwd(att)} (${fmt(att.size)}) over the ${fmt(inlineCap)} inline cap — not inlined: ${link(att)}]`,
          ));
          dbg('attachment:over-inline-cap', { name: att.name, declaredSize: att.size, cap: inlineCap });
        } else if ((isImage || isText) && att.size > fetchBudgetLeft) {
          blocks.push(textContent(
            `[attachment: ${name}${fwd(att)} (${fmt(att.size)}) not inlined — message attachment budget exhausted: ${link(att)}]`,
          ));
          dbg('attachment:budget-exhausted', { name: att.name, size: att.size, budgetLeft: fetchBudgetLeft });
        } else if (isImage) {
          if (att.size > IMAGE_FETCH_CEILING) {
            blocks.push(textContent(`[image attachment ${name}${fwd(att)} (${fmt(att.size)}) too large to fetch — ${link(att)}]`));
          } else {
            fetchBudgetLeft -= att.size;
            const res = await fetchWithTimeout(att.url);
            if (!res.ok) throw new HttpStatusError(res.status);
            const raw = Buffer.from(await res.arrayBuffer());
            const norm = await normalizeImageForInference(raw, att.contentType);
            if (norm) {
              blocks.push({ type: 'image', data: norm.data, mimeType: norm.mimeType } as ContentBlock);
              blocks.push(textContent(`[image attachment: ${name}${fwd(att)} — ${link(att)}]`));
            } else {
              blocks.push(textContent(`[image attachment ${name}${fwd(att)} (${fmt(att.size)}) could not be inlined — ${link(att)}]`));
            }
          }
        } else if (isText) {
          // Charged from the bytes actually read: Discord's declared size is advisory.
          const { text, overflow, bytesRead } = await fetchTextCapped(att.url, inlineCap);
          fetchBudgetLeft -= bytesRead;
          if (overflow) {
            blocks.push(textContent(
              `[attachment: ${name}${fwd(att)} (over the ${fmt(inlineCap)} inline cap; declared ${fmt(att.size)}) — not inlined: ${link(att)}]`,
            ));
            dbg('attachment:over-inline-cap', {
              name: att.name,
              declaredSize: att.size,
              cap: inlineCap,
              misdeclared: true,
            });
          } else {
            blocks.push(textContent(`[attachment: ${name}${fwd(att)} (${fmt(att.size)}) — ${link(att)}]\n  ${senderText(text)}`));
          }
        } else {
          blocks.push(textContent(`[attachment: ${name}${fwd(att)} (${mediaTypeValue(ct)}, ${fmt(att.size)}) — not inlined: ${link(att)}]`));
        }
        dbg('attachment', {
          name: att.name,
          contentType: att.contentType,
          size: att.size,
          kind: isImage ? 'image' : isText ? 'text' : 'other',
        });
      } catch (err) {
        const why = !URL.canParse(att.url)
          ? "the link isn't a valid URL"
          : err instanceof HttpStatusError
            ? `HTTP ${err.status}`
            : (err as { name?: unknown } | null)?.name === 'AbortError'
              ? `not fetched within ${FETCH_TIMEOUT_MS / 1000} s`
              : errorValue(err);
        blocks.push(textContent(`[attachment: ${name}${fwd(att)} — could not fetch (${why}); ${link(att)}]`));
        dbg('attachment:failed', { name: att.name, error: why });
      }
    }
    if (linksExpire) {
      blocks.push(textContent('[Attachment links expire as marked; fetching the message again gives fresh links.]'));
    }
    return blocks;
  }

  private rememberCreate(messageId: string): CreateMemory {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    const mem: CreateMemory = { settled, resolve: () => { mem.done = true; resolve(); }, done: false, edits: 0 };
    this.recentCreates.set(messageId, mem);
    while (this.recentCreates.size > RECENT_CREATES_MAX) {
      let evicted = false;
      for (const [id, m] of this.recentCreates) {
        if (m.done) {
          this.recentCreates.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
    return mem;
  }

  private async handleDiscordMessage(msg: DiscordMessageData): Promise<void> {
    const mem = this.rememberCreate(msg.id);
    try {
      await this.forwardDiscordMessage(msg, mem);
    } finally {
      mem.resolve();
    }
  }

  private async forwardDiscordMessage(msg: DiscordMessageData, mem: CreateMemory): Promise<void> {
    const conn = this.conn;
    dbg('handleDiscordMessage:enter', {
      msgId: msg.id,
      guildId: msg.guildId,
      channelId: msg.channelId,
      channelName: msg.channelName,
      authorId: msg.authorId,
      isBot: msg.isBot,
      mentions: msg.mentions,
      contentPreview: msg.content.slice(0, 80),
      hasConn: !!conn,
      mcplEnabled: this.mcplEnabled,
      enabledSets: [...this.enabledFeatureSets],
      botUserId: this.discord.botUserId,
    });
    if (msg.content.startsWith(CHX_NOOP_PREFIX)) {
      dbg('handleDiscordMessage:drop', { reason: 'chx-noop', msgId: msg.id });
      return;
    }
    if (!conn) { dbg('handleDiscordMessage:drop', { reason: 'no-conn' }); return; }

    if (!this.mcplEnabled) { dbg('handleDiscordMessage:drop', { reason: 'mcpl-disabled' }); return; }

    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) {
      dbg('handleDiscordMessage:drop', { reason: 'discord.messaging-disabled', enabled: [...this.enabledFeatureSets] });
      return;
    }

    if (this.isChannelMuted(msg.channelId)) {
      dbg('handleDiscordMessage:drop', { reason: 'muted', channelId: msg.channelId });
      return;
    }

    const botId = this.discord.botUserId;
    const isDM = msg.guildId === null;
    const flags = addressFlags(msg, botId);
    const { isExplicitMention, isReplyToBot, isMention } = flags;
    const isBot = msg.isBot;
    if (!this.shouldEnterContext(msg.channelId, { isMention, isDM, guildId: msg.guildId })) {
      this.ensureWatermarkLoaded();
      const tally = this.missedTally.get(msg.channelId);
      if (
        tally &&
        msg.authorId !== botId &&
        !msg.content.startsWith(CHX_NOOP_PREFIX)
      ) {
        tally.messages += 1;
        tally.characters += msg.cleanContent.length;
        tally.talliedThrough = msg.id;
        this.saveWatermark();
      }
      dbg('handleDiscordMessage:drop', {
        reason: 'ambient-not-subscribed',
        channelId: msg.channelId,
        channelName: msg.channelName,
        tracked: !!tally,
      });
      return;
    }

    this.ensureSubscriptionsLoaded();
    this.ensureWatermarkLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.channelId);
    let prefixBlock = '';
    if (isFirstInteraction && isDM) {
      const watermark = this.forwardedWatermark.get(msg.channelId);
      let backscrollMsgs: Awaited<ReturnType<typeof this.discord.fetchHistory>> = [];
      try {
        backscrollMsgs = await this.discord.fetchHistory(msg.channelId, {
          limit: this.backscrollLimitFor(msg.channelId),
          before: msg.id,
          ...(watermark ? { after: watermark } : {}),
        });
        // discord.js returns history newest-first.
        backscrollMsgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        backscrollMsgs = backscrollMsgs.filter(
          (m) => m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX),
        );
      } catch (err) {
        dbg('backscroll:fetch-failed', {
          channelId: msg.channelId,
          error: (err as Error).message,
        });
      }

      const blocks: string[] = [];
      blocks.push(
        `<system>Direct message from @${nameValue(msg.authorName)} (user id ${msg.authorId}). ` +
          `To reply, use send_dm(${quotedLabel(msg.authorName)}, content="your message") — or ` +
          `send_dm("${msg.authorId}", content="your message") if the name is ambiguous. ` +
          `The message text always travels in the "content" parameter; a send_dm with ` +
          `only userId sends nothing. DMs always reach you; there is nothing to subscribe to.</system>`,
      );
      if (backscrollMsgs.length > 0) {
        const open = `<backscroll dm="true" count="${backscrollMsgs.length}">`;
        const lines = backscrollMsgs.map((m) => {
          const ts = formatAgentDateTime(m.timestamp, AGENT_TIME_ZONE, AGENT_TIMESTAMP_STYLE);
          const att = m.attachments && m.attachments.length > 0
            ? ` [attachments: ${m.attachments.map((a) => nameValue(a.name)).join(', ')}]`
            : '';
          return `${ts ? `[${ts}] ` : ''}${nameValue(m.authorName)}${att}${this.renderReactionState(m.reactions)}: ${senderText(m.cleanContent)}`;
        });
        blocks.push([open, ...lines, '</backscroll>'].join('\n'));
      }
      if (blocks.length > 0) {
        prefixBlock = blocks.join('\n') + '\n';
        dbg('backscroll:emitted', {
          channelId: msg.channelId,
          backscrollCount: backscrollMsgs.length,
          autoSubscribed: false,
        });
      }
    }

    const guildId = msg.guildId ?? 'dm';
    const channelMcplId = mcplChannelId(guildId, msg.channelId);

    const contextChanged = this.lastChannelId !== msg.channelId;
    let location = '';
    if (contextChanged) {
      // Discord-chosen names, rendered by the header rule (source-header.ts). A
      // text channel's name never has a space, but a voice, stage or forum
      // channel's can, so a channel name with a space is quoted.
      const locationParts: string[] = [];
      const place = messagePlace(msg.channelName, msg);
      if (place.channel) {
        locationParts.push(`#${/\s/.test(place.channel) ? quotedLabel(place.channel) : headerValue(place.channel)}`);
      }
      if (place.thread) locationParts.push(`thread ${quotedLabel(place.thread)}`);
      if (msg.guildName) locationParts.push(`in ${headerValue(msg.guildName)}`);
      else if (msg.guildId === null) locationParts.push('DM');
      if (locationParts.length > 0) location = `[${locationParts.join(' ')}] `;
    }
    const replyMarker = msg.replyToId
      ? `[replying to ${msg.replyToUserName ? `@${nameValue(msg.replyToUserName)}` : 'unknown author'}]\n`
      : '';
    const renderedContent = `${prefixBlock}${replyMarker}${location}${nameValue(msg.authorName)}: ${senderText(msg.cleanContent)}`;
    if (isDM || !this.deletedLately(guildId, msg.channelId)) this.forwardedWatermark.set(msg.channelId, msg.id);
    if (isDM) this.dmChannelIds.add(msg.channelId);
    this.saveWatermark();
    this.lastChannelId = msg.channelId;
    this.lastInboundMessageId = msg.id;

    const attachmentBlocks =
      msg.attachments.length > 0 ? await this.buildAttachmentBlocks(msg.attachments) : [];

    const guildDelivery = isDM
      ? undefined
      : this.registerGuildDelivery(guildId, msg.channelId, { postedAt: msg.timestamp.getTime() });
    const registeredId = guildDelivery
      ? guildDelivery.id
      : this.registerDmDelivery(msg.channelId, { id: msg.authorId, name: msg.authorName });
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);
    dbg('handleDiscordMessage:forwarding', {
      channelMcplId,
      registeredId,
      channelIsOpen,
      path: channelIsOpen ? 'channels/incoming' : 'push/event',
    });

    // MCPL RFC-001 event tags, umbrellas included, so a host needs no
    // implication expansion. The host's wake gate routes on these.
    const eventTags: string[] = (() => {
      const t = new Set<string>(addressTags(flags, isDM, isBot));
      for (const tag of threadTags(msg)) t.add(tag);
      for (const a of msg.attachments) {
        const ct = (a.contentType || '').toLowerCase();
        if (ct.startsWith('image/')) t.add('chat:has-image');
        else if (ct.startsWith('audio/')) t.add('chat:has-audio');
        else t.add('chat:has-file');
      }
      return [...t];
    })();

    mem.render = {
      prefix: prefixBlock, replyMarker, location, authorName: msg.authorName,
      attachments: rememberedAttachments(attachmentBlocks),
    };

    if (channelIsOpen) {
      // channels/incoming is channel scope by definition (RFC-006 §3.2).
      mem.scope = channelMcplId;
      const message: CoalescedIncomingMessage = {
          channelId: channelMcplId,
          messageId: msg.id,
          // RFC-006: the create is the subject's first occurrence (`initial`), keyed by
          // the platform message id, so later edits and deletes, which arrive as
          // push/event, address the same subject.
          ...(this.hostCoalescing?.channelsIncoming
            ? { eventId: `discord_msg_${msg.id}`, coalesce: { key: `message:${msg.id}`, initial: true } }
            : {}),
          // No MCPL threadId: it means a thread WITHIN the channel, and a
          // Discord thread is its own channel, already named by channelId.
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: [textContent(renderedContent), ...attachmentBlocks],
          metadata: {
            mentions: msg.mentions,
            replyTo: msg.replyToId,
            replyToAuthorId: msg.replyToUserId ?? undefined,
            replyToAuthorName: msg.replyToUserName ?? undefined,
            channelName: msg.channelName,
            guildName: msg.guildName,
            ...threadFields(msg),
            rawContent: msg.content,
            isMention,
            isExplicitMention,
            isReplyToBot,
            isBot,
            isDM,
          },
          tags: eventTags,
      };
      await this.deliverCreate({
        lane: 'channels/incoming',
        conn,
        coalesced: (message as { coalesce?: unknown }).coalesce !== undefined,
        channel: channelMcplId,
        discordChannelId: msg.channelId,
        fits: () => 'it went through a channel a previous host opened, and channels/incoming goes only to the host that opened it',
        messageId: msg.id,
        channelMcplId,
        content: message.content,
        attachmentBlocks,
        mem,
        send: async (conn, content, resend) => {
          const params: ChannelsIncomingParams = {
            messages: [{
              ...message,
              content,
              // The host validates an item before its coalescer accepts it, so a refused
              // item has no receipt or subject; a fresh occurrence id keeps the resend
              // clear of any dedup keyed on the first one.
              ...(resend && message.eventId ? { eventId: `${message.eventId}_media_omitted` } : {}),
            } as CoalescedIncomingMessage],
          };
          try {
            return incomingOutcome(await conn.sendRequest(method.CHANNELS_INCOMING, params), msg.id);
          } catch (err) {
            return sendErrorOutcome(err);
          }
        },
      });
    } else {
      const missed = this.missedTally.get(msg.channelId);
      const closedNote = guildDelivery ? this.closedChannelNote(guildId, msg.channelId, guildDelivery) : '';
      const scope = this.coalesceChannelScope(msg.guildId, msg.channelId);
      mem.scope = scope ?? null;
      const pushParams: CoalescedPushEventParams = {
        featureSet: 'discord.messaging',
        eventId: `discord_msg_${msg.id}`,
        // RFC-006: channel-scoped when the host accepts that and the channel is
        // declared, so an edit or delete addresses the same subject whichever lane
        // delivered the create.
        ...(this.hostCoalescing?.pushEvents
          ? { coalesce: { key: `message:${msg.id}`, initial: true, ...(scope ? { channelId: scope } : {}) } }
          : {}),
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'discord',
          messageId: msg.id,
          guildId: msg.guildId,
          guildName: msg.guildName,
          channelId: msg.channelId,
          // The MCPL composite channel id, the form the host registers and routes replies to.
          ...(registeredId ? { mcplChannelId: registeredId } : {}),
          channelName: msg.channelName,
          ...threadFields(msg),
          authorId: msg.authorId,
          authorName: msg.authorName,
          replyTo: msg.replyToId,
          replyToAuthorId: msg.replyToUserId ?? undefined,
          replyToAuthorName: msg.replyToUserName ?? undefined,
          isMention,
          isExplicitMention,
          isReplyToBot,
          isBot,
          isDM,
          ...(missed
            ? { missedMessages: missed.messages, missedCharacters: missed.characters }
            : {}),
        } as Record<string, unknown>,
        tags: eventTags, // MCPL RFC-001 — the host routes/gates on these
        payload: {
          content: [textContent(`${closedNote}${renderedContent}`), ...attachmentBlocks],
        },
      };

      await this.deliverCreate({
        lane: 'push/event',
        conn,
        coalesced: pushParams.coalesce !== undefined,
        channel: registeredId,
        discordChannelId: msg.channelId,
        fits: () => pushFits(pushParams, this.hostCoalescing),
        messageId: msg.id,
        channelMcplId,
        content: pushParams.payload.content,
        attachmentBlocks,
        mem,
        send: async (conn, content, resend) => {
          const params: CoalescedPushEventParams = {
            ...pushParams,
            ...(resend ? { eventId: `${pushParams.eventId}_media_omitted` } : {}),
            payload: { content },
          };
          try {
            return pushOutcome(await conn.sendRequest(method.PUSH_EVENT, params as unknown as Record<string, unknown>));
          } catch (err) {
            return sendErrorOutcome(err);
          }
        },
      });
    }
  }

  private async deliverCreate(args: {
    lane: 'channels/incoming' | 'push/event';
    conn: McplConnection;
    coalesced: boolean;
    channel: string | undefined;
    discordChannelId: string;
    fits: () => string | undefined;
    messageId: string;
    channelMcplId: string;
    content: ContentBlock[];
    attachmentBlocks: ContentBlock[];
    mem: CreateMemory;
    send: (conn: McplConnection, content: ContentBlock[], resend: boolean) => Promise<SendOutcome>;
  }): Promise<void> {
    const { lane, coalesced, channel, fits, discordChannelId, messageId, channelMcplId, content, attachmentBlocks, mem, send } = args;
    const { outcome: first, conn } = await this.sendWithRetries({
      lane, coalesced, channel, fits, conn: args.conn,
      what: `message ${messageId} in ${channelMcplId}`,
      dbgPrefix: 'handleDiscordMessage',
      attempt: (c) => send(c, content, false),
    });
    if (first.kind === 'failed') {
      console.error(`[discord-mcpl] ${lane} failed:`, first.error);
      dbg('handleDiscordMessage:send-failed', { method: lane, error: first.error });
      this.owe(discordChannelId, messageId, { uncertain: true });
      return;
    }
    if (first.kind !== 'rejected') {
      dbg('handleDiscordMessage:sent', { method: lane, channelMcplId, result: first.kind });
      this.owedFollow(conn, discordChannelId);
      return;
    }
    // channels/incoming answers each message without a code, so there the host's
    // own failure ("host is stopping", say) reads the same as a refusal.
    const verb = (code: number | undefined) => (lane === 'channels/incoming' && code === undefined ? "didn't take" : 'rejected');
    const attachments = summarizeAttachments(content);
    console.error(`[discord-mcpl] host ${verb(first.code)} message ${messageId} in ${channelMcplId}: ${first.reason}`);
    dbg('handleDiscordMessage:rejected', {
      method: lane, messageId, channelMcplId, reason: first.reason,
      ...(first.code !== undefined ? { code: first.code } : {}),
      attachments,
    });
    if (answerClass(first) === 'refused') this.owe(discordChannelId, messageId, { uncertain: false });
    if (!isContentRejection(first) || attachments.inline === 0) return;

    const stripped = withoutInlineMedia(content);
    if (mem.render) mem.render.attachments = rememberedAttachments(withoutInlineMedia(attachmentBlocks).content);
    const { outcome: second } = await this.sendWithRetries({
      lane, coalesced, channel, fits, conn,
      what: `message ${messageId} in ${channelMcplId} (resent without inline media)`,
      dbgPrefix: 'handleDiscordMessage',
      attempt: (c) => send(c, stripped.content, true),
    });
    const what = `message ${messageId} in ${channelMcplId} with ${stripped.replaced} inline attachment(s) replaced by a note`;
    if (second.kind === 'failed') {
      console.error(`[discord-mcpl] resent ${what}: send failed: ${second.error}`);
      dbg('handleDiscordMessage:resend-failed', { method: lane, messageId, channelMcplId, error: second.error });
      this.owe(discordChannelId, messageId, { uncertain: true });
    } else if (second.kind === 'rejected') {
      console.error(`[discord-mcpl] resent ${what}: host ${verb(second.code)} it again: ${second.reason}`);
      if (answerClass(second) === 'refused') this.owe(discordChannelId, messageId, { uncertain: false });
      dbg('handleDiscordMessage:resend-rejected', {
        method: lane, messageId, channelMcplId, reason: second.reason,
        ...(second.code !== undefined ? { code: second.code } : {}),
      });
    } else {
      console.error(`[discord-mcpl] resent ${what}: ${second.kind === 'accepted' ? 'accepted' : 'sent (no verdict)'}`);
      this.owedFollow(conn, discordChannelId);
      dbg('handleDiscordMessage:resent', { method: lane, messageId, channelMcplId, replaced: stripped.replaced, result: second.kind });
    }
  }

  private owedFollow(conn: McplConnection, discordChannelId: string): void {
    if (!this.owed.has(discordChannelId)) return;
    void this.deliverOwedIn(conn, discordChannelId, 'live').catch((err) => {
      console.error('[discord-mcpl] Delivering owed messages failed:', errorText(err));
    });
  }

  /** RFC-006 §3.1's retry window: what the host advertises, or the spec's
   *  default hour, when it advertises event coalescing for the lane. */
  private retryWindowFor(lane: 'channels/incoming' | 'push/event'): number | undefined {
    const c = this.hostCoalescing;
    const coalesces = lane === 'channels/incoming' ? c?.channelsIncoming : c?.pushEvents;
    return coalesces ? (this.hostRetryWindowMs ?? DEFAULT_RETRY_WINDOW_MS) : undefined;
  }

  private markReady(conn: McplConnection): void {
    if (this.conn !== conn || conn.isClosed) return;
    this.readyConn = conn;
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const wake of waiters) wake();
  }

  private readyNow(): McplConnection | null {
    const conn = this.conn;
    if (!conn || conn !== this.readyConn || conn.isClosed) return null;
    if (!this.mcplEnabled || !isEnabled('discord.messaging', this.enabledFeatureSets)) return null;
    return conn;
  }

  private async readyConnection(deadline: number): Promise<McplConnection | string> {
    for (;;) {
      const conn = this.readyNow();
      if (conn) return conn;
      const current = this.conn;
      if (current && current === this.readyConn && !current.isClosed) {
        return "the host connected now doesn't take Discord messages";
      }
      const left = deadline - Date.now();
      if (left <= 0) return 'no host connection was ready in time';
      await new Promise<void>((resolve) => {
        const wake = (): void => { clearTimeout(timer); this.readyWaiters.delete(wake); resolve(); };
        // Not unref'd: the wait is bounded by the deadline, and a stdio server exits when its host goes.
        const timer = setTimeout(wake, left);
        this.readyWaiters.add(wake);
      });
    }
  }

  private async waitForHost(deadline: number): Promise<McplConnection | string> {
    const now = this.readyNow();
    if (now) return now;
    if (this.waitingForHost >= this.maxWaitingForHost) {
      return `as many messages as may wait for a host (${this.maxWaitingForHost}) already are`;
    }
    this.waitingForHost++;
    try {
      return await this.readyConnection(deadline);
    } finally {
      this.waitingForHost--;
    }
  }

  private reannounceChannel(conn: McplConnection, id: string): boolean {
    const descriptor = this.channelManager.get(id);
    if (!descriptor || conn.isClosed) return false;
    conn.sendNotification(method.CHANNELS_CHANGED, { added: [descriptor] });
    return true;
  }

  /**
   * RFC-006 §3.1 obliges a host that advertises event coalescing to recognize
   * a repeated eventId for its retry window and return the first result
   * without repeating its effects, so an occurrence admitted after all is
   * never admitted twice; other hosts promise less (the base spec's
   * deduplication is a SHOULD, §9.4). §3.1 limits resends to the window, the
   * shortest advertised meanwhile; half of it leaves room for a slow last
   * answer. The guarantee survives reconnects and host restarts; only the TCP
   * transport reconnects, as a stdio server exits with its host.
   */
  private async sendWithRetries(args: {
    lane: 'channels/incoming' | 'push/event';
    what: string;
    dbgPrefix: 'handleDiscordMessage' | 'handleMessageMutation';
    conn: McplConnection;
    coalesced: boolean;
    channel: string | undefined;
    attempt: (conn: McplConnection) => Promise<SendOutcome>;
    superseded?: () => boolean;
    fits?: () => string | undefined;
  }): Promise<{ outcome: SendOutcome | { kind: 'superseded' }; conn: McplConnection }> {
    const { lane, what, dbgPrefix, coalesced, channel, attempt, superseded, fits } = args;
    let conn = args.conn;
    const firstSentAt = Date.now();
    let windowMs = this.retryWindowFor(lane);
    let sentBeforeReady = conn !== this.readyConn;
    let outcome = await attempt(conn);
    let resends = 0;
    let refusals = 0;
    let announced = false;
    let notYetResent = false;
    const said = (o: SendOutcome): string => describeOutcome(o, lane);
    const notResent = (why: string): void => {
      console.error(`[discord-mcpl] ${what}: ${said(outcome)}; not sent again: ${why}`);
      dbg(`${dbgPrefix}:not-resent`, { method: lane, what, result: outcome.kind, why });
    };
    for (;;) {
      const answer = answerClass(outcome);
      if (answer === 'done') return { outcome, conn };
      if (superseded?.()) {
        if (answer === 'final') return { outcome, conn };
        notResent('a later edit or delete of the message has been sent since');
        return { outcome: { kind: 'superseded' }, conn };
      }
      if (answer === 'final') {
        if (!sentBeforeReady || notYetResent || !isAuthorityRefusal(outcome)) return { outcome, conn };
        notYetResent = true;
        const ready = await this.waitForHost(Date.now() + this.reconnectWaitMs);
        if (typeof ready === 'string') {
          notResent(ready);
          return { outcome, conn };
        }
        if (superseded?.()) {
          notResent('a later edit or delete of the message has been sent since');
          return { outcome: { kind: 'superseded' }, conn };
        }
        const misfit = ready !== conn ? fits?.() : undefined;
        if (misfit) {
          notResent(misfit);
          return { outcome, conn };
        }
        console.error(`[discord-mcpl] ${what}: ${said(outcome)}, before the host's start-up had settled; sending the same occurrence again now that it has`);
        dbg(`${dbgPrefix}:resend`, { method: lane, what, answer: 'not-yet' });
        conn = ready;
        sentBeforeReady = false;
        outcome = await attempt(conn);
        console.error(`[discord-mcpl] sent ${what} again (same event id): ${said(outcome)}`);
        continue;
      }
      if (answer === 'unknown-channel') {
        if (announced || channel === undefined || !this.reannounceChannel(conn, channel)) return { outcome, conn };
        announced = true;
        console.error(`[discord-mcpl] ${what}: ${said(outcome)}; announced channel ${channel} to the host again, and sending the same occurrence again`);
        dbg(`${dbgPrefix}:resend`, { method: lane, what, answer, channel });
        sentBeforeReady = conn !== this.readyConn;
        outcome = await attempt(conn);
        console.error(`[discord-mcpl] sent ${what} again (same event id): ${said(outcome)}`);
        continue;
      }
      if (!coalesced || windowMs === undefined) return { outcome, conn };
      if (answer === 'refused' && ++refusals > 1) return { outcome, conn };
      if (resends >= this.retryDelaysMs.length) {
        notResent(`sent ${resends + 1} times`);
        return { outcome, conn };
      }
      const deadline = firstSentAt + windowMs / 2;
      const wait = this.retryDelaysMs[resends];
      if (Date.now() + wait > deadline) {
        notResent("the host's retry window is closing");
        return { outcome, conn };
      }
      console.error(`[discord-mcpl] ${what}: ${said(outcome)}; sending the same occurrence again (same event id) in ${wait}ms`);
      dbg(`${dbgPrefix}:resend-wait`, { method: lane, what, answer, waitMs: wait, resend: resends + 1 });
      await sleep(wait);
      if (superseded?.()) {
        notResent('a later edit or delete of the message has been sent since');
        return { outcome: { kind: 'superseded' }, conn };
      }
      const next = await this.waitForHost(Math.min(deadline, Date.now() + this.reconnectWaitMs));
      if (typeof next === 'string') {
        notResent(next);
        return { outcome, conn };
      }
      const nextWindow = this.retryWindowFor(lane);
      if (nextWindow === undefined) {
        notResent("the host now connected doesn't coalesce events, so the same occurrence sent again could be a duplicate");
        return { outcome, conn };
      }
      windowMs = Math.min(windowMs, nextWindow);
      if (superseded?.()) {
        notResent('a later edit or delete of the message has been sent since');
        return { outcome: { kind: 'superseded' }, conn };
      }
      const moved = next !== conn;
      const misfit = moved ? fits?.() : undefined;
      if (misfit) {
        notResent(misfit);
        return { outcome, conn };
      }
      conn = next;
      resends++;
      sentBeforeReady = false;
      outcome = await attempt(conn);
      console.error(`[discord-mcpl] sent ${what} again (same event id${moved ? ', to the host connected since' : ''}): ${said(outcome)}`);
      dbg(`${dbgPrefix}:resent-same`, { method: lane, what, result: outcome.kind, resend: resends, newConnection: moved });
    }
  }

  private noteMutationOutcome(
    kind: 'edit' | 'delete',
    messageId: string,
    discordChannelId: string,
    channel: string,
    registeredId: string | undefined,
    conn: McplConnection,
    params: CoalescedPushEventParams,
  ): void {
    const seq = ++this.mutationSeq;
    const inFlight = this.mutationsInFlight.get(messageId) ?? { latest: 0, unsettled: 0 };
    inFlight.latest = seq;
    inFlight.unsettled++;
    this.mutationsInFlight.set(messageId, inFlight);

    void (async () => {
      try {
        const { outcome } = await this.sendWithRetries({
          lane: 'push/event',
          what: `${kind} of message ${messageId} in ${channel}`,
          dbgPrefix: 'handleMessageMutation',
          conn,
          coalesced: params.coalesce !== undefined,
          channel: registeredId,
          superseded: () => inFlight.latest !== seq,
          fits: () => pushFits(params, this.hostCoalescing),
          attempt: async (c) => {
            try {
              return pushOutcome(await c.sendRequest(method.PUSH_EVENT, params as unknown as Record<string, unknown>));
            } catch (err) {
              return sendErrorOutcome(err);
            }
          },
        });
        if (outcome.kind === 'accepted' || outcome.kind === 'no-result') {
          if (this.owed.get(discordChannelId)?.some((o) => o.id === messageId)) this.forgetOwed(discordChannelId, [messageId]);
        } else if (outcome.kind === 'rejected') {
          console.error(`[discord-mcpl] host rejected ${kind} of message ${messageId} in ${channel}: ${outcome.reason}`);
          dbg('handleMessageMutation:rejected', { kind, messageId, channel, reason: outcome.reason, ...(outcome.code !== undefined ? { code: outcome.code } : {}) });
          if (kind === 'edit' && answerClass(outcome) === 'refused') this.owe(discordChannelId, messageId, { uncertain: false, edit: true });
        } else if (outcome.kind === 'failed') {
          if (outcome.hostError) console.error(`[discord-mcpl] host failed ${kind} of message ${messageId} in ${channel}: ${outcome.error}`);
          dbg('handleMessageMutation:send-failed', { kind, messageId, channel, error: outcome.error });
          if (kind === 'edit') this.owe(discordChannelId, messageId, { uncertain: true, edit: true });
        }
      } finally {
        if (--inFlight.unsettled === 0 && this.mutationsInFlight.get(messageId) === inFlight) {
          this.mutationsInFlight.delete(messageId);
        }
      }
    })();
  }
}

type SendOutcome = ForwardOutcome | { kind: 'failed'; error: string; hostError?: true };

function describeOutcome(outcome: SendOutcome | { kind: 'superseded' }, lane: 'channels/incoming' | 'push/event'): string {
  switch (outcome.kind) {
    case 'accepted': return 'accepted';
    case 'no-result': return 'sent (no verdict)';
    case 'rejected': return `host ${lane === 'channels/incoming' && outcome.code === undefined ? "didn't take it" : 'rejected it'}: ${outcome.reason}`;
    case 'failed': return `send failed: ${outcome.error}`;
    case 'superseded': return 'superseded';
  }
}

/** Why a push built for one host doesn't fit the host connected now: one
 *  scoped to a channel (`coalesce.channelId`) goes only to a host that
 *  advertises channel-scoped pushes (RFC-006 §10; another refuses it as
 *  malformed, §13). */
function pushFits(
  params: CoalescedPushEventParams,
  coalescing: { channelScopedPush?: boolean } | null | undefined,
): string | undefined {
  const scoped = (params.coalesce as { channelId?: unknown } | undefined)?.channelId !== undefined;
  return scoped && !coalescing?.channelScopedPush
    ? "the host connected now doesn't take channel-scoped pushes, and this one is scoped to its channel"
    : undefined;
}

function sendErrorOutcome(err: unknown): SendOutcome {
  const rejection = errorRejection(err);
  if (rejection) return { kind: 'rejected', ...rejection };
  return { kind: 'failed', error: errorText(err), ...(hostAnsweredWithError(err) ? { hostError: true as const } : {}) };
}

/** Whether an error is the host's answer (a JSON-RPC error it sent), not a
 *  closed connection or mcpl-core's own timeout, a ConnectionTimeoutError,
 *  which carries a code (-32000) as a host's answer does. */
function hostAnsweredWithError(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown } | null | undefined;
  return !!e && typeof e.code === 'number' && e.name !== 'ConnectionTimeoutError';
}

function snowflake(id: string): bigint | null {
  return /^\d+$/.test(id) ? BigInt(id) : null;
}

function compareSnowflakes(a: string, b: string): number {
  const x = snowflake(a);
  const y = snowflake(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  return a.localeCompare(b);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** MCP's stdio shutdown expects the server to exit once the client closes
 *  its stdin, so a stdio server exits when its host has gone. */
export async function serveStdio(
  server: DiscordMcplServer,
  conn: McplConnection,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  await server.serve(conn);
  console.error('[discord-mcpl] stdio connection ended; exiting');
  exit(0);
}

/**
 * mcpl-core's `acceptTcp` takes a single connection and leaves no listener
 * that logs the server's errors, so this owns the server's 'connection' and
 * 'error' events. Node's server keeps listening after an 'error'.
 */
export function serveTcp(
  tcpServer: net.Server,
  serve: (conn: McplConnection) => Promise<void>,
  log: (...args: unknown[]) => void = console.error,
): void {
  if (!tcpServer.listening) {
    throw new Error("serveTcp needs a listening server: call it once the server has emitted 'listening'");
  }
  tcpServer.on('error', (err) => log('[discord-mcpl] TCP server error:', errorText(err)));
  let serving = false;
  tcpServer.on('connection', (socket) => {
    if (serving) {
      socket.on('error', (err) => log('[discord-mcpl] Refused client socket error:', errorText(err)));
      socket.destroy();
      log('[discord-mcpl] Refused a client: one client is served at a time');
      return;
    }
    serving = true;
    // fromTcp listens for the socket's errors before this handler returns.
    const conn = McplConnection.fromTcp(socket);
    log('[discord-mcpl] Client connected');
    void Promise.resolve()
      .then(() => serve(conn))
      .catch((err) => log('[discord-mcpl] Serving a client failed:', errorText(err)))
      .finally(() => {
        conn.close();
        serving = false;
        log('[discord-mcpl] Client disconnected, waiting for next...');
      });
  });
}
