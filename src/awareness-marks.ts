/**
 * The host's 💤 awareness marks, as the admin slash commands present them.
 *
 * Marks are the framework's: an agent framework with the `marks` host
 * command (anima-research/agent-framework#250) places them for an /undo or
 * /hide only when the operator chooses a scope (`addressed` or `all`), keeps
 * a journal of what it asked Discord to do, and returns a `markers` receipt
 * describing what it scheduled. This module turns those answers into the
 * operator's replies and reads the operator's choice from an interaction.
 */
import type { ChatInputCommandInteraction } from 'discord.js';

/** The operator's choice of which removed messages get a 💤 mark. */
export type MarksChoice = 'none' | 'addressed' | 'all';

/** The `marks` option /undo and /hide take. Omitted means none. */
export const MARKS_OPTION = {
  type: 3, // STRING
  name: 'marks',
  description: 'Mark removed messages with 💤: none (default), addressed (ones that addressed the agent), or all',
  required: false,
  choices: [
    { name: 'none', value: 'none' },
    { name: 'addressed', value: 'addressed' },
    { name: 'all', value: 'all' },
  ],
} as const;

export function readMarksChoice(interaction: ChatInputCommandInteraction): MarksChoice | undefined {
  const raw = interaction.options.getString('marks');
  return raw === 'none' || raw === 'addressed' || raw === 'all' ? raw : undefined;
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
  | { status: 'unresolved'; queued: 0; batchId: string; error: string }
);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * One line for the reply, saying what the receipt says and no more: a
 * queued mark is requested, not yet seen on Discord.
 */
export function describeMarkers(markers: MarkersReceipt | undefined): string {
  if (!markers) return 'Marks: this host reported nothing about 💤 marks.';
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
      return markers.scope === 'none'
        ? `Marks: none (not chosen).${tail}`
        : `Marks: none placed — nothing removed fell within "${markers.scope}".${tail}`;
    case 'queued':
      return `Marks: ${plural(markers.queued, '💤 mark')} requested (${markers.scope}; batch \`${markers.batchId}\`) — ` +
        `not yet confirmed on Discord; \`/marks list\` shows progress.${tail}`;
    case 'not-scheduled':
      return `Marks: not scheduled — ${markers.error}. None will be placed.${tail}`;
    case 'unresolved':
      return `Marks: unresolved — ${markers.error}. Batch \`${markers.batchId}\` may still be delivered later; ` +
        `check \`/marks list\`.${tail}`;
  }
}

/** An operation's status in the journal (agent-framework's DiscordAwarenessOpStatus). */
export type OpStatus = 'requested' | 'dispatching' | 'confirmed' | 'failed' | 'unknown' | 'cancelled';
type Counts = Partial<Record<OpStatus, number>>;

/** One batch, as the journal lists it (agent-framework's DiscordAwarenessBatchView). */
export interface BatchView {
  kind: 'batch';
  id: string;
  status: 'prepared' | 'active' | 'held' | 'discarded';
  scope: string;
  agentName: string;
  sourceBranch?: string;
  targetBranch?: string;
  emoji?: string;
  createdAt: number;
  refs: number;
  unmarked?: number;
  notRemoved?: number;
  held?: { reason: string; at: number; releaseActions: number };
  cancelled?: { at: number; by?: string };
  released?: { at: number; by?: string };
  adds: Counts;
  removals: Counts;
  unresolvedAttempts: number;
  /** What a pre-journal ledger recorded about this batch's refs. */
  legacy?: { entries: number; lastAddConfirmed: number; lastRemoveConfirmed: number; outcomesUnrecorded: number };
}

/** One retract request (agent-framework's DiscordAwarenessRetractView). */
export interface RetractView {
  kind: 'retract';
  id: string;
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  removals: Counts;
  unresolvedAttempts: number;
}

export type AwarenessView = BatchView | RetractView;

/** cancel's receipt (agent-framework's DiscordAwarenessCancelReceipt). */
export interface CancelReceipt {
  target: string;
  kind: 'batch' | 'retract';
  cancelled: number;
  heldDropped: number;
  inFlight: number;
  unknown: number;
  confirmed: number;
  unresolvedAttempts: number;
  legacyOutcomesUnrecorded: number;
}

/** retract's receipt (agent-framework's DiscordAwarenessRetractReceipt). */
export interface RetractReceipt {
  requestId: string;
  removalsQueued: number;
  addsSuperseded: number;
  keysWithUnresolvedAdds: number;
  unresolvedAddAttempts: number;
  keysWithLegacyUncertainty: number;
}

/** release's receipt (agent-framework's DiscordAwarenessReleaseReceipt). */
export interface ReleaseReceipt {
  batchId: string;
  addsQueued: number;
  removalsQueued: number;
}

/** Discord's limit on one reply. */
export const REPLY_LIMIT = 2000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cut text to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** An answer this server can't read, shown as it came (bounded) rather than misread. */
export function unreadable(what: string, value: unknown): string {
  const head = `The host answered ${what} in a shape this server can't read; here it is as sent:\n`;
  const raw = JSON.stringify(value) ?? String(value);
  return `${head}\`\`\`json\n${raw}\n\`\`\``;
}

const counts = (c: Counts | undefined): string => {
  const parts = Object.entries(c ?? {}).filter(([, n]) => isNum(n) && n > 0).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : 'none';
};

const when = (ms: number | undefined): string => (isNum(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : 'unknown time');

const legacyText = (l: BatchView['legacy']): string =>
  l
    ? `imported history: ${plural(l.entries, 'entry', 'entries')} (last add confirmed on ${l.lastAddConfirmed}, ` +
      `last removal confirmed on ${l.lastRemoveConfirmed}; ${plural(l.outcomesUnrecorded, 'attempt')} with unrecorded outcomes — any may have landed)`
    : '';

/** A long free-text field (a held reason) in a summary line. */
const SUMMARY_TEXT_MAX = 80;

/** One line per entry, for the paged list. */
export function summaryLine(v: AwarenessView): string {
  const unresolved = v.unresolvedAttempts ? `; ${v.unresolvedAttempts} unresolved` : '';
  if (v.kind === 'retract') {
    return `• retract \`${v.id}\` → ${v.target}${v.cancelled ? ' (cancelled)' : ''}: removals ${counts(v.removals)}${unresolved}`;
  }
  const state = v.cancelled ? `${v.status}, cancelled` : v.released ? `${v.status}, released` : v.status;
  const held = v.held ? `; held: ${clip(v.held.reason, SUMMARY_TEXT_MAX)}` : '';
  const legacy = v.legacy ? `; imported history (${plural(v.legacy.outcomesUnrecorded, 'unrecorded outcome')})` : '';
  return `• batch \`${v.id}\` — ${state}, ${v.scope}, ${plural(v.refs, 'message')} (${v.agentName}): ` +
    `adds ${counts(v.adds)}; removals ${counts(v.removals)}${unresolved}${held}${legacy}`;
}

/** One entry in full (the caller fits it into a reply). */
export function detailText(v: AwarenessView): string {
  const lines: string[] = [];
  if (v.kind === 'retract') {
    lines.push(`**Retract \`${v.id}\`** of ${v.target === 'all' ? 'every marked message' : `batch \`${v.target}\``}, ${when(v.at)}${v.by ? ` by ${v.by}` : ''}.`);
    if (v.cancelled) lines.push(`Cancelled ${when(v.cancelled.at)}${v.cancelled.by ? ` by ${v.cancelled.by}` : ''}.`);
    lines.push(`Removals: ${counts(v.removals)}.`);
    if (v.unresolvedAttempts) lines.push(`${plural(v.unresolvedAttempts, 'request')} on the wire or with unknown outcome — any may land.`);
  } else {
    lines.push(`**Batch \`${v.id}\`** — ${v.status}; ${v.scope} for ${v.agentName}; ${plural(v.refs, 'message')}; created ${when(v.createdAt)}.`);
    if (v.sourceBranch || v.targetBranch) lines.push(`Branches: ${v.sourceBranch ?? '?'} → ${v.targetBranch ?? '?'}.`);
    if (isNum(v.unmarked) || isNum(v.notRemoved)) {
      lines.push(`Left unmarked: ${v.unmarked ?? 0} outside the scope; ${v.notRemoved ?? 0} chosen but not removed.`);
    }
    if (v.held) lines.push(`Held ${when(v.held.at)} (${plural(v.held.releaseActions, 'release action')}): ${v.held.reason}`);
    if (v.cancelled) lines.push(`Cancelled ${when(v.cancelled.at)}${v.cancelled.by ? ` by ${v.cancelled.by}` : ''}.`);
    if (v.released) lines.push(`Released ${when(v.released.at)}${v.released.by ? ` by ${v.released.by}` : ''}.`);
    lines.push(`Adds: ${counts(v.adds)}. Removals on its messages: ${counts(v.removals)}.`);
    if (v.unresolvedAttempts) lines.push(`${plural(v.unresolvedAttempts, 'request')} on its messages on the wire or with unknown outcome — any may land.`);
    if (v.legacy) lines.push(`${legacyText(v.legacy)[0]!.toUpperCase()}${legacyText(v.legacy).slice(1)}.`);
  }
  return lines.join('\n');
}

const entryTime = (v: AwarenessView): number => (v.kind === 'batch' ? v.createdAt : v.at) ?? 0;

/**
 * The journal, newest first, cut into pages that each fit one reply with
 * their heading. Every entry is on some page; a line too long for a page
 * alone is clipped (its entry still opens in full with `target:`).
 */
export function paginate(views: AwarenessView[], budget = REPLY_LIMIT): string[][] {
  const ordered = [...views].sort((a, b) => entryTime(b) - entryTime(a));
  // Room for the heading ("Awareness journal — page 999 of 999, …"), its
  // newline, and the footer pointing at target:.
  const room = budget - HEADING_RESERVE;
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

const HEADING_RESERVE = 220;

/** One page of `/marks list`, heading and footer included, within one reply. */
export function renderListPage(views: AwarenessView[], pageNumber: number, budget = REPLY_LIMIT): string {
  if (views.length === 0) return 'No awareness-mark batches or retracts in the journal.';
  const pages = paginate(views, budget);
  if (pageNumber > pages.length) {
    return `The journal has ${plural(views.length, 'entry', 'entries')} on ${plural(pages.length, 'page')}; there is no page ${pageNumber}.`;
  }
  const lines = pages[pageNumber - 1]!;
  const heading = `Awareness journal — page ${pageNumber} of ${pages.length}, ${plural(views.length, 'entry', 'entries')}, newest first.`;
  const footer = pages.length > 1
    ? `\`/marks list page:${pageNumber < pages.length ? pageNumber + 1 : 1}\` for ${pageNumber < pages.length ? 'the next page' : 'the first page'}; \`/marks list target:<id>\` shows one entry in full.`
    : '`/marks list target:<id>` shows one entry in full.';
  return clip([heading, ...lines, footer].join('\n'), budget);
}

/** One entry of the journal by id, in full, or why not. */
export function renderEntry(views: AwarenessView[], id: string): string {
  const found = views.filter((v) => v.id === id);
  if (found.length === 0) return `No batch or retract \`${clip(id, 100)}\` in the journal.`;
  return found.map(detailText).join('\n\n');
}

export function isView(v: unknown): v is AwarenessView {
  return isObj(v) && typeof v.id === 'string' &&
    ((v.kind === 'batch' && typeof v.status === 'string' && isNum(v.refs) && isObj(v.adds) && isObj(v.removals)) ||
      (v.kind === 'retract' && typeof v.target === 'string' && isObj(v.removals)));
}

const allNums = (o: Record<string, unknown>, keys: string[]): boolean => keys.every((k) => isNum(o[k]));

export function isCancelReceipt(r: unknown): r is CancelReceipt {
  return isObj(r) && typeof r.target === 'string' && (r.kind === 'batch' || r.kind === 'retract') &&
    allNums(r, ['cancelled', 'heldDropped', 'inFlight', 'unknown', 'confirmed', 'unresolvedAttempts', 'legacyOutcomesUnrecorded']);
}

export function isRetractReceipt(r: unknown): r is RetractReceipt {
  return isObj(r) && typeof r.requestId === 'string' &&
    allNums(r, ['removalsQueued', 'addsSuperseded', 'keysWithUnresolvedAdds', 'unresolvedAddAttempts', 'keysWithLegacyUncertainty']);
}

export function isReleaseReceipt(r: unknown): r is ReleaseReceipt {
  return isObj(r) && typeof r.batchId === 'string' && allNums(r, ['addsQueued', 'removalsQueued']);
}

/** cancel's reply: what will never be sent, and what cancel can't undo. */
export function describeCancel(r: CancelReceipt): string {
  const what = r.kind === 'batch' ? `batch \`${r.target}\`` : `retract \`${r.target}\``;
  const held = r.heldDropped ? `, and ${plural(r.heldDropped, 'held release action')} dropped` : '';
  const lines = [`✅ Cancelled ${what}: ${plural(r.cancelled, 'request')} will now never be sent${held}.`];
  const limits: string[] = [];
  if (r.confirmed) limits.push(`${r.confirmed} already confirmed on Discord ${r.confirmed === 1 ? 'stays' : 'stay'} as ${r.confirmed === 1 ? 'it is' : 'they are'}`);
  if (r.inFlight) limits.push(`${r.inFlight} on the wire may still land`);
  if (r.unknown) limits.push(`${r.unknown} with unknown outcome may have landed`);
  if (r.unresolvedAttempts) limits.push(`${plural(r.unresolvedAttempts, 'unresolved attempt')} in all`);
  if (r.legacyOutcomesUnrecorded) limits.push(`${plural(r.legacyOutcomesUnrecorded, 'imported attempt')} with unrecorded outcomes may have landed`);
  lines.push(`Cancel removes nothing from Discord${limits.length ? `: ${limits.join('; ')}.` : '.'}`);
  if (r.kind === 'batch' && (r.confirmed || r.inFlight || r.unknown)) {
    lines.push(`To take marks down, \`/marks retract target:${r.target}\`.`);
  }
  return lines.join('\n');
}

/** retract's reply: removals requested, and adds that may land after them. */
export function describeRetract(r: RetractReceipt): string {
  const superseded = r.addsSuperseded ? `; ${plural(r.addsSuperseded, 'unsent add')} superseded` : '';
  const lines = [
    `✅ Retract \`${r.requestId}\`: ${plural(r.removalsQueued, '💤 removal')} requested — not yet confirmed on Discord${superseded}.`,
  ];
  if (r.keysWithUnresolvedAdds) {
    lines.push(`${plural(r.keysWithUnresolvedAdds, 'message')} ${r.keysWithUnresolvedAdds === 1 ? 'has' : 'have'} earlier add attempts still unresolved ` +
      `(${plural(r.unresolvedAddAttempts, 'attempt')}): such an add may land after its removal.`);
  }
  if (r.keysWithLegacyUncertainty) {
    lines.push(`${plural(r.keysWithLegacyUncertainty, 'message')} ${r.keysWithLegacyUncertainty === 1 ? 'has' : 'have'} imported history with unrecorded outcomes.`);
  }
  lines.push(`\`/marks list target:${r.requestId}\` shows progress; \`/marks cancel target:${r.requestId}\` stops what hasn't been sent.`);
  return lines.join('\n');
}

/** release's reply: what the release queued. */
export function describeRelease(r: ReleaseReceipt): string {
  return `✅ Released held batch \`${r.batchId}\`: ${plural(r.addsQueued, 'add')} and ${plural(r.removalsQueued, 'removal')} ` +
    `requested — not yet confirmed on Discord. \`/marks list target:${r.batchId}\` shows progress.`;
}

/** A reply too long for one message: cut visibly, with the whole answer attached. */
export type BoundedReply = string | { content: string; files: Array<{ attachment: Buffer; name: string }> };

/**
 * Fit `text` into one Discord reply. When it doesn't fit, the reply says it
 * was cut and attaches the whole answer: `full` as JSON when given (the
 * host's own record), else the text itself.
 */
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
