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
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { SyncClient } from '../src/api/client.js';
import { fetchTransport } from '../src/api/transport.js';
import { authSecret, createAccount, openAccount, vaultKey } from '../src/crypto/account.js';
import { openBlob, sealBlob } from '../src/crypto/blob.js';
import { fromBase64, fromUtf8, randomUuid, toBase64, utf8 } from '../src/crypto/bytes.js';
import { HEADER_BYTES } from '../src/crypto/format.js';
import { decryptName, dedupTag, encryptName, nameHmac, unwrapContentKey, wrapContentKey } from '../src/crypto/scope.js';
import { SyncEngine } from '../src/engine/engine.js';
import { MemoryStateStore } from '../src/engine/state.js';
import { FakeVault } from './fake-vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const entry = path.join(repo, 'server/dist/index.js');

const PORT = Number(process.env['SYNCSERVER_TEST_PORT'] ?? 18087);
const DB = process.env['SYNCSERVER_TEST_DB'] ?? 'syncserver_plugin';
const STORE = path.join(repo, `server/var/test-plugin-${process.pid}`);
const base = `http://127.0.0.1:${PORT}`;

// The REAL Argon2id parameters, not fast ones. The server enforces a 64 MiB floor (#62)
// and refuses anything weaker, so a round trip that lowered them would be testing a
// registration no plugin can perform. It costs about a second, once.

let server: ChildProcess;
const client = new SyncClient(base, fetchTransport);

// The shared account, created and named by the first describe, reused by the engine
// scenario that follows — one account, two devices (AC-11).
let account: ReturnType<typeof createAccount>;
let vaultId: string;

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
      DATABASE_URL: `postgres:///${DB}?host=/var/run/postgresql`,
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

  it('claims the seeded invitation with material derived on the device', async () => {
    const health = await client.health();
    assert.equal(health.bootstrap_pending, true, 'this test needs a fresh database — see npm run test:live');

    account = createAccount(passphrase);
    vaultId = randomUuid();

    // The vault key exists before the vault does: the client picks the id, so it can derive
    // KV and encrypt the vault's own label before anything reaches the server (AC-11).
    kv = vaultKey(account.seed, vaultId);

    const out = await client.redeem({
      invitation_token: 'admin',
      auth_secret: authSecret(account.seed),
      account_salt: toBase64(account.accountSalt),
      kdf_params: account.kdfParams,
      pubkey: 'AQ==',
      enc_privkey: 'Ag==',
      wrapped_seed: account.wrappedSeed,
      recovery_key: 'BA==',
      recovery_code_hash: 'f'.repeat(64),
      initial_vault_id: vaultId,
      initial_vault_name_enc: encryptName(kv, 'testVault'),
      device_name: 'roundtrip',
      device_platform: 'linux',
    });

    client.setAccessToken(out.access);
    rootNodeId = out.root_node_id;
    assert.equal(out.vault_id, vaultId, 'the server took the id the client chose');
  });

  it('reads its own vault label back, which the server cannot', async () => {
    const vaults = await client.listVaults();
    assert.equal(vaults.length, 1);
    assert.equal(decryptName(kv, vaults[0]!.name_enc), 'testVault');

    const opened = await client.openVault(vaultId);
    assert.equal(opened.root_node_id, rootNodeId);
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

  it('shows the server holding nothing it can read', async () => {
    const delta = await client.delta(vaultId);
    assert.ok(!('rejected' in delta));
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
    // Everything a fresh device has: the login, the passphrase, and what the server stores
    // in the clear. No key travels.
    const { account_salt, kdf_params } = await client.kdf('admin');
    const reopened = openAccount(passphrase, fromBase64(account_salt), kdf_params, account.wrappedSeed);
    assert.deepEqual(reopened.seed, account.seed, 'the seed came back out of its envelope');

    const kv2 = vaultKey(reopened.seed, vaultId);
    const delta = await client.delta(vaultId);
    assert.ok(!('rejected' in delta));
    const change = delta.changes[0]!;

    assert.equal(decryptName(kv2, change.name_enc!), filename);

    // The whole point, in one line: the file, recovered from the server by a client that
    // was given a passphrase and nothing else.
    const ciphertext = (await client.getBlob(change.sha256!))!;
    const envelopes = (await client.blobKeys(vaultId, [change.sha256!])).get(change.sha256!) ?? [];
    assert.ok(envelopes.length > 0, 'the envelope comes from the server: a second device has no local copy');

    // Picked BY SCOPE, not by position. One scope today; a shared folder adds more, and
    // "the first one" would then be whichever the database happened to return.
    const mine = envelopes.find((e) => e.scopeId === scopeId);
    assert.ok(mine, 'an envelope under this vault’s own key');
    assert.deepEqual(openBlob(unwrapContentKey(kv2, mine.wrappedKey), ciphertext), plaintext);
  });

  it('hands out no envelope for an address the caller does not hold', async () => {
    // Absent, not forbidden: an envelope is worth exactly what the bytes it opens are worth,
    // so it follows the same rule as a blob read (#20).
    const stranger = 'a'.repeat(64);
    assert.equal((await client.blobKeys(vaultId, [stranger])).size, 0);
  });

  it('refuses the wrong passphrase rather than returning rubbish', async () => {
    const { account_salt, kdf_params } = await client.kdf('admin');
    assert.throws(() => openAccount('not the passphrase', fromBase64(account_salt), kdf_params, account.wrappedSeed));
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

    const engineA = new SyncEngine(client, ownVaultId, kv2, a, new MemoryStateStore());
    const report = await engineA.sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.pushed.length, 1);
    assert.equal(report.pushed[0]!.path, name);
    assert.equal(a.contents(name), docsFile, 'A still has its file');
  });

  it('device B, an empty vault, materialises it through the delta', async () => {
    const b = new FakeVault();

    const engineB = new SyncEngine(client, ownVaultId, kv2, b, new MemoryStateStore());
    const report = await engineB.sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(b.contents(name), docsFile, 'B wrote exactly what A uploaded');
  });

  it('the server never saw a name', async () => {
    const delta = await client.delta(ownVaultId);
    assert.ok(!('rejected' in delta));
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
    const engine = new SyncEngine(client, ownVaultId, kv2, v, store);

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
    const report = await new SyncEngine(client, ownVaultId, kv2, b, new MemoryStateStore()).sync();

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

    const report = await new SyncEngine(client, ownVaultId, kv2, b, new MemoryStateStore()).sync();

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
    const engine = new SyncEngine(client, ownVaultId, kv2, v, store, 'laptop');

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

  it('declines to guess on a small file, falling back to create — and says what vanished', async () => {
    // Two empty-ish notes with identical content is the case the floor exists for: nothing
    // in the bytes says which one moved where.
    const tiny = 'tiny';
    const v = new FakeVault();
    v.seed('Small/one.md', tiny);
    const store = new MemoryStateStore();
    const engine = new SyncEngine(client, ownVaultId, kv2, v, store, 'laptop');
    assert.equal((await engine.sync()).errors.length, 0);

    await v.delete('Small/one.md');
    v.seed('Small/two.md', tiny);

    const report = await engine.sync();
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.renamed.length, 0, 'too small to be sure, so it did not pretend to be');
    assert.ok(report.pushed.some((p) => p.path === 'Small/two.md'), 'created instead — the blob deduplicates anyway');
    assert.deepEqual(report.vanished, [{ path: 'Small/one.md' }], 'and the disappearance is reported, not acted on');
  });

  it('two clients editing the same file: the server refuses the second, and neither version is lost', async () => {
    // The M1 conflict scenario, end to end against a real server. Both devices sync the
    // file first, so each has it as a KNOWN node — this is the ordinary two-client conflict,
    // not adoption's no-common-ancestor case.
    const conflictPath = 'Devices/two-clients.md';

    const a = new FakeVault();
    a.seed(conflictPath, 'the shared starting point');
    const storeA = new MemoryStateStore();
    const engineA = new SyncEngine(client, ownVaultId, kv2, a, storeA, 'laptop');
    assert.equal((await engineA.sync()).errors.length, 0);

    const b = new FakeVault();
    b.seed(conflictPath, 'the shared starting point');
    const storeB = new MemoryStateStore();
    const engineB = new SyncEngine(client, ownVaultId, kv2, b, storeB, 'phone');
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
    const delta = await client.delta(ownVaultId);
    assert.ok(!('rejected' in delta));
    assert.ok(
      delta.changes.some((c) => c.name_enc && decryptName(kv2, c.name_enc) === basenameOf(conflict.conflictPath)),
      'the conflict file reached the server',
    );
  });

  it('adoption: identical content under a NEW path binds to the existing address — nothing sealed twice', async () => {
    const copyPath = 'Devices/copy-of-the-document.md';
    const b = new FakeVault();
    b.seed(copyPath, docsFile); // same bytes as `name`, never uploaded under this path before
    const report = await new SyncEngine(client, ownVaultId, kv2, b, new MemoryStateStore()).sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.pushed.length, 1, 'a node WAS created — dedup binds, it does not skip the file');

    const delta = await client.delta(ownVaultId);
    assert.ok(!('rejected' in delta));
    const original = delta.changes.find((c) => decryptName(kv2, c.name_enc!) === name)!;
    const copy = delta.changes.find((c) => decryptName(kv2, c.name_enc!) === basenameOf(copyPath))!;

    // `KC` is random, so sealing the same plaintext twice gives two DIFFERENT addresses
    // (docs/06). Equal addresses here are only possible if the engine used the dedup match
    // instead of sealing fresh bytes — the whole claim, made unfalsifiable by construction.
    assert.equal(copy.sha256, original.sha256, 'bound to the address that already held this content');
  });
});

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
