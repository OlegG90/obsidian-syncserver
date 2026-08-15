/**
 * Thawing, and the catch-up that has to come with it (SH-20, SH-21).
 *
 * A freeze stops propagation in both directions, so what a frozen member misses is missed
 * for good: propagation is an event and the events are over. These tests are about the only
 * thing that can repair that — a walk of somebody else's copy, which is what SH-21 specifies
 * and why it says "not a re-copy".
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { catchUpShare } from '../src/shares/catchup.js';

const cfg = loadConfig();
let db: Db;
let app: FastifyInstance;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Two accounts, each with a vault: an initiator and somebody who will be frozen. */
const account = async (label: string) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 10000000)`,
    [id, `${label}-${process.pid}-${randomUUID().slice(0, 8)}`],
  );
  const vaultId = randomUUID();
  const rootId = randomUUID();
  await db.tx(async (c) => {
    const scope = await c.query<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, '\\x00', $3, $4, 'vault')`,
      [vaultId, id, rootId, scope.rows[0]!.id],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev, ancestry)
       VALUES ($1, $2, NULL, 'folder', now(), 1, ARRAY[]::uuid[])`,
      [vaultId, rootId],
    );
    // The schema refuses a node whose revision runs ahead of its vault's head, so a fixture
    // that writes revisions by hand has to move the head with them — the production paths
    // take theirs from `nextRev`, which does this for them.
    await c.query(`UPDATE vaults SET head_rev = 1 WHERE id = $1`, [vaultId]);
  });
  return { id, vaultId, rootId };
};

before(async () => {
  db = connect(cfg.databaseUrl);
  await db.query(
    `UPDATE users SET state = 'active', role = 'admin', auth_secret_hash = 'h',
            account_salt = decode('00112233445566778899aabbccddeeff','hex'),
            kdf_params = '{"v":19,"m":65536,"t":3,"p":1}', pubkey = '\\x01', enc_privkey = '\\x02',
            kek_verifier_hash = 'kv', wrapped_seed = '\\x04',
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );
  app = await buildApp(db, cfg);
});

after(async () => {
  await app.close();
  await db.close();
});

/** An active share of one folder, with a second member who has joined. */
const sharedFolder = async () => {
  const owner = await account('owner');
  const away = await account('away');

  const shareId = randomUUID();
  const scopeId = randomUUID();
  const folderId = randomUUID();
  const rootItemId = randomUUID();

  await db.tx(async (c) => {
    await c.query(`INSERT INTO key_scopes (id, kind) VALUES ($1, 'share')`, [scopeId]);
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
       VALUES ($1, $2, $3, decode($4,'base64'), decode($5,'hex'), $6, 'folder', now(), 2, ARRAY[$3]::uuid[])`,
      [owner.vaultId, folderId, owner.rootId, b64('shared'), sha(Buffer.from('shared')), await vaultKeyOf(owner.vaultId)],
    );
    await c.query(
      `INSERT INTO shares (id, initiator_id, initiator_vault_id, subtree_node_id, subtree_key_id,
                           subtree_key_scope_kind, wrapped_key_initiator, root_item_id, state)
       VALUES ($1, $2, $3, $4, $5, 'share', '\\x01', $6, 'active')`,
      [shareId, owner.id, owner.vaultId, folderId, scopeId, rootItemId],
    );
    await c.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at) VALUES ($1, $2, $3, now())`,
      [shareId, owner.id, owner.vaultId],
    );
    await c.query(`UPDATE nodes SET share_id = $1, share_item_id = $2 WHERE vault_id = $3 AND id = $4`, [
      shareId,
      rootItemId,
      owner.vaultId,
      folderId,
    ]);

    // The away member's replica: their own root for the share, named under their own key.
    const replicaRoot = randomUUID();
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev,
                          ancestry, share_id, share_item_id)
       VALUES ($1, $2, $3, decode($4,'base64'), decode($5,'hex'), $6, 'folder', now(), 2, ARRAY[$3]::uuid[], $7, $8)`,
      [
        away.vaultId,
        replicaRoot,
        away.rootId,
        b64('their copy'),
        sha(Buffer.from('their copy')),
        await vaultKeyOf(away.vaultId),
        shareId,
        rootItemId,
      ],
    );
    // With the envelope that carries `KS` to them: the schema refuses a participant who
    // joined an e2ee share without one, which is the rule that makes "joined" mean "can read
    // it" rather than merely "is listed".
    await c.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
       VALUES ($1, $2, $3, now(), '\xfeed')`,
      [shareId, away.id, away.vaultId],
    );
    await c.query(`UPDATE vaults SET head_rev = 2 WHERE id = ANY($1::uuid[])`, [[owner.vaultId, away.vaultId]]);
  });

  return { owner, away, shareId, scopeId, folderId, rootItemId };
};

const vaultKeyOf = async (vaultId: string) =>
  (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [vaultId]))!.id;

/** A file written into the owner's copy while the other member is frozen out of it. */
const writeWhileAway = async (
  share: Awaited<ReturnType<typeof sharedFolder>>,
  body: string,
): Promise<{ shareItemId: string; sha256: string }> => {
  const bytes = Buffer.from(body);
  const hex = sha(bytes);
  const shareItemId = randomUUID();
  const nodeId = randomUUID();

  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
       VALUES (decode($1,'hex'), $2, $3, 'xchacha20-poly1305', $4)
       ON CONFLICT (sha256) DO NOTHING`,
      [hex, bytes.length, `t/${hex}`, share.scopeId],
    );
    await c.query(
      `INSERT INTO blob_keys (sha256, scope_id, wrapped_key) VALUES (decode($1,'hex'), $2, '\\xbeef')
       ON CONFLICT DO NOTHING`,
      [hex, share.scopeId],
    );
    await c.query(
      `INSERT INTO dedup_index (scope_id, content_tag, sha256)
       VALUES ($1, decode($2,'hex'), decode($3,'hex')) ON CONFLICT DO NOTHING`,
      [share.scopeId, sha(Buffer.from(`tag:${hex}`)), hex],
    );
    await c.query(
      `INSERT INTO user_blobs (user_id, sha256, refs_own) VALUES ($1, decode($2,'hex'), 1)
       ON CONFLICT (user_id, sha256) DO UPDATE SET refs_own = user_blobs.refs_own + 1`,
      [share.owner.id, hex],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type,
                          sha256, size, mtime, rev, ancestry, share_id, share_item_id)
       VALUES ($1, $2, $3, decode($4,'base64'), decode($5,'hex'), $6, 'file',
               decode($7,'hex'), $8, now(), 3, ARRAY[$9,$3]::uuid[], $10, $11)`,
      [
        share.owner.vaultId,
        nodeId,
        share.folderId,
        b64(body),
        sha(Buffer.from(body)),
        share.scopeId,
        hex,
        bytes.length,
        share.owner.rootId,
        share.shareId,
        shareItemId,
      ],
    );
    await c.query(`UPDATE vaults SET head_rev = 3 WHERE id = $1`, [share.owner.vaultId]);
    await c.query(
      `INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id)
       VALUES ($1, $2, 3, decode($3,'hex'), $4, $5)`,
      [share.owner.vaultId, nodeId, hex, bytes.length, share.owner.id],
    );
  });

  return { shareItemId, sha256: hex };
};

describe('catching a thawed replica up (SH-21)', () => {
  it('delivers what arrived during the freeze, and the history behind it', async () => {
    const share = await sharedFolder();
    const written = await writeWhileAway(share, `while away ${randomUUID()}`);

    const done = await db.tx((c) =>
      catchUpShare(c, { userId: share.away.id, vaultId: share.away.vaultId }, share.shareId),
    );
    assert.equal(done.created, 1, 'the file created while frozen arrives');
    assert.ok(done.versions >= 1, 'and the version rows behind it, which is what makes this not a re-copy');

    const theirs = await db.one<{ id: string; sha256: string }>(
      `SELECT id, encode(sha256,'hex') AS sha256 FROM nodes
        WHERE vault_id = $1 AND share_item_id = $2`,
      [share.away.vaultId, written.shareItemId],
    );
    assert.ok(theirs, 'their copy now holds the item');
    assert.equal(theirs!.sha256, written.sha256, 'pointing at the same bytes — the blob is not copied');

    const author = await db.one<{ authorId: string }>(
      `SELECT author_id AS "authorId" FROM versions WHERE vault_id = $1 AND node_id = $2`,
      [share.away.vaultId, theirs!.id],
    );
    assert.equal(author!.authorId, share.owner.id, 'authorship survives the crossing (SH-19)');

    const journal = await db.query(
      `SELECT 1 FROM journal WHERE vault_id = $1 AND node_id = $2`,
      [share.away.vaultId, theirs!.id],
    );
    assert.ok(journal.length > 0, 'and their own devices are told, or the arrival is invisible');
  });

  it('is idempotent: a replica already level is not written to at all', async () => {
    // It runs on every thaw, and a freeze that lifted with nothing missed must not manufacture
    // revisions — every one of them is a change somebody's client will come and fetch.
    const share = await sharedFolder();
    await writeWhileAway(share, `once ${randomUUID()}`);

    await db.tx((c) => catchUpShare(c, { userId: share.away.id, vaultId: share.away.vaultId }, share.shareId));
    const again = await db.tx((c) =>
      catchUpShare(c, { userId: share.away.id, vaultId: share.away.vaultId }, share.shareId),
    );

    assert.deepEqual(
      { created: again.created, updated: again.updated, deleted: again.deleted, versions: again.versions },
      { created: 0, updated: 0, deleted: 0, versions: 0 },
    );
  });

  it('leaves the replica root alone, because each copy named its own (SH-01)', async () => {
    const share = await sharedFolder();
    const before = await db.one<{ nameEnc: string; rev: number }>(
      `SELECT encode(name_enc,'base64') AS "nameEnc", rev FROM nodes
        WHERE vault_id = $1 AND share_item_id = $2`,
      [share.away.vaultId, share.rootItemId],
    );

    await writeWhileAway(share, `root untouched ${randomUUID()}`);
    await db.tx((c) => catchUpShare(c, { userId: share.away.id, vaultId: share.away.vaultId }, share.shareId));

    const after = await db.one<{ nameEnc: string; rev: number }>(
      `SELECT encode(name_enc,'base64') AS "nameEnc", rev FROM nodes
        WHERE vault_id = $1 AND share_item_id = $2`,
      [share.away.vaultId, share.rootItemId],
    );
    assert.deepEqual(after, before, 'the name they gave it is theirs, and so is its revision');
  });
});
