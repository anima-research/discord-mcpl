/**
 * Unit tests for forwarded-message rendering and reaction snippets
 * (pure helpers in discord-adapter.ts — no Discord connection).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildForwardedContent,
  buildReactionSnippet,
  resolveVisibleContent,
} from '../src/discord-adapter.js';

/** Minimal stand-in for a discord.js Message with forwarded snapshots. */
function fakeMessage(opts: {
  content?: string;
  cleanContent?: string | null;
  snapshots?: Array<{ content?: string | null; attachments?: { size: number } }>;
}) {
  const snaps = opts.snapshots ?? [];
  return {
    content: opts.content ?? '',
    cleanContent: opts.cleanContent,
    messageSnapshots: { size: snaps.length, values: () => snaps },
  };
}

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

  it('renders custom-emoji tokens in the forwarded body down to :name:', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'so true <:blobheart:12345>' }]),
      '[forwarded message] so true :blobheart:',
    );
  });
});

describe('resolveVisibleContent (shared by live + history paths)', () => {
  it('renders a bare forward from its snapshot — the history-path regression', () => {
    // fetchHistory/fetchAround build HistoryMessages through this helper; a
    // bare forward must not come back as an empty message on backscroll or
    // the reconnect catch-up sweep.
    const m = fakeMessage({ content: '', cleanContent: '', snapshots: [{ content: 'origin text' }] });
    assert.equal(resolveVisibleContent(m), '[forwarded message] origin text');
  });

  it('prefers cleanContent, falling back to raw content when empty', () => {
    assert.equal(
      resolveVisibleContent(fakeMessage({ content: '<@1> hi', cleanContent: '@ra hi' })),
      '@ra hi',
    );
    assert.equal(
      resolveVisibleContent(fakeMessage({ content: 'dm text', cleanContent: undefined })),
      'dm text',
    );
  });

  it('passes non-forward messages through untouched', () => {
    assert.equal(
      resolveVisibleContent(fakeMessage({ content: 'plain', cleanContent: 'plain' })),
      'plain',
    );
  });

  it('appends the forward below outer commentary', () => {
    const m = fakeMessage({
      content: 'check this',
      cleanContent: 'check this',
      snapshots: [{ content: 'forwarded body', attachments: { size: 1 } }],
    });
    assert.equal(
      resolveVisibleContent(m),
      'check this\n[forwarded message] forwarded body [1 attachment]',
    );
  });

  it('tolerates a missing messageSnapshots collection (older gateway shapes)', () => {
    assert.equal(
      resolveVisibleContent({ content: 'hi', cleanContent: 'hi' }),
      'hi',
    );
  });
});
