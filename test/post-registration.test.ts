import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelFacts, DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { snowflakeAt } from '../src/dm-notices.js';
import { toDescriptor, toDmDescriptor } from '../src/channels.js';

const DM = '160000000000000009';
const THREAD = '145000000000000045';
const CHANNEL = '110000000000000001';
const OUTSIDE = '170000000000000007';

type Meta = { name: string | null; guildId: string | null; guildName: string | null; isDM: boolean | null };
type Looked = { kind: 'dm'; recipientId: string; recipientName: string } | { kind: 'uncertain' } | null;
type Descriptor = { id: string; label: string; metadata?: Record<string, unknown> };
type Changed = { added?: Descriptor[]; updated?: Descriptor[] };

const postedAt = (ms: number) => snowflakeAt(ms);

function fixture(opts: {
  meta?: Record<string, Meta>;
  facts?: Record<string, ChannelFacts>;
  admitted?: Set<string>;
  dmAdmitted?: Set<string>;
  lookups?: Record<string, Looked | (() => Promise<Looked>)>;
  postAt?: number;
} = {}) {
  const log: string[] = [];
  const changed: Changed[] = [];
  const lookedUp: string[] = [];
  let inFlight = 0;
  let mostAtOnce = 0;
  let dmPosts = 0;
  const adapter = {
    botUserId: 'bot',
    refreshStale: async () => {},
    resolveChannelRef: () => ({ ok: false, message: 'unknown' }),
    getCachedChannelMeta: (id: string) => opts.meta?.[id] ?? null,
    getCachedChannelFacts: (id: string) => opts.facts?.[id] ?? null,
    getCachedChannelFactsFor: (ids: Iterable<string>) =>
      new Map([...ids].flatMap((id) => (opts.facts?.[id] ? [[id, opts.facts[id]] as const] : []))),
    getCachedDmRecipientName: () => null,
    isStale: () => false,
    hasGuild: (guildId: string) => guildId === 'g1',
    channelAdmitted: (_guildId: string, channelId: string) => opts.admitted?.has(channelId) ?? true,
    dmUserAdmitted: (userId: string) => opts.dmAdmitted?.has(userId) ?? true,
    async lookUpServedChannel(guildSegment: string, channelId: string): Promise<Looked> {
      assert.equal(guildSegment, 'dm');
      lookedUp.push(channelId);
      inFlight++;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        const found = opts.lookups?.[channelId];
        return typeof found === 'function' ? await found() : (found ?? null);
      } finally {
        inFlight--;
      }
    },
    async sendMessage() {
      return { messageId: postedAt(opts.postAt ?? Date.now()) };
    },
    async sendDM() {
      return { messageId: postedAt(Date.parse('2026-11-08T00:00:00Z') + 1000 * ++dmPosts), channelId: DM, recipientId: 'u9', recipientName: 'Ra' };
    },
  };
  const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
    channelManager: { get(id: string): Descriptor | undefined; register(d: unknown): void };
    dmChannelIds: Set<string>;
    subscriptionsLoaded: boolean;
    reactionChannelsLoaded: boolean;
    mutedLoaded: boolean;
    mcplEnabled: boolean;
    enabledFeatureSets: Set<string>;
    conn: unknown;
    handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    registerKeptDms(): Promise<void>;
  };
  server.subscriptionsLoaded = true;
  server.reactionChannelsLoaded = true;
  server.mutedLoaded = true;
  server.mcplEnabled = true;
  server.enabledFeatureSets = new Set(['discord.messaging']);
  server.conn = {
    isClosed: false,
    sendNotification: (method: string, params: Changed) => {
      if (method !== 'channels/changed') return;
      log.push('channels/changed');
      changed.push(params);
    },
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await server.handleToolCall(name, args);
    log.push('answered');
    assert.ok(!res.isError, res.content[0]?.text);
    return JSON.parse(res.content[0].text) as { channelId: string | null; channelLabel: string | null };
  };
  return { server, log, changed, lookedUp, call, mostAtOnce: () => mostAtOnce };
}

function watermarkFile(t: TestContext, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-post-reg-'));
  const path = join(dir, 'watermarks.json');
  writeFileSync(path, JSON.stringify(contents));
  const before = process.env.DISCORD_WATERMARK_FILE;
  process.env.DISCORD_WATERMARK_FILE = path;
  t.after(() => {
    if (before === undefined) delete process.env.DISCORD_WATERMARK_FILE;
    else process.env.DISCORD_WATERMARK_FILE = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

describe('a post registers the place it went before its answer, where this server serves that place', () => {
  it('send_dm to someone with no DM registered: the DM is announced before the answer, which names it', async (t) => {
    const path = watermarkFile(t, {});
    const f = fixture();
    const answer = await f.call('send_dm', { userId: 'u9', content: 'hello' });
    assert.deepEqual(f.log, ['channels/changed', 'answered']);
    const added = f.changed[0].added ?? [];
    assert.deepEqual(added.map((d) => [d.id, d.label, d.metadata?.recipientId]), [[`discord:dm:${DM}`, 'DM: Ra', 'u9']]);
    assert.equal(answer.channelId, `discord:dm:${DM}`);
    assert.ok(f.server.channelManager.get(`discord:dm:${DM}`));
    assert.ok(f.server.dmChannelIds.has(DM));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).dmChannels, [DM]);
  });

  it('a post that registers a new DM keeps what the watermark file already held', async (t) => {
    const path = watermarkFile(t, {
      watermarks: { [CHANNEL]: '120000000000000002' },
      dmChannels: ['150000000000000005'],
      missed: {},
    });
    const f = fixture();
    await f.call('send_dm', { userId: 'u9', content: 'hi' });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(after.watermarks, { [CHANNEL]: '120000000000000002', [DM]: postedAt(Date.parse('2026-11-08T00:00:01Z')) });
    assert.deepEqual(after.dmChannels, ['150000000000000005', DM]);
  });

  it("a post into a DM with no catch-up position makes the post's id its position, and a DM that has one keeps it", async (t) => {
    const path = watermarkFile(t, {});
    const f = fixture();
    await f.call('send_dm', { userId: 'u9', content: 'first' });
    const first = postedAt(Date.parse('2026-11-08T00:00:01Z'));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).watermarks?.[DM], first);
    await f.call('send_dm', { userId: 'u9', content: 'second' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).watermarks?.[DM], first);
  });

  it('send_dm to someone the DM list leaves out: nothing is registered or kept, and the answer still names the DM', async (t) => {
    watermarkFile(t, {});
    const f = fixture({ dmAdmitted: new Set() });
    const answer = await f.call('send_dm', { userId: 'u9', content: 'hello' });
    assert.deepEqual(f.log, ['answered']);
    assert.equal(answer.channelId, `discord:dm:${DM}`);
    assert.equal(f.server.channelManager.get(`discord:dm:${DM}`), undefined);
    assert.equal(f.server.dmChannelIds.has(DM), false);
  });

  it('a post into a DM by its channel id registers it with the other party a lookup finds', async (t) => {
    watermarkFile(t, {});
    const OTHER = '160000000000000019';
    const f = fixture({
      meta: {
        [DM]: { name: null, guildId: null, guildName: null, isDM: true },
        [OTHER]: { name: null, guildId: null, guildName: null, isDM: true },
      },
      lookups: {
        [DM]: { kind: 'dm', recipientId: 'u7', recipientName: 'Bo' },
        [OTHER]: { kind: 'dm', recipientId: 'u8', recipientName: 'Flo' },
      },
    });
    for (const [tool, place, extra] of [['send_message', DM, {}], ['reply_message', OTHER, { messageId: '5' }]] as const) {
      const answer = await f.call(tool, { channelId: place, content: 'hi', ...extra });
      assert.equal(answer.channelId, `discord:dm:${place}`, tool);
    }
    assert.deepEqual(f.log, ['channels/changed', 'answered', 'channels/changed', 'answered']);
    assert.deepEqual(f.changed.map((c) => c.added?.map((d) => [d.id, d.label, d.metadata?.recipientId])), [
      [[`discord:dm:${DM}`, 'DM: Bo', 'u7']],
      [[`discord:dm:${OTHER}`, 'DM: Flo', 'u8']],
    ]);
    assert.ok(f.server.dmChannelIds.has(DM) && f.server.dmChannelIds.has(OTHER));
  });

  it('a post into a DM already registered and kept makes no lookup, and keeps the position the DM has', async (t) => {
    const path = watermarkFile(t, { watermarks: { [DM]: '150000000000000001' }, dmChannels: [DM] });
    const f = fixture({ meta: { [DM]: { name: null, guildId: null, guildName: null, isDM: true } } });
    f.server.channelManager.register(toDmDescriptor(DM, 'Bo', false, 80, 'u7'));
    const answer = await f.call('send_message', { channelId: DM, content: 'hi' });
    assert.equal(answer.channelId, `discord:dm:${DM}`);
    assert.deepEqual(f.lookedUp, []);
    assert.deepEqual(f.log, ['answered']);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).watermarks?.[DM], '150000000000000001');
  });

  it('a post into a DM registered and kept with no catch-up position makes the post its position, with no lookup', async (t) => {
    const path = watermarkFile(t, { dmChannels: [DM] });
    const at = Date.parse('2026-11-08T00:00:05Z');
    const f = fixture({ meta: { [DM]: { name: null, guildId: null, guildName: null, isDM: true } }, postAt: at });
    f.server.channelManager.register(toDmDescriptor(DM, 'Bo', false, 80, 'u7'));
    await f.call('send_message', { channelId: DM, content: 'hi' });
    assert.deepEqual(f.lookedUp, []);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).watermarks?.[DM], postedAt(at));
  });

  it("a post into a DM whose other party Discord's answer leaves uncertain registers nothing, and says so in one line", async (t) => {
    watermarkFile(t, {});
    const f = fixture({ meta: { [DM]: { name: null, guildId: null, guildName: null, isDM: true } }, lookups: { [DM]: { kind: 'uncertain' } } });
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
    t.after(() => { console.error = original; });
    const answer = await f.call('send_message', { channelId: DM, content: 'hi' });
    assert.equal(answer.channelId, `discord:dm:${DM}`);
    assert.deepEqual(f.log, ['answered']);
    assert.equal(f.server.dmChannelIds.has(DM), false);
    const said = lines.filter((l) => l.includes(DM));
    assert.equal(said.length, 1, lines.join(' | '));
    assert.match(said[0], /couldn't be read/);
  });

  it('a post into a DM the lookup finds no longer served registers nothing', async (t) => {
    watermarkFile(t, {});
    const f = fixture({ meta: { [DM]: { name: null, guildId: null, guildName: null, isDM: true } }, lookups: { [DM]: null } });
    const answer = await f.call('send_message', { channelId: DM, content: 'hi' });
    assert.deepEqual(f.log, ['answered']);
    assert.equal(answer.channelId, `discord:dm:${DM}`);
    assert.equal(f.server.dmChannelIds.has(DM), false);
  });

  it('a post into an admitted thread the registry does not hold, one the post unarchived included, registers it', async () => {
    const archivedAt = Date.parse('2026-11-01T00:00:00Z');
    const thread: ChannelFacts = {
      id: THREAD, guildId: 'g1', guildName: 'Guild One', type: 'thread', name: 'standup',
      parentId: CHANNEL, parentName: 'general', archived: true, archivedAt,
    };
    const f = fixture({
      meta: { [THREAD]: { name: 'standup', guildId: 'g1', guildName: 'Guild One', isDM: false } },
      facts: { [THREAD]: thread },
      postAt: archivedAt + 60_000,
    });
    const answer = await f.call('send_message', { channelId: THREAD, content: 'hi' });
    assert.deepEqual(f.log, ['channels/changed', 'answered']);
    assert.deepEqual(f.changed[0].added?.map((d) => d.id), [`discord:g1:${THREAD}`]);
    assert.equal(answer.channelId, `discord:g1:${THREAD}`);
  });

  it('a post into a channel outside the filters registers nothing, and the answer names its canonical id', async () => {
    const f = fixture({
      meta: { [OUTSIDE]: { name: 'elsewhere', guildId: 'g1', guildName: 'Guild One', isDM: false } },
      facts: { [OUTSIDE]: { id: OUTSIDE, guildId: 'g1', guildName: 'Guild One', type: 'text', name: 'elsewhere' } },
      admitted: new Set(),
    });
    const answer = await f.call('send_message', { channelId: OUTSIDE, content: 'hi' });
    assert.deepEqual(f.log, ['answered']);
    assert.equal(answer.channelId, `discord:g1:${OUTSIDE}`);
    assert.equal(f.server.channelManager.get(`discord:g1:${OUTSIDE}`), undefined);
  });

  it('a post whose registration fails still answers the place it went', async (t) => {
    watermarkFile(t, {});
    const f = fixture({
      meta: { [DM]: { name: null, guildId: null, guildName: null, isDM: true } },
      lookups: { [DM]: async () => { throw new Error('lookup broke'); } },
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    t.after(() => { console.error = original; });
    const answer = await f.call('send_message', { channelId: DM, content: 'hi' });
    assert.equal(answer.channelId, `discord:dm:${DM}`);
    assert.ok(errors.some((e) => String(e).includes('lookup broke')), String(errors));
  });

  it('a guild channel the registry already holds is not touched by a post into it', async () => {
    const f = fixture({
      meta: { [CHANNEL]: { name: 'general', guildId: 'g1', guildName: 'Guild One', isDM: false } },
      facts: { [CHANNEL]: { id: CHANNEL, guildId: 'g1', guildName: 'Guild One', type: 'text', name: 'general' } },
    });
    f.server.channelManager.register(toDescriptor({ id: CHANNEL, guildId: 'g1', guildName: 'Guild One', type: 'text', name: 'general' }));
    const answer = await f.call('send_message', { channelId: CHANNEL, content: 'hi' });
    assert.deepEqual(f.log, ['answered']);
    assert.equal(answer.channelId, `discord:g1:${CHANNEL}`);
  });
});

describe('at start, the DMs the watermark file keeps are looked up one at a time and registered together', () => {
  it('registers each served kept DM in one channels/changed, skips the rest with one line each, and runs once', async (t) => {
    const [held, served, refused, unsure, also] = ['161', '162', '163', '164', '167'].map((p) => `${p}000000000000001`);
    watermarkFile(t, { dmChannels: [held, served, refused, unsure, also] });
    const f = fixture({
      lookups: {
        [served]: { kind: 'dm', recipientId: 'u2', recipientName: 'Cy' },
        [also]: { kind: 'dm', recipientId: 'u4', recipientName: 'Ed' },
        [refused]: null,
        [unsure]: { kind: 'uncertain' },
      },
    });
    f.server.channelManager.register(toDmDescriptor(held, 'Al', false, 80, 'u1'));
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
    t.after(() => { console.error = original; });
    await f.server.registerKeptDms();
    await f.server.registerKeptDms();
    assert.deepEqual(f.lookedUp, [served, refused, unsure, also], 'one lookup each, none for a DM already registered, and only once');
    assert.equal(f.mostAtOnce(), 1);
    assert.equal(f.changed.length, 1);
    assert.deepEqual(f.changed[0].added?.map((d) => [d.id, d.label, d.metadata?.recipientId]), [
      [`discord:dm:${served}`, 'DM: Cy', 'u2'],
      [`discord:dm:${also}`, 'DM: Ed', 'u4'],
    ]);
    for (const id of [refused, unsure]) {
      assert.equal(lines.filter((l) => l.includes(id)).length, 1, `one line for ${id}: ${lines.join(' | ')}`);
      assert.ok(f.server.dmChannelIds.has(id), 'a skipped DM stays kept');
    }
    assert.doesNotMatch(lines.find((l) => l.includes(refused))!, /registers when/, 'a DM the list may leave out is promised nothing');
  });

  it('the batch leaves out a DM registered while the lookups ran, and one whose recipient the DM list dropped meanwhile', async (t) => {
    const [early, dropped, last] = ['171', '172', '173'].map((p) => `${p}000000000000001`);
    watermarkFile(t, { dmChannels: [early, dropped, last] });
    const admitted = new Set(['u1', 'u2', 'u3']);
    let f!: ReturnType<typeof fixture>;
    f = fixture({
      dmAdmitted: admitted,
      lookups: {
        [early]: { kind: 'dm', recipientId: 'u1', recipientName: 'u1-from-lookup' },
        [dropped]: { kind: 'dm', recipientId: 'u2', recipientName: 'Bea' },
        [last]: async () => {
          f.server.channelManager.register(toDmDescriptor(early, 'Al', false, 80, 'u1'));
          admitted.delete('u2');
          return { kind: 'dm', recipientId: 'u3', recipientName: 'Cal' };
        },
      },
    });
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
    t.after(() => { console.error = original; });
    await f.server.registerKeptDms();
    assert.deepEqual(f.changed.map((c) => c.added?.map((d) => d.id)), [[`discord:dm:${last}`]]);
    assert.equal(f.server.channelManager.get(`discord:dm:${early}`)?.label, 'DM: Al', 'the registration made meanwhile stands');
    assert.equal(f.server.channelManager.get(`discord:dm:${dropped}`), undefined);
    assert.equal(lines.filter((l) => l.includes(dropped)).length, 1, lines.join(' | '));
  });

  it('a lookup that rejects leaves its DM out and the others still land', async (t) => {
    const [broken, served] = ['165', '166'].map((p) => `${p}000000000000001`);
    watermarkFile(t, { dmChannels: [broken, served] });
    const f = fixture({
      lookups: {
        [broken]: async () => { throw new Error('rest gone'); },
        [served]: { kind: 'dm', recipientId: 'u3', recipientName: 'Di' },
      },
    });
    const original = console.error;
    console.error = () => {};
    t.after(() => { console.error = original; });
    await f.server.registerKeptDms();
    assert.deepEqual(f.changed.map((c) => c.added?.map((d) => d.id)), [[`discord:dm:${served}`]]);
  });

});
