import { after, before, describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPERATOR_ENV = [
  'DISCORD_SUBSCRIPTIONS_FILE', 'DISCORD_MUTED_CHANNELS_FILE', 'DISCORD_REACTION_CHANNELS_FILE', 'DISCORD_WATERMARK_FILE',
  'DISCORD_FILTERS_FILE', 'DISCORD_SUPPRESS_REACTION_EMOJIS', 'DISCORD_SUPPRESSED_REACTIONS_BASELINE',
];
const savedEnv = new Map<string, string | undefined>();

function fixture(t: TestContext, filed?: string) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  t.after(() => adapter.rawClient.destroy());
  const server = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & {
    setupDiscordForwarding(): void;
    subscribeRawChannel(channelId: string): void;
    executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    handleChannelOpen(params: Record<string, unknown>): Promise<unknown>;
    channelManager: { register(d: unknown): void };
  };
  const pushes: unknown[] = [];
  server.conn = { sendRequest: async (_m: string, params: unknown) => { pushes.push(params); return {}; } };
  server.mcplEnabled = true;
  (server.enabledFeatureSets as Set<string>).add('discord.messaging');
  server.subscriptionsLoaded = true;
  server.watermarkLoaded = true;
  if (filed) {
    process.env.DISCORD_MUTED_CHANNELS_FILE = join(filed, 'muted.json');
    process.env.DISCORD_REACTION_CHANNELS_FILE = join(filed, 'reactions.json');
    t.after(() => { delete process.env.DISCORD_MUTED_CHANNELS_FILE; delete process.env.DISCORD_REACTION_CHANNELS_FILE; });
  } else {
    server.mutedLoaded = true;
    server.reactionChannelsLoaded = true;
  }
  server.channelManager.register({ id: 'discord:g1:chan1', type: 'discord', label: '#chan1', address: { guildId: 'g1', channelId: 'chan1' } });
  server.setupDiscordForwarding();
  let n = 0;
  const react = () => (adapter as unknown as { reactionHandler: (ev: unknown) => void }).reactionHandler({
    channelId: 'chan1', messageId: `msg${++n}`, guildId: 'g1', userId: 'u1', userName: 'alice',
    action: 'add', emoji: '😀', emojiId: null, token: '😀', onOwnMessage: false,
    messageSnippet: 'hello', timestamp: new Date(1700000000000 + n),
  });
  const open = () => server.handleChannelOpen({ channelId: 'discord:g1:chan1', type: 'discord' });
  return { server, pushes, react, open };
}

describe('reactions in a muted channel', () => {
  before(() => { for (const name of OPERATOR_ENV) { savedEnv.set(name, process.env[name]); delete process.env[name]; } });
  after(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('a muted channel delivers no reactions, and once the mute has closed it they return with channel_open, not with unmute', async (t) => {
    const f = fixture(t);
    f.server.subscribeRawChannel('chan1');
    f.react();
    assert.equal(f.pushes.length, 1, 'an open channel delivers its reactions');

    await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
    f.react();
    assert.equal(f.pushes.length, 1, 'muted: no reaction reaches the agent');

    await f.server.executeToolCall('unmute_channel', { channelId: 'chan1' });
    f.react();
    assert.equal(f.pushes.length, 1, 'unmuted but not reopened: still no reactions');

    await f.open();
    f.react();
    assert.equal(f.pushes.length, 2, 'reopened with channel_open: reactions arrive again');
  });

  it('no reaction gets through while muted, even with visibility turned on again, and that opt-in applies once unmuted', async (t) => {
    const f = fixture(t);
    await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
    const reply = await f.server.executeToolCall('set_reaction_visibility', { channelId: 'chan1', visible: true });
    assert.match(String(reply), /but the channel is muted: its reactions reach you once unmute_channel lifts the mute/);
    assert.equal((f.server.reactionChannels as Set<string>).has('chan1'), true, 'the opt-in itself took effect');
    f.react();
    assert.deepEqual(f.pushes, [], 'muting takes precedence over the opt-in');
    await f.server.executeToolCall('unmute_channel', { channelId: 'chan1' });
    f.react();
    assert.equal(f.pushes.length, 1, 'unmuted: the opt-in made during the mute delivers');
  });

  it("a mute's drop of reaction visibility is saved, so a restart doesn't bring the reactions back", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'muted-reactions-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = fixture(t, dir);
    await first.server.executeToolCall('set_reaction_visibility', { channelId: 'chan1', visible: true });
    await first.server.executeToolCall('mute_channel', { channelId: 'chan1' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'reactions.json'), 'utf8')), [], 'the drop is on disk');

    const second = fixture(t, dir);
    await second.server.executeToolCall('unmute_channel', { channelId: 'chan1' });
    second.react();
    assert.deepEqual(second.pushes, [], 'after a restart and unmute, reactions stay off until channel_open');
    await second.open();
    second.react();
    assert.equal(second.pushes.length, 1, 'channel_open brings them back');
  });
});
