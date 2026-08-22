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

import { authSecret, createAccount, deriveKek, kekVerifier, openAccount, vaultKey } from '../src/crypto/account.js';
import { randomBytes, toBase64 } from '../src/crypto/bytes.js';
import { seal } from '../src/crypto/sealed.js';
import { encryptName } from '../src/crypto/scope.js';
import { Session, forTests, type AskVault, type Connection, type Derivation } from '../src/session/index.js';
import type { Transport, HttpRequest, HttpResponse } from '../src/api/transport.js';

/** A fixed seed, so `authSecret(seed)` is a known value the test can assert. */
const KNOWN_SEED = new Uint8Array(32).fill(0x42);
const KNOWN_SALT = new Uint8Array(16).fill(0x01);
/**
 * The KEK the fake "derived". Held rather than recomputed for the same reason the real one
 * is: it is what the recovery verifier is made from (D-112), and a derivation that returned
 * an account without one would send an account into the world that cannot be recovered.
 */
const KNOWN_KEK = new Uint8Array(32).fill(0x7e);

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
        kek: KNOWN_KEK,
        // A created account carries its identity; only `open` does without one.
        pubkey: toBase64(new Uint8Array(32).fill(0x11)),
        encPrivkey: toBase64(new Uint8Array(48).fill(0x22)),
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
        kek: KNOWN_KEK,
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

  it('sends KDF parameters that meet the server floor (D-62)', async () => {
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
    // The message is the session's, not the cipher's: whatever the derivation throws, a
    // person is told what to do about it. Pinning /invalid tag/ here is what let that
    // wording reach a real device.
    await assert.rejects(() => session.open('wrong'), /does not open this account/);
    assert.equal(session.state, 'locked', 'no half-open state: the seed was never set');
    assert.equal(derivation.calls, 1, 'the derivation ran and failed');
  });
});

describe('an account that predates recovery repairs itself on login', () => {
  // The server can say `needs_kek_verifier` and can do nothing about it: making one takes the
  // KEK, which exists only on a device holding the passphrase (D-112). Every entrance has it
  // by the time it logs in, so every entrance files it — the repair used to be on the unlock
  // path alone, which left such an account unrecoverable until somebody happened to unlock on
  // the one device that still had it.
  const needsRepair = () => ({
    ...okAnswers(),
    'POST /auth/login': { status: 200, body: { access: 'acc-1', refresh: 'ref-1', needs_kek_verifier: true } },
    'PUT /auth/kek-verifier': { status: 204, body: {} },
  });

  it('files the verifier the KEK produces, bound to this login and salt', async () => {
    const transport = fakeTransport(needsRepair());
    const { create } = forTests({ derivation: fakeDerivation(), transport });

    assert.equal(await create(conn()).open('correct horse battery staple'), 'open');

    const call = transport.calls.find((c) => c.url.includes('/auth/kek-verifier'))!;
    assert.ok(call, 'the repair went out');
    assert.equal(
      JSON.parse(call.body as string).kek_verifier,
      kekVerifier(KNOWN_KEK, 'alice', KNOWN_SALT),
      'the one the server can check — not a placeholder, and not the KEK itself',
    );
  });

  it('says nothing when the account already has one', async () => {
    const transport = fakeTransport(okAnswers());
    const { create } = forTests({ derivation: fakeDerivation(), transport });

    await create(conn()).open('correct horse battery staple');
    assert.ok(!transport.calls.some((c) => c.url.includes('/auth/kek-verifier')), 'no repair, no request');
  });

  it('opens the vault even when the repair cannot be filed', async () => {
    // Offline, or a server too old to have the endpoint. Refusing to open a vault because a
    // repair could not be filed would be the worse trade; it is tried again next login.
    const transport = fakeTransport({
      ...okAnswers(),
      'POST /auth/login': { status: 200, body: { access: 'acc-1', refresh: 'ref-1', needs_kek_verifier: true } },
      'PUT /auth/kek-verifier': { status: 500, body: { error: 'nope' } },
    });
    const { create } = forTests({ derivation: fakeDerivation(), transport });

    assert.equal(await create(conn()).open('correct horse battery staple'), 'open');
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

/** Below the server's floor on purpose: this test never registers, it only unwraps. */
const FAST = { v: 19, m: 256, t: 1, p: 1 };
const SALT = randomBytes(16);

describe('a wrong passphrase says so', () => {
  it('does not hand the AEAD’s own words to a person', async () => {
    // "invalid tag" is what the cipher says and is unusable advice: it is exactly what a
    // wrong passphrase produces, and it reads like a corrupted file. This cost a real
    // debugging session on a real device.
    const conn: Connection = {
      serverUrl: 'http://example.invalid',
      login: 'admin',
      deviceId: '11111111-1111-4111-8111-111111111111',
      vaultId: '22222222-2222-4222-8222-222222222222',
      wrappedSeed: seal(deriveKek('the right one', SALT, FAST), randomBytes(32)),
      accountSalt: toBase64(SALT),
      kdfParams: FAST,
    };

    const s = Session.create(conn, {
      derivation: {
        create: (passphrase, params) => createAccount(passphrase, params),
        open: (passphrase, accountSalt, kdfParams, wrappedSeed) =>
          openAccount(passphrase, accountSalt, kdfParams, wrappedSeed),
      },
      transport: async () => {
        throw new Error('the wire must not be reached — the phrase fails first');
      },
    });

    await assert.rejects(s.open('the wrong one'), /does not open this account/);
    assert.equal(s.state, 'locked', 'and nothing half-opened');
  });
});

/**
 * The real derivation, bound here rather than taken from `index.ts`.
 *
 * `session.recover` in production has no derivation parameter — that is the structural rule
 * this file's header describes — so a test that wants the real one assembles it, and the
 * assembly is visible.
 */
const realDerivationForTests: Derivation = {
  create: (passphrase, params) => createAccount(passphrase, params),
  open: (passphrase, accountSalt, kdfParams, wrappedSeed) =>
    openAccount(passphrase, accountSalt, kdfParams, wrappedSeed),
};

describe('Session.recover — the last device is gone', () => {
  // What the server would hold for this account: the seed sealed under the real KEK, so the
  // envelope that comes back is one this passphrase can actually open.
  const PHRASE = 'correct horse battery staple';
  const SEED = randomBytes(32);
  const RSALT = randomBytes(16);
  const ENVELOPE = seal(deriveKek(PHRASE, RSALT, FAST), SEED);

  const answers = () => ({
    'GET /auth/kdf': { status: 200, body: { account_salt: toBase64(RSALT), kdf_params: FAST } },
    'POST /auth/recover': {
      status: 200,
      body: {
        seed_envelope: ENVELOPE,
        opened_by: 'passphrase',
        enc_privkey: toBase64(new Uint8Array(48).fill(0x22)),
        account_salt: toBase64(RSALT),
        kdf_params: FAST,
        user_id: 'user-1',
        device_id: 'dev-recovered',
      },
    },
    'POST /auth/login': { status: 200, body: { access: 'acc-1', refresh: 'ref-1' } },
    'GET /vaults': { status: 200, body: [{ id: '11111111-1111-4111-8111-111111111111', name_enc: '' }] },
  });

  it('proves the passphrase, opens what comes back, and lands an open session', async () => {
    // The real derivation, not the fake one: this flow's whole claim is that the same KEK
    // both proves itself to the server and opens the envelope the server returns, and a
    // fake that made up either half would assert nothing.
    const transport = fakeTransport(answers());
    const s = await Session.recover(
      { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE },
      { derivation: realDerivationForTests, transport },
    );

    assert.equal(s.state, 'open', 'recovered devices are open — the phrase was just typed');
    assert.equal(s.connection.deviceId, 'dev-recovered', 'the server made the device; nobody approved it');
    assert.equal(s.connection.wrappedSeed, ENVELOPE, 'stored as it arrived: already wrapped under this phrase');
    assert.equal(s.connection.vaultId, '11111111-1111-4111-8111-111111111111', 'one vault is chosen silently');
  });

  it('sends a verifier and never the passphrase', async () => {
    const transport = fakeTransport(answers());
    await Session.recover(
      { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE },
      { derivation: realDerivationForTests, transport },
    );

    const call = transport.calls.find((c) => c.url.includes('/auth/recover'))!;
    const body = JSON.parse(call.body as string);
    assert.ok(body.kek_verifier, 'a proof goes up');
    assert.equal(
      body.kek_verifier,
      kekVerifier(deriveKek(PHRASE, RSALT, FAST), 'alice', RSALT),
      'and it is the one the server can check — bound to this login and this salt',
    );
    for (const c of transport.calls) {
      assert.ok(!String(c.body ?? '').includes(PHRASE), `${c.method} ${c.url} carried the passphrase`);
    }
  });

  it('files a verifier here too, when the server says one is missing', async () => {
    // The widening the shared login step made possible. Recovery normally authenticates WITH
    // the verifier, so this is a no-op in practice — but the entrance no longer decides that
    // for itself, which is the point: one act, and no path that quietly skips half of it.
    const transport = fakeTransport({
      ...answers(),
      'POST /auth/login': { status: 200, body: { access: 'acc-1', refresh: 'ref-1', needs_kek_verifier: true } },
      'PUT /auth/kek-verifier': { status: 204, body: {} },
    });
    await Session.recover(
      { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE },
      { derivation: realDerivationForTests, transport },
    );

    const call = transport.calls.find((c) => c.url.includes('/auth/kek-verifier'))!;
    assert.ok(call, 'the repair went out from a recovery too');
    assert.equal(
      JSON.parse(call.body as string).kek_verifier,
      kekVerifier(deriveKek(PHRASE, RSALT, FAST), 'alice', RSALT),
    );
  });

  it('refuses a login whose salt does not belong to it, rather than storing a broken record', async () => {
    // A hostile or confused server answering /auth/kdf with somebody else's salt produces a
    // KEK that opens nothing. The envelope must fail to open — and the failure must arrive
    // before anything is written down.
    const wrongSalt = randomBytes(16);
    const transport = fakeTransport({
      ...answers(),
      'GET /auth/kdf': { status: 200, body: { account_salt: toBase64(wrongSalt), kdf_params: FAST } },
    });

    await assert.rejects(
      Session.recover(
        { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE },
        { derivation: realDerivationForTests, transport },
      ),
    );
  });
});

describe('which vault a device binds to (D-117, D-116)', () => {
  // The same recover harness as above, because the branch under test is shared: `chooseVault`
  // is reached identically from pairing and from recovery, and recovery is the one with a
  // complete fake already built.
  const PHRASE = 'correct horse battery staple';
  const SEED = randomBytes(32);
  const RSALT = randomBytes(16);
  const ENVELOPE = seal(deriveKek(PHRASE, RSALT, FAST), SEED);
  const VAULT = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  const answers = (vaults: { id: string; name_enc: string }[], extra: Record<string, unknown> = {}) => ({
    'GET /auth/kdf': { status: 200, body: { account_salt: toBase64(RSALT), kdf_params: FAST } },
    'POST /auth/recover': {
      status: 200,
      body: {
        seed_envelope: ENVELOPE,
        opened_by: 'passphrase',
        enc_privkey: toBase64(new Uint8Array(48).fill(0x22)),
        account_salt: toBase64(RSALT),
        kdf_params: FAST,
        user_id: 'user-1',
        device_id: 'dev-recovered',
      },
    },
    'POST /auth/login': { status: 200, body: { access: 'acc-1', refresh: 'ref-1' } },
    'GET /vaults': { status: 200, body: vaults },
    ...extra,
  });

  /** A label as the server holds it: encrypted under that vault own scope key. */
  const labelled = (id: string, name: string) => ({ id, name_enc: encryptName(vaultKey(SEED, id), name) });

  const run = (
    vaults: { id: string; name_enc: string }[],
    askVault: AskVault,
    extra: Record<string, unknown> = {},
  ) =>
    Session.recover(
      { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE, askVault },
      { derivation: realDerivationForTests, transport: fakeTransport(answers(vaults, extra)) },
    );

  it('puts the vault NAMES to the person, not their ids', async () => {
    // The whole reason for asking is that they recognise the answer, and nobody recognises a
    // UUID — which is what the connected screen has shown since M1. The labels are encrypted
    // under each vault own key, so this also pins that the seed is what reads them.
    const asked: { id: string; name: string }[][] = [];
    await run([labelled(VAULT, 'Work notes'), labelled(OTHER, 'Recipes')], async (v) => {
      asked.push(v);
      return { kind: 'use', id: OTHER };
    });

    assert.equal(asked.length, 1, 'asked exactly once');
    assert.deepEqual(
      asked[0]!.map((v) => v.name),
      ['Work notes', 'Recipes'],
    );
    assert.deepEqual(
      asked[0]!.map((v) => v.id),
      [VAULT, OTHER],
      'and the ids travel too',
    );
  });

  it('binds to the one that was chosen, when several are offered', async () => {
    // D-116 point: two vaults on one account used to be an error message listing UUIDs with
    // nowhere to type one. The choice is now an answer.
    const s = await run([labelled(VAULT, 'Work notes'), labelled(OTHER, 'Recipes')], async () => ({
      kind: 'use',
      id: OTHER,
    }));

    assert.equal(s.connection.vaultId, OTHER);
  });

  it('connects nothing when the answer is cancel', async () => {
    // Declining has to leave both sides exactly as they were: this is the branch that used to
    // merge two vaults without asking, so a no that still connected would be worse than never
    // having asked.
    await assert.rejects(
      () => run([labelled(VAULT, 'Work notes')], async () => ({ kind: 'cancel' })),
      (e: unknown) => e instanceof Error && /cancelled/i.test(e.message) && /nothing was changed/i.test(e.message),
    );
  });

  it('goes on to a normal open session when one is chosen', async () => {
    const s = await run([labelled(VAULT, 'Work notes')], async () => ({ kind: 'use', id: VAULT }));

    assert.equal(s.state, 'open');
    assert.equal(s.connection.vaultId, VAULT);
  });

  it('makes a new vault when that is the answer, naming it under its OWN key', async () => {
    // `KV = HKDF(seed, id)`, so the id has to exist before the label can be encrypted — which
    // is why the client chooses it (docs/03). A server-assigned id would mean a name sealed
    // under a key nobody had yet.
    const s = await run([labelled(VAULT, 'Work notes')], async () => ({ kind: 'create', name: 'Recipes' }), {
      'POST /vaults': { status: 201, body: { id: 'ignored', root_node_id: 'root-1' } },
    });

    assert.notEqual(s.connection.vaultId, VAULT, 'a fresh vault, not the existing one');
    assert.match(s.connection.vaultId, /^[0-9a-f-]{36}$/, 'and a real uuid the client minted');
  });

  it('refuses an answer naming a vault that was never offered', async () => {
    // A caller returning something outside the list is a defect in the caller, and binding to
    // an id nobody listed would produce a device syncing something the person never saw named.
    await assert.rejects(
      () => run([labelled(VAULT, 'Work notes')], async () => ({ kind: 'use', id: OTHER })),
      (e: unknown) => e instanceof Error && /no such vault/i.test(e.message),
    );
  });

  it('still asks when a label will not open, rather than refusing to connect', async () => {
    // Being unable to read a name is not a reason to refuse: the id is a worse answer to
    // "which one", not an absent one. Throwing here would strand a device over a string.
    const asked: string[] = [];
    const s = await run([{ id: VAULT, name_enc: 'not-a-real-envelope' }], async (v) => {
      asked.push(v[0]!.name);
      return { kind: 'use', id: VAULT };
    });

    assert.match(asked[0]!, /unreadable|unnamed/, `said so instead of throwing: ${asked[0]}`);
    assert.equal(s.state, 'open', 'and connecting still worked');
  });

  it('asks nothing when no caller can ask, and keeps the old behaviour', async () => {
    // The seam is optional on purpose. A flow with no UI takes one vault silently and throws
    // on several — which is what every test that does not care about this relies on.
    const s = await Session.recover(
      { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE },
      { derivation: realDerivationForTests, transport: fakeTransport(answers([labelled(VAULT, 'Work notes')])) },
    );
    assert.equal(s.connection.vaultId, VAULT);

    await assert.rejects(
      () =>
        Session.recover(
          { serverUrl: 'http://x.test', login: 'alice', passphrase: PHRASE },
          {
            derivation: realDerivationForTests,
            transport: fakeTransport(answers([labelled(VAULT, 'a'), labelled(OTHER, 'b')])),
          },
        ),
      (e: unknown) => e instanceof Error && /has 2 vaults/.test(e.message),
    );
  });
});
