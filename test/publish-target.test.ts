/**
 * MCPL RFC-011: every channel this server registers declares
 * `capabilities.publish.target: 'root'`. A Discord thread is its own channel
 * and a DM has no threads, so a publish lands in the channel itself or fails.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { toDescriptor, toDmDescriptor } from '../src/channels.js';

describe('publish target declaration', () => {
  it('a guild channel, a thread channel and a DM all declare root', () => {
    const text = toDescriptor({ id: 'c1', guildId: 'g1', guildName: 'Guild', name: 'general', type: 'text', parentId: null });
    const thread = toDescriptor({ id: 't1', guildId: 'g1', guildName: 'Guild', name: 'design-chat', type: 'thread', parentId: 'c1', parentName: 'general' });
    const dm = toDmDescriptor('d1', 'alice', false, 500, 'u1');
    for (const d of [text, thread, dm]) {
      assert.deepEqual(d.capabilities?.publish, { target: 'root' }, d.id);
      assert.ok(d.capabilities?.history && d.capabilities?.acknowledgment, `${d.id} keeps its other capabilities`);
    }
  });
});
