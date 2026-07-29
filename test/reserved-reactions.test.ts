/**
 * Tests for the reserved-reaction projection policy (issue #21).
 *
 * The invariant: a reserved reaction leaves no glyph, name, or token in any
 * model-visible output — event text, event ids, history snapshots — while
 * raw Discord state is untouched. Unset policy = no protection (reported,
 * not implied); configured-but-broken policy = fail closed; bad rewrite of
 * a good policy = last-known-good.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReservedReactionsPolicy } from '../src/reserved-reactions.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter, ReactionSummary } from '../src/discord-adapter.js';

const RESERVED_UNICODE = '🛑';
const RESERVED_FAMILY_BASE = '👍';
const RESERVED_CUSTOM_ID = '111222333444555666';
const HARMLESS = '😀';

let dir: string;
let policyPath: string;
let mtimeBump = 1_700_000_000; // deterministic distinct mtimes for hot-reload

function writePolicy(content: unknown | string): void {
  writeFileSync(policyPath, typeof content === 'string' ? content : JSON.stringify(content));
  // File watchers aren't involved — reload keys off mtime, which coarse
  // filesystem timestamps can leave unchanged across quick rewrites.
  utimesSync(policyPath, new Date(mtimeBump * 1000), new Date(mtimeBump * 1000));
  mtimeBump += 60;
}

function goodPolicy(): void {
  writePolicy({
    version: 1,
    customEmojiIds: [RESERVED_CUSTOM_ID],
    unicodeExact: [RESERVED_UNICODE],
    unicodeFamilies: [RESERVED_FAMILY_BASE],
  });
}

function summary(emoji: string, emojiId: string | null = null): ReactionSummary {
  return { emoji, emojiId, token: emojiId ? `<:x:${emojiId}>` : emoji, count: 2, me: false };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reserved-reactions-'));
  policyPath = join(dir, 'reserved.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DISCORD_RESERVED_REACTIONS_FILE;
});

describe('ReservedReactionsPolicy', () => {
  it('unset path: empty policy, honest status, nothing suppressed', () => {
    const policy = new ReservedReactionsPolicy(undefined);
    assert.deepEqual(policy.status(), { state: 'unset' });
    assert.equal(policy.suppressAll(), false);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), false);
    const proj = policy.project([summary(RESERVED_UNICODE)]);
    assert.equal(proj.reactions.length, 1);
    assert.equal(proj.unavailable, false);
  });

  it('matches custom emoji by id, not by display name', () => {
    goodPolicy();
    const policy = new ReservedReactionsPolicy(policyPath);
    assert.equal(policy.isReserved({ emojiId: RESERVED_CUSTOM_ID, emoji: ':innocent_name:' }), true);
    assert.equal(policy.isReserved({ emojiId: '999888777666555444', emoji: ':innocent_name:' }), false);
  });

  it('matches unicode exact across presentation-selector encodings', () => {
    goodPolicy();
    const policy = new ReservedReactionsPolicy(policyPath);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), true);
    assert.equal(policy.isReserved({ emoji: `${RESERVED_UNICODE}\uFE0F` }), true, 'VS16 variant');
    assert.equal(policy.isReserved({ emoji: HARMLESS }), false);
  });

  it('family entries cover skin-tone variants; exact entries do not', () => {
    goodPolicy();
    const policy = new ReservedReactionsPolicy(policyPath);
    // Family base 👍 covers toned variants.
    assert.equal(policy.isReserved({ emoji: `${RESERVED_FAMILY_BASE}\u{1F3FD}` }), true);
    assert.equal(policy.isReserved({ emoji: RESERVED_FAMILY_BASE }), true);
    // Exact-only 🛑 has no tone variants configured as family; a (contrived)
    // toned form must NOT match via the exact list.
    writePolicy({ version: 1, unicodeExact: [RESERVED_UNICODE] });
    const exactOnly = new ReservedReactionsPolicy(policyPath);
    assert.equal(exactOnly.isReserved({ emoji: `${RESERVED_UNICODE}\u{1F3FD}` }), false);
  });

  it('fails closed when the configured file is missing', () => {
    const policy = new ReservedReactionsPolicy(join(dir, 'nope.json'));
    assert.equal(policy.suppressAll(), true);
    assert.equal(policy.status().state, 'failed-closed');
    const proj = policy.project([summary(HARMLESS)]);
    assert.deepEqual(proj.reactions, []);
    assert.equal(proj.unavailable, true);
  });

  it('fails closed on malformed JSON and on a wrong version', () => {
    writePolicy('{not json');
    assert.equal(new ReservedReactionsPolicy(policyPath).suppressAll(), true);
    writePolicy({ version: 2, unicodeExact: [RESERVED_UNICODE] });
    assert.equal(new ReservedReactionsPolicy(policyPath).suppressAll(), true);
    writePolicy({ version: 1, unicodeExact: 'not-an-array' });
    assert.equal(new ReservedReactionsPolicy(policyPath).suppressAll(), true);
  });

  it('recovers from failed-closed when the file is repaired', () => {
    writePolicy('{broken');
    const policy = new ReservedReactionsPolicy(policyPath);
    assert.equal(policy.suppressAll(), true);
    goodPolicy();
    assert.equal(policy.suppressAll(), false);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), true);
    assert.equal(policy.status().state, 'active');
  });

  it('keeps last-known-good through a bad rewrite, and reports stale', () => {
    goodPolicy();
    const policy = new ReservedReactionsPolicy(policyPath);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), true);
    writePolicy('{broken');
    // Still filtering per the old policy — not empty, not fail-closed.
    assert.equal(policy.suppressAll(), false);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), true);
    const status = policy.status();
    assert.equal(status.state, 'active');
    assert.ok('staleSince' in status && status.staleSince, 'stale state is reported');
    // And it recovers when repaired.
    goodPolicy();
    assert.equal((policy.status() as { staleSince?: string }).staleSince, undefined);
  });

  it('keeps last-known-good when the file vanishes after a good load', () => {
    goodPolicy();
    const policy = new ReservedReactionsPolicy(policyPath);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), true);
    unlinkSync(policyPath);
    assert.equal(policy.suppressAll(), false);
    assert.equal(policy.isReserved({ emoji: RESERVED_UNICODE }), true);
  });

  it('status never contains a configured glyph', () => {
    goodPolicy();
    const policy = new ReservedReactionsPolicy(policyPath);
    const s = JSON.stringify(policy.status());
    assert.ok(!s.includes(RESERVED_UNICODE), s);
    assert.ok(!s.includes(RESERVED_FAMILY_BASE), s);
    assert.ok(!s.includes(RESERVED_CUSTOM_ID), s);
  });
});

describe('server integration', () => {
  function makeServer(): DiscordMcplServer {
    // Policy path is read from env at construction.
    process.env.DISCORD_RESERVED_REACTIONS_FILE = policyPath;
    return new DiscordMcplServer({} as DiscordAdapter);
  }

  it('projects reserved reactions out of history messages', () => {
    goodPolicy();
    const server = makeServer() as unknown as {
      projectHistoryReactions(msgs: Array<{ id: string; reactions?: ReactionSummary[] }>): Array<{
        id: string;
        reactions?: ReactionSummary[];
        reactionsUnavailable?: true;
      }>;
    };
    const out = server.projectHistoryReactions([
      { id: 'm1', reactions: [summary(RESERVED_UNICODE), summary(HARMLESS), summary(':x:', RESERVED_CUSTOM_ID)] },
      { id: 'm2' },
    ]);
    assert.deepEqual(out[0].reactions?.map((r) => r.emoji), [HARMLESS]);
    assert.equal(out[0].reactionsUnavailable, undefined);
    assert.equal(out[1].reactions?.length ?? 0, 0);
    assert.ok(!JSON.stringify(out).includes(RESERVED_UNICODE), 'no glyph anywhere in projected output');
  });

  it('failed-closed policy suppresses all history reactions with an unavailable marker', () => {
    writePolicy('{broken');
    const server = makeServer() as unknown as {
      projectHistoryReactions(msgs: Array<{ id: string; reactions?: ReactionSummary[] }>): Array<{
        reactions?: ReactionSummary[];
        reactionsUnavailable?: true;
      }>;
    };
    const out = server.projectHistoryReactions([{ id: 'm1', reactions: [summary(HARMLESS)] }]);
    assert.deepEqual(out[0].reactions, []);
    assert.equal(out[0].reactionsUnavailable, true, 'empty must not read as "none"');
  });

  it('drops reserved live reaction events before text or event id exists', () => {
    goodPolicy();
    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;

    // Capture the onReaction handler without a real Discord connection; stub
    // every other handler registration setupDiscordForwarding performs.
    let reactionHandler: ((ev: Record<string, unknown>) => void) | undefined;
    const noop = () => {};
    s.discord = {
      onMessage: noop, onMessageEdit: noop, onMessageDelete: noop,
      onChannelCreate: noop, onChannelDelete: noop, onGuildCreate: noop,
      onChannelAvailable: noop,
      onReaction: (h: (ev: Record<string, unknown>) => void) => { reactionHandler = h; },
    };
    const sent: unknown[] = [];
    s.conn = { sendRequest: (method: string, params: unknown) => { sent.push({ method, params }); return Promise.resolve({}); } };
    s.mcplEnabled = true;
    (s.enabledFeatureSets as Set<string>).add('discord.messaging');
    (s.reactionChannels as Set<string>).add('chan1');
    s.reactionChannelsLoaded = true;
    (s.setupDiscordForwarding as () => void).call(server);
    assert.ok(reactionHandler, 'reaction handler registered');

    const baseEvent = {
      channelId: 'chan1', messageId: 'msg1', guildId: 'g1',
      userId: 'u1', userName: 'alice', action: 'add',
      onOwnMessage: false, messageSnippet: 'hello', timestamp: new Date(1700000000000),
    };

    // Reserved unicode, reserved family variant, reserved custom id: all dropped.
    reactionHandler!({ ...baseEvent, emoji: RESERVED_UNICODE, emojiId: null, token: RESERVED_UNICODE });
    reactionHandler!({ ...baseEvent, emoji: `${RESERVED_FAMILY_BASE}\u{1F3FD}`, emojiId: null, token: RESERVED_FAMILY_BASE });
    reactionHandler!({ ...baseEvent, action: 'remove', emoji: ':sus:', emojiId: RESERVED_CUSTOM_ID, token: `<:sus:${RESERVED_CUSTOM_ID}>` });
    assert.equal(sent.length, 0, 'reserved reactions must produce no push event at all');

    // Harmless reaction passes through, with emoji in line and event id.
    reactionHandler!({ ...baseEvent, emoji: HARMLESS, emojiId: null, token: HARMLESS });
    assert.equal(sent.length, 1);
    const wire = JSON.stringify(sent);
    assert.ok(wire.includes(HARMLESS));
    // The leak-proof assertion: nothing reserved anywhere in anything sent.
    assert.ok(!wire.includes(RESERVED_UNICODE), 'no reserved glyph on the wire');
    assert.ok(!wire.includes(RESERVED_FAMILY_BASE), 'no family glyph on the wire');
    assert.ok(!wire.includes(RESERVED_CUSTOM_ID), 'no reserved custom id on the wire');
  });

  it('failed-closed policy drops every live reaction event', () => {
    writePolicy('{broken');
    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    let reactionHandler: ((ev: Record<string, unknown>) => void) | undefined;
    const noop = () => {};
    s.discord = {
      onMessage: noop, onMessageEdit: noop, onMessageDelete: noop,
      onChannelCreate: noop, onChannelDelete: noop, onGuildCreate: noop,
      onChannelAvailable: noop,
      onReaction: (h: (ev: Record<string, unknown>) => void) => { reactionHandler = h; },
    };
    const sent: unknown[] = [];
    s.conn = { sendRequest: (m: string, p: unknown) => { sent.push({ m, p }); return Promise.resolve({}); } };
    s.mcplEnabled = true;
    (s.enabledFeatureSets as Set<string>).add('discord.messaging');
    (s.reactionChannels as Set<string>).add('chan1');
    s.reactionChannelsLoaded = true;
    (s.setupDiscordForwarding as () => void).call(server);

    reactionHandler!({
      channelId: 'chan1', messageId: 'msg1', guildId: 'g1',
      userId: 'u1', userName: 'alice', action: 'add',
      onOwnMessage: false, messageSnippet: null, timestamp: new Date(1700000000000),
      emoji: HARMLESS, emojiId: null, token: HARMLESS,
    });
    assert.equal(sent.length, 0, 'fail closed means no reaction events at all');
  });
});
