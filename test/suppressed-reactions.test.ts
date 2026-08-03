/**
 * Unit tests for reaction-emoji suppression (DISCORD_SUPPRESS_REACTION_EMOJIS)
 * — pure helpers in filters.ts. Motivation: host refusal-marker reactions
 * (☣️ 🧪 ☢️ 💻 🧠 🛑) must not re-enter agent context (classifier feedback
 * loop, Mythos 2026-08-03).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  normalizeReactionEmoji,
  parseSuppressedReactionEmojis,
  isSuppressedReactionEmoji,
  filterSuppressedReactions,
} from '../src/filters.js';

describe('normalizeReactionEmoji', () => {
  it('strips VS-16 so keycap/pictographic variants compare equal', () => {
    assert.equal(normalizeReactionEmoji('☣️'), '☣'); // ☣️ → ☣
    assert.equal(normalizeReactionEmoji('☣'), '☣');
  });
  it('strips surrounding colons of custom-emoji names', () => {
    assert.equal(normalizeReactionEmoji(':sigil:'), 'sigil');
    assert.equal(normalizeReactionEmoji('sigil'), 'sigil');
  });
  it('leaves plain pictographic emoji untouched', () => {
    assert.equal(normalizeReactionEmoji('💻'), '💻');
  });
});

describe('parseSuppressedReactionEmojis', () => {
  it('returns null for unset/empty (feature off)', () => {
    assert.equal(parseSuppressedReactionEmojis(undefined), null);
    assert.equal(parseSuppressedReactionEmojis(''), null);
    assert.equal(parseSuppressedReactionEmojis(' , ,'), null);
  });
  it('parses a comma-separated list, normalized', () => {
    const s = parseSuppressedReactionEmojis('☣️, 💻 ,:sigil:');
    assert.ok(s);
    assert.equal(s.size, 3);
    assert.ok(s.has('☣'));
    assert.ok(s.has('💻'));
    assert.ok(s.has('sigil'));
  });
});

describe('isSuppressedReactionEmoji', () => {
  const suppressed = parseSuppressedReactionEmojis('☣️,🧪,☢️,💻,🧠,🛑');
  it('matches across VS-16 presence in either direction', () => {
    assert.ok(isSuppressedReactionEmoji('☣', suppressed)); // bare ☣
    assert.ok(isSuppressedReactionEmoji('☣️', suppressed)); // ☣️
    assert.ok(isSuppressedReactionEmoji('💻', suppressed));
  });
  it('does not match unlisted emoji', () => {
    assert.ok(!isSuppressedReactionEmoji('💜', suppressed));
    assert.ok(!isSuppressedReactionEmoji('✨', suppressed));
  });
  it('never matches when the feature is off', () => {
    assert.ok(!isSuppressedReactionEmoji('💻', null));
  });
});

describe('filterSuppressedReactions', () => {
  const suppressed = parseSuppressedReactionEmojis('💻,🧠');
  const rx = (emoji: string, count = 1) => ({ emoji, emojiId: null, token: emoji, count, me: false });
  it('strips suppressed emojis from history summaries', () => {
    const out = filterSuppressedReactions([rx('💻'), rx('💜', 3), rx('🧠')], suppressed);
    assert.deepEqual(out.map((r) => r.emoji), ['💜']);
  });
  it('passes everything through when the feature is off', () => {
    const list = [rx('💻'), rx('💜')];
    assert.equal(filterSuppressedReactions(list, null), list);
  });
  it('handles undefined/empty input', () => {
    assert.deepEqual(filterSuppressedReactions(undefined, suppressed), []);
    assert.deepEqual(filterSuppressedReactions([], suppressed), []);
  });
});
