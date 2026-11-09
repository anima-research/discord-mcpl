/**
 * Voice output for the host's streamed prose (MCPL `channels/outgoing/*`,
 * SPEC 14.3). That stream is advisory: the authoritative delivery is
 * `channels/publish`, so this module never posts text.
 *
 * A TTS provider's socket is free to hold open; only the characters sent
 * bill.
 */
import { PassThrough, type Readable } from 'node:stream';
import {
  EnergyVad,
  monoTo48kStereo,
  loadRegistry,
  resolveVoice,
  type TtsAlignment,
  type TtsProvider,
  type TtsStream,
  type TtsVoice,
} from '@animalabs/voice-kit';
import { parseMcplChannelId } from './channels.js';
import { VAD_THRESHOLD_DB, type VoiceEnv } from './voice-env.js';

const HOLDOFF_MIN_MS = 150;
const HOLDOFF_MAX_MS = 500;
const COLLISION_WINDOW_MS = 250;
/** Discord clients send ~100 ms bursts on unmute (a mic pop) and on VAD
 *  false triggers (a keyboard, a cough), so a single burst isn't speech. */
const BARGE_IN_SUSTAIN_MS = 250;
const FULLY_PLAYED_SLACK_MS = 250;
/** Sockets bill nothing, but providers cap concurrent connections. */
const PRE_OPEN_MAX = 3;

export interface VoiceOutputConfig {
  textChannels: string[] | null;
  maxHoldMs?: number | null;
}

export interface SpeakerInfo {
  userId: string;
  username?: string;
  bot: boolean;
}

export interface SinkItem {
  id: string;
  /** 48k stereo raw PCM. */
  stream: Readable;
}

export type SinkEvent =
  | { type: 'cleared'; id: string }
  | { type: 'started'; id: string }
  | { type: 'finished'; id: string; playedMs: number }
  | { type: 'interrupted'; id: string; playedMs: number; by: SpeakerInfo }
  | { type: 'failed'; id: string; playedMs: number; reason: string };

export const PlaybackFailure = {
  refused: 'the player refused it',
  streamFailed: 'its audio stream failed',
  noAudio: (ms: number) => `no audio reached the player within ${ms / 1000}s`,
  tooLong: (ms: number) => `it reached the ${ms / 1000}s limit on one reply`,
  stopped: 'playback stopped unexpectedly',
} as const;

export interface PcmSink {
  play(item: SinkItem): void;
  cancel(id: string): boolean;
  onEvent(fn: (ev: SinkEvent) => void): void;
}

export class CarrierGate {
  private speakers = new Map<string, SpeakerInfo>();
  private changeFns: Array<() => void> = [];
  private startFns: Array<(s: SpeakerInfo) => void> = [];
  private sustainedFns: Array<{ ms: number; fn: (s: SpeakerInfo) => void }> = [];

  speakingStart(s: SpeakerInfo): void {
    this.speakers.set(s.userId, s);
    for (const fn of this.startFns) { try { fn(s); } catch { } }
    for (const { ms, fn } of this.sustainedFns) {
      setTimeout(() => {
        if (this.speakers.has(s.userId)) { try { fn(s); } catch { } }
      }, ms).unref?.();
    }
    this.emitChange();
  }

  speakingEnd(userId: string): void {
    if (this.speakers.delete(userId)) this.emitChange();
  }

  busy(): boolean { return this.speakers.size > 0; }

  isSpeaking(userId: string): boolean { return this.speakers.has(userId); }

  onSpeakerStart(fn: (s: SpeakerInfo) => void): void { this.startFns.push(fn); }

  onSpeakerSustained(ms: number, fn: (s: SpeakerInfo) => void): void {
    this.sustainedFns.push({ ms, fn });
  }

  async waitClear(minHoldMs = HOLDOFF_MIN_MS, maxHoldMs = HOLDOFF_MAX_MS): Promise<void> {
    for (;;) {
      while (this.busy()) await this.nextChange();
      const holdMs = minHoldMs + Math.random() * (maxHoldMs - minHoldMs);
      if (await this.quietFor(holdMs)) return;
    }
  }

  private quietFor(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onChange = () => {
        if (!this.busy()) return;
        clearTimeout(timer);
        this.changeFns = this.changeFns.filter((f) => f !== onChange);
        resolve(false);
      };
      timer = setTimeout(() => {
        this.changeFns = this.changeFns.filter((f) => f !== onChange);
        resolve(true);
      }, ms);
      this.changeFns.push(onChange);
    });
  }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => {
      const fn = () => {
        this.changeFns = this.changeFns.filter((f) => f !== fn);
        resolve();
      };
      this.changeFns.push(fn);
    });
  }

  private emitChange(): void {
    for (const fn of [...this.changeFns]) { try { fn(); } catch { } }
  }
}

export interface UtteranceReport {
  inferenceId: string;
  channelId: string;
  status: 'spoken' | 'interrupted' | 'expired' | 'failed';
  playedMs: number;
  queuedMs: number;
  billedChars: number;
  voicedText: string;
  unvoicedText: string;
  estimated: boolean;
  interruptedBy?: SpeakerInfo;
  failure?: string;
  restUnvoiced?: true;
}

interface ActiveUtterance {
  tts: TtsStream | null;
  ttsDead: boolean;
  out: PassThrough;
  channelId: string;
  sentText: string;
  pendingText: string;
  billedChars: number;
  cleared: boolean;
  queuedAt: number;
  clearedAt: number | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Flattened provider alignment, stream-absolute ms (voice-kit contract). */
  aChars: string[];
  aStartMs: number[];
  aDurMs: number[];
  audioMs: number;
  done: boolean;
}

export class VoiceOutput {
  private active = new Map<string, ActiveUtterance>();
  private skipped = new Set<string>();
  private reportFns: Array<(r: UtteranceReport) => void> = [];

  constructor(
    private cfg: VoiceOutputConfig,
    private tts: TtsProvider,
    private voice: TtsVoice,
    private sink: PcmSink,
    private log: (m: string) => void = (m) => console.error(`[discord-mcpl voice] ${m}`),
  ) {
    this.sink.onEvent((ev) => this.handleSinkEvent(ev));
  }

  onReport(fn: (r: UtteranceReport) => void): void { this.reportFns.push(fn); }

  handleChunk(inferenceId: string, mcplChannelId: string, delta: string): void {
    if (this.skipped.has(inferenceId)) return;
    let utt = this.active.get(inferenceId);
    if (!utt) {
      const parsed = parseMcplChannelId(mcplChannelId);
      if (!parsed || (this.cfg.textChannels && !this.cfg.textChannels.includes(parsed.channelId))) {
        this.skipped.add(inferenceId);
        return;
      }
      const opened = this.open(inferenceId, mcplChannelId);
      if (!opened) { this.skipped.add(inferenceId); return; }
      utt = opened;
    }
    if (utt.done) return;
    utt.sentText += delta;
    if (utt.cleared && utt.tts && !utt.ttsDead) {
      utt.tts.sendText(delta);
      utt.billedChars += delta.length;
    } else {
      utt.pendingText += delta;
    }
  }

  handleComplete(inferenceId: string): void {
    this.skipped.delete(inferenceId);
    const utt = this.active.get(inferenceId);
    if (!utt || utt.done) return;
    utt.done = true;
    if (utt.cleared && utt.tts && !utt.ttsDead) utt.tts.end();
  }

  stop(): void {
    for (const [, utt] of this.active) {
      if (utt.holdTimer) clearTimeout(utt.holdTimer);
      utt.tts?.abort();
      utt.out.end();
    }
    this.active.clear();
    this.skipped.clear();
  }

  private open(inferenceId: string, channelId: string): ActiveUtterance | null {
    const out = new PassThrough();
    const utt: ActiveUtterance = {
      tts: null, ttsDead: false, out, channelId,
      sentText: '', pendingText: '', billedChars: 0,
      cleared: false, queuedAt: Date.now(), clearedAt: null, holdTimer: null,
      aChars: [], aStartMs: [], aDurMs: [], audioMs: 0, done: false,
    };
    if (this.active.size < PRE_OPEN_MAX) this.openProviderStream(utt);
    this.sink.play({ id: inferenceId, stream: out });
    const maxHold = this.cfg.maxHoldMs;
    if (maxHold != null && maxHold > 0) {
      utt.holdTimer = setTimeout(() => this.expire(inferenceId), maxHold);
      utt.holdTimer.unref?.();
    }
    this.active.set(inferenceId, utt);
    return utt;
  }

  private openProviderStream(utt: ActiveUtterance): boolean {
    let tts: TtsStream;
    try {
      tts = this.tts.openStream(this.voice);
    } catch (err) {
      this.log(`TTS open failed: ${(err as Error).message}`);
      utt.tts = null;
      utt.ttsDead = true;
      return false;
    }
    utt.tts = tts;
    utt.ttsDead = false;
    const rate = this.tts.outputRateHz;
    tts.onAlignment((a: TtsAlignment) => {
      if (utt.tts !== tts) return;
      utt.aChars.push(...a.chars);
      utt.aStartMs.push(...a.startMs);
      utt.aDurMs.push(...a.durationMs);
    });
    tts.onAudio((pcm) => {
      if (utt.tts !== tts || utt.out.writableEnded) return;
      utt.audioMs += pcm.length / 2 / (rate / 1000); // PCM16 mono
      utt.out.write(monoTo48kStereo(pcm, rate));
    });
    tts.onEnd(() => {
      if (utt.tts !== tts) return;
      if (utt.cleared) utt.out.end();
      else utt.ttsDead = true;
    });
    tts.onError((e) => {
      if (utt.tts !== tts) return;
      if (utt.cleared) {
        this.log(`TTS stream error: ${e.message}`);
        utt.out.end();
      } else {
        this.log(`TTS stream error while queued (will reopen at clearance): ${e.message}`);
        utt.ttsDead = true;
      }
    });
    return true;
  }

  private handleCleared(inferenceId: string): void {
    const utt = this.active.get(inferenceId);
    if (!utt || utt.cleared) return;
    utt.cleared = true;
    utt.clearedAt = Date.now();
    if (utt.holdTimer) { clearTimeout(utt.holdTimer); utt.holdTimer = null; }
    if ((!utt.tts || utt.ttsDead) && !this.openProviderStream(utt)) {
      this.log('TTS unavailable at clearance — line stays text-only');
      utt.out.end();
      return;
    }
    if (utt.pendingText.length > 0) {
      utt.tts!.sendText(utt.pendingText);
      utt.billedChars += utt.pendingText.length;
      utt.pendingText = '';
    }
    if (utt.done) utt.tts!.end();
  }

  private expire(inferenceId: string): void {
    const utt = this.active.get(inferenceId);
    if (!utt || utt.cleared) return;
    if (!this.sink.cancel(inferenceId)) return;
    this.active.delete(inferenceId);
    if (!utt.done) this.skipped.add(inferenceId);
    utt.tts?.abort();
    utt.out.end();
    this.report({
      inferenceId, channelId: utt.channelId, status: 'expired',
      playedMs: 0, queuedMs: Date.now() - utt.queuedAt, billedChars: utt.billedChars,
      voicedText: '', unvoicedText: utt.sentText, estimated: false,
    });
  }

  private handleSinkEvent(ev: SinkEvent): void {
    if (ev.type === 'cleared') { this.handleCleared(ev.id); return; }
    if (ev.type === 'started') return;
    const utt = this.active.get(ev.id);
    if (!utt) return;
    this.active.delete(ev.id);
    if (utt.holdTimer) { clearTimeout(utt.holdTimer); utt.holdTimer = null; }
    const queuedMs = Math.max(0, (utt.clearedAt ?? Date.now()) - utt.queuedAt);

    const fullyPlayed = utt.done && utt.audioMs > 0 && ev.playedMs + FULLY_PLAYED_SLACK_MS >= utt.audioMs;

    if (ev.type === 'interrupted' || ev.type === 'failed') {
      utt.tts?.abort();
      utt.out.end();
      if (!utt.done) this.skipped.add(ev.id);
      const split = ev.type === 'failed' && fullyPlayed
        ? { voicedText: utt.sentText, unvoicedText: '', estimated: false }
        : this.split(utt, ev.playedMs);
      this.report({
        inferenceId: ev.id, channelId: utt.channelId, status: ev.type,
        playedMs: ev.playedMs, queuedMs, billedChars: utt.billedChars,
        ...split,
        ...(ev.type === 'interrupted' ? { interruptedBy: ev.by } : { failure: ev.reason }),
        ...(utt.done ? {} : { restUnvoiced: true as const }),
      });
      return;
    }

    const split = fullyPlayed
      ? { voicedText: utt.sentText, unvoicedText: '', estimated: false }
      : this.split(utt, ev.playedMs);
    this.report({
      inferenceId: ev.id, channelId: utt.channelId, status: 'spoken',
      playedMs: ev.playedMs, queuedMs, billedChars: utt.billedChars,
      ...split,
    });
  }

  /** Alignment characters map onto the input text (voice-kit's contract). */
  private split(utt: ActiveUtterance, playedMs: number):
    { voicedText: string; unvoicedText: string; estimated: boolean } {
    if (playedMs <= 0) return { voicedText: '', unvoicedText: utt.sentText, estimated: false };
    if (utt.aChars.length > 0) {
      let n = 0;
      for (let i = 0; i < utt.aChars.length; i++) {
        if (utt.aStartMs[i]! + utt.aDurMs[i]! / 2 <= playedMs) n++;
      }
      n = Math.min(n, utt.sentText.length);
      return { voicedText: utt.sentText.slice(0, n), unvoicedText: utt.sentText.slice(n), estimated: false };
    }
    if (utt.audioMs > 0) {
      const frac = Math.max(0, Math.min(1, playedMs / utt.audioMs));
      const n = Math.round(utt.sentText.length * frac);
      return { voicedText: utt.sentText.slice(0, n), unvoicedText: utt.sentText.slice(n), estimated: true };
    }
    return { voicedText: '', unvoicedText: utt.sentText, estimated: true };
  }

  private report(r: UtteranceReport): void {
    for (const fn of this.reportFns) { try { fn(r); } catch { } }
  }
}

export async function createVoiceOutput(env: VoiceEnv, client: unknown): Promise<VoiceOutput> {
  const registry = loadRegistry(env.registryPath);
  const voice = resolveVoice(registry, env.voiceName);
  if (!voice) throw new Error(`no registry voice for "${env.voiceName}" (and no defaultBotVoice)`);
  const { ElevenLabsTtsProvider } = await import('@animalabs/voice-kit');
  const provider = new ElevenLabsTtsProvider(env.elevenKey);
  const sink = new DiscordVoiceSink(env.vadThresholdDb);
  await sink.connect(client, env.guildId, env.voiceChannelId);
  return new VoiceOutput({ textChannels: env.textChannels, maxHoldMs: env.maxHoldMs }, provider, voice, sink);
}

export class DiscordVoiceSink implements PcmSink {
  private player: import('@discordjs/voice').AudioPlayer | null = null;
  private queue: SinkItem[] = [];
  private playing = false;
  private eventFns: Array<(ev: SinkEvent) => void> = [];
  private levelFns: Array<(userId: string, db: number) => void> = [];
  private speakerAudioFns: Array<(speaker: SpeakerInfo, pcm: Buffer) => void> = [];
  private selfId = '';
  private current: {
    id: string;
    resource: import('@discordjs/voice').AudioResource;
    startedAt: number;
    interruptedBy: SpeakerInfo | null;
    yielded: AbortController;
  } | null = null;
  private playingTimeoutMs = 10_000;
  private idleTimeoutMs = 300_000;
  private pipelines = new Map<string, () => void>();
  private packetFallback = new Set<string>();
  private vadMode = true;

  readonly gate = new CarrierGate();

  constructor(private vadThresholdDb: number = VAD_THRESHOLD_DB) {}

  onLevel(fn: (userId: string, db: number) => void): void { this.levelFns.push(fn); }

  /** Decoded per-speaker audio, 48k stereo PCM16. */
  onSpeakerAudio(fn: (speaker: SpeakerInfo, pcm: Buffer) => void): void { this.speakerAudioFns.push(fn); }

  async connect(client: unknown, guildId: string, channelId: string): Promise<void> {
    const { joinVoiceChannel, createAudioPlayer, entersState, NoSubscriberBehavior, VoiceConnectionStatus, EndBehaviorType } =
      await import('@discordjs/voice');
    // prism-media comes with @discordjs/voice, and opus decoding runs on opusscript.
    let prism: typeof import('prism-media') | null = null;
    try { prism = (await import('prism-media')).default ?? await import('prism-media'); }
    catch { this.vadMode = false; }

    const c = client as import('discord.js').Client;
    const guild = await c.guilds.fetch(guildId);
    this.selfId = c.user?.id ?? '';
    const conn = joinVoiceChannel({
      channelId, guildId,
      adapterCreator: guild.voiceAdapterCreator,
      // Not deafened: a deafened connection receives no audio, and Discord shows
      // an undeafened bot as listening.
      selfDeaf: false,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);

    conn.receiver.speaking.on('start', (userId: string) => {
      if (userId === this.selfId) return;
      const u = c.users.cache.get(userId);
      const info: SpeakerInfo = { userId, username: u?.username, bot: u?.bot ?? false };
      if (!this.vadMode || !prism) { this.gate.speakingStart(info); return; }
      this.ensurePipeline(conn.receiver, prism, EndBehaviorType, info);
    });
    conn.receiver.speaking.on('end', (userId: string) => {
      if (!this.vadMode || this.packetFallback.delete(userId)) this.gate.speakingEnd(userId);
    });
    // A synthesized stream doesn't blip: a bot's first voiced frame is real audio.
    this.gate.onSpeakerStart((s) => { if (s.bot) this.maybeYield(s); });
    this.gate.onSpeakerSustained(BARGE_IN_SUSTAIN_MS, (s) => {
      if (!s.bot && (this.packetFallback.has(s.userId) || !this.vadMode)) this.maybeYield(s);
    });

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    conn.subscribe(this.player);
    console.error(
      `[discord-mcpl voice] joined voice channel ${channelId} ` +
      `(carrier-sense on, ${this.vadMode ? `energy VAD @ ${this.vadThresholdDb} dBFS` : 'packet mode — opus decode unavailable'})`,
    );
  }

  private ensurePipeline(
    receiver: import('@discordjs/voice').VoiceReceiver,
    prism: typeof import('prism-media'),
    EndBehaviorType: typeof import('@discordjs/voice').EndBehaviorType,
    info: SpeakerInfo,
  ): void {
    if (this.pipelines.has(info.userId)) return;
    try {
      const opus = receiver.subscribe(info.userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const vad = new EnergyVad({ rateHz: 48000, channels: 2, thresholdDb: this.vadThresholdDb });
      vad.onSpeechStart(() => this.gate.speakingStart(info));
      vad.onSpeechEnd(() => this.gate.speakingEnd(info.userId));
      if (!info.bot) vad.onSpeechSustained(BARGE_IN_SUSTAIN_MS, () => this.maybeYield(info));
      vad.onLevel((db) => { for (const fn of this.levelFns) { try { fn(info.userId, db); } catch { } } });
      const cleanup = () => {
        this.pipelines.delete(info.userId);
        vad.end(); // emits speechEnd → gate, if speech was open
        decoder.destroy();
      };
      opus.once('end', cleanup);
      opus.once('error', cleanup);
      decoder.on('error', (e: Error) => {
        console.error(`[discord-mcpl voice] opus decode error (${info.username ?? info.userId}): ${e.message}`);
        cleanup();
      });
      opus.pipe(decoder).on('data', (pcm: Buffer) => {
        vad.feed(pcm);
        for (const fn of this.speakerAudioFns) { try { fn(info, pcm); } catch { } }
      });
      this.pipelines.set(info.userId, cleanup);
    } catch (err) {
      console.error(`[discord-mcpl voice] VAD pipeline failed (${info.userId}): ${(err as Error).message} — packet fallback`);
      this.packetFallback.add(info.userId);
      this.gate.speakingStart(info);
    }
  }

  play(item: SinkItem): void {
    this.queue.push(item);
    this.kick();
  }

  /** The catch is there because an unhandled rejection ends the process (Node ≥ 15). */
  private kick(): void {
    void this.pump().catch((err) => {
      console.error('[discord-mcpl voice] playback pump:', err);
    });
  }

  cancel(id: string): boolean {
    const i = this.queue.findIndex((item) => item.id === id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  onEvent(fn: (ev: SinkEvent) => void): void { this.eventFns.push(fn); }

  private maybeYield(s: SpeakerInfo): void {
    const cur = this.current;
    if (!cur || cur.interruptedBy) return;
    const human = !s.bot;
    const collision = s.bot &&
      Date.now() - cur.startedAt <= COLLISION_WINDOW_MS &&
      compareSnowflakes(this.selfId, s.userId) > 0;
    if (!human && !collision) return;
    cur.interruptedBy = s;
    // A stop takes a playing item to Idle. An item still waiting for Playing
    // never gets there once stopped, so the abort ends that wait.
    cur.yielded.abort();
    this.player?.stop(true);
  }

  private static waitSignal(ms: number, yielded: AbortSignal): { signal: AbortSignal; done: () => void } {
    const deadline = new AbortController();
    const onYield = () => deadline.abort();
    const timer = setTimeout(onYield, ms);
    if (yielded.aborted) deadline.abort();
    else yielded.addEventListener('abort', onYield, { once: true });
    return {
      signal: deadline.signal,
      done: () => { clearTimeout(timer); yielded.removeEventListener('abort', onYield); },
    };
  }

  private async pump(): Promise<void> {
    if (this.playing || !this.player) return;
    this.playing = true;
    try {
      const { createAudioResource, StreamType, AudioPlayerStatus, entersState } = await import('@discordjs/voice');
      while (this.queue.length) {
        await this.gate.waitClear();
        const item = this.queue.shift();
        if (!item) break;
        let resource: import('@discordjs/voice').AudioResource;
        try {
          resource = createAudioResource(item.stream, { inputType: StreamType.Raw });
          this.current = {
            id: item.id, resource, startedAt: Date.now(), interruptedBy: null, yielded: new AbortController(),
          };
          // AudioPlayer.play throws for a resource that has already ended or
          // that another player is playing (@discordjs/voice).
          this.player.play(resource);
        } catch (err) {
          const refused = this.current;
          this.current = null;
          try { refused?.resource.playStream.destroy(); } catch { }
          console.error(`[discord-mcpl voice] playback refused: ${(err as Error)?.message ?? String(err)}`);
          this.emit({ type: 'failed', id: item.id, playedMs: 0, reason: PlaybackFailure.refused });
          continue;
        }
        // The player accepts the item before any audio arrives, and buffers until
        // it does, so a refused item bills nothing.
        this.emit({ type: 'cleared', id: item.id });
        // entersState rejects with an AbortError when its signal fires, and with
        // the player's own error when the playing stream fails meanwhile (its
        // once() listener is what hears that 'error').
        const yielded = this.current.yielded.signal;
        const wait = async (status: import('@discordjs/voice').AudioPlayerStatus, ms: number, limit: string): Promise<string | null> => {
          const { signal, done } = DiscordVoiceSink.waitSignal(ms, yielded);
          try {
            await entersState(this.player!, status, signal);
            return null;
          } catch (err) {
            if ((err as Error)?.name === 'AbortError') return limit;
            console.error(`[discord-mcpl voice] playback stream: ${(err as Error)?.message ?? String(err)}`);
            return PlaybackFailure.streamFailed;
          } finally {
            done();
          }
        };
        let failure = await wait(AudioPlayerStatus.Playing, this.playingTimeoutMs, PlaybackFailure.noAudio(this.playingTimeoutMs));
        if (!failure) {
          this.emit({ type: 'started', id: item.id });
          failure = await wait(AudioPlayerStatus.Idle, this.idleTimeoutMs, PlaybackFailure.tooLong(this.idleTimeoutMs));
        }
        if (failure) this.player.stop(true);
        const cur = this.current;
        this.current = null;
        const playedMs = Math.round(resource.playbackDuration);
        if (failure && !cur?.interruptedBy) console.error(`[discord-mcpl voice] playback failed: ${failure}`);
        this.emit(cur?.interruptedBy
          ? { type: 'interrupted', id: item.id, playedMs, by: cur.interruptedBy }
          : failure
            ? { type: 'failed', id: item.id, playedMs, reason: failure }
            : { type: 'finished', id: item.id, playedMs });
      }
    } catch (err) {
      const reason = PlaybackFailure.stopped;
      console.error('[discord-mcpl voice] playback stopped:', err);
      const queued = this.queue.splice(0);
      const cur = this.current;
      this.current = null;
      if (cur) {
        try { this.player?.stop(true); } catch { }
        const playedMs = Math.round(cur.resource.playbackDuration);
        this.emit(cur.interruptedBy
          ? { type: 'interrupted', id: cur.id, playedMs, by: cur.interruptedBy }
          : { type: 'failed', id: cur.id, playedMs, reason });
      }
      for (const item of queued) this.emit({ type: 'failed', id: item.id, playedMs: 0, reason });
    } finally {
      this.playing = false;
      if (this.queue.length) this.kick();
    }
  }

  private emit(ev: SinkEvent): void {
    for (const fn of this.eventFns) { try { fn(ev); } catch { } }
  }
}

/** Snowflakes are u64 decimal strings, so they compare by length, then lexicographically. */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
