/**
 * Durable state behind DM refusal notices: once per message, at most once a
 * day per sender, nothing for messages older than the state, reservation
 * before send, and suspension when the state can't be persisted.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmodSync, existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DM_NOTICE_WINDOW_MS,
  DmNoticeState,
  resolveDmNoticesPath,
  snowflakeAt,
} from '../src/dm-notices.js';

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function fixture(t: TestContext, start = T0) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-notices-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state', 'dm-notices.json');
  let now = start;
  const clock = { set: (ms: number) => { now = ms; } };
  const interrupted: Array<{ authorId: string; messageId: string; at: number }> = [];
  const make = () => new DmNoticeState({ now: () => now, onInterrupted: (i) => interrupted.push(i) });
  return { dir, path, clock, make, interrupted };
}

/** A message id Discord could assign at `ms` (plus a small increment). */
const idAt = (ms: number, n = 0) => (BigInt(snowflakeAt(ms)) + BigInt(n)).toString();

describe('DM notice state', () => {
  it('notifies once per sender per day, and the reservation is on disk before the send', (t) => {
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    assert.equal(state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    const onDisk = JSON.parse(readFileSync(f.path, 'utf-8'));
    assert.deepEqual(
      onDisk.senders.stranger.lastNotice,
      { messageId: idAt(T0 + 1000), at: T0, outcome: 'pending' },
      'reserved before the caller sends',
    );
    state.recordOutcome('stranger', idAt(T0 + 1000), 'sent');
    assert.equal(JSON.parse(readFileSync(f.path, 'utf-8')).senders.stranger.lastNotice.outcome, 'sent');

    f.clock.set(T0 + HOUR);
    assert.equal(state.decide(idAt(T0 + HOUR), 'stranger'), 'rate-limited');
    assert.equal(state.decide(idAt(T0 + HOUR, 1), 'other'), 'notify', 'the limit is per sender');

    f.clock.set(T0 + DM_NOTICE_WINDOW_MS);
    assert.equal(state.decide(idAt(T0 + DM_NOTICE_WINDOW_MS), 'stranger'), 'notify');
  });

  it('keeps the limit across a restart', (t) => {
    const f = fixture(t);
    const first = f.make();
    first.open(f.path);
    assert.equal(first.decide(idAt(T0 + 1000), 'stranger'), 'notify');

    f.clock.set(T0 + 2 * HOUR);
    const second = f.make();
    second.open(f.path);
    assert.equal(second.decide(idAt(T0 + 2 * HOUR), 'stranger'), 'rate-limited');
  });

  it('settles a reservation interrupted before its outcome as unknown, reports it once, and never retries it', (t) => {
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    assert.equal(state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    // The process dies here, after the reservation and before any outcome.
    f.clock.set(T0 + HOUR);
    const restarted = f.make();
    restarted.open(f.path);
    assert.deepEqual(f.interrupted, [{ authorId: 'stranger', messageId: idAt(T0 + 1000), at: T0 }], 'reported once');
    assert.equal(JSON.parse(readFileSync(f.path, 'utf-8')).senders.stranger.lastNotice.outcome, 'unknown');
    assert.equal(restarted.decide(idAt(T0 + HOUR), 'stranger'), 'rate-limited', 'not retried inside its window');
    const again = f.make();
    again.open(f.path);
    assert.equal(f.interrupted.length, 1, 'an unknown outcome is not re-reported');
  });

  it('never handles the same or an older message twice, even after the window', (t) => {
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    const m1 = idAt(T0 + 1000);
    const m2 = idAt(T0 + 2000);
    assert.equal(state.decide(m1, 'stranger'), 'notify');
    f.clock.set(T0 + 2 * DM_NOTICE_WINDOW_MS);
    // A duplicate gateway event, or a catch-up re-scan after a restart.
    const reopened = f.make();
    reopened.open(f.path);
    assert.equal(reopened.decide(m1, 'stranger'), 'already-handled');
    assert.equal(reopened.decide(m2, 'stranger'), 'notify', 'a genuinely new message after the window');
    assert.equal(reopened.decide(m1, 'stranger'), 'already-handled');
  });

  it('never notifies for a message older than the state, whatever path it arrives on', (t) => {
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    assert.equal(state.decide(idAt(T0 - HOUR), 'old-correspondent'), 'before-floor');
    assert.equal(state.decide(idAt(T0 + 1), 'old-correspondent'), 'notify');
  });

  it('gives a state created late the startup boundary as its floor', (t) => {
    const f = fixture(t);
    f.clock.set(T0 + HOUR); // the file is only created now, at first use
    const state = f.make();
    state.open(f.path, { floorAt: T0 });
    assert.equal(state.decide(idAt(T0 + 5), 'first-knocker'), 'notify', 'arrived after startup, before the file existed');
    assert.equal(state.decide(idAt(T0 - 5), 'earlier-knocker'), 'before-floor', 'arrived before startup');
    const reopened = f.make();
    reopened.open(f.path, { floorAt: T0 + 2 * HOUR });
    assert.equal(JSON.parse(readFileSync(f.path, 'utf-8')).floorId, snowflakeAt(T0), 'an existing file keeps its own floor');
  });

  it('records silenced refusals, so lifting the silence does not notify old messages', (t) => {
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    state.setEnabled(false);
    const m1 = idAt(T0 + 1000);
    assert.equal(state.decide(m1, 'stranger'), 'silenced');
    state.setEnabled(true);
    assert.equal(state.decide(m1, 'stranger'), 'already-handled');
    assert.equal(state.decide(idAt(T0 + 2000), 'stranger'), 'notify', 'silence reserved no window');
  });

  it('keeps the resident\'s setting across a restart, in the same file', (t) => {
    const f = fixture(t);
    const first = f.make();
    first.open(f.path);
    assert.equal(first.status().enabled, true, 'on by default');
    first.setEnabled(false);
    const second = f.make();
    second.open(f.path);
    assert.equal(second.status().enabled, false);
    assert.equal(second.decide(idAt(T0 + 1000), 'stranger'), 'silenced');
    assert.equal(JSON.parse(readFileSync(f.path, 'utf-8')).enabled, false);
  });

  it('suspends notices while the state file is invalid, without touching it, and resumes once it is removed', (t) => {
    const f = fixture(t);
    const state = f.make();
    state.open(f.path); // creates it
    writeFileSync(f.path, '{ not json');
    const broken = f.make();
    broken.open(f.path);
    assert.equal(broken.status().persisted, false);
    assert.match(broken.status().error ?? '', /./);
    assert.equal(broken.decide(idAt(T0 + 1000), 'stranger'), 'suspended');
    assert.equal(readFileSync(f.path, 'utf-8'), '{ not json', 'an invalid file is left for the operator');

    rmSync(f.path);
    f.clock.set(T0 + HOUR);
    assert.equal(broken.decide(idAt(T0 + HOUR, 1), 'stranger'), 'notify');
    assert.equal(broken.status().persisted, true);
  });

  it('suspends notices when the reservation cannot be written', (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('needs POSIX permissions as non-root');
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    const stateDir = join(f.path, '..');
    chmodSync(stateDir, 0o500);
    try {
      assert.equal(state.decide(idAt(T0 + 1000), 'stranger'), 'suspended');
      assert.equal(state.status().persisted, false);
      assert.throws(() => state.setEnabled(false), /could not save the DM notice setting/);
    } finally {
      chmodSync(stateDir, 0o700);
    }
    assert.equal(state.decide(idAt(T0 + 2000), 'stranger'), 'notify', 'the unwritten refusal reserved nothing');
  });

  it('writes a private file in a private directory, and suspends notices when a flush fails', (t) => {
    if (process.platform === 'win32') return t.skip('POSIX modes');
    const f = fixture(t);
    const state = f.make();
    state.open(f.path);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.path, '..')).mode & 0o777, 0o700);

    let failing = false;
    const flaky = new DmNoticeState({
      now: () => T0,
      fsync: (fd) => { if (failing) throw new Error('EIO: flush failed'); fsyncSync(fd); },
    });
    flaky.open(f.path);
    failing = true;
    assert.equal(flaky.decide(idAt(T0 + 1000), 'stranger'), 'suspended', 'no dispatch without a durable reservation');
    assert.match(flaky.status().error ?? '', /flush failed/);
    failing = false;
    assert.equal(flaky.decide(idAt(T0 + 2000), 'stranger'), 'notify');
  });

  it('clears a stale write error once a later write succeeds', (t) => {
    if (process.platform === 'win32') return t.skip('POSIX');
    const f = fixture(t);
    let failing = false;
    const state = new DmNoticeState({
      now: () => T0,
      fsync: (fd) => { if (failing) throw new Error('EIO: flush failed'); fsyncSync(fd); },
    });
    state.open(f.path);
    assert.equal(state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    failing = true;
    assert.throws(() => state.setEnabled(false), /flush failed/);
    assert.equal(state.status().persisted, false);
    failing = false;
    state.recordOutcome('stranger', idAt(T0 + 1000), 'sent');
    assert.equal(state.status().persisted, true, 'the successful outcome write clears the old error');
    assert.equal(state.status().error, undefined);
    assert.equal(JSON.parse(readFileSync(f.path, 'utf-8')).senders.stranger.lastNotice.outcome, 'sent');
  });

  it('reports an interrupted reservation found when a repaired file is reopened, on any path', (t) => {
    const f = fixture(t);
    const writer = f.make();
    writer.open(f.path);
    assert.equal(writer.decide(idAt(T0 + 1000), 'stranger'), 'notify'); // left pending
    const pendingFile = readFileSync(f.path, 'utf-8');

    // decide() reopening a repaired file
    writeFileSync(f.path, '{ broken');
    const viaDecide = f.make();
    viaDecide.open(f.path);
    assert.equal(viaDecide.decide(idAt(T0 + 2000), 'other'), 'suspended');
    writeFileSync(f.path, pendingFile);
    viaDecide.decide(idAt(T0 + 3000), 'other');
    assert.deepEqual(f.interrupted, [{ authorId: 'stranger', messageId: idAt(T0 + 1000), at: T0 }]);

    // setEnabled() reopening a repaired file
    f.interrupted.length = 0;
    writeFileSync(f.path, '{ broken');
    const viaSetting = f.make();
    viaSetting.open(f.path);
    writeFileSync(f.path, pendingFile);
    viaSetting.setEnabled(false);
    assert.deepEqual(f.interrupted, [{ authorId: 'stranger', messageId: idAt(T0 + 1000), at: T0 }]);
    assert.equal(JSON.parse(readFileSync(f.path, 'utf-8')).enabled, false);
  });

  it('resolves its default path per bot under XDG state, with an explicit override', () => {
    assert.equal(
      resolveDmNoticesPath('bot1', { XDG_STATE_HOME: '/x/state' }),
      '/x/state/discord-mcpl/bot1/dm-notices.json',
    );
    assert.ok(resolveDmNoticesPath('bot1', {}).endsWith(join('.local', 'state', 'discord-mcpl', 'bot1', 'dm-notices.json')));
    assert.equal(resolveDmNoticesPath('bot1', { DISCORD_DM_NOTICES_FILE: '/y/n.json' }), '/y/n.json');
    assert.equal(existsSync('/x/state'), false, 'resolving a path creates nothing');
  });
});
