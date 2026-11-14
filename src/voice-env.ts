/**
 * Imports only Node built-ins, so index.ts can tell whether voice is
 * configured without loading ./voice.js, whose top-level
 * @animalabs/voice-kit import would make every instance require voice-kit at
 * startup.
 */

/** A client with noise suppression off transmits continuously, so packet
 *  presence would read as speaking forever. */
export const VAD_THRESHOLD_DB = -45;

export interface VoiceEnv {
  guildId: string;
  voiceChannelId: string;
  registryPath: string;
  voiceName: string;
  textChannels: string[] | null;
  elevenKey: string;
  vadThresholdDb: number;
  maxHoldMs: number | null;
}

export function voiceEnv(): VoiceEnv | null {
  const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  if (!voiceChannelId) return null;
  const guildId = process.env.DISCORD_VOICE_GUILD_ID;
  const registryPath = process.env.DISCORD_VOICE_REGISTRY_FILE;
  const voiceName = process.env.DISCORD_VOICE_NAME;
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const missing = [
    !guildId && 'DISCORD_VOICE_GUILD_ID',
    !registryPath && 'DISCORD_VOICE_REGISTRY_FILE',
    !voiceName && 'DISCORD_VOICE_NAME',
    !elevenKey && 'ELEVENLABS_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`[discord-mcpl voice] DISCORD_VOICE_CHANNEL_ID set but missing: ${missing.join(', ')} — voice disabled`);
    return null;
  }
  const channels = (process.env.DISCORD_VOICE_TEXT_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const vadDb = Number(process.env.DISCORD_VOICE_VAD_DB);
  const maxHold = Number(process.env.DISCORD_VOICE_MAX_HOLD_MS);
  return {
    guildId: guildId!, voiceChannelId, registryPath: registryPath!, voiceName: voiceName!,
    textChannels: channels.length ? channels : null, elevenKey: elevenKey!,
    vadThresholdDb: Number.isFinite(vadDb) ? vadDb : VAD_THRESHOLD_DB,
    // Clamp to Node's timer ceiling (2^31-1 ms): above it setTimeout fires
    // after 1 ms, so an unclamped value would drop replies almost at once
    // while their receipts claim the configured hold (R1-1). Whole ms only.
    maxHoldMs: Number.isFinite(maxHold) && maxHold >= 1 ? Math.min(Math.trunc(maxHold), 2_147_483_647) : null,
  };
}
