import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildCandidates,
  channelLabel,
  isSnowflake,
  parseChannelRef,
  resolveChannelName,
  type ChannelCandidate,
  type GuildLike,
} from '../src/channel-names.js';

const ch = (
  id: string, name: string, guildId: string, guildName: string,
  type: ChannelCandidate['type'] = 'text',
): ChannelCandidate => ({ id, name, guildId, guildName, type });

// Two guilds that both have #general — the case this feature exists for.
const SEPARATRIX_GENERAL = ch('100000000000000001', 'general', 'g1', 'Separatrix');
const ANIMA_GENERAL = ch('100000000000000002', 'general', 'g2', 'Anima Mundi');
const KITCHEN = ch('100000000000000003', 'kitchen-table', 'g1', 'Separatrix');
const CANDIDATES = [SEPARATRIX_GENERAL, ANIMA_GENERAL, KITCHEN];

describe('isSnowflake', () => {
  it('accepts 17-20 digit ids', () => {
    assert.ok(isSnowflake('12345678901234567'));
    assert.ok(isSnowflake('12345678901234567890'));
  });
  it('rejects names, short numbers, and mixed strings', () => {
    for (const v of ['general', '#general', '123', '1234567890123456789a', '']) {
      assert.ok(!isSnowflake(v), v);
    }
  });
});

describe('parseChannelRef', () => {
  it('passes raw snowflakes through unchanged', () => {
    assert.deepEqual(parseChannelRef('100000000000000001'),
      { kind: 'id', id: '100000000000000001' });
  });

  it('passes the existing MCPL composite through, extracting the channel id', () => {
    assert.deepEqual(
      parseChannelRef('discord:200000000000000000:100000000000000001'),
      { kind: 'id', id: '100000000000000001' });
  });

  it('accepts a composite whose ids are not snowflake-shaped', () => {
    // parseMcplChannelId (channels.ts) checks only parts[0] === 'discord'.
    // Being stricter here would reject composites the rest of the codebase
    // accepts -- which is exactly what the test fixtures use.
    assert.deepEqual(parseChannelRef('discord:g1:c1'), { kind: 'id', id: 'c1' });
  });

  it('accepts a bare name with or without the hash', () => {
    assert.deepEqual(parseChannelRef('#general'), { kind: 'name', name: 'general' });
    assert.deepEqual(parseChannelRef('general'), { kind: 'name', name: 'general' });
  });

  it('accepts the label form the system already prints', () => {
    // toDescriptor emits exactly this shape: `#${name} (${guildName})`
    assert.deepEqual(parseChannelRef('#general (Separatrix)'),
      { kind: 'name', name: 'general', guild: 'Separatrix' });
    assert.deepEqual(parseChannelRef('general (Anima Mundi)'),
      { kind: 'name', name: 'general', guild: 'Anima Mundi' });
  });

  it('handles guild names containing punctuation and spaces', () => {
    assert.deepEqual(parseChannelRef("#general (Jai's Lab — v2)"),
      { kind: 'name', name: 'general', guild: "Jai's Lab — v2" });
  });

  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseChannelRef('  #kitchen-table (Separatrix)  '),
      { kind: 'name', name: 'kitchen-table', guild: 'Separatrix' });
  });

  it('returns null for empty-ish input', () => {
    for (const v of ['', '   ', '#', '  #  ']) assert.equal(parseChannelRef(v), null, JSON.stringify(v));
  });
});

describe('resolveChannelName', () => {
  it('resolves an unambiguous bare name', () => {
    const r = resolveChannelName({ name: 'kitchen-table' }, CANDIDATES);
    assert.ok(r.ok);
    assert.equal(r.id, KITCHEN.id);
  });

  it('is case-insensitive on both channel and guild', () => {
    const r = resolveChannelName({ name: 'KITCHEN-TABLE', guild: 'sEpArAtRiX' }, CANDIDATES);
    assert.ok(r.ok);
    assert.equal(r.id, KITCHEN.id);
  });

  it('HARD-ERRORS on a cross-guild collision rather than picking one', () => {
    const r = resolveChannelName({ name: 'general' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
  });

  it('offers qualified labels when labels alone disambiguate', () => {
    // Cross-guild: the labels differ, so they are sufficient and the message
    // stays short. (Earlier this test also asserted the message contained NO
    // ids at all. That was wrong -- it encoded "ids are shameful" as an
    // invariant, when the problem was ids being the ONLY form. It also would
    // have blocked the fix below.)
    const r = resolveChannelName({ name: 'general' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.match(r.message, /#general \(Separatrix\)/);
    assert.match(r.message, /#general \(Anima Mundi\)/);
  });

  it('resolves a collision when the guild is supplied', () => {
    const a = resolveChannelName({ name: 'general', guild: 'Separatrix' }, CANDIDATES);
    assert.ok(a.ok);
    assert.equal(a.id, SEPARATRIX_GENERAL.id);
    const b = resolveChannelName({ name: 'general', guild: 'Anima Mundi' }, CANDIDATES);
    assert.ok(b.ok);
    assert.equal(b.id, ANIMA_GENERAL.id);
  });

  it('distinguishes wrong-guild from no-such-channel', () => {
    const r = resolveChannelName({ name: 'general', guild: 'Nowhere' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'not-found');
    assert.match(r.message, /exists elsewhere/);
    assert.match(r.message, /Separatrix/);
  });

  it('reports not-found for an unknown name', () => {
    const r = resolveChannelName({ name: 'no-such-room' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'not-found');
  });

  it('does no fuzzy matching', () => {
    // "kitchen-tables" and "kitchentable" must NOT reach kitchen-table. A
    // did-you-mean would reintroduce silent wrong-room delivery.
    for (const name of ['kitchen-tables', 'kitchentable', 'kitchen table', 'gener']) {
      const r = resolveChannelName({ name }, CANDIDATES);
      assert.ok(!r.ok, name);
      assert.equal(r.reason, 'not-found', name);
    }
  });

  it('treats an allowlist-filtered set as the whole world', () => {
    // Caller filters first. With the Anima copy removed, the bare name is no
    // longer ambiguous -- and a forbidden channel cannot manufacture a
    // spurious collision with a permitted one.
    const permitted = [SEPARATRIX_GENERAL, KITCHEN];
    const r = resolveChannelName({ name: 'general' }, permitted);
    assert.ok(r.ok);
    assert.equal(r.id, SEPARATRIX_GENERAL.id);
  });

  it('handles duplicate names within a single guild -- ACTIONABLY', () => {
    // Discord permits two same-named channels in different categories. The
    // earlier version of this test asserted only reason === 'ambiguous', which
    // passed while the message was a DEAD END: both suggestions rendered
    // identically, so re-sending either returned the same error and the agent
    // had no way forward but a regenerated snowflake. Classification is not
    // usefulness; assert the suggestions can actually be told apart.
    const dupe = ch('100000000000000004', 'general', 'g1', 'Separatrix');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, dupe]);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
    assert.match(r.message, /100000000000000001/);
    assert.match(r.message, /100000000000000004/);
  });

  it('TIE-BREAKS text over voice -- the stock-Discord collision', () => {
    // Nearly every server ships a VOICE channel named "General" beside text
    // #general, and matching is case-insensitive, so this is the DEFAULT state
    // of an ordinary server -- not an edge case. Without the tie-break the most
    // common configuration on Discord is unaddressable by name.
    const voice = ch('100000000000000005', 'General', 'g1', 'Separatrix', 'voice');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, voice]);
    assert.ok(r.ok, 'text should win over voice');
    assert.equal(r.id, SEPARATRIX_GENERAL.id);
  });

  it('does NOT tie-break when two sendable text channels collide', () => {
    // The tie-break resolves type ambiguity only. Two text channels are a real
    // ambiguity and must still hard-error -- with ids, since labels match.
    const dupe = ch('100000000000000006', 'general', 'g1', 'Separatrix', 'text');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, dupe]);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
    assert.match(r.message, /id 1000000000000000/);
  });

  it('ambiguity message marks the type when labels collide', () => {
    const voice1 = ch('100000000000000007', 'lounge', 'g1', 'Separatrix', 'voice');
    const voice2 = ch('100000000000000008', 'lounge', 'g1', 'Separatrix', 'voice');
    const r = resolveChannelName({ name: 'lounge' }, [voice1, voice2]);
    assert.ok(!r.ok);
    assert.match(r.message, /\[voice\]/);
  });
});

describe('channelLabel', () => {
  it('round-trips through parseChannelRef', () => {
    // The invariant the whole design rests on: what we print is what we accept.
    for (const c of CANDIDATES) {
      const parsed = parseChannelRef(channelLabel(c));
      assert.deepEqual(parsed, { kind: 'name', name: c.name, guild: c.guildName });
      const r = resolveChannelName({ name: c.name, guild: c.guildName }, CANDIDATES);
      assert.ok(r.ok, channelLabel(c));
      assert.equal(r.id, c.id);
    }
  });
});


// ── buildCandidates: the filter that decides what is addressable at all ──────
// Previously untested, which the review correctly called out as coverage
// inverted relative to risk: the pure matcher is the part least likely to
// break, while THIS is where the allowlist is enforced.

const TYPES: Record<number, string> = {
  0: 'text', 2: 'voice', 4: 'category', 11: 'thread', 12: 'thread',
  13: 'unknown', 15: 'forum', 16: 'unknown',
};
const mapType = (t: number | undefined) => TYPES[t ?? -1] ?? 'unknown';
const chan = (id: string, name: string, type: number, parentId: string | null = null) =>
  ({ id, name, type, parentId });
const guild = (id: string, name: string, channels: ReturnType<typeof chan>[]): GuildLike =>
  ({ id, name, channels });
const allowAll = () => true;

describe('buildCandidates', () => {
  it('keeps only sendable kinds', () => {
    const g = guild('g1', 'Separatrix', [
      chan('1', 'text-room', 0), chan('2', 'voice-room', 2),
      chan('3', 'a-category', 4), chan('4', 'a-thread', 11),
      chan('5', 'a-forum', 15), chan('6', 'a-stage', 13), chan('7', 'media', 16),
    ]);
    const got = buildCandidates([g], { mapType, allowed: allowAll });
    assert.deepEqual(got.map((c) => c.name).sort(), ['text-room', 'voice-room']);
    // Forums 400 on a bare send; stage/media land in 'unknown'. All still
    // reachable by id -- excluded from NAME addressing only.
  });

  it('carries the type through, so the tie-break has something to work with', () => {
    const g = guild('g1', 'S', [chan('1', 'general', 0), chan('2', 'General', 2)]);
    const got = buildCandidates([g], { mapType, allowed: allowAll });
    assert.deepEqual(got.map((c) => c.type).sort(), ['text', 'voice']);
  });

  it('APPLIES THE ALLOWLIST -- an excluded channel is not addressable by name', () => {
    const g = guild('g1', 'S', [chan('1', 'public', 0), chan('2', 'secret', 0)]);
    const got = buildCandidates([g], {
      mapType, allowed: (_gid, cid) => cid !== '2',
    });
    assert.deepEqual(got.map((c) => c.name), ['public']);
    const r = resolveChannelName({ name: 'secret' }, got);
    assert.ok(!r.ok, 'an excluded channel must not resolve by name');
  });

  it('an excluded channel cannot manufacture a spurious collision', () => {
    // Two #general, one forbidden. The permitted one must resolve cleanly
    // rather than being blocked by a collision with a channel the caller is
    // not allowed to reach -- which is why filtering precedes matching.
    const g = guild('g1', 'S', [chan('1', 'general', 0), chan('2', 'general', 0)]);
    const got = buildCandidates([g], { mapType, allowed: (_g, cid) => cid === '1' });
    const r = resolveChannelName({ name: 'general' }, got);
    assert.ok(r.ok);
    assert.equal(r.id, '1');
  });

  it('honours the guild allowlist', () => {
    const gs = [guild('g1', 'A', [chan('1', 'x', 0)]), guild('g2', 'B', [chan('2', 'x', 0)])];
    const all = buildCandidates(gs, { mapType, allowed: allowAll });
    assert.equal(all.length, 2);
    const one = buildCandidates(gs, { mapType, allowed: allowAll, guildIds: ['g2'] });
    assert.deepEqual(one.map((c) => c.guildName), ['B']);
  });

  it('spans guilds and survives null channel entries', () => {
    const gs: GuildLike[] = [
      { id: 'g1', name: 'A', channels: [chan('1', 'x', 0), null] },
      guild('g2', 'B', [chan('2', 'y', 0)]),
    ];
    assert.equal(buildCandidates(gs, { mapType, allowed: allowAll }).length, 2);
  });
});
