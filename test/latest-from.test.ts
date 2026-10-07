/**
 * latestFrom: reply to or react to the newest message from a named author,
 * resolved once at invocation among the 100 most recent messages, as the
 * exclusive alternative to an explicit messageId.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField, type Client } from 'discord.js';
import { DiscordAdapter, type HistoryMessage } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 8, 0, s));
const msg = (id: string, authorId: string, authorName: string, text: string, s: number, isBot = false): HistoryMessage => ({
  id, authorId, authorName, isBot, content: text, cleanContent: text, attachments: [], mentionsBot: false, timestamp: at(s),
});
const RA = '100000000000000001';
const RA2 = '100000000000000002';
const FABLE_BOT = '100000000000000003';
const LINN = '100000000000000004';

const members = [
  { id: RA, username: 'ra', displayName: 'Ra', isBot: false },
  { id: FABLE_BOT, username: 'fable', displayName: 'Fable', isBot: true },
  { id: LINN, username: 'linn', displayName: 'Linn', isBot: false },
];

function adapterFixture(
  t: TestContext,
  history: HistoryMessage[],
  memberList: typeof members | Error = members,
  unresolved = 0,
) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const a = adapter as unknown as Record<string, unknown>;
  a.fetchHistory = async () => history;
  a.listChannelMembers = async (channelId: string, opts: { cap?: boolean }) => {
    assert.equal(opts?.cap, false, 'author resolution reads the uncapped member list');
    if (memberList instanceof Error) throw memberList;
    if (channelId === 'p1') {
      // The private thread's parent: no one there manages threads.
      return { channelId: 'p1', channelName: 'general', scope: 'guild-channel', total: 0, members: [], truncated: false };
    }
    return {
      channelId: 'c1', channelName: 'general', scope: unresolved ? 'thread-joined' : 'guild-channel',
      total: memberList.length, members: memberList, truncated: false, ...(unresolved ? { unresolved } : {}),
    };
  };
  // The thread-joined listing above stands for a private thread (no parent lookup).
  (client.channels as unknown as { fetch: unknown }).fetch = async () =>
    ({ isThread: () => true, type: ChannelType.PrivateThread, parentId: 'p1' });
  return { adapter, client };
}

describe('resolveLatestFrom', () => {
  const history = [
    msg('200000000000000010', RA, 'Ra', 'older from Ra', 1),
    msg('200000000000000020', LINN, 'Linn', 'Linn speaks', 2),
    msg('200000000000000030', RA, 'Ra', 'newest from Ra', 3),
    msg('200000000000000040', FABLE_BOT, 'Fable', 'a bot resident speaks', 4, true),
  ];

  it('picks the newest message by a numeric id, a mention, a username or a display name', async (t) => {
    const { adapter } = adapterFixture(t, history);
    for (const ref of [RA, `<@${RA}>`, '@ra', 'Ra', ' ra ']) {
      const r = await adapter.resolveLatestFrom('c1', ref);
      assert.equal(r.ok, true, ref);
      if (r.ok) {
        assert.equal(r.message.id, '200000000000000030', ref);
        assert.equal(r.authorId, RA);
      }
    }
  });

  it('resolves bot residents as well as people', async (t) => {
    const { adapter } = adapterFixture(t, history);
    const r = await adapter.resolveLatestFrom('c1', 'Fable');
    assert.ok(r.ok && r.message.id === '200000000000000040');
  });

  it('refuses a name two people share, with choices, even if only one of them spoke recently', async (t) => {
    const { adapter } = adapterFixture(t, history, [...members, { id: RA2, username: 'ra_two', displayName: 'Ra', isBot: false }]);
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /^"Ra" matches 2 people here: /);
      assert.ok(r.message.includes(`Ra (@ra) = ${RA}`));
      assert.ok(r.message.includes(`Ra (@ra_two) = ${RA2}`));
      assert.match(r.message, /nothing was done\.$/);
    }
  });

  it('refuses when the author has no message in the window, naming the window', async (t) => {
    const { adapter } = adapterFixture(t, history, [...members, { id: RA2, username: 'quiet', displayName: 'Quiet', isBot: false }]);
    const r = await adapter.resolveLatestFrom('c1', 'Quiet');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /^No message from Quiet among the 4 most recent messages here \(2026-10-07T08:00:01.000Z to 2026-10-07T08:00:04.000Z\); nothing was done\./);
      assert.match(r.message, /never reaches further back or picks another author/);
    }
    const nobody = await adapter.resolveLatestFrom('c1', 'Nobody');
    assert.ok(!nobody.ok && /No one named "Nobody"/.test(nobody.message));
  });

  it('refuses a name it cannot check for collisions when the member list fails, but still takes an id', async (t) => {
    // Two people named Ra; only one spoke recently. Without the member list,
    // the recent one would look unique.
    const { adapter } = adapterFixture(t, history, new Error('Guild member cache warm-up failed'));
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.message, '"Ra" can\'t be checked for people sharing that name: this channel\'s member list is unavailable (Guild member cache warm-up failed). Use their numeric user id; nothing was done.');
    }
    const byId = await adapter.resolveLatestFrom('c1', RA);
    assert.ok(byId.ok && byId.message.id === '200000000000000030');
  });

  it('refuses a name when some members are listed by id only (a thread after a failed warm-up)', async (t) => {
    const idOnly = { id: RA2, username: RA2, displayName: RA2, isBot: false };
    const { adapter } = adapterFixture(t, history, [...members, idOnly], 1);
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /1 member\(s\) here couldn't be resolved to names\. Use their numeric user id; nothing was done\.$/);
    const byId = await adapter.resolveLatestFrom('c1', `<@${RA}>`);
    assert.ok(byId.ok && byId.message.id === '200000000000000030');
  });

  it('checks a thread\'s name against its other readers: all parent viewers (public), thread managers (private)', async (t) => {
    const THREAD = '300000000000000001';
    const PARENT = '300000000000000002';
    // Joined: the Ra who spoke. Parent viewers: another Ra who never joined,
    // who can manage threads in the parent or not.
    for (const [type, readerManages, expectRefusal] of [
      [ChannelType.PublicThread, false, true],
      [ChannelType.PrivateThread, true, true],
      [ChannelType.PrivateThread, false, false],
    ] as const) {
      const adapter = new DiscordAdapter({ token: 'unused' });
      const client = (adapter as unknown as { client: Client }).client;
      t.after(() => client.destroy());
      const a = adapter as unknown as Record<string, unknown>;
      a.fetchHistory = async () => history;
      const reader = { id: RA2, username: 'ra_reader', displayName: 'Ra', isBot: false };
      a.listChannelMembers = async (id: string, opts: { withPermission?: bigint }) => {
        if (id === THREAD) {
          return { channelId: THREAD, channelName: 'thread', scope: 'thread-joined', total: 1, members: [members[0]], truncated: false };
        }
        assert.equal(opts.withPermission, type === ChannelType.PrivateThread ? PermissionsBitField.Flags.ManageThreads : undefined);
        const viewers = opts.withPermission === undefined || readerManages ? [members[0], reader] : [];
        return { channelId: PARENT, channelName: 'general', scope: 'guild-channel', total: viewers.length, members: viewers, truncated: false };
      };
      (client.channels as unknown as { fetch: unknown }).fetch = async () => ({ isThread: () => true, type, parentId: PARENT });
      const r = await adapter.resolveLatestFrom(THREAD, 'Ra');
      const label = `${type === ChannelType.PublicThread ? 'public' : 'private'} thread, reader manages threads: ${readerManages}`;
      if (expectRefusal) {
        assert.ok(!r.ok && /^"Ra" matches 2 people here: /.test(r.message), `${label}: ${JSON.stringify(r)}`);
      } else {
        assert.ok(r.ok && r.authorId === RA, `${label}: ${JSON.stringify(r)}`);
      }
    }
  });

  it('narrows a guild channel\'s viewers to those holding a permission when asked', async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    const member = (id: string, username: string) => ({ id, displayName: username, user: { username, bot: false } });
    const viewers = new Map([[RA, member(RA, 'ra')], [RA2, member(RA2, 'moderator')]]);
    const parent = {
      id: 'p1', name: 'general', type: ChannelType.GuildText, parentId: null, isThread: () => false,
      guild: { id: 'g1' }, members: viewers,
      permissionsFor: (m: { id: string }) => ({ has: (p: bigint) => p === PermissionsBitField.Flags.ManageThreads && m.id === RA2 }),
    };
    (client.channels as unknown as { fetch: unknown }).fetch = async () => parent;
    (adapter as unknown as Record<string, unknown>).warmGuildMemberCache = async () => true;
    const all = await adapter.listChannelMembers('p1', { cap: false });
    assert.deepEqual(all.members.map((m) => m.id).sort(), [RA, RA2]);
    const managers = await adapter.listChannelMembers('p1', { cap: false, withPermission: PermissionsBitField.Flags.ManageThreads });
    assert.deepEqual(managers.members.map((m) => m.id), [RA2]);
  });

  it('recognizes id-only members by their shape even when the list gives no count', async (t) => {
    // Wren's probe: both Ra identities came back id-only from a thread listing.
    const idOnly = [RA, RA2].map((id) => ({ id, username: id, displayName: id, isBot: false }));
    const { adapter } = adapterFixture(t, history, idOnly);
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.ok(!r.ok && /2 member\(s\) here couldn't be resolved to names/.test(r.message));
  });

  it('asks discord.js to fail rather than post unthreaded when an addressed reply\'s target is gone', async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    // A logged-out client has no user; the DM channel's recipient getter needs one.
    (client as unknown as { user: unknown }).user = { id: '1300000000000000002' };
    (client.channels as unknown as { _add(data: unknown): unknown })._add({
      id: 'dm1', type: ChannelType.DM, last_message_id: null,
      recipients: [{ id: 'u1', username: 'u1', discriminator: '0' }],
    });
    const bodies: Array<Record<string, unknown>> = [];
    t.mock.method(client.rest, 'post', async (_route: string, options: { body: Record<string, unknown> }) => {
      bodies.push(options.body);
      return {
        id: '1300000000000000001', channel_id: 'dm1', author: { id: '1300000000000000002', username: 'bot', discriminator: '0' },
        content: options.body.content, timestamp: new Date().toISOString(), edited_timestamp: null, tts: false,
        mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
      };
    });
    await adapter.sendMessage('dm1', 'hi', { replyTo: '1200000000000000001', requireReplyTarget: true });
    await adapter.sendMessage('dm1', 'hi', { replyTo: '1200000000000000001' });
    assert.equal((bodies[0].message_reference as Record<string, unknown>).fail_if_not_exists, true);
    assert.equal((bodies[0].message_reference as Record<string, unknown>).message_id, '1200000000000000001');
    assert.equal((bodies[1].message_reference as Record<string, unknown>).message_id, '1200000000000000001');
  });
});

describe('reply and reaction tools', () => {
  function serverFixture() {
    let history = [msg('200000000000000030', RA, 'Ra', 'the message Ra just sent, which is long enough that the receipt only echoes a short part of it to the resident', 3)];
    const calls: Array<{ op: string; channelId: string; messageId?: string; options?: Record<string, unknown> }> = [];
    let gone = false;
    const adapter = {
      botUserId: 'bot',
      resolveChannelRef: (given: string) => ({ ok: true, id: given }),
      async resolveLatestFrom(channelId: string, ref: string) {
        const real = new DiscordAdapter({ token: 'unused' }) as unknown as Record<string, unknown>;
        real.fetchHistory = async () => history;
        real.listChannelMembers = async () => ({ channelId, channelName: 'general', scope: 'guild-channel', total: 1, members, truncated: false });
        try {
          return await (real as unknown as DiscordAdapter).resolveLatestFrom(channelId, ref);
        } finally {
          ((real as unknown as { client: Client }).client).destroy();
        }
      },
      async sendMessage(channelId: string, _content: string, options: Record<string, unknown>) {
        calls.push({ op: 'send', channelId, options });
        return { messageId: '300000000000000001' };
      },
      async addReaction(channelId: string, messageId: string) {
        if (gone) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        calls.push({ op: 'react', channelId, messageId });
      },
      async removeReaction(channelId: string, messageId: string) {
        calls.push({ op: 'unreact', channelId, messageId });
      },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    return {
      server, calls,
      setHistory: (h: HistoryMessage[]) => { history = h; },
      deleteTarget: () => { gone = true; },
      call: async (name: string, args: Record<string, unknown>) => server.handleToolCall(name, { channelId: '1234567890123456789', ...args }),
    };
  }

  it('advertises messageId and latestFrom as nullable, exclusive, and neither required', () => {
    for (const name of ['reply_message', 'add_reaction', 'remove_reaction']) {
      const tool = toolDefinitions.find((d) => d.name === name)!;
      const schema = tool.inputSchema as { properties: Record<string, { type: unknown; description: string }>; required: string[] };
      for (const key of ['messageId', 'latestFrom']) {
        assert.deepEqual(schema.properties[key].type, ['string', 'null'], `${name}.${key}`);
        assert.match(schema.properties[key].description, /^Give exactly one of messageId or latestFrom; the other may be omitted or null\./);
        assert.ok(!schema.required.includes(key), `${name} doesn't require ${key}`);
      }
      assert.ok(schema.required.includes('channelId'));
    }
  });

  it('keeps sparse exact-id calls working', async () => {
    const f = serverFixture();
    const res = await f.call('add_reaction', { messageId: '200000000000000099', emoji: '👍' });
    assert.ok(!res.isError);
    assert.equal(res.content[0].text, 'Reaction added');
    assert.deepEqual(f.calls, [{ op: 'react', channelId: '1234567890123456789', messageId: '200000000000000099' }]);
  });

  it('accepts all-properties calls with the unused selector null, either way round', async () => {
    const f = serverFixture();
    assert.ok(!(await f.call('add_reaction', { messageId: '200000000000000099', latestFrom: null, emoji: '👍' })).isError);
    assert.ok(!(await f.call('remove_reaction', { messageId: null, latestFrom: 'Ra', emoji: '👍' })).isError);
    assert.deepEqual(f.calls.map((c) => c.messageId), ['200000000000000099', '200000000000000030']);
  });

  it('refuses two selectors, no selector, and a non-string selector, doing nothing', async () => {
    const f = serverFixture();
    const both = await f.call('reply_message', { messageId: '200000000000000099', latestFrom: 'Ra', content: 'x' });
    assert.ok(both.isError && /Give messageId or latestFrom, not both; nothing was done\./.test(both.content[0].text));
    const neither = await f.call('add_reaction', { messageId: '  ', latestFrom: null, emoji: '👍' });
    assert.ok(neither.isError && /Give exactly one of messageId or latestFrom/.test(neither.content[0].text));
    const wrong = await f.call('add_reaction', { latestFrom: 42, emoji: '👍' });
    assert.ok(wrong.isError && /latestFrom must be a string or null/.test(wrong.content[0].text));
    assert.deepEqual(f.calls, []);
  });

  it('replies to the resolved target, requires it to exist, and echoes it', async () => {
    const f = serverFixture();
    const res = await f.call('reply_message', { latestFrom: 'Ra', content: 'answering you' });
    assert.ok(!res.isError, res.content[0].text);
    assert.deepEqual(f.calls[0].options, { replyTo: '200000000000000030', files: undefined, requireReplyTarget: true });
    const receipt = JSON.parse(res.content[0].text);
    assert.equal(receipt.messageId, '300000000000000001');
    assert.equal(receipt.target.messageId, '200000000000000030');
    assert.deepEqual(receipt.target.author, { id: RA, name: 'Ra' });
    assert.equal(receipt.target.discordChannelId, '1234567890123456789');
    assert.equal(receipt.target.channelId, undefined, 'channelId is reserved for the canonical form');
    assert.equal(receipt.target.timestamp, '2026-10-07T08:00:03.000Z');
    const sent = 'the message Ra just sent, which is long enough that the receipt only echoes a short part of it to the resident';
    assert.equal(receipt.target.excerpt, `${sent.slice(0, 80)}…`);
    assert.match(receipt.target.selectedBy, /not a claim about what you have seen/);
  });

  it('acts on the message chosen at selection, even if newer traffic arrives before the action', async () => {
    const f = serverFixture();
    const adapter = (f.server as unknown as { discord: Record<string, unknown> }).discord;
    const realAdd = adapter.addReaction as (c: string, m: string) => Promise<void>;
    adapter.addReaction = async (c: string, m: string) => {
      f.setHistory([msg('200000000000000050', RA, 'Ra', 'even newer', 5)]); // arrives after selection
      return realAdd(c, m);
    };
    await f.call('add_reaction', { latestFrom: 'Ra', emoji: '👍' });
    assert.equal(f.calls[0].messageId, '200000000000000030');
  });

  it('fails explicitly when the chosen target is deleted before the action', async () => {
    const f = serverFixture();
    f.deleteTarget();
    const res = await f.call('add_reaction', { latestFrom: 'Ra', emoji: '👍' });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /Unknown Message/);
  });

  it('refuses a latestFrom with no match without acting', async () => {
    const f = serverFixture();
    const res = await f.call('reply_message', { latestFrom: 'Linn', content: 'x' });
    assert.ok(res.isError && /No message from Linn among the 1 most recent messages here/.test(res.content[0].text));
    assert.deepEqual(f.calls, []);
  });
});
