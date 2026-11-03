/**
 * MCPL RFC-008 tool classes for every tool this server exposes.
 * https://github.com/anima-research/mcpl/blob/main/RFC-008-tool-classes.md
 *
 * tools/list carries each tool's classes as `_meta["mcpl/class"]`. Hosts use
 * them to decide how a tool is handled, notably what tool-lifecycle observers
 * may see of its calls. A tool may name several classes; the host applies the
 * union of their restrictions. Comms arguments are never shared with
 * observers, and other classes' may be. A host treats an unclassed tool (no
 * key) as the most restrictive class.
 */

import type { ToolDefinition } from './tools.js';

/** RFC-008 §4 vocabulary. */
export const TOOL_CLASS_VOCABULARY = [
  'comms',
  'memory',
  'notes',
  'files',
  'shell',
  'web',
  'computer',
  'media',
  'body',
  'control',
] as const;

export type ToolClass = (typeof TOOL_CLASS_VOCABULARY)[number];

/** The `_meta` key RFC-008 §3 defines on a tool definition. */
export const TOOL_CLASS_META_KEY = 'mcpl/class';

export const TOOL_CLASSES: Record<string, readonly ToolClass[]> = {
  send_message: ['comms', 'files'],
  reply_message: ['comms', 'files'],
  send_dm: ['comms', 'files'],

  add_reaction: ['comms'],
  remove_reaction: ['comms'],
  edit_message: ['comms'],
  delete_message: ['comms'],
  fetch_history: ['comms'],
  fetch_around: ['comms'],
  list_channel_members: ['comms'],
  list_guilds: ['comms'],
  list_channels: ['comms'],
  list_emojis: ['comms'],

  create_text_channel: ['comms', 'control'],
  delete_channel: ['comms', 'control'],

  filters_get: ['control'],
  filters_update: ['control'],
  refresh_channels: ['control'],
  set_reaction_visibility: ['control'],
  mute_channel: ['control'],
  unmute_channel: ['control'],
  list_subscriptions: ['control'],
  channel_missed: ['control'],

  subscribe_channel: ['control'],
  unsubscribe_channel: ['control'],
};

/** Tools left unclassed, which hosts treat as most restrictive. */
export const UNCLASSED: ReadonlySet<string> = new Set<string>([]);

export function withToolClasses(tool: ToolDefinition): ToolDefinition {
  if (!Object.hasOwn(TOOL_CLASSES, tool.name)) return tool;
  return {
    ...tool,
    _meta: { ...tool._meta, [TOOL_CLASS_META_KEY]: [...TOOL_CLASSES[tool.name]] },
  };
}
