/**
 * The session module, unit-tested against a fake derivation and a fake transport.
 *
 * The fake derivation is *deterministic* (a fixed seed, a fixed salt) so that the test can
 * assert exact values — `auth_secret = authSecret(known seed)`, not merely "something
 * happened". The real Argon2id is pinned by `crypto.test.ts` and by `roundtrip.test.ts`
 * against a live server; these tests exist to prove the *wiring*: what goes over the wire,
 * when, and what happens when the wire refuses.
 *
 * The rule that no live test may substitute the fake is structural: `forTests` is a separate
 * factory, and the real path (`session.connect`/`session.create` in `index.ts`) takes no
 * derivation parameter at all. Substitution is a different function call, visible in review,
 * not a default to override.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authSecret } from '../src/crypto/account.js';
import { randomBytes, toBase64 } from '../src/crypto/bytes.js';
import { forTests, type Connection, type Derivation } from '../src/session/index.js';
import type { Transport, HttpRequest, HttpResponse } from '../src/api/transport.js';

/** A fixed seed, so `authSecret(seed)` is a known value the test can assert. */
const KNOWN_SEED = new Uint8Array(32).fill(0x42);
const KNOWN_SALT = new Uint8Array(16).fill(0x01);

/** A derivation that counts its calls and returns the fixed seed. */
const fakeDerivation = (): Derivation & { calls: number } => {
  const d = {
    calls: 0,
    create(passphrase: string) {
      d.calls++;
      return {
        seed: KNOWN_SEED,
        accountSalt: KNOWN_SALT,
        kdfParams: { v: 19, m: 65536, t: 3, p: 1 },
        wrappedSeed: toBase64(new Uint8Array(40).fill(0x99)), // plausible, not real
      };
    },
    open(passphrase: string, accountSalt: Uint8Array, kdfParams: { v: number; m: number; t: number; p: number }, wrappedSeed: string) {
      d.calls++;
      if (passphrase === 'wrong') throw new Error('invalid tag'); // AEAD refuses
      return {
        seed: KNOWN_SEED,
        accountSalt,
        kdfParams,
        wrappedSeed,
      };
    },
  };
  return d;
};

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

/** A transport that records every call and returns canned answers per path. */
const fakeTransport = (answers: Record<string, { status: number; body: unknown }>): Transport & { calls: RecordedRequest[] } => {
  const calls: RecordedRequest[] = [];
  const t: Transport & { calls: RecordedRequest[] } = Object.assign(
    async (req: HttpRequest): Promise<HttpResponse> => {
      calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body });
      const key = `${req.method} ${new URL(req.url).pathname}`;
      const answer = answers[key];
      if (!answer) throw new Error(`no canned answer for ${key}`);
      const text = JSON.stringify(answer.body);
      return {
        status: answer.status,
        headers: {},
        text: () => text,
        bytes: new TextEncoder().encode(text),
      };
    },
    { calls },
  );
  return t;
};

/** The canned answers a healthy server gives to the session's calls. */
const okAnswers = () => ({
  'POST /auth/redeem': { status: 200, body: { access: 'acc-1', refresh: 'ref-1', device_id: 'dev-1', vault_id: '11111111-1111-4111-8111-111111111111', root_node_id: 'root-1' } },
  'POST /auth/login': { status: 200, body: { access: 'acc-1', refresh: 'ref-1' } },
});

const conn = (): Connection => ({
  serverUrl: 'http://x.test',
  login: 'alice',
  deviceId: 'dev-1',
  vaultId: '11111111-1111-4111-8111-111111111111',
  wrappedSeed: toBase64(new Uint8Array(40).fill(0x99)),
  accountSalt: toBase64(KNOWN_SALT),
  kdfParams: { v: 19, m: 65536, t: 3, p: 1 },
});

const connectArgs = (overrides: Partial<Parameters<typeof import('../src/session/index.js').session.connect>[0]> = {}) => ({
  serverUrl: 'http://x.test',
  login: 'alice',
  invitationToken: 'tok-1',
  passphrase: 'correct horse battery staple',
  vaultName: 'Мій сейф',
  ...overrides,
});

describe('Session.connect', () => {
  it('claims the invitation, derives the keys once, and returns an open session', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { connect } = forTests({ derivation, transport });

    const session = await connect(connectArgs());

    assert.equal(session.state, 'open');
    assert.equal(derivation.calls, 1, 'one derivation, not several');

    // The redeem call carries the auth_secret derived from the seed — never the passphrase.
    const redeem = transport.calls.find((c) => c.url.includes('/auth/redeem'))!;
    const body = JSON.parse(redeem.body as string);
    assert.equal(body.auth_secret, authSecret(KNOWN_SEED), 'the server gets the derived secret');
    assert.ok(!JSON.stringify(body).includes('correct horse'), 'the passphrase is not in the body');
    assert.ok(!redeem.url.includes('correct'), 'nor in the URL');

    // The connection record is returned for the plugin to persist.
    const record = session.connection;
    assert.equal(record.login, 'alice');
    assert.equal(record.vaultId, '11111111-1111-4111-8111-111111111111');
    assert.equal(record.deviceId, 'dev-1');
    assert.equal(record.accountSalt, toBase64(KNOWN_SALT));
  });

  it('sends KDF parameters that meet the server floor (#62)', async () => {
    // This test uses the fake derivation, so the kdf_params come from the fake. The *live*
    // proof that the real derivation meets the floor is in roundtrip.test.ts — the only
    // place real Argon2id runs against a real server. Here we assert the wiring: the params
    // the session hands out are the ones it received from derivation.
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { connect } = forTests({ derivation, transport });

    await connect(connectArgs());

    const body = JSON.parse(transport.calls.find((c) => c.url.includes('/auth/redeem'))!.body as string);
    assert.deepEqual(body.kdf_params, { v: 19, m: 65536, t: 3, p: 1 });
  });

  it('a failed redeem leaves nothing: no session, no cached seed', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport({
      'POST /auth/redeem': { status: 400, body: { error: 'invitation_spent' } },
    });
    const { connect } = forTests({ derivation, transport });

    await assert.rejects(() => connect(connectArgs()));

    // The derivation ran (it must, to build the request), but no session was returned.
    assert.equal(derivation.calls, 1, 'derivation ran to build the request');
    // No session object exists to hold the seed — the plugin has nothing to persist.
  });
});

describe('Session.create + open', () => {
  it('starts locked and stays locked without a passphrase', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    assert.equal(session.state, 'locked');
    assert.equal(await session.open(), 'locked');
    assert.equal(derivation.calls, 0, 'no derivation run for a missing passphrase');
  });

  it('unlocks once and reuses the handle until lock()', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    assert.equal(await session.open('correct horse battery staple'), 'open');
    assert.equal(derivation.calls, 1);

    // The second open() costs nothing: no derivation, no login round-trip.
    assert.equal(await session.open(), 'open');
    assert.equal(derivation.calls, 1, 'the handle is reused — one Argon2 run per unlock');

    // And the login call went out with the derived secret, not the passphrase.
    const login = transport.calls.find((c) => c.url.includes('/auth/login'))!;
    const body = JSON.parse(login.body as string);
    assert.equal(body.auth_secret, authSecret(KNOWN_SEED));
    assert.ok(!JSON.stringify(body).includes('correct horse'));
  });

  it('lock() drops the handle and both tokens; the next open() needs the phrase again', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    await session.open('correct horse battery staple');
    assert.equal(session.lock(), 'locked');
    assert.equal(session.state, 'locked');

    // The refresh token is gone: the next request after lock must not silently mint a new
    // access token, because that would make lock a lie.
    const callsBefore = transport.calls.length;
    await assert.rejects(() => session.use(async (h) => h.client.listVaults()));
    assert.equal(transport.calls.length, callsBefore, 'no request was even attempted');

    // Re-unlock derives again.
    assert.equal(await session.open('correct horse battery staple'), 'open');
    assert.equal(derivation.calls, 2, 'a second unlock is a second derivation');
  });

  it('a wrong passphrase throws and leaves the session locked', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    await assert.rejects(() => session.open('wrong'), /invalid tag/);
    assert.equal(session.state, 'locked', 'no half-open state: the seed was never set');
    assert.equal(derivation.calls, 1, 'the derivation ran and failed');
  });
});

describe('Session.use and lock — the busy guard', () => {
  it('lock() returns busy while a use() is in flight', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    await session.open('correct horse battery staple');

    let lockedDuringUse: 'locked' | 'busy' | undefined;
    await session.use(async () => {
      lockedDuringUse = session.lock();
    });

    assert.equal(lockedDuringUse, 'busy', 'lock() refused while work was out');
    assert.equal(session.state, 'open', 'the busy lock cleared nothing');
  });

  it('lock() succeeds once the use() callback returns', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    await session.open('correct horse battery staple');

    await session.use(async () => {});
    assert.equal(session.lock(), 'locked');
  });

  it('lock() succeeds even when the use() callback threw', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    await session.open('correct horse battery staple');

    await assert.rejects(() =>
      session.use(async () => {
        throw new Error('boom');
      }),
    );
    assert.equal(session.lock(), 'locked', 'the busy mark was cleared in the finally');
  });

  it('two concurrent use() calls are both served', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation, transport });

    const session = create(conn());
    await session.open('correct horse battery staple');

    const [a, b] = await Promise.all([
      session.use(async () => 1),
      session.use(async () => 2),
    ]);
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(session.lock(), 'locked', 'both finished before the lock');
  });
});

describe('the passphrase never crosses the wire', () => {
  it('every request carries derived material, never the phrase', async () => {
    const derivation = fakeDerivation();
    const transport = fakeTransport(okAnswers());
    const { connect, create } = forTests({ derivation, transport });

    const passphrase = 'correct horse battery staple';

    // Exercise both paths: connect (redeem) and create+open (login).
    await connect(connectArgs({ passphrase }));
    const fromCreate = create(conn());
    await fromCreate.open(passphrase);

    for (const call of transport.calls) {
      const text = typeof call.body === 'string' ? call.body : '';
      assert.ok(!text.includes(passphrase), `${call.method} ${call.url} carried the passphrase`);
      assert.ok(!call.url.includes(encodeURIComponent(passphrase)), `${call.method} ${call.url} carried the passphrase in the URL`);
    }
  });
});
