/**
 * sendMessage with a reply target: if the target no longer exists, Discord
 * should send the message unthreaded rather than reject the whole send
 * ("Unknown message"). discord.js expresses that as
 * `reply.failIfNotExists: false`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiscordAdapter } from '../src/discord-adapter.js';

function makeAdapter(channel: unknown) {
  const adapter = new DiscordAdapter({ token: 'not-used' });
  const internals = adapter as unknown as { client: { destroy(): void } };
  internals.client.destroy();
  internals.client = {
    destroy() {},
    channels: { fetch: async () => channel },
    users: { fetch: async () => null },
    user: { id: 'bot_1', username: 'bot', displayName: 'Bot', bot: true },
  } as never;
  return adapter;
}

function captureChannel() {
  const sends: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    sends,
    channel: {
      id: 'c1',
      send: async (payload: Record<string, unknown>) => {
        sends.push(payload);
        return { id: `sent-${++n}` };
      },
    },
  };
}

describe('sendMessage reply target', () => {
  it('asks Discord not to fail the send when the reply target is missing', async () => {
    const { sends, channel } = captureChannel();
    await makeAdapter(channel).sendMessage('c1', 'hello there', { replyTo: 'm-deleted' });
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]!.reply, { messageReference: 'm-deleted', failIfNotExists: false });
  });

  it('only the first chunk of a long message is a reply', async () => {
    const { sends, channel } = captureChannel();
    await makeAdapter(channel).sendMessage('c1', 'word '.repeat(900), { replyTo: 'm1' });
    assert.ok(sends.length > 1, 'message was split');
    assert.deepEqual(sends[0]!.reply, { messageReference: 'm1', failIfNotExists: false });
    for (const later of sends.slice(1)) assert.equal(later.reply, undefined);
  });

  it('sends without a reply when no target is given', async () => {
    const { sends, channel } = captureChannel();
    await makeAdapter(channel).sendMessage('c1', 'hello there');
    assert.equal(sends[0]!.reply, undefined);
  });
});
