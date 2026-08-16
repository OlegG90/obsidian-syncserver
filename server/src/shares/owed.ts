/**
 * What a vault still owes under a key scope — the same question, asked in both directions.
 *
 * Preparing a share moves its interior from `KV` to `KS`; leaving moves it back. Both sides
 * have to know which blobs lack material under the key the subtree is moving TO, and the
 * answer lives in tables only the server holds — `blob_keys`, `dedup_index`, `versions`.
 * Every time a client guessed instead, it guessed wrong in both directions at once: convert
 * everything and it fails on material that was never there, skip and the write is refused.
 *
 * So one query answers all of it, with the scope as its only parameter. Asked twice it would
 * drift, and the drift stays invisible until somebody cannot leave a folder they shared.
 */
import type { Db } from '../db.js';

/**
 * The material a participant would need and does not have yet.
 *
 * Activation is the server's one real check, and it exists because everything after it
 * assumes the answer. A share activated with a hole hands somebody a folder they cannot
 * open — and they would find out later, file by file, with no way to tell a missing
 * envelope from a corrupt one.
 */
export type PreparationGap = {
  nodeId: string;
  /** `name` — still under `KV`; `content` — no `KS` envelope for bytes it references. */
  missing: string;
};

/**
 * What is not yet prepared under `KS`, for the interior of a share.
 *
 * **Interior, not the root.** The share's own folder keeps its `KV` label for the life of
 * the share and after (SH-01, SH-25): it sits beside private siblings, and a participant
 * who cannot read `KV` never needs to read it — they name their own copy's root when they
 * join. Every node *below* it is different, because a participant may create and rename
 * there, so those names must be under `KS`.
 *
 * Two ways to be unprepared, and both matter:
 *
 * - a **name** still under the vault key, which a participant could not decrypt;
 * - **content** with no `KS` envelope — for the live file and for every version still
 *   reachable, since joining delivers a file's retained history and not only its head
 *   (SH-15, SH-23). A head that opens beside a history that does not is the subtler hole,
 *   and the one a check written against current nodes alone would miss.
 */
export const preparationGaps = (db: Db, vaultId: string, rootId: string, keyId: string): Promise<PreparationGap[]> =>
  db.query<PreparationGap>(
    `SELECT n.id AS "nodeId", 'name' AS missing
       FROM nodes n
      WHERE n.vault_id = $1 AND n.ancestry @> ARRAY[$2]::uuid[]
        AND n.deleted_at IS NULL AND n.name_key_id IS DISTINCT FROM $3
      UNION
     SELECT n.id, 'content'
       FROM nodes n
      WHERE n.vault_id = $1 AND n.ancestry @> ARRAY[$2]::uuid[]
        AND n.deleted_at IS NULL AND n.type = 'file' AND n.sha256 IS NOT NULL
        AND (NOT EXISTS (SELECT 1 FROM blob_keys k WHERE k.sha256 = n.sha256 AND k.scope_id = $3)
          -- The tag too, and only here: the schema asks for it exactly where the plaintext
          -- is — a live head. Checking it for history as well would report a gap no client
          -- could close, since a superseded version is not on anybody's disk.
          OR NOT EXISTS (SELECT 1 FROM dedup_index d WHERE d.sha256 = n.sha256 AND d.scope_id = $3))
      UNION
     SELECT v.node_id, 'content'
       FROM versions v
       JOIN nodes n ON n.vault_id = v.vault_id AND n.id = v.node_id
      WHERE n.vault_id = $1 AND n.ancestry @> ARRAY[$2]::uuid[]
        AND NOT EXISTS (SELECT 1 FROM blob_keys k WHERE k.sha256 = v.sha256 AND k.scope_id = $3)
      LIMIT 20`,
    [vaultId, rootId, keyId],
  );

/** One node the departing client must convert, as only it can. */
export type ReplicaNode = {
  nodeId: string;
  nameEnc: string | null;
  nameKeyId: string | null;
  type: string;
  deleted: boolean;
  /**
   * The ciphertext address, for a file.
   *
   * Needed because leaving re-wraps the content key under `KV`, and for somebody who
   * JOINED the share there is no other envelope: the blob's `KV` envelope belongs to the
   * initiator's vault key, which this account never had. Without it their files stay
   * readable only under a key that is about to stop being offered.
   */
  sha256: string | null;
  /**
   * Whether this node's bytes still need an envelope and tag under the vault key.
   *
   * The server can see this and the client cannot — `blob_keys` and `dedup_index` are its
   * tables — so it says it, exactly as `preparationGaps` does for the other direction.
   * Leaving it to the client meant guessing: convert everything and fail on material that
   * was never there, or skip on a missing source and fail the unmark instead, which the
   * schema refuses with "cannot be unmarked before blob … has its vault envelope".
   */
  needsVaultMaterial: boolean;
  /**
   * Superseded blobs of this node that still owe an envelope under the vault key.
   *
   * A node is not one blob. Every write made while the folder was shared minted its content
   * key under `KS` and only `KS` — including writes that arrived from somebody else — so a
   * departure owes an envelope for the whole retained history, not just the head. Reporting
   * the head alone left a leaver refused on a version they could not even see: their own
   * note, one edit ago.
   *
   * **Envelopes only.** The tag is an HMAC over the plaintext, and a superseded version is
   * not on disk; the schema asks for a tag exactly where the plaintext is.
   */
  history: string[];
};

/**
 * Everything in this vault still carrying the share — the set finalization must cover.
 *
 * A purpose-built listing rather than the trash, because they answer different questions.
 * The trash offers *what can be brought back*, so it shows only nodes that still have
 * versions and never shows folders at all; this offers *what must be converted*, which
 * includes both. Asking the first question in place of the second left a client unable to
 * finish — and unable to discover why, since the nodes blocking it were invisible to every
 * listing it had.
 *
 * The names come with it because the client has to re-encrypt them under `KV`, and for a
 * node it deleted long ago the only copy of the name is here.
 */
export const replicaOf = async (
  db: Db,
  userId: string,
  shareId: string,
): Promise<ReplicaNode[] | undefined> => {
  const member = await db.one<{ vaultId: string; vaultKeyId: string }>(
    `SELECT m.vault_id AS "vaultId", v.vault_key_id AS "vaultKeyId"
       FROM share_members m JOIN vaults v ON v.id = m.vault_id
      WHERE m.share_id = $1 AND m.user_id = $2 AND m.left_at IS NULL`,
    [shareId, userId],
  );
  if (!member?.vaultId) return undefined;

  const rows = await owedUnder(db, member.vaultId, shareId, member.vaultKeyId);
  return rows.map(({ needsMaterial, ...rest }) => ({ ...rest, needsVaultMaterial: needsMaterial }));
};

/** One marked node, and what it still owes under some scope. */
type OwedNode = Omit<ReplicaNode, 'needsVaultMaterial'> & { needsMaterial: boolean };

/**
 * Every marked node of a vault, and what each still owes under one scope key.
 *
 * **One query for both directions.** Preparing a share moves the interior from `KV` to `KS`
 * and leaving moves it back; the question each side has to answer is identical — which blobs
 * lack material under the scope being moved TO — and only the scope differs. Asked twice they
 * would drift, and the drift is invisible until somebody cannot leave a folder they shared.
 *
 * The names come with it because a node the client cannot see locally — one it deleted long
 * ago — has its only readable name here.
 */
const owedUnder = (db: Db, vaultId: string, shareId: string, scopeId: string): Promise<OwedNode[]> =>
  db.query<OwedNode>(
    `SELECT n.id AS "nodeId", encode(n.name_enc, 'base64') AS "nameEnc", n.name_key_id AS "nameKeyId",
            n.type::text AS type, (n.deleted_at IS NOT NULL) AS deleted,
            encode(n.sha256, 'hex') AS sha256,
            (n.sha256 IS NOT NULL
             AND NOT (EXISTS (SELECT 1 FROM blob_keys k
                               WHERE k.sha256 = n.sha256 AND k.scope_id = $3)
                      AND (n.deleted_at IS NOT NULL
                           OR EXISTS (SELECT 1 FROM dedup_index d
                                       WHERE d.sha256 = n.sha256 AND d.scope_id = $3))))
              AS "needsMaterial",
            COALESCE((SELECT array_agg(DISTINCT encode(ver.sha256, 'hex'))
                        FROM versions ver
                       WHERE ver.vault_id = n.vault_id AND ver.node_id = n.id
                         AND ver.sha256 IS DISTINCT FROM n.sha256
                         AND NOT EXISTS (SELECT 1 FROM blob_keys k
                                          WHERE k.sha256 = ver.sha256 AND k.scope_id = $3)),
                     ARRAY[]::text[]) AS history
       FROM nodes n
      WHERE n.vault_id = $1 AND n.share_id = $2 ORDER BY deleted, n.id`,
    [vaultId, shareId, scopeId],
  );

/**
 * What preparation still owes under `KS`, for a share being built.
 *
 * The mirror of `replicaOf`, and needed for the same reason: a node is not one blob. A folder
 * whose files were edited before it was shared carries versions keyed under `KV` alone, and
 * activation refuses until every one of them has a `KS` envelope — a set no listing the
 * client keeps would show, since its own tree holds only the head of each file.
 *
 * The root is excluded here as everywhere (SH-01): its name and content stay the initiator's.
 */
export const preparationOwed = async (
  db: Db,
  userId: string,
  shareId: string,
): Promise<OwedNode[] | undefined> => {
  const share = await db.one<{ vaultId: string; keyId: string; rootItemId: string }>(
    `SELECT initiator_vault_id AS "vaultId", subtree_key_id AS "keyId", root_item_id AS "rootItemId"
       FROM shares WHERE id = $1 AND initiator_id = $2 AND state = 'preparing'`,
    [shareId, userId],
  );
  if (!share) return undefined;

  const rows = await owedUnder(db, share.vaultId, shareId, share.keyId);
  const root = await db.one<{ id: string }>(
    `SELECT id FROM nodes WHERE vault_id = $1 AND share_item_id = $2`,
    [share.vaultId, share.rootItemId],
  );
  return rows.filter((n) => n.nodeId !== root?.id);
};
