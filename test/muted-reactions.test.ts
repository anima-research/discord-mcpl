/**
 * A muted channel delivers nothing to the agent, reactions included.
 * mute_channel closes the channel, but the reaction visibility that opening
 * it turned on outlived the mute, so reactions kept arriving after the mute
 * promised "no ambient". Now a mute drops that visibility, as a close does,
 * so after unmute_channel reactions stay off until channel_open, as both
 * tools' descriptions say. And while a channel is muted, no reaction gets
 * through, even where visibility is turned on again.
 *
 * Run: node --import tsx --test test/muted-reactions.test.ts
 */
import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

function fixture(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  t.after(() => adapter.rawClient.destroy());
  const server = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & {
    setupDiscordForwarding(): void;
    subscribeRawChannel(channelId: string): void;
    executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  const pushes: unknown[] = [];
  server.conn = { sendRequest: async (_m: string, params: unknown) => { pushes.push(params); return {}; } };
  server.mcplEnabled = true;
  (server.enabledFeatureSets as Set<string>).add('discord.messaging');
  // No persistence files are configured, so each store lives in memory.
  server.subscriptionsLoaded = true;
  server.mutedLoaded = true;
  server.reactionChannelsLoaded = true;
  server.watermarkLoaded = true;
  server.setupDiscordForwarding();
  let n = 0;
  const react = () => (adapter as unknown as { reactionHandler: (ev: unknown) => void }).reactionHandler({
    channelId: 'chan1', messageId: `msg${++n}`, guildId: 'g1', userId: 'u1', userName: 'alice',
    action: 'add', emoji: '😀', emojiId: null, token: '😀', onOwnMessage: false,
    messageSnippet: 'hello', timestamp: new Date(1700000000000 + n),
  });
  return { server, pushes, react };
}

it('a muted channel delivers no reactions, and they return with channel_open, not with unmute', async (t) => {
  const f = fixture(t);
  // Opening the channel turns its reaction visibility on.
  f.server.subscribeRawChannel('chan1');
  f.react();
  assert.equal(f.pushes.length, 1, 'an open channel delivers its reactions');

  await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
  f.react();
  assert.equal(f.pushes.length, 1, 'muted: no reaction reaches the agent');

  await f.server.executeToolCall('unmute_channel', { channelId: 'chan1' });
  f.react();
  assert.equal(f.pushes.length, 1, 'unmuted but not reopened: still no reactions, as the tool texts say');

  f.server.subscribeRawChannel('chan1');
  f.react();
  assert.equal(f.pushes.length, 2, 'reopened: reactions arrive again');
});

it('no reaction gets through while muted, even with visibility turned on again', async (t) => {
  const f = fixture(t);
  await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
  await f.server.executeToolCall('set_reaction_visibility', { channelId: 'chan1', visible: true });
  f.react();
  assert.deepEqual(f.pushes, [], 'muting takes precedence over the opt-in');
});
