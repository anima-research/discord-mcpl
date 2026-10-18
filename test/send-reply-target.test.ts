/**
 * sendMessage with a reply target: if the target no longer exists, Discord
 * should send the message unthreaded rather than reject the whole send
 * ("Unknown message"). discord.js expresses that as
 * `reply.failIfNotExists: false`, sent as `fail_if_not_exists`. Discord then
 * returns the message without a `message_reference`, and the result says the
 * reply target was missing.
 */

import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';

import { DiscordAdapter } from '../src/discord-adapter.js';

const BOT = '1300000000000000002';
const GONE = '1200000000000000009';

/** A logged-out adapter with one cached DM channel whose REST posts are
 *  captured. Discord's answer echoes the reference unless it names GONE, as
 *  Discord posts a reply to a missing target as a plain message. */
function adapterFixture(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  // A logged-out client has no user; the DM channel's recipient getter needs one.
  (client as unknown as { user: unknown }).user = { id: BOT };
  (client.channels as unknown as { _add(data: unknown): unknown })._add({
    id: 'dm1', type: ChannelType.DM, last_message_id: null,
    recipients: [{ id: 'u1', username: 'u1', discriminator: '0' }],
  });
  const bodies: Array<Record<string, unknown>> = [];
  let n = 0;
  t.mock.method(client.rest, 'post', async (_route: string, options: { body: Record<string, unknown> }) => {
    bodies.push(options.body);
    const ref = options.body.message_reference as { message_id: string } | undefined;
    return {
      id: `13000000000000001${String(++n).padStart(2, '0')}`, channel_id: 'dm1',
      author: { id: BOT, username: 'bot', discriminator: '0' },
      content: options.body.content, timestamp: new Date().toISOString(), edited_timestamp: null, tts: false,
      mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false,
      type: ref && ref.message_id !== GONE ? 19 : 0,
      ...(ref && ref.message_id !== GONE ? { message_reference: { channel_id: 'dm1', message_id: ref.message_id } } : {}),
    };
  });
  return { adapter, bodies };
}

const reference = (body: Record<string, unknown>) => body.message_reference as Record<string, unknown> | undefined;

describe('sendMessage reply target', () => {
  it('asks Discord not to fail the send when the reply target is missing, and says it was missing', async (t) => {
    const { adapter, bodies } = adapterFixture(t);
    const result = await adapter.sendMessage('dm1', 'hello there', { replyTo: GONE });
    assert.equal(bodies.length, 1);
    assert.equal(reference(bodies[0]!)!.message_id, GONE);
    assert.equal(reference(bodies[0]!)!.fail_if_not_exists, false);
    assert.equal(result.replyTargetMissing, true);
  });

  it('does not report a missing target when the reply threaded', async (t) => {
    const { adapter, bodies } = adapterFixture(t);
    const result = await adapter.sendMessage('dm1', 'hello there', { replyTo: '1200000000000000001' });
    assert.equal(reference(bodies[0]!)!.fail_if_not_exists, false);
    assert.deepEqual(result, { messageId: '1300000000000000101' });
  });

  it('only the first chunk of a long message is a reply', async (t) => {
    const { adapter, bodies } = adapterFixture(t);
    const result = await adapter.sendMessage('dm1', 'word '.repeat(900), { replyTo: '1200000000000000001' });
    assert.ok(bodies.length > 1, 'message was split');
    assert.equal(reference(bodies[0]!)!.message_id, '1200000000000000001');
    assert.equal(reference(bodies[0]!)!.fail_if_not_exists, false);
    for (const later of bodies.slice(1)) assert.equal(reference(later), undefined);
    assert.equal(result.replyTargetMissing, undefined, 'later chunks carry no reference by design');
  });

  it('sends without a reply when no target is given', async (t) => {
    const { adapter, bodies } = adapterFixture(t);
    const result = await adapter.sendMessage('dm1', 'hello there');
    assert.equal(reference(bodies[0]!), undefined);
    assert.equal(result.replyTargetMissing, undefined);
  });
});
