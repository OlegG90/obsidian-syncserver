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
| D-1 | Metadata separate from content: the tree in PostgreSQL, content as content-addressed blobs |
| D-2 | A revision journal plus a cursor, not a directory listing |
| D-3 | Optimistic concurrency; a conflict becomes a separate file |
| D-4 | No CRDT in the MVP |
| D-7 | `.obsidian/` is a separate scope, disabled by default |

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
| D-10 | Revocation is server-side authorisation; the share key is not rotated |
| D-11 | Revocation leaves the revoked participant's copy in place (SH-16) |
| D-12 | A share's bytes are charged to every participant, the initiator included |
| D-44 | Dissolving a share is a state change, not a `DELETE` |
| D-104 | Sharing is replication: every participant holds their own nodes, marked `share_id` + `share_item_id`; one server command fans a write out to the live non-frozen set, at most 8, and an integration test proves all-or-none fan-out |
| D-105 | A node's share mark is verified, not trusted, and checked both ways: a marked node is the share's `root_item_id` or has a parent in the same share, and a node inside a shared folder is itself marked |

## Data model and protocol

| # | Decision |
|---|---|
| D-14 | Version history is mandatory, in its own `versions` table with its own retention — not via the delta journal |
| D-16 | Quota is materialised in `user_blobs`, updated in the same transaction as the reference that caused it |
| D-19 | A blob is addressed by the hash of what is stored |
| D-20 | Blob access is authorised by the caller's live reference, never by the hash existing |
| D-24 | Delta and resync work from a pinned snapshot (high-watermark in the cursor, `snapshot` in the listing) |
| D-26 | `HEAD /blobs` answers "do I have this", not "does the server have this" |
| D-29 | A node is keyed by `(vault_id, id)`; the tree is `parent_id`; there are no paths on the server |
| D-33 | `POST /blobs` needs no rights to a blob but has limits: quota reservation, bytes per minute, ceilings on unfinished and unbound uploads, TTL on abandoned parts |
| D-36 | Restoring into a name taken since returns `409`; no automatic renaming |
| D-46 | `POST /blobs` has no "already have it" short-circuit |
| D-52 | The precondition for `PUT` is `base_sha256`, not the node revision |
| D-55 | Deleting an account is a procedure with author anonymisation, not a `DELETE`: its authorship is reassigned to the reserved **tombstone** account, which carries no keys, owns nothing, and is itself permanent |
| D-56 | Name rules are set by the strictest platform: case-insensitive uniqueness, no Windows-forbidden characters or reserved names |
| D-59 | Trash and restore work in groups; restoring a file lifts its ancestor chain |
| D-63 | The client does not apply a delta it cannot materialise — case collision, forbidden name, undecryptable name go to a problem list, not to disk |
| D-72 | Pending uploads are counted in `user_blobs.refs_pending`, not in a table of their own |
| D-73 | An endpoint that takes a **login** never answers `404` for one that does not exist: `/auth/kdf` returns a deterministic fake salt, `/shares/{id}/recipients/{login}/pubkey` a deterministic fake key pair, and an invite naming no account fails generically. A **console account** is answered plainly instead (`409 console_account`, D-115): its existence is not what the fake protects — it is seeded and documented — and it can never be a recipient, since it holds no key to seal a share to |
| D-98 | `ancestry` is the strict ancestor chain, own id excluded, and a deferred constraint trigger verifies it at commit |
| D-100 | The delta cursor is authenticated: `base64url(payload) "." base64url(HMAC(cursor_key, payload))`, with the user id and vault id inside the payload; a bad tag is `400`, not `410` |
| D-102 | `nodes.type` is immutable |

## Cryptography

| # | Decision |
|---|---|
| D-30 | The nonce is random and stored in the blob header |
| D-31 | Keys are wrapped with HPKE (X25519 + HKDF + ChaCha20-Poly1305); the `aad` binds the envelope to a share and a recipient |
| D-34 | Names are the one exception to "nothing is re-encrypted": creating a share re-keys them across the subtree, finalizing a private copy re-keys them back |
| D-38 | A blob is encrypted with its own content key; that key is stored wrapped per scope (`blob_keys`) |
| D-39 | The share key is also wrapped under the initiator's vault key |
| D-42 | The content key is random; deduplication lives in `dedup_index`, keyed by `HMAC(scope key, hash)` |
| D-43 | `blob_keys` rows are never collected on their own, only by cascade with the blob |
| D-45 | The preparation pass covers every blob reachable from the subtree, history included |
| D-49 | Every account gets an X25519 keypair at registration |
| D-50 | The share key is stored before the pass begins; `name_key_id` makes the pass resumable |
| D-53 | Moving content into a share is a miniature preparation pass: envelopes for the blob and all its versions, name re-keyed |
| D-61 | The passphrase never reaches the server: the seed splits into vault keys and an auth secret |
| D-62 | Argon2id parameters are fixed and versioned: m = 64 MiB, t = 3, p = 1, 16-byte salt per account |
| D-64 | A dedup tag is written wherever an envelope is written, in the same transaction |
| D-65 | A `dedup_index` lookup is authorised like a blob read |
| D-66 | The race between two random content keys is resolved by the index primary key: the loser takes the winner's address |
| D-67 | The column is named `auth_secret_hash`, not `pwd_hash` |
| D-109 | A wrapped value carries `wrap_version ‖ alg_id` and authenticates it as the `aad`. The version is this format's own, separate from the blob's; the algorithm id is the shared registry. Without it a change of AEAD is indistinguishable from a wrong passphrase, since both arrive as a tag failure |
| D-110 | The **pairing secret is generated by the new device**, which registers only `sha256(secret)`. The server stores a hash, and a hash of a value it generated and returned would prove nothing about who presents it later; made on the device, the secret reaches the server only when it must be shown |
| D-112 | **A device with no seed can recover the account with the passphrase alone.** The client derives the same `KEK` it would derive to unlock, sends `kek_verifier = HKDF(KEK, "recovery" ‖ login ‖ salt)`, and receives `wrapped_seed` and `enc_privkey` — proving it can open the envelope before it is given it. The verifier's hash is stored fast (D-108) because the slow KDF has already run on the client and the same dump carries the seed envelope anyway. The cost is named rather than hidden: **the passphrase becomes a single factor** — before, an attacker needed the phrase *and* a device — which is the price of a server that can return a vault to the person who wrote it. A rate limit on the endpoint is part of the rule, not of the deployment. The **recovery code keeps its place beside it** as the second proof to the same endpoint, answering the loss this one cannot — a forgotten passphrase. It stays specified and unbuilt until M7, on one condition: its columns are **nullable and null by default**, because an account carrying a placeholder claims a path it does not have. There is no escrow and no administrator in either path, since either would hold what an attacker would want |
| D-113 | **The server address is an editable field, not a reason to reconnect.** Nothing but the URL depends on it, and "disconnect and connect again" would cost a full bootstrap to undo — the invitation token is one-time. **Disconnect** clears the local record and revokes that device, keeping every file and everything on the server; it may not exist before recovery does, or it is an exit with no handle on the outside |
| D-114 | **A backup takes a refusal window, not a freeze — so the database is dumped first and the blobs copied second** ([08](08-backup-restore.md)). Holding a lock across `pg_dump` would stop writes already running; a window that answers new ones with "the server is being backed up" does not, and a write in flight can upload a blob after the blob copy while its node reaches the dump. Blobs-first then produces the failure that is worst because it is silent: the restore completes, the tree is intact, the file is in it, and it cannot be opened — found months later. Database-first makes the blob copy a superset of what the dump references, and surplus blobs are swept by the collector. **The word `freeze` is reserved for the quota state** (SH-20): an account freeze is about space, a backup window is about a moment, and one word for both would make every sentence naming it ambiguous |
| D-115 | **Two kinds of account, and neither can be the other.** A *console* account administers the server: it has a password, a slow hash of it, and **no key material at all** — no `pubkey`, no `wrapped_seed`, no salt — so it cannot sync a vault, cannot be invited into a share (there is no key to seal one to), and can decrypt nothing. A *vault* account is what every user holds: keys born on their device, no password, and no way into the console. This is what makes [11](11-management-console.md)'s "an administrator cannot browse another user's vault" enforced by the schema rather than by care — the admin has no key, rather than being trusted not to use one. It is also the only shape in which a browser can authenticate at all: `auth_secret` is derived from the account seed, which a browser neither holds nor should. The cost is named: a second authentication surface, rate-limited like `/auth/recover`, and a fourth shape in `keys_match_state`. The consequence is that the **profile zone moves to the plugin** — every item in it is about the user's own data, and the plugin already holds the session and the keys |

## Operations

| # | Decision |
|---|---|
| D-69 | `server_meta.restore_epoch` travels in the cursor; a foreign epoch forces a full `410` |
| D-70 | A resync after a `restore_epoch` change does not apply deletions: local files missing on the server are uploaded as new. When a cursor is stale in both epochs at once, `restore` is the reason given — the destructive instruction never wins over the protective one |
| D-74 | Adoption of a non-empty vault is a base client mode, not a migration nicety |
| D-75 | An adoption conflict is resolved conservatively: the server version wins the filename, the local one becomes a conflict file |
| D-76 | A pre-flight check runs before the first upload |
| D-77 | A first-upload mode with raised limits |
| D-79 | Two epochs, not one: `restore_epoch` and `reset_epoch`, and the `410` names the reason. Both may only increase |
| D-80 | Even a deletion the user ordered is not silent: on other devices the surplus files go to a quarantine folder outside synchronisation |
| D-95 | ~~A backup is one frozen window, not an ordering~~ — **superseded by D-114**, which keeps the window and reverses the second half: the order *is* normative, because this server refuses new writes rather than stopping running ones. What survives is the record: `backup_runs` holds the window and `CHECK`s reject a leg outside it — plus one D-95 did not have, that the database leg finished before the blob leg |
| D-96 | The epoch after a restore is `max(state file, restored database) + 1`, never a blind `+ 1` |
| D-101 | A negative test states the expected SQLSTATE and a fragment of the message; `expect_fail` compares both |
| D-107 | The schema **seeds** the two rows nothing else can create: the tombstone (D-55) and the first administrator, as a **console account with no password**. Until a password is set the server answers nothing but the setting of it. The two properties that make a bootstrap acceptable both hold: setting the password is what *creates* it, so there is no state in which a default works — and while it is unset the server does nothing else, so the window is the first run rather than "until somebody remembers". A seeded default that had to be changed would fail the first property, which is why it is absence rather than a known value |
| D-108 | The five stored verifiers (`auth_secret_hash`, `recovery_code_hash`, `kek_verifier_hash`, `invite_token_hash`, `refresh_token_hash`) are **SHA-256 over the token's UTF-8 bytes, hex, constant-time compared** — no salt, no pepper, no slow KDF. Four of them because their inputs are ≥128 bits from a CSPRNG, and that entropy floor is itself the rule; `kek_verifier_hash` is the fifth for the opposite reason, settled in D-112. **The administrator's console password is the one thing on this server the rule does not cover** (D-115): it is chosen by a person, so the entropy floor does not hold for it, and `password_hash` gets Argon2id server-side instead. No client-side KDF can stand in — the browser is not trusted to have run one. It is not a sixth verifier in this list precisely because it is hashed differently |
| D-111 | **One version for the whole solution**, `major.minor.patch`, carried by the server, the plugin, `shared/` and the console alike and bumped together. The **major** number carries the compatibility promise — while it is `0`, the **minor** carries it instead, which is what a leading zero means. `/health` is the only place the server reports its own, because it is the only endpoint open before authentication and before an administrator exists. The client compares and **warns**; it does not refuse to sync, because locking someone out of their own vault over a version string is the worse failure. Six manifests must agree — the four workspaces, the repository root and the plugin's `manifest.json` — and `scripts/check-version.mjs` fails when they do not |

## Management console

| # | Decision |
|---|---|
| D-82 | One web client with two zones — administration and profile; the administrator never browses another user's vault |
| D-83 | An account cannot be created server-side: the administrator issues an invitation, and the keys are born on the user's device (`provisioned` → `active`). The two accounts the bootstrapped install itself seeds — the tombstone and the first administrator — are the discipline's exception, settled in D-107 |
| D-84 | Disable is not delete. Disabling is immediate; deletion is a long-running procedure with its own state |
| D-86 | Cryptographic operations stay in the plugin; the web client does not perform them |
| D-87 | Administrative actions are recorded in an append-only audit log |
| D-88 | The last active administrator cannot be demoted, disabled or deleted — enforced by a trigger |
| D-89 | Changing the passphrase re-wraps the account seed; derived vault keys do not move and nothing is re-encrypted |
| D-90 | Each device carries its own refresh token |
| D-91 | The console triggers and observes backups but cannot download them |
| D-92 | **The console asks for a restore; the server carries it out on its next start, and a person still confirms it afterwards.** The button does not restore: it writes the request beside the restore epoch and stops the server, and the restore runs on the way back up, before a connection is opened for serving — which is the only moment `pg_restore --clean` is safe, and exactly what the old instruction to `docker compose stop server` was buying. This replaces a refusal: the console used to show the command to type, which was correct and left the part somebody gets wrong at three in the morning. **What the button removes is the typing, not the deciding** — the epoch guard still notices the database went backwards, still halts, still serves nothing but the confirm endpoint, and still waits for a person. The request is cleared **before** the attempt, because a marker that survived a failure would turn one bad restore into a restart loop; and the copy is checked against the configured backup directory first, because `destination` is a text column and a value from a foreign dump would otherwise name a path on this host. The server returns only if the deployment restarts it, which the confirmation says before the press |
| D-93 | The audit log carries no foreign keys: actor and target logins are snapshots stored beside the ids |
| D-94 | Audit rows cannot be deleted either, only inserted |
| D-117 | **The audit log has no retention, and that is a decision rather than an omission** (#160). Every action that writes to it is administrative and rare — inviting, activating, enabling, disabling, deleting, changing a quota, recovering, setting a recovery code, changing a passphrase or a console password, revoking a device, confirming a restore: thirteen call sites, none on a path that runs per sync or per login. A real installation measured **20 rows after two days of heavy testing**, in a table whose 64 kB is mostly the minimum footprint of its own indexes. At a generous thousand rows a year it takes something like three thousand years to reach a gigabyte, so a retention policy would be deleting the only record of who did what to save kilobytes — and deleting by age removes exactly the entries somebody eventually goes looking for, since an entry naming an account deleted two years ago is still the answer to what happened to it. **What the decision rests on is the frequency staying rare**, which nothing enforces: a `record()` call added to a path that runs on every sync would break it silently. So the console shows the log's total size beside a page of it, and that number is what would look wrong |
| D-116 | **There is no user-facing web console, and the reason is the key model rather than taste.** A page the server serves holds no keys, so it can show `id` and `name_enc` and never a name: vault names, trash entries, shared folders and version history are all ciphertext under `KV`/`KS`, decrypted on a device that has the seed. A browser could only read them by taking the passphrase and running `Argon2id` itself — which would put the one secret this design keeps off the server into code the server hands out, and end the property D-86 and D-115 exist to hold. What such a console *could* carry is the plaintext half — devices, vault ids, usage, account state — and that is precisely what the **administrative** console already reaches, which on a single-owner server is the same person. So the answer to "the plugin's settings are getting heavy" is not a fourth surface: it is that a `PluginSettingTab` is a list of rows and was never a place for tables, filters and multi-step flows. The plugin gets a **view** instead, where the keys already are (#163) — the settings tab is the wrong room, not the wrong amount of furniture. **What would reopen this**: a server whose operator is not the account's owner. Then a user console becomes necessary, its scope is still the plaintext half, and its authentication is a token the plugin mints — never a passphrase typed into a page |
| D-118 | **A device is marked seen when it refreshes — not when it syncs, and no longer only when it signs in** (#156). `last_seen_at` was written at sign-in, at recovery and at pairing, and never again: a device paired a year ago and syncing every day still read as last seen a year ago, so the column that exists to answer *which of these is gone* was answering *when did this one arrive*. An operator revoking a device that has been lost was reading a first-seen date labelled last-seen. **Every request is the wrong moment** — it makes a write out of every read on the busiest path in the server, and buys precision nobody reads. **Refreshing is the right one**: it happens about once per `ACCESS_TOKEN_TTL_SECONDS` per live session, so the write rate is bounded by a setting rather than by how busy a vault is, and the claim it records is exact — this device held a working session at that moment. It costs a statement and not a round trip, because the refresh already had to find the device. The freshness an operator gets is therefore the token lifetime, fifteen minutes by default, and the column may be read as such |
| D-119 | **Removing a vault removes it on the server and nowhere else** (#157, #175). The rule used to be *empty it first*, which read as caution and was closer to a dead end: the vault somebody actually wants gone is the one a mistaken pairing filled with a copy of their notes (D-117), and emptying it meant connecting to it, deleting every note, emptying the trash, disconnecting, connecting to the right vault, and only then pressing Remove — two disconnects, and nothing on screen said any of it. So a vault goes **with whatever it holds**, after a confirmation that names how much: *remove* and *remove 1,204 items* are different decisions and must not read alike. **No count is typed and none is echoed back**, because nobody remembers how many items a vault holds and a number somebody cannot check is a ceremony rather than a safeguard. What is deleted is the server's copy — the vault, its tree, its history. **Files on every device stay exactly where they are**; this is not a command that reaches out and empties a folder. **Not the vault this window syncs**, refused on the device where the connection lives, because the server cannot know which vault a caller is using. A device still connected to a vault that was removed meets a plain sentence saying so and saying its files are untouched — not a bare `404` out of the middle of a sync. The share refusal stays: what a share holds is other people's access (SH-27) |
| D-120 | **A decision is `D-N` and `#N` is a GitHub issue** (#179). They were one notation for both, and the collision is not hypothetical: D-111 and D-114 through D-119 are all real issue numbers as well, so a reader following a bare hash number landed somewhere plausible and wrong — and `docs/10` and this file each used it in a different sense, in the same milestone. **The platform decides this, not the repository**: GitHub renders `#N` as a link to issue N wherever it appears, so that spelling cannot be borrowed for anything else, and the decisions are what had to move. It also puts the general family beside the ones that were already prefixed — `AC-N` for accounts and vaults, `SH-N` for sharing — leaving no family spelled differently from its siblings. `scripts/check-citations.mjs` holds both halves: every `D-N` resolves to a row here, and no `#N` anywhere names a number this table uses, which is what stops the ambiguity coming back one citation at a time |
