/**
 * A message's thread fields name the thread it was posted IN (Discord threads
 * are channels, so threadId equals channelId), never the thread it started:
 * discord.js `message.thread` is "the thread started by this message", a
 * different conversation.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { Collection, MessageType, type Client } from 'discord.js';
import { DiscordAdapter, type DiscordMessageData } from '../src/discord-adapter.js';

function fixture(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const delivered: DiscordMessageData[] = [];
  adapter.onMessage((message) => delivered.push(message));
  function emit(extra: Record<string, unknown>) {
    const message = {
      id: 'message-1', guildId: 'g1', guild: { name: 'Test Server' },
      author: { id: 'u1', username: 'bob', bot: false },
      content: 'hello', cleanContent: 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
      thread: null,
      ...extra,
    };
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', message);
  }
  return { delivered, emit };
}

describe('thread fields', () => {
  it('name the thread a message was posted in, and the channel it hangs off', (t) => {
    const f = fixture(t);
    f.emit({
      channelId: 'thread-1',
      channel: { name: 'design-chat', isThread: () => true, parentId: 'chan-1', parent: { name: 'general' } },
    });
    assert.equal(f.delivered.length, 1);
    const m = f.delivered[0];
    assert.equal(m.channelId, 'thread-1');
    assert.equal(m.threadId, 'thread-1');
    assert.equal(m.threadName, 'design-chat');
    assert.equal(m.threadParentName, 'general');
  });

  it('stay empty for a channel message that started a thread', (t) => {
    const f = fixture(t);
    f.emit({
      channelId: 'chan-1',
      channel: { name: 'general', isThread: () => false, parentId: null },
      thread: { id: 'spawned-1', name: 'spawned discussion' },
    });
    const m = f.delivered[0];
    assert.equal(m.channelId, 'chan-1');
    assert.equal(m.threadId, undefined, 'the started thread is not where this message was posted');
    assert.equal(m.threadName, undefined);
    assert.equal(m.threadParentName, undefined);
  });

  it('stay empty for a DM', (t) => {
    const f = fixture(t);
    f.emit({ channelId: 'dm-1', guildId: null, guild: null, channel: { isThread: () => false } });
    assert.equal(f.delivered[0].threadId, undefined);
  });
});
