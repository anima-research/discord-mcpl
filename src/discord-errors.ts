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
 * stay as they were. Errors other than these five pass through unchanged.
 */

/** Discord's JSON error codes for an id it can't resolve, or can't reach. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_GUILD = 10004;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_USER = 10013;
const MISSING_ACCESS = 50001;

export function explainDiscordError(err: unknown, args: Record<string, unknown>): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const given = (key: string): string | undefined =>
    typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
  const channel = given('channelId');
  const guild = given('guildId');
  let why: string | undefined;
  switch (code) {
    case UNKNOWN_CHANNEL:
      // The name path is the cure that already lists candidates: it either
      // resolves or returns every channel it matches, qualified. It covers
      // server channels only (resolveChannelRef leaves out threads,
      // categories and DMs), so a thread or DM is pointed at its id's
      // sources instead: a thread's name retried could match a same-named
      // channel.
      why =
        `${channel ? `No channel ${channel}` : 'No such channel'} is visible to this connection. For a ` +
        'server channel, re-send with its name instead (#name, or #name (Server)): a name either resolves ' +
        'or lists every channel it matches. A thread or DM has no name route: copy its id from a message ' +
        'that arrived there, whose source names it. The id may be mistyped or remembered rather than ' +
        'copied, or the channel deleted.';
      break;
    case UNKNOWN_GUILD:
      why =
        `${guild ? `No server ${guild}` : 'No such server'} is visible to this connection: the id may be ` +
        'mistyped or remembered rather than copied, or the bot no longer in it. list_guilds shows the ' +
        'servers this bot is in, with their ids.';
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
        `${given('userId') ? `No user ${given('userId')}` : 'No such user'} is known to Discord. Re-send with ` +
        'their @username or display name instead. The id may be mistyped or remembered rather than copied; ' +
        "a message's author and list_channel_members show real ids.";
      break;
    case MISSING_ACCESS:
      // Named by what the call was aimed at: a channel, else a server.
      why = channel
        ? `This bot can't reach channel ${channel}: it isn't in that server, or the channel's permissions ` +
          'leave it out. list_channels shows the channels it can use.'
        : guild
          ? `This bot can't reach server ${guild}: it isn't in it, or can't see what this call needs there. ` +
            'list_guilds shows the servers it is in.'
          : "This bot can't reach what this call needs: it isn't in that server, or permissions leave it out.";
      break;
  }
  return why ? `${message}\n\n${why}` : message;
}
