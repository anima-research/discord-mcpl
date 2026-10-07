/**
 * MCPL channel management — maps Discord channels to MCPL ChannelDescriptors.
 */

import type { ChannelDescriptor } from '@animalabs/mcpl-core';
import type { DiscordChannelInfo } from './discord-adapter.js';
import { formatChannelLabel } from './channel-names.js';

export type DiscordChannelDescriptor = ChannelDescriptor & {
  initiallyOpen?: boolean;
  capabilities?: {
    history?: { maxMessages?: number; supportsBeforeMessage?: boolean };
    acknowledgment?: { kind?: string; supportsValue?: boolean };
  };
};

/** MCPL channel ID format: discord:<guildId>:<channelId> */
export function mcplChannelId(guildId: string, channelId: string): string {
  return `discord:${guildId}:${channelId}`;
}

/** Parse an MCPL channel ID back to guildId + channelId. Returns null if not a discord channel. */
export function parseMcplChannelId(id: string): { guildId: string; channelId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'discord') return null;
  return { guildId: parts[1], channelId: parts[2] };
}

/** Convert a Discord channel to an MCPL ChannelDescriptor. */
export function toDescriptor(
  guildId: string,
  guildName: string,
  channel: DiscordChannelInfo,
  initiallyOpen = false,
  maxHistory = 500,
): DiscordChannelDescriptor {
  return {
    id: mcplChannelId(guildId, channel.id),
    type: 'discord',
    // Same formatter the resolver parses back, so this descriptor's label is
    // by construction a valid channelId argument.
    label: formatChannelLabel(channel.name, guildName),
    direction: 'bidirectional',
    address: { guildId, channelId: channel.id },
    metadata: { channelType: channel.type, parentId: channel.parentId },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
    },
  };
}

/** Convert a DM channel to an MCPL ChannelDescriptor.
 *
 * DMs have no guild — the id uses the `dm` pseudo-guild segment
 * (`discord:dm:<channelId>`), matching the id handleDiscordMessage forwards
 * events under. Without this descriptor DMs were never registered at all
 * (registration only ran off guild events), so `channel_open` on a DM id
 * could never resolve and DM open/subscription state never stuck
 * (observed on Mythos, 2026-07-18). */
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
    label: `DM: ${recipientName}`,
    direction: 'bidirectional',
    address: { guildId: 'dm', channelId },
    // recipientName/recipientId make DM addressing people-first: the host
    // resolves `>>@name` and `<@id>` mention tokens against them (explicit
    // prose routing), instead of forcing agents through raw channel ids.
    metadata: { channelType: 'dm', recipientName, ...(recipientId ? { recipientId } : {}) },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
    },
  };
}

/**
 * Tracks which channels are registered (known to host) and which are open
 * (host has explicitly opened them for bidirectional message flow).
 */
/** How many candidates an ambiguity refusal lists before summarizing. */
const OPEN_CHOICES_SHOWN = 10;

/**
 * Resolve a channels/open request to exactly one registered channel, or say
 * why it can't. Every selector the caller supplied must name the same
 * channel: an explicit channelId or address that is unknown, malformed, or
 * contradicts another selector is refused, never replaced by a looser match.
 * Only a request with no selector at all (a legacy host) may pick a channel
 * by type, and only when exactly one of that type is registered.
 *
 * "No selector" is narrow. channelId is optional in MCPL, so it is absent
 * only when omitted; an empty or non-string channelId is an invalid selector.
 * address is a required field, so a selector-free host sends it as null or
 * an empty object; anything else must be an object naming both guildId and
 * channelId (an array, say, is refused).
 */
export function resolveOpenTarget(
  params: { channelId?: unknown; type?: unknown; address?: unknown },
  channels: readonly ChannelDescriptor[],
): { ok: true; channel: ChannelDescriptor } | { ok: false; reason: string } {
  const type = typeof params.type === 'string' && params.type.length > 0 ? params.type : null;
  const byId = new Map(channels.map((c) => [c.id, c]));
  const named: Array<{ via: string; id: string }> = [];

  if (params.channelId !== undefined) {
    if (typeof params.channelId !== 'string' || params.channelId === '') {
      return {
        ok: false,
        reason: 'channelId must be a registered channel id; an empty or non-string channelId names no channel (omit it to open by type). Nothing was opened.',
      };
    }
    named.push({ via: `channelId "${params.channelId}"`, id: params.channelId });
  }
  const addr = params.address;
  const isObject = typeof addr === 'object' && addr !== null && !Array.isArray(addr);
  if (addr !== undefined && addr !== null && !(isObject && Object.keys(addr).length === 0)) {
    const a = addr as { guildId?: unknown; channelId?: unknown };
    if (!isObject || typeof a.guildId !== 'string' || !a.guildId
      || typeof a.channelId !== 'string' || !a.channelId) {
      return { ok: false, reason: 'address must be an object naming both a guildId and a channelId. Nothing was opened.' };
    }
    named.push({ via: `address ${a.guildId}/${a.channelId}`, id: mcplChannelId(a.guildId, a.channelId) });
  }

  if (named.length > 0) {
    for (const n of named) {
      if (!byId.has(n.id)) {
        return { ok: false, reason: `No registered channel matches ${n.via}; nothing was opened.` };
      }
    }
    if (named.some((n) => n.id !== named[0].id)) {
      return {
        ok: false,
        reason: `The selectors name different channels (${named.map((n) => `${n.via} → ${n.id}`).join('; ')}); nothing was opened.`,
      };
    }
    const channel = byId.get(named[0].id)!;
    if (type && channel.type !== type) {
      return { ok: false, reason: `${named[0].via} is a ${channel.type} channel, not ${type}; nothing was opened.` };
    }
    return { ok: true, channel };
  }

  const candidates = channels.filter((c) => !type || c.type === type);
  if (candidates.length === 1) return { ok: true, channel: candidates[0] };
  if (candidates.length === 0) {
    return { ok: false, reason: `No ${type ?? ''} channel is registered${type ? '' : ' at all'}; nothing was opened.`.replace('No  channel', 'No channel') };
  }
  const shown = candidates.slice(0, OPEN_CHOICES_SHOWN).map((c) => `${c.id} (${c.label})`).join(', ');
  const more = candidates.length > OPEN_CHOICES_SHOWN ? `, and ${candidates.length - OPEN_CHOICES_SHOWN} more` : '';
  return {
    ok: false,
    reason: `${candidates.length} ${type ?? ''} channels are registered; name one with channelId. Choices: ${shown}${more}. Nothing was opened.`.replace(/ {2}/g, ' '),
  };
}

export class ChannelManager {
  /** All registered channel descriptors, keyed by MCPL channel ID. */
  private registered = new Map<string, ChannelDescriptor>();

  /** Set of open channel IDs (subset of registered). */
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

  /** Open a channel by Discord guildId + channelId. Returns the descriptor if found. */
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

  /** Check if a Discord channel (by guildId:channelId) has an open MCPL channel. */
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
