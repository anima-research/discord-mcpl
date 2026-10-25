import { appendFileSync } from 'node:fs';

export function dbg(tag: string, info: Record<string, unknown> = {}): void {
  const DEBUG_LOG_PATH = process.env.DISCORD_MCPL_DEBUG_LOG;
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${tag} ${JSON.stringify(info)}\n`,
    );
  } catch {
    // Logging is best-effort; never break Discord delivery because of it.
  }
}
