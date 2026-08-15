-- SyncServer — database schema (PostgreSQL 16+).
--
-- Design notes live in the Obsidian vault: Projects/Obsidian/SyncServer/.
-- Normative reference: docs/03-data-model.md (and 04, 05, 06).
--
-- Two kinds of reference appear in these comments:
--   "#N"    — the numbered decision log, docs/09-decisions.md.
--   "SH-NN" / "AC-NN" — the sharing and account/vault scenario ledgers
--             (docs/12-sharing-scenarios.md; the vault registries by AC- id).
--
-- === Account/vault + E2EE-always ===
-- Two foundations:
--   * AN ACCOUNT HOLDS MANY VAULTS (AC-10). `users` is the account —
--     authentication and per-account quota; a `vaults` row is a sync unit under it,
--     carrying head_rev, reset_epoch and a key. A node is keyed by (vault_id, id).
--   * EVERYTHING IS E2EE (AC-08). The server stores only ciphertext and
--     reads neither content nor names. There is no enc_mode and no plaintext name;
--     a node carries name_enc and a keyed name_hmac the client computes.
-- Key derivation (AC-11): the seed is a STABLE RANDOM secret wrapped under a
-- passphrase-derived KEK (not derived from the passphrase — else a passphrase change
-- would re-encrypt everything). KV_vault = HKDF(seed, vault_id).

BEGIN;

-- ============================================================ enum types

CREATE TYPE node_type     AS ENUM ('file', 'folder');
CREATE TYPE journal_op    AS ENUM ('put', 'del', 'move');
-- No enc_mode: everything is E2EE (AC-08). No share_mode/share_role (SH-10) and no
-- assets_policy (SH-26).
-- 'preparing' = the initiator's client is producing the share-key form of each name.
--   It blocks INVITING, not writing (SH-Encrypted). In the old plaintext mode a share
--   was born 'active'; with E2EE always there is always a pass, so every share prepares.
-- 'ended'     = the initiator left (SH-17), or the last joined participant besides them
--               did (SH-07). Both are DEPARTURES: a share with one member that nobody
--               has left — preparing, awaiting an answer, after a decline — is alive.
CREATE TYPE share_state   AS ENUM ('preparing', 'active', 'cancelled', 'ended');
CREATE TYPE key_scope_kind AS ENUM ('vault', 'share');

CREATE TYPE user_role     AS ENUM ('user', 'admin');
-- 'tombstone' is the one reserved account: the identity account deletion (#55) reassigns
-- authorship to, so other people's history stays readable after its writer is gone. It
-- carries no key material, nobody can log into it, it owns nothing, and it is neither
-- deleted nor changed once it exists. Exactly one row may hold it.
CREATE TYPE user_state    AS ENUM ('provisioned', 'active', 'disabled', 'deleting', 'tombstone');
CREATE TYPE backup_status AS ENUM ('running', 'ok', 'failed');

-- ============================================================ KDF parameters

-- A new device must reproduce the KEK (and thence unwrap the seed) from the passphrase
-- alone, so these parameters are part of the protocol. Stored as jsonb because they are
-- versioned, but "versioned" is not "arbitrary": a row with {} or m = 1024 hands the
-- next device an impossible or weak derivation and nothing downstream would notice.
CREATE FUNCTION is_valid_kdf(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
    IF p IS NULL THEN
        RETURN false;
    END IF;
    -- coalesce, not a bare comparison: a MISSING key gives SQL NULL, jsonb_typeof(NULL)
    -- is NULL, and `<> 'number'` is then NULL rather than true, so a validator written to
    -- reject {} would PASS it. Found by the negative test.
    IF coalesce(jsonb_typeof(p->'v'), '') <> 'number'
       OR coalesce(jsonb_typeof(p->'m'), '') <> 'number'
       OR coalesce(jsonb_typeof(p->'t'), '') <> 'number'
       OR coalesce(jsonb_typeof(p->'p'), '') <> 'number' THEN
        RETURN false;
    END IF;
    RETURN (p->>'v')::numeric = 19
       AND (p->>'v')::numeric = trunc((p->>'v')::numeric)
       AND (p->>'m')::numeric = trunc((p->>'m')::numeric)
       AND (p->>'t')::numeric = trunc((p->>'t')::numeric)
       AND (p->>'p')::numeric = trunc((p->>'p')::numeric)
       AND (p->>'m')::numeric >= 65536      -- KiB, i.e. 64 MiB
       AND (p->>'t')::numeric >= 3
       AND (p->>'p')::numeric >= 1;
END;
$$;

-- ============================================================ server identity

-- One row. restore_epoch is bumped every time this database is restored from a backup,
-- and it travels inside the opaque delta cursor. It is SERVER-WIDE (a backup is the
-- whole DB); per-vault "my client is the source of truth" resets use vaults.reset_epoch.
CREATE TABLE server_meta (
    only_row      boolean PRIMARY KEY DEFAULT true CHECK (only_row),
    restore_epoch integer NOT NULL DEFAULT 1 CHECK (restore_epoch > 0),
    restored_at   timestamptz
);

INSERT INTO server_meta DEFAULT VALUES;

-- An epoch may only ever go UP. Lowering one silently makes stale cursors look current
-- again — the exact failure the epoch exists to prevent. Shared by server_meta and
-- vaults; the column differs, so the trigger picks it by table.
CREATE FUNCTION epoch_only_increases() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    old_v integer;
    new_v integer;
BEGIN
    IF TG_TABLE_NAME = 'server_meta' THEN
        old_v := OLD.restore_epoch; new_v := NEW.restore_epoch;
    ELSE
        old_v := OLD.reset_epoch;   new_v := NEW.reset_epoch;   -- vaults
    END IF;

    IF new_v < old_v THEN
        RAISE EXCEPTION 'epoch may not decrease (% -> %)', old_v, new_v
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER server_meta_epoch_forward
    BEFORE UPDATE OF restore_epoch ON server_meta
    FOR EACH ROW EXECUTE FUNCTION epoch_only_increases();

CREATE FUNCTION server_meta_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'server_meta cannot be deleted or replaced'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER server_meta_is_not_replaceable
    BEFORE DELETE ON server_meta FOR EACH ROW EXECUTE FUNCTION server_meta_reject_delete();

-- ============================================================ users (the account)

-- A user is an ACCOUNT, not a vault (AC-10): authentication, role, state and the
-- per-account quota. Vaults live in their own table; head_rev/reset_epoch/enc_mode are
-- gone from here.
CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login        text        NOT NULL,
    -- NOT pwd_hash: the passphrase never reaches the server. auth_secret = HKDF(seed,
    -- "auth"); the column is named for what it holds so future code is never nudged
    -- into posting the passphrase.
    auth_secret_hash text,
    account_salt bytea       CHECK (account_salt IS NULL OR octet_length(account_salt) = 16),
    kdf_params   jsonb       CHECK (kdf_params IS NULL OR is_valid_kdf(kdf_params)),
    -- The account master secret: a random seed WRAPPED under the passphrase-derived KEK
    -- (AC-11). It is not derived from the passphrase — otherwise a passphrase change
    -- would move every vault key and re-encrypt everything. Changing the passphrase
    -- only re-wraps this.
    wrapped_seed bytea,
    -- The account identity keypair: it receives someone else's share key. An invitation is
    -- issued to a PERSON, before it is known which of their vaults they accept it in
    -- (AC-Q4), so the keypair is on the account, not a vault. The private half is sealed
    -- under an account key from the seed.
    pubkey       bytea,
    enc_privkey  bytea,
    recovery_key bytea,                          -- the seed wrapped under the recovery code
    recovery_code_hash text,

    role         user_role   NOT NULL DEFAULT 'user',
    state        user_state  NOT NULL DEFAULT 'provisioned',
    invite_token_hash text,
    invite_expires_at timestamptz,
    quota_bytes  bigint      NOT NULL CHECK (quota_bytes > 0),   -- per account (AC-Q2)
    -- Over quota (SH-20). Quota is per ACCOUNT, so the freeze is too: it covers every
    -- vault the account owns and every share it participates in, all at once. Frozen
    -- means nothing may be sent that grows usage; reading and deleting stay available,
    -- because deleting is the only way out.
    frozen_at    timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- An account is an unclaimed invitation, the reserved tombstone, or a fully keyed
    -- account. No half-initialised middle.
    CONSTRAINT keys_match_state CHECK (
        (state = 'provisioned'
            AND auth_secret_hash IS NULL AND pubkey IS NULL AND wrapped_seed IS NULL
            AND invite_token_hash IS NOT NULL AND invite_expires_at IS NOT NULL)
        OR
        -- The tombstone holds NOTHING: no keys to steal, no token to redeem, no way in.
        (state = 'tombstone'
            AND auth_secret_hash IS NULL AND account_salt IS NULL AND kdf_params IS NULL
            AND pubkey IS NULL AND enc_privkey IS NULL AND recovery_key IS NULL
            AND recovery_code_hash IS NULL AND wrapped_seed IS NULL
            AND invite_token_hash IS NULL AND invite_expires_at IS NULL
            AND frozen_at IS NULL)
        OR
        (state NOT IN ('provisioned', 'tombstone')
            AND auth_secret_hash IS NOT NULL AND account_salt IS NOT NULL
            AND kdf_params IS NOT NULL AND pubkey IS NOT NULL
            AND enc_privkey IS NOT NULL AND recovery_key IS NOT NULL
            AND recovery_code_hash IS NOT NULL
            AND wrapped_seed IS NOT NULL
            AND invite_token_hash IS NULL AND invite_expires_at IS NULL))
);

CREATE UNIQUE INDEX users_login_key ON users (lower(login));

-- Exactly one tombstone. Two would split anonymised authorship between them for no reason,
-- and "which one is the real one" is a question nobody should ever have to answer.
CREATE UNIQUE INDEX users_single_tombstone ON users ((state)) WHERE state = 'tombstone';

-- Locking yourself out of your own server is a one-keystroke mistake, so the last
-- usable administrator cannot be demoted, disabled, put into deletion — or DELETEd (#88).
CREATE FUNCTION users_keep_one_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.role <> 'admin' OR OLD.state <> 'active' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.state = 'active' THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM users
                    WHERE id <> OLD.id AND role = 'admin' AND state = 'active') THEN
        RAISE EXCEPTION 'refusing to remove the last active administrator'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER users_last_admin_stays
    BEFORE UPDATE OF role, state OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION users_keep_one_admin();

-- Deleting an account is a PROCEDURE, not a statement (#55): end its shares, clear the
-- share marks from every replica, reassign authorship to a tombstone so other people's
-- history stays readable. The STATE can be enforced: an account that ever held data must
-- pass through 'deleting' first. An unclaimed invitation is exempt.
CREATE FUNCTION users_reject_undeclared_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- The tombstone has its own rule and its own reason; let that one speak, or this
    -- trigger (which fires first) would answer "enter state deleting" for a row that
    -- must never be deleted at all.
    IF OLD.state = 'tombstone' THEN
        RETURN OLD;
    END IF;
    IF OLD.state NOT IN ('provisioned', 'deleting') THEN
        RAISE EXCEPTION 'account % is %; it must enter state deleting before it can be removed',
            OLD.login, OLD.state USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER users_delete_follows_the_procedure
    BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION users_reject_undeclared_delete();

-- Once the tombstone exists it never changes and never goes away. It is the only thing
-- standing between "this account was deleted" and a history full of dangling authorship,
-- and versions.author_id points at it with RESTRICT — so a delete would fail anyway, at a
-- foreign key, with a message about nothing in particular. This says why instead.
CREATE FUNCTION users_keep_the_tombstone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state = 'tombstone' THEN
        RAISE EXCEPTION 'the tombstone account is permanent: it cannot be % ',
            CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'changed' END
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER users_tombstone_is_permanent
    BEFORE UPDATE OF state, login, role OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION users_keep_the_tombstone();

-- ============================================================ vaults

-- A sync unit under an account (AC-10). head_rev is this vault's cursor position;
-- reset_epoch bumps on a per-vault "my client is the source of truth" reset (AC-14).
-- vault_key_id names the scope key blob_keys.scope_id points at for own content, with
-- KV = HKDF(seed, id) (AC-11) — so two vaults of one account never dedup against each
-- other (AC-09). The label name_enc is itself ciphertext (E2EE): a login lists vaults by
-- (id, name_enc), and the client derives KV from the id to read the label.
CREATE TABLE key_scopes (
    id         uuid           NOT NULL DEFAULT gen_random_uuid(),
    kind       key_scope_kind NOT NULL,
    created_at timestamptz    NOT NULL DEFAULT now(),

    PRIMARY KEY (id),
    UNIQUE (id, kind)
);

CREATE TABLE vaults (
    id           uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    root_node_id uuid NOT NULL,
    name_enc     bytea,                          -- encrypted label; NULL only transiently at creation
    vault_key_id uuid NOT NULL,
    vault_key_scope_kind key_scope_kind NOT NULL DEFAULT 'vault' CHECK (vault_key_scope_kind = 'vault'),
    head_rev     bigint      NOT NULL DEFAULT 0 CHECK (head_rev >= 0),
    reset_epoch  integer     NOT NULL DEFAULT 1 CHECK (reset_epoch > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (id),
    -- Lets shares and share_members pin a vault to its owner with a composite FK.
    UNIQUE (user_id, id),
    FOREIGN KEY (vault_key_id, vault_key_scope_kind) REFERENCES key_scopes (id, kind)
);

CREATE INDEX vaults_user ON vaults (user_id);

CREATE TRIGGER vaults_reset_epoch_forward
    BEFORE UPDATE OF reset_epoch ON vaults
    FOR EACH ROW EXECUTE FUNCTION epoch_only_increases();

-- ============================================================ admin audit + backups

-- Administrative actions on other people's accounts. Append-only (#87), and deliberately
-- free of foreign keys (#93): the logins are snapshots, so the record survives — and
-- keeps naming — an account later renamed or deleted.
CREATE TABLE audit_log (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at             timestamptz NOT NULL DEFAULT now(),
    actor_user_id  uuid,
    actor_login    text  NOT NULL CHECK (actor_login <> ''),
    action         text  NOT NULL CHECK (action <> ''),
    target_user_id uuid,
    target_login   text,
    details        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_target ON audit_log (target_user_id, at DESC);
CREATE INDEX audit_log_at     ON audit_log (at DESC);

-- Backup history. A backup is TWO stores captured as ONE frozen window (#95): writes are
-- frozen, both legs run inside the freeze, writes are released. CHECKs reject a leg
-- outside the window.
CREATE TABLE backup_runs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    writes_frozen_at timestamptz,
    writes_thawed_at timestamptz,
    blobs_done_at    timestamptz,
    db_done_at       timestamptz,
    status       backup_status NOT NULL DEFAULT 'running',
    bytes        bigint CHECK (bytes IS NULL OR bytes >= 0),
    blob_count   bigint CHECK (blob_count IS NULL OR blob_count >= 0),
    destination  text,
    error        text,
    verified_at  timestamptz,
    triggered_by uuid REFERENCES users ON DELETE SET NULL,

    CONSTRAINT finished_has_status CHECK (
        finished_at IS NULL OR status <> 'running'),
    CONSTRAINT ok_implies_a_closed_freeze CHECK (
        status <> 'ok' OR (writes_frozen_at IS NOT NULL AND blobs_done_at IS NOT NULL
                       AND db_done_at IS NOT NULL AND writes_thawed_at IS NOT NULL
                       AND finished_at IS NOT NULL)),
    CONSTRAINT legs_inside_the_freeze CHECK (
        (blobs_done_at IS NULL OR (writes_frozen_at IS NOT NULL
                                   AND blobs_done_at >= writes_frozen_at))
    AND (db_done_at IS NULL    OR (writes_frozen_at IS NOT NULL
                                   AND db_done_at >= writes_frozen_at))
    AND (writes_thawed_at IS NULL OR (
            writes_frozen_at IS NOT NULL
        AND writes_thawed_at >= writes_frozen_at
        AND (blobs_done_at IS NULL OR blobs_done_at <= writes_thawed_at)
        AND (db_done_at    IS NULL OR db_done_at    <= writes_thawed_at)))),
    CONSTRAINT failure_is_explained CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX backup_runs_at ON backup_runs (started_at DESC);

-- A device belongs to the ACCOUNT, not a vault (AC-13): it may reach any of the
-- account's vaults, and which it syncs is a client choice — there is no device x vault
-- table. The stored cursor is diagnostics only; the client owns the authoritative one.
CREATE TABLE devices (
    id           uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    name         text NOT NULL,
    platform     text NOT NULL,
    last_cursor  text,
    last_seen_at timestamptz,
    refresh_token_hash text,                     -- one per device, so "sign out this device" works (#90)
    revoked_at   timestamptz
);

CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE device_pairings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pairing_token_hash text NOT NULL UNIQUE,
    device_pubkey      bytea NOT NULL,             -- new device's ephemeral X25519 public key
    approved_user_id   uuid REFERENCES users ON DELETE CASCADE,
    approved_at        timestamptz,
    seed_envelope      bytea,                      -- seed sealed to device_pubkey by the approving device
    claimed_device_id  uuid UNIQUE REFERENCES devices ON DELETE SET NULL,
    claimed_at         timestamptz,
    expires_at         timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pairing_approval_fields_together CHECK (
        (approved_user_id IS NULL) = (approved_at IS NULL)
        AND (approved_user_id IS NULL) = (seed_envelope IS NULL)),
    CONSTRAINT pairing_claim_fields_together CHECK ((claimed_device_id IS NULL) = (claimed_at IS NULL)),
    CONSTRAINT pairing_claim_requires_approval CHECK (claimed_device_id IS NULL OR approved_user_id IS NOT NULL),
    CONSTRAINT pairing_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE FUNCTION device_pairings_check_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.expires_at <= now() THEN
        RAISE EXCEPTION 'device pairing % is expired', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.approved_user_id IS DISTINCT FROM OLD.approved_user_id
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
        OR NEW.seed_envelope IS DISTINCT FROM OLD.seed_envelope)
       AND OLD.approved_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'device pairing % is already approved', NEW.id USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.approved_user_id IS NOT NULL
       AND NEW.device_pubkey IS DISTINCT FROM OLD.device_pubkey THEN
        RAISE EXCEPTION 'device pairing % public key is immutable after approval', NEW.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.claimed_device_id IS DISTINCT FROM OLD.claimed_device_id
        OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at)
       AND OLD.claimed_device_id IS NOT NULL THEN
        RAISE EXCEPTION 'device pairing % is already claimed', NEW.id USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.claimed_device_id IS NOT NULL AND NEW.approved_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM devices
         WHERE id = NEW.claimed_device_id AND user_id = NEW.approved_user_id
    ) THEN
        RAISE EXCEPTION 'device pairing % must be claimed by a device of its approved user', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER device_pairings_lifecycle
    BEFORE INSERT OR UPDATE OF device_pubkey, approved_user_id, approved_at, seed_envelope,
                              claimed_device_id, claimed_at, expires_at
    ON device_pairings FOR EACH ROW EXECUTE FUNCTION device_pairings_check_lifecycle();

-- ============================================================ content

-- Blobs are immutable and addressed by the hash of WHAT IS STORED — always
-- header‖ciphertext, because there is no plaintext mode (AC-08), so enc_alg/key_id are
-- never null. The content key AND nonce are RANDOM, so encrypting the same file twice
-- yields two addresses; convergence is dedup_index's job. Nothing is derived from the
-- plaintext: content is guessable, and a guessable key is no key.
CREATE TABLE blobs (
    sha256       bytea PRIMARY KEY CHECK (octet_length(sha256) = 32),
    size         bigint      NOT NULL CHECK (size >= 0),
    storage_key  text        NOT NULL UNIQUE,
    enc_alg      text        NOT NULL,
    key_id       uuid        NOT NULL,           -- which content key the ciphertext is under
    refcount     integer     NOT NULL DEFAULT 0 CHECK (refcount >= 0),
    gc_marked_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX blobs_gc ON blobs (gc_marked_at) WHERE gc_marked_at IS NOT NULL;

-- The address IS the content, so a blob's identity never changes (#19). refcount and
-- gc_marked_at are the collector's bookkeeping, outside the rule.
CREATE FUNCTION blobs_reject_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.size IS DISTINCT FROM OLD.size
       OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
       OR NEW.enc_alg IS DISTINCT FROM OLD.enc_alg
       OR NEW.key_id IS DISTINCT FROM OLD.key_id THEN
        RAISE EXCEPTION 'blob identity is immutable; create a new blob instead'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER blobs_identity_immutable
    BEFORE UPDATE OF sha256, size, storage_key, enc_alg, key_id ON blobs
    FOR EACH ROW EXECUTE FUNCTION blobs_reject_identity_change();

-- A blob is encrypted with its own RANDOM content key; that key is stored WRAPPED, once
-- per scope that may read it — a vault key, or the subtree key of every share it is
-- visible in. Rows are NEVER deleted on their own, only by cascade when the blob dies.
CREATE TABLE blob_keys (
    sha256      bytea NOT NULL REFERENCES blobs ON DELETE CASCADE,
    scope_id    uuid  NOT NULL REFERENCES key_scopes ON DELETE RESTRICT,
    wrapped_key bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (sha256, scope_id)
);

CREATE INDEX blob_keys_by_scope ON blob_keys (scope_id);

-- Deduplication. The content key is RANDOM, so identical content does not converge on
-- one address by itself; this index converges it, per scope. Two vaults of one account
-- have different scope keys, so they do not dedup against each other (AC-09). Reading it
-- is an oracle, so queries carry the same authorisation as a blob read (#65).
CREATE TABLE dedup_index (
    scope_id    uuid  NOT NULL REFERENCES key_scopes ON DELETE RESTRICT,
    content_tag bytea NOT NULL CHECK (octet_length(content_tag) = 32),  -- HMAC(scope key, sha256(plaintext))
    sha256      bytea NOT NULL REFERENCES blobs ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (scope_id, content_tag)
);

CREATE INDEX dedup_index_by_blob ON dedup_index (sha256);

-- Quota accounting, PER ACCOUNT across all its vaults (AC-Q2). One set per account
-- covering own nodes and own history. Quota = SUM(size) over these rows. Because keys
-- are per vault, the same file in two vaults is two blobs counted twice (AC-09).
CREATE TABLE user_blobs (
    user_id           uuid        NOT NULL REFERENCES users ON DELETE CASCADE,
    sha256            bytea       NOT NULL REFERENCES blobs ON DELETE RESTRICT,
    refs_own          integer     NOT NULL DEFAULT 0 CHECK (refs_own     >= 0),
    refs_pending      integer     NOT NULL DEFAULT 0 CHECK (refs_pending >= 0),
    pending_since     timestamptz,
    pending_device_id uuid        REFERENCES devices ON DELETE SET NULL,

    PRIMARY KEY (user_id, sha256),
    CONSTRAINT row_must_be_referenced CHECK (refs_own + refs_pending > 0),
    CONSTRAINT pending_fields_travel_together CHECK (
        (refs_pending > 0) = (pending_since IS NOT NULL))
);

CREATE INDEX user_blobs_by_blob ON user_blobs (sha256);
CREATE INDEX user_blobs_pending ON user_blobs (pending_since) WHERE refs_pending > 0;

-- ============================================================ vault tree

-- A node is keyed by (vault_id, id) (AC-10, composite PK). parent_id NULL marks the
-- vault root — one per vault. Names live here as CIPHERTEXT only (AC-08): there is no
-- plaintext `name`. name_hmac = HMAC(scope key, casefold(NFC(name))) is computed by the
-- CLIENT; the server never sees a name, so it cannot verify the hash — sibling
-- uniqueness is an index over the hash and the client is trusted to compute it. Every
-- name rule (is_valid_name, forbidden characters, NFC) is therefore CLIENT-side.
-- name_key_id says whether the name is under the vault key KV or a share key KS.
CREATE TABLE nodes (
    vault_id   uuid        NOT NULL REFERENCES vaults ON DELETE CASCADE,
    id         uuid        NOT NULL DEFAULT gen_random_uuid(),
    parent_id  uuid,
    name_enc   bytea,
    name_hmac  bytea,
    name_key_id uuid,
    type       node_type   NOT NULL,
    sha256     bytea       REFERENCES blobs ON DELETE RESTRICT,
    size       bigint      CHECK (size IS NULL OR size >= 0),
    mtime      timestamptz NOT NULL,
    rev        bigint      NOT NULL,
    deleted_at timestamptz,
    -- STRICT ancestors, root first, own id NOT included: ancestry = parent.ancestry
    -- || parent_id, and the vault root carries '{}'. "everything strictly under X" is
    -- ancestry @> ARRAY[X]; "X itself or under it" is id = X OR ancestry @> ARRAY[X].
    ancestry   uuid[]      NOT NULL DEFAULT '{}',

    -- A node that belongs to a replica of a shared folder (SH-02). share_item_id is the
    -- shared identity — equal across every participant's copy, in whichever vault they
    -- accepted the invitation in (AC-Q4). The FK to shares is added by ALTER below
    -- (circular reference).
    share_id      uuid,
    share_item_id uuid,

    PRIMARY KEY (vault_id, id),
    -- RESTRICT, not CASCADE: an orphaned branch is worse than a failed delete. GC removes
    -- dead nodes BOTTOM-UP. The parent is pinned to the SAME vault by the composite FK.
    FOREIGN KEY (vault_id, parent_id) REFERENCES nodes (vault_id, id) ON DELETE RESTRICT,

    -- The root is the one node with no name, so "must have a name" exempts it.
    CONSTRAINT has_a_name CHECK (parent_id IS NULL OR name_enc IS NOT NULL),
    CONSTRAINT root_has_no_name CHECK (parent_id IS NOT NULL OR name_enc IS NULL),
    -- A non-root node carries a keyed name_hmac (32 bytes). The root has none.
    CONSTRAINT name_hmac_present CHECK (
        (parent_id IS NULL AND name_hmac IS NULL)
        OR (parent_id IS NOT NULL AND name_hmac IS NOT NULL AND octet_length(name_hmac) = 32)),
    CONSTRAINT folders_have_no_content CHECK (
        type <> 'folder' OR (sha256 IS NULL AND size IS NULL)),
    CONSTRAINT live_files_have_content CHECK (
        type <> 'file' OR deleted_at IS NOT NULL OR (sha256 IS NOT NULL AND size IS NOT NULL)),
    CONSTRAINT node_is_not_its_own_parent CHECK (parent_id <> id),
    CONSTRAINT share_pair_travels_together CHECK (
        (share_id IS NULL) = (share_item_id IS NULL))
);

-- One node per participant per shared item, keyed by the replica's vault (AC-Q4): given
-- a written node, its counterparts are the rows sharing (share_id, share_item_id) in
-- other vaults.
CREATE UNIQUE INDEX nodes_one_replica_per_item
    ON nodes (share_id, share_item_id, vault_id)
    WHERE share_id IS NOT NULL;

CREATE INDEX nodes_by_share_item ON nodes (share_id, share_item_id)
    WHERE share_id IS NOT NULL;

CREATE INDEX nodes_by_share ON nodes (share_id) WHERE share_id IS NOT NULL;

-- One root per vault.
CREATE UNIQUE INDEX nodes_single_root ON nodes (vault_id) WHERE parent_id IS NULL;

-- Sibling names unique among LIVE nodes only, within a parent. name_hmac is
-- client-supplied and unverifiable (E2EE), so this enforces uniqueness over a hash the
-- server cannot see; a lying client corrupts only its own vault's listing.
CREATE UNIQUE INDEX nodes_unique_sibling
    ON nodes (vault_id, parent_id, name_hmac) WHERE deleted_at IS NULL;

CREATE INDEX nodes_children  ON nodes (parent_id);
CREATE INDEX nodes_ancestry  ON nodes USING gin (ancestry);
CREATE INDEX nodes_by_blob   ON nodes (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX nodes_trash     ON nodes (vault_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- The FK is deferred because a transaction may create the vault before its root node.
ALTER TABLE vaults
    ADD CONSTRAINT vaults_root_node_fkey
    FOREIGN KEY (id, root_node_id) REFERENCES nodes (vault_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION vaults_check_root() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid;
    expected_root uuid;
    actual_root uuid;
BEGIN
    IF TG_TABLE_NAME = 'vaults' THEN
        v_id := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        v_id := OLD.vault_id;
    ELSE
        v_id := NEW.vault_id;
    END IF;
    SELECT root_node_id INTO expected_root FROM vaults WHERE id = v_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT id INTO actual_root FROM nodes WHERE vault_id = v_id AND parent_id IS NULL;
    IF actual_root IS NULL OR actual_root IS DISTINCT FROM expected_root THEN
        RAISE EXCEPTION 'vault % must have exactly one linked root node', v_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER vaults_root_is_exactly_one_node
    AFTER INSERT OR UPDATE ON vaults DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION vaults_check_root();

CREATE CONSTRAINT TRIGGER nodes_keep_vault_root_linked
    AFTER INSERT OR UPDATE OR DELETE ON nodes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION vaults_check_root();

-- A vault is deleted only after its contents have been explicitly cleaned up.  CASCADE
-- here would make a mistaken DELETE erase a whole sync unit, including its history.
CREATE FUNCTION vaults_reject_nonempty_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM nodes WHERE vault_id = OLD.id) THEN
        RAISE EXCEPTION 'vault % is not empty; explicitly clean up its data before deleting it', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER vaults_delete_requires_explicit_cleanup
    BEFORE DELETE ON vaults FOR EACH ROW EXECUTE FUNCTION vaults_reject_nonempty_delete();

-- A node may not be moved under its own descendant.
CREATE FUNCTION nodes_reject_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL
       AND NEW.id = ANY (SELECT unnest(ancestry) FROM nodes
                          WHERE vault_id = NEW.vault_id AND id = NEW.parent_id) THEN
        RAISE EXCEPTION 'node % cannot be moved under its own descendant', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_no_cycles
    BEFORE INSERT OR UPDATE OF parent_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_reject_cycle();

-- A file never becomes a folder and vice versa (#102): no operation does it, and every
-- rule that reads `type` assumes it.
CREATE FUNCTION nodes_reject_type_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.type <> OLD.type THEN
        RAISE EXCEPTION 'node % cannot change type (% -> %)', OLD.id, OLD.type, NEW.type
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_type_immutable
    BEFORE UPDATE OF type ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_reject_type_change();

-- ancestry is security-critical (subtree ACL, share-boundary, no-nesting all read it),
-- so the schema checks it. DEFERRED: a move rewrites the whole subtree in the
-- application, passing through inconsistent states; only the state at COMMIT must be
-- consistent. A deferred check may not trust NEW — it holds the row as queued, not as it
-- stands at commit — so it re-reads the row.
CREATE FUNCTION nodes_check_ancestry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    cur      nodes%ROWTYPE;
    expected uuid[];
    stale    uuid;
BEGIN
    SELECT * INTO cur FROM nodes WHERE vault_id = NEW.vault_id AND id = NEW.id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF cur.parent_id IS NULL THEN
        expected := '{}'::uuid[];
    ELSE
        SELECT p.ancestry || cur.parent_id INTO expected
          FROM nodes p WHERE p.vault_id = cur.vault_id AND p.id = cur.parent_id;
    END IF;

    IF cur.ancestry IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'node % carries ancestry %, but its parent chain is %',
            cur.id, cur.ancestry, expected USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        RETURN NULL;
    END IF;

    SELECT c.id INTO stale
      FROM nodes c
     WHERE c.vault_id = cur.vault_id AND c.parent_id = cur.id
       AND c.ancestry IS DISTINCT FROM cur.ancestry || cur.id
     LIMIT 1;

    IF stale IS NOT NULL THEN
        RAISE EXCEPTION 'child % kept a stale ancestry after % changed place; the subtree rewrite is missing',
            stale, cur.id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER nodes_ancestry_matches_parents
    AFTER INSERT OR UPDATE OF parent_id, ancestry ON nodes
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION nodes_check_ancestry();

-- Version history (#14). Keyed by node, so a rename touches nothing here. Carries
-- vault_id for the composite FK to nodes.
CREATE TABLE versions (
    vault_id  uuid        NOT NULL,
    node_id   uuid        NOT NULL,
    rev       bigint      NOT NULL,
    sha256    bytea       NOT NULL REFERENCES blobs ON DELETE RESTRICT,
    size      bigint      NOT NULL CHECK (size >= 0),
    at        timestamptz NOT NULL DEFAULT now(),
    -- ≠ the vault owner when a share member wrote it (SH-19). RESTRICT: a CASCADE would
    -- erase somebody else's history; account deletion reassigns author_id to a tombstone.
    author_id uuid        NOT NULL REFERENCES users ON DELETE RESTRICT,

    PRIMARY KEY (vault_id, node_id, rev),
    FOREIGN KEY (vault_id, node_id) REFERENCES nodes (vault_id, id) ON DELETE CASCADE
);

CREATE INDEX versions_by_blob ON versions (sha256);
CREATE INDEX versions_by_age  ON versions (at);

-- Delta log (#2), PER VAULT (AC-12). Append-only, 90-day TTL, never used to serve
-- history. node_id has no FK — the log outlives the node.
CREATE TABLE journal (
    vault_id       uuid        NOT NULL REFERENCES vaults ON DELETE CASCADE,
    rev            bigint      NOT NULL,
    node_id        uuid        NOT NULL,
    prev_parent_id uuid,
    op             journal_op  NOT NULL,
    node_rev       bigint,
    at             timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (vault_id, rev),
    CONSTRAINT move_carries_prev_parent CHECK ((op = 'move') = (prev_parent_id IS NOT NULL)),
    CONSTRAINT put_carries_node_rev     CHECK (op <> 'put' OR node_rev IS NOT NULL)
);

CREATE INDEX journal_by_age ON journal (at);

-- ============================================================ sharing
--
-- REPLICATION, not mounting (#104). Every participant holds their own copy as ordinary
-- nodes in the vault THEY ACCEPTED IN (SH-02, AC-Q4); a write fans out to the corresponding node
-- of every other participant (SH-11). The server never serves one user's node to another.

CREATE TABLE shares (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- "initiator", not "owner": every participant owns their own copy.
    initiator_id    uuid        NOT NULL REFERENCES users ON DELETE CASCADE,
    -- Which of the initiator's vaults the shared folder lives in, and the node within it.
    initiator_vault_id uuid     NOT NULL,
    subtree_node_id uuid        NOT NULL,
    state           share_state NOT NULL DEFAULT 'preparing',
    root_item_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
    -- The share key: a TRANSPORT key, not a storage scope (SH-Encrypted). The initiator's
    -- own names stay under their vault key for the life of the share and after (SH-01, SH-25).
    subtree_key_id  uuid,
    subtree_key_scope_kind key_scope_kind CHECK (subtree_key_scope_kind = 'share'),
    wrapped_key_initiator bytea,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One timestamp for both terminal states: a share that was cancelled before any
    -- participant joined, and one that ended after a life. Named terminal_at, not
    -- ended_at, so the column does not claim only 'ended' may carry it.
    terminal_at      timestamptz,

    CONSTRAINT key_pairs_with_scope CHECK (
        (subtree_key_id IS NULL) = (wrapped_key_initiator IS NULL)
        AND (subtree_key_id IS NULL) = (subtree_key_scope_kind IS NULL)),
    CONSTRAINT terminal_state_carries_a_time CHECK ((state IN ('cancelled', 'ended')) = (terminal_at IS NOT NULL)),

    -- One LIVE share per folder — see the partial index below, which is where that rule
    -- lives. It cannot be a table constraint: a plain UNIQUE would hold a folder's slot for
    -- ever, and re-sharing is not merely allowed but specified (SH-08).
    FOREIGN KEY (initiator_id, initiator_vault_id) REFERENCES vaults (user_id, id),
    FOREIGN KEY (initiator_vault_id, subtree_node_id) REFERENCES nodes (vault_id, id),
    FOREIGN KEY (subtree_key_id, subtree_key_scope_kind) REFERENCES key_scopes (id, kind)
);

CREATE INDEX shares_initiator ON shares (initiator_id);

-- One share per folder **at a time**, not for ever.
--
-- A plain UNIQUE kept the slot after the share was over, so a folder that had once been
-- shared could never be shared again — while SH-08 says re-sharing starts from scratch, a
-- new share with no reference of any kind to the old one. Found by sharing a folder,
-- leaving, and trying again: `duplicate key value violates unique constraint`, on a share
-- everybody had already left.
--
-- Terminal rows stay, and must: participants keep their copies and their history, and an
-- offline device still has to learn the share ended.
CREATE UNIQUE INDEX shares_one_live_per_folder
    ON shares (initiator_vault_id, subtree_node_id)
    WHERE state IN ('preparing', 'active');

-- The other half of the circular reference. RESTRICT: CASCADE would delete participants'
-- files when a share ends (the one thing the design promises never to do, SH-05); SET
-- NULL would clear share_id and leave share_item_id — half a pair. So ending a share must
-- explicitly unmark the replicas first, and RESTRICT makes that step unskippable.
ALTER TABLE nodes
    ADD CONSTRAINT nodes_share_fkey FOREIGN KEY (share_id) REFERENCES shares ON DELETE RESTRICT;

CREATE TABLE share_members (
    share_id    uuid       NOT NULL REFERENCES shares ON DELETE CASCADE,
    user_id     uuid       NOT NULL REFERENCES users  ON DELETE CASCADE,
    -- The vault the participant ACCEPTED IN, where their replica lives (AC-Q4). NULL
    -- before they join; set on joining from the vault their client runs in, never from an
    -- answer they had to give — a plugin instance can only reach its own vault. No role
    -- column (SH-10).
    vault_id    uuid,
    invited_at  timestamptz NOT NULL DEFAULT now(),
    joined_at   timestamptz,
    -- Set by leave/revoke/end to stop propagation immediately.  The affected member
    -- then completes the KV metadata pass before left_at records detachment.
    finalization_started_at timestamptz,
    left_at     timestamptz,
    -- No freeze column here: over quota is an ACCOUNT state (users.frozen_at, SH-20),
    -- because the quota it reflects is per account. And no key epoch: the share key is
    -- never rotated (#10), so there is no generation to name.
    wrapped_key bytea,                            -- HPKE envelope carrying the share key

    PRIMARY KEY (share_id, user_id),
    -- The chosen vault must belong to the participant.
    FOREIGN KEY (user_id, vault_id) REFERENCES vaults (user_id, id),

    CONSTRAINT joined_picks_a_vault CHECK (joined_at IS NULL OR vault_id IS NOT NULL),
    CONSTRAINT left_after_join      CHECK (left_at IS NULL OR joined_at IS NOT NULL),
    CONSTRAINT finalization_after_join CHECK (finalization_started_at IS NULL OR joined_at IS NOT NULL),
    CONSTRAINT leaving_requires_finalization CHECK (left_at IS NULL OR finalization_started_at IS NOT NULL)
);

CREATE INDEX share_members_user ON share_members (user_id);

CREATE INDEX share_members_live
    ON share_members (share_id, user_id)
    WHERE joined_at IS NOT NULL AND finalization_started_at IS NULL AND left_at IS NULL;

-- A share is rooted at a LIVE FOLDER of the initiator's own vault (SH-01), and no share
-- nesting. The composite FK pins the root to the initiator's vault; these checks add
-- "is a folder", "is alive", and "not already/inside a share".
CREATE FUNCTION shares_check_root() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    root_type    node_type;
    root_deleted timestamptz;
    root_share   uuid;
    root_anc     uuid[];
BEGIN
    SELECT type, deleted_at, share_id, ancestry
      INTO root_type, root_deleted, root_share, root_anc
      FROM nodes WHERE vault_id = NEW.initiator_vault_id AND id = NEW.subtree_node_id;

    IF root_type <> 'folder' THEN
        RAISE EXCEPTION 'a share must be rooted at a folder, not a %', root_type
            USING ERRCODE = 'check_violation';
    END IF;

    IF root_deleted IS NOT NULL THEN
        RAISE EXCEPTION 'node % is deleted and cannot be shared', NEW.subtree_node_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF root_share IS NOT NULL THEN
        RAISE EXCEPTION 'node % is already part of share %; a replica cannot be re-shared',
            NEW.subtree_node_id, root_share USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM nodes
                WHERE vault_id = NEW.initiator_vault_id
                  AND id = ANY (root_anc)
                  AND share_id IS NOT NULL) THEN
        RAISE EXCEPTION 'node % sits inside a shared folder and cannot be shared separately',
            NEW.subtree_node_id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER shares_root_is_a_live_folder
    BEFORE INSERT OR UPDATE OF subtree_node_id, initiator_vault_id, initiator_id ON shares
    FOR EACH ROW EXECUTE FUNCTION shares_check_root();

-- The initiator and their source vault identify a share for its full lifetime.  Moving
-- either would sever the meaning of existing replicas and key envelopes.
CREATE FUNCTION shares_reject_initiator_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.initiator_id IS DISTINCT FROM OLD.initiator_id
       OR NEW.initiator_vault_id IS DISTINCT FROM OLD.initiator_vault_id THEN
        RAISE EXCEPTION 'share % initiator and initiator vault are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER shares_initiator_is_immutable
    BEFORE UPDATE OF initiator_id, initiator_vault_id ON shares
    FOR EACH ROW EXECUTE FUNCTION shares_reject_initiator_change();

-- An 'active' e2ee share must carry a key, and a share that carries one must have no
-- joined participant without an envelope. Both ends of the same edge (the hole was always
-- one end guarded and the other not). The initiator is excluded from the envelope check:
-- their copy of the key is in wrapped_key_initiator.
CREATE FUNCTION shares_check_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Everything is e2ee now (AC-08), so an active share always needs a key.
    IF NEW.state = 'active' AND NEW.subtree_key_id IS NULL THEN
        RAISE EXCEPTION 'an active e2ee share must carry a share key'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.subtree_key_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM share_members m
            WHERE m.share_id = NEW.id
              AND m.user_id <> NEW.initiator_id
              AND m.joined_at IS NOT NULL
              AND m.finalization_started_at IS NULL
              AND m.left_at IS NULL
              AND m.wrapped_key IS NULL) THEN
        RAISE EXCEPTION 'share % carries a key while a joined participant holds no envelope',
            NEW.id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER shares_keys_match_state
    BEFORE INSERT OR UPDATE OF state, subtree_key_id, initiator_id ON shares
    FOR EACH ROW EXECUTE FUNCTION shares_check_keys();

-- A share moves preparing → active | cancelled, then active → ended, never back.
CREATE FUNCTION shares_check_state_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state = NEW.state THEN
        RETURN NEW;
    END IF;
    IF OLD.state IN ('cancelled', 'ended') THEN
        RAISE EXCEPTION 'share % is terminal; it cannot return to %', OLD.id, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF (OLD.state = 'preparing' AND NEW.state NOT IN ('active', 'cancelled'))
       OR (OLD.state = 'active' AND NEW.state <> 'ended') THEN
        RAISE EXCEPTION 'invalid share lifecycle transition % -> %', OLD.state, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER shares_state_moves_forward
    BEFORE UPDATE OF state ON shares
    FOR EACH ROW EXECUTE FUNCTION shares_check_state_transition();

-- By commit nobody may still be in a terminal share. Deferred, because ending/cancellation
-- is several statements and the order between them is the application's business.
CREATE FUNCTION shares_check_ended_is_empty() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s     shares%ROWTYPE;
    stuck uuid;
BEGIN
    SELECT * INTO s FROM shares WHERE id = NEW.id;
    IF NOT FOUND OR s.state NOT IN ('cancelled', 'ended') THEN
        RETURN NULL;
    END IF;

    SELECT user_id INTO stuck FROM share_members
     WHERE share_id = s.id
       AND joined_at IS NOT NULL
       AND left_at IS NULL
       AND finalization_started_at IS NULL
     LIMIT 1;

    IF stuck IS NOT NULL THEN
        RAISE EXCEPTION 'share % is terminal but % is still a participant', s.id, stuck
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER shares_ended_leaves_nobody
    AFTER UPDATE OF state ON shares
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION shares_check_ended_is_empty();

-- At most 8 participants, the initiator included (SH-11) — what keeps synchronous fan-out
-- honest.
CREATE FUNCTION share_members_check_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT count(*) FROM share_members
         WHERE share_id = NEW.share_id
           AND finalization_started_at IS NULL AND left_at IS NULL) > 8 THEN
        RAISE EXCEPTION 'a share holds at most 8 participants'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER share_members_ceiling
    AFTER INSERT OR UPDATE OF finalization_started_at, left_at ON share_members
    FOR EACH ROW EXECUTE FUNCTION share_members_check_ceiling();

-- Joining requires the key envelope (an invitation legitimately has none), and an ACTIVE
-- share (a 'preparing' folder has no share-key names yet). The initiator is exempt: they
-- are a participant from creation, while the share is still 'preparing'.
CREATE FUNCTION share_members_check_join() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s shares%ROWTYPE;
BEGIN
    SELECT * INTO s FROM shares WHERE id = NEW.share_id;

    IF NEW.joined_at IS NOT NULL AND NEW.finalization_started_at IS NULL AND NEW.left_at IS NULL
       AND s.state IN ('cancelled', 'ended') THEN
        RAISE EXCEPTION 'terminal share % cannot regain a live member', s.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.joined_at IS NOT NULL AND NEW.finalization_started_at IS NULL
       AND NEW.user_id <> s.initiator_id
       AND (TG_OP = 'INSERT' OR OLD.joined_at IS NULL)
       AND s.state <> 'active' THEN
        RAISE EXCEPTION 'a share may only be joined while it is active, not while %', s.state
            USING ERRCODE = 'check_violation';
    END IF;

    -- INVITING is blocked by the same states as joining, and for the same reason: while
    -- the share is preparing, its interior names are not yet under KS, so an invitee could
    -- not read what they were handed. The initiator's own row is exempt — it is created
    -- with the share, before it can possibly be active.
    IF TG_OP = 'INSERT' AND NEW.joined_at IS NULL
       AND NEW.user_id <> s.initiator_id
       AND s.state <> 'active' THEN
        RAISE EXCEPTION 'a share may only be invited to while it is active, not while %', s.state
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.joined_at IS NOT NULL AND NEW.finalization_started_at IS NULL
       AND NEW.left_at IS NULL
       AND NEW.wrapped_key IS NULL
       AND NEW.user_id <> s.initiator_id
       AND s.subtree_key_id IS NOT NULL THEN
        RAISE EXCEPTION 'a participant of an e2ee share cannot join without a key envelope'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER share_members_join_carries_a_key
    BEFORE INSERT OR UPDATE OF joined_at, left_at, wrapped_key, share_id ON share_members
    FOR EACH ROW EXECUTE FUNCTION share_members_check_join();

-- The initiator cannot quietly stop being a participant: their departure ENDS the share
-- (SH-17), a state change on the share, not a row edit here.
CREATE FUNCTION share_members_protect_initiator() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s shares%ROWTYPE;
    leaving boolean;
BEGIN
    SELECT * INTO s FROM shares WHERE id = COALESCE(NEW.share_id, OLD.share_id);
    IF s.id IS NULL OR s.state IN ('cancelled', 'ended') THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;

    leaving := (TG_OP = 'DELETE')
            OR (NEW.finalization_started_at IS NOT NULL AND OLD.finalization_started_at IS NULL);

    IF leaving AND OLD.user_id = s.initiator_id THEN
        RAISE EXCEPTION 'the initiator cannot leave share % while it lives; end the share instead',
            s.id USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER share_members_initiator_stays
    BEFORE UPDATE OF finalization_started_at, left_at OR DELETE ON share_members
    FOR EACH ROW EXECUTE FUNCTION share_members_protect_initiator();

-- A node's share mark is a FACT, not a claim (#105), checked BOTH ways (SH-26):
--   * a node inside a shared folder must ITSELF be marked — no unmarked node in a replica
--     (else it is invisible to propagation and swept in by a reset, SH-27);
--   * a marked node is the share's root item or has a parent in the same share, its owner
--     is a live participant, AND it sits in the vault that participant ACCEPTED IN (AC-Q4).
-- A descendant probe catches a subtree marked without its contents. DEFERRED, re-reads
-- the row (a deferred check may not trust NEW).
CREATE FUNCTION nodes_check_share_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    cur          nodes%ROWTYPE;
    parent_share uuid;
    root_item    uuid;
    member_vault uuid;
    stray        uuid;
BEGIN
    SELECT * INTO cur FROM nodes WHERE vault_id = NEW.vault_id AND id = NEW.id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF cur.parent_id IS NOT NULL THEN
        SELECT share_id INTO parent_share
          FROM nodes WHERE vault_id = cur.vault_id AND id = cur.parent_id;
    END IF;

    -- CASE A — a node inside a shared folder must itself be marked (SH-26). The share
    -- root is exempt for free: its parent is an ordinary folder, so parent_share is null.
    IF cur.share_id IS NULL THEN
        IF parent_share IS NOT NULL THEN
            RAISE EXCEPTION 'node % sits inside shared folder % but carries no share mark',
                cur.id, parent_share USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
    END IF;

    -- The node IS marked. Its owner must be a live participant, and this must be the vault
    -- they chose for that share.
    SELECT vault_id INTO member_vault FROM share_members m
     WHERE m.share_id = cur.share_id
       AND m.user_id  = (SELECT user_id FROM vaults WHERE id = cur.vault_id)
       AND m.joined_at IS NOT NULL
       AND m.left_at  IS NULL;

    IF member_vault IS NULL THEN
        RAISE EXCEPTION 'node % carries share % but its owner is not a live participant of it',
            cur.id, cur.share_id USING ERRCODE = 'check_violation';
    END IF;

    IF member_vault IS DISTINCT FROM cur.vault_id THEN
        RAISE EXCEPTION 'node % is marked for share % but lives in a vault the participant did not choose',
            cur.id, cur.share_id USING ERRCODE = 'check_violation';
    END IF;

    SELECT root_item_id INTO root_item FROM shares WHERE id = cur.share_id;

    -- A non-root marked node's parent must be in the SAME share.
    IF cur.share_item_id <> root_item THEN
        IF cur.parent_id IS NULL OR parent_share IS DISTINCT FROM cur.share_id THEN
            RAISE EXCEPTION 'node % claims share % but its parent is not in it',
                cur.id, cur.share_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- CASE B — the descendant probe: a child nobody touched, left unmarked when its folder
    -- was marked, has no event of its own; only the parent can catch it.
    SELECT c.id INTO stray
      FROM nodes c
     WHERE c.vault_id = cur.vault_id AND c.parent_id = cur.id
       AND c.share_id IS DISTINCT FROM cur.share_id
     LIMIT 1;

    IF stray IS NOT NULL THEN
        RAISE EXCEPTION 'node % is in share % but its child % carries a different mark or none; the subtree is incompletely shared',
            cur.id, cur.share_id, stray USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER nodes_share_membership_is_real
    AFTER INSERT OR UPDATE OF share_id, share_item_id, parent_id, vault_id ON nodes
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION nodes_check_share_membership();

-- The share's named folder must carry the share's own marks. Deferred: the row and the
-- marks are written in the same transaction, one first.
CREATE FUNCTION shares_check_root_marks() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s shares%ROWTYPE;
    n nodes%ROWTYPE;
BEGIN
    SELECT * INTO s FROM shares WHERE id = NEW.id;
    IF NOT FOUND OR s.state IN ('cancelled', 'ended') THEN
        RETURN NULL;
    END IF;

    SELECT * INTO n FROM nodes
     WHERE vault_id = s.initiator_vault_id AND id = s.subtree_node_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF n.share_id IS DISTINCT FROM s.id
       OR n.share_item_id IS DISTINCT FROM s.root_item_id THEN
        RAISE EXCEPTION 'share % names folder % but that folder does not carry its root item',
            s.id, s.subtree_node_id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER shares_root_carries_its_marks
    AFTER INSERT OR UPDATE OF subtree_node_id, root_item_id, state ON shares
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION shares_check_root_marks();

-- A leave/revoke/end first stops propagation, but retains the member's finalization state
-- while their client supplies KV envelopes/tags and translates KS names.  `left_at` is only
-- the completed outcome; it cannot be used as an early propagation switch or bypass.
CREATE FUNCTION share_members_check_finalization_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.finalization_started_at IS DISTINCT FROM OLD.finalization_started_at THEN
        IF OLD.finalization_started_at IS NULL THEN
            IF NEW.finalization_started_at IS NULL OR NEW.left_at IS NOT NULL THEN
                RAISE EXCEPTION 'member % finalization must start before it can complete', NEW.user_id
                    USING ERRCODE = 'restrict_violation';
            END IF;
        ELSIF NEW.finalization_started_at IS NULL
              AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL
              AND NEW.joined_at > OLD.joined_at THEN
            NULL; -- a fresh invitation starts a distinct membership interval
        ELSE
            RAISE EXCEPTION 'member % finalization state is immutable until a fresh rejoin', NEW.user_id
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL
       AND NEW.finalization_started_at IS NULL THEN
        RAISE EXCEPTION 'member % cannot leave before finalization starts', NEW.user_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER share_members_finalization_moves_forward
    BEFORE UPDATE OF joined_at, finalization_started_at, left_at ON share_members
    FOR EACH ROW EXECUTE FUNCTION share_members_check_finalization_transition();

-- Clearing a share mark is allowed only for the affected member's in-progress finalization.
-- The server cannot inspect client cryptography, but it can validate that every detached
-- node has its KV name plus KV envelope/tag material before the mark disappears.
CREATE FUNCTION nodes_check_finalization_material() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    member share_members%ROWTYPE;
    vault_key uuid;
    missing_blob bytea;
BEGIN
    IF OLD.share_id IS NULL OR NEW.share_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT m.* INTO member FROM share_members m
     WHERE m.share_id = OLD.share_id
       AND m.user_id = (SELECT user_id FROM vaults WHERE id = OLD.vault_id)
       AND m.vault_id = OLD.vault_id;
    IF NOT FOUND OR member.finalization_started_at IS NULL OR member.left_at IS NOT NULL THEN
        RAISE EXCEPTION 'node % cannot be unmarked outside its member finalization', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT vault_key_id INTO vault_key FROM vaults WHERE id = OLD.vault_id;
    IF NEW.name_key_id IS DISTINCT FROM vault_key THEN
        RAISE EXCEPTION 'node % cannot be unmarked before its name is under the vault key', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT b.sha256 INTO missing_blob
      FROM (SELECT NEW.sha256 AS sha256
            UNION
            SELECT v.sha256 FROM versions v
             WHERE v.vault_id = OLD.vault_id AND v.node_id = OLD.id) b
     WHERE b.sha256 IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM blob_keys bk WHERE bk.sha256 = b.sha256 AND bk.scope_id = vault_key)
         OR NOT EXISTS (SELECT 1 FROM dedup_index d WHERE d.sha256 = b.sha256 AND d.scope_id = vault_key))
     LIMIT 1;
    IF missing_blob IS NOT NULL THEN
        RAISE EXCEPTION 'node % cannot be unmarked before blob % has its vault envelope and tag',
            OLD.id, encode(missing_blob, 'hex') USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_unmark_requires_finalization_material
    BEFORE UPDATE OF share_id, share_item_id, name_key_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_check_finalization_material();

-- Completion may only follow that per-member metadata pass; at this point there can be no
-- marked nodes left in the participant's chosen vault.
CREATE FUNCTION share_members_check_marks_cleared() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL
       AND NEW.finalization_started_at IS NULL THEN
        RAISE EXCEPTION 'user % cannot leave share % before finalization starts',
            NEW.user_id, NEW.share_id USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL
       AND EXISTS (SELECT 1 FROM nodes
                    WHERE share_id = NEW.share_id
                      AND vault_id = NEW.vault_id) THEN
        RAISE EXCEPTION 'user % still holds nodes marked with share %; clear the marks before leaving',
            NEW.user_id, NEW.share_id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER share_members_leave_clears_marks
    BEFORE UPDATE OF left_at ON share_members
    FOR EACH ROW EXECUTE FUNCTION share_members_check_marks_cleared();

-- A membership row is evidence that the finalization procedure has completed.  A normal
-- DELETE cannot skip it; FK cascade from collecting a terminal share remains permitted.
--
-- An UNACCEPTED INVITATION is the exception, and it has to be: joined_at IS NULL forbids
-- finalization_started_at and left_at (see the CHECKs on this table), so without this arm
-- the row could never be removed at all. Decline and withdrawal would be unimplementable
-- and the invitation would occupy one of the eight slots for ever. There is nothing to
-- finalize: no replica was ever materialised, and no key envelope was ever opened.
CREATE FUNCTION share_members_reject_early_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s_state share_state;
BEGIN
    SELECT state INTO s_state FROM shares WHERE id = OLD.share_id;
    IF pg_trigger_depth() > 1 AND s_state IN ('cancelled', 'ended') THEN
        RETURN OLD;
    END IF;
    -- Never joined: decline, or the initiator withdrawing the invitation.
    IF OLD.joined_at IS NULL THEN
        RETURN OLD;
    END IF;
    IF OLD.finalization_started_at IS NULL OR OLD.left_at IS NULL
       OR (OLD.vault_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM nodes WHERE share_id = OLD.share_id AND vault_id = OLD.vault_id)) THEN
        RAISE EXCEPTION 'share member % cannot be deleted before finalization completes and marks clear',
            OLD.user_id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER share_members_delete_requires_finalization
    BEFORE DELETE ON share_members
    FOR EACH ROW EXECUTE FUNCTION share_members_reject_early_delete();

-- A node's name must be encrypted (E2EE always, AC-08): name_enc present, no plaintext
-- name column exists. There is nothing mode-dependent left — the old plaintext arm that
-- recomputed name_hmac is gone with mode A. The root is exempt (no name at all).
-- (name_enc presence is a CHECK; this trigger guards the exact scope id.)
CREATE FUNCTION nodes_check_name_key() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    vault_key uuid;
    s shares%ROWTYPE;
BEGIN
    IF NEW.parent_id IS NULL THEN
        IF NEW.name_key_id IS NOT NULL THEN
            RAISE EXCEPTION 'vault root % has no name and no name key', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.name_key_id IS NULL THEN
        RAISE EXCEPTION 'node % has an encrypted name but no name_key_id (KV or KS?)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT vault_key_id INTO vault_key FROM vaults WHERE id = NEW.vault_id;
    IF NEW.share_id IS NULL THEN
        IF NEW.name_key_id <> vault_key THEN
            RAISE EXCEPTION 'private node % name must use its vault key', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    SELECT * INTO s FROM shares WHERE id = NEW.share_id;
    IF NEW.share_item_id = s.root_item_id THEN
        IF NEW.name_key_id <> vault_key THEN
            RAISE EXCEPTION 'share root % name must use its vault key', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF s.state = 'active' THEN
        IF NEW.name_key_id IS DISTINCT FROM s.subtree_key_id THEN
            RAISE EXCEPTION 'active shared node % name must use its share key', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF s.state = 'preparing' THEN
        IF NEW.name_key_id <> vault_key AND NEW.name_key_id IS DISTINCT FROM s.subtree_key_id THEN
            RAISE EXCEPTION 'preparing shared node % name must use its vault or share key', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.name_key_id <> vault_key THEN
        RAISE EXCEPTION 'terminal shared node % name must use its vault key', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_name_is_encrypted
    BEFORE INSERT OR UPDATE OF name_enc, name_hmac, name_key_id, share_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_check_name_key();

-- Activation is the one-way point where every interior replica must already be readable
-- with KS.  Check names and both blob paths here so an active share is never half-migrated.
CREATE FUNCTION shares_check_activation_material() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    missing_node uuid;
    missing_blob bytea;
BEGIN
    IF NEW.state <> 'active' OR (TG_OP = 'UPDATE' AND OLD.state = 'active') THEN
        RETURN NEW;
    END IF;

    SELECT n.id INTO missing_node
      FROM nodes n
     WHERE n.share_id = NEW.id
       AND n.share_item_id <> NEW.root_item_id
       AND n.name_key_id IS DISTINCT FROM NEW.subtree_key_id
     LIMIT 1;
    IF missing_node IS NOT NULL THEN
        RAISE EXCEPTION 'share % cannot activate: interior node % name is not under its share key',
            NEW.id, missing_node USING ERRCODE = 'check_violation';
    END IF;

    SELECT n.sha256 INTO missing_blob
      FROM nodes n
     WHERE n.share_id = NEW.id
       AND n.share_item_id <> NEW.root_item_id
       AND n.sha256 IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM blob_keys bk
                         WHERE bk.sha256 = n.sha256 AND bk.scope_id = NEW.subtree_key_id)
            OR NOT EXISTS (SELECT 1 FROM dedup_index d
                           WHERE d.sha256 = n.sha256 AND d.scope_id = NEW.subtree_key_id))
     LIMIT 1;
    IF missing_blob IS NOT NULL THEN
        RAISE EXCEPTION 'share % cannot activate: current blob lacks its share envelope or tag', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT v.sha256 INTO missing_blob
      FROM versions v
      JOIN nodes n ON n.vault_id = v.vault_id AND n.id = v.node_id
     WHERE n.share_id = NEW.id
       AND n.share_item_id <> NEW.root_item_id
       AND (NOT EXISTS (SELECT 1 FROM blob_keys bk
                         WHERE bk.sha256 = v.sha256 AND bk.scope_id = NEW.subtree_key_id)
            OR NOT EXISTS (SELECT 1 FROM dedup_index d
                           WHERE d.sha256 = v.sha256 AND d.scope_id = NEW.subtree_key_id))
     LIMIT 1;
    IF missing_blob IS NOT NULL THEN
        RAISE EXCEPTION 'share % cannot activate: version blob lacks its share envelope or tag', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER shares_activation_has_all_key_material
    BEFORE INSERT OR UPDATE OF state ON shares
    FOR EACH ROW EXECUTE FUNCTION shares_check_activation_material();

-- Over quota freezes the whole ACCOUNT (SH-20), because the quota is per account (AC-Q2):
-- every vault it owns and every share it is in, at once. Two arms, and the difference
-- matters:
--   * own content — nothing that GROWS usage may arrive: no new node, no new content for
--     an existing one. Renames, moves and deletes stay allowed; deleting is the only way
--     out of over-quota, so a freeze that blocked it would be a deadlock;
--   * a replica — does not move at all, in either direction. Propagation is all-or-none
--     (SH-11), so a partially-updated replica is worse than a stalled one; the gap is
--     restored on thaw (SH-21).
CREATE FUNCTION nodes_reject_frozen_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner uuid;
BEGIN
    SELECT v.user_id INTO owner
      FROM vaults v JOIN users u ON u.id = v.user_id
     WHERE v.id = NEW.vault_id AND u.frozen_at IS NOT NULL;

    IF owner IS NULL THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.share_id, OLD.share_id) IS NOT NULL THEN
        RAISE EXCEPTION 'account % is over quota; their copy does not move until the freeze lifts',
            owner USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' OR NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
        RAISE EXCEPTION 'account % is over quota; nothing that grows usage may be sent until the freeze lifts',
            owner USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_frozen_account_sends_nothing
    BEFORE INSERT OR UPDATE OF parent_id, name_enc, name_hmac, sha256, size, mtime, rev, deleted_at
    ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_reject_frozen_write();

-- Activation validates existing replicas; later shared writes need the same key material.
CREATE FUNCTION nodes_check_active_share_material() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s shares%ROWTYPE;
BEGIN
    IF NEW.share_id IS NULL OR NEW.sha256 IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO s FROM shares WHERE id = NEW.share_id;
    IF s.state = 'active' AND NEW.share_item_id <> s.root_item_id
       AND (NOT EXISTS (SELECT 1 FROM blob_keys WHERE sha256 = NEW.sha256 AND scope_id = s.subtree_key_id)
         OR NOT EXISTS (SELECT 1 FROM dedup_index WHERE sha256 = NEW.sha256 AND scope_id = s.subtree_key_id)) THEN
        RAISE EXCEPTION 'active shared node % needs its share envelope and dedup tag', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_active_share_writes_have_key_material
    BEFORE INSERT OR UPDATE OF sha256, share_id, share_item_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_check_active_share_material();

-- A private write must make its ciphertext readable under KV and discoverable through a
-- KV dedup tag before the node can reference it.  Active shared interiors use KS above.
CREATE FUNCTION nodes_check_private_material() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    vault_key uuid;
BEGIN
    -- Detaching a replica has its own finalization trigger, which first checks membership
    -- state and then validates the same KV material with the intended diagnostics.
    IF NEW.share_id IS NOT NULL OR NEW.sha256 IS NULL
       OR (TG_OP = 'UPDATE' AND OLD.share_id IS NOT NULL) THEN
        RETURN NEW;
    END IF;
    SELECT vault_key_id INTO vault_key FROM vaults WHERE id = NEW.vault_id;
    IF NOT EXISTS (SELECT 1 FROM blob_keys WHERE sha256 = NEW.sha256 AND scope_id = vault_key)
       OR NOT EXISTS (SELECT 1 FROM dedup_index WHERE sha256 = NEW.sha256 AND scope_id = vault_key) THEN
        RAISE EXCEPTION 'private node % needs its vault envelope and dedup tag', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_private_writes_have_key_material
    BEFORE INSERT OR UPDATE OF sha256, share_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_check_private_material();

CREATE FUNCTION versions_check_active_share_material() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s shares%ROWTYPE;
    n nodes%ROWTYPE;
BEGIN
    SELECT * INTO n FROM nodes WHERE vault_id = NEW.vault_id AND id = NEW.node_id;
    IF n.share_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO s FROM shares WHERE id = n.share_id;
    IF s.state = 'active' AND n.share_item_id <> s.root_item_id
       AND (NOT EXISTS (SELECT 1 FROM blob_keys WHERE sha256 = NEW.sha256 AND scope_id = s.subtree_key_id)
         OR NOT EXISTS (SELECT 1 FROM dedup_index WHERE sha256 = NEW.sha256 AND scope_id = s.subtree_key_id)) THEN
        RAISE EXCEPTION 'active shared version needs its share envelope and dedup tag'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER versions_active_share_writes_have_key_material
    BEFORE INSERT OR UPDATE OF sha256 ON versions
    FOR EACH ROW EXECUTE FUNCTION versions_check_active_share_material();

-- Clearing a share mark is the moment a replica becomes ordinary content, and SH-22/SH-25
-- say what happens to its history then: an added participant keeps the files alone; the
-- initiator keeps everything. Checkable exactly here — once the mark is gone there is no
-- telling which nodes were in the share. Deferred.
CREATE FUNCTION nodes_check_history_on_unmark() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    cur       nodes%ROWTYPE;
    initiator uuid;
    owner     uuid;
BEGIN
    IF OLD.share_id IS NULL OR NEW.share_id IS NOT NULL THEN
        RETURN NULL;                         -- not an unmark
    END IF;

    SELECT * INTO cur FROM nodes WHERE vault_id = OLD.vault_id AND id = OLD.id;
    IF NOT FOUND OR cur.share_id IS NOT NULL THEN
        RETURN NULL;
    END IF;

    SELECT initiator_id INTO initiator FROM shares WHERE id = OLD.share_id;
    SELECT user_id INTO owner FROM vaults WHERE id = cur.vault_id;
    IF NOT FOUND OR initiator = owner THEN
        RETURN NULL;                         -- the initiator keeps their history
    END IF;

    IF EXISTS (SELECT 1 FROM versions WHERE vault_id = cur.vault_id AND node_id = cur.id) THEN
        RAISE EXCEPTION 'node % left share % with its history; an added participant keeps the files alone',
            cur.id, OLD.share_id USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER nodes_unmark_drops_history
    AFTER UPDATE OF share_id ON nodes
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION nodes_check_history_on_unmark();

-- Ending a share is a STATE CHANGE, not a DELETE: offline participants must still learn
-- of it from their delta. The collector removes the row after the journal TTL.
CREATE FUNCTION shares_reject_live_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state NOT IN ('cancelled', 'ended') THEN
        RAISE EXCEPTION 'share % is live; set it to a terminal state instead of deleting it', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER shares_no_delete_while_live
    BEFORE DELETE ON shares
    FOR EACH ROW EXECUTE FUNCTION shares_reject_live_delete();

-- A per-vault reset (AC-14) HARD-deletes the vault's own nodes where share_id IS NULL;
-- replicas are excluded (SH-27), because deleting them would propagate to other people.
-- That predicate belongs to the reset. The one part the schema holds: the root of a live
-- share cannot be soft-deleted at all, whoever asks.
CREATE FUNCTION nodes_reject_delete_of_share_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM shares s
                    WHERE s.initiator_vault_id = NEW.vault_id
                      AND s.subtree_node_id = NEW.id
                      AND s.state <> 'ended') THEN
        RAISE EXCEPTION 'node % is the root of a live share; end it first', NEW.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_no_delete_of_share_root
    BEFORE UPDATE OF deleted_at ON nodes
    FOR EACH ROW EXECUTE FUNCTION nodes_reject_delete_of_share_root();

-- ============================================================ append-only logs

CREATE FUNCTION reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER journal_append_only
    BEFORE UPDATE ON journal FOR EACH ROW EXECUTE FUNCTION reject_update();

-- A new-revision notification (docs/04). Fired on every journal row, which is one revision;
-- `pg_notify` delivers it only when the transaction commits, so a write that rolls back
-- emits nothing. One channel for all vaults; the payload is the vault that changed.
CREATE FUNCTION journal_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('sync_vault', NEW.vault_id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER journal_notify
    AFTER INSERT ON journal FOR EACH ROW EXECUTE FUNCTION journal_notify();

CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_update();

CREATE FUNCTION reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are not deletable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_delete();

-- Account-owned records exist and change only while their owner is active.
CREATE FUNCTION owned_rows_require_active_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner_id uuid;
    owner_state user_state;
BEGIN
    IF TG_TABLE_NAME = 'nodes' THEN
        SELECT user_id INTO owner_id FROM vaults
         WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.vault_id ELSE NEW.vault_id END;
    ELSE
        owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    END IF;
    SELECT state INTO owner_state FROM users WHERE id = owner_id;
    IF owner_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'only active users may own or write vaults, devices, and nodes'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_TABLE_NAME = 'devices' THEN
        IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id
           AND EXISTS (SELECT 1 FROM device_pairings
                        WHERE claimed_device_id = OLD.id AND approved_user_id IS DISTINCT FROM NEW.user_id) THEN
            RAISE EXCEPTION 'a claimed pairing device must remain owned by its approved user'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER vaults_owner_is_active
    BEFORE INSERT OR UPDATE OR DELETE ON vaults
    FOR EACH ROW EXECUTE FUNCTION owned_rows_require_active_user();

CREATE TRIGGER devices_owner_is_active
    BEFORE INSERT OR UPDATE OR DELETE ON devices
    FOR EACH ROW EXECUTE FUNCTION owned_rows_require_active_user();

CREATE TRIGGER nodes_owner_is_active
    BEFORE INSERT OR UPDATE OR DELETE ON nodes
    FOR EACH ROW EXECUTE FUNCTION owned_rows_require_active_user();

CREATE FUNCTION users_cannot_become_inactive_owners() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state = 'active' AND NEW.state <> 'active'
       AND (EXISTS (SELECT 1 FROM vaults WHERE user_id = OLD.id)
         OR EXISTS (SELECT 1 FROM devices WHERE user_id = OLD.id)) THEN
        RAISE EXCEPTION 'user % cannot become % while owning vaults, devices, or nodes', OLD.id, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_active_ownership_is_required
    BEFORE UPDATE OF state ON users
    FOR EACH ROW EXECUTE FUNCTION users_cannot_become_inactive_owners();

-- Version authorship is a write attributed to an account that may not own this vault
-- (a share participant), so it needs the same active-account boundary explicitly.
CREATE FUNCTION versions_author_must_be_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- The tombstone is admitted alongside active accounts, and it has to be: account
    -- deletion (#55) reassigns authorship to it, and a rule that only accepted 'active'
    -- would make the anonymisation pass impossible — the procedure would block on its
    -- own guard.
    IF NOT EXISTS (SELECT 1 FROM users
                    WHERE id = NEW.author_id AND state IN ('active', 'tombstone')) THEN
        RAISE EXCEPTION 'only an active account or the tombstone may be named as author'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER versions_author_is_active
    BEFORE INSERT OR UPDATE OF author_id ON versions
    FOR EACH ROW EXECUTE FUNCTION versions_author_must_be_active();

-- The writer allocates revisions and may prune expired journal rows, so the schema cannot
-- require a contiguous journal.  It can still reject impossible revision bounds at commit.
CREATE FUNCTION vaults_check_revision_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid;
    head bigint;
BEGIN
    IF TG_TABLE_NAME = 'vaults' THEN
        v_id := NEW.id;
    ELSE
        v_id := NEW.vault_id;
    END IF;
    SELECT head_rev INTO head FROM vaults WHERE id = v_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM nodes WHERE vault_id = v_id AND rev > head)
       OR EXISTS (SELECT 1 FROM journal WHERE vault_id = v_id AND (rev > head OR node_rev > head))
       OR EXISTS (SELECT 1 FROM versions v JOIN nodes n ON n.vault_id = v.vault_id AND n.id = v.node_id
                  WHERE v.vault_id = v_id AND v.rev > n.rev) THEN
        RAISE EXCEPTION 'vault % has node, journal, or version revision beyond its head revision', v_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER vaults_revision_bounds
    AFTER INSERT OR UPDATE OF head_rev ON vaults DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION vaults_check_revision_integrity();

CREATE CONSTRAINT TRIGGER nodes_revision_within_vault_head
    AFTER INSERT OR UPDATE OF rev ON nodes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION vaults_check_revision_integrity();

CREATE CONSTRAINT TRIGGER journal_revision_within_vault_head
    AFTER INSERT ON journal DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION vaults_check_revision_integrity();

CREATE CONSTRAINT TRIGGER versions_revision_within_node
    AFTER INSERT OR UPDATE OF rev ON versions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION vaults_check_revision_integrity();

-- ============================================================ seed: the rows nothing can create
--
-- Two accounts have to exist before the system can do anything, and neither can be made
-- by the procedures that make the others. server_meta above is seeded for the same reason.

-- The TOMBSTONE (#55). Account deletion reassigns authorship to it, so history keeps
-- saying "written by an account that is gone" instead of losing its writer. It has to
-- exist BEFORE the first deletion, and nothing else would ever insert it. The nil UUID is
-- deliberate: gen_random_uuid() never produces it, so the id is unmistakable in a log.
-- Seeding it here is also what reserves its login — users_login_key is unique, so no real
-- account can take 'deleted' afterwards. quota_bytes must be > 0 and is never used.
INSERT INTO users (id, login, role, state, quota_bytes)
VALUES ('00000000-0000-0000-0000-000000000000', 'deleted', 'user', 'tombstone', 1);

-- The FIRST ADMINISTRATOR, as an unredeemed invitation — the only shape the server can
-- create, because keys are born on a device (#83) and the server has none to give.
-- The token is the literal string 'admin'. That is a default credential, and it is made
-- safe by being SINGLE USE BY CONSTRUCTION: redeeming it is what replaces it, filling in
-- the operator's own key material and turning this row into their account. Until then the
-- application serves nothing but its redemption (#107), so the window is "first run",
-- not "for ever, because nobody changed it".
INSERT INTO users (id, login, role, state, invite_token_hash, invite_expires_at, quota_bytes)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'admin', 'provisioned',
        encode(sha256(convert_to('admin', 'UTF8')), 'hex'), now() + interval '7 days', 10737418240);

-- ============================================================ notes on what is NOT here
--
-- * rev allocation. vaults.head_rev is bumped inside the write transaction
--   (SELECT … FOR UPDATE on the vaults row). It stays in the application so the three-way
--   write — node, journal, version — remains one explicit unit; deferred checks enforce
--   only revision bounds, not correspondence or contiguous journal history after TTL.
-- * ancestry MAINTENANCE on move is a recursive UPDATE in the application; the schema
--   only VERIFIES it (nodes_ancestry_matches_parents).
-- * PROPAGATION: a write inside a shared folder is applied to every participant's
--   counterpart in their chosen vault, in one transaction (SH-11). Application work; the
--   schema guarantees only that counterparts are findable (nodes_one_replica_per_item).
-- * KEY DERIVATION and passphrase change are client-side (AC-11); the server stores
--   wrapped_seed and never unwraps it.
-- * Retention and GC are jobs, not constraints; the schema only guarantees a referenced
--   blob cannot be deleted (ON DELETE RESTRICT on every path from blobs).

COMMIT;
