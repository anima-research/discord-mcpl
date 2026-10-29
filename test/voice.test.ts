import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import {
  CarrierGate, VoiceOutput, compareSnowflakes,
  type PcmSink, type SinkEvent, type SinkItem, type UtteranceReport,
} from '../src/voice.js';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '@animalabs/voice-kit';

class FakeStream implements TtsStream {
  sent: string[] = [];
  ended = false;
  aborted = false;
  private audioFns: Array<(b: Buffer) => void> = [];
  private alignFns: Array<(a: TtsAlignment) => void> = [];
  private endFns: Array<() => void> = [];
  private errorFns: Array<(e: Error) => void> = [];
  sendText(d: string): void { this.sent.push(d); }
  end(): void { this.ended = true; for (const f of this.endFns) f(); }
  abort(): void { this.aborted = true; }
  onAudio(f: (b: Buffer) => void): void { this.audioFns.push(f); }
  onAlignment(f: (a: TtsAlignment) => void): void { this.alignFns.push(f); }
  onEnd(f: () => void): void { this.endFns.push(f); }
  onError(f: (e: Error) => void): void { this.errorFns.push(f); }
  emitAudio(b: Buffer): void { for (const f of this.audioFns) f(b); }
  emitAlignment(a: TtsAlignment): void { for (const f of this.alignFns) f(a); }
  emitError(e: Error): void { for (const f of this.errorFns) f(e); }
}

class FakeProvider implements TtsProvider {
  readonly name = 'fake';
  readonly outputRateHz = 44100;
  streams: FakeStream[] = [];
  openStream(_v: TtsVoice): TtsStream {
    const s = new FakeStream();
    this.streams.push(s);
    return s;
  }
}

class FakeSink implements PcmSink {
  played: SinkItem[] = [];
  cancelled: string[] = [];
  private clearedIds = new Set<string>();
  private fns: Array<(ev: SinkEvent) => void> = [];
  play(item: SinkItem): void { this.played.push(item); }
  cancel(id: string): boolean {
    if (this.clearedIds.has(id) || !this.played.some((p) => p.id === id)) return false;
    this.cancelled.push(id);
    return true;
  }
  onEvent(fn: (ev: SinkEvent) => void): void { this.fns.push(fn); }
  emit(ev: SinkEvent): void {
    if (ev.type === 'cleared') this.clearedIds.add(ev.id);
    for (const f of this.fns) f(ev);
  }
  clear(id: string): void { this.emit({ type: 'cleared', id }); }
}

const VOICE: TtsVoice = { voiceId: 'v1' };

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(textChannels: string[] | null = null) {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  return { provider, sink, out, reports };
}

function evenAlignment(text: string, msPerChar = 100): TtsAlignment {
  const chars = [...text];
  return {
    chars,
    startMs: chars.map((_, i) => i * msPerChar),
    durationMs: chars.map(() => msPerChar),
  };
}

test('billing gate: socket pre-opens free, text banks until cleared, then streams live', () => {
  const { provider, sink, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'Hello ');
  out.handleChunk('inf1', 'discord:g:100', 'there.');
  assert.equal(provider.streams.length, 1);        // socket pre-opened (free)
  assert.equal(sink.played.length, 1);
  assert.equal(sink.played[0]!.id, 'inf1');
  assert.deepEqual(provider.streams[0]!.sent, []); // zero characters billed while queued
  sink.clear('inf1');
  assert.deepEqual(provider.streams[0]!.sent, ['Hello there.']);
  out.handleChunk('inf1', 'discord:g:100', ' More.');
  assert.deepEqual(provider.streams[0]!.sent, ['Hello there.', ' More.']);
  assert.equal(provider.streams[0]!.ended, false);
  out.handleComplete('inf1');
  assert.equal(provider.streams[0]!.ended, true);
});

test('complete while queued: end is deferred to the flush', () => {
  const { provider, sink, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'Whole thing.');
  out.handleComplete('inf1');
  assert.equal(provider.streams[0]!.ended, false);
  sink.clear('inf1');
  assert.deepEqual(provider.streams[0]!.sent, ['Whole thing.']);
  assert.equal(provider.streams[0]!.ended, true);
});

test('channel filter: non-voiced channels are skipped for the whole inference', () => {
  const { provider, sink, out } = setup(['777']);
  out.handleChunk('inf1', 'discord:g:999', 'not voiced ');
  out.handleChunk('inf1', 'discord:g:999', 'still not');
  assert.equal(provider.streams.length, 0);
  out.handleChunk('inf2', 'discord:g:777', 'voiced');
  assert.equal(provider.streams.length, 1);
  sink.clear('inf2');
  assert.deepEqual(provider.streams[0]!.sent, ['voiced']);
});

test('concurrent inferences get separate streams; audio resampled 44.1k→48k stereo', async () => {
  const { provider, sink, out } = setup();
  out.handleChunk('a', 'discord:g:1', 'A');
  out.handleChunk('b', 'discord:g:1', 'B');
  assert.equal(provider.streams.length, 2);
  assert.equal(sink.played.length, 2);

  // 100 samples of 44.1k mono → floor(100*48000/44100)=108 frames of stereo (432 bytes)
  const chunks: Buffer[] = [];
  sink.played[0]!.stream.on('data', (c: Buffer) => chunks.push(c));
  provider.streams[0]!.emitAudio(Buffer.alloc(200));
  provider.streams[0]!.end();
  const expected = Math.floor((100 * 48000) / 44100) * 4;
  for (let i = 0; i < 100 && Buffer.concat(chunks).length < expected; i++) await turn();
  for (let i = 0; i < 3; i++) await turn();
  assert.equal(Buffer.concat(chunks).length, expected);
});

test('unparseable channel ids are skipped, never throw', () => {
  const { provider, out } = setup();
  out.handleChunk('x', 'not-a-channel', 'text');
  assert.equal(provider.streams.length, 0);
});

test('interruption: alignment-exact voiced/unvoiced split, TTS aborted, later chunks dropped', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'Hello there, friend.';
  out.handleChunk('inf1', 'discord:g:100', text);
  provider.streams[0]!.emitAlignment(evenAlignment(text));

  const by = { userId: 'u9', username: 'antra', bot: false };
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 550, by });

  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.status, 'interrupted');
  assert.equal(r.estimated, false);
  assert.equal(r.voicedText, 'Hello ');
  assert.equal(r.unvoicedText, 'there, friend.');
  assert.deepEqual(r.interruptedBy, by);
  assert.equal(provider.streams[0]!.aborted, true);

  out.handleChunk('inf1', 'discord:g:100', ' more prose');
  assert.equal(provider.streams.length, 1);
});

test('interruption without alignment: proportional estimate, flagged', () => {
  const { provider, sink, out, reports } = setup();
  out.handleChunk('inf1', 'discord:g:100', '0123456789');
  // 44100 samples = 1000 ms of source audio (PCM16 mono 44.1k = 2 bytes/sample)
  provider.streams[0]!.emitAudio(Buffer.alloc(88200));
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 500, by: { userId: 'u1', bot: false } });

  const r = reports[0]!;
  assert.equal(r.estimated, true);
  assert.equal(r.voicedText, '01234');
  assert.equal(r.unvoicedText, '56789');
});

test('interruption before any audio: everything unvoiced', () => {
  const { sink, out, reports } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'never heard');
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 0, by: { userId: 'u1', bot: true } });
  const r = reports[0]!;
  assert.equal(r.voicedText, '');
  assert.equal(r.unvoicedText, 'never heard');
});

test('clean finish after complete snaps to fully voiced', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'Short and sweet.';
  out.handleChunk('inf1', 'discord:g:100', text);
  provider.streams[0]!.emitAlignment(evenAlignment(text));
  provider.streams[0]!.emitAudio(Buffer.alloc(88200));
  out.handleComplete('inf1');
  sink.emit({ type: 'finished', id: 'inf1', playedMs: 900 });

  const r = reports[0]!;
  assert.equal(r.status, 'spoken');
  assert.equal(r.voicedText, text);
  assert.equal(r.unvoicedText, '');
});

test('truncated finish (TTS died early) reports the unvoiced tail', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'This sentence will be cut off midway through.';
  out.handleChunk('inf1', 'discord:g:100', text);
  provider.streams[0]!.emitAlignment(evenAlignment(text));
  provider.streams[0]!.emitAudio(Buffer.alloc(88200 * 5));
  out.handleComplete('inf1');
  sink.emit({ type: 'finished', id: 'inf1', playedMs: 2000 });

  const r = reports[0]!;
  assert.equal(r.status, 'spoken');
  assert.equal(r.voicedText, text.slice(0, 20));
  assert.equal(r.unvoicedText, text.slice(20));
  assert.equal(r.estimated, false);
});

test('zero-cost-loser pin: stopped while queued → provider received zero characters', () => {
  const { provider, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'never billed');
  out.stop();
  assert.deepEqual(provider.streams[0]!.sent, []);
  assert.equal(provider.streams[0]!.aborted, true);
});

test('interrupted while never cleared: report carries billedChars 0', () => {
  const { sink, out, reports } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'unbilled words');
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 0, by: { userId: 'u1', bot: true } });
  assert.equal(reports[0]!.billedChars, 0);
  assert.equal(reports[0]!.unvoicedText, 'unbilled words');
});

test('billedChars receipt: cleared-then-interrupted bills exactly the flushed text', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'Hello there, friend.';
  out.handleChunk('inf1', 'discord:g:100', text);
  sink.clear('inf1');
  provider.streams[0]!.emitAlignment(evenAlignment(text));
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 550, by: { userId: 'u9', bot: false } });
  assert.equal(reports[0]!.billedChars, text.length);
  assert.ok(reports[0]!.queuedMs >= 0);
});

test('socket pre-open is capped: deep-queue items open at clearance instead', () => {
  const { provider, sink, out } = setup();
  for (let i = 0; i < 5; i++) out.handleChunk('inf' + i, 'discord:g:100', 'text ' + i);
  const opened = provider.streams.length;
  assert.ok(opened < 5, 'pre-open is capped, not one socket per item');
  for (let i = 5; i < 10; i++) out.handleChunk('inf' + i, 'discord:g:100', 'text ' + i);
  assert.equal(provider.streams.length, opened, 'a deeper queue opens no more');
  sink.clear('inf9');
  assert.equal(provider.streams.length, opened + 1, 'the deep-queue item opens at clearance');
  assert.deepEqual(provider.streams.at(-1)!.sent, ['text 9']);
});

test('socket died while queued: flush reopens a fresh stream and resends the bank', () => {
  const { provider, sink, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'resent ');
  provider.streams[0]!.emitError(new Error('idle timeout'));
  out.handleChunk('inf1', 'discord:g:100', 'text');
  sink.clear('inf1');
  assert.equal(provider.streams.length, 2);
  assert.deepEqual(provider.streams[0]!.sent, []);
  assert.deepEqual(provider.streams[1]!.sent, ['resent text']);
});

/** On the real clock the hold timer runs on the event loop's cached time, in
 *  whole milliseconds, so it can fire before Date.now() has moved by its delay. */
function mockClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
}

test('maxHold expiry: dropped unspoken with an expired receipt, zero billed', (t) => {
  mockClock(t);
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null, maxHoldMs: 20 }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'too late');
  t.mock.timers.tick(19);
  assert.deepEqual(sink.cancelled, [], 'not expired before its max hold');
  t.mock.timers.tick(1);
  assert.deepEqual(sink.cancelled, ['inf1']);
  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.status, 'expired');
  assert.equal(r.billedChars, 0);
  assert.equal(r.playedMs, 0);
  assert.equal(r.voicedText, '');
  assert.equal(r.unvoicedText, 'too late');
  assert.equal(r.queuedMs, 20);
  assert.deepEqual(provider.streams[0]!.sent, []);
  assert.equal(provider.streams[0]!.aborted, true);
  t.mock.timers.tick(100);
  assert.equal(reports.length, 1);
  assert.equal(provider.streams.length, 1);
  out.handleChunk('inf1', 'discord:g:100', 'late delta');
  assert.equal(provider.streams.length, 1);
});

test('an expiry the event loop runs late reports the time the utterance actually waited', (t) => {
  mockClock(t);
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null, maxHoldMs: 20 }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'too late');
  t.mock.timers.tick(19);
  t.mock.timers.setTime(Date.now() + 15);
  t.mock.timers.tick(1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, 'expired');
  assert.equal(reports[0]!.queuedMs, 35, 'the measured wait, not the configured hold');
});

test('cleared beats expiry: a cleared utterance is never expired', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new FakeProvider();
  // A sink that would take back even a cleared item, so what keeps it is VoiceOutput's own.
  const sink = new (class extends FakeSink {
    override cancel(id: string): boolean {
      if (!this.played.some((p) => p.id === id)) return false;
      this.cancelled.push(id);
      return true;
    }
  })();
  const out = new VoiceOutput({ textChannels: null, maxHoldMs: 20 }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'quick');
  sink.clear('inf1');
  t.mock.timers.tick(50);
  assert.deepEqual(sink.cancelled, []);
  assert.equal(reports.length, 0);
  assert.deepEqual(provider.streams[0]!.sent, ['quick']);
});

test('waitClear resolves only after silence + full hold-off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new CarrierGate();
  gate.speakingStart({ userId: 'u1', bot: false });

  let cleared = false;
  void gate.waitClear(10, 11).then(() => { cleared = true; });

  await turn();
  t.mock.timers.tick(25);
  await turn();
  assert.equal(cleared, false, 'not while someone speaks');

  gate.speakingEnd('u1');
  await turn();
  t.mock.timers.tick(9);
  await turn();
  assert.equal(cleared, false, 'not before the hold-off has passed');
  t.mock.timers.tick(3);
  await turn();
  assert.equal(cleared, true);
});

test('a speaker starting during hold-off restarts the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new CarrierGate();
  let cleared = false;
  void gate.waitClear(30, 31).then(() => { cleared = true; });

  await turn();
  t.mock.timers.tick(10);
  gate.speakingStart({ userId: 'u2', bot: true });
  await turn();
  t.mock.timers.tick(40);
  await turn();
  assert.equal(cleared, false, 'past the first hold-off, which the start cancelled');

  gate.speakingEnd('u2');
  await turn();
  t.mock.timers.tick(29);
  await turn();
  assert.equal(cleared, false, 'the hold-off starts again from the end');
  t.mock.timers.tick(3);
  await turn();
  assert.equal(cleared, true);
});

test('onSpeakerStart fires for barge-in decisions; busy() tracks the set', () => {
  const gate = new CarrierGate();
  const starts: string[] = [];
  gate.onSpeakerStart((s) => starts.push(s.userId));
  assert.equal(gate.busy(), false);
  gate.speakingStart({ userId: 'a', bot: false });
  gate.speakingStart({ userId: 'b', bot: true });
  assert.equal(gate.busy(), true);
  gate.speakingEnd('a');
  assert.equal(gate.busy(), true);
  gate.speakingEnd('b');
  assert.equal(gate.busy(), false);
  assert.deepEqual(starts, ['a', 'b']);
});

test('sustained-speech debounce: blips never fire, real speech does', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new CarrierGate();
  const sustained: string[] = [];
  gate.onSpeakerSustained(30, (s) => sustained.push(s.userId));

  gate.speakingStart({ userId: 'blip', bot: false });
  t.mock.timers.tick(10);
  gate.speakingEnd('blip');
  t.mock.timers.tick(40);
  assert.deepEqual(sustained, []);

  gate.speakingStart({ userId: 'talker', bot: false });
  t.mock.timers.tick(29);
  assert.deepEqual(sustained, [], 'not before the debounce');
  t.mock.timers.tick(1);
  assert.deepEqual(sustained, ['talker']);
});

test('rapid VAD re-trigger counts as sustained speech', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new CarrierGate();
  const sustained: string[] = [];
  gate.onSpeakerSustained(30, (s) => sustained.push(s.userId));

  gate.speakingStart({ userId: 'u', bot: false });
  t.mock.timers.tick(10);
  gate.speakingEnd('u');
  t.mock.timers.tick(5);
  gate.speakingStart({ userId: 'u', bot: false });
  t.mock.timers.tick(30);
  assert.ok(sustained.includes('u'));
});

test('compareSnowflakes: numeric order via length-then-lex', () => {
  assert.ok(compareSnowflakes('99', '100') < 0);
  assert.ok(compareSnowflakes('101', '100') > 0);
  assert.equal(compareSnowflakes('100', '100'), 0);
});
