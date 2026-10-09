/**
 * An id Discord doesn't know comes back as "Unknown Channel" and the like,
 * which says nothing about what to do. The tool chokepoint appends what the
 * answer means for the id that was passed, and how to get a real one, after
 * Discord's own words.
 *
 * Run: node --import tsx --test test/discord-errors.test.ts
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { explainDiscordError } from '../src/discord-errors.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';

/** Shaped as discord.js's DiscordAPIError: the message is Discord's, `code` its JSON error code. */
const discordError = (message: string, code: number, status: number) => Object.assign(new Error(message), { code, status });

describe('explainDiscordError', () => {
  it('says what an unknown channel id means, names the id, and gives the cures', () => {
    const text = explainDiscordError(discordError('Unknown Channel', 10003, 404), { channelId: '111111111111111111' });
    assert.match(text, /^Unknown Channel\n\n/, "Discord's own words come first");
    assert.match(text, /No channel 111111111111111111 is visible to this connection\. For a server channel, re-send with its name/,
      'the name path, which lists its candidates, is the first cure');
    assert.match(text, /A thread or DM has no name route: copy its id from a message that arrived there/,
      'a thread or DM is never sent back to a name that could match another channel');
    assert.match(text, /remembered rather than copied/);
  });

  it('explains an unknown message, an unknown user and missing access the same way', () => {
    const msg = explainDiscordError(discordError('Unknown Message', 10008, 404), { channelId: '1', messageId: '222' });
    assert.match(msg, /No message 222 is visible in channel 1/);
    assert.match(msg, /fetch_history/);
    const user = explainDiscordError(discordError('Unknown User', 10013, 404), { userId: '333' });
    assert.match(user, /No user 333 is known to Discord\. Re-send with their @username/);
    const access = explainDiscordError(discordError('Missing Access', 50001, 403), { channelId: '444' });
    assert.match(access, /^Missing Access\n\nThis bot can't reach channel 444/);
  });

  it('names a server for an unknown guild id, and for missing access on a call aimed at a server', () => {
    const guild = explainDiscordError(discordError('Unknown Guild', 10004, 404), { guildId: '555' });
    assert.match(guild, /^Unknown Guild\n\nNo server 555 is visible to this connection/);
    assert.match(guild, /list_guilds/);
    const access = explainDiscordError(discordError('Missing Access', 50001, 403), { guildId: '666' });
    assert.match(access, /^Missing Access\n\nThis bot can't reach server 666/);
    assert.match(access, /list_guilds/);
  });

  it('keeps what a tool path added to the message, and leaves every other error as it was', () => {
    const sent = discordError('Unknown Channel', 10003, 404);
    sent.message += '\n\nAttempted destination: discord:g1:555.';
    const text = explainDiscordError(sent, { channelId: '555' });
    assert.ok(text.startsWith('Unknown Channel\n\nAttempted destination: discord:g1:555.\n\nNo channel 555'), text);
    assert.equal(explainDiscordError(discordError('Missing Permissions', 50013, 403), { channelId: '1' }), 'Missing Permissions');
    assert.equal(explainDiscordError(new Error('socket hang up'), {}), 'socket hang up');
    assert.equal(explainDiscordError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), {}), 'read ECONNRESET');
    assert.match(explainDiscordError(discordError('Unknown Channel', 10003, 404), {}), /^Unknown Channel\n\nNo such channel is visible/);
  });
});

describe('the tool chokepoint', () => {
  it('list_emojis with an unknown guild id passes Discord\'s error through to be explained', async (t) => {
    const { DiscordAdapter } = await import('../src/discord-adapter.js');
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: { guilds: { fetch: (id: string) => Promise<unknown> }; destroy(): void } }).client;
    t.after(() => client.destroy());
    client.guilds.fetch = async () => { throw discordError('Unknown Guild', 10004, 404); };
    const server = new DiscordMcplServer(adapter) as unknown as {
      handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('list_emojis', { guildId: '999999999999999999' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /^Unknown Guild\n\nNo server 999999999999999999 is visible to this connection/);
    assert.match(r.content[0].text ?? '', /list_guilds/);
  });

  it('a send to an unknown channel id returns the explanation as the tool error', async () => {
    const adapter = {
      sendMessage: async () => { throw discordError('Unknown Channel', 10003, 404); },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('send_message', { channelId: '123456789012345678', content: 'hi' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /^Unknown Channel\n\nNo channel 123456789012345678 is visible to this connection/);
  });
});
