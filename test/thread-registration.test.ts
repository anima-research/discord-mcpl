/**
 * Adapter side of thread registration: a thread's label is display-only, the
 * channel cache reports a thread's parent (so the reconnect sweep can
 * register what it pushes), a deleted thread is reported, and channelCreate
 * registers only guild text channels, as boot and channelUpdate do.
 * Jerome-1896 and Esther-1897 found that no path registered threads (room-203
 * #58153), and that the sweep pushed DMs and threads unregistered (#58257,
 * #58302).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAdapter, type DiscordChannelInfo } from '../src/discord-adapter.js';
import { formatThreadLabel, parseChannelRef } from '../src/channel-names.js';
import { toDescriptor } from '../src/channels.js';

function adapterFixture(t: { after: (fn: () => void) => void }) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
  return { adapter, client, emit };
}

describe('thread labels', () => {
  it('name the parent channel and the thread, in a form that is not a channel address', () => {
    assert.equal(formatThreadLabel('general', 'design-chat', 'Test Server'), '#general › design-chat (Test Server)');
    assert.equal(formatThreadLabel(null, 'design-chat', 'Test Server'), '› design-chat (Test Server)');
    const d = toDescriptor('g1', 'Test Server', { id: 'th1', name: 'design-chat', type: 'thread', parentId: 'c1', parentName: 'general', label: '' });
    assert.equal(d.label, '#general › design-chat (Test Server)');
    // Pasted back, it asks for a channel named `general › design-chat`, and a
    // Discord text channel's name has no spaces: it fails loudly, where
    // `#design-chat (Test Server)` would quietly name a same-named channel.
    assert.deepEqual(parseChannelRef(d.label), { kind: 'name', name: 'general › design-chat', guild: 'Test Server' });
    // A channel's descriptor keeps its address form.
    const c = toDescriptor('g1', 'Test Server', { id: 'c1', name: 'general', type: 'text', label: '' } as DiscordChannelInfo);
    assert.equal(c.label, '#general (Test Server)');
    assert.deepEqual(parseChannelRef(c.label), { kind: 'name', name: 'general', guild: 'Test Server' });
  });
});

describe('the channel cache reports a thread\'s parent', () => {
  it('for a cached thread, and not for a channel or an uncached id', (t) => {
    const { adapter, client } = adapterFixture(t);
    const cache = client.channels.cache as unknown as Map<string, unknown>;
    cache.set('th1', {
      id: 'th1', name: 'design-chat', guildId: 'g1', guild: { name: 'Test Server' },
      isThread: () => true, parentId: 'c1', parent: { name: 'general' },
    });
    cache.set('c1', {
      id: 'c1', name: 'general', guildId: 'g1', guild: { name: 'Test Server' },
      isThread: () => false, parentId: 'cat1', parent: { name: 'Text Channels' },
    });
    assert.deepEqual(adapter.getCachedThreadParent('th1'), { parentId: 'c1', parentName: 'general' });
    assert.equal(adapter.getCachedThreadParent('c1'), null);
    assert.equal(adapter.getCachedThreadParent('not-cached'), null);
  });
});

describe('channel lifecycle events', () => {
  it('reports a deleted thread', (t) => {
    const { adapter, emit } = adapterFixture(t);
    const deleted: Array<[string, string]> = [];
    adapter.onThreadDelete((guildId, threadId) => deleted.push([guildId, threadId]));
    emit('threadDelete', { id: 'th1', guildId: 'g1' });
    assert.deepEqual(deleted, [['g1', 'th1']]);
  });

  it('registers only guild text channels from channelCreate, as boot and channelUpdate do', (t) => {
    const { adapter, emit } = adapterFixture(t);
    const created: string[] = [];
    adapter.onChannelCreate((_guildId, channel) => created.push(channel.id));
    const channel = (id: string, type: ChannelType) => ({
      id, type, name: `chan-${id}`, guildId: 'g1', guild: { name: 'Test Server' }, parentId: null,
    });
    emit('channelCreate', channel('text1', ChannelType.GuildText));
    emit('channelCreate', channel('cat1', ChannelType.GuildCategory));
    emit('channelCreate', channel('forum1', ChannelType.GuildForum));
    emit('channelCreate', channel('voice1', ChannelType.GuildVoice));
    assert.deepEqual(created, ['text1']);
  });
});
