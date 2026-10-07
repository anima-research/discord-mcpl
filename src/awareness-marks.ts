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

type Counts = Record<string, number>;

/** The journal's views (agent-framework's DiscordAwarenessView). */
export type AwarenessView =
  | {
      kind: 'batch';
      id: string;
      status: string;
      scope: string;
      agentName?: string;
      refs: number;
      createdAt?: number;
      held?: { reason: string };
      cancelled?: unknown;
      released?: unknown;
      adds?: Counts;
      removals?: Counts;
      unresolvedAttempts?: number;
    }
  | {
      kind: 'retract';
      id: string;
      target: string;
      cancelled?: unknown;
      removals?: Counts;
      unresolvedAttempts?: number;
    };

const counts = (c: Counts | undefined): string => {
  const parts = Object.entries(c ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : 'none';
};

/** The most entries a /marks list reply shows (Discord caps a reply at 2000 characters). */
export const LIST_LIMIT = 12;

export function renderAwareness(views: AwarenessView[]): string {
  if (views.length === 0) return 'No awareness-mark batches or retracts in the journal.';
  const lines = views.slice(0, LIST_LIMIT).map((v) => {
    const unresolved = v.unresolvedAttempts ? `; ${v.unresolvedAttempts} unresolved` : '';
    if (v.kind === 'retract') {
      return `• retract \`${v.id}\` → ${v.target}${v.cancelled ? ' (cancelled)' : ''}: removals ${counts(v.removals)}${unresolved}`;
    }
    const held = v.held ? `; held: ${v.held.reason}` : '';
    return `• batch \`${v.id}\` — ${v.status}, ${v.scope}, ${plural(v.refs, 'message')}` +
      `${v.agentName ? ` (${v.agentName})` : ''}: adds ${counts(v.adds)}; removals ${counts(v.removals)}${unresolved}${held}`;
  });
  if (views.length > LIST_LIMIT) lines.push(`… and ${views.length - LIST_LIMIT} more`);
  return lines.join('\n');
}
