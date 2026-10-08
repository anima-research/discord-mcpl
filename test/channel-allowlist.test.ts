/**
 * The per-guild channel whitelist (`guildChannels`) and threads. A thread
 * counts as its parent channel, so it is admitted exactly when its channel
 * is, including when the channel is admitted only through a listed category.
 * Before, only one parent level was checked: a thread's parent is its
 * channel, so threads in a category-admitted channel were dropped, and a
 * category-admitted forum lost every post. Hamish-1866 and Leonard-1867
 * found it reviewing #72.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';

const G1 = '500000000000000001';
const G2 = '500000000000000002';
const CATEGORY = '510000000000000001';
const OTHER_CATEGORY = '510000000000000002';
const LISTED = '520000000000000001';
const IN_CATEGORY = '520000000000000002';
const FORUM_IN_CATEGORY = '520000000000000003';
const UNLISTED = '520000000000000004';
const UNCACHED_CHANNEL = '520000000000000005';
const THREAD_OF_LISTED = '530000000000000001';
const THREAD_IN_CATEGORY = '530000000000000002';
const FORUM_POST = '530000000000000003';
const THREAD_OF_UNLISTED = '530000000000000004';
const THREAD_OF_UNCACHED = '530000000000000005';

/** Each channel's own parent: a category for a channel, the channel for a thread. */
const PARENT: Record<string, string | null> = {
  [CATEGORY]: null,
  [OTHER_CATEGORY]: null,
  [LISTED]: OTHER_CATEGORY,
  [IN_CATEGORY]: CATEGORY,
  [FORUM_IN_CATEGORY]: CATEGORY,
  [UNLISTED]: OTHER_CATEGORY,
  [THREAD_OF_LISTED]: LISTED,
  [THREAD_IN_CATEGORY]: IN_CATEGORY,
  [FORUM_POST]: FORUM_IN_CATEGORY,
  [THREAD_OF_UNLISTED]: UNLISTED,
  [THREAD_OF_UNCACHED]: UNCACHED_CHANNEL,
};

function fixture(t: { after: (fn: () => void) => void }) {
  const adapter = new DiscordAdapter({ token: 'unused', guildChannels: { [G1]: [LISTED, CATEGORY] } });
  const internals = adapter as unknown as {
    client: Client;
    channelAllowed(guildId: string | null, channelId: string, parentId?: string | null): boolean;
    messageFilterReason(message: unknown): string | null;
  };
  t.after(() => internals.client.destroy());
  // The guild's channels as the GUILDS intent caches them; UNCACHED_CHANNEL
  // is deliberately missing.
  const cache = internals.client.channels.cache as unknown as Map<string, unknown>;
  for (const [id, parentId] of Object.entries(PARENT)) {
    cache.set(id, { id, guildId: G1, parentId });
  }
  const allowed = (id: string) => internals.channelAllowed(G1, id, PARENT[id] ?? null);
  return { internals, allowed };
}

describe('guildChannels admits threads with their channel, through a category too', () => {
  it('admits listed channels, channels under a listed category, and their threads', (t) => {
    const { allowed } = fixture(t);
    for (const id of [LISTED, IN_CATEGORY, FORUM_IN_CATEGORY, THREAD_OF_LISTED, THREAD_IN_CATEGORY, FORUM_POST]) {
      assert.equal(allowed(id), true, `${id} is admitted`);
    }
  });

  it('still excludes unlisted channels and their threads, and a thread whose channel it cannot see', (t) => {
    const { allowed } = fixture(t);
    for (const id of [UNLISTED, THREAD_OF_UNLISTED, OTHER_CATEGORY, THREAD_OF_UNCACHED]) {
      assert.equal(allowed(id), false, `${id} is excluded`);
    }
  });

  it('leaves a guild without an entry unrestricted', (t) => {
    const { internals } = fixture(t);
    assert.equal(internals.channelAllowed(G2, '590000000000000001', '590000000000000002'), true);
  });

  it('delivers a post in a forum admitted only through its category, at ingress', (t) => {
    const { internals } = fixture(t);
    const message = (channelId: string) => ({
      id: '600000000000000001',
      author: { id: '610000000000000001' },
      guildId: G1,
      channelId,
      channel: { id: channelId, parentId: PARENT[channelId] },
    });
    assert.equal(internals.messageFilterReason(message(FORUM_POST)), null);
    assert.equal(internals.messageFilterReason(message(THREAD_IN_CATEGORY)), null);
    assert.equal(internals.messageFilterReason(message(THREAD_OF_UNLISTED)), 'channel-not-allowed');
  });
});
