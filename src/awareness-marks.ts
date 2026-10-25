/**
 * An /undo's marks are the framework's: an agent framework with the `marks`
 * host command (anima-research/agent-framework#250) places them only when the
 * operator chooses a scope, keeps them in its awareness ledger, and returns a
 * `markers` receipt. For a hide the host places none and refuses a choice, so
 * this server adds 💤 to the hidden messages itself.
 */
import { ApplicationCommandOptionType, type ChatInputCommandInteraction } from 'discord.js';

export type MarksChoice = 'none' | 'addressed' | 'all';

export const MARKS_OPTION = {
  type: ApplicationCommandOptionType.String,
  name: 'marks',
  description: 'Mark removed messages with 💤: none (default), addressed (ones that addressed the agent), or all',
  required: false,
  choices: [
    { name: 'none', value: 'none' },
    { name: 'addressed', value: 'addressed' },
    { name: 'all', value: 'all' },
  ],
} as const;

/** The host's answer to a hide names the hidden messages without saying
 *  which addressed the agent, so `addressed` isn't offered. */
export const HIDE_MARKS_OPTION = {
  type: ApplicationCommandOptionType.String,
  name: 'marks',
  description: 'Mark hidden messages with 💤: none (default) or all',
  required: false,
  choices: [
    { name: 'none', value: 'none' },
    { name: 'all', value: 'all' },
  ],
} as const;

const isMarksChoice = (v: unknown): v is MarksChoice => v === 'none' || v === 'addressed' || v === 'all';

export function readMarksChoice(interaction: ChatInputCommandInteraction): MarksChoice | undefined {
  const raw = interaction.options.getString('marks');
  return isMarksChoice(raw) ? raw : undefined;
}

/** What a surgery did about marks (agent-framework's SurgeryMarkerReceipt). */
export type MarkersReceipt = {
  scope: MarksChoice;
  unmarked: number;
  notRemoved: number;
} & (
  | { status: 'none'; queued: 0 }
  | { status: 'queued'; queued: number; batchId: string }
  | { status: 'not-scheduled'; queued: 0; error: string }
);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export const markersReported = (markers: unknown): boolean => markers !== undefined && markers !== null;

export function describeMarkers(markers: unknown): string {
  if (!markersReported(markers)) {
    return 'Marks: this host reported nothing about 💤 marks; `/marks action:list` shows whether it scheduled any.';
  }
  if (!isMarkersReceipt(markers)) {
    return `Marks: the host's receipt is in a shape this server can't read; here it is as sent:\n${asSent(markers)}`;
  }
  const extras: string[] = [];
  if (markers.unmarked > 0 && markers.scope !== 'none') {
    extras.push(`${plural(markers.unmarked, 'removed message')} outside that scope left unmarked`);
  }
  if (markers.notRemoved > 0) {
    extras.push(`${plural(markers.notRemoved, 'chosen message')} not removed, so not marked`);
  }
  const tail = extras.length ? ` (${extras.join('; ')})` : '';
  switch (markers.status) {
    case 'none':
      // The receipt's scope can't tell an explicit none from one left out.
      return markers.scope === 'none'
        ? `Marks: none.${tail}`
        : `Marks: none placed — nothing removed fell within "${markers.scope}".${tail}`;
    case 'queued':
      return `Marks: ${plural(markers.queued, '💤 mark')} requested (${markers.scope}; batch \`${markers.batchId}\`) — ` +
        `not yet confirmed on Discord; \`/marks action:list\` shows progress.${tail}`;
    case 'not-scheduled':
      return `Marks: not scheduled — ${markers.error}. None will be placed.${tail}`;
  }
}

const SHORT_TEXT_MAX = 100;
const ID_MAX = 100;

export function summarizeMarkers(markers: unknown): string {
  if (!markersReported(markers)) return 'Marks: the host reported nothing about them; `/marks action:list` shows whether it scheduled any.';
  if (!isMarkersReceipt(markers)) return "Marks: the host's receipt couldn't be read; `/marks action:list` shows the ledger.";
  const batch = (id: string): string => `batch \`${clip(id, SHORT_TEXT_MAX)}\``;
  switch (markers.status) {
    case 'none':
      return markers.scope === 'none' ? 'Marks: none.' : 'Marks: none placed.';
    case 'queued':
      return `Marks: ${plural(markers.queued, '💤 mark')} requested (${batch(markers.batchId)}).`;
    case 'not-scheduled':
      return `Marks: not scheduled — ${clip(markers.error, SHORT_TEXT_MAX)}.`;
  }
}

/**
 * Reactions counted by state (agent-framework's DiscordAwarenessReactionState):
 * queued (a request owed, not yet sent), sending (on the wire), present or
 * absent (nothing owed, and Discord's last answer), unknown (nothing owed,
 * and the last request went unanswered), failed (it ended unconfirmed) and
 * untouched (never asked).
 */
type Reactions = Record<string, number>;

/** One batch, as the ledger lists it (agent-framework's DiscordAwarenessBatchView). */
export interface BatchView {
  kind: 'batch';
  id: string;
  /** prepared, active or retired at agent-framework#250; shown as the host
   *  names it. */
  status: string;
  scope: string;
  agentName: string;
  sourceBranch?: string;
  targetBranch?: string;
  emoji?: string;
  createdAt: number;
  refs: number;
  unmarked?: number;
  notRemoved?: number;
  cancelled?: { at: number; by?: string };
  /** Its messages' reactions, by state, whichever act wants them now. */
  reactions: Reactions;
  /** Of those, the ones with a request on the wire or one never answered. */
  mayStillLand: number;
  /** A batch imported from agent-framework 0.22.x's ledger: how many of its
   *  messages 0.22.x's last attempt added a mark to with no error recorded.
   *  Nothing an import brings is ever sent, so this is the view's only count
   *  of what 0.22.x added. */
  legacyAdded?: number;
}

/** One retract request (agent-framework's DiscordAwarenessRetractView). */
export interface RetractView {
  kind: 'retract';
  id: string;
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  /** The removals it queued. */
  keys: number;
  /** The reactions it still wants absent, by state. */
  reactions: Reactions;
  /** Of those, the ones with a request on the wire or one never answered. */
  mayStillLand: number;
}

export type AwarenessView = BatchView | RetractView;

/** cancel's receipt (agent-framework's DiscordAwarenessCancelReceipt). */
export interface CancelReceipt {
  target: string;
  kind: 'batch' | 'retract';
  /** Its reactions left with nothing owed before any request went out. */
  cancelled: number;
  /** Its reactions whose last answer from Discord is what it wanted. */
  confirmed: number;
  /** Its reactions with a request on the wire or one never answered: any may land. */
  mayStillLand: number;
}

/** retract's receipt (agent-framework's DiscordAwarenessRetractReceipt). */
export interface RetractReceipt {
  requestId: string;
  removalsQueued: number;
  addsSuperseded: number;
  /** Reactions with an add on the wire or one never answered, which may land
   *  after the removal. */
  keysWithUnresolvedAdds: number;
}

/** Discord's limit on one reply. */
export const REPLY_LIMIT = 2000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const hostCount = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface HiddenRef { channelId: string; messageId: string }

export function readHiddenRefs(v: unknown): HiddenRef[] | 'unreadable' {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return 'unreadable';
  return v.every((r: unknown) => isObj(r) && isStr(r.channelId) && isStr(r.messageId)) ? (v as HiddenRef[]) : 'unreadable';
}

const HIDE_MARKS_OWN = "They're this server's own, outside the host's awareness ledger: `/marks` doesn't list them, " +
  "and a retract reaches one only on a message the host's ledger also names, when the host's marks are 💤 too.";

export function hideMarksAt(refs: HiddenRef[] | 'unreadable'): string {
  if (refs === 'unreadable') return "Marks: the host's list of hidden messages couldn't be read, so none was marked with 💤.";
  if (refs.length === 0) return 'Marks: the host named no hidden messages, so none was marked with 💤.';
  return `Marks: adding 💤 to ${plural(refs.length, 'hidden message')}…`;
}

const ERROR_MAX = 400;
const TRANSIT_ERROR_MAX = 500;

export function describeHideMarks(confirmed: number, total: number, firstError?: string): string {
  const rest = firstError === undefined ? ''
    : ` The rest weren't confirmed, so they may or may not be on Discord (first error: ${clip(firstError, ERROR_MAX)}).`;
  return `Marks: Discord confirmed 💤 on ${confirmed} of ${plural(total, 'hidden message')}.${rest} ${HIDE_MARKS_OWN}`;
}

export const HIDE_MARKS_NOT_ADDED = "Marks: no 💤 was added, since this server adds them only once it has read the host's answer.";

/** The cut falls between code points, so it never leaves half of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const before = text.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

const asSent = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value) ?? String(value)}\n\`\`\``;

export function unreadable(what: string, value: unknown): string {
  return `The host answered ${what} in a shape this server can't read; here it is as sent:\n${asSent(value)}`;
}

const counts = (c: Reactions | undefined): string => {
  const parts = Object.entries(c ?? {}).filter(([, n]) => isNum(n) && n > 0).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : 'none';
};

const when = (ms: number | undefined): string => (isNum(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : 'unknown time');

const mayStillLand = (n: number): string => (n ? `; ${n} may still land` : '');

export function summaryLine(v: AwarenessView): string {
  if (v.kind === 'retract') {
    return `• retract \`${v.id}\` → ${v.target}${v.cancelled ? ' (cancelled)' : ''}: ${plural(v.keys, 'removal')}; ` +
      `reactions ${counts(v.reactions)}${mayStillLand(v.mayStillLand)}`;
  }
  const state = v.cancelled ? `${v.status}, cancelled` : v.status;
  const legacy = isNum(v.legacyAdded) ? `; 0.22.x recorded ${plural(v.legacyAdded, 'mark')} as added` : '';
  return `• batch \`${v.id}\` — ${state}, ${v.scope}, ${plural(v.refs, 'message')} (${v.agentName}): ` +
    `reactions ${counts(v.reactions)}${mayStillLand(v.mayStillLand)}${legacy}`;
}

const STATES = "States, counted by what each reaction's latest act wants, an add or a later retract's removal: " +
  'queued, a request owed and not yet sent; sending, on the wire; present or absent, ' +
  "Discord's last answer, with nothing owed; unknown, the last request went unanswered; failed, it ended unconfirmed; " +
  'untouched, never asked.';

export function detailText(v: AwarenessView): string {
  const lines: string[] = [];
  if (v.kind === 'retract') {
    lines.push(`**Retract \`${v.id}\`** of ${v.target === 'all' ? 'every message in the ledger' : `batch \`${v.target}\``}, ${when(v.at)}${v.by ? ` by ${v.by}` : ''}.`);
    if (v.cancelled) lines.push(`Cancelled ${when(v.cancelled.at)}${v.cancelled.by ? ` by ${v.cancelled.by}` : ''}.`);
    lines.push(`${plural(v.keys, 'removal')} queued. The reactions it still wants absent: ${counts(v.reactions)}.`);
    if (v.mayStillLand) lines.push(`${plural(v.mayStillLand, 'reaction')} with a request on the wire or one never answered — any may land.`);
  } else {
    lines.push(`**Batch \`${v.id}\`** — ${v.status}; ${v.scope} for ${v.agentName}; ${plural(v.refs, 'message')}; created ${when(v.createdAt)}.`);
    if (v.sourceBranch || v.targetBranch) lines.push(`Branches: ${v.sourceBranch ?? '?'} → ${v.targetBranch ?? '?'}.`);
    // agent-framework#250 keeps each of these counts only when it isn't zero
    // (and its view carries only what it kept), so one left out is zero.
    if (isNum(v.unmarked) || isNum(v.notRemoved)) {
      lines.push(`Left unmarked: ${v.unmarked ?? 0} outside the scope; ${v.notRemoved ?? 0} chosen but not removed.`);
    }
    if (v.cancelled) lines.push(`Cancelled ${when(v.cancelled.at)}${v.cancelled.by ? ` by ${v.cancelled.by}` : ''}.`);
    lines.push(`Its messages' reactions: ${counts(v.reactions)}.`);
    if (v.mayStillLand) lines.push(`${plural(v.mayStillLand, 'reaction')} with a request on the wire or one never answered — any may land.`);
    if (isNum(v.legacyAdded)) {
      lines.push(`Imported from agent-framework 0.22.x, which recorded ${plural(v.legacyAdded, 'mark')} on these messages as added. ` +
        `Marks it placed may still be on Discord: \`/marks action:retract target:${v.id}\` queues their removal.`);
    }
  }
  lines.push(STATES);
  return lines.join('\n');
}

const entryTime = (v: AwarenessView): number => (v.kind === 'batch' ? v.createdAt : v.at) ?? 0;

export function paginate(views: AwarenessView[], budget = REPLY_LIMIT): string[][] {
  const ordered = [...views].sort((a, b) => entryTime(b) - entryTime(a));
  const room = budget - HEADING_AND_FOOTER_RESERVE;
  const pages: string[][] = [];
  let page: string[] = [];
  let used = 0;
  for (const view of ordered) {
    const line = clip(summaryLine(view), room);
    const cost = line.length + 1;
    if (page.length > 0 && used + cost > room) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(line);
    used += cost;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

const HEADING_AND_FOOTER_RESERVE = 220;

export function renderListPage(views: AwarenessView[], pageNumber: number, budget = REPLY_LIMIT): string {
  if (views.length === 0) return 'No awareness-mark batches or retracts in the ledger.';
  const pages = paginate(views, budget);
  if (pageNumber < 1 || pageNumber > pages.length) {
    return `The ledger has ${plural(views.length, 'entry', 'entries')} on ${plural(pages.length, 'page')}; there is no page ${pageNumber}.`;
  }
  const lines = pages[pageNumber - 1]!;
  const heading = `Awareness ledger — page ${pageNumber} of ${pages.length}, ${plural(views.length, 'entry', 'entries')}, newest first.`;
  const footer = pages.length > 1
    ? `\`/marks action:list page:${pageNumber < pages.length ? pageNumber + 1 : 1}\` for ${pageNumber < pages.length ? 'the next page' : 'the first page'}; \`/marks action:list target:<id>\` shows one entry in full.`
    : '`/marks action:list target:<id>` shows one entry in full.';
  return clip([heading, ...lines, footer].join('\n'), budget);
}

export function renderEntry(views: AwarenessView[], id: string): string {
  const found = views.filter((v) => v.id === id);
  if (found.length === 0) return `No batch or retract \`${clip(id, ID_MAX)}\` in the ledger.`;
  return found.map(detailText).join('\n\n');
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const opt = (v: unknown, is: (x: unknown) => boolean): boolean => v === undefined || is(v);
const allNums = (o: Record<string, unknown>, keys: string[]): boolean => keys.every((k) => isNum(o[k]));
const isCounts = (v: unknown): boolean => isObj(v) && Object.values(v).every(isNum);
const isStamp = (v: unknown): boolean => isObj(v) && isNum(v.at) && opt(v.by, isStr);

export function isView(v: unknown): v is AwarenessView {
  if (!isObj(v) || !isStr(v.id) || !isCounts(v.reactions) || !isNum(v.mayStillLand) || !opt(v.cancelled, isStamp)) {
    return false;
  }
  if (v.kind === 'retract') return isStr(v.target) && isNum(v.at) && opt(v.by, isStr) && isNum(v.keys);
  return v.kind === 'batch' && isStr(v.status) && isStr(v.scope) && isStr(v.agentName) && isNum(v.createdAt) &&
    isNum(v.refs) && opt(v.sourceBranch, isStr) && opt(v.targetBranch, isStr) &&
    opt(v.unmarked, isNum) && opt(v.notRemoved, isNum) && opt(v.legacyAdded, isNum);
}

/** A markers receipt as agent-framework#250 defines it. */
export function isMarkersReceipt(m: unknown): m is MarkersReceipt {
  if (!isObj(m) || !isMarksChoice(m.scope) || !isNum(m.unmarked) || !isNum(m.notRemoved)) return false;
  switch (m.status) {
    case 'none':
      return true;
    case 'queued':
      return isNum(m.queued) && isStr(m.batchId);
    case 'not-scheduled':
      return isStr(m.error);
    default:
      return false;
  }
}

export function isCancelReceipt(r: unknown): r is CancelReceipt {
  return isObj(r) && typeof r.target === 'string' && (r.kind === 'batch' || r.kind === 'retract') &&
    allNums(r, ['cancelled', 'confirmed', 'mayStillLand']);
}

export function isRetractReceipt(r: unknown): r is RetractReceipt {
  return isObj(r) && typeof r.requestId === 'string' &&
    allNums(r, ['removalsQueued', 'addsSuperseded', 'keysWithUnresolvedAdds']);
}

const stopped = (cancelled: number, fate: string): string =>
  cancelled === 0 ? 'nothing it asked for was still waiting to be sent' : `${plural(cancelled, 'reaction')} ${fate}`;

const mayLand = (n: number): string => `${plural(n, 'reaction')} with a request on the wire or one never answered may land`;

export function describeCancel(r: CancelReceipt): string {
  const what = r.kind === 'batch' ? `batch \`${r.target}\`` : `retract \`${r.target}\``;
  const lines = [`✅ Cancelled ${what}: ${stopped(r.cancelled, 'will now never be requested')}.`];
  const limits: string[] = [];
  if (r.confirmed) limits.push(`${r.confirmed} already confirmed on Discord ${r.confirmed === 1 ? 'stays' : 'stay'} as ${r.confirmed === 1 ? 'it is' : 'they are'}`);
  if (r.mayStillLand) limits.push(mayLand(r.mayStillLand));
  lines.push(`Cancel removes nothing from Discord${limits.length ? `: ${limits.join('; ')}.` : '.'}`);
  // Every batch's: its receipt can't see marks an import brought, or marks
  // another batch placed on the same messages, whose removal a retract queues too.
  if (r.kind === 'batch') lines.push(retractPointer(r.target));
  return lines.join('\n');
}

const retractPointer = (batchId: string): string =>
  `If any of its marks are on Discord, \`/marks action:retract target:${batchId}\` queues their removal.`;

const nothingToRetract = (requestId: string): string => `✅ Retract \`${requestId}\` queued no removal: its target names no message.`;

export function describeRetract(r: RetractReceipt): string {
  if (r.removalsQueued === 0) return nothingToRetract(r.requestId);
  // An add still owed includes one on the wire, which settles before the
  // removal is sent and may land (keysWithUnresolvedAdds).
  const superseded = r.addsSuperseded ? `; it replaces ${plural(r.addsSuperseded, 'add')} still owed` : '';
  const lines = [
    `✅ Retract \`${r.requestId}\`: ${plural(r.removalsQueued, '💤 removal')} requested — not yet confirmed on Discord${superseded}.`,
  ];
  if (r.keysWithUnresolvedAdds) {
    lines.push(`${plural(r.keysWithUnresolvedAdds, 'message')} ${r.keysWithUnresolvedAdds === 1 ? 'has' : 'have'} an add on the wire ` +
      'or one never answered: such an add may land after its removal.');
  }
  lines.push(`\`/marks action:list target:${r.requestId}\` shows progress; \`/marks action:cancel target:${r.requestId}\` stops what hasn't been sent.`);
  return lines.join('\n');
}

export type BoundedReply = string | { content: string; files: Array<{ attachment: Buffer; name: string }> };

export function boundedReply(text: string, full?: unknown, budget = REPLY_LIMIT): BoundedReply {
  if (text.length <= budget) return text;
  const json = full !== undefined;
  const note = `\n… (cut to fit one message; the whole ${json ? 'answer is attached as JSON' : 'reply is attached'})`;
  return {
    content: clip(text, budget - note.length) + note,
    files: [
      json
        ? { attachment: Buffer.from(JSON.stringify(full, null, 2) ?? String(full), 'utf8'), name: 'awareness.json' }
        : { attachment: Buffer.from(text, 'utf8'), name: 'reply.txt' },
    ],
  };
}

export function summarizeControl(action: string, target: string | undefined, answer: unknown): string {
  if (action === 'cancel' && isCancelReceipt(answer)) {
    return `✅ Cancelled ${answer.kind} \`${answer.target}\`: ${stopped(answer.cancelled, 'will never be requested')}; ` +
      `cancel removes nothing from Discord${answer.mayStillLand ? `: ${mayLand(answer.mayStillLand)}` : ''}.` +
      (answer.kind === 'batch' ? ` ${retractPointer(answer.target)}` : '');
  }
  if (action === 'retract' && isRetractReceipt(answer)) {
    if (answer.removalsQueued === 0) return nothingToRetract(answer.requestId);
    const after = !answer.keysWithUnresolvedAdds
      ? ''
      : answer.keysWithUnresolvedAdds === 1
        ? '; 1 message has an add on the wire or never answered, which may land after its removal'
        : `; ${answer.keysWithUnresolvedAdds} messages have adds on the wire or never answered, which may land after their removal`;
    const superseded = answer.addsSuperseded ? `; it replaces ${plural(answer.addsSuperseded, 'add')} still owed` : '';
    return `✅ Retract \`${answer.requestId}\`: ${plural(answer.removalsQueued, 'removal')} requested, not yet confirmed on Discord${superseded}${after}.`;
  }
  return `✅ The host accepted /marks action:${action}${target ? ` \`${clip(target, ID_MAX)}\`` : ''} (its receipt couldn't be read). ` +
    '`/marks action:list` shows what it did.';
}

export function controlOutcomeUnknown(action: string, target: string | undefined, error?: string): string {
  const effect = action === 'cancel' ? 'already have cancelled it' : 'already have queued the removals';
  return `⚠️ /marks action:${action} outcome unknown${error ? ` (${clip(error, TRANSIT_ERROR_MAX)})` : ''}: the host may ${effect}. ` +
    controlCheck(action, target);
}

/** A cancel shows on its target's entry; a retract the host queued is an
 *  entry of its own, with an id the operator doesn't have yet. */
const controlCheck = (action: string, target: string | undefined): string =>
  action === 'retract' && target
    ? `Check \`/marks action:list\` for a retract of ${target === 'all' ? 'all' : `\`${clip(target, ID_MAX)}\``} before trying again; ` +
      'the ledger lists newest first.'
    : target && target !== 'all'
      ? `Check \`/marks action:list target:${clip(target, ID_MAX)}\` before trying again.`
      : 'Check `/marks action:list` before trying again.';

/** agent-framework refuses every host command from a server its config doesn't allow (`allowHostCommands`, deny by default). */
export const PROBE_AGAIN = 'Running it again can work after a timeout, or once the host is back if it was restarting. ' +
  'If the host refuses host commands, whoever runs it has to allow them for this server (`allowHostCommands`).';

const surgeryCheck = (marksChosen: boolean): string =>
  `Check the agent's context${marksChosen ? ', and `/marks action:list` for a 💤 batch it may have scheduled,' : ''} before trying again.`;

export function surgeryOutcomeUnknown(command: 'Undo' | 'Hide', marksChosen: boolean, error?: string): string {
  return `⚠️ ${command} outcome unknown${error ? ` (${clip(error, TRANSIT_ERROR_MAX)})` : ''}: the host may or may not have applied it. ` +
    surgeryCheck(marksChosen);
}

export function unreadableSurgery(command: 'undo' | 'hide', answer: unknown, marksChosen: boolean, note?: string): string {
  return `⚠️ The host answered /${command} in a shape this server can't read, so it may have been applied. ` +
    `${surgeryCheck(marksChosen)}${note ? `\n${note}` : ''}\nHere it is as sent:\n${asSent(answer)}`;
}

export function unreadableControl(action: string, target: string | undefined, answer: unknown): string {
  return `⚠️ The host answered /marks action:${action} in a shape this server can't read, so it may have been applied. ` +
    `${controlCheck(action, target)}\nHere it is as sent:\n${asSent(answer)}`;
}

export function hostRefusal(command: string, answer: Record<string, unknown>): string {
  const code = isStr(answer.code) && answer.code !== '' ? ` (${answer.code})` : '';
  const error = isStr(answer.error) && answer.error !== '' ? answer.error : 'unknown error';
  return `⚠️ ${command} failed${code}: ${error}`;
}
