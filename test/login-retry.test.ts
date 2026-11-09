/**
 * Login retry after an outage at boot (2026-09-25, 2026-09-26: six residents
 * booted while DNS was down). discord.js destroys the client when login()
 * fails, and `destroyed` is never cleared, so a later successful login on the
 * SAME client receives messages but reports isReady() === false forever:
 * every send waited 60 s and failed "Discord is not connected right now".
 * The destroyed manager also refuses to reconnect its shards after a later
 * drop, and destroy() stops the cache sweepers.
 *
 * Fix: a failed login replaces the client before the next attempt.
 * whenReady() is owned by the adapter, so waiters survive a replacement.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Client, GatewayIntentBits, Status } from 'discord.js';

const { DiscordAdapter, CONFIGURATION_CLOSES } = await import('../src/discord-adapter.js');

describe('the library behaviour behind the bug', () => {
  it('a failed login leaves the client destroyed: isReady() stays false even at status Ready', async () => {
    // Refused connection = "network down" for the REST call login() makes first: a port just bound and closed.
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: p } = s.address() as net.AddressInfo;
        s.close(() => resolve(p));
      });
    });
    const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `http://127.0.0.1:${port}`, retries: 0, timeout: 2_000 } });
    await assert.rejects(client.login('not-a-real-token'), (err: unknown) => {
      const e = err as { code?: unknown; cause?: { code?: unknown } };
      assert.equal(e.cause?.code ?? e.code, 'ECONNREFUSED', String(err));
      return true;
    });
    assert.equal((client.ws as unknown as { destroyed: boolean }).destroyed, true);
    (client.ws as unknown as { status: Status }).status = Status.Ready; // what a later successful login sets
    assert.equal(client.isReady(), false, 'the flag the connector trusted can never recover');
    await client.destroy();
  });
});

describe("the gateway's messages the refusals match", () => {
  it('the installed @discordjs/ws still constructs an error with each message refusal() matches', () => {
    const require = createRequire(import.meta.url);
    const ws = readFileSync(require.resolve('@discordjs/ws', { paths: [require.resolve('discord.js')] }), 'utf8');
    for (const message of ['Authentication failed', ...Object.keys(CONFIGURATION_CLOSES)]) {
      assert.ok(ws.includes(`new Error("${message}")`), `@discordjs/ws no longer says "${message}"`);
    }
  });
});

/** A stand-in for discord.js Client with the same lifecycle rules:
 *  a failed login destroys it for good. */
class FakeClient extends EventEmitter {
  static made: FakeClient[] = [];
  destroyed = false;
  ready = false;
  logins = 0;
  constructor(private readonly fail: (() => Error) | null) {
    super();
    FakeClient.made.push(this);
  }
  isReady(): boolean { return !this.destroyed && this.ready; }
  async login(): Promise<string> {
    this.logins++;
    if (this.fail) { this.destroyed = true; throw this.fail(); }
    // As a real client can, it turns ready only after login resolves.
    setImmediate(() => { this.ready = true; this.emit('ready', this); });
    return 'token';
  }
  async destroy(): Promise<void> { this.destroyed = true; }
  // The adapter listens on the gateway manager for raw dispatches and wraps the client's ThreadListSync action at
  // construction; setupEvents() reads a few client fields when handlers fire, and none fire here.
  readonly ws = Object.assign(new EventEmitter(), { status: 0, ping: -1 });
  readonly actions = { ThreadListSync: { handle(): void {} } };
  get guilds() { return { cache: new Map() }; }
}

/** Fail (not hang) if a connect never completes. */
function within<T>(p: Promise<T>, ms = 3_000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms).unref())]);
}

const unreachable = () => new Error('getaddrinfo ENOTFOUND discord.com');

/** An adapter whose clients' logins fail with each of `failures` in turn, then succeed. */
function adapterWith(failures: Array<() => Error>) {
  FakeClient.made = [];
  let built = 0;
  const adapter = new DiscordAdapter({
    token: 'not-used',
    clientFactory: () => new FakeClient(failures[built++] ?? null) as unknown as Client,
  });
  return adapter;
}

describe('connectWithRetry', () => {
  it('network down at boot: each failed login gets a fresh client, and the connect completes once Discord answers', async () => {
    const adapter = adapterWith([unreachable, unreachable]);
    const waiter = adapter.whenReady(); // registered while down, as index.ts does
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(waiter);
    assert.equal(FakeClient.made.length, 3);
    assert.deepEqual(FakeClient.made.map((c) => [c.logins, c.destroyed]), [[1, true], [1, true], [1, false]]);
    assert.equal(adapter.isConnected, true, 'the connected check reads the live client, not a destroyed one');
    assert.equal((adapter as unknown as { rawClient: unknown }).rawClient, FakeClient.made[2]);
  });

  it('whenReady() after connecting resolves immediately', async () => {
    const adapter = adapterWith([]);
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    const first = await Promise.race([
      adapter.whenReady().then(() => 'ready'),
      new Promise((r) => setImmediate(() => r('next turn'))),
    ]);
    assert.equal(first, 'ready', 'resolves before the event loop turns');
  });

  it('a login failing with a 5xx, a 408 or a 429 is retried', async () => {
    const adapter = adapterWith([
      () => Object.assign(new Error('503: Service Unavailable'), { status: 503 }),
      () => Object.assign(new Error('408: Request Timeout'), { status: 408 }),
      () => Object.assign(new Error('429: Too Many Requests'), { status: 429 }),
    ]);
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    assert.equal(FakeClient.made.length, 4);
    assert.equal(adapter.isConnected, true);
  });
});

describe('refusals no wait would change', () => {
  const refuses = async (error: () => Error, pattern: RegExp) => {
    const adapter = adapterWith([error]);
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), pattern);
    assert.equal(FakeClient.made.length, 1, 'no fresh client, so no retry');
    assert.equal(FakeClient.made[0]!.logins, 1);
  };

  it('a token refused at login ends the connect, naming DISCORD_TOKEN', async () => {
    await refuses(() => Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }), /DISCORD_TOKEN/);
  });

  it('a login answered with a 4xx other than 429 ends the connect, naming the developer portal', async () => {
    await refuses(() => Object.assign(new Error('403: Forbidden'), { status: 403 }), /403: Forbidden.*developer portal/);
  });

  it("a login closed for intents Discord doesn't allow ends the connect, naming the intents", async () => {
    await refuses(() => new Error('Used disallowed intents'), /Used disallowed intents.*Server Members and Message Content/);
  });

  it('a message that only matches an inherited key is retried, not refused', async () => {
    const adapter = adapterWith([() => new Error('constructor')]);
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    assert.equal(FakeClient.made.length, 2);
  });
});

describe('connecting', () => {
  it('is false before a connect starts, true while logins fail, and false once it is ready', async () => {
    let during: boolean | undefined;
    const adapter = adapterWith([() => { during = adapter.connecting; return unreachable(); }]);
    assert.equal(adapter.connecting, false);
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    assert.equal(during, true);
    assert.equal(adapter.connecting, false);
    assert.equal(adapter.isConnected, true);
  });

  it('is false once a refusal has ended the connect', async () => {
    let during: boolean | undefined;
    const adapter = adapterWith([() => { during = adapter.connecting; return Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }); }]);
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), /DISCORD_TOKEN/);
    assert.equal(during, true);
    assert.equal(adapter.connecting, false);
  });
});
