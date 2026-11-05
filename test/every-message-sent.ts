/**
 * The server reports the deletion of a message only if it knows the agent was
 * sent it. A test of what else decides a deletion's delivery would pass for that
 * reason alone, whatever it's testing, so for those every message counts as sent.
 */
class EveryMessageSent extends Map<string, string | undefined> {
  override has(): boolean {
    return true;
  }
}

export function countEveryMessageAsSent(server: unknown): void {
  (server as { sentMessages: Map<string, string | undefined> }).sentMessages = new EveryMessageSent();
}
