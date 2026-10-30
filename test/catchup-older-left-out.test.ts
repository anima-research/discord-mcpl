import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

const G = '100000000000000001';
const P = '100000000000000002';
const Q = '100000000000000003';
const OTHER = '100000000000000006';
const BOT = '100000000000000004';
const U = '100000000000000005';
const bot = { id: BOT, username: 'bot', discriminator: '0', avatar: null };
const POSITION = 300000000000000000n;
const idAt = (n: number) => (POSITION + BigInt(n)).toString();
const at = (id: string | undefined) => (id === undefined ? undefined : `m${BigInt(id) - POSITION}`);
const placeOf = (id: string, name: string) => `channel="#${name}" channelId="${id}" guild="Guild"`;
const PLACE = placeOf(P, 'before');

function wire(n: number, mention: boolean, sameMillisecond: boolean) {
  return {
    id: idAt(n),
    author: { id: U, username: 'bob', displayName: 'Bob', bot: false },
    member: null, system: false, type: 0,
    content: `m${n}`, cleanContent: `m${n}`, messageSnapshots: null,
    attachments: new Map(), reactions: { cache: new Map() },
    createdAt: new Date(1_700_000_000_000 + (sameMillisecond && n > 0 ? 0 : n * 1000)),
    mentions: { users: new Map(mention ? [[BOT, bot]] : []), repliedUser: null, roles: { some: () => false } },
  };
}

interface ChannelSpec { id: string; name: string; open: boolean; sent: number; mentionAt?: number; sameMillisecond?: boolean }

async function catchUp(t: TestContext, o: {
  limit: number; channels: ChannelSpec[]; guildChannels?: Record<string, string[]>;
}): Promise<{ pushed: string[]; logged: string[]; positions: Map<string, string | undefined> }> {
  const file = join(tmpdir(), `catchup-older-left-out-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  t.after(() => { if (existsSync(file)) unlinkSync(file); });
  const adapter = new DiscordAdapter({ token: 'unused', ...(o.guildChannels ? { guildChannels: o.guildChannels } : {}) });
  const client = adapter.rawClient as any;
  t.after(() => client.destroy());
  client.user = client.users._add({ ...bot, bot: true });
  const guild = client.guilds._add({
    id: G, name: 'Guild', owner_id: BOT, roles: [],
    channels: [
      ...o.channels.map((c) => ({ id: c.id, guild_id: G, type: ChannelType.GuildText, name: c.name, parent_id: null })),
      { id: OTHER, guild_id: G, type: ChannelType.GuildText, name: 'other', parent_id: null },
    ],
  });
  guild.members._add({ user: bot, roles: [] });
  const server = new DiscordMcplServer(adapter) as any;
  Object.defineProperty(server, 'catchupLimit', { get: () => o.limit });
  server.watermarkFile = () => file;
  for (const c of o.channels) {
    const messages = Array.from({ length: c.sent + 3 }, (_, i) => wire(i - 2, c.mentionAt === i - 2, c.sameMillisecond ?? false));
    client.channels.cache.get(c.id).messages.fetch = async (page: { limit: number; before?: string }) =>
      new Map(messages
        .filter((m) => page.before === undefined || BigInt(m.id) < BigInt(page.before))
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .slice(0, page.limit)
        .map((m) => [m.id, m]));
    if (c.open) server.subscribedChannels.add(c.id);
    server.forwardedWatermark.set(c.id, idAt(0));
  }
  const pushed: string[] = [];
  server.conn = {
    isClosed: false,
    sendNotification() {},
    sendRequest(method: string, params: any) {
      if (method === 'push/event') pushed.push(params.payload.content[0].text);
      return Promise.resolve({});
    },
  };
  server.mcplEnabled = true;
  server.enabledFeatureSets.add('discord.messaging');
  server.subscriptionsLoaded = server.mutedLoaded = server.watermarkLoaded = true;
  server.saveWatermark = () => {};
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await server.runReconnectSweep();
  } finally {
    console.error = log;
  }
  const positions = new Map(o.channels.map((c) => [c.id, at(server.forwardedWatermark.get(c.id))]));
  return { pushed, logged, positions };
}

const open = (sent: number, more: Partial<ChannelSpec> = {}): ChannelSpec => ({ id: P, name: 'before', open: true, sent, ...more });
const notOpen = (sent: number, more: Partial<ChannelSpec> = {}): ChannelSpec => ({ id: P, name: 'before', open: false, sent, ...more });
const block = (text: string) => text.slice(text.indexOf('<missed '));
const opening = (text: string) => block(text).split('\n')[0];
const lines = (text: string) => block(text).split('\n').slice(1, -1).map((line) => line.replace(/^\[.* id=\d+\] /, ''));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `bob: m${from + i}`);

it('an open channel with more messages since its watermark than the catch-up takes is told older ones were left out', async (t) => {
  const { pushed } = await catchUp(t, { limit: 3, channels: [open(4)] });
  assert.equal(pushed.length, 1, 'one push');
  assert.equal(opening(pushed[0]), `<missed ${PLACE} count="3" older="left out" after="${idAt(0)}" reason="backscroll">`);
  assert.deepEqual(lines(pushed[0]), range(2, 4), 'the newest three');
});

it('a channel that isn\'t open, with a mention among the newest messages, is told older ones were left out', async (t) => {
  const { pushed } = await catchUp(t, { limit: 3, channels: [notOpen(4, { mentionAt: 4 })] });
  assert.equal(pushed.length, 1, 'one push');
  assert.equal(opening(pushed[0]), `<missed ${PLACE} count="1" lines="3" older="left out" after="${idAt(0)}" reason="mention">`);
  assert.deepEqual(lines(pushed[0]), ['bob: m2', 'bob: m3', 'bob (mention): m4']);
});

it('a channel that isn\'t open, with no mention among the newest messages, still hears that older ones were left out, once', async (t) => {
  const { pushed, logged, positions } = await catchUp(t, { limit: 3, channels: [notOpen(4, { mentionAt: 1 })] });
  assert.equal(pushed.length, 1, 'one push');
  assert.equal(block(pushed[0]), `<missed ${PLACE} count="0" lines="0" older="left out" after="${idAt(0)}" reason="backscroll">\n</missed>`);
  assert.ok(!logged.some((line) => line.includes('delivered missed messages')), `no messages were delivered: ${JSON.stringify(logged)}`);
  assert.equal(positions.get(P), 'm4', 'the position moves to the newest, so the next start doesn\'t say it again');
});

it('a catch-up that took every message since the watermark, exactly as many as it takes, says nothing of older ones', async (t) => {
  const { pushed } = await catchUp(t, { limit: 3, channels: [open(3)] });
  assert.equal(pushed.length, 1, 'one push');
  assert.equal(opening(pushed[0]), `<missed ${PLACE} count="3" reason="backscroll">`);
  assert.deepEqual(lines(pushed[0]), range(1, 3));
});

it('a catch-up that took fewer messages than it takes at most says nothing of older ones', async (t) => {
  const { pushed } = await catchUp(t, { limit: 3, channels: [open(2)] });
  assert.equal(pushed.length, 1, 'one push');
  assert.equal(opening(pushed[0]), `<missed ${PLACE} count="2" reason="backscroll">`);
  assert.deepEqual(lines(pushed[0]), range(1, 2));
});

it('a catch-up that left older messages out, but whose messages the channel filters all withhold, pushes nothing', async (t) => {
  for (const channel of [open(4), notOpen(4, { mentionAt: 4 }), notOpen(4)]) {
    const { pushed } = await catchUp(t, { limit: 3, channels: [channel], guildChannels: { [G]: [OTHER] } });
    assert.deepEqual(pushed, [], JSON.stringify(channel));
  }
});

it('messages sent in one millisecond are told apart by their ids: the newest are kept, and the position is the newest', async (t) => {
  const { pushed, positions } = await catchUp(t, { limit: 3, channels: [open(4, { sameMillisecond: true })] });
  assert.equal(pushed.length, 1, 'one push');
  assert.equal(opening(pushed[0]), `<missed ${PLACE} count="3" older="left out" after="${idAt(0)}" reason="backscroll">`);
  assert.deepEqual(lines(pushed[0]), range(2, 4));
  assert.equal(positions.get(P), 'm4');
});

it('at a limit that fills whole pages of 100, one more message is read from the next page, and only then is the push marked', async (t) => {
  const over = await catchUp(t, { limit: 100, channels: [open(101)] });
  assert.equal(over.pushed.length, 1, 'one push');
  assert.equal(opening(over.pushed[0]), `<missed ${PLACE} count="100" older="left out" after="${idAt(0)}" reason="backscroll">`);
  assert.deepEqual(lines(over.pushed[0]), range(2, 101));
  const exactly = await catchUp(t, { limit: 100, channels: [open(100)] });
  assert.equal(exactly.pushed.length, 1, 'one push');
  assert.equal(opening(exactly.pushed[0]), `<missed ${PLACE} count="100" reason="backscroll">`);
  assert.deepEqual(lines(exactly.pushed[0]), range(1, 100));
});

it('the log counts the channels whose messages were delivered, not one that got only the notice', async (t) => {
  const { pushed, logged } = await catchUp(t, {
    limit: 3,
    channels: [open(2), { id: Q, name: 'quiet', open: false, sent: 4, mentionAt: 1 }],
  });
  assert.equal(pushed.length, 2, 'a delivery and a notice');
  assert.ok(pushed.some((text) => block(text) === `<missed ${placeOf(Q, 'quiet')} count="0" lines="0" older="left out" after="${idAt(0)}" reason="backscroll">\n</missed>`));
  assert.ok(logged.some((line) => line.includes('delivered missed messages from 1 channel(s)')), JSON.stringify(logged));
});
