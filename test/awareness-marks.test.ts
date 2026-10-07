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
import { boundedReply, describeMarkers, paginate, renderListPage, REPLY_LIMIT, type AwarenessView } from '../src/awareness-marks.js';

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
  const out: { replies: string[]; files: Array<{ attachment: Buffer; name: string }[]>; deferred?: unknown; ephemeral: boolean[] } = {
    replies: [],
    files: [],
    ephemeral: [],
  };
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
      editReply: async (o: string | { content: string; files: Array<{ attachment: Buffer; name: string }> }) => {
        if (typeof o === 'string') out.replies.push(o);
        else { out.replies.push(o.content); out.files.push(o.files); }
      },
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

  it('on a host with the verb that omits its receipt, reports marks unreported and never supplements them', async () => {
    const h = host({ marksVerb: 'yes', answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden } : { ok: true }) });
    const { server, reactions } = serverWith(h.conn);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(reactions, []);
    assert.match(i.out.replies.at(-1)!, /Marks: this host reported nothing about 💤 marks\./);
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

// Shapes as agent-framework#250 (dc2928c, unchanged at 485a3c7) produces them:
// DiscordAwarenessBatchView / RetractView, and each action's receipt.
const batch = (n: number, extra: Partial<Record<string, unknown>> = {}): AwarenessView => ({
  kind: 'batch',
  id: `batch-${String(n).padStart(4, '0')}-1f2e3d4c-5b6a-4789-9abc-def012345678`,
  status: 'active',
  scope: 'all',
  agentName: 'lena',
  sourceBranch: 'main',
  targetBranch: `undo-msgs/lena/${1760000000000 + n}`,
  emoji: '💤',
  createdAt: 1760000000000 + n * 1000,
  refs: 3,
  adds: { requested: 1, dispatching: 0, confirmed: 2, failed: 0, unknown: 0, cancelled: 0 },
  removals: { requested: 0, dispatching: 0, confirmed: 0, failed: 0, unknown: 0, cancelled: 0 },
  unresolvedAttempts: 0,
  ...extra,
} as AwarenessView);
const retractView = (at: number): AwarenessView => ({
  kind: 'retract',
  id: 'retract-9f8e7d6c-5b4a-4321-8fed-cba987654321',
  target: 'all',
  at,
  by: 'Admin',
  removals: { requested: 2, dispatching: 0, confirmed: 4, failed: 0, unknown: 1, cancelled: 0 },
  unresolvedAttempts: 1,
});

describe('/marks', () => {
  const listing = (views: AwarenessView[]) => (p: Sent) => (p.action === 'list' ? { ok: true, awareness: views } : { ok: true });

  it('lists the journal newest first, ephemerally, keeping imported evidence', async () => {
    const views = [
      batch(1, { legacy: { entries: 2, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 3 } }),
      batch(2, { status: 'held', held: { reason: 'branch switched while prepared', at: 1760000005000, releaseActions: 2 } }),
      retractView(1760000009000),
    ];
    const h = host({ marksVerb: 'yes', answer: listing(views) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'list' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.ok(i.out.deferred && (i.out.deferred as { flags?: unknown }).flags !== undefined, 'deferred ephemerally');
    const reply = i.out.replies.at(-1)!;
    const lines = reply.split('\n');
    assert.match(lines[0]!, /page 1 of 1, 3 entries, newest first/);
    assert.match(lines[1]!, /retract `retract-9f8e.*` → all: removals requested 2, confirmed 4, unknown 1; 1 unresolved/);
    assert.match(lines[2]!, /batch `batch-0002.*` — held, all, 3 messages \(lena\): adds requested 1, confirmed 2; removals none; held: branch switched/);
    assert.match(lines[3]!, /batch `batch-0001.*imported history \(3 unrecorded outcomes\)/);
    assert.ok(reply.length <= REPLY_LIMIT);
  });

  it('pages a long journal within one reply each, every entry reachable', async () => {
    const reason = 'x'.repeat(600);
    const views = [
      ...Array.from({ length: 13 }, (_, n) => batch(n + 1, { status: 'held', held: { reason, at: 1, releaseActions: 1 } })),
      retractView(1),
    ];
    const pages = paginate(views);
    assert.ok(pages.length > 1);
    const shown = new Set<string>();
    for (let p = 1; p <= pages.length; p++) {
      const page = renderListPage(views, p);
      assert.ok(page.length <= REPLY_LIMIT, `page ${p}: ${page.length} chars`);
      for (const v of views) if (page.includes(`\`${v.id}\``)) shown.add(v.id);
      assert.match(page, p < pages.length ? /`\/marks list page:\d+` for the next page/ : /for the first page/);
    }
    assert.equal(shown.size, views.length, 'every batch and the retract appear on some page');
    assert.match(renderListPage(views, 1), /batch-0013/, 'the newest batch leads');
    assert.match(renderListPage(views, pages.length + 1), /there is no page/);

    const h = host({ marksVerb: 'yes', answer: listing(views) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'list', page: 2 });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.match(i.out.replies.at(-1)!, /page 2 of/);
    assert.equal('target' in h.commands()[0]!, false, 'the host lists everything; paging is here');
  });

  it('shows one entry in full by id, cutting a long one visibly with the record attached', async () => {
    const long = batch(5, {
      status: 'held',
      held: { reason: 'r'.repeat(2500), at: 1760000005000, releaseActions: 2 },
      legacy: { entries: 1, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 2 },
    });
    const views = [batch(4), long];
    const h = host({ marksVerb: 'yes', answer: listing(views) });
    const { server } = serverWith(h.conn);

    const short = interaction('marks', { action: 'list', target: views[0]!.id });
    await asAdmin(() => server.handleSlashCommand(short.value));
    assert.match(short.out.replies.at(-1)!, /\*\*Batch `batch-0004.*`\*\* — active; all for lena; 3 messages/);
    assert.equal(short.out.files.length, 0);

    const i = interaction('marks', { action: 'list', target: long.id });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.ok(reply.length <= REPLY_LIMIT, `${reply.length} chars`);
    assert.match(reply, /cut to fit one message; the whole answer is attached as JSON/);
    const attached = JSON.parse(i.out.files.at(-1)![0]!.attachment.toString('utf8'));
    assert.equal(attached[0].held.reason.length, 2500);
    assert.deepEqual(attached[0].legacy, { entries: 1, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 2 });

    const missing = interaction('marks', { action: 'list', target: 'nope' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.match(missing.out.replies.at(-1)!, /No batch or retract `nope` in the journal/);
  });

  it("renders cancel's receipt, keeping what cancel can't undo", async () => {
    const receipt = { target: 'batch-1', kind: 'batch', cancelled: 2, heldDropped: 1, inFlight: 1, unknown: 1, confirmed: 3, unresolvedAttempts: 2, legacyOutcomesUnrecorded: 1 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: receipt } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'cancel', target: 'batch-1' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0]!.target, 'batch-1');
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /Cancelled batch `batch-1`: 2 requests will now never be sent, and 1 held release action dropped\./);
    assert.match(reply, /Cancel removes nothing from Discord: 3 already confirmed on Discord stay as they are; 1 on the wire may still land; 1 with unknown outcome may have landed; 2 unresolved attempts in all; 1 imported attempt with unrecorded outcomes may have landed\./);
    assert.match(reply, /`\/marks retract target:batch-1`/);
  });

  it("renders retract's and release's receipts as requested, not confirmed", async () => {
    const retract = { requestId: 'r-1', removalsQueued: 4, addsSuperseded: 1, keysWithUnresolvedAdds: 2, unresolvedAddAttempts: 3, keysWithLegacyUncertainty: 1 };
    const release = { batchId: 'b-1', addsQueued: 2, removalsQueued: 0 };
    const h = host({
      marksVerb: 'yes',
      answer: (p) => (p.action === 'retract' ? { ok: true, awareness: retract } : p.action === 'release' ? { ok: true, awareness: release } : { ok: true }),
    });
    const { server } = serverWith(h.conn);

    const missing = interaction('marks', { action: 'retract' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.match(missing.out.replies.at(-1)!, /needs a target: a batch id, or `all`/);
    assert.equal(h.commands().length, 0);

    const r = interaction('marks', { action: 'retract', target: 'all' });
    await asAdmin(() => server.handleSlashCommand(r.value));
    assert.deepEqual(
      { command: h.commands()[0]!.command, action: h.commands()[0]!.action, target: h.commands()[0]!.target },
      { command: 'marks', action: 'retract', target: 'all' },
    );
    const rr = r.out.replies.at(-1)!;
    assert.match(rr, /Retract `r-1`: 4 💤 removals requested — not yet confirmed on Discord; 1 unsent add superseded\./);
    assert.match(rr, /2 messages have earlier add attempts still unresolved \(3 attempts\): such an add may land after its removal\./);
    assert.match(rr, /1 message has imported history with unrecorded outcomes\./);

    const l = interaction('marks', { action: 'release', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(l.value));
    assert.match(l.out.replies.at(-1)!, /Released held batch `b-1`: 2 adds and 0 removals requested — not yet confirmed on Discord\./);
  });

  it('shows a shape it cannot read as sent, bounded, never misread', async () => {
    const odd = { batchId: 'b-1', something: 'new'.repeat(900) };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: odd } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'cancel', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /answered \/marks cancel in a shape this server can't read/);
    assert.ok(reply.length <= REPLY_LIMIT);
    assert.deepEqual(JSON.parse(i.out.files.at(-1)![0]!.attachment.toString('utf8')), odd);
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

  it('fits a long reply into one message, cut visibly with the whole text attached', () => {
    assert.equal(boundedReply('short'), 'short');
    const long = boundedReply('y'.repeat(5000));
    assert.ok(typeof long !== 'string');
    assert.ok(long.content.length <= REPLY_LIMIT);
    assert.match(long.content, /cut to fit one message; the whole reply is attached\)$/);
    assert.equal(long.files[0]!.attachment.toString('utf8').length, 5000);
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
    assert.ok(marksCommand?.options?.some((o) => o.name === 'page'));
  });
});
