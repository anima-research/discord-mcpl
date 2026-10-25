#!/usr/bin/env node

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { DiscordAdapter } from './discord-adapter.js';
import { DiscordMcplServer, serveStdio, serveTcp } from './server.js';
import {
  resolveStartupFilters,
  loadFiltersFile,
  filtersFileMtime,
  FiltersFilePollTracker,
} from './filters.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !tcpPort) {
    console.error('Usage: discord-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN environment variable is required');
    process.exit(1);
  }

  const filtersFile = process.env.DISCORD_FILTERS_FILE;
  const { filters, fileBroken: filtersFileBroken } = resolveStartupFilters(filtersFile);

  const discord = new DiscordAdapter({
    token,
    guildIds: filters.guildIds,
    guildChannels: filters.guildChannels,
    dmUsers: filters.dmUsers,
  });

  const discordReady = new Promise<void>((resolve) => {
    discord.onReady(() => {
      console.error(`[discord-mcpl] Discord connected as bot ${discord.botUserId}`);
      resolve();
    });
  });

  await discord.connect();
  await discordReady;

  // Built before the server, so the initialize handshake can declare
  // channels.streaming. ./voice.js is imported only after the env check, inside
  // the try: it pulls @animalabs/voice-kit at top level, which a box without
  // voice configured may not have.
  const { voiceEnv } = await import('./voice-env.js');
  let voice = null as import('./voice.js').VoiceOutput | null;
  const vEnv = voiceEnv();
  if (vEnv) {
    try {
      const { createVoiceOutput } = await import('./voice.js');
      voice = await createVoiceOutput(vEnv, discord.rawClient);
    } catch (err) {
      console.error('[discord-mcpl] voice setup failed:', (err as Error).message, '— continuing text-only');
    }
  }

  const server = new DiscordMcplServer(discord, voice);
  await server.setupDmRefusals();

  if (filtersFileBroken) {
    server.filtersState.markBroken('invalid');
  } else {
    server.filtersState.applyParsed(filters);
  }

  if (filtersFile) {
    const tracker = new FiltersFilePollTracker(filtersFileMtime(filtersFile));
    const poll = setInterval(() => {
      const action = tracker.observe(filtersFileMtime(filtersFile));
      if (action === 'none') return;
      if (action === 'missing') {
        if (server.filtersState.markBroken('missing')) {
          console.error(
            `[discord-mcpl] filters file ${filtersFile} is MISSING — plane is stale; ` +
              'last-known-good filters stay in force until the file reappears',
          );
        }
        return;
      }
      const next = loadFiltersFile(filtersFile);
      if (!next) {
        if (server.filtersState.markBroken('invalid')) {
          console.error(
            `[discord-mcpl] filters file changed but is unparseable — keeping previous filters (${filtersFile})`,
          );
        }
        return;
      }
      const diff = server.applyReloadedFilters(next);
      console.error(
        `[discord-mcpl] filters hot-reloaded from ${filtersFile} ` +
          `(guilds +${diff.addedGuilds.length}/-${diff.removedGuilds.length})`,
      );
    }, 3000);
    poll.unref();
  }

  // Command registration needs the applications.commands scope; a failure shouldn't take down the surface.
  try {
    await server.setupSlashCommands();
    console.error('[discord-mcpl] Slash commands registered');
  } catch (err) {
    console.error('[discord-mcpl] Slash command setup failed:', (err as Error).message);
  }

  if (useStdio) {
    // Log to stderr: stdout is the protocol channel.
    console.error('[discord-mcpl] Starting on stdio');
    await serveStdio(server, McplConnection.fromStreams(process.stdin, process.stdout));
  } else if (tcpPort) {
    console.error(`[discord-mcpl] Listening on TCP port ${tcpPort}`);
    const tcpServer = net.createServer();
    tcpServer.listen(tcpPort, '127.0.0.1');

    // A failure to listen (the port taken) emits 'error' with no listener yet, which ends the process, as it should.
    await new Promise<void>((resolve) => tcpServer.once('listening', resolve));

    serveTcp(tcpServer, (conn) => server.serve(conn));
  }
}

main().catch((err) => {
  console.error('[discord-mcpl] Fatal error:', err);
  process.exit(1);
});
