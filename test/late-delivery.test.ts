import assert from 'node:assert/strict';
import test from 'node:test';
import * as late from '../src/late-delivery.js';
import { lateDeliveryLine, LATE_DELIVERY_THRESHOLD_MS } from '../src/late-delivery.js';

const sent = new Date('2026-09-13T07:07:00Z');

test('on-time delivery adds nothing', () => {
  const received = new Date(sent.getTime() + LATE_DELIVERY_THRESHOLD_MS);
  assert.equal(lateDeliveryLine(sent, received, 'Europe/Paris', 'full'), '');
});

test('late delivery names both times in the agent time zone', () => {
  const received = new Date('2026-09-24T14:01:40Z');
  const line = lateDeliveryLine(sent, received, 'Europe/Paris', 'full');
  assert.match(line, /^\[delayed delivery · sent 2026-09-13T09:07:00\+02:00.* · received 2026-09-24T16:01:40\+02:00.*\]\n$/);
});

test('falls back to ISO when timestamps are styled off', () => {
  const received = new Date('2026-09-24T14:01:40Z');
  const line = lateDeliveryLine(sent, received, 'UTC', 'none');
  assert.equal(line, '[delayed delivery · sent 2026-09-13T07:07:00.000Z · received 2026-09-24T14:01:40.000Z]\n');
});

test('with the time style, the line gives the date and minutes, so a day-old message shows its day', () => {
  const dayLater = new Date(sent.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(lateDeliveryLine(sent, dayLater, 'UTC', 'time'), '[delayed delivery · sent 2026-09-13 07:07 · received 2026-09-14 07:07]\n');
});

test("a block's received attribute uses its lines' style, and is left out under none", () => {
  assert.equal(late.receivedAttribute(sent, 'UTC', 'full'), 'received="2026-09-13T07:07:00+00:00 [UTC]"');
  assert.equal(late.receivedAttribute(sent, 'UTC', 'time'), 'received="07:07"');
  assert.equal(late.receivedAttribute(sent, 'UTC', 'none'), '');
});

test('a received time earlier than the sent time adds nothing', () => {
  assert.equal(lateDeliveryLine(sent, new Date(sent.getTime() - 10 * 60 * 1000), 'UTC', 'full'), '');
});

test('each side gets its own offset across a DST change, and the time style its date in the agent zone', () => {
  const before = new Date('2026-10-25T00:59:00Z');
  const after = new Date('2026-10-25T01:02:00Z');
  assert.equal(lateDeliveryLine(before, after, 'Europe/Paris', 'full', 60 * 1000), '[delayed delivery · sent 2026-10-25T02:59:00+02:00 [Europe/Paris] · received 2026-10-25T02:02:00+01:00 [Europe/Paris]]\n');
  assert.equal(lateDeliveryLine(sent, new Date(sent.getTime() + 24 * 60 * 60 * 1000), 'Europe/Paris', 'time'), '[delayed delivery · sent 2026-09-13 09:07 · received 2026-09-14 09:07]\n');
});
