/**
 * Durable state behind DM refusal notices: off until the resident turns
 * them on, once per message, at most once a day per sender and a ceiling an
 * hour across senders, nothing for messages older than the state,
 * reservation before send, suspension when the state can't be persisted,
 * operations in the order they were called, and a state that matches its
 * file after a failed write.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DM_NOTICE_CEILING_WINDOW_MS,
  DM_NOTICE_HOURLY_CEILING,
  DM_NOTICE_RETENTION_MS,
  DM_NOTICE_WINDOW_MS,
  DmNoticeState,
  resolveDmNoticesPath,
  snowflakeAt,
} from '../src/dm-notices.js';

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

type FlushTarget = 'file' | 'directory';

function fixture(t: TestContext, start = T0) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-notices-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state', 'dm-notices.json');
  let now = start;
  const clock = { set: (ms: number) => { now = ms; } };
  const interrupted: Array<{ authorId: string; messageId: string; at: number }> = [];
  // Flushes of the targets named here fail, as a failing disk's would.
  const failing = new Set<FlushTarget>();
  const sync = async (handle: FileHandle, what: FlushTarget) => {
    if (failing.has(what)) throw new Error(`EIO: ${what} flush failed`);
    await handle.sync();
  };
  const make = () => new DmNoticeState({ now: () => now, sync, onInterrupted: (i) => interrupted.push(i) });
  const onDisk = () => JSON.parse(readFileSync(path, 'utf-8'));
  /** Open the state and turn notices on, as a resident would: they're off
   *  in a new state. */
  const openOn = async (state: DmNoticeState) => {
    await state.open(path);
    assert.equal(await state.setEnabled(true), null);
  };
  return { dir, path, clock, make, interrupted, failing, onDisk, openOn };
}

/** A message id Discord could assign at `ms` (plus a small increment). */
const idAt = (ms: number, n = 0) => (BigInt(snowflakeAt(ms)) + BigInt(n)).toString();

describe('DM notice state', () => {
  it('notifies once per sender per day, and the reservation is on disk before the send', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    assert.deepEqual(
      f.onDisk().senders.stranger.lastNotice,
      { messageId: idAt(T0 + 1000), at: T0, outcome: 'pending' },
      'reserved before the caller sends',
    );
    assert.equal(await state.recordOutcome('stranger', idAt(T0 + 1000), 'sent'), null);
    assert.equal(f.onDisk().senders.stranger.lastNotice.outcome, 'sent');

    f.clock.set(T0 + HOUR);
    assert.equal(await state.decide(idAt(T0 + HOUR), 'stranger'), 'rate-limited');
    assert.equal(await state.decide(idAt(T0 + HOUR, 1), 'other'), 'notify', 'the limit is per sender');

    f.clock.set(T0 + DM_NOTICE_WINDOW_MS);
    assert.equal(await state.decide(idAt(T0 + DM_NOTICE_WINDOW_MS), 'stranger'), 'notify');
  });

  it('decides in the order it was asked, each decision seeing the one before', async (t) => {
    const f = fixture(t);
    const state = f.make();
    void state.open(f.path); // not awaited: the setting and decisions below wait for it
    void state.setEnabled(true);
    const m1 = idAt(T0 + 1000);
    const m2 = idAt(T0 + 2000);
    // All asked in one tick, as a gateway burst or a catch-up batch would.
    const decisions = await Promise.all([
      state.decide(m1, 'stranger'),
      state.decide(m1, 'stranger'),
      state.decide(m2, 'stranger'),
      state.decide(m2, 'other'),
    ]);
    assert.deepEqual(decisions, ['notify', 'already-handled', 'rate-limited', 'notify']);
    assert.equal(f.onDisk().senders.stranger.lastHandledId, m2);
  });

  it('keeps the limit across a restart', async (t) => {
    const f = fixture(t);
    const first = f.make();
    await f.openOn(first);
    assert.equal(await first.decide(idAt(T0 + 1000), 'stranger'), 'notify');

    f.clock.set(T0 + 2 * HOUR);
    const second = f.make();
    await second.open(f.path);
    assert.equal(await second.decide(idAt(T0 + 2 * HOUR), 'stranger'), 'rate-limited');
  });

  it('settles a reservation interrupted before its outcome as unknown, reports it once, and never retries it', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    // The process dies here, after the reservation and before any outcome.
    f.clock.set(T0 + HOUR);
    const restarted = f.make();
    await restarted.open(f.path);
    assert.deepEqual(f.interrupted, [{ authorId: 'stranger', messageId: idAt(T0 + 1000), at: T0 }], 'reported once');
    assert.equal(f.onDisk().senders.stranger.lastNotice.outcome, 'unknown');
    assert.equal(await restarted.decide(idAt(T0 + HOUR), 'stranger'), 'rate-limited', 'not retried inside its window');
    const again = f.make();
    await again.open(f.path);
    assert.equal(f.interrupted.length, 1, 'an unknown outcome is not re-reported');
  });

  it('never handles the same or an older message twice, even after the window', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    const m1 = idAt(T0 + 1000);
    const m2 = idAt(T0 + 2000);
    assert.equal(await state.decide(m1, 'stranger'), 'notify');
    f.clock.set(T0 + 2 * DM_NOTICE_WINDOW_MS);
    // A duplicate gateway event, or a catch-up re-scan after a restart.
    const reopened = f.make();
    await reopened.open(f.path);
    assert.equal(await reopened.decide(m1, 'stranger'), 'already-handled');
    assert.equal(await reopened.decide(m2, 'stranger'), 'notify', 'a genuinely new message after the window');
    assert.equal(await reopened.decide(m1, 'stranger'), 'already-handled');
  });

  it('never notifies for a message older than the state, whatever path it arrives on', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(await state.decide(idAt(T0 - HOUR), 'old-correspondent'), 'before-floor');
    assert.equal(await state.decide(idAt(T0 + 1), 'old-correspondent'), 'notify');
  });

  it('moves the floor to the moment notices are turned on, and only then', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await state.open(f.path);
    assert.equal(f.onDisk().floorId, snowflakeAt(T0), "a new state's floor is its creation");
    f.clock.set(T0 + HOUR);
    const reopened = f.make();
    await reopened.open(f.path);
    assert.equal(f.onDisk().floorId, snowflakeAt(T0), 'an existing file keeps its own floor');
    await reopened.setEnabled(true);
    assert.equal(f.onDisk().floorId, snowflakeAt(T0 + HOUR), 'turning notices on moves it to now');
    f.clock.set(T0 + 2 * HOUR);
    await reopened.setEnabled(true);
    assert.equal(f.onDisk().floorId, snowflakeAt(T0 + HOUR), 'turning on what is already on moves nothing');
    assert.equal(await reopened.decide(idAt(T0 + 5), 'early-knocker'), 'before-floor', 'refused while off');
    assert.equal(await reopened.decide(idAt(T0 + 2 * HOUR), 'later-knocker'), 'notify');
  });

  it('writes nothing for a refusal while notices are off, and never notifies it once they are on', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await state.open(f.path);
    const before = readFileSync(f.path, 'utf-8');
    const m1 = idAt(T0 + 1000);
    f.clock.set(T0 + 1000);
    assert.equal(await state.decide(m1, 'stranger'), 'silenced');
    assert.equal(readFileSync(f.path, 'utf-8'), before, 'a refusal while off writes nothing');
    f.clock.set(T0 + 1500);
    await state.setEnabled(true);
    assert.equal(await state.decide(m1, 'stranger'), 'before-floor', 'refused while off, so it never notifies');
    f.clock.set(T0 + 2000);
    assert.equal(await state.decide(idAt(T0 + 2000), 'stranger'), 'notify', 'silence reserved no window');
  });

  it('keeps a sender for the retention after their latest refusal, then drops them, and the floor follows', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(await state.decide(idAt(T0 + 1000), 'old-friend'), 'notify');
    f.clock.set(T0 + DM_NOTICE_RETENTION_MS);
    assert.equal(await state.decide(idAt(T0 + DM_NOTICE_RETENTION_MS), 'newcomer'), 'notify');
    assert.ok(f.onDisk().senders['old-friend'], 'kept within the retention');
    f.clock.set(T0 + 1000 + DM_NOTICE_RETENTION_MS + 1);
    assert.equal(await state.decide(idAt(T0 + 1000 + DM_NOTICE_RETENTION_MS + 1), 'third'), 'notify');
    assert.deepEqual(Object.keys(f.onDisk().senders).sort(), ['newcomer', 'third'], 'dropped once past it');
    assert.equal(await state.decide(idAt(T0 + 1000), 'old-friend'), 'before-floor', "a dropped sender's old message still never notifies");
  });

  it('is off until the resident turns it on, so a new state notifies no one', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await state.open(f.path);
    assert.deepEqual([state.status().enabled, state.status().persisted], [false, true], 'off by default, and durable');
    assert.equal(f.onDisk().enabled, false);
    f.clock.set(T0 + 1000);
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'silenced');
    f.clock.set(T0 + 1500);
    assert.equal(await state.setEnabled(true), null);
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'before-floor', 'a message refused while off stays unnotified');
    f.clock.set(T0 + 2000);
    assert.equal(await state.decide(idAt(T0 + 2000), 'stranger'), 'notify');
  });

  it('keeps the resident\'s setting across a restart, in the same file', async (t) => {
    const f = fixture(t);
    const first = f.make();
    await first.open(f.path);
    await first.setEnabled(true);
    const second = f.make();
    await second.open(f.path);
    assert.equal(second.status().enabled, true);
    assert.equal(await second.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    await second.setEnabled(false);
    const third = f.make();
    await third.open(f.path);
    assert.equal(third.status().enabled, false);
    assert.equal(await third.decide(idAt(T0 + 2000), 'other'), 'silenced');
    assert.equal(f.onDisk().enabled, false);
  });

  it('holds all senders together to an hourly ceiling, durably, apart from each sender\'s own day', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    for (let i = 0; i < DM_NOTICE_HOURLY_CEILING; i++) {
      assert.equal(await state.decide(idAt(T0 + 1000, i), `knocker-${i}`), 'notify');
    }
    const over = idAt(T0 + 2000);
    assert.equal(await state.decide(over, 'one-too-many'), 'ceiling-reached');
    assert.deepEqual(f.onDisk().senders['one-too-many'], { lastHandledId: over }, 'handled, with nothing reserved');

    // The ceiling is counted from the file, so a restart doesn't reset it.
    f.clock.set(T0 + DM_NOTICE_CEILING_WINDOW_MS - 1);
    const restarted = f.make();
    await restarted.open(f.path);
    assert.equal(await restarted.decide(idAt(T0 + 3000), 'another'), 'ceiling-reached');
    assert.equal(await restarted.decide(over, 'one-too-many'), 'already-handled', 'a message held by the ceiling never notifies later');

    // An hour after those notices, the ceiling has room again; each sender's
    // own 24-hour limit still stands.
    f.clock.set(T0 + DM_NOTICE_CEILING_WINDOW_MS);
    assert.equal(await restarted.decide(idAt(T0 + HOUR, 1), 'one-too-many'), 'notify', 'a later message, once there is room');
    assert.equal(await restarted.decide(idAt(T0 + HOUR, 2), 'knocker-0'), 'rate-limited', 'its own day, not the ceiling');
  });

  it('suspends notices while the state file is invalid, without touching it, and resumes once it is removed', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await state.open(f.path); // creates it
    writeFileSync(f.path, '{ not json');
    const broken = f.make();
    await broken.open(f.path);
    assert.equal(broken.status().persisted, false);
    assert.match(broken.status().error ?? '', /not a valid DM notice state file/);
    assert.equal(await broken.decide(idAt(T0 + 1000), 'stranger'), 'suspended');
    assert.equal(readFileSync(f.path, 'utf-8'), '{ not json', 'an invalid file is left for the operator');

    rmSync(f.path);
    f.clock.set(T0 + HOUR);
    assert.equal(await broken.decide(idAt(T0 + HOUR, 1), 'stranger'), 'silenced', 'a new file starts with notices off');
    assert.equal(broken.status().persisted, true);
    await broken.setEnabled(true);
    assert.equal(await broken.decide(idAt(T0 + HOUR, 2), 'stranger'), 'notify');
  });

  it('suspends notices when the reservation cannot be written', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('needs POSIX permissions as non-root');
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    const stateDir = join(f.path, '..');
    chmodSync(stateDir, 0o500);
    try {
      assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'suspended');
      assert.equal(state.status().persisted, false);
      await assert.rejects(state.setEnabled(false), /could not save the DM notice setting/);
      assert.equal(state.status().enabled, true, 'a setting that was not saved is not in effect');
    } finally {
      chmodSync(stateDir, 0o700);
    }
    assert.equal(await state.decide(idAt(T0 + 2000), 'stranger'), 'notify', 'the unwritten refusal reserved nothing');
  });

  it('writes a private file in a private directory, and suspends notices when the file flush fails', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX modes');
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.path, '..')).mode & 0o777, 0o700);

    f.failing.add('file');
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'suspended', 'no dispatch without a durable reservation');
    assert.match(state.status().error ?? '', /file flush failed/);
    assert.equal(f.onDisk().senders.stranger, undefined, 'the file was not replaced');
    f.failing.clear();
    assert.equal(await state.decide(idAt(T0 + 2000), 'stranger'), 'notify');
  });

  it('clears a stale write error once a later write succeeds', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX');
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    f.failing.add('file');
    await assert.rejects(state.setEnabled(false), /file flush failed/);
    assert.equal(state.status().persisted, false);
    f.failing.clear();
    assert.equal(await state.recordOutcome('stranger', idAt(T0 + 1000), 'sent'), null);
    assert.equal(state.status().persisted, true, 'the successful outcome write clears the old error');
    assert.equal(state.status().error, undefined);
    assert.equal(f.onDisk().senders.stranger.lastNotice.outcome, 'sent');
  });

  it('reports why an outcome could not be saved, and leaves the reservation pending for the next open', async (t) => {
    const f = fixture(t);
    const state = f.make();
    await f.openOn(state);
    assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
    f.failing.add('file');
    assert.match(await state.recordOutcome('stranger', idAt(T0 + 1000), 'sent') ?? '', /file flush failed/);
    assert.equal(f.onDisk().senders.stranger.lastNotice.outcome, 'pending');
    f.failing.clear();
    await f.make().open(f.path);
    assert.equal(f.interrupted.length, 1, 'the file never learned the outcome, so it is reported as interrupted');
  });

  describe('when the directory flush fails after the file was replaced, the state is what the file holds', () => {
    if (process.platform === 'win32') return;

    it('a setting change takes effect, says its durability is unconfirmed, and is not undone by the next write', async (t) => {
      const f = fixture(t);
      const state = f.make();
      await f.openOn(state);
      f.failing.add('directory');
      const unconfirmed = await state.setEnabled(false);
      assert.match(unconfirmed ?? '', /flushing its directory failed.*directory flush failed/);
      assert.deepEqual(
        [state.status().enabled, state.status().persisted],
        [false, false],
        'in effect, as the file says, but not confirmed durable',
      );
      f.failing.clear();
      assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'silenced');
      assert.equal(state.status().persisted, false, 'a refusal while off writes nothing, so it confirms nothing');
      assert.equal(await state.setEnabled(false), null);
      assert.equal(f.onDisk().enabled, false, 'the next write kept the setting the file held');
      assert.equal(state.status().persisted, true, 'that write was durable');
    });

    it('a reservation is not sent, its window stands, and a durable write later lets notices resume', async (t) => {
      const f = fixture(t);
      const state = f.make();
      await f.openOn(state);
      f.failing.add('directory');
      assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'suspended', 'no dispatch without a durable reservation');
      assert.match(state.status().error ?? '', /flushing its directory failed/);
      assert.equal(f.onDisk().senders.stranger.lastNotice.outcome, 'pending', 'the file holds the reservation');
      f.failing.clear();
      assert.equal(await state.decide(idAt(T0 + 2000), 'stranger'), 'rate-limited', 'memory kept the reservation the file holds');
      assert.equal(await state.decide(idAt(T0 + 3000), 'other'), 'notify');
      assert.equal(f.onDisk().senders.stranger.lastNotice.messageId, idAt(T0 + 1000));
    });

    it('a recorded outcome stays recorded through later writes', async (t) => {
      const f = fixture(t);
      const state = f.make();
      await f.openOn(state);
      assert.equal(await state.decide(idAt(T0 + 1000), 'stranger'), 'notify');
      f.failing.add('directory');
      assert.match(await state.recordOutcome('stranger', idAt(T0 + 1000), 'sent') ?? '', /flushing its directory failed/);
      f.failing.clear();
      assert.equal(await state.decide(idAt(T0 + 2000), 'stranger'), 'rate-limited');
      assert.equal(f.onDisk().senders.stranger.lastNotice.outcome, 'sent', 'not rewritten as pending');
      await f.make().open(f.path);
      assert.deepEqual(f.interrupted, [], 'so no later open reports it as interrupted');
    });
  });

  it('reports an interrupted reservation found when a repaired file is reopened, on any path', async (t) => {
    const f = fixture(t);
    const writer = f.make();
    await f.openOn(writer);
    assert.equal(await writer.decide(idAt(T0 + 1000), 'stranger'), 'notify'); // left pending
    const pendingFile = readFileSync(f.path, 'utf-8');

    // decide() reopening a repaired file
    writeFileSync(f.path, '{ broken');
    const viaDecide = f.make();
    await viaDecide.open(f.path);
    assert.equal(await viaDecide.decide(idAt(T0 + 2000), 'other'), 'suspended');
    writeFileSync(f.path, pendingFile);
    await viaDecide.decide(idAt(T0 + 3000), 'other');
    assert.deepEqual(f.interrupted, [{ authorId: 'stranger', messageId: idAt(T0 + 1000), at: T0 }]);

    // setEnabled() reopening a repaired file
    f.interrupted.length = 0;
    writeFileSync(f.path, '{ broken');
    const viaSetting = f.make();
    await viaSetting.open(f.path);
    writeFileSync(f.path, pendingFile);
    await viaSetting.setEnabled(false);
    assert.deepEqual(f.interrupted, [{ authorId: 'stranger', messageId: idAt(T0 + 1000), at: T0 }]);
    assert.equal(f.onDisk().enabled, false);
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
