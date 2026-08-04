/**
 * Tests for reaction suppression on the DiscordFilters plane (issue #21,
 * folded per PR #13's architecture review).
 *
 * The invariant: a suppressed reaction leaves no glyph, name, or token in
 * any model-visible output — event text, event ids, history snapshots,
 * status, warnings, logs — while raw Discord state is untouched. The policy
 * source is the filters file's suppressedReactionEmojis key; the deprecated
 * DISCORD_SUPPRESS_REACTION_EMOJIS env survives as a compat source for
 * files that don't carry the key. Failure posture: stale LKG when a usable
 * set predates a broken rewrite; withhold-everything when a configured
 * plane was never readable (or its only prior state was empty).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ReactionSuppression,
  resolveStartupFilters,
  normalizeFilters,
  loadFiltersFile,
  parseSuppressionEnvTokens,
  type DiscordFilters,
} from '../src/filters.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter, ReactionSummary } from '../src/discord-adapter.js';

const SUPPRESSED_UNICODE = '🛑';
const SUPPRESSED_VARIANT = '☣️'; // VS-16 form; bare '☣' must match too
const SUPPRESSED_BARE = '☣';
const SUPPRESSED_CUSTOM_ID = '111222333444555666';
const ENV_ONLY_GLYPH = '🧪';
const HARMLESS = '😀';

const FILE_TOKENS = [SUPPRESSED_UNICODE, SUPPRESSED_VARIANT, `:sigil:`, SUPPRESSED_CUSTOM_ID];

function withKey(tokens: string[] = FILE_TOKENS): DiscordFilters {
  return { guildIds: ['999888777666555444'], suppressedReactionEmojis: tokens };
}

function summary(emoji: string, emojiId: string | null = null): ReactionSummary {
  return { emoji, emojiId, token: emojiId ? `<:x:${emojiId}>` : emoji, count: 2, me: false };
}

/** Capture console.error lines for glyph-leak assertions. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, restore: () => (console.error = orig) };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reaction-suppression-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DISCORD_FILTERS_FILE;
  delete process.env.DISCORD_SUPPRESS_REACTION_EMOJIS;
});

describe('ReactionSuppression state machine', () => {
  it('not-configured: no key, no env — honest status, nothing suppressed', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.applyFilters({});
    const st = rs.status();
    assert.equal(st.status, 'not-configured');
    assert.equal(st.protectionActive, false);
    assert.equal(st.source, 'none');
    assert.equal(st.effectiveDigest, null);
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false);
    assert.equal(rs.suppressAll(), false);
  });

  it('file key active: matches VS-16 variants, colon-stripped names, and custom ids', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.applyFilters(withKey());
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true);
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_BARE }), true, 'bare form of a VS-16 entry matches');
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_VARIANT }), true);
    assert.equal(rs.isSuppressed({ emoji: 'sigil' }), true, 'colon-configured name matches bare');
    assert.equal(rs.isSuppressed({ emoji: ':whatever:', emojiId: SUPPRESSED_CUSTOM_ID }), true, 'snowflake entry matches by id');
    assert.equal(rs.isSuppressed({ emoji: HARMLESS }), false);
    const st = rs.status();
    assert.equal(st.status, 'active');
    assert.equal(st.protectionActive, true);
    assert.equal(st.source, 'file');
    assert.match(st.effectiveDigest!, /^sha256:[0-9a-f]{64}$/, 'full machine digest, not a shortened one');
    assert.ok(st.loadedAt, 'load state is reported');
  });

  it('configured-empty is distinct from not-configured and from active', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.applyFilters({ suppressedReactionEmojis: [] });
    const st = rs.status();
    assert.equal(st.status, 'configured-empty');
    assert.equal(st.protectionActive, false);
    assert.equal(st.source, 'file');
    assert.equal(st.effectiveDigest, null);
  });

  it('file precedence: key present means env is ignored, never unioned', () => {
    const cap = captureStderr();
    try {
      const rs = new ReactionSuppression(() => ENV_ONLY_GLYPH);
      rs.applyFilters(withKey());
      assert.equal(rs.isSuppressed({ emoji: ENV_ONLY_GLYPH }), false, 'env entry must NOT be unioned in');
      assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true);
      const st = rs.status();
      assert.equal(st.source, 'file');
      assert.equal(st.legacyEnvIgnored, true);
      const warnings = cap.lines.filter((l) => l.includes('IGNORED'));
      assert.equal(warnings.length, 1, 'ignored-env warning fires once');
      assert.ok(!warnings[0].includes(ENV_ONLY_GLYPH), 'warning is glyph-free');
      rs.status(); // repeated status must not re-warn
      assert.equal(cap.lines.filter((l) => l.includes('IGNORED')).length, 1);
    } finally {
      cap.restore();
    }
  });

  it('legacy env source: emergency-filter semantics, live env edits, deprecated status', () => {
    let env: string | undefined = `${ENV_ONLY_GLYPH}, ${SUPPRESSED_CUSTOM_ID}`;
    const rs = new ReactionSuppression(() => env);
    rs.applyFilters({ guildIds: ['999888777666555444'] }); // file exists, no key
    assert.equal(rs.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    assert.equal(rs.isSuppressed({ emoji: ':x:', emojiId: SUPPRESSED_CUSTOM_ID }), true, 'numeric token matches by id');
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_CUSTOM_ID }), true, 'numeric token keeps its literal match');
    const st = rs.status();
    assert.equal(st.status, 'active');
    assert.equal(st.source, 'legacy-env');
    assert.equal(st.deprecated, true);
    assert.equal(st.protectionActive, true);

    env = undefined; // env unset live — read per decision, no restart needed
    assert.equal(rs.isSuppressed({ emoji: ENV_ONLY_GLYPH }), false);
    assert.equal(rs.status().status, 'not-configured');
  });

  it('key deletion falls back to env (compat), or to off', () => {
    const rs = new ReactionSuppression(() => ENV_ONLY_GLYPH);
    rs.applyFilters(withKey());
    assert.equal(rs.isSuppressed({ emoji: ENV_ONLY_GLYPH }), false);
    rs.applyFilters({ guildIds: ['999888777666555444'] }); // operator removed the key
    assert.equal(rs.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true, 'env resumes when the key is gone');
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, 'file entries no longer enforced');
    assert.equal(rs.status().source, 'legacy-env');

    const rsOff = new ReactionSuppression(() => undefined);
    rsOff.applyFilters(withKey());
    rsOff.applyFilters({});
    assert.equal(rsOff.status().status, 'not-configured');
    assert.equal(rsOff.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false);
  });

  it('malformed rewrite after a good load: stale, protection stays active on the LKG set', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.applyFilters(withKey());
    const activeDigest = rs.status().effectiveDigest;
    rs.markUnavailable('unparseable on reload');
    assert.equal(rs.suppressAll(), false, 'a usable LKG must not escalate to withhold-everything');
    assert.equal(rs.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true, 'LKG still enforced');
    assert.equal(rs.isSuppressed({ emoji: HARMLESS }), false);
    const st = rs.status();
    assert.equal(st.status, 'stale');
    assert.equal(st.protectionActive, true, 'stale must not hide an active LKG');
    assert.equal(st.effectiveDigest, activeDigest);
    assert.ok(st.effectiveCount > 0);
    assert.equal(st.desiredState, 'invalid');
    assert.ok(st.staleSince);
  });

  it('malformed initial (never loaded): unavailable, everything withheld', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.markUnavailable('unparseable at startup');
    assert.equal(rs.suppressAll(), true);
    assert.equal(rs.isSuppressed({ emoji: HARMLESS }), false, 'isSuppressed is per-entry; the posture is suppressAll');
    const proj = rs.project([summary(HARMLESS)]);
    assert.deepEqual(proj.reactions, []);
    assert.equal(proj.unavailable, true, 'empty must not read as "none"');
    const st = rs.status();
    assert.equal(st.status, 'unavailable');
    assert.equal(st.protectionActive, true);
    assert.equal(st.suppressingAllReactions, true);
    assert.equal(st.desiredState, 'invalid');
  });

  it('configured-empty then malformed rewrite fails closed, not open', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.applyFilters({ suppressedReactionEmojis: [] });
    rs.markUnavailable('unparseable on reload');
    assert.equal(rs.suppressAll(), true, 'an empty LKG is not a fallback — this is the typo-in-first-real-entries case');
    assert.equal(rs.status().status, 'unavailable');
  });

  it('known key-absence + broken file: live sources continue, desiredState reported', () => {
    const rsEnv = new ReactionSuppression(() => ENV_ONLY_GLYPH);
    rsEnv.applyFilters({ guildIds: ['999888777666555444'] });
    rsEnv.markUnavailable('unparseable on reload');
    assert.equal(rsEnv.suppressAll(), false, 'file never carried suppression; env is live and unaffected');
    assert.equal(rsEnv.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    const stEnv = rsEnv.status();
    assert.equal(stEnv.source, 'legacy-env');
    assert.equal(stEnv.desiredState, 'invalid');

    const rsOff = new ReactionSuppression(() => undefined);
    rsOff.applyFilters({});
    rsOff.markUnavailable('unparseable on reload');
    assert.equal(rsOff.suppressAll(), false, 'known absence of any suppression must not blank reactions');
    const stOff = rsOff.status();
    assert.equal(stOff.status, 'not-configured');
    assert.equal(stOff.desiredState, 'invalid');
  });

  it('recovery: a good reload clears the failure posture', () => {
    const rs = new ReactionSuppression(() => undefined);
    rs.markUnavailable('unparseable at startup');
    assert.equal(rs.suppressAll(), true);
    rs.applyFilters(withKey());
    assert.equal(rs.suppressAll(), false);
    const st = rs.status();
    assert.equal(st.status, 'active');
    assert.equal(st.desiredState, undefined);
  });

  it('status and warnings never contain a configured glyph or id', () => {
    const cap = captureStderr();
    try {
      const rs = new ReactionSuppression(() => ENV_ONLY_GLYPH);
      rs.applyFilters(withKey());
      rs.markUnavailable('unparseable on reload');
      for (const blob of [JSON.stringify(rs.status()), cap.lines.join('\n')]) {
        for (const secret of [SUPPRESSED_UNICODE, SUPPRESSED_BARE, 'sigil', SUPPRESSED_CUSTOM_ID, ENV_ONLY_GLYPH]) {
          assert.ok(!blob.includes(secret), `no configured value in status/logs (found ${secret.length}-char entry)`);
        }
      }
    } finally {
      cap.restore();
    }
  });

  it('normalizeFilters dedupes suppression variants and preserves an explicit empty list', () => {
    const n = normalizeFilters({
      suppressedReactionEmojis: [SUPPRESSED_VARIANT, SUPPRESSED_BARE, ':sigil:', 'sigil', '  '],
    });
    assert.equal(n.suppressedReactionEmojis!.length, 2, 'VS-16 variants and colon forms collapse');
    const empty = normalizeFilters({ suppressedReactionEmojis: [] });
    assert.deepEqual(empty.suppressedReactionEmojis, [], 'explicit empty is preserved, not collapsed to unset');
    const unset = normalizeFilters({});
    assert.equal(unset.suppressedReactionEmojis, undefined);
  });

  it('parseSuppressionEnvTokens: unset/empty/separator-only stay honestly off', () => {
    assert.deepEqual(parseSuppressionEnvTokens(undefined), []);
    assert.deepEqual(parseSuppressionEnvTokens(''), []);
    assert.deepEqual(parseSuppressionEnvTokens(' , ,, '), []);
    assert.deepEqual(parseSuppressionEnvTokens(`${HARMLESS}, x`), [HARMLESS, 'x']);
  });
});

describe('startup resolution (resolveStartupFilters)', () => {
  it('absent file: seeds whitelists AND the suppression key from the emergency env', () => {
    const path = join(dir, 'filters.json');
    const cap = captureStderr();
    try {
      const { filters, fileBroken } = resolveStartupFilters(path, {
        DISCORD_GUILD_ID: '999888777666555444',
        DISCORD_SUPPRESS_REACTION_EMOJIS: `${SUPPRESSED_UNICODE},${SUPPRESSED_CUSTOM_ID}`,
      } as NodeJS.ProcessEnv);
      assert.equal(fileBroken, false);
      assert.deepEqual(filters.suppressedReactionEmojis, [SUPPRESSED_UNICODE, SUPPRESSED_CUSTOM_ID]);
      const onDisk = loadFiltersFile(path)!;
      assert.deepEqual(onDisk.suppressedReactionEmojis, [SUPPRESSED_UNICODE, SUPPRESSED_CUSTOM_ID]);
      assert.ok(!cap.lines.join('\n').includes(SUPPRESSED_UNICODE), 'seed log is glyph-free');
    } finally {
      cap.restore();
    }
  });

  it('absent file + no suppression env: seeds without the key', () => {
    const path = join(dir, 'filters.json');
    const cap = captureStderr();
    try {
      const { filters } = resolveStartupFilters(path, {
        DISCORD_GUILD_ID: '999888777666555444',
      } as NodeJS.ProcessEnv);
      assert.equal(filters.suppressedReactionEmojis, undefined);
      assert.equal(loadFiltersFile(path)!.suppressedReactionEmojis, undefined);
    } finally {
      cap.restore();
    }
  });

  it('existing file without the key is NOT rewritten; env stays the live compat source', () => {
    const path = join(dir, 'filters.json');
    writeFileSync(path, JSON.stringify({ guildIds: ['999888777666555444'] }));
    const before = readFileSync(path, 'utf8');
    const mtimeBefore = statSync(path).mtimeMs;
    const cap = captureStderr();
    try {
      const { filters, fileBroken } = resolveStartupFilters(path, {
        DISCORD_SUPPRESS_REACTION_EMOJIS: ENV_ONLY_GLYPH,
      } as NodeJS.ProcessEnv);
      assert.equal(fileBroken, false);
      assert.equal(filters.suppressedReactionEmojis, undefined, 'no surprise key injection');
      assert.equal(readFileSync(path, 'utf8'), before, 'file bytes untouched');
      assert.equal(statSync(path).mtimeMs, mtimeBefore, 'file not rewritten');
      // The class then keeps the env live for exactly this shape:
      const rs = new ReactionSuppression(() => ENV_ONLY_GLYPH);
      rs.applyFilters(filters);
      assert.equal(rs.status().source, 'legacy-env');
      assert.equal(rs.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    } finally {
      cap.restore();
    }
  });

  it('existing malformed file: untouched, reported broken, env whitelists in force', () => {
    const path = join(dir, 'filters.json');
    writeFileSync(path, '{broken');
    const cap = captureStderr();
    try {
      const { filters, fileBroken } = resolveStartupFilters(path, {
        DISCORD_GUILD_ID: '999888777666555444',
        DISCORD_SUPPRESS_REACTION_EMOJIS: SUPPRESSED_UNICODE,
      } as NodeJS.ProcessEnv);
      assert.equal(fileBroken, true);
      assert.equal(readFileSync(path, 'utf8'), '{broken', 'malformed file is never overwritten');
      assert.deepEqual(filters.guildIds, ['999888777666555444']);
      assert.equal(filters.suppressedReactionEmojis, undefined, 'no key claimed without a readable file');
    } finally {
      cap.restore();
    }
  });
});

describe('server integration', () => {
  function makeServer(): DiscordMcplServer {
    return new DiscordMcplServer({} as DiscordAdapter);
  }

  it('projects suppressed reactions out of history messages', () => {
    const server = makeServer();
    server.reactionSuppression.applyFilters(withKey());
    const s = server as unknown as {
      projectHistoryReactions(msgs: Array<{ id: string; reactions?: ReactionSummary[] }>): Array<{
        id: string;
        reactions?: ReactionSummary[];
        reactionsUnavailable?: true;
      }>;
    };
    const out = s.projectHistoryReactions([
      { id: 'm1', reactions: [summary(SUPPRESSED_UNICODE), summary(HARMLESS), summary(':x:', SUPPRESSED_CUSTOM_ID)] },
      { id: 'm2' },
    ]);
    assert.deepEqual(out[0].reactions?.map((r) => r.emoji), [HARMLESS]);
    assert.equal(out[0].reactionsUnavailable, undefined);
    assert.equal(out[1].reactions?.length ?? 0, 0);
    assert.ok(!JSON.stringify(out).includes(SUPPRESSED_UNICODE), 'no glyph anywhere in projected output');
  });

  it('withhold-everything posture blanks history reactions with an unavailable marker', () => {
    const server = makeServer();
    server.reactionSuppression.markUnavailable('unparseable at startup');
    const s = server as unknown as {
      projectHistoryReactions(msgs: Array<{ id: string; reactions?: ReactionSummary[] }>): Array<{
        reactions?: ReactionSummary[];
        reactionsUnavailable?: true;
      }>;
    };
    const out = s.projectHistoryReactions([{ id: 'm1', reactions: [summary(HARMLESS)] }]);
    assert.deepEqual(out[0].reactions, []);
    assert.equal(out[0].reactionsUnavailable, true, 'empty must not read as "none"');
  });

  function wireReactionHandler(server: DiscordMcplServer): {
    handler: (ev: Record<string, unknown>) => void;
    sent: unknown[];
  } {
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
    s.conn = { sendRequest: (method: string, params: unknown) => { sent.push({ method, params }); return Promise.resolve({}); } };
    s.mcplEnabled = true;
    (s.enabledFeatureSets as Set<string>).add('discord.messaging');
    (s.reactionChannels as Set<string>).add('chan1');
    s.reactionChannelsLoaded = true;
    (s.setupDiscordForwarding as () => void).call(server);
    assert.ok(reactionHandler, 'reaction handler registered');
    return { handler: reactionHandler!, sent };
  }

  const baseEvent = {
    channelId: 'chan1', messageId: 'msg1', guildId: 'g1',
    userId: 'u1', userName: 'alice', action: 'add',
    onOwnMessage: false, messageSnippet: 'hello', timestamp: new Date(1700000000000),
  };

  it('drops suppressed live reaction add AND remove before text or event id exists', () => {
    const server = makeServer();
    server.reactionSuppression.applyFilters(withKey());
    const { handler, sent } = wireReactionHandler(server);

    handler({ ...baseEvent, emoji: SUPPRESSED_UNICODE, emojiId: null, token: SUPPRESSED_UNICODE });
    handler({ ...baseEvent, emoji: SUPPRESSED_BARE, emojiId: null, token: SUPPRESSED_BARE });
    handler({ ...baseEvent, action: 'remove', emoji: ':sus:', emojiId: SUPPRESSED_CUSTOM_ID, token: `<:sus:${SUPPRESSED_CUSTOM_ID}>` });
    assert.equal(sent.length, 0, 'suppressed reactions must produce no push event at all');

    handler({ ...baseEvent, emoji: HARMLESS, emojiId: null, token: HARMLESS });
    assert.equal(sent.length, 1);
    const wire = JSON.stringify(sent);
    assert.ok(wire.includes(HARMLESS));
    assert.ok(!wire.includes(SUPPRESSED_UNICODE), 'no suppressed glyph on the wire');
    assert.ok(!wire.includes(SUPPRESSED_BARE), 'no bare-variant glyph on the wire');
    assert.ok(!wire.includes(SUPPRESSED_CUSTOM_ID), 'no suppressed custom id on the wire');
  });

  it('withhold-everything posture drops every live reaction event', () => {
    const server = makeServer();
    server.reactionSuppression.markUnavailable('unparseable at startup');
    const { handler, sent } = wireReactionHandler(server);
    handler({ ...baseEvent, emoji: HARMLESS, emojiId: null, token: HARMLESS });
    assert.equal(sent.length, 0);
  });

  it('filters_get reports redacted suppression state and distinguishes the nothings', async () => {
    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    s.discord = { getFilters: () => ({}) };
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);

    // not-configured
    server.reactionSuppression.applyFilters({});
    let res = (await call('filters_get', {})) as { reactionSuppression: Record<string, unknown> };
    assert.equal(res.reactionSuppression.status, 'not-configured');
    assert.equal(res.reactionSuppression.writable, false);
    assert.ok(String(res.reactionSuppression.whyNotWritable).length > 0, 'observe-only says why and what changes it');

    // configured-empty ≠ not-configured
    server.reactionSuppression.applyFilters({ suppressedReactionEmojis: [] });
    res = (await call('filters_get', {})) as { reactionSuppression: Record<string, unknown> };
    assert.equal(res.reactionSuppression.status, 'configured-empty');

    // active, redacted
    server.reactionSuppression.applyFilters(withKey());
    res = (await call('filters_get', {})) as { reactionSuppression: Record<string, unknown> };
    assert.equal(res.reactionSuppression.status, 'active');
    const blob = JSON.stringify(res);
    for (const secret of [SUPPRESSED_UNICODE, SUPPRESSED_BARE, 'sigil', SUPPRESSED_CUSTOM_ID]) {
      assert.ok(!blob.includes(secret), 'filters_get never echoes a suppressed entry');
    }

    // stale ≠ unavailable
    server.reactionSuppression.markUnavailable('unparseable on reload');
    res = (await call('filters_get', {})) as { reactionSuppression: Record<string, unknown> };
    assert.equal(res.reactionSuppression.status, 'stale');
    assert.equal(res.reactionSuppression.protectionActive, true);
  });

  it('guild/DM filters_update preserves the operator-owned suppression key (round trip)', async () => {
    const path = join(dir, 'filters.json');
    process.env.DISCORD_FILTERS_FILE = path;
    writeFileSync(path, JSON.stringify(withKey()));

    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    const startup = loadFiltersFile(path)!;
    server.reactionSuppression.applyFilters(startup);
    const digestBefore = server.reactionSuppression.status().effectiveDigest;

    s.discord = {
      getFilters: () => ({ guildIds: [...(startup.guildIds ?? [])] }),
      updateFilters: () => ({ addedGuilds: [], removedGuilds: [] }),
      listGuilds: async () => [],
    };
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);
    await call('filters_update', { setDmUsers: ['123456789012345678'] });

    const onDisk = loadFiltersFile(path)!;
    assert.deepEqual(onDisk.dmUsers, ['123456789012345678'], 'the whitelist change landed');
    assert.ok(onDisk.suppressedReactionEmojis?.length, 'suppression key survived the rewrite');
    server.reactionSuppression.applyFilters(onDisk);
    assert.equal(
      server.reactionSuppression.status().effectiveDigest,
      digestBefore,
      'effective suppression digest unchanged by a resident whitelist update',
    );
  });

  it('filters_update prefers fresh file entries over the process copy (operator edit inside the poll window)', async () => {
    const path = join(dir, 'filters.json');
    process.env.DISCORD_FILTERS_FILE = path;
    writeFileSync(path, JSON.stringify(withKey()));

    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    server.reactionSuppression.applyFilters(loadFiltersFile(path)!);

    // Operator adds an entry on disk; the 3s poller hasn't fired yet.
    const grown = [...FILE_TOKENS, ENV_ONLY_GLYPH];
    writeFileSync(path, JSON.stringify(withKey(grown)));

    s.discord = {
      getFilters: () => ({}),
      updateFilters: () => ({ addedGuilds: [], removedGuilds: [] }),
      listGuilds: async () => [],
    };
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);
    await call('filters_update', { setDmUsers: ['123456789012345678'] });

    const onDisk = loadFiltersFile(path)!;
    assert.equal(onDisk.suppressedReactionEmojis!.length, normalizeFilters({ suppressedReactionEmojis: grown }).suppressedReactionEmojis!.length,
      'the operator\'s fresh entry survives, not the process\'s stale copy');
  });
});
