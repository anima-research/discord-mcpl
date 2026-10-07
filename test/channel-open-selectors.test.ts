/**
 * channels/open resolves every supplied selector against one registered
 * channel. A stale or contradictory selector is refused before any history is
 * fetched or anything is opened; it never falls back to another channel of
 * the same type.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { resolveOpenTarget, toDescriptor, toDmDescriptor } from '../src/channels.js';

const general = toDescriptor('g1', 'Guild', { id: 'c1', name: 'general', type: 'text', label: '#general (Guild)' });
const dev = toDescriptor('g1', 'Guild', { id: 'c2', name: 'dev', type: 'text', label: '#dev (Guild)' });
const dm = toDmDescriptor('d1', 'Ra');

function fixture(channels = [general, dev]) {
  const fetched: string[] = [];
  const adapter = {
    async fetchHistory(channelId: string) {
      fetched.push(channelId);
      return [{
        id: '900', authorId: 'u1', authorName: 'Alice', isBot: false, content: `from ${channelId}`,
        cleanContent: `from ${channelId}`, attachments: [], mentionsBot: false, timestamp: new Date(), reactions: [],
      }];
    },
  } as unknown as DiscordAdapter;
  const server = new DiscordMcplServer(adapter) as unknown as {
    channelManager: { register(d: unknown): void; isOpen(id: string): boolean; getAll(): unknown[] };
    subscribedChannels: Set<string>;
    subscriptionsLoaded: boolean;
    reactionChannelsLoaded: boolean;
    mutedLoaded: boolean;
    handleChannelOpen(params: Record<string, unknown>): Promise<{ channel: { id: string }; history?: Array<{ channelId: string; content: Array<{ text: string }> }> }>;
  };
  server.subscriptionsLoaded = true;
  server.reactionChannelsLoaded = true;
  server.mutedLoaded = true;
  for (const c of channels) server.channelManager.register(c);
  const nothingOpened = () => {
    assert.deepEqual(fetched, [], 'no history was fetched');
    for (const c of channels) assert.equal(server.channelManager.isOpen(c.id), false, `${c.id} stayed closed`);
    assert.equal(server.subscribedChannels.size, 0, 'nothing was subscribed');
  };
  return { server, fetched, nothingOpened };
}

describe('channels/open selectors', () => {
  it('refuses a stale channelId even when another channel of the same type is registered', async () => {
    const f = fixture();
    await assert.rejects(
      f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 10 } }),
      /No registered channel matches channelId "discord:g1:c9"; nothing was opened/,
    );
    f.nothingOpened();
  });

  it('refuses a stale address the same way', async () => {
    const f = fixture();
    await assert.rejects(
      f.server.handleChannelOpen({ type: 'discord', address: { guildId: 'g1', channelId: 'c9' }, history: { limit: 10 } }),
      /No registered channel matches address g1\/c9/,
    );
    f.nothingOpened();
  });

  it('refuses a channelId and an address that name different channels', async () => {
    const f = fixture();
    await assert.rejects(
      f.server.handleChannelOpen({
        channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c2' }, history: { limit: 10 },
      }),
      /The selectors name different channels \(channelId "discord:g1:c1" → discord:g1:c1; address g1\/c2 → discord:g1:c2\)/,
    );
    f.nothingOpened();
  });

  it('refuses a malformed address instead of ignoring it', async () => {
    const f = fixture();
    await assert.rejects(
      f.server.handleChannelOpen({ type: 'discord', address: { guildId: 'g1' } }),
      /address must be an object naming both a guildId and a channelId/,
    );
    f.nothingOpened();
  });

  it('refuses an empty or non-string channelId and a non-object address, even when one channel would fit by type', async () => {
    for (const selector of [
      { channelId: '' },
      { channelId: null },
      { channelId: 42 },
      { address: [] },
      { address: false },
      { address: 'g1/c1' },
    ]) {
      const f = fixture([general]); // selector-free, this request would open discord:g1:c1
      await assert.rejects(
        f.server.handleChannelOpen({ type: 'discord', ...selector, history: { limit: 10 } }),
        /channelId must be a registered channel id|address must be an object naming both a guildId and a channelId/,
        JSON.stringify(selector),
      );
      f.nothingOpened();
    }
  });

  it('treats only an omitted channelId with a null or empty-object address as selector-free', async () => {
    for (const selector of [{}, { address: null }, { address: {} }]) {
      const f = fixture([general]);
      const res = await f.server.handleChannelOpen({ type: 'discord', ...selector });
      assert.equal(res.channel.id, 'discord:g1:c1', JSON.stringify(selector));
    }
  });

  it('opens exactly the channel an id names, with its own history', async () => {
    const f = fixture();
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c2', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.id, 'discord:g1:c2');
    assert.deepEqual(f.fetched, ['c2']);
    assert.equal(res.history?.[0].channelId, 'discord:g1:c2');
    assert.match(res.history?.[0].content[0].text ?? '', /from c2/);
    assert.equal(f.server.channelManager.isOpen('discord:g1:c2'), true);
    assert.equal(f.server.channelManager.isOpen('discord:g1:c1'), false);
  });

  it('opens exactly the channel an address names, and accepts a matching id beside it', async () => {
    const f = fixture();
    const byAddress = await f.server.handleChannelOpen({ type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    assert.equal(byAddress.channel.id, 'discord:g1:c1');
    const both = await f.server.handleChannelOpen({
      channelId: 'discord:g1:c2', type: 'discord', address: { guildId: 'g1', channelId: 'c2' },
    });
    assert.equal(both.channel.id, 'discord:g1:c2');
  });

  it('lets a selector-free request open the only compatible channel', async () => {
    const f = fixture([general]);
    const res = await f.server.handleChannelOpen({ type: 'discord', address: {} });
    assert.equal(res.channel.id, 'discord:g1:c1');
  });

  it('refuses a selector-free request when several channels fit, listing bounded choices', async () => {
    const f = fixture([general, dev, dm]);
    await assert.rejects(
      f.server.handleChannelOpen({ type: 'discord', history: { limit: 10 } }),
      (err: Error) => {
        assert.match(err.message, /^3 discord channels are registered; name one with channelId\. Choices: /);
        assert.ok(err.message.includes('discord:g1:c1 (#general (Guild))'));
        assert.ok(err.message.includes('discord:dm:d1 (DM: Ra)'));
        assert.match(err.message, /Nothing was opened\.$/);
        return true;
      },
    );
    f.nothingOpened();
  });

  it('summarizes long choice lists and names a type mismatch', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      toDescriptor('g1', 'Guild', { id: `c${i}`, name: `room${i}`, type: 'text', label: `#room${i} (Guild)` }));
    const res = resolveOpenTarget({ type: 'discord' }, many);
    assert.equal(res.ok, false);
    assert.match((res as { reason: string }).reason, /, and 3 more\. Nothing was opened\./);
    const mismatch = resolveOpenTarget({ channelId: 'discord:g1:c1', type: 'slack' }, [general]);
    assert.deepEqual(mismatch, { ok: false, reason: 'channelId "discord:g1:c1" is a discord channel, not slack; nothing was opened.' });
    assert.deepEqual(resolveOpenTarget({ type: 'discord' }, []), {
      ok: false, reason: 'No discord channel is registered; nothing was opened.',
    });
  });
});
