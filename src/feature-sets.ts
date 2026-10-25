/**
 * Feature set declarations for the Discord MCPL server.
 */

import type { FeatureSetDeclaration } from '@animalabs/mcpl-core';

/** This server advertises the legacy array form, which the §17 digest
 *  conformance corpus hashes verbatim and hosts normalize; changing the wire
 *  shape changes the manifest digest. */
export interface NamedFeatureSetDeclaration extends FeatureSetDeclaration {
  name: string;
  /** Dropped from MCPL 0.5's core type but kept on the wire, since the
   *  conformance corpus hashes extra fields verbatim into the digest. Required:
   *  the installed 0.2.1 core type requires it, so an optional override is a
   *  TS2430. */
  hostState: boolean;
}

export const featureSets: NamedFeatureSetDeclaration[] = [
  {
    name: 'discord.messaging',
    description: 'Send, read, react to messages in Discord channels',
    // SPEC §6.4: a host rejects a server's use of a capability its feature set's `uses` doesn't declare.
    uses: [
      'tools',
      'channels.publish',
      'pushEvents',
      'channels.incoming',
      'channels.register',
      'channels.lifecycle',
      // The handlers' capabilities count as uses too (§6.4).
      'channels.streaming',
      'channels.acknowledge',
      'channels.typing',
    ],
    rollback: true,
    hostState: false,
    // MCPL RFC-001: tags on Discord message events. The umbrellas are emitted
    // directly, so a host needs no implication expansion.
    tagOntology: {
      coreTags: [
        'chat:addressed', 'chat:mention', 'chat:reply', 'chat:dm', 'chat:ambient',
        'chat:private', 'chat:from-human', 'chat:from-bot', 'chat:thread',
        'chat:edited', 'chat:deleted', 'chat:reaction', 'chat:reaction-remove',
        'chat:has-image', 'chat:has-audio', 'chat:has-file',
      ],
      // RFC-001 rev 2 renamed `defaultTreatment` to `suggestedTreatment`, a hint a
      // host applies only on explicit acceptance (SPEC §16.5). The pinned
      // @animalabs/mcpl-core still types the old name (mcpl-core-ts#6 renames it),
      // hence the cast.
      ...({
        suggestedTreatment: [
          { tagsAny: ['chat:addressed'], behavior: 'immediate' },
          { tagsAny: ['chat:ambient', 'chat:from-bot'], behavior: { throttle: { perMs: 120000 } } },
        ],
      } as object),
      // Discord-specific extensions (e.g. discord:everyone, discord:slash) may be
      // emitted in future; consumers should tolerate undeclared tags.
      open: true,
    },
  },
  {
    name: 'discord.channels',
    description: 'Create, delete, and manage Discord channels',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'discord.history',
    description: 'Fetch message history from Discord channels',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'discord.subscriptions',
    description:
      'Manage per-channel ambient-message subscriptions (which channels deliver ' +
      'non-mention messages for passive awareness). Mentions and DMs are always ' +
      'delivered and are not affected by subscriptions.',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
];

/** Check if a feature set is in a given enabled list. */
export function isEnabled(name: string, enabledSets: Set<string>): boolean {
  // Check exact match
  if (enabledSets.has(name)) return true;
  // Check wildcard (e.g., "discord.*")
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabledSets.has(prefix)) return true;
  }
  return false;
}

/** Get the feature set that owns a given tool. Returns undefined for always-available tools. */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'send_message':
    case 'reply_message':
    case 'send_dm':
    case 'add_reaction':
    case 'remove_reaction':
    case 'list_emojis':
    case 'edit_message':
    case 'delete_message':
      return 'discord.messaging';
    case 'create_text_channel':
    case 'delete_channel':
      return 'discord.channels';
    case 'fetch_history':
    case 'fetch_around':
      return 'discord.history';
    case 'subscribe_channel':
    case 'unsubscribe_channel':
    case 'mute_channel':
    case 'unmute_channel':
    case 'list_subscriptions':
    case 'channel_missed':
    case 'set_reaction_visibility':
      return 'discord.subscriptions';
    case 'list_guilds':
    case 'list_channels':
    case 'list_channel_members':
    case 'refresh_channels':
    case 'filters_get':
    case 'filters_update':
      return undefined; // Always available
    default:
      return undefined;
  }
}
