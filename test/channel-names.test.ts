import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  channelLabel,
  isSnowflake,
  parseChannelRef,
  resolveChannelName,
  type ChannelCandidate,
} from '../src/channel-names.js';

const ch = (id: string, name: string, guildId: string, guildName: string): ChannelCandidate =>
  ({ id, name, guildId, guildName });

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

  it('offers qualified LABELS in the ambiguity error, not snowflakes', () => {
    // The whole point: the error must hand back usable addresses, or the agent
    // falls back to regenerating ids, which is the bug we are fixing.
    const r = resolveChannelName({ name: 'general' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.match(r.message, /#general \(Separatrix\)/);
    assert.match(r.message, /#general \(Anima Mundi\)/);
    assert.doesNotMatch(r.message, /\d{17,}/, 'must not fall back to raw ids');
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

  it('handles duplicate names within a single guild', () => {
    // Discord permits two channels with the same name in different categories.
    const dupe = ch('100000000000000004', 'general', 'g1', 'Separatrix');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, dupe]);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
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
