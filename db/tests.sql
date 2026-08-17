-- SyncServer — schema tests (PostgreSQL 16+).
--
-- Mostly NEGATIVE tests: each fires a rule from the wrong side and asserts WHICH rule
-- rejected it — the expected SQLSTATE plus a fragment of the message (#101). SQLSTATE
-- alone is not enough: nearly every trigger raises check_violation, like a plain CHECK.
--
-- Runs in one transaction ending in ROLLBACK, so it leaves the database as schema.sql
-- created it. DEFERRED constraints never fire in a rolled-back transaction on their own;
-- tests force them with SET CONSTRAINTS … IMMEDIATE, and the file closes with
-- SET CONSTRAINTS ALL IMMEDIATE so a wrong fixture cannot sit unnoticed.
--
-- Rewritten for the account/vault + E2EE-always model (2026-08-04): a user is an ACCOUNT
-- holding VAULTS; a node is keyed by (vault_id, id); names are ciphertext only.

BEGIN;

-- ============================================================ test helpers

CREATE FUNCTION expect_fail(stmt text, sqlstate_expected text, msg_like text, label text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE stmt;
    EXCEPTION WHEN others THEN
        IF SQLSTATE <> sqlstate_expected THEN
            RAISE EXCEPTION 'FAIL  %: rejected with % (%), but the test expects %',
                label, SQLSTATE, SQLERRM, sqlstate_expected;
        END IF;
        IF position(msg_like IN SQLERRM) = 0 THEN
            RAISE EXCEPTION 'FAIL  %: rejected with the right SQLSTATE % but by the wrong rule — expected a message containing "%", got "%"',
                label, SQLSTATE, msg_like, SQLERRM;
        END IF;
        RAISE NOTICE 'PASS  % (% %)', label, SQLSTATE, msg_like;
        RETURN;
    END;
    RAISE EXCEPTION 'FAIL  %: statement was accepted but must have been rejected', label;
END;
$$;

CREATE FUNCTION expect_ok(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE stmt;
    RAISE NOTICE 'PASS  % (accepted, as expected)', label;
EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'FAIL  %: rejected with % — %', label, SQLSTATE, SQLERRM;
END;
$$;

-- A stand-in for the client-computed keyed name_hmac (32 bytes). The server never sees a
-- name and never verifies this, so any distinct 32-byte value models a distinct name.
CREATE FUNCTION nh(s text) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to(s, 'UTF8')) $$;

SELECT expect_fail($$
    DELETE FROM server_meta
$$, '23001', 'cannot be deleted or replaced',
   'deleting the singleton server metadata row');

-- ============================================================ fixtures

-- Two accounts. Keys are dummy bytes: nothing here tests crypto, only the shape the
-- schema demands. state must be explicit (default 'provisioned' carries no keys, #83).
INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                    pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'active', 'h',
   '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
    '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea, 10000000),
  ('22222222-2222-2222-2222-222222222222', 'bob', 'active', 'h',
   '\xffeeddccbbaa99887766554433221100'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
    '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea, 10000000);

-- Every vault/share scope is registered before it is referenced.
INSERT INTO key_scopes (id, kind) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'vault'),
  ('bc000000-0000-0000-0000-000000000001', 'vault');

-- One vault per account (an account may hold more; these tests use one each).
INSERT INTO vaults (id, user_id, root_node_id, name_enc, vault_key_id)
VALUES
  ('aa000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'a0000000-0000-0000-0000-0000000000a1',
    '\xaa'::bytea, 'ac000000-0000-0000-0000-000000000001'),
  ('bb000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'b0000000-0000-0000-0000-0000000000b1',
    '\xbb'::bytea, 'bc000000-0000-0000-0000-000000000001');

UPDATE vaults SET head_rev = 100
 WHERE id = 'aa000000-0000-0000-0000-000000000001';
UPDATE vaults SET head_rev = 10
 WHERE id = 'bb000000-0000-0000-0000-000000000001';

INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
VALUES (sha256('hello'::bytea), 5, 'ab/cd/hello', 'xchacha20-poly1305',
         'ce000000-0000-0000-0000-000000000001');

INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
VALUES (sha256('hello'::bytea), 'ac000000-0000-0000-0000-000000000001', '\xbeef'::bytea);
INSERT INTO dedup_index (scope_id, content_tag, sha256)
VALUES ('ac000000-0000-0000-0000-000000000001', nh('alice-private-tag'), sha256('hello'::bytea));

-- Roots (one per vault): no name, no name_hmac.
INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, mtime, rev)
VALUES
  ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a1',
   NULL, NULL, NULL, 'folder', now(), 0),
  ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b1',
   NULL, NULL, NULL, 'folder', now(), 0);

-- Alice: /Research (folder) + /Research/note.md (file). Names are ciphertext + a keyed
-- hmac; name_key_id points at the vault key.
INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a2',
        'a0000000-0000-0000-0000-0000000000a1', '\xda7a01'::bytea, nh('Research'),
        'ac000000-0000-0000-0000-000000000001', 'folder', now(), 1,
        ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[]);

INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a3',
        'a0000000-0000-0000-0000-0000000000a2', '\xda7a02'::bytea, nh('note.md'),
        'ac000000-0000-0000-0000-000000000001', 'file', sha256('hello'::bytea), 5, now(), 2,
        ARRAY['a0000000-0000-0000-0000-0000000000a1',
              'a0000000-0000-0000-0000-0000000000a2']::uuid[]);

-- ============================================================ accounts / KDF (#83)

-- A provisioned account carries an invitation and no keys.
SELECT expect_ok($$
    INSERT INTO users (id, login, quota_bytes, state, invite_token_hash, invite_expires_at)
    VALUES ('33333333-3333-3333-3333-333333333333', 'carol', 10000000,
            'provisioned', 'tokenhash', now() + interval '7 days')
$$, 'provisioned account without keys');

-- A provisioned account may not carry keys.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, invite_token_hash, wrapped_seed)
    VALUES ('44444444-4444-4444-4444-444444444444', 'dave', 10000000,
            'provisioned', 'tok', '\x04'::bytea)
$$, '23514', 'keys_match_state',
   'a provisioned account carrying a seed');

SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, invite_token_hash, invite_expires_at)
    VALUES ('43434343-3333-3333-3333-333333333333', 'no-expiry', 10000000,
            'provisioned', 'tok', NULL)
$$, '23514', 'keys_match_state',
   'a provisioned account without invitation expiry');

-- An active account must carry all key material, wrapped_seed included.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                       kdf_params, pubkey, enc_privkey, kek_verifier_hash, recovery_key)
    VALUES ('44444444-4444-4444-4444-444444444444', 'dave', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
            '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea)
$$, '23514', 'keys_match_state',
   'an active account with no wrapped_seed');

-- kdf_params is validated: an empty object hands the next device an impossible derivation.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                        kdf_params, pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed)
    VALUES ('44444444-4444-4444-4444-444444444444', 'dave', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{}'::jsonb,
             '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea)
$$, '23514', 'kdf_params',
   'kdf_params of {} accepted by a validator meant to reject it');

-- Argon2id memory below the floor is refused.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                        kdf_params, pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed)
    VALUES ('44444444-4444-4444-4444-444444444444', 'dave', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":1024,"t":3,"p":1}',
             '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea)
$$, '23514', 'kdf_params',
   'kdf_params below the memory floor');

SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                        kdf_params, pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed)
    VALUES ('46444444-4444-4444-4444-444444444444', 'fractional-kdf', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":65536.5,"t":3,"p":1}',
             '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea)
$$, '23514', 'kdf_params',
   'a fractional KDF parameter');

SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                        kdf_params, pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed)
    VALUES ('47444444-4444-4444-4444-444444444444', 'wrong-kdf-version', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":18,"m":65536,"t":3,"p":1}',
             '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea)
$$, '23514', 'kdf_params',
   'an unsupported KDF version');

-- Login is case-insensitively unique.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, invite_token_hash, invite_expires_at)
    VALUES ('44444444-4444-4444-4444-444444444444', 'Alice', 10000000, 'provisioned', 'tok', now() + interval '1 day')
$$, '23505', 'users_login_key',
   'a login differing only in case');

-- Half a recovery pair is nobody's state: an envelope with no verifier can never be
-- released, and a verifier with no envelope releases nothing.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                       kdf_params, pubkey, enc_privkey, kek_verifier_hash, recovery_key, wrapped_seed)
    VALUES ('45444444-4444-4444-4444-444444444444', 'no-recovery-hash', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
            '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, '\x04'::bytea)
$$, '23514', 'recovery_code_is_whole',
   'an active account holding a recovery envelope with no verifier');

-- The recovery code answers a DIFFERENT loss and is optional (#112). An account without one
-- must be expressible, because the alternative is the placeholder that made an account claim
-- a way back it did not have.
SELECT expect_ok($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                       kdf_params, pubkey, enc_privkey, kek_verifier_hash, wrapped_seed)
    VALUES ('48444444-4444-4444-4444-444444444444', 'no-recovery-code', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
            '\x01'::bytea, '\x02'::bytea, 'kv', '\x04'::bytea)
$$, 'an active account with no recovery code at all, which is the honest shape');

-- The KEK verifier is NOT optional: without it an account that loses its last device cannot
-- be recovered by any means, which is the state M3.5 exists to make impossible.
SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, auth_secret_hash, account_salt,
                       kdf_params, pubkey, enc_privkey, wrapped_seed)
    VALUES ('49444444-4444-4444-4444-444444444444', 'no-kek-verifier', 10000000, 'active', 'h',
            '\x00112233445566778899aabbccddeeff'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
            '\x01'::bytea, '\x02'::bytea, '\x04'::bytea)
$$, '23514', 'keys_match_state',
   'an active account with no way to prove its passphrase');

-- ---- last active administrator
-- A CONSOLE account (#115): a password and no key material. An administrator carrying keys
-- is now a shape the check refuses, which the negatives further down assert.
INSERT INTO users (id, login, state, role, password_hash, quota_bytes)
VALUES ('99999999-9999-9999-9999-999999999999', 'root', 'active', 'admin', '$argon2id$fake', 1);

SELECT expect_fail($$
    UPDATE users SET role = 'user' WHERE login = 'root'
$$, '23001', 'last active administrator',
   'demoting the only administrator');

SELECT expect_fail($$
    UPDATE users SET state = 'deleting' WHERE login = 'root'
$$, '23001', 'last active administrator',
   'putting the only administrator into deletion');

-- An account that ever held data must pass through 'deleting' before removal.
SELECT expect_fail($$
    DELETE FROM users WHERE login = 'bob'
$$, '23001', 'must enter state deleting',
   'deleting an active account directly');

-- An unclaimed invitation is exempt.
SELECT expect_ok($$
    DELETE FROM users WHERE login = 'carol'
$$, 'revoking an unclaimed invitation is a plain delete');

-- ============================================================ vaults

-- reset_epoch has a floor (checked on insert, before any epoch trigger can fire).
INSERT INTO key_scopes (id, kind)
VALUES ('ac000000-0000-0000-0000-000000000009', 'vault');
SELECT expect_fail($$
    INSERT INTO vaults (id, user_id, root_node_id, vault_key_id, reset_epoch)
    VALUES ('ad000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111',
            'a9000000-0000-0000-0000-0000000000a1',
            'ac000000-0000-0000-0000-000000000009', 0)
$$, '23514', 'reset_epoch',
   'a vault created with reset_epoch 0');

SELECT expect_fail($$
    DO $inner$
    BEGIN
        UPDATE vaults SET reset_epoch = 5 WHERE id = 'aa000000-0000-0000-0000-000000000001';
        UPDATE vaults SET reset_epoch = 4 WHERE id = 'aa000000-0000-0000-0000-000000000001';
    END $inner$
$$, '23001', 'epoch may not decrease',
   'lowering a vault reset_epoch');

SELECT expect_fail($$
    DO $inner$
    BEGIN
        UPDATE vaults SET root_node_id = 'a0000000-0000-0000-0000-0000000000a2'
         WHERE id = 'aa000000-0000-0000-0000-000000000001';
        SET CONSTRAINTS vaults_root_is_exactly_one_node IMMEDIATE;
    END $inner$
$$, '23514', 'exactly one linked root',
   'linking a vault to a non-root node');

-- Disabling keeps every byte (docs/11): sessions go, writes stop, the data stays. An
-- account that had to be emptied before it could be switched off would make disabling a
-- destructive act, and the reversible half of #55 would not exist.
SELECT expect_ok($$
    DO $inner$ BEGIN
        UPDATE users SET state = 'disabled' WHERE login = 'alice';
        UPDATE users SET state = 'active'   WHERE login = 'alice';
    END $inner$
$$, 'an account that owns a vault can be switched off and back on');

-- The two states that must own nothing are the two that are not an account at all.
SELECT expect_fail($$
    UPDATE users SET state = 'tombstone' WHERE login = 'alice'
$$, '23001', 'while owning vaults, devices, or nodes',
   'the tombstone cannot be an account that still holds data');

-- And a disabled account may not write, which is what "switched off" means.
SELECT expect_fail($$
    DO $inner$ BEGIN
        UPDATE users SET state = 'disabled' WHERE login = 'alice';
        INSERT INTO devices (user_id, name, platform)
        VALUES ((SELECT id FROM users WHERE login = 'alice'), 'sneaky', 'linux');
    END $inner$
$$, '23001', 'only an active account may write',
   'a disabled account cannot add a device');

INSERT INTO key_scopes (id, kind)
VALUES ('ac000000-0000-0000-0000-000000000008', 'vault');
INSERT INTO vaults (id, user_id, root_node_id, vault_key_id)
VALUES ('ae000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111',
        'a8000000-0000-0000-0000-0000000000a1', 'ac000000-0000-0000-0000-000000000008');
INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, mtime, rev)
VALUES ('ae000000-0000-0000-0000-000000000008', 'a8000000-0000-0000-0000-0000000000a1',
        NULL, NULL, NULL, 'folder', now(), 0);

SELECT expect_fail($$
    DELETE FROM vaults WHERE id = 'ae000000-0000-0000-0000-000000000008'
$$, '23001', 'not empty; explicitly clean up',
   'deleting a non-empty vault');

SELECT expect_ok($$
    DO $inner$
    BEGIN
        DELETE FROM nodes WHERE vault_id = 'ae000000-0000-0000-0000-000000000008';
        DELETE FROM vaults WHERE id = 'ae000000-0000-0000-0000-000000000008';
    END $inner$
$$, 'an empty vault is deleted after explicit data cleanup');

-- An anonymous pairing has the new device's ephemeral key, is approved once with its
-- seed envelope, claimed once, and cannot outlive its TTL.
SELECT expect_fail($$
    INSERT INTO device_pairings (pairing_token_hash, expires_at)
    VALUES ('missing-device-key', now() + interval '10 minutes')
$$, '23502', 'device_pubkey',
   'creating a pairing without an ephemeral device public key');
SELECT expect_ok($$
    INSERT INTO device_pairings (id, pairing_token_hash, device_pubkey, expires_at)
    VALUES ('d0000000-0000-0000-0000-000000000001', 'pair-token', '\xdead'::bytea,
            now() + interval '10 minutes')
$$, 'an anonymous device pairing is created');
SELECT expect_fail($$
    UPDATE device_pairings
       SET approved_user_id = '11111111-1111-1111-1111-111111111111', approved_at = now()
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, '23514', 'pairing_approval_fields_together',
   'approving a pairing without a seed envelope');
SELECT expect_fail($$
    UPDATE device_pairings SET seed_envelope = '\xbeef'::bytea
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, '23514', 'pairing_approval_fields_together',
   'storing a seed envelope before approval');
SELECT expect_fail($$
    UPDATE device_pairings SET claimed_device_id = gen_random_uuid(), claimed_at = now()
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, '23514', 'pairing_claim_requires_approval',
   'claiming a pairing before approval');
SELECT expect_ok($$
    UPDATE device_pairings
       SET approved_user_id = '11111111-1111-1111-1111-111111111111', approved_at = now(),
           seed_envelope = '\xbeef'::bytea
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, 'an approved pairing binds its account and seed envelope');
SELECT expect_ok($$
    INSERT INTO devices (id, user_id, name, platform)
    VALUES ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'paired', 'test');
    UPDATE device_pairings SET claimed_device_id = 'd1000000-0000-0000-0000-000000000001', claimed_at = now()
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, 'an approved pairing is claimed once');
SELECT expect_fail($$
    UPDATE device_pairings SET device_pubkey = '\xcafe'::bytea
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, '23001', 'public key is immutable after approval',
   'changing a device public key after approval');
SELECT expect_ok($$
    INSERT INTO devices (id, user_id, name, platform)
    VALUES ('d2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'wrong-owner', 'test');
    INSERT INTO device_pairings (id, pairing_token_hash, device_pubkey, approved_user_id, approved_at, seed_envelope, expires_at)
    VALUES ('d0000000-0000-0000-0000-000000000002', 'pair-token-2', '\xdead'::bytea,
            '11111111-1111-1111-1111-111111111111', now(), '\xbeef'::bytea, now() + interval '10 minutes')
$$, 'a second pairing is approved for Alice');
SELECT expect_fail($$
    UPDATE device_pairings
       SET claimed_device_id = 'd2000000-0000-0000-0000-000000000001', claimed_at = now()
     WHERE id = 'd0000000-0000-0000-0000-000000000002'
$$, '23514', 'must be claimed by a device of its approved user',
   'claiming Alice pairing with Bob device');
SELECT expect_fail($$
    UPDATE device_pairings SET claimed_device_id = gen_random_uuid(), claimed_at = now()
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, '23001', 'already claimed',
   'claiming a pairing twice');
SELECT expect_fail($$
    UPDATE device_pairings SET claimed_at = now() + interval '1 second'
     WHERE id = 'd0000000-0000-0000-0000-000000000001'
$$, '23001', 'already claimed',
   'changing the timestamp of an already claimed pairing');
SELECT expect_fail($$
    INSERT INTO device_pairings (pairing_token_hash, device_pubkey, expires_at)
    VALUES ('expired-pair-token', '\xdead'::bytea, now() - interval '1 second')
$$, '23514', 'is expired',
   'creating an expired pairing');

-- A node id may repeat across vaults (composite key): Bob may hold a node whose id equals
-- one of Alice's. This is what makes replication's per-vault ids work.
SELECT expect_ok($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a2',
            'b0000000-0000-0000-0000-0000000000b1', '\xbb01'::bytea, nh('SameId'),
            'bc000000-0000-0000-0000-000000000001', 'folder', now(), 1,
            ARRAY['b0000000-0000-0000-0000-0000000000b1']::uuid[])
$$, 'the same node id lives independently in two vaults');

-- ============================================================ names (client-side; server checks only shape)

-- A non-root node must carry a name_enc.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000c1',
            'a0000000-0000-0000-0000-0000000000a2', nh('noenc'),
            'ac000000-0000-0000-0000-000000000001', 'file', sha256('hello'::bytea), 5, now(), 3,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, '23514', 'has_a_name',
   'a non-root node with no encrypted name');

-- The root may have no name; a second root in one vault is refused.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, mtime, rev)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000c2',
            NULL, NULL, NULL, 'folder', now(), 3)
$$, '23505', 'nodes_single_root',
   'a second root in one vault');

-- Sibling uniqueness is over the (unverifiable) name_hmac.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000c3',
            'a0000000-0000-0000-0000-0000000000a2', '\xda7a99'::bytea, nh('note.md'),
            'ac000000-0000-0000-0000-000000000001', 'file', sha256('hello'::bytea), 5, now(), 3,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, '23505', 'nodes_unique_sibling',
   'a duplicate live sibling name_hmac');

-- Equal node ids in different vaults may also be equal parent ids.  Sibling uniqueness
-- must not let Alice's child reserve a name under Bob's unrelated parent.
SELECT expect_ok($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000c3',
            'a0000000-0000-0000-0000-0000000000a2', '\xbbc3'::bytea, nh('note.md'),
            'bc000000-0000-0000-0000-000000000001', 'folder', now(), 3,
            ARRAY['b0000000-0000-0000-0000-0000000000b1',
                  'a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, 'the same sibling name under equal parent ids in different vaults');

-- A non-root encrypted name needs a name_key_id (KV or KS?).
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, sha256, size, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000c4',
            'a0000000-0000-0000-0000-0000000000a2', '\xda7a03'::bytea, nh('nokey'),
            'file', sha256('hello'::bytea), 5, now(), 3,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, '23514', 'no name_key_id',
   'an encrypted name with no name_key_id');

-- Deleting frees the name (#36).
SELECT expect_ok($$
    UPDATE nodes SET deleted_at = now(), sha256 = NULL, size = NULL
     WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
       AND id = 'a0000000-0000-0000-0000-0000000000a3'
$$, 'soft-delete a file');

SELECT expect_ok($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a4',
            'a0000000-0000-0000-0000-0000000000a2', '\xda7a04'::bytea, nh('note.md'),
            'ac000000-0000-0000-0000-000000000001', 'file', sha256('hello'::bytea), 5, now(), 4,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, 'the freed name is reusable');

-- ============================================================ node shape

-- A folder carries no content.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000c5',
            'a0000000-0000-0000-0000-0000000000a2', '\xda7a05'::bytea, nh('fatfolder'),
            'ac000000-0000-0000-0000-000000000001', 'folder', sha256('hello'::bytea), 5, now(), 3,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, '23514', 'folders_have_no_content',
   'a folder with a blob');

-- A live file must have content.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000c6',
            'a0000000-0000-0000-0000-0000000000a2', '\xda7a06'::bytea, nh('emptyfile'),
            'ac000000-0000-0000-0000-000000000001', 'file', now(), 3,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, '23514', 'live_files_have_content',
   'a live file with no blob');

-- A node cannot be its own parent.
SELECT expect_fail($$
    UPDATE nodes SET parent_id = 'a0000000-0000-0000-0000-0000000000a2'
     WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
       AND id = 'a0000000-0000-0000-0000-0000000000a2'
$$, '23514', 'node_is_not_its_own_parent',
   'a node parented to itself');

-- Type is immutable.
SELECT expect_fail($$
    UPDATE nodes SET type = 'file'
     WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
       AND id = 'a0000000-0000-0000-0000-0000000000a2'
$$, '23001', 'cannot change type',
   'a folder becoming a file');

-- The parent link stays inside one vault: a child cannot point at a parent id that only
-- exists in another vault.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b9',
            'a0000000-0000-0000-0000-0000000000a4', '\xbb09'::bytea, nh('crossvault'),
            'bc000000-0000-0000-0000-000000000001', 'folder', now(), 2,
            ARRAY['a0000000-0000-0000-0000-0000000000a4']::uuid[])
$$, '23503', 'nodes_vault_id_parent_id_fkey',
   'a child whose parent (a4) lives only in Alice''s vault');

-- ---- cycles and ancestry
SELECT expect_ok($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000d1',
            'a0000000-0000-0000-0000-0000000000a2', '\xda7a10'::bytea, nh('Sub'),
            'ac000000-0000-0000-0000-000000000001', 'folder', now(), 5,
            ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, 'a subfolder');

-- Moving a folder under its own descendant is a cycle.
SELECT expect_fail($$
    UPDATE nodes SET parent_id = 'a0000000-0000-0000-0000-0000000000d1'
     WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
       AND id = 'a0000000-0000-0000-0000-0000000000a2'
$$, '23514', 'own descendant',
   'moving a folder under its own child');

-- A sibling folder to move things under.
SELECT expect_ok($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a5',
            'a0000000-0000-0000-0000-0000000000a1', '\xda7a20'::bytea, nh('Other'),
            'ac000000-0000-0000-0000-000000000001', 'folder', now(), 6,
            ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[])
$$, 'a sibling folder');

-- A move that rewrites the node but forgets a descendant's ancestry is caught at commit.
-- Move a2 under a5 (a2.ancestry becomes {a1,a5}) but leave its children claiming {a1,a2}.
SELECT expect_fail($$
    DO $inner$
    BEGIN
        SET CONSTRAINTS nodes_ancestry_matches_parents IMMEDIATE;   -- drain clean fixtures
        SET CONSTRAINTS nodes_ancestry_matches_parents DEFERRED;
        UPDATE nodes SET parent_id = 'a0000000-0000-0000-0000-0000000000a5',
                         ancestry = ARRAY['a0000000-0000-0000-0000-0000000000a1',
                                          'a0000000-0000-0000-0000-0000000000a5']::uuid[]
         WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
           AND id = 'a0000000-0000-0000-0000-0000000000a2';
        SET CONSTRAINTS nodes_ancestry_matches_parents IMMEDIATE;   -- only a2's event pending
    END $inner$
$$, '23514', 'stale ancestry',
   'a move that forgot to rewrite a descendant');

-- ============================================================ blobs

SELECT expect_fail($$
    INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
    VALUES (sha256('hello'::bytea), 'de000000-0000-0000-0000-000000000001', '\x01'::bytea)
$$, '23503', 'blob_keys_scope_id_fkey',
   'a blob envelope under an unregistered scope');

SELECT expect_fail($$
    INSERT INTO dedup_index (scope_id, content_tag, sha256)
    VALUES ('de000000-0000-0000-0000-000000000001', nh('unregistered'), sha256('hello'::bytea))
$$, '23503', 'dedup_index_scope_id_fkey',
   'a deduplication tag under an unregistered scope');

-- A blob's identity is immutable.
SELECT expect_fail($$
    UPDATE blobs SET size = 99 WHERE sha256 = sha256('hello'::bytea)
$$, '23001', 'blob identity is immutable',
   'changing the size of a stored blob');

-- The collector may still mark and unmark.
SELECT expect_ok($$
    UPDATE blobs SET gc_marked_at = now() WHERE sha256 = sha256('hello'::bytea)
$$, 'the collector may mark a blob');
SELECT expect_ok($$
    UPDATE blobs SET gc_marked_at = NULL WHERE sha256 = sha256('hello'::bytea)
$$, 'and unmark it');

-- enc_alg/key_id are mandatory: there is no plaintext blob (E2EE always).
SELECT expect_fail($$
    INSERT INTO blobs (sha256, size, storage_key, key_id)
    VALUES (sha256('nope'::bytea), 3, 'zz/zz/nope', 'ce000000-0000-0000-0000-000000000002')
$$, '23502', 'enc_alg',
   'a blob with no enc_alg');

INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
VALUES (sha256('private-write'::bytea), 13, 'ab/cd/private-write', 'xchacha20-poly1305',
        'ce000000-0000-0000-0000-000000000003');

SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b9',
            'a0000000-0000-0000-0000-0000000000a2', '\xbb09'::bytea, nh('private-write'),
            'bc000000-0000-0000-0000-000000000001', 'file', sha256('private-write'::bytea), 13, now(), 5,
            ARRAY['b0000000-0000-0000-0000-0000000000b1',
                  'a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, '23514', 'vault envelope and dedup tag',
   'a private node write without KV material');

INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
VALUES (sha256('private-write'::bytea), 'bc000000-0000-0000-0000-000000000001', '\xbeef'::bytea);
INSERT INTO dedup_index (scope_id, content_tag, sha256)
VALUES ('bc000000-0000-0000-0000-000000000001', nh('bob-private-tag'), sha256('private-write'::bytea));

SELECT expect_ok($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b9',
            'a0000000-0000-0000-0000-0000000000a2', '\xbb09'::bytea, nh('private-write'),
            'bc000000-0000-0000-0000-000000000001', 'file', sha256('private-write'::bytea), 13, now(), 5,
            ARRAY['b0000000-0000-0000-0000-0000000000b1',
                  'a0000000-0000-0000-0000-0000000000a2']::uuid[])
$$, 'a private node write with its KV material');

-- ---- user_blobs (per-account quota)
SELECT expect_ok($$
    INSERT INTO user_blobs (user_id, sha256, refs_own)
    VALUES ('11111111-1111-1111-1111-111111111111', sha256('hello'::bytea), 1)
$$, 'a blob held by the account');

SELECT expect_fail($$
    INSERT INTO user_blobs (user_id, sha256, refs_own, refs_pending)
    VALUES ('22222222-2222-2222-2222-222222222222', sha256('hello'::bytea), 0, 0)
$$, '23514', 'row_must_be_referenced',
   'a user_blobs row with no references');

INSERT INTO users (id, login, quota_bytes, state, invite_token_hash, invite_expires_at)
VALUES ('66666666-6666-6666-6666-666666666666', 'inactive-writer', 10000000,
        'provisioned', 'writer-token', now() + interval '1 day');

SELECT expect_fail($$
    INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a4', 1,
            sha256('hello'::bytea), 5, '66666666-6666-6666-6666-666666666666')
$$, '23001', 'only an active account or the tombstone may be named as author',
   'a provisioned account writing a version');

-- ---- the seed: two rows the schema creates because nothing else can
SELECT expect_ok($$
    DO $inner$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM users
                        WHERE id = '00000000-0000-0000-0000-000000000000'
                          AND state = 'tombstone' AND login = 'deleted') THEN
            RAISE EXCEPTION 'the tombstone was not seeded';
        END IF;
        -- No token and no password (#107, #115): there is nothing to redeem here, only a
        -- password to create, and creating it is what makes the row usable. A seeded
        -- password would keep working if nobody changed it.
        IF NOT EXISTS (SELECT 1 FROM users
                        WHERE id = '00000000-0000-0000-0000-000000000001'
                          AND state = 'provisioned' AND role = 'admin'
                          AND password_hash IS NULL AND invite_token_hash IS NULL) THEN
            RAISE EXCEPTION 'the bootstrap administrator was not seeded';
        END IF;
    END $inner$
$$, 'the schema seeds the tombstone and the bootstrap administrator');

SELECT expect_ok($$
    INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id)
    VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a4', 1,
            sha256('hello'::bytea), 5, '00000000-0000-0000-0000-000000000000')
$$, 'the tombstone may be named as author — otherwise anonymisation blocks on its own guard');

SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, wrapped_seed)
    VALUES ('dd000000-0000-0000-0000-0000000000de', 'deleted-2', 1, 'tombstone', '\x04'::bytea)
$$, '23514', 'keys_match_state',
   'a tombstone carrying key material');

SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state)
    VALUES ('dd000000-0000-0000-0000-0000000000df', 'deleted-3', 1, 'tombstone')
$$, '23505', 'users_single_tombstone',
   'a second tombstone');

SELECT expect_fail($$
    INSERT INTO users (id, login, quota_bytes, state, invite_token_hash, invite_expires_at)
    VALUES ('dd000000-0000-0000-0000-0000000000e0', 'DELETED', 1,
            'provisioned', 'tok', now() + interval '1 day')
$$, '23505', 'users_login_key',
   'an account taking the tombstone login — seeding it is what reserves it');

SELECT expect_fail($$
    UPDATE users SET state = 'active' WHERE id = '00000000-0000-0000-0000-000000000000'
$$, '23001', 'the tombstone account is permanent',
   'reviving the tombstone');

SELECT expect_fail($$
    DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000000'
$$, '23001', 'the tombstone account is permanent',
   'deleting the tombstone');

-- ============================================================ logs are append-only

INSERT INTO journal (vault_id, rev, node_id, op, node_rev)
VALUES ('aa000000-0000-0000-0000-000000000001', 1,
        'a0000000-0000-0000-0000-0000000000a4', 'put', 4);

SELECT expect_fail($$
    UPDATE journal SET op = 'del'
     WHERE vault_id = 'aa000000-0000-0000-0000-000000000001' AND rev = 1
$$, '23001', 'journal is append-only',
   'an UPDATE on the delta journal');

SELECT expect_fail($$
    INSERT INTO journal (vault_id, rev, node_id, op)
    VALUES ('aa000000-0000-0000-0000-000000000001', 2,
            'a0000000-0000-0000-0000-0000000000a4', 'move')
$$, '23514', 'move_carries_prev_parent',
   'a move journal row without prev_parent_id');

SELECT expect_fail($$
    INSERT INTO journal (vault_id, rev, node_id, op)
    VALUES ('aa000000-0000-0000-0000-000000000001', 3,
            'a0000000-0000-0000-0000-0000000000a4', 'put')
$$, '23514', 'put_carries_node_rev',
   'a put journal row without node_rev');

SELECT expect_fail($$
    DO $inner$
    BEGIN
        UPDATE nodes SET rev = 101
         WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
           AND id = 'a0000000-0000-0000-0000-0000000000a5';
        SET CONSTRAINTS nodes_revision_within_vault_head IMMEDIATE;
    END $inner$
$$, '23514', 'beyond its head revision',
   'a node revision beyond its vault head revision');

-- ============================================================ sharing

-- Alice shares /Research (a2). She is a participant of her own share, the first one, in
-- her own vault. Her marked nodes are the replica in her vault.
-- Preparation marks the full subtree, then activation requires KS names plus envelope/tag.
INSERT INTO key_scopes (id, kind)
VALUES ('ce000000-0000-0000-0000-0000000000c1', 'share');
INSERT INTO shares (id, initiator_id, initiator_vault_id, subtree_node_id, state, root_item_id,
                    subtree_key_id, subtree_key_scope_kind, wrapped_key_initiator)
VALUES ('c0000000-0000-0000-0000-0000000000c1',
        '11111111-1111-1111-1111-111111111111',
        'aa000000-0000-0000-0000-000000000001',
         'a0000000-0000-0000-0000-0000000000a2', 'preparing',
        'e0000000-0000-0000-0000-0000000000e1',
         'ce000000-0000-0000-0000-0000000000c1', 'share', '\xdead'::bytea);

INSERT INTO share_members (share_id, user_id, vault_id, joined_at)
VALUES ('c0000000-0000-0000-0000-0000000000c1',
        '11111111-1111-1111-1111-111111111111',
        'aa000000-0000-0000-0000-000000000001', now());

UPDATE nodes SET share_id = 'c0000000-0000-0000-0000-0000000000c1',
                 share_item_id = 'e0000000-0000-0000-0000-0000000000e1'
 WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
   AND id = 'a0000000-0000-0000-0000-0000000000a2';
UPDATE nodes SET share_id = 'c0000000-0000-0000-0000-0000000000c1',
                 share_item_id = 'e0000000-0000-0000-0000-0000000000e2'
 WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
   AND id = 'a0000000-0000-0000-0000-0000000000a4';
UPDATE nodes SET share_id = 'c0000000-0000-0000-0000-0000000000c1',
                 share_item_id = 'e0000000-0000-0000-0000-0000000000e3'
 WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
   AND id = 'a0000000-0000-0000-0000-0000000000d1';
-- a3 is the soft-deleted first note.md, still a child of the shared folder; a shared
-- folder is shared in full, deleted nodes included, so it carries a mark too.
UPDATE nodes SET share_id = 'c0000000-0000-0000-0000-0000000000c1',
                 share_item_id = 'e0000000-0000-0000-0000-0000000000e4'
 WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
   AND id = 'a0000000-0000-0000-0000-0000000000a3';

UPDATE nodes SET name_key_id = 'ce000000-0000-0000-0000-0000000000c1'
 WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
   AND share_id = 'c0000000-0000-0000-0000-0000000000c1'
   AND share_item_id <> 'e0000000-0000-0000-0000-0000000000e1';
INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
VALUES (sha256('hello'::bytea), 'ce000000-0000-0000-0000-0000000000c1', '\xbeef'::bytea);
INSERT INTO dedup_index (scope_id, content_tag, sha256)
VALUES ('ce000000-0000-0000-0000-0000000000c1', nh('hello-tag'), sha256('hello'::bytea));
UPDATE shares SET state = 'active' WHERE id = 'c0000000-0000-0000-0000-0000000000c1';

-- ---- a share must be rooted at a live folder of the initiator's own vault
SELECT expect_fail($$
    INSERT INTO shares (initiator_id, initiator_vault_id, subtree_node_id)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'aa000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-0000000000a4')
$$, '23514', 'must be rooted at a folder',
   'a share rooted at a file');

-- A vault that is not the initiator's cannot root their share.
SELECT expect_fail($$
    INSERT INTO shares (initiator_id, initiator_vault_id, subtree_node_id)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'bb000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-0000000000b1')
$$, '23503', 'shares_initiator_id_initiator_vault_id_fkey',
   'a share over a vault the initiator does not own');

-- ---- Bob joins, into HIS vault, and replicates the folder
SELECT expect_ok($$
    INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
    VALUES ('c0000000-0000-0000-0000-0000000000c1',
            '22222222-2222-2222-2222-222222222222',
            'bb000000-0000-0000-0000-000000000001', now(), '\xbeef'::bytea)
$$, 'a participant joins into their chosen vault');

SELECT expect_fail($$
    DELETE FROM share_members
     WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
       AND user_id = '22222222-2222-2222-2222-222222222222'
$$, '23001', 'before finalization completes and marks clear',
   'deleting a live membership directly');

-- An UNACCEPTED invitation is the exception, and it must be: joined_at IS NULL forbids
-- both finalization_started_at and left_at, so without the exemption the row could never
-- be removed and decline/withdraw would be unimplementable (the slot would leak).
INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                   pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
VALUES ('77777777-7777-7777-7777-777777777777', 'erin', 'active', 'h',
        '\x0f0e0d0c0b0a09080706050403020100'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
        '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea, 10000000);

SELECT expect_ok($$
    INSERT INTO share_members (share_id, user_id)
    VALUES ('c0000000-0000-0000-0000-0000000000c1',
            '77777777-7777-7777-7777-777777777777')
$$, 'an invitation carries no vault and no key');

SELECT expect_ok($$
    DELETE FROM share_members
     WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
       AND user_id = '77777777-7777-7777-7777-777777777777'
$$, 'declining or withdrawing an unaccepted invitation removes the row');

SELECT expect_fail($$
    UPDATE shares SET initiator_id = '22222222-2222-2222-2222-222222222222'
     WHERE id = 'c0000000-0000-0000-0000-0000000000c1'
$$, '23001', 'initiator and initiator vault are immutable',
   'changing a share initiator');

SELECT expect_fail($$
    UPDATE shares SET initiator_vault_id = 'ae000000-0000-0000-0000-000000000008'
     WHERE id = 'c0000000-0000-0000-0000-0000000000c1'
$$, '23001', 'initiator and initiator vault are immutable',
   'changing a share initiator vault');

INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                   share_id, share_item_id)
VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b2',
        'b0000000-0000-0000-0000-0000000000b1', '\xbb02'::bytea, nh('Research'),
         'bc000000-0000-0000-0000-000000000001', 'folder', now(), 3,
        ARRAY['b0000000-0000-0000-0000-0000000000b1']::uuid[],
        'c0000000-0000-0000-0000-0000000000c1',
        'e0000000-0000-0000-0000-0000000000e1');

INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry,
                   share_id, share_item_id)
VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b3',
        'b0000000-0000-0000-0000-0000000000b2', '\xbb03'::bytea, nh('note.md'),
         'ce000000-0000-0000-0000-0000000000c1', 'file', sha256('hello'::bytea), 5, now(), 4,
        ARRAY['b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b2']::uuid[],
        'c0000000-0000-0000-0000-0000000000c1',
         'e0000000-0000-0000-0000-0000000000e2');

INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
VALUES (sha256('late-share-write'::bytea), 16, 'ab/cd/late-share-write', 'xchacha20-poly1305',
        'ce000000-0000-0000-0000-000000000002');
SELECT expect_fail($$
    UPDATE nodes SET sha256 = sha256('late-share-write'::bytea), size = 16
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23514', 'needs its share envelope and dedup tag',
   'a late active-share node write without KS material');

SELECT expect_fail($$
    UPDATE nodes SET name_key_id = 'bc000000-0000-0000-0000-000000000001'
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23514', 'active shared node',
   'an active shared interior name under the vault key');

-- A participant cannot re-share their replica.
SELECT expect_fail($$
    INSERT INTO shares (initiator_id, initiator_vault_id, subtree_node_id)
    VALUES ('22222222-2222-2222-2222-222222222222',
            'bb000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-0000000000b2')
$$, '23514', 'cannot be re-shared',
   'a participant re-shares their own replica');

-- ---- the shared identity: both halves or neither
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry, share_id)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b4',
            'b0000000-0000-0000-0000-0000000000b2', '\xbb04'::bytea, nh('Half'),
             'ce000000-0000-0000-0000-0000000000c1', 'folder', now(), 5,
            ARRAY['b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b2']::uuid[],
            'c0000000-0000-0000-0000-0000000000c1')
$$, '23514', 'share_pair_travels_together',
   'a node in a share with no item id');

-- Two nodes of one vault for the same shared item.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                       share_id, share_item_id)
    VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b5',
            'b0000000-0000-0000-0000-0000000000b2', '\xbb05'::bytea, nh('Twin'),
             'ce000000-0000-0000-0000-0000000000c1', 'folder', now(), 5,
            ARRAY['b0000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-0000000000b2']::uuid[],
            'c0000000-0000-0000-0000-0000000000c1',
            'e0000000-0000-0000-0000-0000000000e2')
$$, '23505', 'nodes_one_replica_per_item',
   'two nodes of one vault for the same shared item');

-- ---- a share mark is verified: an outsider node cannot claim a share it is not in
SELECT expect_fail($$
    DO $inner$
    BEGIN
        INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                           share_id, share_item_id)
        VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000f1',
                'a0000000-0000-0000-0000-0000000000a1', '\xda7af1'::bytea, nh('Impostor'),
                 'ce000000-0000-0000-0000-0000000000c1', 'folder', now(), 12,
                ARRAY['a0000000-0000-0000-0000-0000000000a1']::uuid[],
                'c0000000-0000-0000-0000-0000000000c1',
                'e0000000-0000-0000-0000-00000000000f');
        SET CONSTRAINTS nodes_share_membership_is_real IMMEDIATE;
    END $inner$
$$, '23514', 'its parent is not in it',
   'a node outside the shared folder claiming to be in it');

-- A non-participant cannot hold a replica: an account that never joined.
SELECT expect_fail($$
    DO $inner$
    BEGIN
        INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                           share_id, share_item_id)
        VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b8',
                'b0000000-0000-0000-0000-0000000000b1', '\xbb08'::bytea, nh('Stolen'),
                 'bc000000-0000-0000-0000-000000000001', 'folder', now(), 6,
                ARRAY['b0000000-0000-0000-0000-0000000000b1']::uuid[],
                'cc000000-0000-0000-0000-0000000000cc',
                'e0000000-0000-0000-0000-0000000000e1');
        SET CONSTRAINTS nodes_share_membership_is_real IMMEDIATE;
    END $inner$
$$, '23503', 'nodes_share_fkey',
   'a replica pointing at a share that does not exist');

-- ---- a shared folder is shared in full: no unmarked node inside it (SH-26)
SELECT expect_fail($$
    DO $inner$
    BEGIN
        SET CONSTRAINTS nodes_share_membership_is_real IMMEDIATE;   -- drain the clean ones
        INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, sha256, size, mtime, rev, ancestry)
        VALUES ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000f2',
                'a0000000-0000-0000-0000-0000000000a2', '\xda7af2'::bytea, nh('sneaked'),
                'ac000000-0000-0000-0000-000000000001', 'file', sha256('hello'::bytea), 5, now(), 13,
                ARRAY['a0000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-0000000000a2']::uuid[]);
        SET CONSTRAINTS nodes_share_membership_is_real IMMEDIATE;
    END $inner$
$$, '23514', 'carries no share mark',
   'an unmarked node created inside a shared folder');

-- ---- the replica must sit in the vault the participant chose
SELECT expect_fail($$
    DO $inner$
    BEGIN
        SET CONSTRAINTS nodes_share_membership_is_real IMMEDIATE;
        -- Bob owns a second vault, but his replica of this share lives in the first.
        INSERT INTO key_scopes (id, kind)
        VALUES ('bc000000-0000-0000-0000-000000000002', 'vault');
        INSERT INTO vaults (id, user_id, root_node_id, name_enc, vault_key_id)
        VALUES ('bb000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
                'b2000000-0000-0000-0000-0000000000b1',
                '\xbb'::bytea, 'bc000000-0000-0000-0000-000000000002');
        INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, mtime, rev)
        VALUES ('bb000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-0000000000b1',
                NULL, NULL, NULL, 'folder', now(), 0);
        INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                           share_id, share_item_id)
        VALUES ('bb000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-0000000000b2',
                'b2000000-0000-0000-0000-0000000000b1', '\xbb22'::bytea, nh('Wrong'),
                 'bc000000-0000-0000-0000-000000000002', 'folder', now(), 1,
                ARRAY['b2000000-0000-0000-0000-0000000000b1']::uuid[],
                'c0000000-0000-0000-0000-0000000000c1',
                'e0000000-0000-0000-0000-0000000000e1');
        SET CONSTRAINTS nodes_share_membership_is_real IMMEDIATE;
    END $inner$
$$, '23514', 'did not choose',
   'a replica placed in a vault the participant did not pick for the share');

-- ---- membership
SELECT expect_fail($$
    UPDATE share_members SET finalization_started_at = now()
     WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
        AND user_id  = '11111111-1111-1111-1111-111111111111'
$$, '23001', 'initiator cannot leave',
   'the initiator leaves instead of ending the share');

SELECT expect_fail($$
    UPDATE share_members SET left_at = now()
     WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
       AND user_id  = '22222222-2222-2222-2222-222222222222'
$$, '23001', 'cannot leave before finalization starts',
   'setting left_at before the leave metadata pass begins');

-- ---- over quota freezes the whole account (SH-20)
-- A plain, unmarked node of the same account, created before the freeze: it is what
-- proves the own-content arm of the rule.
UPDATE vaults SET head_rev = 7 WHERE id = 'bb000000-0000-0000-0000-000000000001';

INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000ba',
        'b0000000-0000-0000-0000-0000000000b1', '\xbb0a'::bytea, nh('Private'),
        'bc000000-0000-0000-0000-000000000001', 'folder', now(), 6,
        ARRAY['b0000000-0000-0000-0000-0000000000b1']::uuid[]);

SELECT expect_ok($$
    UPDATE users SET frozen_at = now()
     WHERE id = '22222222-2222-2222-2222-222222222222'
$$, 'an account freezes at the quota');

SELECT expect_fail($$
    UPDATE nodes SET mtime = now(), rev = 99
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23001', 'their copy does not move until the freeze lifts',
   'a write into a frozen account''s replica');

-- Own content: growth is refused, but deleting must stay possible — it is the only way
-- out of over-quota, so a freeze that blocked it would deadlock the account.
SELECT expect_fail($$
    INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id,
                       type, sha256, size, mtime, rev)
    VALUES ('bb000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-0000000000b1',
            '\x99'::bytea, sha256('frozen-new'::bytea),
            'bc000000-0000-0000-0000-000000000001',
            'file', sha256('hello'::bytea), 5, now(), 1)
$$, '23001', 'nothing that grows usage may be sent until the freeze lifts',
   'a frozen account creating a node in its own vault');

SELECT expect_ok($$
    UPDATE nodes SET deleted_at = now(), rev = 7
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000ba'
$$, 'a frozen account may still delete, which is how it gets out');

SELECT expect_ok($$
    UPDATE users SET frozen_at = NULL
     WHERE id = '22222222-2222-2222-2222-222222222222'
$$, 'the freeze lifts');

-- ---- unmarking drops an added participant's history (SH-22), keeps the initiator's (SH-25)
--
-- The superseded revision is a DIFFERENT blob from the head, which is what an edit made
-- inside a share actually leaves behind, and it carries KS material alone — the only scope
-- that existed when it was written.
INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
VALUES (sha256('older'::bytea), 5, 'ab/cd/older', 'xchacha20-poly1305',
        'ce000000-0000-0000-0000-000000000002');
INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
VALUES (sha256('older'::bytea), 'ce000000-0000-0000-0000-0000000000c1', '\xbeef'::bytea);
INSERT INTO dedup_index (scope_id, content_tag, sha256)
VALUES ('ce000000-0000-0000-0000-0000000000c1', nh('older-ks-tag'), sha256('older'::bytea));

INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id)
VALUES ('bb000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b3', 1,
        sha256('older'::bytea), 5, '11111111-1111-1111-1111-111111111111');

SELECT expect_fail($$
    UPDATE nodes SET share_id = NULL, share_item_id = NULL,
                     name_key_id = 'bc000000-0000-0000-0000-000000000001'
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23001', 'outside its member finalization',
   'unmarking before the affected member starts finalization');

-- Leave/revoke stops propagation first.  The resulting durable state authorises only this
-- member's later metadata pass; it is not itself a completed departure.
SELECT expect_ok($$
    UPDATE share_members SET finalization_started_at = now()
     WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
       AND user_id  = '22222222-2222-2222-2222-222222222222'
$$, 'leaving starts a member finalization and stops propagation');

SELECT expect_fail($$
    UPDATE nodes SET share_id = NULL, share_item_id = NULL,
                     name_key_id = 'bc000000-0000-0000-0000-000000000001'
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23514', 'vault envelope',
   'unmarking before the client supplies the KV envelope');

-- The head alone is not enough. A superseded revision was written under KS and only KS, so
-- it owes a KV envelope of its own — and asking for the head's is how a live vault got stuck
-- on a blob its owner could not see, one edit behind the file in front of them.
INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
VALUES (sha256('hello'::bytea), 'bc000000-0000-0000-0000-000000000001', '\xbeef'::bytea);

SELECT expect_fail($$
    UPDATE nodes SET share_id = NULL, share_item_id = NULL,
                     name_key_id = 'bc000000-0000-0000-0000-000000000001'
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23514', 'vault envelope',
   'unmarking with the head converted but its history left under the share key');

INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
VALUES (sha256('older'::bytea), 'bc000000-0000-0000-0000-000000000001', '\xbeef'::bytea);

-- Envelopes complete, tag still missing: the two halves are separate rules, because only
-- one of them can be produced without the plaintext.
SELECT expect_fail($$
    UPDATE nodes SET share_id = NULL, share_item_id = NULL,
                     name_key_id = 'bc000000-0000-0000-0000-000000000001'
     WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
       AND id = 'b0000000-0000-0000-0000-0000000000b3'
$$, '23514', 'vault dedup tag',
   'unmarking before the client supplies the KV dedup tag for the live head');

-- A tag for the HEAD only. The superseded revision never gets one: it is not on the leaving
-- device's disk, and deduplication asks "have I uploaded this before", which it will not.
INSERT INTO dedup_index (scope_id, content_tag, sha256)
VALUES ('bc000000-0000-0000-0000-000000000001', nh('bob-leave-tag'), sha256('hello'::bytea));

SELECT expect_fail($$
    DO $inner$
    BEGIN
         UPDATE nodes SET share_id = NULL, share_item_id = NULL,
                          name_key_id = 'bc000000-0000-0000-0000-000000000001'
         WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
           AND id = 'b0000000-0000-0000-0000-0000000000b3';
        SET CONSTRAINTS nodes_unmark_drops_history IMMEDIATE;
    END $inner$
$$, '23001', 'keeps the files alone',
   'an added participant unmarks a replica that still carries history');

SELECT expect_ok($$
    DO $inner$
    BEGIN
        DELETE FROM versions WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
                               AND node_id = 'b0000000-0000-0000-0000-0000000000b3';
         UPDATE nodes SET share_id = NULL, share_item_id = NULL,
                          name_key_id = 'bc000000-0000-0000-0000-000000000001'
         WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
           AND id = 'b0000000-0000-0000-0000-0000000000b3';
        SET CONSTRAINTS nodes_unmark_drops_history IMMEDIATE;
        SET CONSTRAINTS nodes_unmark_drops_history DEFERRED;
    END $inner$
$$, 'with the history dropped, the replica becomes an ordinary file');

-- ---- leaving requires the marks cleared first
SELECT expect_fail($$
    UPDATE share_members SET left_at = now()
     WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
       AND user_id  = '22222222-2222-2222-2222-222222222222'
$$, '23001', 'clear the marks before leaving',
   'leaving while the replica still carries the share marks');

SELECT expect_ok($$
    DO $inner$
    BEGIN
        UPDATE nodes SET share_id = NULL, share_item_id = NULL
         WHERE vault_id = 'bb000000-0000-0000-0000-000000000001'
           AND share_id = 'c0000000-0000-0000-0000-0000000000c1';
        UPDATE share_members SET left_at = now()
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
           AND user_id  = '22222222-2222-2222-2222-222222222222';
    END $inner$
$$, 'the replica becomes ordinary content, then the participant leaves');

SELECT expect_ok($$
    DO $inner$
    BEGIN
        DELETE FROM share_members
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c1'
           AND user_id  = '22222222-2222-2222-2222-222222222222';
        INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
        VALUES ('c0000000-0000-0000-0000-0000000000c1',
                '22222222-2222-2222-2222-222222222222',
                'bb000000-0000-0000-0000-000000000001', now(), '\x06'::bytea);
    END $inner$
$$, 'and is invited back as a fresh membership');

-- ---- the ceiling (SH-11)
SELECT expect_ok($$
    DO $inner$
    DECLARE i integer;
    BEGIN
        FOR i IN 1..6 LOOP
            INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                                pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
            VALUES (('90000000-0000-0000-0000-00000000000' || i)::uuid,
                    'crowd' || i, 'active', 'x',
                    '\x99999999999999999999999999999999'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
                     '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea, 1000);
            INSERT INTO key_scopes (id, kind)
            VALUES (('9c000000-0000-0000-0000-00000000000' || i)::uuid, 'vault');
            INSERT INTO vaults (id, user_id, root_node_id, vault_key_id)
            VALUES (('99000000-0000-0000-0000-00000000000' || i)::uuid,
                    ('90000000-0000-0000-0000-00000000000' || i)::uuid,
                    ('91000000-0000-0000-0000-00000000000' || i)::uuid,
                    ('9c000000-0000-0000-0000-00000000000' || i)::uuid);
            INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, mtime, rev)
            VALUES (('99000000-0000-0000-0000-00000000000' || i)::uuid,
                    ('91000000-0000-0000-0000-00000000000' || i)::uuid,
                    NULL, NULL, NULL, 'folder', now(), 0);
            INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
            VALUES ('c0000000-0000-0000-0000-0000000000c1',
                    ('90000000-0000-0000-0000-00000000000' || i)::uuid,
                    ('99000000-0000-0000-0000-00000000000' || i)::uuid, now(), '\xbeef'::bytea);
        END LOOP;
    END $inner$
$$, 'a share fills up to eight participants');

SELECT expect_fail($$
    DO $inner$
    BEGIN
        INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                            pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
        VALUES ('90000000-0000-0000-0000-000000000009', 'crowd9', 'active', 'x',
                '\x99999999999999999999999999999999'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
                '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea, 1000);
        INSERT INTO key_scopes (id, kind)
        VALUES ('9c000000-0000-0000-0000-000000000009', 'vault');
        INSERT INTO vaults (id, user_id, root_node_id, vault_key_id)
        VALUES ('99000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000009',
                '91000000-0000-0000-0000-000000000009',
                '9c000000-0000-0000-0000-000000000009');
        INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
        VALUES ('c0000000-0000-0000-0000-0000000000c1',
                '90000000-0000-0000-0000-000000000009',
                '99000000-0000-0000-0000-000000000009', now(), '\xbeef'::bytea);
    END $inner$
$$, '23514', 'at most 8 participants',
   'a ninth participant');

-- ---- an e2ee share needs a key; joining needs an envelope
INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                    pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
VALUES ('55555555-5555-5555-5555-555555555555', 'frank', 'active', 'x',
        '\x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'::bytea, '{"v":19,"m":65536,"t":3,"p":1}',
         '\x01'::bytea, '\x02'::bytea, 'kv', '\x03'::bytea, 'rh', '\x04'::bytea, 10000000);
INSERT INTO key_scopes (id, kind)
VALUES ('fc000000-0000-0000-0000-000000000001', 'vault');
INSERT INTO vaults (id, user_id, root_node_id, vault_key_id, head_rev)
VALUES ('ff000000-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
        'f0000000-0000-0000-0000-0000000000f1',
        'fc000000-0000-0000-0000-000000000001', 1);
INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, type, mtime, rev)
VALUES ('ff000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000f1',
        NULL, NULL, NULL, 'folder', now(), 0);
INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
VALUES ('ff000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000f2',
        'f0000000-0000-0000-0000-0000000000f1', '\xffee'::bytea, nh('secret'),
        'fc000000-0000-0000-0000-000000000001', 'folder', now(), 1,
        ARRAY['f0000000-0000-0000-0000-0000000000f1']::uuid[]);

SELECT expect_fail($$
    INSERT INTO shares (initiator_id, initiator_vault_id, subtree_node_id, state)
    VALUES ('55555555-5555-5555-5555-555555555555',
            'ff000000-0000-0000-0000-000000000001',
            'f0000000-0000-0000-0000-0000000000f2', 'active')
$$, '23514', 'must carry a share key',
   'an active e2ee share with no key');

-- 'preparing' without a key is legitimate; the initiator joins while preparing.
SELECT expect_ok($$
    DO $inner$
    BEGIN
        INSERT INTO shares (id, initiator_id, initiator_vault_id, subtree_node_id, state, root_item_id)
        VALUES ('c0000000-0000-0000-0000-0000000000c2',
                '55555555-5555-5555-5555-555555555555',
                'ff000000-0000-0000-0000-000000000001',
                'f0000000-0000-0000-0000-0000000000f2', 'preparing',
                'e0000000-0000-0000-0000-0000000000f2');
        INSERT INTO share_members (share_id, user_id, vault_id, joined_at)
        VALUES ('c0000000-0000-0000-0000-0000000000c2',
                '55555555-5555-5555-5555-555555555555',
                'ff000000-0000-0000-0000-000000000001', now());
        UPDATE nodes SET share_id = 'c0000000-0000-0000-0000-0000000000c2',
                         share_item_id = 'e0000000-0000-0000-0000-0000000000f2'
         WHERE vault_id = 'ff000000-0000-0000-0000-000000000001'
           AND id = 'f0000000-0000-0000-0000-0000000000f2';
    END $inner$
$$, 'an e2ee share still preparing, key not yet made');

SELECT expect_fail($$
    UPDATE shares SET state = 'active'
     WHERE id = 'c0000000-0000-0000-0000-0000000000c2'
$$, '23514', 'must carry a share key',
   'preparation finishing without a key');

-- Inviting is blocked by the same states as joining: while preparing, the interior names
-- are not yet under KS, so an invitee could not read what they were handed.
SELECT expect_fail($$
    INSERT INTO share_members (share_id, user_id)
    VALUES ('c0000000-0000-0000-0000-0000000000c2',
            '22222222-2222-2222-2222-222222222222')
$$, '23514', 'may only be invited to while it is active',
   'inviting into a share that is still preparing');

-- ============================================================ reset (per vault, hard)

-- The root of a live share cannot be soft-deleted; end the share first.
SELECT expect_fail($$
    UPDATE nodes SET deleted_at = now()
     WHERE vault_id = 'aa000000-0000-0000-0000-000000000001'
       AND id = 'a0000000-0000-0000-0000-0000000000a2'
$$, '23001', 'root of a live share',
   'soft-delete the root of a live share');

-- ---- ending a share: nobody may still be in it at commit
SELECT expect_fail($$
    DO $inner$
    BEGIN
         UPDATE shares SET state = 'cancelled', terminal_at = now()
         WHERE id = 'c0000000-0000-0000-0000-0000000000c2';
        SET CONSTRAINTS shares_ended_leaves_nobody IMMEDIATE;
    END $inner$
$$, '23514', 'is still a participant',
   'cancelling a share while someone is still in it');

-- An ended share never comes back.
SELECT expect_fail($$
    DO $inner$
    BEGIN
        UPDATE shares SET state = 'cancelled', terminal_at = now()
         WHERE id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE share_members SET finalization_started_at = now()
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE nodes SET share_id = NULL, share_item_id = NULL
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE share_members SET left_at = now()
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE shares SET state = 'preparing'
         WHERE id = 'c0000000-0000-0000-0000-0000000000c2';
    END $inner$
$$, '23001', 'terminal; it cannot return',
   'reviving a cancelled share');

-- A live share may not be deleted; it must be ended.
SELECT expect_fail($$
    DELETE FROM shares WHERE id = 'c0000000-0000-0000-0000-0000000000c1'
$$, '23001', 'terminal state',
   'deleting a live share instead of ending it');

-- Collecting a terminal share cascades its completed membership rows; this is distinct
-- from direct membership deletion, which is blocked until finalization is complete.
SELECT expect_ok($$
    DO $inner$
    BEGIN
        UPDATE shares SET state = 'cancelled', terminal_at = now()
         WHERE id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE share_members SET finalization_started_at = now()
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE nodes SET share_id = NULL, share_item_id = NULL
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c2';
        UPDATE share_members SET left_at = now()
         WHERE share_id = 'c0000000-0000-0000-0000-0000000000c2';
        DELETE FROM shares WHERE id = 'c0000000-0000-0000-0000-0000000000c2';
    END $inner$
$$, 'terminal share cleanup cascades completed memberships');

-- ---- the two kinds of account (#115)

-- An administrator with key material is the shape that would have let a browser hold a
-- seed. It is refused, which is what makes "the admin has no key" a fact about the row.
SELECT expect_fail($$
    UPDATE users SET pubkey = ''::bytea WHERE login = 'root'
$$, '23514', 'keys_match_state', 'a console account carrying key material');

-- And the mirror: a vault account with a password would be a second way in, past the one
-- authentication path this server has.
SELECT expect_fail($$
    UPDATE users SET password_hash = '$argon2id$fake' WHERE login = 'alice'
$$, '23514', 'keys_match_state', 'a vault account carrying a console password');

-- An active console account without one cannot exist either: it would be an administrator
-- nobody can sign in as, on a server that answers only to administrators.
SELECT expect_fail($$
    UPDATE users SET password_hash = NULL WHERE login = 'root'
$$, '23514', 'keys_match_state', 'an active console account with no password');

-- The seeded first administrator is the one row allowed to have neither (#107): it is
-- `provisioned`, holds no token because there is nothing to redeem, and becomes usable by
-- having a password CREATED rather than replaced.
SELECT expect_ok($$
    SELECT 1 FROM users
     WHERE id = '00000000-0000-0000-0000-000000000001'
       AND state = 'provisioned' AND role = 'admin'
       AND password_hash IS NULL AND invite_token_hash IS NULL
$$, 'the seeded administrator waits with no password and no token');

-- ============================================================ retention

-- The outer bound of the history ladder is the user's, and it is a length of time: zero
-- days is not "keep nothing", it is a setting that would delete the head of a live file
-- the ladder keeps unconditionally (docs/03).
SELECT expect_fail($$
    UPDATE users SET history_days = 0 WHERE login = 'alice'
$$, '23514', 'users_history_days_check', 'history cannot be kept for no days at all');

SELECT expect_ok($$
    UPDATE users SET history_days = 30 WHERE login = 'alice'
$$, 'an account may keep less history than the default year');

-- A console account administers the server and holds no key material (#115), so there is
-- nothing to seal a share key to. The FK does not catch it — the row exists and is active —
-- which is exactly why this is a trigger and not left to the one code path that knows.
SELECT expect_fail($$
    INSERT INTO share_members (share_id, user_id, wrapped_key)
    SELECT s.id, u.id, '\x01'::bytea FROM shares s, users u
     WHERE u.login = 'root' LIMIT 1
$$, '23514', 'administers the server', 'a console account invited into a share');

-- ============================================================ backup runs

-- The dangerous order (#114), refused by the schema rather than by the one file that knows
-- about it. A run that copied blobs without a database leg behind them is the shape that
-- restores cleanly and cannot open a file — months later, with no way back.
SELECT expect_fail($$
    INSERT INTO backup_runs (window_opened_at, blobs_done_at, destination)
    VALUES (now(), now(), '/backups')
$$, '23514', 'database_leg_first', 'blobs copied with no database leg before them');

SELECT expect_fail($$
    INSERT INTO backup_runs (window_opened_at, blobs_done_at, db_done_at, destination)
    VALUES (now(), now(), now() + interval '1 second', '/backups')
$$, '23514', 'database_leg_first', 'blobs copied before the database was dumped');

SELECT expect_ok($$
    INSERT INTO backup_runs (window_opened_at, db_done_at, blobs_done_at, window_closed_at,
                             finished_at, status, destination)
    VALUES (now(), now(), now(), now(), now(), 'ok', '/backups')
$$, 'database first, blobs second, both inside the window');

-- A leg outside the window is refused whichever side it falls on: a dump taken before the
-- window opened describes an instant the blob copy does not.
SELECT expect_fail($$
    INSERT INTO backup_runs (window_opened_at, db_done_at, destination)
    VALUES (now(), now() - interval '1 minute', '/backups')
$$, '23514', 'legs_inside_the_window', 'a database leg taken before the window opened');

-- ============================================================ deferred checkpoint

-- Everything above ran inside one transaction that ends in ROLLBACK, so a DEFERRED
-- constraint would otherwise never fire. Forcing the check here validates every row the
-- fixtures created, not just the ones a test aimed at.
SELECT expect_ok($$
    SET CONSTRAINTS ALL IMMEDIATE
$$, 'every fixture row is consistent');

-- ============================================================

ROLLBACK;
