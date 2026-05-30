/**
 * MCP tool definitions and input types for Discord operations.
 * These tools work in both MCP and MCPL mode.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Reusable schema for the optional `files` attachment parameter on send tools. */
const FILES_PROP = {
  type: 'array',
  description:
    'Optional file attachments to upload with the message. Each entry is read ' +
    'from a local filesystem path on the host (e.g. a file you created in your ' +
    'workspace or sandbox). Up to 10 files per message; size limits are enforced ' +
    'by Discord.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute local filesystem path to the file to upload' },
      name: { type: 'string', description: 'Optional display filename (defaults to the basename of path)' },
      description: { type: 'string', description: 'Optional alt-text / description shown for accessibility' },
    },
    required: ['path'],
  },
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a message to a Discord channel, optionally with file attachments',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        content: { type: 'string', description: 'Message content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['channelId'],
    },
  },
  {
    name: 'reply_message',
    description: 'Reply to a specific message in a Discord channel, optionally with file attachments',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to reply to' },
        content: { type: 'string', description: 'Reply content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'send_dm',
    description: 'Send a direct message to a Discord user, optionally with file attachments',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Discord user ID' },
        content: { type: 'string', description: 'Message content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['userId'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add a reaction (emoji) to a message',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to react to' },
        emoji: { type: 'string', description: 'Emoji (unicode or custom :name:)' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to edit' },
        content: { type: 'string', description: 'New message content' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to delete' },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'list_guilds',
    description: 'List Discord guilds (servers) the bot is in',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_channels',
    description: 'List channels in a Discord guild',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Discord guild ID' },
      },
      required: ['guildId'],
    },
  },
  {
    name: 'refresh_channels',
    description:
      'Re-scan every Discord channel the bot can currently see and register any ' +
      'that the host does not yet know about. Use this if you were added to a new ' +
      'server or channel after startup and it is not showing up in your channel ' +
      'list. Returns the count of visible channels and any newly-registered ones.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'fetch_history',
    description: 'Fetch recent message history from a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        limit: { type: 'number', description: 'Max messages to fetch (default 50)' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'create_text_channel',
    description: 'Create a new text channel in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Discord guild ID' },
        name: { type: 'string', description: 'Channel name' },
        categoryId: { type: 'string', description: 'Parent category ID (optional)' },
      },
      required: ['guildId', 'name'],
    },
  },
  {
    name: 'delete_channel',
    description: 'Delete a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID to delete' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'subscribe_channel',
    description:
      'Subscribe to ambient (non-mention) messages from a Discord channel. ' +
      'Direct mentions and DMs always come through regardless of subscriptions; ' +
      'this only controls passive awareness of channel chatter. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID to subscribe to' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'unsubscribe_channel',
    description:
      'Stop receiving ambient messages from a Discord channel. Mentions and DMs ' +
      'from that channel will still arrive. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID to unsubscribe from' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'list_subscriptions',
    description:
      'List the Discord channels currently subscribed for ambient message ' +
      'delivery. Returns the channel IDs as an array.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
