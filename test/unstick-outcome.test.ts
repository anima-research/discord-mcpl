/**
 * After /unstick, a host that says it can (`outcome: true`) answers a second
 * request when the session ends. The failure's labels then go to the person
 * who ran the command alone, in an ephemeral follow-up, and to no log.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';

type Sent = Record<string, unknown>;
const TOKEN_MS = 15 * 60_000;

/** Each outcome request takes the next answer, called if it is a function; with none left, the request fails. */
function host(ack: unknown, ...answers: unknown[]) {
  const sent: Array<{ params: Sent; timeout?: number }> = [];
  const conn = {
    sendRequest: async (method: string, params: Sent, timeout?: number) => {
      assert.equal(method, 'host/command');
      sent.push({ params, timeout });
      if (params.command === 'unstick') return ack;
      if (params.command !== 'unstick-outcome') throw new Error(`unexpected ${String(params.command)}`);
      if (answers.length === 0) throw new Error('no answer left in this test');
      const next = answers.shift();
      return typeof next === 'function' ? next(params) : next;
    },
  };
  return { conn, sent, outcomeRequests: () => sent.filter((s) => s.params.command === 'unstick-outcome') };
}

function interaction(opts: { createdAgoMs?: number; refuseFollowUp?: boolean } = {}) {
  const out: { edits: string[]; followUps: Array<{ content: string; flags?: unknown }> } = { edits: [], followUps: [] };
  return {
    out,
    value: {
      commandName: 'unstick',
      createdTimestamp: Date.now() - (opts.createdAgoMs ?? 1_000),
      user: { id: 'admin-1', username: 'Admin' },
      channelId: 'c1',
      options: { getInteger: () => null, getString: () => null },
      deferReply: async () => {},
      editReply: async (o: string) => { out.edits.push(o); },
      reply: async () => {},
      followUp: async (o: { content: string; flags?: unknown }) => {
        if (opts.refuseFollowUp) throw new Error('Unknown interaction');
        out.followUps.push(o);
      },
    },
  };
}

async function run(conn: unknown, i: ReturnType<typeof interaction>): Promise<void> {
  const server = new DiscordMcplServer({} as unknown as DiscordAdapter) as unknown as {
    conn: unknown;
    handleSlashCommand(i: unknown): Promise<void>;
  };
  server.conn = conn;
  const previous = process.env.DISCORD_ADMIN_USERS;
  process.env.DISCORD_ADMIN_USERS = 'admin-1';
  try {
    await server.handleSlashCommand(i.value);
  } finally {
    if (previous === undefined) delete process.env.DISCORD_ADMIN_USERS;
    else process.env.DISCORD_ADMIN_USERS = previous;
  }
}

const ACK = { ok: true, started: true, cap: 3, outcome: true, agentName: 'resident-a' };
const EPHEMERAL = 64;

describe('/unstick outcome to the person who ran it', () => {
  it('asks for the outcome of the agent that the acknowledgement names, within the token', async () => {
    const h = host(ACK, () => ({ ok: true, outcome: 'cleared', rewinds: 1 }));
    const i = interaction({ createdAgoMs: 60_000 });
    await run(h.conn, i);
    const asks = h.outcomeRequests();
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].params, { command: 'unstick-outcome', agentName: 'resident-a' });
    assert.ok(asks[0].timeout! <= TOKEN_MS - 60_000 && asks[0].timeout! > TOKEN_MS - 70_000, `timeout ${asks[0].timeout}`);
    assert.match(i.out.edits[0], /I'll post the result here\./);
    assert.deepEqual(i.out.followUps, []);
  });

  it('sends the refusal category in one ephemeral follow-up', async () => {
    const h = host(ACK, () => ({ ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'cyber' } }));
    const i = interaction();
    await run(h.conn, i);
    assert.equal(h.outcomeRequests().length, 1);
    assert.deepEqual(i.out.followUps, [{ content: 'The provider refused each rerun. Category: `cyber`.', flags: EPHEMERAL }]);
  });

  it("sends a failed turn's labels where the answer has them, and says the unstick goes on", async () => {
    const goesOn = ' The unstick stays in force: the agent\'s next turn continues it, and its result comes in the channel.';
    for (const [cause, labels] of [
      [{ kind: 'failure', type: 'overloaded_error', status: 529 }, ' Type: `overloaded_error`, HTTP 529.'],
      [{ kind: 'failure', type: 'api_error' }, ' Type: `api_error`.'],
      [{ kind: 'failure', type: '', status: 500 }, ' HTTP 500.'],
      [{ kind: 'failure', type: '' }, ''],
      [{ kind: 'failure', status: 503 }, ' HTTP 503.'],
      [{ kind: 'failure' }, ''],
      [undefined, ''],
    ] as const) {
      const i = interaction();
      await run(host(ACK, () => ({ ok: true, outcome: 'turn-failed', rewinds: 1, ...(cause ? { cause } : {}) })).conn, i);
      assert.deepEqual(i.out.followUps, [{ content: `The rerun's turn failed.${labels}${goesOn}`, flags: EPHEMERAL }], JSON.stringify(cause));
    }
  });

  it('says when the agent or the host ended first', async () => {
    const agentEnded = interaction();
    await run(host(ACK, () => ({ ok: true, outcome: 'agent-ended', rewinds: 0 })).conn, agentEnded);
    assert.deepEqual(agentEnded.out.followUps, [{ content: 'The agent ended before the unstick did.', flags: EPHEMERAL }]);
    const hostStopped = interaction();
    await run(host(ACK, () => ({ ok: true, outcome: 'host-stopped', rewinds: 0 })).conn, hostStopped);
    assert.deepEqual(hostStopped.out.followUps, [{ content: 'The host stopped before the unstick ended.', flags: EPHEMERAL }]);
  });

  it('sends nothing for no outcome, or for an answer that names no known end or cause', async () => {
    for (const answer of [
      { ok: false, error: 'no unstick outcome for resident-a' },
      { ok: true, outcome: 'gave-up', rewinds: 3 },
      { ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal' } },
      { ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: '' } },
      { ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'failure', type: 'api_error' } },
      { ok: true, outcome: 'something-new', rewinds: 1 },
      { ok: true, end: 'agent-ended', rewinds: 0 },
    ]) {
      const h = host(ACK, () => answer);
      const i = interaction();
      await run(h.conn, i);
      assert.equal(h.outcomeRequests().length, 1, JSON.stringify(answer));
      assert.deepEqual(i.out.followUps, [], JSON.stringify(answer));
    }
  });

  it('ends quietly when the outcome request fails or Discord refuses the follow-up', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const timedOut = host(ACK, () => { throw new Error('Request timed out'); });
      const i1 = interaction();
      await run(timedOut.conn, i1);
      assert.equal(timedOut.outcomeRequests().length, 1);
      assert.deepEqual(i1.out.followUps, []);
      assert.equal(i1.out.edits.length, 1);

      const refused = host(ACK, () => ({ ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'cyber' } }));
      const i2 = interaction({ refuseFollowUp: true });
      await run(refused.conn, i2);
      assert.equal(refused.outcomeRequests().length, 1);
      assert.equal(i2.out.edits.length, 1);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('asks again after a failed turn, and sends a line only when it differs from the last one sent', async () => {
    const failed = (type: string, status: number) => ({ ok: true, outcome: 'turn-failed', rewinds: 1, cause: { kind: 'failure', type, status } });
    const h = host(ACK, failed('overloaded_error', 529), failed('overloaded_error', 529), failed('api_error', 503),
      { ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'cyber' } });
    const i = interaction();
    await run(h.conn, i);
    const asks = h.outcomeRequests();
    assert.equal(asks.length, 4);
    for (const ask of asks) assert.deepEqual(ask.params, { command: 'unstick-outcome', agentName: 'resident-a' });
    for (let n = 1; n < asks.length; n++) assert.ok(asks[n].timeout! <= asks[n - 1].timeout!, `timeout ${n}`);
    const goesOn = ' The unstick stays in force: the agent\'s next turn continues it, and its result comes in the channel.';
    assert.deepEqual(i.out.followUps.map((f) => f.content), [
      `The rerun's turn failed. Type: \`overloaded_error\`, HTTP 529.${goesOn}`,
      `The rerun's turn failed. Type: \`api_error\`, HTTP 503.${goesOn}`,
      'The provider refused each rerun. Category: `cyber`.',
    ]);
  });

  it('stops asking once the token has run out, and when a follow-up after a failed turn is refused', async () => {
    const failed = { ok: true, outcome: 'turn-failed', rewinds: 1, cause: { kind: 'failure', type: 'overloaded_error', status: 529 } };
    const i = interaction();
    const h = host(ACK, () => { i.value.createdTimestamp = Date.now() - TOKEN_MS - 1; return failed; }, failed);
    await run(h.conn, i);
    assert.equal(h.outcomeRequests().length, 1);
    assert.equal(i.out.followUps.length, 1);
    const refused = host(ACK, failed, failed);
    await run(refused.conn, interaction({ refuseFollowUp: true }));
    assert.equal(refused.outcomeRequests().length, 1);
  });

  it('writes no category, type or status to the debug log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unstick-outcome-'));
    const log = join(dir, 'debug.log');
    const previous = process.env.DISCORD_MCPL_DEBUG_LOG;
    process.env.DISCORD_MCPL_DEBUG_LOG = log;
    try {
      const refusal = interaction();
      await run(host(ACK, () => ({ ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'label-cat-7f3a' } })).conn, refusal);
      const api = interaction();
      await run(host(ACK, () => ({ ok: true, outcome: 'turn-failed', rewinds: 1, cause: { kind: 'failure', type: 'label-type-9c2e', status: 7919 } })).conn, api);
      const unsent = interaction({ refuseFollowUp: true });
      await run(host(ACK, () => ({ ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'label-cat-5b1d' } })).conn, unsent);
      assert.equal(refusal.out.followUps.length, 1);
      assert.equal(api.out.followUps.length, 1);
      const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      assert.match(text, /slash:unstick /);
      for (const label of ['label-cat-7f3a', 'label-type-9c2e', '7919', 'label-cat-5b1d']) {
        assert.ok(!text.includes(label), `debug log holds ${label}`);
      }
    } finally {
      if (previous === undefined) delete process.env.DISCORD_MCPL_DEBUG_LOG;
      else process.env.DISCORD_MCPL_DEBUG_LOG = previous;
    }
  });

  it('sends no second request to a host that does not say it can, or when the token has ended', async () => {
    for (const ack of [
      { ok: true, started: true, cap: 3 },
      { ok: true, started: true, cap: 3, outcome: true },
      { ok: true, started: true, cap: 3, outcome: true, agentName: '' },
    ]) {
      const h = host(ack, () => ({ ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'cyber' } }));
      const i = interaction();
      await run(h.conn, i);
      assert.equal(h.sent.length, 1, JSON.stringify(ack));
      assert.deepEqual(i.out.followUps, []);
      assert.match(i.out.edits[0], /I'll post the result here\./);
    }
    const late = host(ACK, () => ({ ok: true, outcome: 'gave-up', rewinds: 3, cause: { kind: 'refusal', category: 'cyber' } }));
    await run(late.conn, interaction({ createdAgoMs: TOKEN_MS + 1_000 }));
    assert.equal(late.outcomeRequests().length, 0);
  });
});
