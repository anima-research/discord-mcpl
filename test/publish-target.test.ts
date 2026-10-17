/**
 * MCPL RFC-011: a channel declares `capabilities.publish.target: 'root'`
 * when a message can be posted in it, since a Discord thread is its own
 * channel and a channel has no threads inside it; a DM always does. A kind
 * that takes no message, or one this server doesn't know, declares nothing,
 * unless a message has been delivered from that channel.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { toDescriptor, toDmDescriptor } from '../src/channels.js';
import type { ChannelFacts } from '../src/discord-adapter.js';

const facts = (type: ChannelFacts['type'], extra: Partial<ChannelFacts> = {}): ChannelFacts => ({
  id: `${type}-1`, guildId: 'g1', guildName: 'Guild', name: `${type}-room`, type, parentId: null, ...extra,
});

describe('publish target declaration', () => {
  it('every kind a message can be posted in declares root, and keeps its other capabilities', () => {
    const kinds: ChannelFacts['type'][] = ['text', 'announcement', 'voice', 'stage'];
    const descriptors = [
      ...kinds.map((k) => toDescriptor(facts(k))),
      toDescriptor(facts('thread', { parentId: 'text-1', parentName: 'text-room' })),
      toDmDescriptor('d1', 'alice', false, 500, 'u1'),
    ];
    for (const d of descriptors) {
      assert.deepEqual(d.capabilities?.publish, { target: 'root' }, d.id);
      assert.ok(d.capabilities?.history && d.capabilities?.acknowledgment, `${d.id} keeps its other capabilities`);
    }
  });

  it('a category, a forum, and a kind this server does not know declare no target', () => {
    for (const kind of ['category', 'forum', 'unknown'] as const) {
      const d = toDescriptor(facts(kind));
      assert.equal(d.capabilities?.publish, undefined, kind);
      assert.ok(d.capabilities?.history && d.capabilities?.acknowledgment, `${kind} keeps its other capabilities`);
    }
  });

  it('a channel a message has been delivered from declares root, whatever its kind', () => {
    assert.deepEqual(toDescriptor(facts('unknown', { postedIn: true })).capabilities?.publish, { target: 'root' });
  });
});
