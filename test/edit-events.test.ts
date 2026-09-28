/**
 * Edit/delete forwarding.
 *
 * Discord emits MESSAGE_UPDATE for more than content edits: link-preview /
 * embed refreshes re-send old messages with `edited_timestamp` still null.
 * Those were forwarded as "[message edited] …" events — weeks-old,
 * never-edited messages reaching the agent as fresh edits — with no author and
 * no guild, so the host placed them at `discord:dm:<guildChannelId>` and the
 * agent attributed them to whoever it had last been talking to.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { editForwardDecision } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter, MessageEventInfo } from '../src/discord-adapter.js';

const EDITED_AT = 1790000000000;
const guildMsg = (over: Record<string, unknown> = {}) => ({
  content: 'zz new text',
  editedTimestamp: EDITED_AT,
  guildId: 'g1',
  author: { id: 'u1' },
  ...over,
});

describe('editForwardDecision', () => {
  it('forwards a real content edit', () => {
    assert.equal(editForwardDecision({ partial: false, content: 'zz old text' }, guildMsg(), {}), 'forward');
  });

  it('drops an update that is not an edit (embed / link-preview refresh: edited_timestamp null)', () => {
    assert.equal(editForwardDecision(null, guildMsg({ editedTimestamp: null }), {}), 'not-an-edit');
    assert.equal(editForwardDecision(undefined, guildMsg({ editedTimestamp: undefined }), {}), 'not-an-edit');
  });

  it('drops an update whose content did not change when the old message is cached', () => {
    assert.equal(editForwardDecision({ partial: false, content: 'zz new text' }, guildMsg(), {}), 'unchanged');
  });

  it('forwards an edit of an uncached (partial) message — old content unknown', () => {
    assert.equal(editForwardDecision({ partial: true, content: null }, guildMsg(), {}), 'forward');
  });

  it('keeps the existing no-content and self-author drops', () => {
    assert.equal(editForwardDecision(null, guildMsg({ content: '' }), {}), 'no-content');
    assert.equal(editForwardDecision(null, guildMsg({ author: { id: 'bot' } }), { selfId: 'bot' }), 'self');
  });

  it('applies the DM whitelist and fails closed when the author is unknown', () => {
    const dmUsers = new Set(['ok-user']);
    const dm = (author: { id: string } | null) => guildMsg({ guildId: null, author });
    assert.equal(editForwardDecision(null, dm({ id: 'ok-user' }), { dmUsers }), 'forward');
    assert.equal(editForwardDecision(null, dm({ id: 'stranger' }), { dmUsers }), 'dm-not-allowed');
    assert.equal(editForwardDecision(null, dm(null), { dmUsers }), 'dm-not-allowed');
    // No whitelist configured: DMs from anyone, as before.
    assert.equal(editForwardDecision(null, dm(null), {}), 'forward');
  });

  it('does not apply the DM whitelist to guild channels', () => {
    assert.equal(editForwardDecision(null, guildMsg({ author: null }), { dmUsers: new Set(['ok-user']) }), 'forward');
  });
});

describe('edit/delete push events', () => {
  type EditHandler = (c: string, m: string, t: string, isDM: boolean, info?: MessageEventInfo) => void;
  type DeleteHandler = (c: string, m: string, isDM: boolean, info?: MessageEventInfo) => void;

  function wire(): { edit: EditHandler; del: DeleteHandler; sent: Array<{ method: string; params: any }> } {
    const server = new DiscordMcplServer({} as DiscordAdapter);
    const s = server as unknown as Record<string, unknown>;
    let edit: EditHandler | undefined;
    let del: DeleteHandler | undefined;
    const noop = () => {};
    s.discord = {
      onMessage: noop, onReaction: noop,
      onChannelCreate: noop, onChannelDelete: noop, onGuildCreate: noop, onChannelAvailable: noop,
      onMessageEdit: (h: EditHandler) => { edit = h; },
      onMessageDelete: (h: DeleteHandler) => { del = h; },
    };
    const sent: Array<{ method: string; params: any }> = [];
    s.conn = { sendRequest: (method: string, params: unknown) => { sent.push({ method, params }); return Promise.resolve({}); } };
    s.mcplEnabled = true;
    (s.enabledFeatureSets as Set<string>).add('discord.messaging');
    (s.ensureSubscriptionsLoaded as () => void).call(server);
    (s.subscribedChannels as Set<string>).add('chan1');
    (s.setupDiscordForwarding as () => void).call(server);
    assert.ok(edit && del, 'edit/delete handlers registered');
    return { edit: edit!, del: del!, sent };
  }

  it('a guild edit names its author and carries the guild + composite channel id', () => {
    const { edit, sent } = wire();
    edit('chan1', 'm1', 'zz fixed typo', false, { guildId: 'g1', authorId: 'u1', authorName: 'niston' });
    assert.equal(sent.length, 1);
    const { origin, payload } = sent[0]!.params;
    assert.equal(payload.content[0].text, '[message edited] niston: zz fixed typo');
    assert.equal(origin.guildId, 'g1');
    assert.equal(origin.mcplChannelId, 'discord:g1:chan1');
    assert.equal(origin.messageId, 'm1');
    assert.equal(origin.authorId, 'u1');
    assert.equal(origin.authorName, 'niston');
  });

  it('a DM edit carries no guild, so the host still composes discord:dm:<id>', () => {
    const { edit, sent } = wire();
    edit('dmchan', 'm2', 'zz hola', true, { guildId: null, authorId: 'u2', authorName: '_reim0n' });
    const { origin, payload } = sent[0]!.params;
    assert.equal(payload.content[0].text, '[message edited] _reim0n: zz hola');
    assert.equal(origin.guildId, undefined);
    assert.equal(origin.mcplChannelId, undefined);
  });

  it('an edit without author info keeps the old text shape', () => {
    const { edit, sent } = wire();
    edit('chan1', 'm3', 'zz text', false);
    assert.equal(sent[0]!.params.payload.content[0].text, '[message edited] zz text');
    assert.equal(sent[0]!.params.origin.guildId, undefined);
  });

  it('a guild delete carries the guild + composite channel id', () => {
    const { del, sent } = wire();
    del('chan1', 'm4', false, { guildId: 'g1' });
    const { origin, payload } = sent[0]!.params;
    assert.equal(payload.content[0].text, '[message deleted] m4');
    assert.equal(origin.mcplChannelId, 'discord:g1:chan1');
  });
});
