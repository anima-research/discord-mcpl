import { ERR_UNKNOWN_CHANNEL, type ChannelDescriptor } from '@animalabs/mcpl-core';
import type { ChannelFacts } from './discord-adapter.js';
import { formatChannelLabel, formatThreadLabel, isNameAddressableKind, isThreadLabelShape } from './channel-names.js';
import { nameValue, quotedLabel } from './source-header.js';

export type DiscordChannelDescriptor = ChannelDescriptor & {
  initiallyOpen?: boolean;
  capabilities?: {
    history?: { maxMessages?: number; supportsBeforeMessage?: boolean };
    acknowledgment?: { kind?: string; supportsValue?: boolean };
  };
};

export function mcplChannelId(guildId: string, channelId: string): string {
  return `discord:${guildId}:${channelId}`;
}

export function parseMcplChannelId(id: string): { guildId: string; channelId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'discord') return null;
  return { guildId: parts[1], channelId: parts[2] };
}

/**
 * A guild channel's label, the same whichever path registered it:
 * - a channel the resolver names (text, announcement, voice, stage): its
 *   address, `#name (Guild)`, the string a tool's channelId accepts back,
 *   while that resolves back to it;
 * - a thread: `#parent › thread (Guild)`, display only, or `› thread (Guild)`
 *   when its channel's name isn't known. Threads are addressed by id;
 * - anything else: its composite id, `discord:<guild>:<channel>`, which
 *   addresses exactly this channel. That is the label when the guild's or the
 *   channel's name isn't known, for a kind the resolver doesn't name, for a
 *   voice or stage channel whose name has a thread label's shape
 *   (`general › design`), and for a channel whose name resolves to another
 *   channel.
 */
export function channelLabelFor(c: ChannelFacts): string {
  if (c.guildName && c.name) {
    if (c.type === 'thread') return formatThreadLabel(c.parentName, c.name, c.guildName);
    if (isNameAddressableKind(c.type) && !isThreadLabelShape(c.name) && c.nameResolves !== false) {
      return formatChannelLabel(c.name, c.guildName);
    }
  }
  return mcplChannelId(c.guildId, c.id);
}

export function toDescriptor(
  channel: ChannelFacts,
  initiallyOpen = false,
  maxHistory = 500,
): DiscordChannelDescriptor {
  return {
    id: mcplChannelId(channel.guildId, channel.id),
    type: 'discord',
    label: channelLabelFor(channel),
    direction: 'bidirectional',
    address: { guildId: channel.guildId, channelId: channel.id },
    metadata: {
      channelType: channel.type,
      ...(channel.parentId ? { parentId: channel.parentId } : {}),
      ...(channel.name ? { channelName: channel.name } : {}),
      ...(channel.guildName ? { guildName: channel.guildName } : {}),
      ...(channel.type === 'thread' && channel.parentName ? { parentName: channel.parentName } : {}),
    },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
    },
  };
}

export function dmLabel(recipientName: string): string {
  return `DM: ${nameValue(recipientName)}`;
}

export function toDmDescriptor(
  channelId: string,
  recipientName: string,
  initiallyOpen = false,
  maxHistory = 500,
  recipientId?: string,
): DiscordChannelDescriptor {
  return {
    id: mcplChannelId('dm', channelId),
    type: 'discord',
    label: dmLabel(recipientName),
    direction: 'bidirectional',
    address: { guildId: 'dm', channelId },
    // The host resolves `>>@name` and `<@id>` mention tokens against recipientName and recipientId.
    metadata: { channelType: 'dm', recipientName, ...(recipientId ? { recipientId } : {}) },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
    },
  };
}

export const OPEN_CHOICES_SHOWN = 10;

/** JSON-RPC's code for invalid params (MCPL's own codes are mcpl-core's ERR_*). */
export const INVALID_PARAMS = -32602;

export class RequestRefusal extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'RequestRefusal';
  }
}

export function echo(value: string): string {
  return JSON.stringify(value.length > 100 ? `${value.slice(0, 100)}…` : value);
}

export function typeName(type: string): string {
  return /^[a-z][\w.-]{0,39}$/i.test(type) ? type : echo(type);
}

export type OpenTarget =
  | { kind: 'registered'; channel: ChannelDescriptor }
  | { kind: 'unregistered'; id: string; via: string }
  | { kind: 'refused'; code: number; reason: string };

/**
 * MCPL's channels/open requires `type` and has no `channelId`.
 * agent-framework's ChannelsOpenParams adds `channelId`, the exact registered
 * id to open, and asks a server that doesn't know the id to refuse rather
 * than open another channel.
 */
export function resolveOpenTarget(
  params: { channelId?: unknown; type?: unknown; address?: unknown },
  channels: readonly ChannelDescriptor[],
): OpenTarget {
  const refuse = (code: number, reason: string): OpenTarget => ({ kind: 'refused', code, reason });
  const { type } = params;
  if (typeof type !== 'string' || type === '') {
    return refuse(INVALID_PARAMS, 'type must be a non-empty string naming a channel type, such as "discord". Nothing was opened.');
  }
  const byId = new Map(channels.map((c) => [c.id, c]));
  const exact = (id: string, via: string): OpenTarget => {
    const channel = byId.get(id);
    if (!channel) {
      return parseMcplChannelId(id)
        ? { kind: 'unregistered', id, via }
        : refuse(ERR_UNKNOWN_CHANNEL, `${via} names no channel: a Discord channel id has the form discord:<guildId>:<channelId> (discord:dm:<channelId> for a DM). Nothing was opened.`);
    }
    if (channel.type !== type) {
      return refuse(INVALID_PARAMS, `${via} is a ${channel.type} channel, not ${typeName(type)}. Nothing was opened.`);
    }
    return { kind: 'registered', channel };
  };

  const { channelId } = params;
  if (channelId !== undefined && channelId !== null) {
    if (typeof channelId !== 'string') {
      return refuse(INVALID_PARAMS, 'channelId must be a string, such as "discord:<guildId>:<channelId>" (send null or omit it for no selector). Nothing was opened.');
    }
    if (channelId === '') {
      return refuse(INVALID_PARAMS, 'channelId is empty: send null or omit it for no selector, or name the channel as discord:<guildId>:<channelId>. Nothing was opened.');
    }
    return exact(channelId, `channelId ${echo(channelId)}`);
  }

  const addr = params.address;
  const isObject = typeof addr === 'object' && addr !== null && !Array.isArray(addr);
  if (addr !== undefined && addr !== null && !(isObject && Object.keys(addr).length === 0)) {
    if (!isObject) {
      return refuse(INVALID_PARAMS, 'address must be absent, null, {}, or an object naming a guildId and a channelId. Nothing was opened.');
    }
    const a = addr as { guildId?: unknown; channelId?: unknown };
    if ((a.guildId !== undefined && typeof a.guildId !== 'string') || (a.channelId !== undefined && typeof a.channelId !== 'string')) {
      return refuse(INVALID_PARAMS, 'address guildId and channelId are strings (a Discord id as a JSON number loses precision). Nothing was opened.');
    }
    if (!a.guildId || !a.channelId) {
      return refuse(INVALID_PARAMS, 'address must name both a guildId and a channelId, or be absent, null or {} for no selector. Nothing was opened.');
    }
    return exact(mcplChannelId(a.guildId as string, a.channelId as string), `address ${echo(a.guildId as string)}/${echo(a.channelId as string)}`);
  }

  const candidates = channels.filter((c) => c.type === type);
  if (candidates.length === 1) return { kind: 'registered', channel: candidates[0] };
  if (candidates.length === 0) {
    return refuse(ERR_UNKNOWN_CHANNEL, `No ${typeName(type)} channel is registered, so there is none to open without a selector. Nothing was opened.`);
  }
  const shown = candidates.slice(0, OPEN_CHOICES_SHOWN).map((c) => `${c.id} (${quotedLabel(c.label)})`).join(', ');
  const more = candidates.length > OPEN_CHOICES_SHOWN
    ? `, and ${candidates.length - OPEN_CHOICES_SHOWN} more, which channels/list returns`
    : '';
  return refuse(
    INVALID_PARAMS,
    `${candidates.length} ${typeName(type)} channels are registered; name one with channelId. Choices: ${shown}${more}. Nothing was opened.`,
  );
}

export class ChannelManager {
  private registered = new Map<string, ChannelDescriptor>();

  private openChannels = new Set<string>();

  registerAll(descriptors: ChannelDescriptor[]): void {
    for (const d of descriptors) {
      this.registered.set(d.id, d);
    }
  }

  register(descriptor: ChannelDescriptor): void {
    this.registered.set(descriptor.id, descriptor);
  }

  unregister(id: string): boolean {
    this.openChannels.delete(id);
    return this.registered.delete(id);
  }

  open(id: string): ChannelDescriptor | undefined {
    const desc = this.registered.get(id);
    if (desc) {
      this.openChannels.add(id);
    }
    return desc;
  }

  openByDiscordId(guildId: string, channelId: string): ChannelDescriptor | undefined {
    const id = mcplChannelId(guildId, channelId);
    return this.open(id);
  }

  close(id: string): boolean {
    return this.openChannels.delete(id);
  }

  isOpen(id: string): boolean {
    return this.openChannels.has(id);
  }

  isDiscordChannelOpen(guildId: string, channelId: string): boolean {
    return this.openChannels.has(mcplChannelId(guildId, channelId));
  }

  get(id: string): ChannelDescriptor | undefined {
    return this.registered.get(id);
  }

  getAll(): ChannelDescriptor[] {
    return [...this.registered.values()];
  }

  getOpen(): ChannelDescriptor[] {
    return [...this.openChannels]
      .map((id) => this.registered.get(id))
      .filter((d): d is ChannelDescriptor => d !== undefined);
  }
}
