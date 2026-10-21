/**
 * list_channels lists a guild's live threads from the cache the gateway
 * keeps (GUILD_CREATE, THREAD_LIST_SYNC and the thread events), so listing
 * them fetches nothing that could bypass the freshness rule (refetchChannel)
 * unless one is stale. An archived thread isn't listed, nor a stale one
 * whose fetch fails, nor one whose channel the guild's cache doesn't hold,
 * and the channel filter admits a thread through its channel or that
 * channel's category. A thread a guild came back without is listed again
 * once Discord reports it, though discord.js leaves it out of the guild's own
 * cache. A thread's label is its `discord:<guild>:<thread>` id, since names
 * don't address threads: a `#name (Guild)` label would not resolve, or would
 * resolve to a channel of the same name.
 *
 * The guild is built with discord.js's own managers and handlers, as in
 * registration-lifecycle.test.ts.
 */
import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ChannelType } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';

const require = createRequire(import.meta.url);
const discordJs = dirname(require.resolve('discord.js'));
const guildCreate = require(resolve(discordJs, 'client/websocket/handlers/GUILD_CREATE.js'));
const threadUpdate = require(resolve(discordJs, 'client/websocket/handlers/THREAD_UPDATE.js'));
const threadCreate = require(resolve(discordJs, 'client/websocket/handlers/THREAD_CREATE.js'));

const G = '100000000000000001';
const P = '100000000000000002';
const Q = '100000000000000003';
const BOT = '100000000000000004';
const U = '100000000000000005';
const TH = '100000000000000006';
const TQ = '100000000000000007';
const TX = '100000000000000008';
const idOf = (channelId: string) => `discord:${G}:${channelId}`;
const bot = { id: BOT, username: 'bot', discriminator: '0', avatar: null };
const channelData = (id: string, name: string) => ({ id, guild_id: G, type: ChannelType.GuildText, name, parent_id: null });
const threadData = (id: string, name: string, parent: string, archived = false) => ({
  id, guild_id: G, type: ChannelType.PublicThread, name, parent_id: parent, owner_id: U,
  thread_metadata: { archived, auto_archive_duration: 60, archive_timestamp: new Date().toISOString(), locked: false },
});

/** A guild with channels P (`general`) and Q (`planning`), any others given,
 *  and the given threads, under the given channel filter. */
function fixture(t: TestContext, opts: {
  threads?: Array<Record<string, unknown>>;
  channels?: Array<Record<string, unknown>>;
  guildChannels?: string[];
} = {}) {
  const adapter = new DiscordAdapter({
    token: 'unused',
    ...(opts.guildChannels ? { guildChannels: { [G]: opts.guildChannels } } : {}),
  });
  const client = adapter.rawClient as any;
  t.after(() => client.destroy());
  client.user = client.users._add({ ...bot, bot: true });
  const guild = client.guilds._add({
    id: G, name: 'Guild', owner_id: BOT, roles: [],
    channels: [channelData(P, 'general'), channelData(Q, 'planning'), ...(opts.channels ?? [])],
  });
  guild.members._add({ user: bot, roles: [] });
  for (const thread of opts.threads ?? []) client.channels._add(thread);
  const get = t.mock.method(client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  return { adapter, client, get };
}

it('list_channels lists live threads from the cache, typed and labelled by id, and fetches nothing', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  const listed = await f.adapter.listChannels(G);
  assert.deepEqual(listed.map((c) => c.id).sort(), [P, Q, TH].sort());
  const thread = listed.find((c) => c.id === TH)!;
  assert.equal(thread.type, 'thread');
  assert.equal(thread.name, 'topic');
  assert.equal(thread.parentId, P);
  assert.equal(thread.label, idOf(TH));
  assert.equal(f.get.mock.callCount(), 0, 'no REST call: the gateway keeps the threads in the cache');
});

it("a thread named like a channel is listed by a label that resolves to the thread, not the channel", async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'planning', P)] });
  const listed = await f.adapter.listChannels(G);
  const thread = listed.find((c) => c.id === TH)!;
  const resolved = f.adapter.resolveChannelRef(thread.label);
  assert.ok(resolved.ok, `thread label ${thread.label} did not resolve`);
  assert.equal(resolved.id, TH);
  // Every listed label round-trips to its own entry.
  for (const c of listed) {
    const r = f.adapter.resolveChannelRef(c.label);
    assert.ok(r.ok && r.id === c.id, `${c.label} should resolve to ${c.id}`);
  }
  assert.equal(listed.find((c) => c.id === Q)?.label, '#planning (Guild)', "the channel keeps its name label");
});

it('list_channels leaves out an archived thread', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P), threadData(TQ, 'done', P, true)] });
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.ok(ids.includes(TH));
  assert.ok(!ids.includes(TQ));
});

it("list_channels lists a forum's active posts as threads with the forum as their parent, as a forum's error says", async (t) => {
  const FORUM = '100000000000000009';
  const forum = { id: FORUM, guild_id: G, type: ChannelType.GuildForum, name: 'ideas', parent_id: null };
  const post = { ...threadData(TH, 'a post', FORUM), type: ChannelType.PublicThread };
  const f = fixture(t, { channels: [forum], threads: [post] });
  const listed = await f.adapter.listChannels(G);
  assert.equal(listed.find((c) => c.id === FORUM)?.type, 'forum');
  const listedPost = listed.find((c) => c.id === TH);
  assert.equal(listedPost?.type, 'thread');
  assert.equal(listedPost?.parentId, FORUM);
  assert.equal(listedPost?.label, idOf(TH));
});

it('list_channels admits a thread through its parent, as the channel filter does', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'allowed', P), threadData(TQ, 'hidden', Q)], guildChannels: [P] });
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.deepEqual(ids.sort(), [P, TH].sort());
});

it('list_channels leaves out a thread still stale when its fetch fails', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  (f.adapter as any).markStale(TH, G);
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.equal(f.get.mock.callCount(), 1, 'its fetch was tried');
  assert.equal(f.adapter.isStale(TH), true);
  assert.deepEqual(ids.sort(), [P, Q].sort());
});

it('list_channels fetches a stale thread first, and lists it as Discord has it now', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  f.get.mock.mockImplementation(async () => threadData(TH, 'renamed', P));
  (f.adapter as any).markStale(TH, G);
  const listed = await f.adapter.listChannels(G);
  assert.equal(f.get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(TH), false);
  assert.equal(listed.find((c) => c.id === TH)?.name, 'renamed');
});

it('a name lookup, which reads every guild, fetches no stale thread: names don\'t address threads', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  (f.adapter as any).markStale(TH, G);
  await f.adapter.refreshStale();
  assert.equal(f.get.mock.callCount(), 0);
  assert.equal(f.adapter.isStale(TH), true);
});

it('list_channels leaves out a thread whose channel is still stale, with that channel', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  (f.adapter as any).markStale(P, G);
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.equal(f.get.mock.callCount(), 1, 'P was fetched first');
  assert.equal(f.adapter.isStale(P), true, "P's fetch failed");
  assert.deepEqual(ids, [Q]);
});

it("list_channels admits a thread through its channel's category, as the channel filter does", async (t) => {
  const CAT = '100000000000000009';
  const R = '100000000000000010';
  const TR = '100000000000000011';
  const f = fixture(t, {
    channels: [
      { id: CAT, guild_id: G, type: ChannelType.GuildCategory, name: 'help', parent_id: null },
      { ...channelData(R, 'inside'), parent_id: CAT },
    ],
    threads: [threadData(TR, 'question', R), threadData(TH, 'hidden', P)],
    guildChannels: [CAT],
  });
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.deepEqual(ids.sort(), [CAT, R, TR].sort());
});

it('list_channels leaves out a thread known only from a message until its channel is known', async (t) => {
  const f = fixture(t);
  // What discord.js builds from a MESSAGE_CREATE carrying `channel_type` for a
  // thread it hasn't cached: its type and guild, with no name, channel or
  // archive state, until a thread event or a fetch fills them in.
  f.client.channels._add({ id: TX, guild_id: G, type: ChannelType.PublicThread });
  assert.ok(f.client.guilds.cache.get(G).channels.cache.has(TX));
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id).sort(), [P, Q].sort());
  f.client.actions.ChannelUpdate.handle(threadData(TX, 'topic', P));
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id).sort(), [P, Q, TX].sort());
});

it("list_channels leaves out a thread whose channel was deleted while it sat outside that channel's threads", async (t) => {
  const f = fixture(t);
  // Filled in by a thread event, not a fetch, so it never joined P's threads
  // cache, and P's deletion leaves it in the guild's.
  f.client.channels._add({ id: TX, guild_id: G, type: ChannelType.PublicThread });
  f.client.actions.ChannelUpdate.handle(threadData(TX, 'topic', P));
  f.client.actions.ChannelDelete.handle({ id: P, guild_id: G, type: ChannelType.GuildText });
  assert.ok(f.client.guilds.cache.get(G).channels.cache.has(TX));
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id), [Q]);
});

it('list_channels lists a thread its guild came back without once Discord reports it active again', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  // The guild goes unavailable and comes back without TH, archived meanwhile.
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  dispatch(f.client, 'GUILD_CREATE', guildCreate, {
    d: {
      id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [channelData(P, 'general'), channelData(Q, 'planning')], threads: [],
    },
  });
  assert.equal(f.adapter.isStale(TH), true, 'the guild came back without it');
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id).sort(), [P, Q].sort());
  // An unarchive reaches the client as a THREAD_UPDATE, which discord.js
  // applies to the thread it kept without putting it back in the guild's cache.
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadData(TH, 'topic', P) });
  assert.ok(!f.client.guilds.cache.get(G).channels.cache.has(TH));
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id).sort(), [P, Q, TH].sort());
});

it('list_channels lists a thread its guild came back without once the bot is added to it again', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  // The guild comes back without TH, which the bot had lost meanwhile, as it
  // does a private thread it's removed from.
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  dispatch(f.client, 'GUILD_CREATE', guildCreate, {
    d: {
      id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [channelData(P, 'general'), channelData(Q, 'planning')], threads: [],
    },
  });
  assert.equal(f.adapter.isStale(TH), true);
  // Adding the bot back reaches the client as a THREAD_CREATE, which
  // discord.js applies to the thread it kept, with no threadCreate event.
  dispatch(f.client, 'THREAD_CREATE', threadCreate, { d: threadData(TH, 'topic', P) });
  assert.equal(f.adapter.isStale(TH), false, 'a report of the thread clears its mark');
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id).sort(), [P, Q, TH].sort());
});

/** Discord's report as the gateway dispatches it: the adapter hears it
 *  first (client.ws), as it does Discord's, and then discord.js applies it
 *  with its handler for the event. */
function dispatch(client: any, event: string, handler: (client: any, packet: unknown, shard: { id: number }) => void, packet: { d: Record<string, unknown> }): void {
  client.ws.emit(event, packet.d, 0);
  handler(client, packet, { id: 0 });
}
