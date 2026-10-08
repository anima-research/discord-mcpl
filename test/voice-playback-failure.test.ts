// A voice item that can't be played is settled as 'failed': the sink resets
// what it was playing and goes on to the next item, without clearing (and so
// billing) the refused one; VoiceOutput ends the utterance (stopping
// synthesis) and reports it; and the server tells the model it couldn't be
// played. Before, the throw escaped the sink's fire-and-forget pump() as an
// unhandled rejection, which ends the process, and left the utterance waiting
// for an outcome that never came. slimepriestess's #69 review note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  DiscordVoiceSink, VoiceOutput,
  type PcmSink, type SinkEvent, type SinkItem, type UtteranceReport,
} from '../src/voice.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '@animalabs/voice-kit';

type SinkInternals = {
  player: unknown;
  gate: { waitClear: () => Promise<void> };
  current: unknown;
  playing: boolean;
};

/** A DiscordVoiceSink with a stand-in player and carrier gate: no Discord. */
function sinkWith(player: unknown, waitClear: () => Promise<void> = async () => {}) {
  const sink = new DiscordVoiceSink();
  const internals = sink as unknown as SinkInternals;
  internals.player = player;
  internals.gate = { waitClear };
  const events: SinkEvent[] = [];
  sink.onEvent((ev) => events.push(ev));
  return { sink, internals, events };
}

const item = (id: string): SinkItem => ({ id, stream: new PassThrough() });

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Fails the test if anything rejects unhandled while it runs. */
function noUnhandledRejections(t: { after: (fn: () => void) => void }): unknown[] {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(seen, [], 'no unhandled rejection');
  });
  return seen;
}

const summary = (events: SinkEvent[]) =>
  events.map((e) => (e.type === 'failed' ? `${e.type}:${e.id}:${e.playedMs}:${e.reason}` : `${e.type}:${e.id}`));

test('a player that refuses an item settles it as failed, uncleared, and the next item still plays', async (t) => {
  noUnhandledRejections(t);
  // @discordjs/voice's AudioPlayer.play throws this for an ended resource.
  const refusal = 'Cannot play a resource that has already ended.';
  const played: unknown[] = [];
  const player = {
    play(resource: unknown) { played.push(resource); throw new Error(refusal); },
    stop() {},
  };
  const { sink, internals, events } = sinkWith(player);
  sink.play(item('u1'));
  sink.play(item('u2'));
  await until(() => events.filter((e) => e.type === 'failed').length === 2, 'both items to settle');
  // Never 'cleared': the billing gate stays shut for an item the player refused.
  assert.deepEqual(summary(events), [`failed:u1:0:${refusal}`, `failed:u2:0:${refusal}`]);
  assert.equal(played.length, 2, 'the second item reached the player after the first failed');
  assert.equal(internals.current, null, 'nothing is left marked as playing');
  await until(() => internals.playing === false, 'the pump to finish');
});

test('when nothing more can play, every queued item is settled as failed, and a later item plays again', async (t) => {
  noUnhandledRejections(t);
  let broken = true;
  const played: unknown[] = [];
  const player = {
    play(resource: unknown) { played.push(resource); throw new Error('player refused'); },
    stop() {},
  };
  const { sink, internals, events } = sinkWith(player, async () => {
    if (broken) throw new Error('gate broke');
  });
  sink.play(item('u1'));
  sink.play(item('u2'));
  await until(() => events.filter((e) => e.type === 'failed').length === 2, 'both queued items to settle');
  assert.deepEqual(summary(events), ['failed:u1:0:gate broke', 'failed:u2:0:gate broke']);
  assert.equal(played.length, 0);
  await until(() => internals.playing === false, 'the pump to stop');

  // The sink isn't wedged: the next item is pumped again.
  broken = false;
  sink.play(item('u3'));
  await until(() => events.length === 3, 'the later item to settle');
  assert.deepEqual(summary(events).slice(2), ['failed:u3:0:player refused']);
  assert.equal(played.length, 1);
});

// ── VoiceOutput and the server: what a failed item becomes ─────────────────

class FakeStream implements TtsStream {
  sent: string[] = [];
  ended = false;
  aborted = false;
  sendText(d: string): void { this.sent.push(d); }
  end(): void { this.ended = true; }
  abort(): void { this.aborted = true; }
  onAudio(_f: (b: Buffer) => void): void {}
  onAlignment(_f: (a: TtsAlignment) => void): void {}
  onEnd(_f: () => void): void {}
  onError(_f: (e: Error) => void): void {}
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
  private fns: Array<(ev: SinkEvent) => void> = [];
  play(i: SinkItem): void { this.played.push(i); }
  cancel(): boolean { return false; }
  onEvent(fn: (ev: SinkEvent) => void): void { this.fns.push(fn); }
  emit(ev: SinkEvent): void { for (const f of this.fns) f(ev); }
}

test('VoiceOutput ends a failed utterance, stops its synthesis and reports it as failed', () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));

  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  sink.emit({ type: 'cleared', id: 'inf1' });
  assert.deepEqual(provider.streams[0]!.sent, ['Hello there.']);
  const reason = 'Cannot play a resource that has already ended.';
  sink.emit({ type: 'failed', id: 'inf1', playedMs: 0, reason });

  assert.equal(provider.streams[0]!.aborted, true, 'synthesis stops: no more billing for audio nobody hears');
  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.status, 'failed');
  assert.equal(r.failure, reason);
  assert.equal(r.interruptedBy, undefined);
  assert.equal(r.voicedText, '');
  assert.equal(r.unvoicedText, 'Hello there.');

  // The rest of that inference isn't voiced: the model re-decides.
  out.handleChunk('inf1', 'discord:g:100', ' More.');
  assert.equal(provider.streams.length, 1);
  assert.equal(sink.played.length, 1);
});

test('an item refused before clearance bills nothing and reports how long it was queued', async () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));

  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  await new Promise((r) => setTimeout(r, 25));
  sink.emit({ type: 'failed', id: 'inf1', playedMs: 0, reason: 'refused' });

  assert.deepEqual(provider.streams[0]!.sent, [], 'no text went to the provider');
  assert.equal(provider.streams[0]!.aborted, true, 'the pre-opened socket is closed');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, 'failed');
  assert.equal(reports[0]!.billedChars, 0);
  assert.equal(reports[0]!.unvoicedText, 'Hello there.');
  assert.ok(reports[0]!.queuedMs >= 15, `queued until it failed (${reports[0]!.queuedMs} ms)`);
});

test('the server tells the model a failed utterance could not be played, tagged voice:failed', () => {
  const server = new DiscordMcplServer({} as unknown as DiscordAdapter);
  const sent: Array<{ method: string; params: Record<string, any> }> = [];
  const internals = server as unknown as {
    conn: unknown;
    mcplEnabled: boolean;
    handleVoiceReport(r: UtteranceReport): void;
  };
  internals.conn = {
    sendRequest: async (method: string, params: Record<string, any>) => { sent.push({ method, params }); return {}; },
  };
  internals.mcplEnabled = true;

  const base = {
    inferenceId: 'inf1', channelId: 'discord:g1:100', status: 'failed' as const,
    queuedMs: 40, billedChars: 12, voicedText: '', unvoicedText: 'Hello there.', estimated: true,
    failure: 'Cannot play a resource that has already ended.',
  };
  internals.handleVoiceReport({ ...base, playedMs: 0 });
  assert.equal(sent.length, 1);
  const p = sent[0]!.params;
  assert.deepEqual(p.tags, ['voice:failed']);
  assert.equal(p.eventId, 'discord_voice_failed_inf1');
  const text: string = p.payload.content[0].text;
  assert.equal(
    text,
    "[voice] Your spoken message couldn't be played (Cannot play a resource that has already ended.) — nothing was heard.\n" +
      'NOT heard: "Hello there."\n(The text was still delivered in the text channel as usual.)',
  );

  // Part-way through: say how much was heard.
  internals.handleVoiceReport({ ...base, playedMs: 1500, voicedText: 'Hello', unvoicedText: ' there.', estimated: false });
  const partial: string = sent[1]!.params.payload.content[0].text;
  assert.equal(
    partial,
    "[voice] Your spoken message couldn't be played (Cannot play a resource that has already ended.) after 1.5s.\n" +
      'Heard up to: "Hello"\nNOT heard: " there."\n(The text was still delivered in the text channel as usual.)',
  );
});
