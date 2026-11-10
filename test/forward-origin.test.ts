import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { Message, type Client } from 'discord.js';

import { DiscordAdapter, type DiscordMessageData } from '../src/discord-adapter.js';

const G = '300000000000000001';
const G2 = '300000000000000002';
const G3 = '300000000000000003';
const CHANNEL = '310000000000000001';
const LISTED = '310000000000000002';
const UNLISTED = '310000000000000003';
const THREAD_OF_LISTED = '310000000000000004';
const THREAD_OF_UNLISTED = '310000000000000005';
const LOUNGE = '320000000000000001';
const UNCACHED = '320000000000000009';
const ORPHAN = '330000000000000001';
const DM = '340000000000000001';
const AUTHOR = '100000000000000001';
const MEMBER = '100000000000000002';
const ROLE = '200000000000000001';

const RawMessage = Message as unknown as new (client: Client, data: unknown) => Message;

function world(t: TestContext, filters: Record<string, unknown> = {}) {
  const adapter = new DiscordAdapter({ token: 'unused', guildIds: [G], guildChannels: { [G]: [CHANNEL, LISTED] }, ...filters });
  const client = adapter.rawClient;
  t.after(() => client.destroy());
  const add = (manager: unknown, data: unknown) => (manager as { _add(data: unknown): unknown })._add(data);
  const channel = (id: string, name: string, guildId: string) => ({ id, type: 0, name, guild_id: guildId, position: 0, permission_overwrites: [] });
  const thread = (id: string, name: string, parentId: string) => ({
    id, type: 11, name, guild_id: G, parent_id: parentId,
    thread_metadata: { archived: false, auto_archive_duration: 60, locked: false, archive_timestamp: '2026-01-01T00:00:00.000Z' },
  });
  add(client.guilds, {
    id: G, name: 'Guild',
    roles: [{ id: ROLE, name: 'tutors', permissions: '0', position: 1, color: 0, hoist: false, managed: false, mentionable: true }],
    members: [{ user: { id: MEMBER, username: 'eve', global_name: null }, nick: 'Eve Ng', roles: [], joined_at: '2026-01-01T00:00:00.000Z' }],
    channels: [channel(CHANNEL, 'general', G), channel(LISTED, 'math', G), channel(UNLISTED, 'staff-only', G)],
    threads: [thread(THREAD_OF_LISTED, 'proofs', LISTED), thread(THREAD_OF_UNLISTED, 'pay-review', UNLISTED)],
  });
  add(client.guilds, { id: G2, name: 'Other Guild', roles: [], members: [], channels: [channel(LOUNGE, 'lounge', G2)] });
  add(client.channels, { id: DM, type: 1, recipients: [{ id: AUTHOR, username: 'ann', global_name: null }] });
  let seq = 0;
  const forward = (source: { channel: string; guild: string | null }, content: string, at: { channel: string; guild: string | null } = { channel: CHANNEL, guild: G }): Message => {
    seq++;
    return new RawMessage(client, {
      id: `5000000000000000${String(seq).padStart(2, '0')}`, channel_id: at.channel, ...(at.guild ? { guild_id: at.guild } : {}), type: 0, content: '',
      author: { id: AUTHOR, username: 'ann', global_name: null, bot: false },
      mentions: [], mention_roles: [], mention_everyone: false, attachments: [], embeds: [], components: [], reactions: [],
      flags: 16384, tts: false, pinned: false, timestamp: '2026-11-03T06:00:00.000Z', edited_timestamp: null,
      message_reference: { type: 1, channel_id: source.channel, ...(source.guild ? { guild_id: source.guild } : {}), message_id: `6000000000000000${String(seq).padStart(2, '0')}` },
      message_snapshots: [{ message: {
        type: 0, content, mentions: [], mention_roles: [], attachments: [], embeds: [], components: [],
        flags: 0, timestamp: '2026-11-03T05:00:00.000Z', edited_timestamp: null,
      } }],
    });
  };
  const live = async (m: Message): Promise<DiscordMessageData> => {
    const got = new Promise<DiscordMessageData>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the forward never reached onMessage within 5 s')), 5_000);
      adapter.onMessage((msg) => { clearTimeout(timer); resolve(msg); });
    });
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', m);
    return got;
  };
  const read = async (messages: Message[]) => {
    const fetched = client.channels.cache.get(CHANNEL) as unknown as Record<string, unknown>;
    (fetched.messages as Record<string, unknown>).fetch = async () => new Map(messages.map((m) => [m.id, m]));
    (client.channels as unknown as { fetch: unknown }).fetch = async () => fetched;
    return { fetch_history: await adapter.fetchHistory(CHANNEL, { limit: 10 }), fetch_around: await adapter.fetchAround(CHANNEL, messages[0].id, 10) };
  };
  const stale = (id: string) => (adapter as unknown as { stale: Map<string, { guildId: string }> }).stale.set(id, { guildId: G });
  const cacheWithoutItsServer = (id: string, name: string, guildId: string) =>
    (client.channels.cache as unknown as Map<string, unknown>).set(id, { id, name, guildId, parentId: null });
  return { forward, live, read, stale, cacheWithoutItsServer };
}

const from = async (w: ReturnType<typeof world>, source: { channel: string; guild: string | null }) => (await w.live(w.forward(source, 'hello'))).forwardedFrom;

describe("a forward's text and where it came from, as the agent gets them", () => {
  it("names the mentions in a forward's text as a live message's text names them, under the plain forward label", async (t) => {
    const w = world(t);
    const got = await w.live(w.forward({ channel: LISTED, guild: G }, `ask <@${MEMBER}> or <@&${ROLE}> in <#${LISTED}>`));
    assert.equal(got.content, '[forwarded message] ask @Eve Ng or @tutors in #math');
  });

  it("leaves a mention the cache can't name in a forward's text as Discord wrote it", async (t) => {
    const w = world(t);
    const got = await w.live(w.forward({ channel: LISTED, guild: G }, `ask <@100000000000000099> in <#${UNCACHED}>`));
    assert.equal(got.content, `[forwarded message] ask <@100000000000000099> in <#${UNCACHED}>`);
  });

  it('gives the channel a forward came from when the filters allow it, and its server when that is another server', async (t) => {
    const w = world(t, { guildIds: [G, G2] });
    assert.deepEqual(await from(w, { channel: LISTED, guild: G }), { channel: 'math', otherServer: false });
    assert.deepEqual(await from(w, { channel: THREAD_OF_LISTED, guild: G }), { channel: 'proofs', otherServer: false });
    assert.deepEqual(await from(w, { channel: LOUNGE, guild: G2 }), { channel: 'lounge', server: 'Other Guild', otherServer: true });
  });

  it('names no channel and no server the filters leave out, the cache lacks, or its stale facts can no longer vouch for', async (t) => {
    const w = world(t, { guildIds: [G, G2, G3] });
    assert.deepEqual(await from(w, { channel: UNLISTED, guild: G }), { otherServer: false });
    assert.deepEqual(await from(w, { channel: THREAD_OF_UNLISTED, guild: G }), { otherServer: false });
    assert.deepEqual(await from(w, { channel: UNCACHED, guild: G2 }), { otherServer: true });
    const orphan = w.forward({ channel: ORPHAN, guild: G3 }, 'hello');
    w.cacheWithoutItsServer(ORPHAN, 'orphan', G3);
    assert.deepEqual((await w.live(orphan)).forwardedFrom, { otherServer: true });
    w.stale(LISTED);
    assert.deepEqual(await from(w, { channel: LISTED, guild: G }), { otherServer: false });
    const narrow = world(t);
    assert.deepEqual(await from(narrow, { channel: LOUNGE, guild: G2 }), { otherServer: true });
  });

  it('gives no origin for a forward from a DM or from the channel it was posted in, and names the server for one posted in a DM', async (t) => {
    const w = world(t);
    assert.equal(await from(w, { channel: DM, guild: null }), undefined);
    assert.equal(await from(w, { channel: CHANNEL, guild: G }), undefined);
    const intoDm = await w.live(w.forward({ channel: LISTED, guild: G }, 'hello', { channel: DM, guild: null }));
    assert.deepEqual(intoDm.forwardedFrom, { channel: 'math', server: 'Guild', otherServer: true });
  });

  it('gives fetch_history and fetch_around the same text and origin as live delivery', async (t) => {
    const w = world(t);
    const got = await w.read([w.forward({ channel: LISTED, guild: G }, `ask <@${MEMBER}>`), w.forward({ channel: UNLISTED, guild: G }, 'hi')]);
    for (const [tool, messages] of Object.entries(got)) {
      assert.deepEqual(messages.map((m) => [m.cleanContent, m.forwardedFrom]).sort(), [
        ['[forwarded message] ask @Eve Ng', { channel: 'math', otherServer: false }],
        ['[forwarded message] hi', { otherServer: false }],
      ], tool);
    }
  });
});
