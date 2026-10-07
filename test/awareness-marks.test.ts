/**
 * The admin slash commands and the host's 💤 awareness marks
 * (agent-framework#250's `marks` host command).
 *
 * - /undo and /hide take an optional `marks` choice (none, addressed, all),
 *   passed to a host that has the `marks` verb, which places the marks and
 *   returns a `markers` receipt.
 * - A host without the verb places branch-following marks on undo that no
 *   option can make a one-shot act, so /undo is refused there. /hide there
 *   reacts 💤 itself only for `all`, and refuses `addressed`.
 * - /marks lists the journal and cancels, retracts or releases.
 *
 * The host is a stub answering host/command; Discord is a stub adapter.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';
import { describeMarkers, renderAwareness } from '../src/awareness-marks.js';

type Sent = Record<string, unknown>;

/** A host whose host/command answers are scripted; `marksVerb` decides how
 *  it answers the `marks` probe. */
function host(opts: {
  marksVerb: 'yes' | 'no' | 'error';
  answer?: (params: Sent) => unknown;
}) {
  const sent: Sent[] = [];
  const conn = {
    sendRequest: async (method: string, params: Sent) => {
      assert.equal(method, 'host/command');
      sent.push(params);
      if (params.command === 'marks' && params.action === 'list' && !params.requesterId) {
        if (opts.marksVerb === 'error') throw new Error('request timed out');
        return opts.marksVerb === 'yes'
          ? { ok: true, awareness: [] }
          : { ok: false, error: 'Unknown host command: marks' };
      }
      return opts.answer?.(params) ?? { ok: true };
    },
  };
  return { conn, sent, commands: () => sent.filter((p) => !(p.command === 'marks' && !p.requesterId)) };
}

function serverWith(conn: unknown) {
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const discord = {
    addReaction: async (channelId: string, messageId: string, emoji: string) => {
      reactions.push({ channelId, messageId, emoji });
    },
  };
  const server = new DiscordMcplServer(discord as unknown as DiscordAdapter) as unknown as {
    conn: unknown;
    handleSlashCommand(i: unknown): Promise<void>;
  };
  server.conn = conn;
  return { server, reactions };
}

/** A slash interaction from an admin, recording what it was answered. */
function interaction(commandName: string, options: Record<string, string | number | undefined>) {
  const out: { replies: string[]; deferred?: unknown; ephemeral: boolean[] } = { replies: [], ephemeral: [] };
  return {
    out,
    value: {
      commandName,
      user: { id: 'admin-1', username: 'Admin' },
      channelId: 'c1',
      options: {
        getInteger: (name: string) => (typeof options[name] === 'number' ? options[name] : null),
        getString: (name: string, required?: boolean) => {
          const v = options[name];
          if (v === undefined && required) throw new Error(`missing ${name}`);
          return typeof v === 'string' ? v : null;
        },
      },
      deferReply: async (o?: { flags?: unknown }) => { out.deferred = o ?? {}; },
      editReply: async (content: string) => { out.replies.push(content); },
      reply: async (o: { content: string; flags?: unknown }) => { out.replies.push(o.content); out.ephemeral.push(o.flags !== undefined); },
    },
  };
}

async function asAdmin<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DISCORD_ADMIN_USERS;
  process.env.DISCORD_ADMIN_USERS = 'admin-1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DISCORD_ADMIN_USERS;
    else process.env.DISCORD_ADMIN_USERS = previous;
  }
}

const undoAnswer = (markers: unknown) => (p: Sent) =>
  p.command === 'undo' ? { ok: true, messagesRemoved: 2, markers, lastVisible: null } : { ok: true };

describe('/undo and the marks choice', () => {
  it('is refused on a host without the marks verb, whatever the option, and nothing is undone', async () => {
    for (const marks of [undefined, 'none', 'addressed', 'all']) {
      const h = host({ marksVerb: 'no' });
      const { server } = serverWith(h.conn);
      const i = interaction('undo', { messages: 2, marks });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal(h.commands().length, 0, `marks=${marks}: no undo sent`);
      assert.match(i.out.replies.at(-1)!, /Undo refused: this host can't make awareness marks a choice/);
    }
  });

  it('is not sent when the probe proves nothing, and asks again next time', async () => {
    const h = host({ marksVerb: 'error' });
    const { server } = serverWith(h.conn);
    const first = interaction('undo', {});
    await asAdmin(() => server.handleSlashCommand(first.value));
    assert.match(first.out.replies.at(-1)!, /Undo not sent: couldn't confirm .*request timed out/);
    const second = interaction('undo', {});
    await asAdmin(() => server.handleSlashCommand(second.value));
    assert.equal(h.sent.filter((p) => p.command === 'marks').length, 2, 'an unproven answer is not kept');
    assert.equal(h.commands().length, 0);
  });

  it('sends no marks when none are chosen, and probes once per connection', async () => {
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 }) });
    const { server } = serverWith(h.conn);
    for (let n = 0; n < 2; n++) {
      const i = interaction('undo', { messages: 2 });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.match(i.out.replies.at(-1)!, /Removed the last \*\*2\*\*/);
      assert.match(i.out.replies.at(-1)!, /Marks: none \(not chosen\)\./);
    }
    const undos = h.commands();
    assert.equal(undos.length, 2);
    for (const u of undos) assert.equal('marks' in u, false);
    assert.equal(h.sent.filter((p) => p.command === 'marks').length, 1, 'one probe per connection');
  });

  it('passes a chosen scope and reports what the receipt says, no more', async () => {
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'addressed', unmarked: 1, notRemoved: 0, status: 'queued', queued: 3, batchId: 'b-7' }) });
    const { server } = serverWith(h.conn);
    const i = interaction('undo', { messages: 4, marks: 'addressed' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0].marks, 'addressed');
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /3 💤 marks requested \(addressed; batch `b-7`\) — not yet confirmed on Discord/);
    assert.match(reply, /1 removed message outside that scope left unmarked/);
  });
});

describe('/hide and the marks choice', () => {
  const hidden = [{ channelId: 'discord:g1:c1', messageId: 'm1' }, { channelId: 'c1', messageId: 'm2' }];

  it('on a host with the verb, passes the choice and never reacts itself', async () => {
    const h = host({
      marksVerb: 'yes',
      answer: (p) => p.command === 'hide'
        ? { ok: true, hidden: 2, hiddenRefs: hidden, markers: { scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 2, batchId: 'b-9' } }
        : { ok: true },
    });
    const { server, reactions } = serverWith(h.conn);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0].marks, 'all');
    assert.deepEqual(reactions, []);
    assert.match(i.out.replies.at(-1)!, /2 💤 marks requested \(all; batch `b-9`\)/);
  });

  it('on an older host, reacts itself only for `all`, refuses `addressed`, and marks nothing otherwise', async () => {
    const answer = (p: Sent) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden } : { ok: true });

    const all = host({ marksVerb: 'no', answer });
    const a = serverWith(all.conn);
    const ia = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => a.server.handleSlashCommand(ia.value));
    assert.equal('marks' in all.commands()[0], false, 'an older host is not sent a choice it cannot read');
    assert.deepEqual(a.reactions.map((r) => [r.channelId, r.messageId, r.emoji]), [['c1', 'm1', '💤'], ['c1', 'm2', '💤']]);
    assert.match(ia.out.replies.at(-1)!, /reacted 💤 itself on 2 of 2/);

    const addressed = host({ marksVerb: 'no', answer });
    const b = serverWith(addressed.conn);
    const ib = interaction('hide', { message: '111111111111111111', marks: 'addressed' });
    await asAdmin(() => b.server.handleSlashCommand(ib.value));
    assert.equal(addressed.commands().length, 0, 'nothing hidden');
    assert.match(ib.out.replies.at(-1)!, /`marks: addressed` isn't available here/);

    const none = host({ marksVerb: 'no', answer });
    const c = serverWith(none.conn);
    const ic = interaction('hide', { message: '111111111111111111' });
    await asAdmin(() => c.server.handleSlashCommand(ic.value));
    assert.deepEqual(c.reactions, []);
    assert.match(ic.out.replies.at(-1)!, /Marks: none \(not chosen\)\./);
  });
});

describe('/marks', () => {
  const journal = [
    { kind: 'batch', id: 'b-1', status: 'active', scope: 'all', agentName: 'lena', refs: 3, adds: { delivered: 2, queued: 1 }, removals: {}, unresolvedAttempts: 0 },
    { kind: 'retract', id: 'r-1', target: 'b-0', removals: { delivered: 4 }, unresolvedAttempts: 1 },
  ];

  it('lists the journal, ephemerally', async () => {
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'list' ? { ok: true, awareness: journal } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'list' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.ok(i.out.deferred && (i.out.deferred as { flags?: unknown }).flags !== undefined, 'deferred ephemerally');
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /batch `b-1` — active, all, 3 messages \(lena\): adds delivered 2, queued 1; removals none/);
    assert.match(reply, /retract `r-1` → b-0: removals delivered 4; 1 unresolved/);
  });

  it('passes an action and its target, and needs a target for anything but list', async () => {
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'retract' ? { ok: true, awareness: [journal[1]] } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const missing = interaction('marks', { action: 'retract' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.match(missing.out.replies.at(-1)!, /needs a target: a batch id, or `all`/);
    assert.equal(h.commands().length, 0);

    const i = interaction('marks', { action: 'retract', target: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(
      { command: h.commands()[0].command, action: h.commands()[0].action, target: h.commands()[0].target },
      { command: 'marks', action: 'retract', target: 'all' },
    );
    assert.match(i.out.replies.at(-1)!, /✅ \/marks retract `all` done\./);
  });

  it("reports the host's refusal with its code, and explains an older host", async () => {
    const busy = host({ marksVerb: 'yes', answer: () => ({ ok: false, error: 'an agent sharing the store is mid-turn', code: 'agent-busy' }) });
    const a = serverWith(busy.conn);
    const ia = interaction('marks', { action: 'release', target: 'b-1' });
    await asAdmin(() => a.server.handleSlashCommand(ia.value));
    assert.match(ia.out.replies.at(-1)!, /\/marks release failed \(agent-busy\): an agent sharing the store is mid-turn/);

    const old = host({ marksVerb: 'no' });
    const b = serverWith(old.conn);
    const ib = interaction('marks', { action: 'list' });
    await asAdmin(() => b.server.handleSlashCommand(ib.value));
    assert.match(ib.out.replies.at(-1)!, /doesn't have awareness-mark controls/);
  });
});

describe('rendering', () => {
  it('describes every receipt status without claiming delivery', () => {
    assert.match(describeMarkers(undefined), /reported nothing/);
    assert.match(describeMarkers({ scope: 'addressed', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }), /nothing removed fell within "addressed"/);
    assert.match(describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 2, status: 'not-scheduled', queued: 0, error: 'journal full' }), /not scheduled — journal full\. None will be placed\. \(2 chosen messages not removed, so not marked\)/);
    assert.match(describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 0, status: 'unresolved', queued: 0, batchId: 'b-2', error: 'disk' }), /may still be delivered later/);
  });

  it('caps a long journal', () => {
    const views = Array.from({ length: 20 }, (_, n) => ({ kind: 'retract' as const, id: `r-${n}`, target: 'all', removals: {} }));
    const text = renderAwareness(views);
    assert.match(text, /… and 8 more$/);
    assert.equal(renderAwareness([]), 'No awareness-mark batches or retracts in the journal.');
  });
});

describe('registration', () => {
  it('offers the marks choice on /undo and /hide, and registers /marks', async () => {
    let registered: Array<{ name: string; options?: Array<{ name: string; choices?: Array<{ value: string }> }> }> = [];
    const discord = {
      onSlashCommand: () => undefined,
      registerGuildCommands: async (commands: typeof registered) => { registered = commands; },
    };
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    await server.setupSlashCommands();
    for (const name of ['undo', 'hide']) {
      const marks = registered.find((c) => c.name === name)?.options?.find((o) => o.name === 'marks');
      assert.deepEqual(marks?.choices?.map((c) => c.value), ['none', 'addressed', 'all'], name);
    }
    const marksCommand = registered.find((c) => c.name === 'marks');
    assert.deepEqual(marksCommand?.options?.find((o) => o.name === 'action')?.choices?.map((c) => c.value), ['list', 'cancel', 'retract', 'release']);
    assert.ok(marksCommand?.options?.some((o) => o.name === 'target'));
  });
});
