/**
 * Refused DMs: the sender gets one automatic delivery notice, the agent gets
 * nothing, and the reconnect catch-up sweep applies the same ingress decision
 * as live delivery.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelType, Collection, MessageType, type Client } from 'discord.js';
import { DiscordAdapter, type DmRefusal } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { DM_NOTICE_TEXT, snowflakeAt } from '../src/dm-notices.js';

/** A message id Discord could assign right now (plus an increment). Call it
 *  after the harness exists: the notice state's floor is set when it opens. */
const freshId = (n = 0) => (BigInt(snowflakeAt(Date.now())) + BigInt(n)).toString();

interface HistoryMessage {
  id: string; authorId: string; authorName: string; isBot: boolean; content: string; cleanContent: string;
  attachments: never[]; mentionsBot: boolean; timestamp: Date; reactions: never[];
}
const historyMessage = (id: string, authorId: string, text: string, mentionsBot = false): HistoryMessage => ({
  id, authorId, authorName: authorId, isBot: false, content: text, cleanContent: text,
  attachments: [], mentionsBot, timestamp: new Date(), reactions: [],
});

// Harnesses capture console.error; every one restores the real one, so two
// harnesses alive in one test (a restart) can't leave a stale capture behind.
const REAL_CONSOLE_ERROR = console.error;

type ChannelMeta = { name: string | null; guildId: string | null; guildName: string | null; isDM: boolean };

function harness(t: TestContext, opts: {
  dmUsers?: string[];
  guildIds?: string[];
  guildChannels?: Record<string, string[]>;
  watermarks?: Record<string, string>;
  dmChannels?: string[];
  history?: (channelId: string) => Promise<HistoryMessage[]>;
  meta?: (channelId: string) => ChannelMeta | null;
  noticesFile?: 'fresh' | 'unwritable';
  /** Reuse a notice-state path, to model a restart. */
  noticesPath?: string;
  /** Use the adapter's real channel-metadata helpers instead of stubs. */
  realMeta?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-refusal-'));
  const env = { wm: process.env.DISCORD_WATERMARK_FILE, notices: process.env.DISCORD_DM_NOTICES_FILE };
  const wm = join(dir, 'wm.json');
  writeFileSync(wm, JSON.stringify({ watermarks: opts.watermarks ?? {}, dmChannels: opts.dmChannels ?? [] }));
  process.env.DISCORD_WATERMARK_FILE = wm;
  const noticesDir = join(dir, 'notices');
  process.env.DISCORD_DM_NOTICES_FILE = opts.noticesPath ?? join(noticesDir, 'dm-notices.json');
  if (opts.noticesFile === 'unwritable') {
    // A directory where the file should be: it can be neither read nor written.
    rmSync(noticesDir, { recursive: true, force: true });
    writeFileSync(noticesDir, 'not a directory');
  }

  const adapter = new DiscordAdapter({
    token: 'unused', dmUsers: opts.dmUsers, guildIds: opts.guildIds, guildChannels: opts.guildChannels,
  });
  const client = (adapter as unknown as { client: Client }).client;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  t.after(() => {
    console.error = REAL_CONSOLE_ERROR;
    client.destroy();
    if (env.wm === undefined) delete process.env.DISCORD_WATERMARK_FILE; else process.env.DISCORD_WATERMARK_FILE = env.wm;
    if (env.notices === undefined) delete process.env.DISCORD_DM_NOTICES_FILE; else process.env.DISCORD_DM_NOTICES_FILE = env.notices;
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const a = adapter as unknown as Record<string, unknown>;
  a.fetchHistory = (channelId: string) => (opts.history ? opts.history(channelId) : Promise.resolve([]));
  if (!opts.realMeta) {
    const meta = opts.meta ?? (() => null);
    a.getCachedChannelMeta = (channelId: string) => meta(channelId);
    a.getChannelMeta = async (channelId: string) => {
      const m = meta(channelId);
      if (!m) throw new Error('lookup failed');
      return m;
    };
  }
  const notices: Array<{ channelId: string; content: string }> = [];
  let noticeError: Error | null = null;
  a.sendDmNotice = async (channelId: string, content: string) => {
    if (noticeError) throw noticeError;
    notices.push({ channelId, content });
    return { messageId: 'notice' };
  };

  const delivered: string[] = [];
  const emit = (authorId: string, opts2: { id?: string; guildId?: string | null; channelId?: string; content?: string } = {}) => {
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
      id: opts2.id ?? freshId(), channelId: opts2.channelId ?? `dm-${authorId}`, guildId: opts2.guildId ?? null, channel: null,
      author: { id: authorId, username: authorId, bot: false },
      content: opts2.content ?? 'hello', cleanContent: opts2.content ?? 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
    });
  };

  const server = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & {
    runReconnectSweep(): Promise<void>;
    setupDiscordForwarding(): void;
    filtersUpdate(args: Record<string, unknown>): Promise<{ applied: { dmNotice: boolean | null }; notes: string[] }>;
    executeToolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    handleDmRefusal(ev: DmRefusal): Promise<void>;
    forwardedWatermark: Map<string, string>;
  };
  const pushes: Array<{ payload: { content: Array<{ text: string }> } }> = [];
  server.conn = {
    sendRequest: async (_method: string, params: unknown) => {
      pushes.push(params as (typeof pushes)[number]);
      return {};
    },
  };
  server.mcplEnabled = true;
  server.enabledFeatureSets = new Set(['discord.messaging']);
  server.setupDiscordForwarding();
  // As index.ts does at startup: the notice state's floor predates the sweep.
  (server as unknown as { openDmNoticeState(): void }).openDmNoticeState();
  // Record what the adapter hands the server, then let the server handle it.
  const toServer = (adapter as unknown as { messageHandler: (m: { authorId: string; content: string }) => void }).messageHandler;
  (adapter as unknown as { messageHandler: (m: { authorId: string; content: string }) => void }).messageHandler = (m) => {
    delivered.push(`${m.authorId}:${m.content}`);
    toServer(m);
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    adapter, client, server, emit, delivered, pushes, notices, logs, settle,
    failNoticesWith: (err: Error | null) => { noticeError = err; },
    noticesPath: process.env.DISCORD_DM_NOTICES_FILE!,
  };
}

describe('live refusals', () => {
  it('tells a refused sender once per 24 hours and forwards nothing', async (t) => {
    const h = harness(t, { dmUsers: ['friend'] });
    h.emit('stranger', { id: freshId(1), content: 'first private words' });
    await h.settle();
    h.emit('stranger', { id: freshId(2), content: 'second private words' });
    await h.settle();
    assert.deepEqual(h.delivered, [], 'nothing reaches the agent');
    assert.deepEqual(h.notices, [{ channelId: 'dm-stranger', content: DM_NOTICE_TEXT }]);
    const lines = h.logs.filter((l) => l.includes('DM refused by the DM allowlist'));
    assert.equal(lines.length, 2, 'one operator line per refused DM');
    assert.match(lines[0], /\(live\): sender stranger, message \d+; notice sent/);
    assert.match(lines[1], /notice rate-limited/);
    assert.ok(!h.logs.some((l) => l.includes('private words')), 'no message body is logged');
    const state = readFileSync(h.noticesPath, 'utf-8');
    assert.ok(!state.includes('private words'), 'the notice state stores no message bodies');
  });

  it('decides concurrent refusals once: the same message twice, or two messages from one sender, in one tick', async (t) => {
    const h = harness(t, { dmUsers: ['friend'] });
    const id = freshId(3);
    h.emit('stranger', { id });
    h.emit('stranger', { id });
    h.emit('stranger', { id: freshId(4) });
    await h.settle();
    assert.equal(h.notices.length, 1);
    const outcomes = h.logs.filter((l) => l.includes('sender stranger')).map((l) => l.replace(/.*; notice /, ''));
    assert.deepEqual(outcomes.sort(), ['already-handled', 'rate-limited', 'sent']);
  });

  it('after a crash between reservation and outcome, reports the attempt as unknown and does not retry it', async (t) => {
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-crash-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');
    const first = harness(t, { dmUsers: ['friend'], noticesPath });
    (first.adapter as unknown as Record<string, unknown>).sendDmNotice = () => new Promise(() => {}); // never settles
    first.emit('stranger', { id: freshId(1) });
    await first.settle();
    assert.equal(JSON.parse(readFileSync(noticesPath, 'utf-8')).senders.stranger.lastNotice.outcome, 'pending');

    const restarted = harness(t, { dmUsers: ['friend'], noticesPath });
    assert.ok(restarted.logs.some((l) => /DM notice to sender stranger .* was interrupted before its outcome was recorded; outcome unknown, not retried/.test(l)));
    restarted.emit('stranger', { id: freshId(2) });
    await restarted.settle();
    assert.deepEqual(restarted.notices, []);
    assert.ok(restarted.logs.some((l) => /sender stranger.*notice rate-limited/.test(l)));
  });

  it('sends no notice for allowed senders, guild messages, or a duplicate of a handled message', async (t) => {
    const h = harness(t, { dmUsers: ['friend'] });
    h.emit('friend', { content: 'hi' });
    h.emit('anyone', { guildId: 'g1', channelId: 'chan1', content: 'in a guild' });
    const id = freshId(7);
    h.emit('stranger', { id });
    await h.settle();
    h.emit('stranger', { id }); // the same gateway event again
    await h.settle();
    assert.deepEqual(h.delivered, ['friend:hi', 'anyone:in a guild']);
    assert.equal(h.notices.length, 1);
    assert.ok(h.logs.some((l) => l.includes('notice already-handled')));
  });

  it('sends nothing for an old message arriving live, from before the connector began handling refusals', async (t) => {
    const before = (BigInt(snowflakeAt(Date.now() - 60_000)) + 1n).toString();
    const h = harness(t, { dmUsers: ['friend'] });
    h.emit('stranger', { id: before });
    await h.settle();
    assert.deepEqual(h.notices, []);
    assert.ok(h.logs.some((l) => /\(live\): sender stranger.*notice before-floor/.test(l)));
  });

  it('reports an interrupted notice found when a repaired state file is reopened by a later refusal', async (t) => {
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-repair-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');
    const first = harness(t, { dmUsers: ['friend'], noticesPath });
    (first.adapter as unknown as Record<string, unknown>).sendDmNotice = () => new Promise(() => {}); // never settles
    first.emit('stranger', { id: freshId(1) });
    await first.settle();
    const pendingFile = readFileSync(noticesPath, 'utf-8');

    writeFileSync(noticesPath, '{ broken');
    const restarted = harness(t, { dmUsers: ['friend'], noticesPath }); // opens broken: suspended
    writeFileSync(noticesPath, pendingFile); // an operator repairs it
    restarted.emit('someone-else', { id: freshId(2) });
    await restarted.settle();
    assert.ok(restarted.logs.some((l) => /DM notice to sender stranger .* was interrupted before its outcome was recorded/.test(l)),
      'reported on the reopen, not only on the first open');
  });

  it('sends nothing when the resident has silenced notices', async (t) => {
    const h = harness(t, { dmUsers: ['friend'] });
    await h.server.filtersUpdate({ setDmNotice: false });
    h.emit('stranger');
    await h.settle();
    assert.deepEqual(h.notices, []);
    assert.ok(h.logs.some((l) => /notice silenced/.test(l)));
  });

  it('suspends notices when their state cannot be persisted', async (t) => {
    const h = harness(t, { dmUsers: ['friend'], noticesFile: 'unwritable' });
    h.emit('stranger');
    await h.settle();
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.delivered, []);
    assert.ok(h.logs.some((l) => /notice suspended \(/.test(l)));
  });

  it('records a failed or unknown send honestly and never retries it', async (t) => {
    const h = harness(t, { dmUsers: ['friend'] });
    h.failNoticesWith(Object.assign(new Error('Cannot send messages to this user'), { status: 403 }));
    h.emit('blocked-us', { id: freshId(1) });
    await h.settle();
    h.failNoticesWith(new Error('socket hang up'));
    h.emit('flaky', { id: freshId(2) });
    await h.settle();
    h.failNoticesWith(Object.assign(new Error('Service Unavailable'), { status: 503 }));
    h.emit('server-error', { id: freshId(5) });
    await h.settle();
    h.failNoticesWith(null);
    h.emit('blocked-us', { id: freshId(3) });
    h.emit('flaky', { id: freshId(4) });
    await h.settle();
    assert.deepEqual(h.notices, [], 'the window was reserved before each attempt; nothing is retried');
    assert.ok(h.logs.some((l) => /sender blocked-us.*notice failed: Cannot send messages/.test(l)));
    assert.ok(h.logs.some((l) => /sender flaky.*notice unknown: socket hang up/.test(l)));
    assert.ok(h.logs.some((l) => /sender server-error.*notice unknown: Service Unavailable/.test(l)),
      'a 5xx may have posted it, so it is unknown, not failed');
  });
});

describe('the reconnect catch-up sweep applies the live ingress decision', () => {
  it('withholds a DM from a sender removed from the DM list, and notifies it once', async (t) => {
    const h = harness(t, {
      dmUsers: ['still-allowed'],
      watermarks: { 'dm-chan-1': '100' },
      dmChannels: ['dm-chan-1'],
      history: async () => [historyMessage(freshId(1), 'removed-user', 'sent during downtime')],
    });
    await h.server.runReconnectSweep();
    await h.settle();
    assert.deepEqual(h.pushes, [], 'nothing is rendered for the agent');
    assert.deepEqual(h.notices, [{ channelId: 'dm-chan-1', content: DM_NOTICE_TEXT }]);
    assert.ok(h.logs.some((l) => /\(sweep\): sender removed-user/.test(l)));
    assert.ok(!h.logs.some((l) => l.includes('sent during downtime')));
    assert.notEqual(h.server.forwardedWatermark.get('dm-chan-1'), '100', 'the anchor moves past what was withheld');
  });

  it('still delivers DMs from allowed senders in the same channel', async (t) => {
    const h = harness(t, {
      dmUsers: ['still-allowed'],
      watermarks: { 'dm-chan-1': '100' },
      dmChannels: ['dm-chan-1'],
      history: async () => [
        historyMessage(freshId(1), 'removed-user', 'withheld words'),
        historyMessage(freshId(2), 'still-allowed', 'welcome words'),
      ],
    });
    await h.server.runReconnectSweep();
    assert.equal(h.pushes.length, 1);
    const text = h.pushes[0].payload.content[0].text;
    assert.ok(text.includes('welcome words'));
    assert.ok(!text.includes('withheld words'));
  });

  it('withholds messages from a channel of a guild removed from the guild filter', async (t) => {
    const h = harness(t, {
      guildIds: ['kept-guild'],
      watermarks: { 'chan-in-removed-guild': '200' },
      history: async () => [historyMessage(freshId(1), 'someone', '@bot are you there', true)],
      meta: () => ({ name: 'general', guildId: 'removed-guild', guildName: 'Removed Guild', isDM: false }),
    });
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.deepEqual(h.notices, [], 'guild refusals send no DM notice');
  });

  it('decides with the filters in force after the fetch, not before it', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(t, {
      dmUsers: ['friend', 'soon-removed'],
      watermarks: { 'dm-chan-2': '100' },
      dmChannels: ['dm-chan-2'],
      history: async () => {
        await gate;
        return [historyMessage(freshId(1), 'soon-removed', 'pending words')];
      },
    });
    const sweep = h.server.runReconnectSweep();
    await h.settle();
    h.adapter.updateFilters({ dmUsers: ['friend'] }); // the contact is removed while the fetch is pending
    release();
    await sweep;
    assert.deepEqual(h.pushes, []);
  });

  it('with the real metadata helpers, an unresolvable channel is held back, not read as a DM, and says so', async (t) => {
    const h = harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'gone-chan': '400' },
      history: async () => [historyMessage(freshId(1), 'friend', '@bot ping', true)],
      realMeta: true,
    });
    t.mock.method(h.client.channels, 'fetch', async () => null);
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.equal(h.server.forwardedWatermark.get('gone-chan'), '400');
    assert.ok(h.logs.some((l) => /Catch-up held back channel gone-chan: neither its guild nor DM identity could be resolved/.test(l)),
      'visible outside the debug log');
  });

  it('says outside the debug log when it withholds guild messages the filters refuse', async (t) => {
    const h = harness(t, {
      guildIds: ['kept-guild'],
      watermarks: { 'chan-in-removed-guild': '200' },
      history: async () => [historyMessage(freshId(1), 'someone', '@bot hello', true)],
      meta: () => ({ name: 'general', guildId: 'removed-guild', guildName: 'Removed Guild', isDM: false }),
    });
    await h.server.runReconnectSweep();
    assert.ok(h.logs.some((l) => /Catch-up withheld 1 missed message\(s\) in channel chan-in-removed-guild: guild-not-allowed/.test(l)));
    assert.ok(!h.logs.some((l) => l.includes('@bot hello')), 'no body in the log');
  });

  it('never delivers a channel whose identity cannot be resolved as if it were a DM', async (t) => {
    const h = harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'mystery-chan': '300' },
      history: async () => [historyMessage(freshId(1), 'friend', '@bot ping', true)],
      meta: () => null,
    });
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.equal(h.server.forwardedWatermark.get('mystery-chan'), '300', 'it waits for the next sweep');
  });

  it('a message already handled live is not notified again by the sweep', async (t) => {
    let id = '';
    const h = harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'dm-stranger': '100' },
      dmChannels: ['dm-stranger'],
      history: async () => [historyMessage(id, 'stranger', 'once')],
    });
    id = freshId(9);
    h.emit('stranger', { id, channelId: 'dm-stranger' });
    await h.settle();
    await h.server.runReconnectSweep();
    await h.settle();
    assert.equal(h.notices.length, 1);
    assert.ok(h.logs.some((l) => /\(sweep\): sender stranger.*notice already-handled/.test(l)));
  });
});

describe('the notice setting', () => {
  it('works without a filters file and survives a restart', async (t) => {
    const prev = process.env.DISCORD_FILTERS_FILE;
    delete process.env.DISCORD_FILTERS_FILE;
    t.after(() => { if (prev !== undefined) process.env.DISCORD_FILTERS_FILE = prev; });
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-keep-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');

    const first = harness(t, { dmUsers: ['friend'], noticesPath });
    const shown = await first.server.executeToolCall('filters_get', {}) as { dmNotice: { enabled: boolean; persisted: boolean; path: string } };
    assert.deepEqual([shown.dmNotice.enabled, shown.dmNotice.persisted, shown.dmNotice.path], [true, true, noticesPath]);
    await assert.rejects(first.server.filtersUpdate({ setDmNotice: false, setDmUsers: ['x'] }), /DISCORD_FILTERS_FILE is not set/);
    assert.equal(JSON.parse(readFileSync(noticesPath, 'utf-8')).enabled, true, 'a refused filter change applies nothing');
    const off = await first.server.filtersUpdate({ setDmNotice: false });
    assert.equal(off.applied.dmNotice, false);
    await assert.rejects(first.server.filtersUpdate({ setDmNotice: 'no' }), /true or false/);
    await assert.rejects(first.server.filtersUpdate({ setDmUsers: ['x'] }), /DISCORD_FILTERS_FILE is not set/,
      'whitelist changes still need the filters file');

    const restarted = harness(t, { dmUsers: ['friend'], noticesPath });
    restarted.emit('stranger');
    await restarted.settle();
    assert.deepEqual(restarted.notices, []);
    const again = await restarted.server.executeToolCall('filters_get', {}) as { dmNotice: { enabled: boolean } };
    assert.equal(again.dmNotice.enabled, false);
    await restarted.server.filtersUpdate({ setDmNotice: true });
    restarted.emit('stranger');
    await restarted.settle();
    assert.equal(restarted.notices.length, 1);
  });

  it('works alongside whitelist changes when a filters file is configured, without writing to it', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-notice-tool-'));
    const prev = process.env.DISCORD_FILTERS_FILE;
    const path = join(dir, 'filters.json');
    writeFileSync(path, JSON.stringify({ dmUsers: ['friend'] }));
    process.env.DISCORD_FILTERS_FILE = path;
    t.after(() => {
      if (prev === undefined) delete process.env.DISCORD_FILTERS_FILE; else process.env.DISCORD_FILTERS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    });
    const h = harness(t, { dmUsers: ['friend'] });
    const res = await h.server.filtersUpdate({ setDmNotice: false, setDmUsers: ['friend', 'new-friend'] });
    assert.equal(res.applied.dmNotice, false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { dmUsers: ['friend', 'new-friend'] });
    assert.equal(JSON.parse(readFileSync(h.noticesPath, 'utf-8')).enabled, false);
  });
});

describe('adapter surfaces', () => {
  function adapterFixture(t: TestContext, config: ConstructorParameters<typeof DiscordAdapter>[0]) {
    const adapter = new DiscordAdapter(config);
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    return { adapter, client };
  }

  it('reports a refused DM by identity only, and nothing else', (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused', dmUsers: ['friend'] });
    const refusals: DmRefusal[] = [];
    adapter.onDmRefused((ev) => refusals.push(ev));
    adapter.onMessage(() => {});
    const emit = (authorId: string, guildId: string | null) =>
      (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
        id: '12345', channelId: 'chan', guildId, channel: null,
        author: { id: authorId, username: authorId, bot: false },
        content: 'secret', cleanContent: 'secret', type: MessageType.Default,
        attachments: new Collection(), createdAt: new Date(),
        mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
      });
    emit('friend', null);
    emit('anyone', 'g1');
    emit('stranger', null);
    assert.deepEqual(refusals, [{ messageId: '12345', channelId: 'chan', authorId: 'stranger', origin: 'live' }]);
  });

  it('decides history with the live rules, including a thread under an allowed parent', (t) => {
    const { adapter, client } = adapterFixture(t, {
      token: 'unused', dmUsers: ['friend'], guildIds: ['g1'], guildChannels: { g1: ['parent'] },
    });
    (client.channels.cache as unknown as Map<string, unknown>).set('thread1', { id: 'thread1', parentId: 'parent' });
    assert.equal(adapter.historyIngressReason('dm1', null, 'friend'), null);
    assert.equal(adapter.historyIngressReason('dm1', null, 'stranger'), 'dm-user-not-allowed');
    assert.equal(adapter.historyIngressReason('thread1', 'g1', 'someone'), null);
    assert.equal(adapter.historyIngressReason('other', 'g1', 'someone'), 'channel-not-allowed');
    assert.equal(adapter.historyIngressReason('chan', 'g2', 'someone'), 'guild-not-allowed');
  });

  it('sends the notice through discord.js with an enforced nonce and no mentions', async (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused' });
    // A real DMChannel in the cache, and the REST layer captured: this
    // exercises discord.js's own MessagePayload, not a mocked send.
    (client.channels as unknown as { _add(data: unknown): unknown })._add({
      id: 'dm1', type: ChannelType.DM, last_message_id: null,
      recipients: [{ id: 'u1', username: 'u1', discriminator: '0' }],
    });
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    t.mock.method(client.rest, 'post', async (route: string, options: { body: Record<string, unknown> }) => {
      calls.push({ route, body: options.body });
      return {
        id: '1300000000000000001', channel_id: 'dm1', author: { id: '1300000000000000002', username: 'bot', discriminator: '0' },
        content: options.body.content, timestamp: new Date().toISOString(), edited_timestamp: null,
        tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [],
        pinned: false, type: 0,
      };
    });
    assert.deepEqual(await adapter.sendDmNotice('dm1', DM_NOTICE_TEXT, 'dmn123'), { messageId: '1300000000000000001' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, '/channels/dm1/messages');
    assert.equal(calls[0].body.content, DM_NOTICE_TEXT);
    assert.equal(calls[0].body.nonce, 'dmn123');
    assert.equal(calls[0].body.enforce_nonce, true);
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  });

  it('reports channel kind only when it is known', async (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused' });
    const answers: unknown[] = [
      null,
      {},
      { isDMBased: () => true },
      { guildId: 'g1', name: 'general', guild: { name: 'Guild' }, isDMBased: () => false },
    ];
    t.mock.method(client.channels, 'fetch', async () => answers.shift());
    assert.equal((await adapter.getChannelMeta('a')).isDM, null, 'unresolvable');
    assert.equal((await adapter.getChannelMeta('b')).isDM, null, 'sparse');
    assert.equal((await adapter.getChannelMeta('c')).isDM, true);
    assert.deepEqual(await adapter.getChannelMeta('d'), { name: 'general', guildId: 'g1', guildName: 'Guild', isDM: false });
  });
});
