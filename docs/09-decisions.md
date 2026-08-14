# 09 — Decision index

One line per decision, so that an id found in a `schema.sql` comment or in another document resolves to the
rule it stands for. The rule's full form — what it covers, how it is enforced — lives in the document that
owns the subject; this file only names it.

Ids are stable and never reused; a gap is a number that no longer names anything. A rule belongs to **one**
id — where a `#N` and an `SH-N` once said the same thing, the `SH-` one kept it, because that is where
sharing behaviour is stated.

Three prefixes appear across the corpus:

| Prefix | Subject | Full form in |
|---|---|---|
| `#N` | the system as a whole | the owning document, listed below |
| `AC-N` | accounts and vaults | [03](03-data-model.md), [06](06-key-model.md) |
| `SH-N` | sharing behaviour | [12](12-sharing-scenarios.md) |

## Foundation

| # | Decision |
|---|---|
| 1 | Metadata separate from content: the tree in PostgreSQL, content as content-addressed blobs |
| 2 | A revision journal plus a cursor, not a directory listing |
| 3 | Optimistic concurrency; a conflict becomes a separate file |
| 4 | No CRDT in the MVP |
| 7 | `.obsidian/` is a separate scope, disabled by default |

## Accounts and vaults

| # | Decision |
|---|---|
| AC-08 | Everything is E2EE: the server reads neither content nor names, for every account and every vault |
| AC-09 | Vault key scopes are independent: two vaults of one account never deduplicate against each other |
| AC-10 | An account holds many vaults; the account is the unit of authentication and quota, the vault the unit of synchronisation |
| AC-11 | A vault key is `HKDF(seed, vault_id)`, where the seed is a stable random secret wrapped under the passphrase — so changing the passphrase re-encrypts nothing |
| AC-12 | The vault is the boundary of the journal and the cursor: `journal` is keyed `(vault_id, rev)` and the cursor names its vault |
| AC-13 | A device belongs to the account and may reach any of its vaults; which it syncs is a client choice, and there is no `device × vault` table |
| AC-14 | A reset acts on one vault, hard-destroys its prior server state, and bumps that vault's `reset_epoch` |
| AC-Q2 | Quota is per account, summed across the account's vaults |
| AC-Q4 | A share replica lands in the vault the invitation was **accepted in** — there is no separate "which vault?" question, because a plugin instance can only reach the vault it runs in |

## Sharing

| # | Decision |
|---|---|
| 10 | Revocation is server-side authorisation; the share key is not rotated |
| 11 | Revocation leaves the revoked participant's copy in place (SH-16) |
| 12 | A share's bytes are charged to every participant, the initiator included |
| 44 | Dissolving a share is a state change, not a `DELETE` |
| 104 | Sharing is replication: every participant holds their own nodes, marked `share_id` + `share_item_id`; one server command fans a write out to the live non-frozen set, at most 8, and an integration test proves all-or-none fan-out |
| 105 | A node's share mark is verified, not trusted, and checked both ways: a marked node is the share's `root_item_id` or has a parent in the same share, and a node inside a shared folder is itself marked |

## Data model and protocol

| # | Decision |
|---|---|
| 14 | Version history is mandatory, in its own `versions` table with its own retention — not via the delta journal |
| 16 | Quota is materialised in `user_blobs`, updated in the same transaction as the reference that caused it |
| 19 | A blob is addressed by the hash of what is stored |
| 20 | Blob access is authorised by the caller's live reference, never by the hash existing |
| 24 | Delta and resync work from a pinned snapshot (high-watermark in the cursor, `snapshot` in the listing) |
| 26 | `HEAD /blobs` answers "do I have this", not "does the server have this" |
| 29 | A node is keyed by `(vault_id, id)`; the tree is `parent_id`; there are no paths on the server |
| 33 | `POST /blobs` needs no rights to a blob but has limits: quota reservation, bytes per minute, ceilings on unfinished and unbound uploads, TTL on abandoned parts |
| 36 | Restoring into a name taken since returns `409`; no automatic renaming |
| 46 | `POST /blobs` has no "already have it" short-circuit |
| 52 | The precondition for `PUT` is `base_sha256`, not the node revision |
| 55 | Deleting an account is a procedure with author anonymisation, not a `DELETE`: its authorship is reassigned to the reserved **tombstone** account, which carries no keys, owns nothing, and is itself permanent |
| 56 | Name rules are set by the strictest platform: case-insensitive uniqueness, no Windows-forbidden characters or reserved names |
| 59 | Trash and restore work in groups; restoring a file lifts its ancestor chain |
| 63 | The client does not apply a delta it cannot materialise — case collision, forbidden name, undecryptable name go to a problem list, not to disk |
| 72 | Pending uploads are counted in `user_blobs.refs_pending`, not in a table of their own |
| 73 | An endpoint that takes a **login** never answers `404` for one that does not exist: `/auth/kdf` returns a deterministic fake salt, `/shares/{id}/recipients/{login}/pubkey` a deterministic fake key pair, and an invite naming no account fails generically |
| 98 | `ancestry` is the strict ancestor chain, own id excluded, and a deferred constraint trigger verifies it at commit |
| 100 | The delta cursor is authenticated: `base64url(payload) "." base64url(HMAC(cursor_key, payload))`, with the user id and vault id inside the payload; a bad tag is `400`, not `410` |
| 102 | `nodes.type` is immutable |

## Cryptography

| # | Decision |
|---|---|
| 30 | The nonce is random and stored in the blob header |
| 31 | Keys are wrapped with HPKE (X25519 + HKDF + ChaCha20-Poly1305); the `aad` binds the envelope to a share and a recipient |
| 34 | Names are the one exception to "nothing is re-encrypted": creating a share re-keys them across the subtree, finalizing a private copy re-keys them back |
| 38 | A blob is encrypted with its own content key; that key is stored wrapped per scope (`blob_keys`) |
| 39 | The share key is also wrapped under the initiator's vault key |
| 42 | The content key is random; deduplication lives in `dedup_index`, keyed by `HMAC(scope key, hash)` |
| 43 | `blob_keys` rows are never collected on their own, only by cascade with the blob |
| 45 | The preparation pass covers every blob reachable from the subtree, history included |
| 49 | Every account gets an X25519 keypair at registration |
| 50 | The share key is stored before the pass begins; `name_key_id` makes the pass resumable |
| 53 | Moving content into a share is a miniature preparation pass: envelopes for the blob and all its versions, name re-keyed |
| 61 | The passphrase never reaches the server: the seed splits into vault keys and an auth secret |
| 62 | Argon2id parameters are fixed and versioned: m = 64 MiB, t = 3, p = 1, 16-byte salt per account |
| 64 | A dedup tag is written wherever an envelope is written, in the same transaction |
| 65 | A `dedup_index` lookup is authorised like a blob read |
| 66 | The race between two random content keys is resolved by the index primary key: the loser takes the winner's address |
| 67 | The column is named `auth_secret_hash`, not `pwd_hash` |
| 109 | A wrapped value carries `wrap_version ‖ alg_id` and authenticates it as the `aad`. The version is this format's own, separate from the blob's; the algorithm id is the shared registry. Without it a change of AEAD is indistinguishable from a wrong passphrase, since both arrive as a tag failure |
| 110 | The **pairing secret is generated by the new device**, which registers only `sha256(secret)`. The server stores a hash, and a hash of a value it generated and returned would prove nothing about who presents it later; made on the device, the secret reaches the server only when it must be shown |

## Operations

| # | Decision |
|---|---|
| 69 | `server_meta.restore_epoch` travels in the cursor; a foreign epoch forces a full `410` |
| 70 | A resync after a `restore_epoch` change does not apply deletions: local files missing on the server are uploaded as new. When a cursor is stale in both epochs at once, `restore` is the reason given — the destructive instruction never wins over the protective one |
| 74 | Adoption of a non-empty vault is a base client mode, not a migration nicety |
| 75 | An adoption conflict is resolved conservatively: the server version wins the filename, the local one becomes a conflict file |
| 76 | A pre-flight check runs before the first upload |
| 77 | A first-upload mode with raised limits |
| 79 | Two epochs, not one: `restore_epoch` and `reset_epoch`, and the `410` names the reason. Both may only increase |
| 80 | Even a deletion the user ordered is not silent: on other devices the surplus files go to a quarantine folder outside synchronisation |
| 95 | A backup is one frozen window, not an ordering: writes are frozen, both legs are taken inside the window, writes are released. `backup_runs` records the window and `CHECK`s reject a leg outside it |
| 96 | The epoch after a restore is `max(state file, restored database) + 1`, never a blind `+ 1` |
| 101 | A negative test states the expected SQLSTATE and a fragment of the message; `expect_fail` compares both |
| 107 | The schema **seeds** the two accounts nothing else can create: the tombstone (#55) and the first administrator, as an unredeemed invitation. Until that invitation is redeemed the server answers nothing but its redemption |
| 108 | The four stored verifiers (`auth_secret_hash`, `recovery_code_hash`, `invite_token_hash`, `refresh_token_hash`) are **SHA-256 over the token's UTF-8 bytes, hex, constant-time compared** — no salt, no pepper, no slow KDF, because every one of their inputs is ≥128 bits from a CSPRNG. That entropy floor is itself the rule; the seeded bootstrap token is its one exception |
| 111 | **One version for the whole solution**, `major.minor.patch`, carried by the server, the plugin, `shared/` and the console alike and bumped together. The **major** number carries the compatibility promise — while it is `0`, the **minor** carries it instead, which is what a leading zero means. `/health` is the only place the server reports its own, because it is the only endpoint open before authentication and before an administrator exists. The client compares and **warns**; it does not refuse to sync, because locking someone out of their own vault over a version string is the worse failure. Five manifests must agree and `scripts/check-version.mjs` fails when they do not |

## Management console

| # | Decision |
|---|---|
| 82 | One web client with two zones — administration and profile; the administrator never browses another user's vault |
| 83 | An account cannot be created server-side: the administrator issues an invitation, and the keys are born on the user's device (`provisioned` → `active`). The two accounts the bootstrapped install itself seeds — the tombstone and the first administrator — are the discipline's exception, settled in #107 |
| 84 | Disable is not delete. Disabling is immediate; deletion is a long-running procedure with its own state |
| 86 | Cryptographic operations stay in the plugin; the web client does not perform them |
| 87 | Administrative actions are recorded in an append-only audit log |
| 88 | The last active administrator cannot be demoted, disabled or deleted — enforced by a trigger |
| 89 | Changing the passphrase re-wraps the account seed; derived vault keys do not move and nothing is re-encrypted |
| 90 | Each device carries its own refresh token |
| 91 | The console triggers and observes backups but cannot download them |
| 92 | The console cannot perform a restore; it verifies backups, confirms a completed restore and bumps the epoch — and refuses to serve if it detects an unconfirmed one |
| 93 | The audit log carries no foreign keys: actor and target logins are snapshots stored beside the ids |
| 94 | Audit rows cannot be deleted either, only inserted |
