import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { ChannelType } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';

function member(id: string, displayName: string, opts: { bot?: boolean } = {}) {
  return { id, displayName, user: { username: displayName.toLowerCase(), bot: opts.bot ?? false } };
}

interface FakeGuild {
  id: string;
  name: string;
  members: {
    fetch: () => Promise<unknown>;
    cache: Map<string, ReturnType<typeof member>>;
  };
}

function fakeGuild(members: ReturnType<typeof member>[], opts: {
  fetchImpl?: () => Promise<unknown>;
} = {}): FakeGuild {
  const cache = new Map(members.map((m) => [m.id, m]));
  return {
    id: 'g1',
    name: 'Test Guild',
    members: {
      fetch: opts.fetchImpl ?? (async () => cache),
      cache,
    },
  };
}

function guildChannel(id: string, guild: FakeGuild, viewers: ReturnType<typeof member>[], parentId: string | null = null) {
  return {
    id,
    type: ChannelType.GuildText,
    name: `chan-${id}`,
    guild,
    guildId: guild.id,
    parentId,
    isThread: () => false,
    // discord.js's members getter is computed from permissions; the fixture gives its answer directly.
    members: new Map(viewers.map((m) => [m.id, m])),
  };
}

function thread(id: string, guild: FakeGuild, joinedIds: string[], parentId: string) {
  return {
    id,
    type: ChannelType.PublicThread,
    name: `thread-${id}`,
    guild,
    guildId: guild.id,
    parentId,
    isThread: () => true,
    members: {
      fetch: async () => new Map(joinedIds.map((mid) => [mid, { id: mid }])),
    },
  };
}

function makeAdapter(
  channels: Record<string, unknown>,
  opts: { guildChannels?: Record<string, string[]>; timeoutMs?: number } = {},
) {
  const adapter = new DiscordAdapter({ token: 'not-used', guildChannels: opts.guildChannels });
  const internals = adapter as unknown as {
    client: { destroy(): void };
    memberFetchTimeoutMs: number;
  };
  internals.client.destroy();
  internals.client = {
    destroy() {},
    // As discord.js's client does: guild channels are in the cache too.
    channels: { fetch: async (id: string) => channels[id] ?? null, cache: new Map(Object.entries(channels)) },
    users: { fetch: async () => null },
    user: { id: 'bot_1', username: 'bot', displayName: 'Bot', bot: true },
  } as never;
  internals.memberFetchTimeoutMs = opts.timeoutMs ?? 200;
  return adapter;
}

describe('listChannelMembers: channel-name freshness', () => {
  for (const kind of ['guild-channel', 'thread-joined'] as const) {
    it('omits a stale ' + kind + " name when every channel fetch is overtaken", async () => {
      const alice = member('u1', 'Alice');
      const guild = fakeGuild([alice]);
      const channel = kind === 'guild-channel'
        ? guildChannel('c1', guild, [alice])
        : thread('c1', guild, ['u1'], 'parent');
      const adapter = makeAdapter({ c1: channel, parent: guildChannel('parent', guild, [alice]) });
      const internals = adapter as unknown as {
        client: { channels: { fetch(id: string): Promise<unknown> } };
        overtake(id: string): void;
        markStale(id: string, guildId: string): void;
      };
      internals.markStale('c1', guild.id);
      let fetches = 0;
      internals.client.channels.fetch = async (id) => {
        fetches++;
        internals.overtake(id);
        return channel;
      };

      const result = await adapter.listChannelMembers('c1');

      assert.ok(fetches > 1, 'the lookup retried the overtaken fetch');
      assert.equal(adapter.isStale('c1'), true);
      assert.equal(result.channelName, null);
      assert.equal(result.scope, kind);
      assert.equal(result.members.length, 1);
    });
  }
});

describe('listChannelMembers: guild channels', () => {
  it('returns the permission-computed viewer list after a successful cache warm', async () => {
    const alice = member('u1', 'Alice');
    const zed = member('u2', 'Zed');
    const bot = member('u3', 'Helper', { bot: true });
    const g = fakeGuild([alice, zed, bot]);
    const adapter = makeAdapter({ c1: guildChannel('c1', g, [zed, bot, alice]) });

    const result = await adapter.listChannelMembers('c1');
    assert.equal(result.scope, 'guild-channel');
    assert.equal(result.total, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.members.map((m) => m.displayName), ['Alice', 'Zed', 'Helper']);
  });

  it('throws (not a silently partial list) when the guarded warm times out', async () => {
    const g = fakeGuild([], { fetchImpl: () => new Promise(() => {}) });
    const adapter = makeAdapter({ c1: guildChannel('c1', g, []) }, { timeoutMs: 50 });
    const started = Date.now();
    await assert.rejects(
      adapter.listChannelMembers('c1'),
      /warm-up failed or timed out/,
    );
    assert.ok(Date.now() - started < 1000);
  });

  it('caps large channels with a truthful total', async () => {
    const many = Array.from({ length: 250 }, (_, i) => member(`u${i}`, `User${String(i).padStart(3, '0')}`));
    const g = fakeGuild(many);
    const adapter = makeAdapter({ c1: guildChannel('c1', g, many) });
    const result = await adapter.listChannelMembers('c1');
    assert.equal(result.total, 250);
    assert.equal(result.members.length, 200);
    assert.equal(result.truncated, true);
  });
});

describe('listChannelMembers: channel filters bound inspection', () => {
  it('rejects a channel outside the configured allowlist', async () => {
    const g = fakeGuild([member('u1', 'Alice')]);
    const adapter = makeAdapter(
      { c_denied: guildChannel('c_denied', g, []) },
      { guildChannels: { g1: ['c_allowed'] } },
    );
    await assert.rejects(adapter.listChannelMembers('c_denied'), /channel filters/);
  });

  it('allows a thread under an allowed parent; rejects one under a denied parent', async () => {
    const g = fakeGuild([member('u1', 'Alice')]);
    const adapter = makeAdapter(
      {
        t_ok: thread('t_ok', g, ['u1'], 'c_allowed'),
        t_no: thread('t_no', g, ['u1'], 'c_other'),
      },
      { guildChannels: { g1: ['c_allowed'] } },
    );
    const ok = await adapter.listChannelMembers('t_ok');
    assert.equal(ok.scope, 'thread-joined');
    await assert.rejects(adapter.listChannelMembers('t_no'), /channel filters/);
  });

  it('allows a thread whose channel is admitted only through its listed category; rejects one whose category is not listed', async () => {
    const alice = member('u1', 'Alice');
    const g = fakeGuild([alice]);
    const adapter = makeAdapter(
      {
        c_in_cat: guildChannel('c_in_cat', g, [alice], 'cat_allowed'),
        t_in_cat: thread('t_in_cat', g, ['u1'], 'c_in_cat'),
        c_other_cat: guildChannel('c_other_cat', g, [alice], 'cat_other'),
        t_other_cat: thread('t_other_cat', g, ['u1'], 'c_other_cat'),
      },
      { guildChannels: { g1: ['cat_allowed'] } },
    );
    const ok = await adapter.listChannelMembers('t_in_cat');
    assert.equal(ok.scope, 'thread-joined');
    assert.deepEqual(ok.members.map((m) => m.displayName), ['Alice']);
    await assert.rejects(adapter.listChannelMembers('t_other_cat'), /channel filters/);
  });
});

describe('listChannelMembers: threads', () => {
  it('resolves joined members via one bulk warm — no per-member fetches — and says so', async () => {
    let fetchCalls = 0;
    const alice = member('u1', 'Alice');
    const g = fakeGuild([alice], {
      fetchImpl: async () => { fetchCalls++; return g.members.cache; },
    });
    const adapter = makeAdapter({ t1: thread('t1', g, ['u1', 'ghost'], 'c_parent') });

    const result = await adapter.listChannelMembers('t1');
    assert.equal(result.scope, 'thread-joined');
    assert.ok(result.note && /joined members only/i.test(result.note));
    assert.equal(fetchCalls, 1);
    assert.deepEqual(
      result.members.map((m) => [m.id, m.displayName]),
      [['u1', 'Alice'], ['ghost', 'ghost']],
    );
  });

  it('degrades to id-only display (not an error) when the warm fails for a thread', async () => {
    const g = fakeGuild([], { fetchImpl: async () => { throw new Error('no intent'); } });
    const adapter = makeAdapter({ t1: thread('t1', g, ['u1'], 'c_parent') });
    const result = await adapter.listChannelMembers('t1');
    assert.deepEqual(result.members.map((m) => m.displayName), ['u1']);
  });
});

describe('listChannelMembers: DMs', () => {
  it('returns the two parties', async () => {
    const dm = {
      id: 'd1',
      type: ChannelType.DM,
      isThread: () => false,
      recipient: { id: 'u9', username: 'ra', displayName: 'Ra', bot: false },
    };
    const adapter = makeAdapter({ d1: dm });
    const result = await adapter.listChannelMembers('d1');
    assert.equal(result.scope, 'dm');
    assert.deepEqual(result.members.map((m) => m.id).sort(), ['bot_1', 'u9']);
  });
});
