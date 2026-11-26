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
  const operatorWrites = (next: DiscordFilters) => writeFileSync(path, JSON.stringify(next));
  return { update, refusal, reaches, file, operatorWrites };
}

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';
const reopen = 'To open DMs to anyone again, call filters_update with setDmUsers: [].';

describe('addDmUsers never stops anyone, and a call that stops someone says whom', () => {
  it('from an open list, addDmUsers changes nothing and says that the user can already DM', async (t) => {
    const r = resident(t, {});
    const a = await r.update({ addDmUsers: [A] });
    assert.equal(r.file().dmUsers, undefined);
    assert.equal(a.applied.dmUsers, null);
    assert.deepEqual(r.reaches(A, B), [A, B]);
    assert.deepEqual(a.notes, [`DMs are open to anyone, so these users can already DM you: ${A}. There is no DM list, and nothing was added.`]);
  });

  it('from a list, addDmUsers keeps everyone listed, adds the user, and names a user already listed', async (t) => {
    const r = resident(t, { dmUsers: [A] });
    assert.deepEqual(r.reaches(A, B), [A]);
    const a = await r.update({ addDmUsers: [A, B] });
    assert.deepEqual(r.file().dmUsers, [A, B]);
    assert.deepEqual(r.reaches(A, B, C), [A, B]);
    assert.deepEqual(a.notes, [`Can DM you now: ${B}.`, `Already on the DM list: ${A}.`]);
  });

  it('from an open list, setDmUsers says that everyone else is stopped, and how to open DMs again', async (t) => {
    const r = resident(t, {});
    assert.deepEqual(r.reaches(A, B), [A, B]);
    const a = await r.update({ setDmUsers: [B] });
    assert.deepEqual(r.reaches(A, B), [B]);
    assert.deepEqual(a.notes, [
      `DMs were open to anyone. Now only these users can DM you: ${B}. Everyone else's DMs stop now. ${reopen}`,
    ]);
  });

  it('from a list, setDmUsers names whom it let in and whom it stopped', async (t) => {
    const r = resident(t, { dmUsers: [A, B] });
    const a = await r.update({ setDmUsers: [B, C] });
    assert.deepEqual(r.reaches(A, B, C), [B, C]);
    assert.deepEqual(a.notes, [`Can DM you now: ${C}.`, `Can no longer DM you: ${A}.`]);
  });

  it('setDmUsers with an empty list opens DMs and names no one as stopped', async (t) => {
    const r = resident(t, { dmUsers: [A] });
    const a = await r.update({ setDmUsers: [] });
    assert.deepEqual(r.reaches(A, B), [A, B]);
    assert.deepEqual(a.notes, ['DM whitelist cleared — DMs from ANYONE are now delivered.']);
  });

  it('with setDmUsers and addDmUsers in one call, the list is set first and the users are added to it', async (t) => {
    const r = resident(t, { dmUsers: [A] });
    const a = await r.update({ setDmUsers: [B], addDmUsers: [C] });
    assert.deepEqual(r.file().dmUsers, [B, C]);
    assert.deepEqual(a.notes, [`Can DM you now: ${B}, ${C}.`, `Can no longer DM you: ${A}.`]);
    const open = resident(t, {});
    const b = await open.update({ setDmUsers: [B], addDmUsers: [C] });
    assert.deepEqual(open.reaches(A, B, C), [B, C]);
    assert.match(b.notes[0] ?? '', new RegExp(`^DMs were open to anyone\\. Now only these users can DM you: ${B}, ${C}\\. Everyone else's DMs stop now\\.`));
  });

  it('addDmUsers takes user ids only: it refuses a number, a name or a mention, and changes nothing', async (t) => {
    const r = resident(t, { dmUsers: [A] });
    assert.match(await r.refusal({ addDmUsers: [123] }), /ids must be strings in quotes/);
    assert.match(await r.refusal({ addDmUsers: ['@alice'] }), /addDmUsers takes a list of Discord user ids, .*"@alice" isn't one/);
    assert.match(await r.refusal({ addDmUsers: [`<@${B}>`] }), /addDmUsers takes a list of Discord user ids/);
    assert.match(await r.refusal({ addDmUsers: B }), /addDmUsers takes a list of Discord user ids/);
  });

  it('an entry that is not a user id is named as letting no one in, never as a user who can DM', async (t) => {
    const open = resident(t, {});
    const a = await open.update({ setDmUsers: ['@alice'] });
    assert.deepEqual(open.reaches(A, B), []);
    assert.deepEqual(a.notes, [`DMs were open to anyone. Now no one can DM you. ${reopen}`, 'Not user ids, so they let no one in: @alice.']);
    const listed = resident(t, { dmUsers: [A] });
    const b = await listed.update({ setDmUsers: [A, '@bob'] });
    assert.deepEqual(b.notes, ['Not user ids, so they let no one in: @bob.']);
    const c = await listed.update({ setDmUsers: [A] });
    assert.deepEqual(c.notes, []);
  });

  it('the answer compares with the list in force, so an operator edit not yet applied is named too', async (t) => {
    const listed = resident(t, { dmUsers: [A] });
    listed.operatorWrites({ dmUsers: [B] });
    const a = await listed.update({ addDmUsers: [C] });
    assert.deepEqual(listed.reaches(A, B, C), [B, C]);
    assert.deepEqual(a.notes, [`Can DM you now: ${B}, ${C}.`, `Can no longer DM you: ${A}.`]);
    const open = resident(t, {});
    open.operatorWrites({ dmUsers: [A] });
    const b = await open.update({ addDmUsers: [B] });
    assert.deepEqual(open.reaches(A, B, C), [A, B]);
    assert.deepEqual(b.notes, [`DMs were open to anyone. Now only these users can DM you: ${A}, ${B}. Everyone else's DMs stop now. ${reopen}`]);
  });
});
