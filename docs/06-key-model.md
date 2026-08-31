# 06 — Key model

The owner of everything cryptographic: the key hierarchy, what is encrypted with what, and what happens to
keys when a share is created, joined, revoked or left. Other documents link here and must not restate the
rules — a crypto rule stated in two places is a contradiction waiting on a seam.

Everything here is **E2EE**: the server stores only ciphertext and reads neither content nor names. There is
no server-readable mode (AC-08).

## Two scope keys, no modes

There is no `enc_mode` and no plaintext mode (AC-08); encryption is not a property a scope can switch off.
It is scoped by **key**, and there are two:

- the **vault key** `KV` — one per vault, `KV = HKDF(seed, vault_id)` (AC-11) — encrypts everything an
  account owns in that vault: content-key envelopes and names;
- the **share key** `KS` — one per share, random — is a **transport** key, so participants can read names
  the server cannot.

Two consequences, each of which otherwise surfaces as a bug:

- **every account gets an X25519 keypair at registration.** It is not for encrypting own content; it is so
  that someone else's share key can be **wrapped to the account**. An account without a keypair cannot be
  invited into a share at all. The keypair is on the **account**, not a vault, because an invitation is
  issued to a person before it is known which of their vaults they will accept it in (AC-Q4);
- **the vault view reports the key scope per scope** — the vault's own key plus each share it participates
  in — because a client must encrypt a file in a shared folder under `KS`, not `KV`.

Two vaults of one account have **different** `KV` (different `vault_id`), which is why they never
deduplicate against each other (AC-09).

## Hierarchy

| Key | How many | Where from | Who holds it |
|---|---|---|---|
| **vault key** `KV` | **one per vault** | `KV = HKDF(seed, vault_id)`; the `seed` is a random account secret **wrapped** under a passphrase-derived KEK (`Argon2id`), and under the recovery code where one exists | all of the owner's devices |
| **X25519 keypair** | one per **account** | generated at registration; the private half encrypted under an account key from the seed | the owner; the public half is public |
| **share key** `KS` | one per share | random, at creation | the initiator and every participant |
| **content key** `KC` | one per blob | **random** — never derived from the content, never dependent on a scope | anyone holding at least one envelope for it |

## The indirection that makes sharing cheap

> **A blob is encrypted with its own key, and that key is what gets wrapped.**
>
> The tempting shortcut is to encrypt content directly with a scope key. Then opening a folder as a share
> means **re-encrypting** all of it under `KS`: different addresses, a full re-upload, double quota during
> the transition — exactly the cost we refused to pay for key rotation on revocation.
>
> So `KC` sits between them. The blob is encrypted with its own content key, and `KC` is stored **wrapped
> once per scope that needs it**. Sharing an existing folder means adding one more envelope per blob.
> Metadata. No bytes move and no address changes.

```
KC          = 32 random bytes                        ← new for every new blob
nonce       = 24 random bytes
header      = magic ‖ format_version ‖ alg_id ‖ key_id ‖ nonce
ciphertext  = XChaCha20-Poly1305(KC, nonce, plaintext, aad = header)
address     = sha256(header ‖ ciphertext)

envelope    = AEAD(K_scope, KC)                      ← a blob_keys row per scope
dedup tag   = HMAC(K_scope, sha256(plaintext))       ← a dedup_index row
```

`key_id` in the header identifies the **content key**, not a scope: a blob has one `KC` and any number of
envelopes.

### The header, byte for byte

The address is `sha256(header ‖ ciphertext)` and the header is the AEAD's `aad`, so the layout is a
**contract**: change it and every address in every vault changes, and every existing tag stops verifying.

| Offset | Bytes | Field | Value |
|---|---|---|---|
| 0 | 4 | magic | `SYNC` in ASCII — so a blob found in a backup identifies itself |
| 4 | 1 | `format_version` | `1` |
| 5 | 1 | `alg_id` | `1` = XChaCha20-Poly1305, the only AEAD in this design |
| 6 | 16 | `key_id` | the content key's UUID, big-endian as written |
| 22 | 24 | nonce | random per blob — XChaCha's extended nonce, never a counter |

46 bytes, fixed. `format_version` sits at a fixed offset that **no future version may move**, which is what
makes an old blob readable after the layout changes.

### The wrapping format, byte for byte

Everything encrypted that is **not file content** — the seed under the KEK, a content key under a scope key,
a name under a scope key — uses the same AEAD in a second, smaller format (D-109):

```
marker      = wrap_version ‖ alg_id
wrapped     = marker ‖ nonce ‖ XChaCha20-Poly1305(K, nonce, plaintext, aad = marker)
```

| Offset | Bytes | Field | Value |
|---|---|---|---|
| 0 | 1 | `wrap_version` | `1` — **this format's** version, not the blob's |
| 1 | 1 | `alg_id` | `1` = XChaCha20-Poly1305, the same registry the blob header cites |
| 2 | 24 | nonce | random per value |

Base64 on the wire; `bytea` in `users.wrapped_seed`, `blob_keys.wrapped_key` and `nodes.name_enc`, which the
server stores and never parses. **The server does not check the marker** — it holds no key, so it cannot
verify the tag that makes the marker honest, and a second reader of this rule would need bumping in lockstep
for no gain.

**No magic and no key id**, unlike a blob. Magic exists so bytes found in a backup identify themselves, and a
wrapped value is never loose — it is always the named column that quotes it. A key id exists because a blob
has one `KC` and many envelopes; here the key is the one the caller already holds.

**A version, though, for the same reason the blob has one.** Without it a stored `wrapped_seed` cannot say
which AEAD produced it, so changing the algorithm leaves "try the old one, then the new one" — and in this
layer that is indistinguishable from a wrong passphrase, because both arrive as a tag failure. The same
applies to the nonce: a reader that slices a fixed 24 bytes misparses any value whose layout moved, and
blames the key for it. The two version numbers are **separate on purpose**: framing a large blob into
per-chunk nonces moves the blob's and leaves this one alone. The algorithm id is shared, because it names an
AEAD in the design rather than a field of either format.

**The marker is the `aad`**, and the reason is the next field rather than these two. Flipping a version byte
today only selects a version that does not exist, which the client refuses before it uses a key at all. But a
marker is where a future field lands — a scope binding, a "this is a name, not a key" flag — and such a field
is exactly the kind an attacker may swap while the tag still verifies. Binding it from the first version
means every field that joins it is bound by construction, rather than resting on whoever adds it noticing
that it must be.

> **`KC` is random, and never derived from the content.**
>
> A convergent scheme — `KC = HMAC(public domain, sha256(plaintext))` — is not "deduplication at the price
> of confirming existence". Anyone who **guesses** a file's content derives the key and **decrypts** it, and
> notes are guessable: templated, short, with predictable `.obsidian` configs. That is a dictionary attack,
> and it would mean the system is not E2EE at all.
>
> Because `KC` is random, nothing in the ciphertext is derived from anything public, so knowing the content
> buys nothing. Deduplication lives in a separate index keyed by `HMAC(K_scope, hash)`: only a holder of the
> scope key can compute a tag, so the tag is not an oracle.
>
> Watch the wording as well as the scheme. "Reveals whether a file exists" understates this failure by a
> wide margin — the correct statement is that it reveals the file.

**One formula, all cases.** `KC` is always random, including for a participant's write into a share. The
scope decides only the **dedup tag** and the set of envelopes, never the key itself.

## What is encrypted with what

| Object | Key | Stored in |
|---|---|---|
| file content | the blob's `KC` | the blob store |
| `KC` | the `KV` of each holder and/or the `KS` of each share that sees it | `blob_keys` |
| a node's name outside any share | `KV` | `nodes.name_enc` |
| a strict descendant of an **active shared root** | `KS` | `nodes.name_enc` |
| a share-root name in any participant vault | that vault's `KV` | `nodes.name_enc` |
| `KS` for the initiator | the initiator's `KV` | `shares.wrapped_key_initiator` |
| `KS` for a participant | HPKE to their public X25519 | `share_members.wrapped_key` |

**The share key is a storage scope for interior names and a transport scope for content keys.** A writable
participant cannot create an initiator-side interior name under `KV`, because they never hold that private
key. Therefore strict descendants of every active share root are named under `KS` (SH-28). The root label is
local `KV` metadata: it sits among private siblings and never propagates.

### Wrapping for a participant

```
wrapped_key = HPKE.Seal(participant_pubkey, KS,
                        aad = format_version ‖ share_id ‖ recipient_user_id)
```

HPKE (RFC 9180), mode Base, `DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305`. X25519 by
itself wraps nothing — it agrees a shared secret — and composing HKDF and an AEAD by hand where a standard
exists has no justification.

The `aad` binds the envelope to the pair "share — recipient": it cannot be handed to a different
participant or reused under a different share. There is **no key epoch** in it, because `KS` is never
rotated (D-10) — an epoch would name a generation that cannot exist.

## Vault key derivation

A device derives every vault key from the seed after one of the two bootstraps below, so the derivation
parameters are part of the protocol, not an implementation detail. **One expensive pass per account, cheap
branches per vault** (AC-11). The seed is a **stable random secret wrapped under the passphrase**, not derived from it —
otherwise changing the passphrase would change every key and force a full re-encryption:

```
KEK          = Argon2id(passphrase, account_salt, m, t, p)   ← key-encryption key
seed         = 32 random bytes                                ← the account master secret, generated once
wrapped_seed = AEAD(KEK, seed)                                ← stored on the server; recovery_key wraps it again
auth_secret  = HKDF(seed, info = "auth")                      ← this is what goes to the server
kek_verifier = HKDF(KEK,  info = "recovery" ‖ login ‖ salt)   ← proves the phrase without the seed
KV_vault     = HKDF(seed, info = vault_id)                    ← one per vault, derived on demand
```

`auth_secret` is stable for the lifetime of the seed. A passphrase change changes only the KEK and seed
wrapping; it does not rotate `auth_secret`, vault keys or encrypted content.

The client runs Argon2id **once** after bootstrap to get the `KEK`, unwraps the seed, then derives each vault
key as an HKDF branch keyed by the `vault_id` it took from the vault list. To open a vault a device needs the
seed and the vault's `id` — which is why listing vaults is an account-level request that precedes any sync
(AC-10). **Changing the passphrase re-wraps the seed under a new `KEK` and
re-encrypts nothing**, because the vault keys derive from the unchanged seed.

| Parameter | Value | Why |
|---|---|---|
| algorithm | Argon2id, version 0x13 | the standard; `id` balances side-channel and GPU resistance |
| `m` | 64 MiB | the ceiling of a mobile WebView. More, and Android starts killing the tab |
| `t` | 3 | with `m`, about 0.5–1 s on desktop and a few seconds on a phone |
| `p` | 1 | parallelism buys nothing in WASM |
| `salt` | 16 random bytes per **account** | stored in the clear on the server — it is not a secret |
| `kdf_params` | JSON with all of the above plus a version | so the parameters can change later without breaking existing vaults |

> **The server never sees the seed or any `KV`.** The passphrase does not reach it at all. The seed splits
> into keys that never leave the device (`auth_secret` is the exception, sent as the password and hashed
> again server-side). If authentication used the same material as encryption, the server would receive a
> vault key on every login and E2EE would be decorative.
>
> The column is named **`auth_secret_hash`**, not `pwd_hash`. Not pedantry: `pwd_hash` suggests to future
> code that a password arrives, and sooner or later someone writes exactly that.

**The client never persists a refresh token.** What the plugin writes down — server URL, ids, `wrapped_seed`
— is worthless without the passphrase, and that is the file's whole security property. A saved refresh token
would void it: it lets the device keep synchronising as itself without the phrase, which is exactly the
convenience that eats the property. The token lives in memory for the length of an unlock and dies with it;
`lock()` clears it together with the seed and the access token, and after a restart the passphrase is the
only way back in.

**The rule generalises, and it has to be stated once: anything derived from the seed keeps the unlock's
lifetime.** The token is one such thing; so is the tree of **paths** the sync engine walks, which is
plaintext names all the way down — the server holds none, and one exists only once a client has opened
every name above it (docs/03). Keeping a walked tree between passes is allowed (issue #252) and keeping
it past a lock is not: it would leave in memory exactly what locking exists to end. The way this is kept
is structural rather than remembered — such a cache hangs off the session's handle, which is made at
unlock and dropped by `lock()`, so there is no clearing step for anybody to forget.

`account_salt` and `kdf_params` are returned by the pre-auth `/auth/kdf` response and by either bootstrap.
Nothing in them is secret, and they are not sufficient to obtain a seed — deriving a `KEK` from them still
requires the passphrase, which is exactly what recovery makes the caller demonstrate.

### Bootstrap on a device that has no seed

A device without the seed cannot derive `auth_secret`, so ordinary login cannot bootstrap it. It has two
paths, and they answer two different losses.

1. **Pair an existing device** — for a device *added* while another still works. The new device makes an
   ephemeral X25519 keypair and a random pairing secret. An already authorised device scans or enters both,
   seals the seed to the ephemeral public key, and sends only that opaque envelope through the server. The
   short-lived `device_pairings` record stores the public key and a hash of the pairing secret; approval
   binds exactly one account and envelope, and claim is once. Claim also returns the account's encrypted
   `enc_privkey`, then creates and binds that device to the account.
2. **Recover** — for a device *replacing* the last one, where there is nobody left to approve anything. One
   endpoint, and **two proofs**, because there are two ways to arrive at it:
   - **the passphrase.** The client takes `account_salt` and `kdf_params` from the pre-auth `/auth/kdf`,
     derives the same `KEK` it would derive to unlock, and sends `kek_verifier` — never the phrase, and never
     anything the seed could be read out of. The server answers with `wrapped_seed`;
   - **the recovery code.** A high-entropy string shown **once**, under which a second copy of the seed is
     wrapped. The server holds `recovery_code_hash` and answers with `recovery_key`. Not at registration:
     it is an action in the settings, for the reason M7 gives — a code demanded during sign-up lands in the
     same password manager as the passphrase, where it is a second key to the same door.

   Either way it creates the device exactly as claim does and returns `enc_privkey` beside the envelope, and
   the client unwraps with the key it already has.

### Changing it

A passphrase change rewrites `wrapped_seed` and `kek_verifier_hash` together, through
`PUT /auth/passphrase`, and **changes nothing else**: the seed is the same seed, so every vault key derived
from it is the same key and not a byte is re-encrypted. `account_salt` stays too, for the reason above — it
is an input to the recovery code's derivation.

**It does not reach the account's other devices, and cannot.** Each holds its own copy of the envelope and
unwraps it locally, so a device that was not present goes on opening with the old passphrase — syncing
correctly, behind a phrase its owner has stopped using. The server says so rather than leaving it silent:
`/auth/login` answers with `seed_fingerprint`, a hash of the current envelope, and a device whose own copy
hashes to something else knows it is behind.

Catching up takes the **new passphrase**, not merely the session: `POST /auth/seed-envelope` wants the same
`kek_verifier` recovery does. A hash on login and a proof for the envelope are one decision made twice — the
envelope is an offline target for guessing the passphrase, so a stolen access token must not be able to
fetch one.

**The recovery code survives a passphrase change**, by construction: it wraps the seed, and the seed did not
move. A passphrase changed because it leaked leaves that second way in exactly as it was, which is worth
saying out loud to whoever is changing it.

**Recovery hands back a seed envelope, not the seed**, and only against proof that the caller can open that
particular envelope. That is the whole design, and it is why one endpoint can carry both proofs: each returns
the envelope its proof unlocks and nothing else. The server learns nothing it did not already store, and a
caller who can produce neither proof gets the same refusal as an unknown login.

**The two proofs answer two different losses**, which is why keeping both is not redundancy:

| lost | proof that still works |
|---|---|
| every device, the passphrase remembered | `kek_verifier` |
| the passphrase | the recovery code, if one was kept |

Both are implemented. The passphrase proof arrived with M3.5; the code with M7.

#### How the code wraps the seed

    recovery_kek = HKDF(sha256, ikm = normalised code, salt = account_salt, info = "recovery-code")
    recovery_key = AEAD(recovery_kek, seed)              ← beside wrapped_seed, same 32 bytes
    recovery_code_hash = sha256(normalised code), hex    ← like every other stored verifier (D-108)

**HKDF and not Argon2id**, unlike the passphrase, and the asymmetry is the point: the code is 128 bits of
CSPRNG (`human-code.ts`), so no work factor buys anything against it — it would only charge the person
recovering, at the one moment they are already having a bad day. This is the reasoning of *Hashing the four
secrets* below, applied one layer up.

**The salt binds the envelope to the account**, so a code cannot be carried to another one, and the `info`
label keeps this branch from colliding with the seed's own.

**Normalising is the client's job at both ends**, exactly as for a pairing secret. The code crosses a human
and comes back with or without dashes, in whatever case, with `O` for `0` — and the server hashes the string
it is handed, having no opinion about any of that. A client that hashes the displayed form when filing and
sends the typed form when recovering has built a code that can never be redeemed. There is a test that
asserts this trap rather than describing it.

**Replacing is the same act as creating**, and it invalidates the previous code. The whole risk this feature
carries is a slip of paper from three years ago that still opens the account, so there is deliberately no way
to hold two.

#### What this costs, stated plainly

The alternative to path 2 is not a stricter product — it is a vault whose owner cannot get it back. A server
that holds every byte and cannot return them to the person who wrote them is a transport between two live
devices, not a backup. So the cost is paid deliberately and named here rather than discovered later.

**What does not change.** A database leak is no worse: the dump already contains `wrapped_seed`, and the
verifier is derived through the same `Argon2id`, so attacking it costs exactly what attacking the seed
envelope beside it costs. The server still cannot read a note, a name or a key. The passphrase still never
reaches it.

**What does change, and it is one sentence.** The passphrase becomes a **single factor**. Before, an attacker
needed the phrase *and* a device's `data.json`; now the phrase, the login and a route to the server are
enough. That is the same bargain every passphrase-recoverable E2EE product makes, and it is the reason the
server-side attempt limit below is part of the design rather than an operational nicety.

**What it does not rescue.** A forgotten passphrase — that is the recovery code's job, and an account
without a code has nothing that rescues it. The settings screen says so in those words rather than leaving it
to be discovered.

**An account must not claim a path it does not have.** `recovery_key` and `recovery_code_hash` are
**nullable, and null means exactly what it says**: this account has no recovery code. Writing a placeholder
there — a fixed byte, a random hash nobody holds the preimage of — produces an account that passes every
check and fails the only moment it exists for.

**The one new exposure.** The client now sends something derived from the phrase, so a hostile server could
answer `/auth/kdf` with a salt of its choosing and collect a verifier under it. Binding the verifier to the
login and the salt keeps it from being replayed against another account, and `Argon2id` at 64 MiB keeps each
candidate expensive — but the exposure is real and belongs on this list.

#### The attempt limit is part of the protocol

`/auth/recover` is the one endpoint where a guess is worth making, so a limit on guesses is a rule and not a
deployment choice: attempts are counted per login and per source, back off, and are recorded in the audit log.
The refusal is the same for an unknown login and a wrong phrase (D-73), so the limit never becomes an oracle
of its own.

## Hashing the four secrets the server does store

The server holds no key, but it does hold a verifier for five things: `users.auth_secret_hash`,
`users.recovery_code_hash`, `users.kek_verifier_hash`, `users.invite_token_hash` and
`devices.refresh_token_hash`. All five are
**SHA-256 over the token's UTF-8 bytes, hex-encoded, compared in constant time** — no salt, no pepper, no
slow KDF (D-108). The encoding is part of the contract, not an implementation detail: a token is a string on
the wire, and "hash the string" is ambiguous until it says which bytes.

`kek_verifier_hash` is the only one whose input is **not** high-entropy, and it is stored the same way for a
different reason. Its input descends from a passphrase, so a fast hash would normally be wrong — but the slow
KDF has already run: the verifier is `HKDF` of an `Argon2id` output, and a guess costs a full 64 MiB pass
before it can be tested. Adding a second slow KDF on the server would charge the honest caller twice and the
attacker nothing extra, since the same dump already carries `wrapped_seed` — an equally expensive target for
exactly the same guesses.

Its name is chosen the way `auth_secret_hash` was (D-67): it verifies knowledge of the **KEK**, not of a
passphrase, and a column called `passphrase_hash` would sooner or later invite code that sends one.

That is not the usual answer, so here is the reasoning, and the condition it rests on.

**A slow KDF protects low-entropy secrets, and only one of these is one.** Argon2 and bcrypt exist to make an
offline guess expensive after a database leak. `auth_secret = HKDF(seed, "auth")` is 32 random bytes, the
refresh and invitation tokens are generated by the server, and the recovery code is high-entropy by
definition; nothing about 128+ bits of CSPRNG output is brute-forceable at any work factor, so the work
factor buys nothing. `kek_verifier` is the exception that proves the rule rather than breaking it: its
entropy is a passphrase's, and the slow KDF that guards it has already run on the client.

**And it costs.** `auth_secret_hash` is verified on **every login**, after the client has already spent its
own Argon2 pass (64 MiB, about a second on a phone) to unwrap the seed. A second slow hash on the server
would add hundreds of milliseconds to every sync start on mobile, in exchange for protection against an
attack that cannot be mounted.

**No salt**, because there are no rainbow tables for 256-bit random values and no two rows ever hold the
same token.

**No pepper either, and this one is a trade rather than an obvious call.** An HMAC under a server secret
would make a leaked database useless on its own, and the design already speaks that language elsewhere
(`cursor_key`, the fake-salt derivation). It is refused because it creates a **second secret that must
survive a restore**: lose it and every account is locked out permanently, where losing `cursor_key` costs
only a full resync. On a single-host home server the configuration usually sits in the same volume and the
same backup as the database, so the scenario a pepper defends — database leaked *without* configuration —
mostly does not arise, while the way to brick the server does.

> **The condition, and it is not optional.** All of this holds only while every one of those secrets really
> is high-entropy: **at least 128 bits from a CSPRNG**. Written down as a rule rather than assumed, because
> the day somebody adds a "convenient" short invitation code, a fast unsalted hash stops being a considered
> choice and becomes a hole.
>
> The seeded bootstrap invitation is the **one deliberate exception**: its token is the literal `admin`
> ([03](03-data-model.md), D-107). It survives this rule because it is single use by construction and
> because the server answers nothing but its redemption until it is used — the window is one first run of an
> empty installation, where there is nothing to steal.

## Identifiers and envelope lifetime

Every scope key has an id in durable `key_scopes`, because that is what `blob_keys.scope_id` and
`dedup_index.scope_id` point at: `vaults.vault_key_id` registers a `vault` scope and `shares.subtree_key_id`
registers a `share` scope. The registry makes a dangling or wrong-kind UUID impossible without storing any
secret key material.

> **Envelopes are never tidied up — they die with the blob.** `blob_keys` cascades from `blobs`, and that
> is the only way a row disappears. Removing "the envelopes of a share that ended" looks like housekeeping
> and would cut former participants off from folders that are now their own: those files are read through
> exactly that envelope.
>
> So when a share ends, the `shares` row goes and `subtree_key_id` survives in the envelopes as an id with
> nothing left to point at. That is a normal state, not garbage — the key itself lives on in the keyrings
> of everyone who received it.

## Lifecycle

### Creating a share

One pass by the **initiator's** client over the folder. Order matters, and only the first step is strict:

1. generate `KS`, wrap it under the initiator's `KV` and **store the envelope on the server**;
2. for every blob **reachable from the folder**, add a `KC` envelope under `KS` and a dedup tag in that
   scope;
3. for every node **strictly below the folder root**, re-key `name_enc` and `name_hmac` from `KV` to `KS` and
   set `name_key_id` to the share key. The initiator's root label stays under `KV`, because it is a sibling of
   private nodes; every joiner supplies their own local `KV` root label.

> **Step 1 cannot be deferred.** A device that generates `KS`, starts producing names under it and dies
> before storing the envelope leaves part of the work under a key **nobody has**. Nothing can repair that.
> The key becomes available first; only then is anything encrypted with it.

> **"Reachable" is not "current".** Step 2 must cover blobs held only by `versions`. A participant receives
> each file's history from its entry into the share (SH-23), so history left under `KV` alone means versions nobody
> but the initiator can open — a failure that surfaces the first time someone looks back, not before.

**The pass is additive for content and resumable for names.** It never changes bytes or content keys. Names
are the deliberate metadata exception: a node already under `KS` is skipped, while a `KV`-named node is
translated once. Three properties follow, and each removes a mechanism the pass would otherwise need:

- **nothing is locked**, so a device that dies mid-pass cannot leave the initiator's own folder stuck;
- **`preparing` blocks invite and join, not writing.** A shared write during the pass is valid as long as it
  uses `KS` for its new or renamed interior nodes and adds the material in the same transaction;
- **`name_key_id = KS` is the resume marker**, so retry needs no progress record and cannot double-encrypt.

`nodes.name_key_id` says whether a node's name is under `KV` or `KS`. Active shared **interior** nodes are
`KS`; roots and private nodes are `KV`. When a copy becomes private its interior names return to `KV`. That
transition is the one pass that still needs to know where it got to.

### Invitation and joining

The initiator wraps `KS` to the invitee's public key and stores the envelope; the invitee unwraps it with
their private key. From then on their replica's names and content envelopes are readable to them.

> **A mistyped login produces a key, not an error.** The endpoint that returns a public key answers a login
> that names no account with a **deterministic fake pair** rather than a `404`, so that nobody can use it to
> enumerate the server's accounts (D-73, [04](04-sync-protocol.md)). The initiator therefore wraps `KS` under
> a key nobody holds, and finds out only at the invite, which fails **generically** — deliberately, because a
> specific "no such account" would be the same oracle one call later.
>
> This is the operational price of that decision, and the client is where it has to be paid: the invite
> dialog confirms the login it is about to use, and a failed invite says the invitation could not be
> delivered, not why. On a family-sized server a typo is far likelier than an attacker, so the plugin should
> make the login easy to check **before** sending, rather than explain it afterwards.

The server creates the replica — it can copy rows and hashes — but it **cannot invent names** (it never
sees one). It uses the share-key form produced at creation, which is why step 3 above exists at all.

### A participant writes

The writer asks `dedup_index` in the `KS` scope whether that content already exists. If not, they generate
a **random** `KC`, upload the blob, add an envelope under `KS` and a tag in the same scope.

One envelope serves every participant, the initiator included, because all of them hold `KS`. That is what
keeps a write from costing eight envelopes.

### Leaving

`KS` stays in the leaver's keyring as one more key — it is never rotated, so it never stops working.

An **added participant** who leaves does three things to their copy, and the first one is load-bearing:

1. **adds a `KC` envelope under their replica's vault `KV` for every blob they keep.** Until this happens those files
   are readable only through `KS`, and `KS` reaches them by exactly two routes — the keyring on the device
   they are using, and the HPKE envelope in `share_members.wrapped_key`. Both are temporary: the membership
   row dies with the share, and a **new device** derives `KV` from the passphrase and has no way to obtain
   `KS` at all. Without this step a participant who leaves keeps a folder full of files that stop opening
   the next time they reinstall — the folder is there, the bytes are there, and nothing can decrypt them;
2. re-keys the names from `KS` back to `KV`, recomputing `name_hmac`;
3. adds dedup tags under `KV`, so their vault deduplicates against content that has just become part of it.

All three are metadata inside their own vault: no bytes move, no address changes. Their version rows go at
the same time (SH-22), so history needs no re-keying.

> **The envelope step is not optional and not "nice to have".** It is the difference between "you keep your
> files" (SH-05) being true and being true only until the next device. The dedup-tag step is the visible,
> tidy half of the same pass; this is the half that decides whether the files still open.

The **initiator** keeps history (SH-25), but their nodes are still `KS` while the share lives. When it ends,
their copy also receives any missing `KV` envelopes and tags and translates its names back to `KV`; a
participant may have introduced content that previously existed only under `KS`.

### Revocation

`KS` is **not rotated** — not for the revoked participant and not for anyone else. Revocation is purely
server-side authorisation: new content stops flowing, and whatever they hold stays with them. Under
replication they hold all of it, by construction.

Rotation would mean re-encrypting the whole folder and re-issuing envelopes to everyone remaining, on every
revocation. For a server serving a handful of people that does not pay for itself.

The interface must say so plainly: "access can be revoked going forward; what the person already received
stays with them." Not "shared securely."

### Finalizing a private copy

The server can stop propagation, but cannot make a replica private: it holds neither the recipient's `KV` nor
the names it must re-encrypt. Leave, revoke and ending therefore create a pending finalization. The affected
client supplies, in one final metadata pass, KV envelopes and tags for every current/history blob plus the
KS→KV names of its interior nodes. The server validates this material while it clears replica marks, then
records `left_at`. Until then the device can read its old copy through `KS` but receives no new share changes.

### Crossing a shared-folder boundary

The content key remains independent of scope, so no bytes move or re-encrypt. But `move` cannot cross a
shared-folder boundary: it returns `409 share_boundary`. The client instead copy/puts into the destination
scope, supplying the destination envelopes and dedup tags with the node metadata in one transaction, then
deletes the source. For a folder this includes every descendant and every retained version.

## Deduplication

Because `KC` is random, identical content twice yields **different** addresses unless the index is asked
first. So the client always asks.

```
tag = HMAC(K_scope, sha256(plaintext))
dedup_index: (scope_id, tag) → blob address
```

| Scope | Who shares deduplication |
|---|---|
| own vault | all of the account's devices, for that vault |
| a share | the initiator and every participant — one scope for all of them |
| different vaults | **not shared**, even two vaults of the **same** account: different keys, different tags (AC-09) |

Deduplication works wherever anyone needs it and vanishes exactly between parties who have nothing to
share. That is better than a global index: the server cannot tell from matching addresses alone that two
strangers hold the same file.

A tag reveals nothing **by itself** — only a scope-key holder can compute one, and HMAC is not invertible.
But **querying the index is an oracle**, so the query carries the same authorisation as a blob read.

Tags are created wherever envelopes are: the creation pass, a move into a shared folder, and the leave-time
pass. An empty index for a scope does not mean "not warmed up" — it means no deduplication in that scope at
all.

## Loss and recovery

Every `KV` is derived from the seed and a vault id; the server does not know either secret material. The two
losses are not the same loss, and only one of them is survivable:

| lost | what remains | the way back |
|---|---|---|
| **every device** — the phrase is remembered | the server holds `wrapped_seed` | prove the `KEK`, receive the envelope |
| **the passphrase** — devices intact or not | the server holds `recovery_key`, if a code was kept | prove the code, receive that envelope |
| **both** | envelopes nothing can open | none, and this is said at registration |

**There is no escrow and no administrator who can help.** An administrator holds the same envelopes an
attacker would, which is the property the whole model exists to have. Insurance against forgetting is the
recovery code, kept where other irreplaceable things are kept — and an account that has none says so with a
null rather than a placeholder.

The first row is the one that makes the server worth running. It is why recovery exists, and why its cost is
argued in full under [Bootstrap](#bootstrap-on-a-device-that-has-no-seed) rather than assumed.

## Two threats that are easy to conflate

| Who | What they can do | What answers it |
|---|---|---|
| **another user of the server** | holds an account and possibly their own copy of some file | blob access only through the caller's own live reference; `HEAD` without one returns `404`; `POST /blobs` has **no short circuit** — the server never answers "already have it", it accepts and deduplicates internally |
| **someone with access to the database** (the server's administrator) | sees the tree structure, sizes, timestamps; could brute-force content if encryption were derived from public data | a random `KC` — knowing the content does **not** yield the key. What remains is the metadata picture below |

The second row is why `KC` must stay random: with a content-derived key, an administrator who **guessed** the
content would obtain the key and decrypt the file rather than merely confirm a guess. For notes that is
dictionary work, not theory.

The `404` rule is not made redundant by it: an address can be learned another way — from someone's device,
from logs — and it must not be a capability.

## What the model does not hide

An honest list, so it is not claimed where it does not hold:

- **structural metadata**: the server sees the tree, sizes, modification times, version counts. Only names
  and content are hidden;
- **content equality within a scope**: two nodes pointing at one blob are the same file. Across scopes this
  is invisible, because the dedup tags differ;
- **the fact and time of access**: who synchronised when, and how much they wrote;
- **revocation is not cryptographic** (see above);
- **encryption is not opt-in.** The server never sees content or names, for any account or vault (AC-08).
  What it does see is the structural metadata above, and hiding that is deliberately not a goal: it would
  be a different product at a different price.
