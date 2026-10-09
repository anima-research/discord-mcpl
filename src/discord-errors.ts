/**
 * What Discord's answer means for the id a tool was given.
 *
 * A name that matches several channels comes back with every match listed
 * by its qualified name (channel-names.ts), so the next call can pick one.
 * An id Discord doesn't know comes back as two words, "Unknown Channel",
 * which says nothing about what went wrong or what to do instead. An id has
 * no candidates to list the way a name has, so the explanation names what
 * the answer means for the id that was passed and how to get a real one.
 * Ids get misremembered: one recalled rather than copied is the commonest
 * way to reach this.
 *
 * The explanation is appended after the error's own text, so Discord's words
 * and anything a tool path added to them (such as where a send was aimed)
 * stay as they were. Errors other than these four pass through unchanged.
 */

/** Discord's JSON error codes for an id it can't resolve, or can't reach. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_USER = 10013;
const MISSING_ACCESS = 50001;

export function explainDiscordError(err: unknown, args: Record<string, unknown>): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const given = (key: string): string | undefined =>
    typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
  const channel = given('channelId');
  let why: string | undefined;
  switch (code) {
    case UNKNOWN_CHANNEL:
      why =
        `${channel ? `No channel ${channel}` : 'No such channel'} is visible to this connection: the id may be ` +
        'mistyped or remembered rather than copied, or the channel deleted. Copy a channel id from ' +
        "list_channels or from a message's source, or pass the channel as #name (a name that matches " +
        'several channels lists them).';
      break;
    case UNKNOWN_MESSAGE:
      why =
        `${given('messageId') ? `No message ${given('messageId')}` : 'No such message'} is visible` +
        `${channel ? ` in channel ${channel}` : ''}: the id may be mistyped or remembered rather than copied, ` +
        'the message deleted, or in another channel. Copy the message id from fetch_history or from the ' +
        'message as it arrived, with the channel it arrived in.';
      break;
    case UNKNOWN_USER:
      why =
        `${given('userId') ? `No user ${given('userId')}` : 'No such user'} is known to Discord: the id may be ` +
        "mistyped or remembered rather than copied. Copy a user id from a message's author or from " +
        'list_channel_members, or pass their @username.';
      break;
    case MISSING_ACCESS:
      why =
        `This bot can't reach ${channel ? `channel ${channel}` : 'what this call needs'}: it isn't in that ` +
        "server, or the channel's permissions leave it out. list_channels shows the channels it can use.";
      break;
  }
  return why ? `${message}\n\n${why}` : message;
}
