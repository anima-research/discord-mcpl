/**
 * The muted channels, the reaction channels and the watermarks are each read
 * once and then rewritten whole after every change. A file that couldn't be
 * read used to leave its store empty, and the next save then overwrote it,
 * so one unreadable file lost every earlier mute, reaction opt-in or
 * watermark. Now an unusable file is moved aside before its store starts
 * empty, and saves write a temp file and rename it over, so a crash can't
 * leave a torn file.
 *
 * Run: node --import tsx --test test/persisted-stores.test.ts
 */
import { describe, it, beforeEach, afterEach, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { writeJsonFile } from '../src/persisted-json.js';

const ENV = ['DISCORD_MUTED_CHANNELS_FILE', 'DISCORD_REACTION_CHANNELS_FILE', 'DISCORD_WATERMARK_FILE'];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persisted-stores-'));
  process.env.DISCORD_MUTED_CHANNELS_FILE = join(dir, 'muted.json');
  process.env.DISCORD_REACTION_CHANNELS_FILE = join(dir, 'reactions.json');
  process.env.DISCORD_WATERMARK_FILE = join(dir, 'watermarks.json');
});

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});

function server(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  t.after(() => adapter.rawClient.destroy());
  const s = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & {
    executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    ensureWatermarkLoaded(): void;
    saveWatermark(): void;
    forwardedWatermark: Map<string, string>;
  };
  s.subscriptionsLoaded = true;
  return s;
}

const errors = (t: TestContext) => t.mock.method(console, 'error', () => {});
const asides = (name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`));

describe('a store whose file is unusable', () => {
  it('moves an unparsable muted list aside, so the next mute writes a fresh file', async (t) => {
    const logged = errors(t);
    writeFileSync(join(dir, 'muted.json'), '["chan-a", "chan-b"');
    await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'muted.json'), 'utf-8')), ['chan-new']);
    const [aside] = asides('muted.json');
    assert.ok(aside, 'the unreadable file is kept beside it');
    assert.equal(readFileSync(join(dir, aside), 'utf-8'), '["chan-a", "chan-b"', 'byte for byte');
    assert.ok(
      logged.mock.calls.some((c) => String(c.arguments[0]).includes(aside)),
      'the operator log names where it went',
    );
  });

  it('moves a muted list of the wrong shape aside too', async (t) => {
    errors(t);
    writeFileSync(join(dir, 'muted.json'), '{"chan-a": true}');
    await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'muted.json'), 'utf-8')), ['chan-new']);
    assert.equal(asides('muted.json').length, 1);
  });

  it('moves an unparsable reaction-channel list aside', async (t) => {
    errors(t);
    writeFileSync(join(dir, 'reactions.json'), 'not json');
    await server(t).executeToolCall('set_reaction_visibility', { channelId: 'chan-new', visible: true });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'reactions.json'), 'utf-8')), ['chan-new']);
    assert.equal(asides('reactions.json').length, 1);
  });

  it('moves an unparsable watermark file aside', (t) => {
    errors(t);
    writeFileSync(join(dir, 'watermarks.json'), '{"watermarks": {"chan-a": "1"');
    const s = server(t);
    s.ensureWatermarkLoaded();
    s.forwardedWatermark.set('chan-new', '2');
    s.saveWatermark();
    const saved = JSON.parse(readFileSync(join(dir, 'watermarks.json'), 'utf-8'));
    assert.deepEqual(saved.watermarks, { 'chan-new': '2' });
    assert.equal(asides('watermarks.json').length, 1);
  });

  it('loads a readable file as before, and moves nothing', async (t) => {
    writeFileSync(join(dir, 'muted.json'), '["chan-a"]');
    writeFileSync(join(dir, 'watermarks.json'), '{"watermarks": {"chan-a": "1"}, "missed": {"chan-b": null}}');
    const s = server(t);
    await s.executeToolCall('mute_channel', { channelId: 'chan-new' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'muted.json'), 'utf-8')), ['chan-a', 'chan-new']);
    // A tally entry that isn't an object reads as an empty one.
    s.ensureWatermarkLoaded();
    assert.equal(s.forwardedWatermark.get('chan-a'), '1');
    assert.deepEqual(readdirSync(dir).sort(), ['muted.json', 'watermarks.json']);
  });
});

describe('writeJsonFile', () => {
  it('a failed save leaves the last good file, and a good one leaves no temp file', () => {
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => writeJsonFile(path, circular));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['a'], 'a failed save leaves the last good file');
    writeJsonFile(path, ['b']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
    assert.deepEqual(readdirSync(dir), ['store.json']);
  });
});
