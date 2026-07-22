/**
 * Unit tests for forwarded-message rendering and reaction snippets
 * (pure helpers in discord-adapter.ts — no Discord connection).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildForwardedContent, buildReactionSnippet } from '../src/discord-adapter.js';

describe('buildReactionSnippet', () => {
  it('returns null for empty / missing / whitespace-only text', () => {
    assert.equal(buildReactionSnippet(null), null);
    assert.equal(buildReactionSnippet(undefined), null);
    assert.equal(buildReactionSnippet(''), null);
    assert.equal(buildReactionSnippet('   \n\t '), null);
  });

  it('passes short text through, trimmed', () => {
    assert.equal(buildReactionSnippet('  hello world  '), 'hello world');
  });

  it('collapses internal whitespace and newlines to single spaces', () => {
    assert.equal(
      buildReactionSnippet('first line\nsecond   line\n\nthird'),
      'first line second line third',
    );
  });

  it('caps long text at 80 chars with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const snippet = buildReactionSnippet(long);
    assert.ok(snippet);
    assert.equal(snippet.length, 80);
    assert.ok(snippet.endsWith('…'));
    assert.equal(snippet, 'a'.repeat(79) + '…');
  });

  it('renders custom-emoji tokens down to :name:', () => {
    assert.equal(
      buildReactionSnippet('nice <:blobheart:12345> work'),
      'nice :blobheart: work',
    );
  });
});

describe('buildForwardedContent', () => {
  it('returns the base content untouched when there are no snapshots', () => {
    assert.equal(buildForwardedContent('hi', []), 'hi');
    assert.equal(buildForwardedContent('', []), '');
  });

  it('renders a bare forward (no outer content) from its snapshot', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'the original text' }]),
      '[forwarded message] the original text',
    );
  });

  it('appends the forward below outer content when both exist', () => {
    assert.equal(
      buildForwardedContent('look at this:', [{ content: 'original' }]),
      'look at this:\n[forwarded message] original',
    );
  });

  it('notes attachments on an attachment-only forward', () => {
    assert.equal(
      buildForwardedContent('', [{ content: '', attachments: { size: 2 } }]),
      '[forwarded message] [2 attachments]',
    );
    assert.equal(
      buildForwardedContent('', [{ content: null, attachments: { size: 1 } }]),
      '[forwarded message] [1 attachment]',
    );
  });

  it('notes an embed-only forward instead of rendering silence', () => {
    assert.equal(
      buildForwardedContent('', [{ content: '', embeds: { length: 1 } }]),
      '[forwarded message] [embed]',
    );
  });

  it('keeps text AND attachment note when a forward has both', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'caption', attachments: { size: 1 } }]),
      '[forwarded message] caption [1 attachment]',
    );
  });

  it('falls back to an explicit no-content marker', () => {
    assert.equal(
      buildForwardedContent('', [{ content: '' }]),
      '[forwarded message] [no text content]',
    );
  });

  it('renders multiple snapshots one per line', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'one' }, { content: 'two' }]),
      '[forwarded message] one\n[forwarded message] two',
    );
  });
});
