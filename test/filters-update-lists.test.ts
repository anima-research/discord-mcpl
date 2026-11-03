import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Collection, MessageType, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { loadFiltersFile, type DiscordFilters } from '../src/filters.js';

function filtersFile(t: TestContext, filters: DiscordFilters): string {
  const dir = mkdtempSync(join(tmpdir(), 'discord-filters-lists-'));
  const path = join(dir, 'filters.json');
  const previous = process.env.DISCORD_FILTERS_FILE;
  process.env.DISCORD_FILTERS_FILE = path;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_FILTERS_FILE;
    else process.env.DISCORD_FILTERS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(path, JSON.stringify(filters));
  return path;
}

function adapterOver(t: TestContext, filters: DiscordFilters, botGuilds: string[] = []) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  adapter.updateFilters(filters);
  (adapter as unknown as { listGuilds: () => Promise<Array<{ id: string; name: string }>> }).listGuilds =
    async () => botGuilds.map((id) => ({ id, name: id }));
  const delivered: string[] = [];
  adapter.onMessage((message) => delivered.push(`${message.guildId}/${message.channelId}`));
  const post = (guildId: string, channelId = `channel-${guildId}`) => {
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
      id: `message-${guildId}-${channelId}`, channelId, guildId, channel: null,
      author: { id: 'user-1', username: 'user-1', bot: false },
      content: 'hello', cleanContent: 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
    });
  };
  const postDm = (userId: string) => {
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
      id: `dm-${userId}`, channelId: `dm-channel-${userId}`, guildId: null, channel: null,
      author: { id: userId, username: userId, bot: false },
      content: 'hello', cleanContent: 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
    });
  };
  return { adapter, delivered, post, postDm };
}

function serverOver(t: TestContext, filters: DiscordFilters, botGuilds: string[] = []) {
  const path = filtersFile(t, filters);
  const { adapter, delivered, post, postDm } = adapterOver(t, filters, botGuilds);
  const server = new DiscordMcplServer(adapter);
  server.filtersState.applyParsed(filters);
  const callTool = (server as unknown as {
    handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
  }).handleToolCall.bind(server);
  const update = async (args: Record<string, unknown>) => {
    const result = await callTool('filters_update', args);
    return { refused: result.isError === true, text: result.content.map((c) => c.text ?? '').join('') };
  };
  return { path, delivered, post, postDm, update, fileText: () => readFileSync(path, 'utf8') };
}

describe('filters_update narrows the server list and never empties it', () => {
  it('stops a removed server\'s events while another server stays listed', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1', 'guild-2'] });
    assert.equal((await s.update({ removeGuilds: ['guild-1'] })).refused, false);
    s.post('guild-1');
    s.post('guild-2');
    assert.deepEqual(s.delivered, ['guild-2/channel-guild-2']);
    assert.deepEqual(JSON.parse(s.fileText()).guildIds, ['guild-2']);
  });

  it('removes the last listed server when the same call adds another', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1'] });
    assert.equal((await s.update({ addGuilds: ['guild-2'], removeGuilds: ['guild-1'] })).refused, false);
    s.post('guild-1');
    s.post('guild-2');
    assert.deepEqual(s.delivered, ['guild-2/channel-guild-2']);
  });

  it('removes one of two servers from an unrestricted list, leaving the other listed', async (t) => {
    const s = serverOver(t, {}, ['guild-1', 'guild-2']);
    assert.equal((await s.update({ removeGuilds: ['guild-1'] })).refused, false);
    assert.deepEqual(JSON.parse(s.fileText()).guildIds, ['guild-2']);
    s.post('guild-1');
    s.post('guild-2');
    assert.deepEqual(s.delivered, ['guild-2/channel-guild-2']);
  });

  it('refuses to remove the last listed server, says why and what narrows, and changes nothing', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1'], guildChannels: { 'guild-1': ['channel-guild-1'] } });
    const before = s.fileText();
    const result = await s.update({ removeGuilds: ['guild-1'] });
    assert.equal(result.refused, true);
    assert.match(result.text, /Removing guild-1 would leave no server listed/);
    assert.match(result.text, /admits every server/);
    assert.match(result.text, /addGuilds/);
    assert.match(result.text, /With no other server to keep, this tool can't stop that one's events/);
    assert.match(result.text, /Nothing was changed/);
    assert.equal(s.fileText(), before);
    s.post('guild-1');
    s.post('guild-2');
    assert.deepEqual(s.delivered, ['guild-1/channel-guild-1']);
  });

  it('refuses, from an unrestricted list, to remove the only server the bot is in, and changes nothing', async (t) => {
    const s = serverOver(t, {}, ['guild-1']);
    const before = s.fileText();
    const result = await s.update({ removeGuilds: ['guild-1'] });
    assert.equal(result.refused, true);
    assert.match(result.text, /Nothing was changed/);
    assert.equal(s.fileText(), before);
    s.post('guild-1');
    assert.deepEqual(s.delivered, ['guild-1/channel-guild-1']);
  });

  it('refuses the whole call when it would empty the list, the DM list change with it', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1'], dmUsers: ['user-1'] });
    const before = s.fileText();
    const result = await s.update({ removeGuilds: ['guild-1'], setDmUsers: ['user-2'] });
    assert.equal(result.refused, true);
    assert.equal(s.fileText(), before);
    s.postDm('user-1');
    s.postDm('user-2');
    s.post('guild-1');
    s.post('guild-2');
    assert.deepEqual(s.delivered, ['null/dm-channel-user-1', 'guild-1/channel-guild-1']);
  });

  it('reads an argument given as null as left out', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1'], dmUsers: ['user-1'] });
    const result = await s.update({ addGuilds: ['guild-2'], removeGuilds: null, setDmUsers: null, setDmNotice: null });
    assert.equal(result.refused, false, result.text);
    assert.deepEqual(JSON.parse(s.fileText()), { guildIds: ['guild-1', 'guild-2'], dmUsers: ['user-1'] });
    s.postDm('user-1');
    s.postDm('user-2');
    assert.deepEqual(s.delivered, ['null/dm-channel-user-1']);
  });

  it('reads spaces around an id, and an empty "+" segment, as the ids they surround', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1', 'guild-3'], dmUsers: ['user-1'] });
    const result = await s.update({
      addGuilds: [' guild-2 : channel-a + channel-b +'], removeGuilds: [' guild-1 '], setDmUsers: [' user-2 '],
    });
    assert.equal(result.refused, false, result.text);
    assert.deepEqual(JSON.parse(s.fileText()), {
      guildIds: ['guild-3', 'guild-2'], guildChannels: { 'guild-2': ['channel-a', 'channel-b'] }, dmUsers: ['user-2'],
    });
    s.post('guild-1');
    s.post('guild-2', 'channel-a');
    s.post('guild-2', 'channel-b');
    s.post('guild-2', 'channel-other');
    s.postDm('user-1');
    s.postDm('user-2');
    assert.deepEqual(s.delivered, ['guild-2/channel-a', 'guild-2/channel-b', 'null/dm-channel-user-2']);
  });
});

describe('filters_update refuses an entry that isn\'t a server id or a server id with channel ids', () => {
  for (const entry of [
    'guild-2:', 'guild-2:+', 'guild-2: + ', 'guild-1:', ':', ':+', ':channel-guild-2', 'guild-2::channel-guild-2',
    'guild-2:channel-a:channel-b', 'guild 2', 'guild-2:channel a', 'guild-2:channel-a,channel-b', 'guild-2,guild-3',
    'guild-2+guild-3',
  ]) {
    it(`refuses addGuilds ${JSON.stringify(entry)} beside a good entry, and changes nothing`, async (t) => {
      const s = serverOver(t, { guildIds: ['guild-1'], guildChannels: { 'guild-1': ['channel-guild-1'] } });
      const before = s.fileText();
      const result = await s.update({ addGuilds: ['guild-3', entry] });
      assert.equal(result.refused, true);
      assert.match(result.text, /a server id alone, for all its channels, or a server id with the channel ids to add/);
      assert.ok(result.text.includes(JSON.stringify(entry)), result.text);
      assert.match(result.text, /Nothing was changed/);
      assert.equal(s.fileText(), before);
      s.post('guild-1');
      s.post('guild-1', 'channel-other');
      s.post('guild-2');
      s.post('guild-3');
      assert.deepEqual(s.delivered, ['guild-1/channel-guild-1']);
    });
  }

  const notIdLists: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a number in removeGuilds', { removeGuilds: [111] }, /removeGuilds takes a list of server ids, .* and 111 isn't a string/],
    ['a number in addGuilds', { addGuilds: [222] }, /addGuilds takes a list of entries, .* and 222 isn't a string/],
    ['an empty string in removeGuilds', { removeGuilds: ['guild-1', ''] }, /removeGuilds takes a list of server ids, .* and "" isn't one/],
    ['an id with a space inside it in removeGuilds', { removeGuilds: ['guild 1'] }, /and "guild 1" isn't one/],
    ['a removeGuilds that is not a list', { removeGuilds: 'guild-1' }, /removeGuilds takes a list of server ids, .* not "guild-1"/],
    ['a setDmUsers of empty strings', { setDmUsers: [''] }, /setDmUsers takes a list of user ids, .* and "" isn't one/],
    ['a number in setDmUsers', { setDmUsers: [123] }, /setDmUsers takes a list of user ids, .* and 123 isn't a string/],
    ['a setDmUsers that is not a list', { setDmUsers: 'user-2' }, /setDmUsers takes a list of user ids, .* not "user-2"/],
  ];
  for (const [what, args, says] of notIdLists) {
    it(`refuses ${what}, and changes nothing`, async (t) => {
      const s = serverOver(t, { guildIds: ['guild-1', '111'], guildChannels: { '111': ['channel-111'] }, dmUsers: ['user-1'] });
      const before = s.fileText();
      const result = await s.update(args);
      assert.equal(result.refused, true);
      assert.match(result.text, says);
      assert.match(result.text, /Nothing was changed/);
      assert.equal(s.fileText(), before);
      s.post('111');
      s.post('111', 'channel-other');
      s.postDm('user-1');
      s.postDm('user-2');
      assert.deepEqual(s.delivered, ['111/channel-111', 'null/dm-channel-user-1']);
    });
  }

  it('adds a server with only the channels its entry names', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1'] });
    assert.equal((await s.update({ addGuilds: ['guild-2:channel-a+channel-b'] })).refused, false);
    assert.deepEqual(JSON.parse(s.fileText()).guildChannels, { 'guild-2': ['channel-a', 'channel-b'] });
    s.post('guild-2', 'channel-a');
    s.post('guild-2', 'channel-b');
    s.post('guild-2', 'channel-other');
    assert.deepEqual(s.delivered, ['guild-2/channel-a', 'guild-2/channel-b']);
  });
});

describe('filters_update applies an entry for a server already listed', () => {
  it('adds channels to its restriction, lifts the restriction for a bare id, and notes a list that changes nothing', async (t) => {
    const s = serverOver(t, { guildIds: ['guild-1', 'guild-2'], guildChannels: { 'guild-1': ['channel-a'] } });
    const merged = await s.update({ addGuilds: ['guild-1:channel-b'] });
    assert.equal(merged.refused, false, merged.text);
    assert.deepEqual(JSON.parse(s.fileText()).guildChannels, { 'guild-1': ['channel-a', 'channel-b'] });
    const noOp = await s.update({ addGuilds: ['guild-2:channel-c'] });
    assert.match(noOp.text, /Guild guild-2 already allows all channels; the channel list on .*guild-2:channel-c.* is a no-op/);
    assert.equal(JSON.parse(s.fileText()).guildChannels?.['guild-2'], undefined);
    const lifted = await s.update({ addGuilds: ['guild-1'] });
    assert.match(lifted.text, /Guild guild-1: channel restriction removed/);
    assert.equal(JSON.parse(s.fileText()).guildChannels?.['guild-1'], undefined);
    s.post('guild-1', 'channel-other');
    s.post('guild-2', 'channel-other');
    assert.deepEqual(s.delivered, ['guild-1/channel-other', 'guild-2/channel-other']);
  });
});

describe('a filters file\'s empty server list', () => {
  it('still admits every server', (t) => {
    const path = filtersFile(t, { guildIds: [] });
    const loaded = loadFiltersFile(path);
    assert.ok(loaded);
    const { delivered, post } = adapterOver(t, loaded);
    post('guild-1');
    post('guild-2');
    assert.deepEqual(delivered, ['guild-1/channel-guild-1', 'guild-2/channel-guild-2']);
  });
});
