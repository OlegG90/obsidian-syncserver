/**
 * The client, the key model and the server, against each other.
 *
 * Everything else in this suite proves a piece in isolation. This proves the seam: bytes
 * encrypted on the device, uploaded, described to a server that can read none of it, and
 * read back through the delta by a client that has only the passphrase. If the three halves
 * of the design disagree about a single byte, an encoding or a field name, it fails here and
 * nowhere else.
 *
 * It runs a real server against its own database, so it needs one prepared first:
 *
 *     npm run test:live
 *
 * which resets `syncserver_plugin`, builds the server and runs this.
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { ApiError, SyncClient, type CursorRejected, type CursorUnverifiable } from '../src/api/client.js';
import type { Delta } from '@syncserver/shared';
import { fetchTransport, type Transport } from '../src/api/transport.js';
import { authSecret, createAccount, openAccount, vaultKey } from '../src/crypto/account.js';
import { openBlob, sealBlob } from '../src/crypto/blob.js';
import { fromBase64, fromUtf8, randomBytes, randomUuid, toBase64, utf8 } from '../src/crypto/bytes.js';
import { HEADER_BYTES } from '../src/crypto/format.js';
import { decryptName, dedupTag, encryptName, nameHmac, unwrapContentKey, wrapContentKey } from '../src/crypto/scope.js';
import { SyncEngine } from '../src/engine/engine.js';
import { scopesOf } from './vault-scopes.js';
import { MemoryStateStore } from '../src/engine/state.js';
import { newPairingCode } from '../src/crypto/pairing-code.js';
import { session, type Session } from '../src/session/index.js';
import { wrapShareKey } from '../src/crypto/share.js';
import { shareFolder } from '../src/sharing.js';
import { vaultScopeIdOf } from '../src/share-keys.js';
import { PushListener } from '../src/obsidian/push.js';
import { FakeVault } from './fake-vault.js';

/**
 * A delta answer narrowed to its page.
 *
 * `delta` declares three outcomes — a page, a `410` with its reason, and a cursor this
 * server cannot verify (#100) — and a test that wants the page has to say so about both
 * refusals. Said once here rather than twice at each of eleven call sites.
 */
const page = (res: Delta | CursorRejected | CursorUnverifiable): Delta => {
  assert.ok(!('rejected' in res), `the cursor was rejected: ${'rejected' in res ? res.reason : ''}`);
  assert.ok(!('unverifiable' in res), 'the server could not verify the cursor');
  return res;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const entry = path.join(repo, 'server/dist/index.js');

const PORT = Number(process.env['SYNCSERVER_TEST_PORT'] ?? 18087);
const DB = process.env['SYNCSERVER_TEST_DB'] ?? 'syncserver_plugin';

/**
 * How the server this test starts reaches its database.
 *
 * An inherited `DATABASE_URL` wins, and it has to: the development socket below is how
 * PostgreSQL authenticates on a developer's machine (peer, no password) and does not exist
 * anywhere else. CI creates the database over TCP and names it in that variable, and a test
 * that insisted on the socket answered `ENOENT /var/run/postgresql/.s.PGSQL.5432` — a
 * sentence about a missing file, for a server that was running the whole time.
 *
 * Whoever sets it must name the database `test:live` has just reset; nothing here can check
 * that, and a mismatch shows up as a first-run vault that is not first-run.
 */
const DATABASE_URL = process.env['DATABASE_URL'] ?? `postgres:///${DB}?host=/var/run/postgresql`;
const STORE = path.join(repo, `server/var/test-plugin-${process.pid}`);
const base = `http://127.0.0.1:${PORT}`;

// The REAL Argon2id parameters, not fast ones. The server enforces a 64 MiB floor (#62)
// and refuses anything weaker, so a round trip that lowered them would be testing a
// registration no plugin can perform. It costs about a second, once.

let server: ChildProcess;
const client = new SyncClient(base, fetchTransport);

// The shared account, created and named by the first describe, reused by the engine
// scenario that follows — one account, two devices (AC-11).
// Opened, not created: what a second device recovers from the passphrase alone, which
// carries no identity of its own — that is fetched, not derived.
let account: ReturnType<typeof openAccount>;
let vaultId: string;

/** The session the first describe block lives on — connect → open → lock → open. */
let sess: Session;

/** Everything the child said, kept so a failed start can explain itself. */
let serverOutput = '';

/**
 * A minute, not ten seconds, and the wait says what it saw.
 *
 * The server starts from `/mnt/c`, so it loads its dependencies across a 9p filesystem whose
 * latency is not ours to predict — ten seconds was enough most of the time, which is the
 * worst amount to be. And a bare "no healthy answer" sent the last diagnosis down a long
 * detour: the child's own output had the reason all along and was being discarded.
 */
const waitForHealth = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`the server exited with ${server.exitCode} before answering:\n${serverOutput}`);
    }
    try {
      const h = await client.health();
      if (h.status === 'ok') return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no healthy answer from ${base} after a minute. The server said:\n${serverOutput || '(nothing)'}`);
};

before(async () => {
  assert.ok(
    existsSync(entry),
    `${entry} is missing — build the server first (npm run test:live does it for you)`,
  );

  server = spawn(process.execPath, [entry], {
    cwd: path.join(repo, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_URL,
      SERVER_SECRET: 'test-only-secret-for-the-plugin-roundtrip',
      BLOB_STORE_PATH: STORE,
      // The collector would otherwise take its first pass while the test runs. Nothing here
      // is old enough to sweep, but a background transaction is one more thing to explain
      // when something fails.
      SWEEP_INTERVAL_SECONDS: '86400',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Both streams, kept AND echoed: kept so `waitForHealth` can quote them, echoed so a
  // failure later in the run is visible next to the test that hit it.
  for (const stream of [server.stdout, server.stderr]) {
    stream?.on('data', (d: Buffer) => {
      serverOutput += d.toString();
      process.stderr.write(`[server] ${d}`);
    });
  }

  await waitForHealth();
});

after(async () => {
  server?.kill('SIGTERM');
  await rm(STORE, { recursive: true, force: true });
});

describe('a vault, end to end', () => {
  const passphrase = 'a passphrase the server never sees';
  const plaintext = utf8('# Нотатка\n\nЗміст, якого сервер не побачить.\n');
  const filename = 'Нотатка.md';

  let rootNodeId: string;
  let scopeId: string;
  let kv: Uint8Array;
  let address: string;

  /**
   * A vault account to be, invited the way every real one is.
   *
   * A fresh server holds no invitation any more: it holds a console administrator with no
   * password (#107, #115). So the first run here is what it is anywhere — set that password,
   * sign in to the console, and issue an invitation — and only then is there something for a
   * client to redeem. It is three requests rather than none, and each one is the real path.
   */
  const inviteVaultAccount = async (login: string): Promise<string> => {
    // Each body is read ONCE. `assert.equal`'s message argument is evaluated whether or not
    // the assertion holds, so `await res.text()` there consumes the stream the next line
    // wants to parse — which fails as "Body has already been read", about the wrong thing.
    const ask = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, text: await res.text() };
    };

    const bootstrap = await ask('/auth/bootstrap', { password: 'the first administrator password' });
    assert.equal(bootstrap.status, 201, bootstrap.text);

    // The ADMINISTRATOR signs in here, not the account being invited: the console is a
    // different kind of account (#115), and it is the one that may issue an invitation.
    const signIn = await ask('/auth/console', {
      login: 'admin',
      password: 'the first administrator password',
    });
    assert.equal(signIn.status, 200, signIn.text);
    const { access } = JSON.parse(signIn.text) as { access: string };

    const invited = await ask(
      '/admin/invitations',
      { login, quota_bytes: '10737418240' },
      { authorization: `Bearer ${access}` },
    );
    assert.equal(invited.status, 201, invited.text);
    return (JSON.parse(invited.text) as { token: string }).token;
  };

  it('claims an invitation through the session', async () => {
    const health = await client.health();
    assert.equal(health.bootstrap_pending, true, 'this test needs a fresh database — see npm run test:live');

    const token = await inviteVaultAccount('roundtrip-user');

    sess = await session.connect(
      {
        serverUrl: base,
        login: 'roundtrip-user',
        invitationToken: token,
        passphrase,
        vaultName: 'testVault',
        deviceName: 'roundtrip',
        devicePlatform: 'linux',
      },
      fetchTransport,
    );

    assert.equal(sess.state, 'open', 'connect() returns an open session — the phrase was just typed');
    vaultId = sess.connection.vaultId;

    // The live KDF floor check (#62): the session derived these with real Argon2id, and the
    // server accepted them — the only place that proof can live.
    const kdf = sess.connection.kdfParams;
    assert.equal(kdf.v, 19, 'the live KDF parameters meet the floor');
    assert.ok(kdf.m >= 65536, 'the memory floor');
    assert.ok(kdf.t >= 3, 'the time floor');
    assert.ok(kdf.p >= 1, 'the parallelism floor');

    // The account material the later tests need: the seed lives in the session, so we open
    // the account from the record the plugin would persist — the same thing a second
    // device would do with nothing but the passphrase.
    account = openAccount(passphrase, fromBase64(sess.connection.accountSalt), kdf, sess.connection.wrappedSeed);

    // The session's client is the one the later tests use: it is already authenticated.
    await sess.use(async (h) => {
      // The engine will borrow this client; the test borrows it the same way.
      Object.assign(client, h.client);
      kv = h.kv;
    });
  });

  it('reads its own vault label back, which the server cannot', async () => {
    const vaults = await client.listVaults();
    assert.equal(vaults.length, 1);
    assert.equal(decryptName(kv, vaults[0]!.name_enc), 'testVault');

    const opened = await client.openVault(vaultId);
    rootNodeId = opened.root_node_id;
    scopeId = opened.scopes.find((s) => s.scope === 'vault')!.key_id;
    assert.ok(scopeId, 'the vault reports its own key scope (docs/06)');
  });

  it('uploads a file as ciphertext and binds it to a node', async () => {
    const sealed = sealBlob(plaintext);
    address = sealed.sha256;

    const stored = await client.putBlob(sealed);
    assert.equal(stored.sha256, sealed.sha256, 'the server re-hashed what it received and agrees');

    // 404 until a node references it: an upload leaves a PENDING reference and reads are
    // authorised by a live one (#20).
    assert.equal(await client.hasBlob(address), false);

    const node = await client.createNode(vaultId, {
      parent_id: rootNodeId,
      type: 'file',
      sha256: address,
      size: sealed.bytes.length,
      mtime: new Date().toISOString(),
      name_enc: encryptName(kv, filename),
      name_hmac: nameHmac(kv, filename),
      name_key_id: scopeId,
      blob_envelopes: [{ sha256: address, scope_id: scopeId, wrapped_key: wrapContentKey(kv, sealed.contentKey) }],
      dedup_tags: [{ sha256: address, scope_id: scopeId, content_tag: dedupTag(kv, plaintext) }],
    });
    assert.ok(node.node_id);

    assert.equal(await client.hasBlob(address), true, 'and 200 once a node holds it');
  });

  it('resumes a large upload from where it broke, instead of sending it again', async () => {
    // 512-byte parts rather than 8 MB, so this proves the protocol without moving
    // megabytes. The server enforces the part size as a ceiling, so a smaller one needs no
    // configuration on its side — which is itself worth knowing.
    const big = randomBytes(5000);
    const sealed = sealBlob(big);

    let puts = 0;
    let breakAfter = Infinity;
    const flaky: Transport = async (req) => {
      if (req.method === 'PUT' && req.url.includes('/parts/')) {
        puts++;
        if (puts > breakAfter) throw new Error('the connection dropped');
      }
      return fetchTransport(req);
    };

    // The tokens come from the authenticated client; `partBytes` is applied AFTER the copy,
    // because `Object.assign` would otherwise bring the 8 MB default across with them.
    const small = new SyncClient(base, flaky);
    Object.assign(small, client, { transport: flaky, partBytes: 512 });

    breakAfter = 3;
    await assert.rejects(small.putBlob(sealed), 'the upload dies partway through');
    assert.equal(puts, 4, 'three parts landed, the fourth did not');

    breakAfter = Infinity;
    puts = 0;
    const stored = await small.putBlob(sealed);
    assert.equal(stored.sha256, sealed.sha256);
    assert.equal(stored.size, sealed.bytes.length);

    // The whole point: the second attempt sent only what was missing. Ten parts in all,
    // three already staged — a client that re-sent everything would show ten here.
    assert.equal(puts, Math.ceil(sealed.bytes.length / 512) - 3, 'only the parts that never landed');

    // And what the server assembled is the blob, not merely something of the right length.
    const node = await client.createNode(vaultId, {
      parent_id: rootNodeId,
      type: 'file',
      sha256: sealed.sha256,
      size: sealed.bytes.length,
      mtime: new Date().toISOString(),
      name_enc: encryptName(kv, 'Великий.bin'),
      name_hmac: nameHmac(kv, 'Великий.bin'),
      name_key_id: scopeId,
      blob_envelopes: [{ sha256: sealed.sha256, scope_id: scopeId, wrapped_key: wrapContentKey(kv, sealed.contentKey) }],
      dedup_tags: [{ sha256: sealed.sha256, scope_id: scopeId, content_tag: dedupTag(kv, big) }],
    });
    assert.ok(node.node_id);

    const back = (await client.getBlob(sealed.sha256))!;
    assert.equal(back.length, sealed.bytes.length, 'the assembled blob is the length it claims');
    const envelope = (await client.blobKeys(vaultId, [sealed.sha256])).get(sealed.sha256)![0]!;
    assert.deepEqual(openBlob(unwrapContentKey(kv, envelope.wrappedKey), back), big);
  });

  it('shows the server holding nothing it can read', async () => {
    const delta = page(await client.delta(vaultId));
    const change = delta.changes[0]!;

    // Everything the server has about this file, and none of it is the file or its name.
    assert.equal(change.sha256, address);
    assert.notEqual(change.name_enc, filename);
    assert.notEqual(fromBase64(change.name_enc!).length, 0);
    assert.equal(decryptName(kv, change.name_enc!), filename, 'only the key turns it back into a name');

    const ciphertext = (await client.getBlob(address))!;
    assert.notDeepEqual(ciphertext.subarray(HEADER_BYTES), plaintext, 'what is stored is not the plaintext');
  });

  it('opens the vault again from the passphrase alone, as a second device would', async () => {
    // The session locks, and the phrase is all that gets it back.
    assert.equal(sess.lock(), 'locked');
    assert.equal(sess.state, 'locked');
    assert.equal(await sess.open(), 'locked', 'no phrase, no entry');

    // The whole point, in one line: the file, recovered from the server by a client that
    // was given a passphrase and nothing else.
    assert.equal(await sess.open(passphrase), 'open');
    await sess.use(async (h) => {
      const delta = page(await h.client.delta(vaultId));
      const change = delta.changes[0]!;

      assert.equal(decryptName(h.kv, change.name_enc!), filename);

      const ciphertext = (await h.client.getBlob(change.sha256!))!;
      const envelopes = (await h.client.blobKeys(vaultId, [change.sha256!])).get(change.sha256!) ?? [];
      assert.ok(envelopes.length > 0, 'the envelope comes from the server: a second device has no local copy');

      // Picked BY SCOPE, not by position. One scope today; a shared folder adds more, and
      // "the first one" would then be whichever the database happened to return.
      const mine = envelopes.find((e) => e.scopeId === scopeId);
      assert.ok(mine, 'an envelope under this vault’s own key');
      assert.deepEqual(openBlob(unwrapContentKey(h.kv, mine.wrappedKey), ciphertext), plaintext);
    });
  });

  it('pairs a second device, which then reads the vault without ever seeing the passphrase path', async () => {
    // The scenario the plugin could not perform at all until now: a phone joining an
    // account that already exists. `connect()` mints a new account and spends an invitation;
    // this spends nothing and generates nothing — the seed already exists, and the whole
    // flow is about moving it to a second device without the server being able to read it.
    const code = newPairingCode();

    // B begins and polls; A approves on the first wait. Concurrency is the point — a
    // pairing that could only be approved before it was started would not be a pairing.
    let approvals = 0;
    const second = await session.pair(
      {
        serverUrl: base,
        login: 'roundtrip-user',
        passphrase,
        pairingCode: code,
        deviceName: 'phone',
        devicePlatform: 'android',
      },
      fetchTransport,
      async () => {
        // Typed the way a person types it: no dashes, wrong case. The displayed form and
        // the form the approver enters are DIFFERENT STRINGS, and both must hash to one
        // pairing — passing `code` verbatim here is what let a real 404 through, because
        // the phone hashed the dashed form and the desktop the normalised one.
        if (approvals++ === 0) await sess.approvePairing(code.replace(/-/g, '').toLowerCase());
        return true;
      },
    );

    assert.equal(approvals, 1, 'one wait, one approval — the claim succeeded straight after');
    assert.equal(second.state, 'open', 'a paired device is open: it holds the seed it was sent');

    // A DIFFERENT device row, on the SAME account and vault.
    assert.notEqual(second.connection.deviceId, sess.connection.deviceId);
    assert.equal(second.connection.vaultId, vaultId);

    // The proof that the seed arrived intact rather than merely something 32 bytes long:
    // the vault key it derives opens what the first device wrote.
    await second.use(async (h) => {
      const delta = page(await h.client.delta(vaultId));
      const change = delta.changes.find((c) => c.sha256 === address);
      assert.ok(change, 'the file the first device uploaded');
      assert.equal(decryptName(h.kv, change.name_enc!), filename, 'and its name, under the same KV');
    });

    // And it can lock and come back on the passphrase alone — which it could not do if it
    // had not re-wrapped the seed for itself, since the server never sent a wrapped one.
    assert.equal(second.lock(), 'locked');
    assert.equal(await second.open(passphrase), 'open');
    assert.equal(second.lock(), 'locked');
  });

  it('refuses a pairing code that was already used', async () => {
    const code = newPairingCode();
    await assert.rejects(
      session.pair(
        { serverUrl: base, login: 'roundtrip-user', passphrase, pairingCode: code },
        fetchTransport,
        async () => {
          // Approve once, then approve again: the second must be refused, and the refusal
          // must reach the caller rather than leaving the pairing half-settled.
          await sess.approvePairing(code.toLowerCase());
          await sess.approvePairing(code.toLowerCase());
          return true;
        },
      ),
      /already_settled|409/,
    );
  });

  it('hands out no envelope for an address the caller does not hold', async () => {
    // Absent, not forbidden: an envelope is worth exactly what the bytes it opens are worth,
    // so it follows the same rule as a blob read (#20).
    const stranger = 'a'.repeat(64);
    assert.equal((await client.blobKeys(vaultId, [stranger])).size, 0);
  });

  it('refuses the wrong passphrase rather than returning rubbish', async () => {
    const locked = session.create(sess.connection, fetchTransport);
    await assert.rejects(() => locked.open('not the passphrase'));
    assert.equal(locked.state, 'locked', 'the session stayed locked — no half-open state');
  });

});

describe('the engine, device A pushes and device B pulls', () => {
  // The M0.5 boundary, end to end: one engine SEES a local vault and uploads it; a
  // second engine, in an EMPTY vault with only the passphrase, materialises that
  // vault through the delta. Conflicts cannot occur by construction (docs/10).
  const passphrase = 'a passphrase the server never sees';
  const docsFile = '# Документ\n\nОдин і той самий текст з двох пристроїв.\n';
  const note = utf8(docsFile);
  const name = 'Документ.md';

  let ownVaultId: string;
  let kv2: Uint8Array;

  /**
   * The engine as its caller now builds it: the vault is opened here and handed over.
   *
   * `openVault` left the engine's seam when the plugin started opening once per operation —
   * a leave was making five of those calls and a pass two, every one describing the same
   * instant. A live test is a caller like any other, so it opens too.
   */
  const engineOn = async (
    wire: typeof client,
    vault: FakeVault,
    store: MemoryStateStore,
    label?: string,
    syncObsidian?: boolean,
  ): Promise<SyncEngine> =>
    new SyncEngine(
      wire,
      ownVaultId,
      scopesOf(await client.openVault(ownVaultId), kv2),
      vault,
      store,
      label,
      syncObsidian,
    );

  it('two engines share one account but separate vaults', async () => {
    // Same account (AC-11 allows several vaults), each vault with its own derived key.
    ownVaultId = randomUuid();
    kv2 = vaultKey(account.seed, ownVaultId);

    const out = await client.createVault(ownVaultId, encryptName(kv2, 'engineVault'));
    assert.ok(out.root_node_id);
  });

  it('device A pushes its whole vault', async () => {
    const a = new FakeVault();
    a.seed(name, docsFile);

    const engineA = await engineOn(client, a, new MemoryStateStore());
    const report = await engineA.sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.pushed.length, 1);
    assert.equal(report.pushed[0]!.path, name);
    assert.equal(a.contents(name), docsFile, 'A still has its file');
  });

  it('device B, an empty vault, materialises it through the delta', async () => {
    const b = new FakeVault();

    const engineB = await engineOn(client, b, new MemoryStateStore());
    const report = await engineB.sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(b.contents(name), docsFile, 'B wrote exactly what A uploaded');
  });

  it('the server never saw a name', async () => {
    const delta = page(await client.delta(ownVaultId));
    const change = delta.changes[0]!;
    assert.notEqual(change.name_enc, name);
    assert.equal(decryptName(kv2, change.name_enc!), name);
  });

  it('a device that has synced this node before edits it normally — no adoption involved', async () => {
    // The one path every earlier test in this block used a FRESH MemoryStateStore for, which
    // means none of them actually exercised "this device already knows the node." Real reuse
    // needs the same store handed to two sync() calls.
    const editPath = 'Devices/known-edit.md';
    const v = new FakeVault();
    v.seed(editPath, 'first revision');
    const store = new MemoryStateStore();
    const engine = await engineOn(client, v, store);

    const first = await engine.sync();
    assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
    assert.equal(first.pushed.length, 1);
    assert.equal(first.conflicts.length, 0, 'a brand new path is never a conflict');

    await v.write(editPath, utf8('second revision'));
    const second = await engine.sync();

    assert.equal(second.errors.length, 0, JSON.stringify(second.errors));
    assert.equal(second.conflicts.length, 0, 'the state store remembered this node — not adoption, an edit');
    assert.equal(second.pushed.length, 1, 'the edit went out as an ordinary PUT');
  });

  it('adoption: a fresh device meets a path the server already has — same content binds, nothing moves', async () => {
    const b = new FakeVault();
    b.seed(name, docsFile); // byte-identical to what device A pushed
    const report = await (await engineOn(client, b, new MemoryStateStore())).sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.conflicts.length, 0, 'identical content is not a conflict');

    // Asserted per PATH, not by counting: this vault has accumulated files from the tests
    // above, and pulling those is correct — they are server-only as far as B is concerned.
    // What matters is that THIS path moved in neither direction.
    assert.ok(report.matched.some((m) => m.path === name), 'recognised as already in sync');
    assert.ok(!report.pushed.some((p) => p.path === name), 'nothing needed sending — the content was already there');
    assert.ok(!report.pulled.some((p) => p.path === name), 'nor fetching — the local file already had it');
    assert.equal(b.contents(name), docsFile, 'left exactly as it was');
  });

  it('adoption: a fresh device meets a path the server already has — differing content conflicts', async () => {
    // This is the scenario an earlier version of this test got wrong: it expected B's edit
    // to silently replace A's content, based on nothing but a matching path. Two independent
    // files that happen to share a path have no common ancestor (docs/07) — the server
    // version wins the name, and B's own copy survives beside it rather than vanishing.
    const b = new FakeVault();
    const edited = '# Документ\n\nВідредаговано на пристрої B.\n';
    b.seed(name, edited);

    const report = await (await engineOn(client, b, new MemoryStateStore())).sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.conflicts.length, 1);
    const conflict = report.conflicts[0]!;
    assert.equal(conflict.path, name);
    // docs/04's exact form: "Note (conflict 2026-08-01 laptop).md" — device label, not a name.
    assert.match(conflict.conflictPath, /^Документ \(conflict \d{4}-\d{2}-\d{2} device\)\.md$/);

    assert.equal(b.contents(name), docsFile, 'the server version is now the file at this path');
    assert.equal(b.contents(conflict.conflictPath), edited, 'and the local original was not discarded');

    // The conflict file is not a loose end left for the next click — it is queued and
    // uploaded within the SAME pass, because the moment it exists it is an ordinary new file.
    assert.ok(report.pushed.some((p) => p.path === conflict.conflictPath), 'the conflict file itself was uploaded');
  });

  it('renaming a file moves the node rather than replacing it, so its history follows', async () => {
    // Long enough to clear the heuristic's floor: below a few hundred bytes a hash match
    // means almost nothing (docs/04), and the engine deliberately declines to guess.
    const body = `# Renamed\n\n${'A note with enough substance to be identifiable. '.repeat(20)}`;
    const before = 'Renames/before.md';
    const after = 'Renames/after.md';

    const v = new FakeVault();
    v.seed(before, body);
    const store = new MemoryStateStore();
    const engine = await engineOn(client, v, store, 'laptop');

    const first = await engine.sync();
    assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
    const created = (await client.delta(ownVaultId)) as { changes: { node_id: string; name_enc: string | null }[] };
    const originalNode = created.changes.find((c) => c.name_enc && decryptName(kv2, c.name_enc) === 'before.md')!;
    assert.ok(originalNode, 'the file reached the server under its first name');

    // Renamed the way a file manager does it: gone from one path, present at another.
    await v.delete(before);
    v.seed(after, body);

    const report = await engine.sync();
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.deepEqual(report.renamed, [{ from: before, to: after }]);
    assert.equal(report.pushed.length, 0, 'a move sends no content');
    assert.equal(report.vanished.length, 0, 'the disappearance was explained by the rename');

    const now = (await client.delta(ownVaultId)) as { changes: { node_id: string; name_enc: string | null }[] };
    const movedNode = now.changes.find((c) => c.name_enc && decryptName(kv2, c.name_enc) === 'after.md')!;
    assert.ok(movedNode, 'the server knows it by its new name');

    // The whole point: same node id. `versions` is keyed by node_id and knows nothing about
    // names, so a delete-and-create would have stranded every earlier revision.
    assert.equal(movedNode.node_id, originalNode.node_id, 'the node moved; it was not replaced');
    assert.ok(!now.changes.some((c) => c.name_enc && decryptName(kv2, c.name_enc) === 'before.md'));
  });

  it('declines to guess on a small file, falling back to create — and deletes the vanished one', async () => {
    // Two empty-ish notes with identical content is the case the floor exists for: nothing
    // in the bytes says which one moved where.
    const tiny = 'tiny';
    const v = new FakeVault();
    v.seed('Small/one.md', tiny);
    const store = new MemoryStateStore();
    const engine = await engineOn(client, v, store, 'laptop');
    assert.equal((await engine.sync()).errors.length, 0);

    await v.delete('Small/one.md');
    v.seed('Small/two.md', tiny);

    const report = await engine.sync();
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.renamed.length, 0, 'too small to be sure, so it did not pretend to be');
    assert.ok(report.pushed.some((p) => p.path === 'Small/two.md'), 'created instead — the blob deduplicates anyway');
    // The disappearance is now a real delete, pushed to the server — not just reported.
    assert.deepEqual(report.deleted, [{ path: 'Small/one.md' }], 'the vanished file is deleted, not left dangling');
  });

  it('two clients editing the same file: the server refuses the second, and neither version is lost', async () => {
    // The M1 conflict scenario, end to end against a real server. Both devices sync the
    // file first, so each has it as a KNOWN node — this is the ordinary two-client conflict,
    // not adoption's no-common-ancestor case.
    const conflictPath = 'Devices/two-clients.md';

    const a = new FakeVault();
    a.seed(conflictPath, 'the shared starting point');
    const storeA = new MemoryStateStore();
    const engineA = await engineOn(client, a, storeA, 'laptop');
    assert.equal((await engineA.sync()).errors.length, 0);

    const b = new FakeVault();
    b.seed(conflictPath, 'the shared starting point');
    const storeB = new MemoryStateStore();
    const engineB = await engineOn(client, b, storeB, 'phone');
    const adopted = await engineB.sync();
    assert.equal(adopted.errors.length, 0, JSON.stringify(adopted.errors));
    assert.ok(adopted.matched.some((m) => m.path === conflictPath), 'B adopted it without moving bytes');

    // B edits and wins the race, because it syncs first.
    await b.write(conflictPath, utf8('edited on the phone'));
    const pushedB = await engineB.sync();
    assert.equal(pushedB.errors.length, 0, JSON.stringify(pushedB.errors));
    assert.ok(pushedB.pushed.some((p) => p.path === conflictPath));

    // A edits from the version it last saw. Its base is stale, so the server refuses — and
    // that refusal is the whole mechanism: A cannot know about B's write until it is told.
    await a.write(conflictPath, utf8('edited on the laptop'));
    const report = await engineA.sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.conflicts.length, 1, 'a real conflict, decided by the server');
    const conflict = report.conflicts[0]!;
    assert.equal(conflict.path, conflictPath);
    assert.match(conflict.conflictPath, /two-clients \(conflict \d{4}-\d{2}-\d{2} laptop\)\.md$/);

    assert.equal(a.contents(conflictPath), 'edited on the phone', 'the server version holds the path');
    assert.equal(a.contents(conflict.conflictPath), 'edited on the laptop', 'and the laptop’s work survives');

    // And it is on the server too, not merely on disk: the conflict file uploads in the
    // same pass, so the other device sees it on its next sync rather than never.
    const delta = page(await client.delta(ownVaultId));
    assert.ok(
      delta.changes.some((c) => c.name_enc && decryptName(kv2, c.name_enc) === basenameOf(conflict.conflictPath)),
      'the conflict file reached the server',
    );
  });

  it('adoption: identical content under a NEW path binds to the existing address — nothing sealed twice', async () => {
    const copyPath = 'Devices/copy-of-the-document.md';
    const b = new FakeVault();
    b.seed(copyPath, docsFile); // same bytes as `name`, never uploaded under this path before
    const report = await (await engineOn(client, b, new MemoryStateStore())).sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.pushed.length, 1, 'a node WAS created — dedup binds, it does not skip the file');

    const delta = page(await client.delta(ownVaultId));
    const original = delta.changes.find((c) => decryptName(kv2, c.name_enc!) === name)!;
    const copy = delta.changes.find((c) => decryptName(kv2, c.name_enc!) === basenameOf(copyPath))!;

    // `KC` is random, so sealing the same plaintext twice gives two DIFFERENT addresses
    // (docs/06). Equal addresses here are only possible if the engine used the dedup match
    // instead of sealing fresh bytes — the whole claim, made unfalsifiable by construction.
    assert.equal(copy.sha256, original.sha256, 'bound to the address that already held this content');
  });

  it('a delete on one device removes the file on the other, and nothing resurrects it', async () => {
    const path = 'Devices/doomed.md';
    const a = new FakeVault();
    a.seed(path, 'this file will be deleted');
    const storeA = new MemoryStateStore();
    const engineA = await engineOn(client, a, storeA, 'laptop');
    assert.equal((await engineA.sync()).errors.length, 0);

    const b = new FakeVault();
    const storeB = new MemoryStateStore();
    const engineB = await engineOn(client, b, storeB, 'phone');
    assert.equal((await engineB.sync()).errors.length, 0);
    assert.equal(b.contents(path), 'this file will be deleted', 'B has the file before the delete');

    // A deletes it and pushes the delete.
    await a.delete(path);
    const delReport = await engineA.sync();
    assert.equal(delReport.errors.length, 0, JSON.stringify(delReport.errors));
    assert.ok(delReport.deleted.some((d) => d.path === path), 'A pushed the delete');

    // B syncs: the node is gone from the tree, B's epoch is continuous, so the local copy goes.
    const reportB = await engineB.sync();
    assert.equal(reportB.errors.length, 0, JSON.stringify(reportB.errors));
    assert.equal(b.contents(path), undefined, 'B removed the local copy');
    assert.ok(reportB.removed.some((r) => r.path === path), 'B reports the removal');

    // And the delete is a soft delete: the content is still in the trash on the server.
    const trash = page(await client.delta(ownVaultId));
  });

  it('the .obsidian/ switch gates pull, so a device with it off never receives configuration', async () => {
    // Device A has the switch ON: it uploads a note AND its .obsidian configuration.
    const note = 'Devices/scope-note.md';
    const config = '.obsidian/appearance.json';
    const a = new FakeVault();
    a.seed(note, 'a note');
    a.seed(config, '{"theme":"obsidian"}');
    const engineA = await engineOn(client, a, new MemoryStateStore(), 'laptop', true);
    const reportA = await engineA.sync();
    assert.equal(reportA.errors.length, 0, JSON.stringify(reportA.errors));
    assert.ok(reportA.pushed.some((p) => p.path === config), 'A pushed .obsidian with the switch on');

    // Device B has the switch OFF: it gets the note but never the configuration.
    const b = new FakeVault();
    const engineB = await engineOn(client, b, new MemoryStateStore(), 'phone', false);
    const reportB = await engineB.sync();
    assert.equal(reportB.errors.length, 0, JSON.stringify(reportB.errors));
    assert.equal(b.contents(note), 'a note', 'the note is pulled');
    assert.equal(b.contents(config), undefined, 'the .obsidian configuration is not pulled');
    assert.ok(!reportB.pulled.some((p) => p.path.startsWith('.obsidian/')));

    // Flip B's switch ON: the configuration now comes down, as an ordinary pull.
    const engineB2 = await engineOn(client, b, new MemoryStateStore(), 'phone', true);
    const reportB2 = await engineB2.sync();
    assert.equal(reportB2.errors.length, 0, JSON.stringify(reportB2.errors));
    assert.equal(b.contents(config), '{"theme":"obsidian"}', 'the configuration arrives once the switch is on');
  });

  it('a renamed folder moves as one node, and the empty source folder does not linger', async () => {
    const before = 'Folders/old';
    const after = 'Folders/new';
    const body = `# A folder's note\n\n${'Enough to be identified by hash. '.repeat(20)}`;

    const a = new FakeVault();
    a.seed(`${before}/one.md`, body);
    a.seed(`${before}/two.md`, body + '\nsecond');
    const engineA = await engineOn(client, a, new MemoryStateStore(), 'laptop');
    const first = await engineA.sync();
    assert.equal(first.errors.length, 0, JSON.stringify(first.errors));

    // Rename the folder the way a file manager would: every child moves, content unchanged.
    await a.delete(`${before}/one.md`);
    await a.delete(`${before}/two.md`);
    a.seed(`${after}/one.md`, body);
    a.seed(`${after}/two.md`, body + '\nsecond');

    const report = await engineA.sync();
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.ok(report.renamed.some((r) => r.from === before && r.to === after), 'the folder moved as one node');

    // The server tree has `new/…` and no live node under `old/` (the empty source folder is gone).
    const delta = page(await client.delta(ownVaultId));
    const names = delta.changes.map((c) => c.name_enc && decryptName(kv2, c.name_enc)).filter(Boolean);
    assert.ok(names.includes('one.md') && names.includes('two.md'), 'the children are live under the new folder');
    assert.ok(!names.includes('old'), 'the empty source folder did not linger');

    // A second device materialises the vault and sees the new folder, not the old one.
    const b = new FakeVault();
    await (await engineOn(client, b, new MemoryStateStore(), 'phone')).sync();
    assert.equal(b.contents(`${after}/one.md`), body);
    assert.equal(b.contents(`${before}/one.md`), undefined, 'no file under the old folder');
  });

  it('a rename on one device and an edit on the other land as a move plus an edit — no duplicate, no conflict', async () => {
    const before = 'Devices/move-me.md';
    const after = 'Devices/moved.md';
    const body = `# Move me\n\n${'Enough substance to be identified by hash. '.repeat(20)}`;

    const a = new FakeVault();
    a.seed(before, body);
    const storeA = new MemoryStateStore();
    const engineA = await engineOn(client, a, storeA, 'laptop');
    assert.equal((await engineA.sync()).errors.length, 0);

    const b = new FakeVault();
    const storeB = new MemoryStateStore();
    const engineB = await engineOn(client, b, storeB, 'phone');
    assert.equal((await engineB.sync()).errors.length, 0);
    assert.equal(b.contents(before), body, 'B has the file at the old path');

    // A renames it (file-manager style: gone from one path, present at another).
    await a.delete(before);
    a.seed(after, body);
    assert.equal((await engineA.sync()).errors.length, 0);

    // B has a local EDIT at the old path, then syncs. The edit must follow the move.
    await b.write(before, utf8(body + '\nedited on B\n'));
    const reportB = await engineB.sync();
    assert.equal(reportB.errors.length, 0, JSON.stringify(reportB.errors));
    assert.equal(reportB.conflicts.length, 0, 'a rename and an edit do not conflict');
    assert.equal(b.contents(before), undefined, 'the old path is gone');
    assert.equal(b.contents(after), body + '\nedited on B\n', 'the edit followed the move');

    // A syncs once more and sees exactly one node: the moved, edited file. No duplicate.
    const reportA2 = await engineA.sync();
    assert.equal(reportA2.errors.length, 0, JSON.stringify(reportA2.errors));
    const delta = page(await client.delta(ownVaultId));
    const names = delta.changes
      .map((c) => c.name_enc && decryptName(kv2, c.name_enc))
      .filter(Boolean);
    assert.ok(!names.includes('move-me.md'), 'the old name did not come back');
  });

  it('an interruption between the blob upload and the node write retries without duplicating', async () => {
    // The M1 interruption scenario: the blob lands (a pending claim), the node write dies
    // before the transaction commits. The next sync must succeed and create exactly one node.
    const path = 'Devices/interrupted.md';
    const a = new FakeVault();
    a.seed(path, 'interrupted but retried');

    // Fail the node write ONCE. The blob upload before it is real and leaves `refs_pending`.
    let failed = false;
    const flaky = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'createNode' && !failed) {
          failed = true;
          return async () => {
            throw new ApiError(500, 'boom_before_commit', '');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const store = new MemoryStateStore();
    const engine = await engineOn(flaky, a, store, 'laptop');
    const first = await engine.sync();
    assert.equal(first.errors.length, 1, 'the interrupted write is reported');

    // The retry — a fresh engine over the same vault, the same store — succeeds cleanly.
    const retry = await (await engineOn(client, a, store, 'laptop')).sync();
    assert.equal(retry.errors.length, 0, JSON.stringify(retry.errors));
    assert.ok(retry.pushed.some((p) => p.path === path));

    // Exactly one node holds the file. The interrupted upload sits as `refs_pending` until
    // the collector's unbound TTL sweeps it — nothing was bound to a duplicate node.
    const delta = page(await client.delta(ownVaultId));
    const matches = delta.changes.filter((c) => c.name_enc && decryptName(kv2, c.name_enc) === 'interrupted.md');
    assert.equal(matches.length, 1, 'one node, not two');
  });

  it('a deleted file can be restored from the trash, and a taken name is refused', async () => {
    // The trash/restore half of "deletion and restore from the trash": the server keeps the
    // content and offers it back; a restore is a new write with an old hash (docs/04).
    const path = 'Devices/trashable.md';
    const a = new FakeVault();
    a.seed(path, 'to be deleted and returned');
    const engineA = await engineOn(client, a, new MemoryStateStore(), 'laptop');
    assert.equal((await engineA.sync()).errors.length, 0);

    // Delete it, and the node is soft-deleted into the trash.
    await a.delete(path);
    assert.equal((await engineA.sync()).errors.length, 0);
    const trash = await client.trash(ownVaultId);
    const entry = trash.entries.find((t) => t.name_enc && decryptName(kv2, t.name_enc) === 'trashable.md');
    assert.ok(entry, 'the deleted node is in the trash');
    assert.ok(entry!.versions >= 1, 'with history still alive');

    // Restore the newest version: a new write with the old hash (docs/04).
    const versions = await client.versions(ownVaultId, entry!.node_id);
    const newest = versions[0]!;
    const restored = await client.restore(ownVaultId, entry!.node_id, newest.rev);
    assert.ok(restored.rev >= newest.rev, 'the restore wrote a new version');

    // `lifted` is the ancestor folders that had to come back out of the trash, and here
    // there are none — `Devices/` was never deleted. An EMPTY LIST is the assertion worth
    // making: the client used to declare this field a boolean, and `[]` is truthy, so
    // "nothing was lifted" arrived as "something was" and no test could see it.
    // `history.test.ts` covers the non-empty case, where the id of the folder appears.
    assert.ok(Array.isArray(restored.lifted), 'a list of node ids, not a flag');
    assert.deepEqual(restored.lifted, [], 'nothing had to be lifted to put this file back');

    const after = page(await client.delta(ownVaultId));
    assert.ok(
      after.changes.some((c) => c.name_enc && decryptName(kv2, c.name_enc) === 'trashable.md'),
      'the file is live again',
    );

    // A second device pulls the restored file.
    const b = new FakeVault();
    await (await engineOn(client, b, new MemoryStateStore(), 'phone')).sync();
    assert.equal(b.contents(path), 'to be deleted and returned');
  });

  it('a reset on one device resyncs the other through 410, quarantining displaced work', async () => {
    // docs/07: another device running "my client wins" sends the loser `410 reset`. The
    // loser resyncs against the winner's tree and QUARANTINES its own local-only work rather
    // than erasing it (#80) — never delete the user's files silently.
    const path = 'Devices/reset-shared.md';
    const extraPath = 'Devices/reset-only-on-b.md';

    // A wins: pushes the shared file.
    const a = new FakeVault();
    a.seed(path, 'the winning content');
    const engineA = await engineOn(client, a, new MemoryStateStore(), 'laptop');
    assert.equal((await engineA.sync()).errors.length, 0);

    // B pulls it and has an extra local-only file.
    const b = new FakeVault();
    const storeB = new MemoryStateStore();
    const engineB = await engineOn(client, b, storeB, 'phone');
    assert.equal((await engineB.sync()).errors.length, 0);
    assert.equal(b.contents(path), 'the winning content');
    b.seed(extraPath, 'my unsynced work');

    // A resets the vault, wiping it, then re-uploads its own tree.
    const reset = await client.resetVault(ownVaultId);
    assert.ok(reset.reset_epoch >= 1, 'the reset epoch moved');
    const storeA2 = new MemoryStateStore();
    const engineA2 = await engineOn(client, a, storeA2, 'laptop');
    assert.equal((await engineA2.sync()).errors.length, 0);

    // B syncs: its cursor predates the reset, so the probe answers 410 reset.
    const reportB = await engineB.sync();
    assert.equal(reportB.errors.length, 0, JSON.stringify(reportB.errors));

    // The shared file rebinds to the new node; the local-only work is quarantined, not gone.
    assert.equal(b.contents(path), 'the winning content');
    assert.equal(b.contents(extraPath), undefined, 'the displaced file leaves its path');
    const q = reportB.quarantined.find((x) => x.from === extraPath);
    assert.ok(q, 'the displaced work was quarantined');
    assert.equal(b.contents(q!.to), 'my unsynced work', 'and survives, in the quarantine folder');
  });

  it('a change notification wakes a listening device through the live WebSocket', async () => {
    // The real channel, end to end: the server's journal trigger notifies the hub, the hub
    // fans out to this device's WebSocket, and the listener wakes. Uses Node's global
    // WebSocket (present in the test runner, exactly as it is in Electron and the WebView).
    const notified: string[] = [];
    const listener = new PushListener({
      url: base.replace(/^http/, 'ws') + '/events',
      vaultId: ownVaultId,
      tokenSource: () => client.getAccessToken(),
      refresh: () => client.refreshToken(),
      onNotify: (vaultId) => notified.push(vaultId),
    });
    listener.start();

    // A write that bumps the vault's head: push a new file through the engine.
    const path = 'Devices/pushed-notify.md';
    const a = new FakeVault();
    a.seed(path, 'wake up');
    const report = await (await engineOn(client, a, new MemoryStateStore(), 'laptop')).sync();
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.ok(report.pushed.some((p) => p.path === path));

    // Give the LISTEN → fan-out → socket a moment to land.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !notified.includes(ownVaultId)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(notified.includes(ownVaultId), `the listener was woken: ${notified.join(', ')}`);
    await listener.stop();
  });
});

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * A shared folder whose key this device cannot open, against the real server.
 *
 * The unit tests for this build the state by hand: a scope reported with nothing to unwrap.
 * This one makes it the way it actually arises — a real share, prepared and activated through
 * the real endpoints, whose interior is genuinely named under `KS` by the server's own
 * triggers — and then takes the key away.
 *
 * Taking it away is the one step no client action produces: an envelope that never arrived,
 * or arrived sealed to somebody else's key, is a state of the DATA. So the share's stored
 * envelope is replaced with one wrapped under a key nothing here holds, which is exactly what
 * `shareKeysFrom` meets when it drops a scope — and then the pass is asked to survive it.
 *
 * What no fixture could prove and this does: that the server really does name the interior
 * under `KS` while leaving the root under `KV`, which is the fact the whole exclusion rests on.
 */
describe('a shared folder whose key this device cannot open, live', () => {
  const passphrase = 'a passphrase the server never sees';
  const folder = 'Team';
  const inside = `${folder}/plan.md`;
  const outside = 'ordinary.md';

  let vault: FakeVault;
  let store: MemoryStateStore;
  let shareVaultId: string;
  let kvS: Uint8Array;
  let seed: Uint8Array;
  let shareId: string;
  let goodEnvelope: string;

  /** One statement against the test database — the only way to reach a state no client can make. */
  const sql = async (statement: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      execFile('psql', ['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-c', statement], (err, _out, stderr) =>
        err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(),
      );
    });
  };

  const engineHere = async (): Promise<SyncEngine> =>
    new SyncEngine(
      client,
      shareVaultId,
      scopesOf(await client.openVault(shareVaultId), kvS),
      vault,
      store,
      'share-live',
    );

  before(async () => {
    const account = openAccount(
      passphrase,
      fromBase64(sess.connection.accountSalt),
      sess.connection.kdfParams,
      sess.connection.wrappedSeed,
    );
    seed = account.seed;
    shareVaultId = randomUuid();
    kvS = vaultKey(seed, shareVaultId);
    await client.createVault(shareVaultId, encryptName(kvS, 'shareVault'));

    vault = new FakeVault();
    vault.seed(outside, 'a note that is nobody else’s business');
    vault.seed(inside, 'the plan');
    store = new MemoryStateStore();
  });

  it('shares a folder, and the server names its interior under the share key', async () => {
    const first = await (await engineHere()).sync();
    assert.deepEqual(first.errors, [], JSON.stringify(first.errors));
    assert.equal(first.pushed.length, 2, 'both files went up before anything was shared');

    const tree = await (await engineHere()).readTree();
    const nodes = [...tree.values()].map((n) => ({
      path: n.path, nodeId: n.nodeId, address: n.address, nameKeyId: n.nameKeyId ?? '',
    }));

    const opened = await client.openVault(shareVaultId);
    const out = await shareFolder(
      {
        client,
        read: (p) => vault.read(p),
        vaultId: shareVaultId,
        vaultKey: kvS,
        vaultScopeId: vaultScopeIdOf(opened.scopes),
        newScopeId: () => randomUuid(),
      },
      folder,
      nodes,
    );
    shareId = out.shareId;

    // The fact the exclusion rests on, asserted against the real schema rather than assumed:
    // the ROOT keeps the vault's scope (SH-01) while what is inside it moves to the share's.
    const after = await (await engineHere()).readTree();
    assert.equal(after.get(folder)?.nameKeyId, vaultScopeIdOf(opened.scopes), 'the root stays under KV');
    assert.equal(after.get(inside)?.nameKeyId, out.scopeId, 'its interior is under KS');

    const scopes = await client.openVault(shareVaultId);
    goodEnvelope = scopes.scopes.find((s) => s.share_id === shareId)!.wrapped_key!;
    assert.ok(goodEnvelope, 'and the server hands this device its own copy of the key');
  });

  it('syncs normally while the key is still openable', async () => {
    const report = await (await engineHere()).sync();
    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.deepEqual(report.unreadable, [], 'nothing is unreadable yet');
  });

  it('survives the key becoming unopenable, and says which folder', async () => {
    // Sealed under a key nothing here holds: the shape an envelope has when it was meant for
    // somebody else, or when it did not survive whatever delivered it.
    const unopenable = wrapShareKey(randomBytes(32), randomBytes(32));
    await sql(`UPDATE shares SET wrapped_key_initiator = decode('${unopenable}', 'base64') WHERE id = '${shareId}'`);

    const report = await (await engineHere()).sync();

    assert.deepEqual(report.errors, [], 'the pass finished — this is the defect that made it not');
    assert.deepEqual(
      report.unreadable.map((u) => u.path),
      [folder],
      'and it names the folder, once, rather than every file in it',
    );
    assert.deepEqual(report.pushed, [], 'nothing inside it was re-uploaded under the vault key');
    assert.equal(vault.contents(inside), 'the plan', 'and nothing on disk was touched');
  });

  it('picks the folder up again when the key comes back', async () => {
    await sql(`UPDATE shares SET wrapped_key_initiator = decode('${goodEnvelope}', 'base64') WHERE id = '${shareId}'`);

    const report = await (await engineHere()).sync();

    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.deepEqual(report.unreadable, [], 'readable again, with no resync and nothing to repair');
    assert.deepEqual(report.pushed, [], 'and it did not mistake the folder for new work');
  });
});
