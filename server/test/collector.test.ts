/**
 * Collector: the TTL sweeps docs/04 promises. An unbound blob past its TTL drops its
 * quota row and then its storage; a stale `.part` temp file is swept by age alone; the
 * delta journal is pruned on its TTL; and a blob with a live reference survives all of it.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { openStore } from '../src/blobs/store.js';
import { runCollector } from '../src/collector.js';
import { INTERLOCK_ID as COLLECTOR_LOCK_ID } from '../src/interlock.js';

const STORE = `var/test-collector-${process.pid}`;
// Small TTLs so the test can backdate rows instead of waiting.
const cfg = {
  ...loadConfig(),
  blobStorePath: STORE,
  limits: {
    ...loadConfig().limits,
    abandonedPartTtlSeconds: 60,
    unboundBlobTtlSeconds: 60,
    journalTtlSeconds: 60,
    gcQuarantineSeconds: 60,
  },
};

let db: Db;
let app: FastifyInstance;
let token: string;
let keyId: string;
let vaultId: string;
let rootId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${token}` });

const uploadBlob = async (body: Buffer): Promise<string> => {
  const hex = sha(body);
  const r = await app.inject({
    method: 'POST', url: '/blobs',
    query: { sha256: hex, size: String(body.length), key_id: keyId },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  assert.equal(r.statusCode, 201, r.body);
  return hex;
};

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
    [userId, `collector-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [userId],
  );
  token = app.jwt.sign({ sub: userId, device: device!.id });

  const vaultIdRaw = randomUUID();
  const v = await app.inject({
    method: 'POST', url: '/vaults', headers: auth(),
    payload: { id: vaultIdRaw, name_enc: Buffer.from('collector vault').toString('base64') },
  });
  assert.equal(v.statusCode, 201, v.body);
  vaultId = vaultIdRaw;
  rootId = v.json().root_node_id;
  keyId = (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [vaultIdRaw]))!.id;

  await mkdir(path.join(STORE, 'ab'), { recursive: true });
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('the collector', () => {
  it('drops an unbound blob past its TTL, then holds its bytes in quarantine before removing them', async () => {
    const body = randomBytes(768);
    const hex = await uploadBlob(body);
    const addr = Buffer.from(hex, 'hex');
    const file = path.join(STORE, hex.slice(0, 2), hex.slice(2, 4), hex);

    const rowOf = async (h: string) =>
      db.one(`SELECT 1 AS x FROM user_blobs WHERE user_id = $1 AND sha256 = $2`, [
        (await db.one<{ id: string }>(`SELECT id FROM users WHERE login = $1`, [`collector-${process.pid}`]))!.id,
        Buffer.from(h, 'hex'),
      ]);
    assert.ok(await rowOf(hex), 'an unbound upload has a quota row');

    // Backdate the pending claim past the TTL, then sweep.
    await db.query(`UPDATE user_blobs SET pending_since = now() - interval '2 minutes' WHERE sha256 = $1`, [addr]);
    const first = await runCollector(db, openStore(STORE), cfg);
    assert.ok(first.unboundDropped >= 1, `expected an unbound row dropped, got ${first.unboundDropped}`);
    assert.equal(await rowOf(hex), undefined, 'the quota row is gone at once — it is what quota counts');

    // And the bytes are NOT. Losing a last reference is the moment an upload of the same
    // content is most likely to be in flight: it writes its file before it commits its row,
    // so a delete on the spot can leave a committed row pointing at nothing. The hold is
    // what makes that race theoretical, and it is the half a single pass must not skip.
    // Asked of this blob rather than of the pass's counters: the database is shared with
    // every other suite, and a total says as much about their leftovers as about this one.
    const condemned = await db.one<{ marked: string | null }>(
      `SELECT gc_marked_at AS marked FROM blobs WHERE sha256 = $1`, [addr]);
    assert.ok(condemned?.marked, 'condemned rather than deleted');
    await access(file); // throws if the file went — nothing goes on one look

    await db.query(`UPDATE blobs SET gc_marked_at = now() - interval '2 minutes' WHERE sha256 = $1`, [addr]);
    const second = await runCollector(db, openStore(STORE), cfg);
    assert.ok(second.blobsRemoved >= 1, `expected a blob removed, got ${second.blobsRemoved}`);
    assert.equal(
      await db.one(`SELECT 1 AS x FROM blobs WHERE sha256 = $1`, [addr]),
      undefined,
      'the blob row is gone',
    );
    await assert.rejects(access(file), 'storage gone too');
  });

  it('takes a blob back out of quarantine when something claims it again', async () => {
    // The other half of the same rule. A blob bound between two passes must be unmarked, or
    // a file somebody is actively reading is deleted on the strength of an observation made
    // a week earlier.
    const body = randomBytes(512);
    const hex = await uploadBlob(body);
    const addr = Buffer.from(hex, 'hex');

    await db.query(`UPDATE user_blobs SET pending_since = now() - interval '2 minutes' WHERE sha256 = $1`, [addr]);
    await runCollector(db, openStore(STORE), cfg);
    const marked = await db.one<{ marked: string | null }>(
      `SELECT gc_marked_at AS marked FROM blobs WHERE sha256 = $1`, [addr]);
    assert.ok(marked?.marked, 'in quarantine to begin with');

    // Somebody uploads the same content again — the address is the content, so this is the
    // ordinary way a condemned blob comes back to life.
    await uploadBlob(body);
    await runCollector(db, openStore(STORE), cfg);

    const mark = await db.one<{ marked: string | null }>(
      `SELECT gc_marked_at AS marked FROM blobs WHERE sha256 = $1`, [addr]);
    assert.equal(mark!.marked, null, 'and it is not merely ignored — the row says it is alive');
    await access(path.join(STORE, hex.slice(0, 2), hex.slice(2, 4), hex));
  });

  it('leaves a blob with a live reference alone', async () => {
    const body = randomBytes(256);
    const hex = await uploadBlob(body);
    await db.query(`UPDATE user_blobs SET refs_own = 1, refs_pending = 0, pending_since = NULL, pending_device_id = NULL
                     WHERE sha256 = $1`, [Buffer.from(hex, 'hex')]);

    const r = await runCollector(db, openStore(STORE), cfg);
    assert.ok(r.unboundDropped === 0, `no unbound row expected, got ${r.unboundDropped}`);
    const stillThere = await db.one<{ x: number }>(`SELECT 1 AS x FROM blobs WHERE sha256 = $1`, [Buffer.from(hex, 'hex')]);
    assert.ok(stillThere, 'a bound blob is never swept');
  });

  it('clears a stale pending claim on a bound blob without touching the row', async () => {
    // refs_own holds the row up, so the unbound sweep cannot see it; before this the
    // counter had no way back down.
    const body = randomBytes(320);
    const hex = await uploadBlob(body);
    const sha256 = Buffer.from(hex, 'hex');

    // Bound by a real node, not by writing `refs_own` on its own. The reconcile in this
    // pass recomputes what an account holds from what actually points at it (docs/03 step
    // 4), so a counter with nothing behind it is exactly what it is there to remove — and a
    // fixture that fakes one is asserting the counter rather than the binding.
    const bound = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: auth(),
      payload: {
        parent_id: rootId, type: 'file', sha256: hex, size: body.length,
        mtime: new Date().toISOString(),
        name_enc: Buffer.from('bound.md').toString('base64'),
        name_hmac: sha(Buffer.from('bound.md')), name_key_id: keyId,
        blob_envelopes: [{ sha256: hex, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
        dedup_tags: [{ sha256: hex, scope_id: keyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
      },
    });
    assert.equal(bound.statusCode, 201, bound.body);

    await db.query(
      `UPDATE user_blobs SET refs_pending = 2, pending_since = now() - interval '2 minutes'
        WHERE sha256 = $1`,
      [sha256],
    );

    const r = await runCollector(db, openStore(STORE), cfg);
    assert.ok(r.pendingCleared >= 1, `expected a pending claim cleared, got ${r.pendingCleared}`);

    const row = await db.one<{ own: number; pending: number; since: Date | null }>(
      `SELECT refs_own AS own, refs_pending AS pending, pending_since AS since
         FROM user_blobs WHERE sha256 = $1`,
      [sha256],
    );
    assert.ok(row, 'the row survives — it is bound');
    assert.equal(row.pending, 0, 'the stale claim is gone');
    assert.equal(row.since, null, 'and pending_since with it (pending_fields_travel_together)');
    assert.equal(row.own, 1, 'the binding is untouched');
    assert.ok(
      await db.one(`SELECT 1 AS x FROM blobs WHERE sha256 = $1`, [sha256]),
      'and the blob is not swept: the row still references it',
    );
  });

  it('leaves a fresh pending claim alone', async () => {
    const body = randomBytes(321);
    const hex = await uploadBlob(body);
    const sha256 = Buffer.from(hex, 'hex');
    await db.query(`UPDATE user_blobs SET refs_own = 1, refs_pending = 1 WHERE sha256 = $1`, [sha256]);

    await runCollector(db, openStore(STORE), cfg);
    const row = await db.one<{ pending: number }>(
      `SELECT refs_pending AS pending FROM user_blobs WHERE sha256 = $1`,
      [sha256],
    );
    assert.equal(row?.pending, 1, 'an upload still being bound is not the collector’s business');
  });

  it('skips the pass while the advisory lock is held elsewhere', async () => {
    // What an operator does for the duration of a backup (docs/08), and what a second
    // server process against the same database does to itself.
    const held = await db.session(async (c) => {
      await c.query('SELECT pg_advisory_lock($1)', [COLLECTOR_LOCK_ID]);
      try {
        return await runCollector(db, openStore(STORE), cfg);
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [COLLECTOR_LOCK_ID]);
      }
    });
    assert.equal(held.skipped, true, 'the pass is skipped, not queued');
    assert.equal(held.journalPruned, 0, 'and nothing was collected');

    // Released again, the next pass runs normally.
    const after = await runCollector(db, openStore(STORE), cfg);
    assert.equal(after.skipped, false, 'the lock is not left behind');
  });

  it('sweeps stale parts by age, not by reference', async () => {
    // A .part file with an old mtime is an interrupted upload; a fresh one is an upload
    // in progress.
    const stale = path.join(STORE, 'ab', `orphan.part`);
    await writeFile(stale, 'stale');
    await utimes(stale, new Date(Date.now() - 2 * 60_000), new Date(Date.now() - 2 * 60_000));

    const fresh = path.join(STORE, 'ab', `fresh.part`);
    await writeFile(fresh, 'fresh'); // mtime = now

    const r = await runCollector(db, openStore(STORE), cfg);
    assert.ok(r.partsSwept >= 1, `expected a stale part swept, got ${r.partsSwept}`);

    await assert.rejects(access(stale));
    await access(fresh); // does not throw
  });

  it('sweeps an abandoned resumable upload by its newest part, not by each part', async () => {
    // An upload is abandoned when nothing has arrived for it in a long time. Judging each
    // part separately would eat the early parts of a slow but live migration while its
    // later ones were still coming in — which is how a resumable upload becomes one that
    // can never finish.
    const store = openStore(STORE);
    const old = new Date(Date.now() - 2 * 60_000);

    const abandoned = path.join(STORE, 'staging', 'user-a', 'aa'.repeat(32));
    await mkdir(abandoned, { recursive: true });
    for (const n of ['1', '2']) {
      await writeFile(path.join(abandoned, n), n);
      await utimes(path.join(abandoned, n), old, old);
    }

    // Same shape, but one part arrived just now: the upload is alive.
    const live = path.join(STORE, 'staging', 'user-a', 'bb'.repeat(32));
    await mkdir(live, { recursive: true });
    await writeFile(path.join(live, '1'), '1');
    await utimes(path.join(live, '1'), old, old);
    await writeFile(path.join(live, '2'), '2'); // mtime = now

    await runCollector(db, store, cfg);

    await assert.rejects(access(path.join(abandoned, '1')));
    await access(path.join(live, '1')); // the old part of a live upload stays
    await access(path.join(live, '2'));
  });

  it('prunes the delta journal past its TTL', async () => {
    // Raise the vault head so the revs below are not "beyond the head revision".
    await db.query(`UPDATE vaults SET head_rev = 2000 WHERE id = $1`, [vaultId]);

    const nodeId = randomUUID();
    await db.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev, at) VALUES ($1, 1001, $2, 'put', 1001, now() - interval '2 minutes')`,
      [vaultId, nodeId],
    );
    await db.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev) VALUES ($1, 1002, $2, 'put', 1002)`,
      [vaultId, nodeId],
    );

    const r = await runCollector(db, openStore(STORE), cfg);
    assert.ok(r.journalPruned >= 1, `expected the stale journal row pruned, got ${r.journalPruned}`);
    assert.equal(
      await db.one(`SELECT 1 AS x FROM journal WHERE vault_id = $1 AND rev = 1001`, [vaultId]),
      undefined,
      'the old row is gone',
    );
    assert.ok(
      await db.one(`SELECT 1 AS x FROM journal WHERE vault_id = $1 AND rev = 1002`, [vaultId]),
      'the fresh row stays',
    );
  });
});
describe('the retention ladder', () => {
  /** A file with `count` writes, every version backdated to `daysAgo`. */
  const aged = async (name: string, bodies: Buffer[], daysAgo: number[]) => {
    const first = bodies[0]!;
    const hex = await uploadBlob(first);
    const created = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: auth(),
      payload: {
        parent_id: rootId, type: 'file', sha256: hex, size: first.length,
        mtime: new Date().toISOString(),
        name_enc: Buffer.from(name).toString('base64'),
        name_hmac: sha(Buffer.from(name)), name_key_id: keyId,
        blob_envelopes: [{ sha256: hex, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
        dedup_tags: [{ sha256: hex, scope_id: keyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const nodeId = created.json().node_id as string;

    let base = hex;
    for (const body of bodies.slice(1)) {
      const next = await uploadBlob(body);
      const put = await app.inject({
        method: 'PUT', url: `/vaults/${vaultId}/nodes/${nodeId}`, headers: auth(),
        payload: {
          sha256: next, size: body.length, mtime: new Date().toISOString(), base_sha256: base,
          blob_envelopes: [{ sha256: next, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
          dedup_tags: [{ sha256: next, scope_id: keyId, content_tag: sha(Buffer.from(`tag:${next}`)) }],
        },
      });
      assert.equal(put.statusCode, 200, put.body);
      base = next;
    }

    const revs = await db.query<{ rev: string }>(
      `SELECT rev::text AS rev FROM versions WHERE vault_id = $1 AND node_id = $2 ORDER BY rev`,
      [vaultId, nodeId],
    );
    assert.equal(revs.length, daysAgo.length, 'one age per version, oldest first');
    for (const [i, days] of daysAgo.entries()) {
      await db.query(
        `UPDATE versions SET at = now() - make_interval(days => $3) WHERE vault_id = $1 AND rev = $2`,
        [vaultId, Number(revs[i]!.rev), days],
      );
    }
    return nodeId;
  };

  const survivors = async (nodeId: string) => {
    const rows = await db.query<{ rev: string }>(
      `SELECT rev::text AS rev FROM versions WHERE vault_id = $1 AND node_id = $2 ORDER BY rev`,
      [vaultId, nodeId],
    );
    return rows.length;
  };

  it('keeps everything under a week, whatever else the ladder says', async () => {
    const node = await aged(`fresh-${randomUUID()}.md`,
      [randomBytes(64), randomBytes(64), randomBytes(64)], [6, 5, 1]);
    await runCollector(db, openStore(STORE), cfg);
    assert.equal(await survivors(node), 3, 'a week of edits is a week of edits');
  });

  it('thins to one a day between a week and a month, and one a week beyond it', async () => {
    // Two versions on the same day, ten days back: one survives. Two versions on the SAME
    // day, sixty days back: one survives (the "one a week" step groups by calendar week, so
    // the two must share a date or the test would depend on which weekday today is — 60 and
    // 58 days back landed in different weeks on some days and the assertion drifted between
    // 3 and 4). Plus the head, which is not history at all.
    const node = await aged(`ladder-${randomUUID()}.md`,
      [randomBytes(64), randomBytes(64), randomBytes(64), randomBytes(64), randomBytes(64)],
      [60, 60, 10, 10, 0]);
    await runCollector(db, openStore(STORE), cfg);
    assert.equal(await survivors(node), 3, 'one for the old week, one for the day, and the head');
  });

  it('never touches the head of a live file, however old it is', async () => {
    // The head is the file, not its history. A ladder that could take it is a ladder that
    // deletes notes — so it sits outside the policy rather than at the safe end of it.
    const node = await aged(`ancient-${randomUUID()}.md`, [randomBytes(64), randomBytes(64)], [900, 800]);
    await runCollector(db, openStore(STORE), cfg);
    assert.equal(await survivors(node), 1, 'everything but the head, and the head stays');

    const alive = await db.one<{ deleted: string | null }>(
      `SELECT deleted_at AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, node]);
    assert.equal(alive!.deleted, null, 'and the node is still a file, not a trash entry');
  });

  it('honours an account that asked to keep less', async () => {
    const node = await aged(`short-${randomUUID()}.md`,
      [randomBytes(64), randomBytes(64), randomBytes(64)], [200, 100, 0]);
    await db.query(`UPDATE users SET history_days = 30 WHERE login = $1`, [`collector-${process.pid}`]);
    await runCollector(db, openStore(STORE), cfg);
    await db.query(`UPDATE users SET history_days = 365 WHERE login = $1`, [`collector-${process.pid}`]);

    assert.equal(await survivors(node), 1, 'past their own bound, only the head remains');
  });

  it('empties the trash by itself once the last version has aged out', async () => {
    // What makes the trash finite without anybody pressing anything. A deleted node's head
    // is NOT exempt — it is history now — so the ladder takes it, and the row that held it
    // has nothing left to restore.
    const node = await aged(`forgotten-${randomUUID()}.md`, [randomBytes(64)], [900]);
    const rev = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, node]);
    const removed = await app.inject({
      method: 'DELETE', url: `/vaults/${vaultId}/nodes/${node}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });
    assert.equal(removed.statusCode, 200, removed.body);

    const r = await runCollector(db, openStore(STORE), cfg);
    assert.ok(r.versionsThinned >= 1);
    assert.ok(r.trashRemoved >= 1);
    const left = await db.one(`SELECT 1 AS x FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, node]);
    assert.equal(left, undefined, 'the row goes with the last thing it could have restored');
  });
});
