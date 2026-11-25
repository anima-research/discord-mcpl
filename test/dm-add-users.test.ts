import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Collection, MessageType, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { loadFiltersFile, type DiscordFilters } from '../src/filters.js';

interface Answer {
  applied: { dmUsers: string[] | null };
  notes: string[];
}

const firstValue = new WeakMap<TestContext, string | undefined>();

function resident(t: TestContext, contents: DiscordFilters) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-dm-add-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'filters.json');
  if (!firstValue.has(t)) {
    firstValue.set(t, process.env.DISCORD_FILTERS_FILE);
    t.after(() => {
      const previous = firstValue.get(t);
      if (previous === undefined) delete process.env.DISCORD_FILTERS_FILE;
      else process.env.DISCORD_FILTERS_FILE = previous;
    });
  }
  process.env.DISCORD_FILTERS_FILE = path;
  writeFileSync(path, JSON.stringify(contents));
  const filters = loadFiltersFile(path) ?? {};
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  adapter.updateFilters(filters);
  const delivered: string[] = [];
  adapter.onMessage((message) => delivered.push(message.authorId));
  let n = 0;
  const reaches = (...users: string[]) => {
    delivered.length = 0;
    for (const user of users) {
      n += 1;
      (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
        id: `dm-${user}-${n}`, channelId: `dm-channel-${user}`, guildId: null, channel: null,
        author: { id: user, username: user, bot: false },
        content: 'hello', cleanContent: 'hello', type: MessageType.Default,
        attachments: new Collection(), createdAt: new Date(),
        mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
      });
    }
    return [...delivered];
  };
  const server = new DiscordMcplServer(adapter);
  server.filtersState.applyParsed(filters);
  const callTool = (server as unknown as {
    handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
  }).handleToolCall.bind(server);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await callTool(name, args);
    return { refused: result.isError === true, text: result.content.map((c) => c.text ?? '').join('') };
  };
  const update = async (args: Record<string, unknown>) => {
    const r = await call('filters_update', args);
    assert.equal(r.refused, false, r.text);
    return JSON.parse(r.text) as Answer;
  };
  const state = async () => ({ file: readFileSync(path, 'utf8'), shown: (await call('filters_get', {})).text });
  const refusal = async (args: Record<string, unknown>) => {
    const before = await state();
    const r = await call('filters_update', args);
    assert.equal(r.refused, true, r.text);
    assert.deepEqual(await state(), before, 'a refused call changes neither the file nor the filters in force');
    return r.text;
  };
  const file = () => JSON.parse(readFileSync(path, 'utf8')) as DiscordFilters;
  return { update, refusal, reaches, file };
}

describe('addDmUsers never stops anyone, and a call that stops someone says whom', () => {
  it('from an open list, addDmUsers changes nothing and says that the user can already DM', async (t) => {
    const r = resident(t, {});
    const a = await r.update({ addDmUsers: ['user-a'] });
    assert.equal(r.file().dmUsers, undefined);
    assert.equal(a.applied.dmUsers, null);
    assert.deepEqual(r.reaches('user-a', 'user-b'), ['user-a', 'user-b']);
    assert.deepEqual(a.notes, ['DMs are open to anyone, so these users can already DM you: user-a. There is no DM list, and nothing was added.']);
  });

  it('from a list, addDmUsers keeps everyone listed, adds the user, and names a user already listed', async (t) => {
    const r = resident(t, { dmUsers: ['user-a'] });
    assert.deepEqual(r.reaches('user-a', 'user-b'), ['user-a']);
    const a = await r.update({ addDmUsers: ['user-a', 'user-b'] });
    assert.deepEqual(r.file().dmUsers, ['user-a', 'user-b']);
    assert.deepEqual(r.reaches('user-a', 'user-b', 'user-c'), ['user-a', 'user-b']);
    assert.deepEqual(a.notes, ['Can DM you now: user-b.', 'Already on the DM list: user-a.']);
  });

  it('from an open list, setDmUsers says that everyone else is stopped, and how to open DMs again', async (t) => {
    const r = resident(t, {});
    assert.deepEqual(r.reaches('user-a', 'user-b'), ['user-a', 'user-b']);
    const a = await r.update({ setDmUsers: ['user-b'] });
    assert.deepEqual(r.reaches('user-a', 'user-b'), ['user-b']);
    assert.deepEqual(a.notes, [
      "DMs were open to anyone. Now only these users can DM you: user-b. Everyone else's DMs stop now. To open DMs to anyone again, call setDmUsers with an empty list.",
    ]);
  });

  it('from a list, setDmUsers names whom it let in and whom it stopped', async (t) => {
    const r = resident(t, { dmUsers: ['user-a', 'user-b'] });
    const a = await r.update({ setDmUsers: ['user-b', 'user-c'] });
    assert.deepEqual(r.reaches('user-a', 'user-b', 'user-c'), ['user-b', 'user-c']);
    assert.deepEqual(a.notes, ['Can DM you now: user-c.', 'Can no longer DM you: user-a.']);
  });

  it('setDmUsers with an empty list opens DMs and names no one as stopped', async (t) => {
    const r = resident(t, { dmUsers: ['user-a'] });
    const a = await r.update({ setDmUsers: [] });
    assert.deepEqual(r.reaches('user-a', 'user-b'), ['user-a', 'user-b']);
    assert.deepEqual(a.notes, ['DM whitelist cleared — DMs from ANYONE are now delivered.']);
  });

  it('with setDmUsers and addDmUsers in one call, the list is set first and the users are added to it', async (t) => {
    const r = resident(t, { dmUsers: ['user-a'] });
    const a = await r.update({ setDmUsers: ['user-b'], addDmUsers: ['user-c'] });
    assert.deepEqual(r.file().dmUsers, ['user-b', 'user-c']);
    assert.deepEqual(a.notes, ['Can DM you now: user-b, user-c.', 'Can no longer DM you: user-a.']);
    const open = resident(t, {});
    const b = await open.update({ setDmUsers: ['user-b'], addDmUsers: ['user-c'] });
    assert.deepEqual(open.reaches('user-a', 'user-b', 'user-c'), ['user-b', 'user-c']);
    assert.match(b.notes[0] ?? '', /^DMs were open to anyone\. Now only these users can DM you: user-b, user-c\. Everyone else's DMs stop now\./);
  });

  it('refuses an id in addDmUsers that is a number or not an id, and changes nothing', async (t) => {
    const r = resident(t, { dmUsers: ['user-a'] });
    assert.match(await r.refusal({ addDmUsers: [123] }), /ids must be strings in quotes/);
    assert.match(await r.refusal({ addDmUsers: ['two words'] }), /addDmUsers takes a list of user ids/);
    assert.match(await r.refusal({ addDmUsers: 'user-b' }), /addDmUsers takes a list of user ids/);
  });
});
