/**
 * Login retry after an outage at boot (2026-09-25, 2026-09-26: six residents
 * booted while DNS was down). discord.js destroys the client when login()
 * fails, and `destroyed` is never cleared, so a later successful login on the
 * SAME client receives messages but reports isReady() === false forever:
 * every send waited 60 s and failed "Discord is not connected right now".
 * The destroyed manager also refuses to reconnect its shards after a later
 * drop, and destroy() stops the cache sweepers.
 *
 * Fix: probe the gateway endpoint before any login (an unreachable network
 * never touches the client), and if a login fails anyway, replace the client.
 * whenReady() is owned by the adapter, so waiters survive a replacement.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { Client, GatewayIntentBits, Status } from 'discord.js';

const { DiscordAdapter } = await import('../src/discord-adapter.js');

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

/** A stand-in for discord.js Client with the same lifecycle rules:
 *  a failed login destroys it for good. */
class FakeClient extends EventEmitter {
  static made: FakeClient[] = [];
  destroyed = false;
  ready = false;
  logins = 0;
  constructor(private readonly plan: { failLogin: boolean }) {
    super();
    FakeClient.made.push(this);
  }
  isReady(): boolean { return !this.destroyed && this.ready; }
  async login(): Promise<string> {
    this.logins++;
    if (this.plan.failLogin) { this.destroyed = true; throw new Error('getaddrinfo ENOTFOUND discord.com'); }
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

function adapterWith(opts: { probe: () => Promise<void>; failLogins: number }) {
  FakeClient.made = [];
  let built = 0;
  const adapter = new DiscordAdapter({
    token: 'not-used',
    clientFactory: () => new FakeClient({ failLogin: built++ < opts.failLogins }) as unknown as Client,
    probeGateway: opts.probe,
  });
  return adapter;
}

describe('connectWithRetry', () => {
  it('network down at boot: never logs in until the gateway is reachable, then connects cleanly', async () => {
    let probes = 0;
    const loginsAtFailedProbes: number[] = [];
    const adapter = adapterWith({
      probe: async () => {
        if (++probes < 3) {
          loginsAtFailedProbes.push(FakeClient.made.reduce((n, c) => n + c.logins, 0));
          throw new Error('getaddrinfo ENOTFOUND discord.com');
        }
      },
      failLogins: 0,
    });
    const waiter = adapter.whenReady(); // registered while down, as index.ts does
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(waiter);
    assert.equal(probes, 3);
    assert.deepEqual(loginsAtFailedProbes, [0, 0], 'no login before or during a failed probe');
    assert.equal(FakeClient.made.length, 1, 'the client was never destroyed, so never replaced');
    assert.equal(FakeClient.made[0]!.logins, 1, 'no login while the network was down');
    assert.equal(adapter.isConnected, true);
  });

  it('a login that fails anyway gets a fresh client; waiters from before the swap still resolve', async () => {
    const adapter = adapterWith({ probe: async () => {}, failLogins: 1 });
    const waiter = adapter.whenReady();
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(waiter);
    assert.equal(FakeClient.made.length, 2);
    assert.equal(FakeClient.made[0]!.destroyed, true);
    assert.equal(adapter.isConnected, true, 'the connected check reads the live client, not the destroyed one');
    assert.equal((adapter as unknown as { rawClient: unknown }).rawClient, FakeClient.made[1]);
  });

  it('whenReady() after connecting resolves immediately', async () => {
    const adapter = adapterWith({ probe: async () => {}, failLogins: 0 });
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(adapter.whenReady());
  });
});

describe('a token Discord refuses', () => {
  const refused = () => Object.assign(new Error('401: Unauthorized'), { status: 401 });

  it('ends the connect at the probe with an error naming DISCORD_TOKEN, with no login and no retry', async () => {
    let probes = 0;
    const adapter = adapterWith({ probe: async () => { probes++; throw refused(); }, failLogins: 0 });
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), /DISCORD_TOKEN/);
    assert.equal(probes, 1);
    assert.equal(FakeClient.made[0]!.logins, 0);
  });

  it('ends the connect at login with an error naming DISCORD_TOKEN, with no fresh client', async () => {
    FakeClient.made = [];
    const client = new FakeClient({ failLogin: false });
    client.login = async () => { client.logins++; client.destroyed = true; throw Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }); };
    const adapter = new DiscordAdapter({ token: 'not-used', clientFactory: () => client as unknown as Client, probeGateway: async () => {} });
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), /DISCORD_TOKEN/);
    assert.equal(client.logins, 1);
    assert.equal(FakeClient.made.length, 1);
  });
});

describe('other refusals no wait would change', () => {
  it('a probe answered with a 4xx other than 429 ends the connect, naming the developer portal, with no login', async () => {
    let probes = 0;
    const adapter = adapterWith({ probe: async () => { probes++; throw Object.assign(new Error('403: Forbidden'), { status: 403 }); }, failLogins: 0 });
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), /403: Forbidden.*developer portal/);
    assert.equal(probes, 1);
    assert.equal(FakeClient.made[0]!.logins, 0);
  });

  it('a probe answered with a 5xx or a 429 is retried', async () => {
    let probes = 0;
    const adapter = adapterWith({
      probe: async () => {
        probes++;
        if (probes === 1) throw Object.assign(new Error('503: Service Unavailable'), { status: 503 });
        if (probes === 2) throw Object.assign(new Error('429: Too Many Requests'), { status: 429 });
      },
      failLogins: 0,
    });
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    assert.equal(probes, 3);
    assert.equal(adapter.isConnected, true);
  });

  it("a login closed for intents Discord doesn't allow ends the connect, naming the intents, with no fresh client", async () => {
    FakeClient.made = [];
    const client = new FakeClient({ failLogin: false });
    client.login = async () => { client.logins++; client.destroyed = true; throw new Error('Used disallowed intents'); };
    const adapter = new DiscordAdapter({ token: 'not-used', clientFactory: () => client as unknown as Client, probeGateway: async () => {} });
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), /Used disallowed intents.*Server Members and Message Content/);
    assert.equal(client.logins, 1);
    assert.equal(FakeClient.made.length, 1);
  });
});

describe('connecting', () => {
  it('is false before a connect starts, true while the gateway is unreachable, and false once it is ready', async () => {
    let probes = 0;
    let during: boolean | undefined;
    const adapter = adapterWith({ probe: async () => { if (++probes < 2) { during = adapter.connecting; throw new Error('getaddrinfo ENOTFOUND discord.com'); } }, failLogins: 0 });
    assert.equal(adapter.connecting, false);
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    assert.equal(during, true);
    assert.equal(adapter.connecting, false);
    assert.equal(adapter.isConnected, true);
  });

  it('is false once a refused token has ended the connect', async () => {
    let probes = 0;
    let during: boolean | undefined;
    const adapter = adapterWith({
      probe: async () => { probes++; during = adapter.connecting; throw Object.assign(new Error('401: Unauthorized'), { status: 401 }); },
      failLogins: 0,
    });
    await assert.rejects(within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 })), /DISCORD_TOKEN/);
    assert.equal(probes, 1);
    assert.equal(during, true);
    assert.equal(adapter.connecting, false);
  });
});
