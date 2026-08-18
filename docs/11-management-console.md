# 11 — Management console

One web client, served by the server itself, for **administration and nothing else**. It is where accounts
are invited, quotas are changed, backups are run and the audit log is read — all of it about *other
people's* accounts, which is what makes it a separate surface at all.

## Two kinds of account, and neither can be the other (#115)

| | console account | vault account |
|---|---|---|
| what it is for | administering the server | holding notes |
| how it authenticates | a password, slow-hashed on the server | the passphrase, never sent — `auth_secret` from the seed |
| key material | **none at all** | all of it, born on the device |
| can it sync | no — there is no seed to derive a vault key from | yes |
| can it be invited into a share | no — there is no public key to seal one to | yes |
| can it read the console | yes | no |
| quota | **zero**, and the schema insists on it — it owns no vault | positive, per account (AC-Q2) |
| device rows | **one, reused** on every sign-in | one per device, revocable one at a time (#90) |

A console session is a browser, and a browser is not a device somebody installed and can point at. So a
sign-in reuses the account's one console device row rather than adding another — the alternative is a
list of devices nobody owns, growing for ever, in the surface whose job is to make the real ones legible.
The consequence is stated rather than hidden: signing in from a second browser takes the session from the
first, which is acceptable for an administrator and would not be for a vault.

**"An administrator cannot browse another user's vault" is now a fact about the row rather than a promise
about behaviour.** With E2EE always on (AC-08) the server holds only ciphertext, and a console account
holds no key to open it with — so this is not a permission somebody could grant later, it is an absence.

It is also the only shape in which a browser can sign in at all. `auth_secret` is derived from the account
seed; a browser neither holds a seed nor should be given one, and deriving it there would mean Argon2id and
the whole key hierarchy in a second environment — which is exactly what this document refuses further down.

**The profile zone lives in the plugin.** Vaults, devices, shares, retention and the security section are
all about the user's own data, and the plugin already holds the session and the keys; a browser would have
had to obtain both to show any of it. That is why there is one zone here and not two.

## What the administrator cannot do, and the console must say so

**Reset a passphrase.** The server never has the seed required to re-wrap it, so an administrator cannot reset
a passphrase at all. The user changes it only from a client that already has the seed — one it kept, one
paired to it, or one recovered with the phrase itself ([07](07-onboarding.md)). Administrative recovery means
disable the account or issue a replacement invitation, not silently create empty vaults.

**Delete an account with one click.** Deletion is a procedure (#55): dissolve the shares the account
initiated, wait for each participant to finalize their copy (SH-29), reassign the account's authorship in
other people's history to the **tombstone**, only then remove its vaults. The console models this as a
**state**, `deleting`, with progress — not as a button that either works or times out.

The tombstone is a reserved account with no keys and no way in, and the history it inherits keeps saying
"written by an account that is gone" rather than "written by nobody" — the version rows stay, only the name
behind them changes. It is the reason deletion can finish at all: `versions.author_id` is `NOT NULL` and
refuses to lose its target, so there has to be somewhere for authorship to go.

What the administrator *can* do immediately is **disable**: sessions revoked, writes refused, data
untouched. Disable and delete are different operations and must not share a control.

## Accounts cannot be created server-side

`pubkey` is generated on the user's device; `enc_privkey`, the wrapped seed and recovery envelope are sealed
there. `vault_key_id` is a server-side scope identifier for a later vault, not a passphrase-derived key. The
administrator cannot produce the account's cryptographic material.

**The first administrator is the exception that proves it.** They cannot be invited — there is nobody to
issue it — so `schema.sql` seeds a console account **with no password at all** (#107), and the server
answers nothing but the setting of one until it is set. Setting it is what creates it, so there is no state
in which a default works; a seeded password that had to be changed would still work if nobody changed it.
The console shows that one form in place of a login while it is pending, which is the whole of a fresh
server's interface.

**At least 12 characters**, refused as `password_too_short` below that. A length rule and nothing else —
no character classes, which push people towards `Passw0rd!` and buy less than length does. The floor
exists because this is the one secret on the server a person chooses: everything else it stores is
≥128 bits of CSPRNG output (#108), and everything the *client* holds has Argon2id in front of it before
the server ever sees it. Here there is only Argon2id on the server, so the phrase has to carry its own
weight.

The operator's own **vault** account is a separate thing they invite for themselves afterwards, exactly as
they would invite anybody. Administering a server and keeping notes on it are different jobs, and this is
where that stops being a figure of speech.

So registration is an invitation, and the account is born in two steps:

```mermaid
flowchart LR
    A["Administrator creates<br/>an invitation"] --> B["provisioned:<br/>login, quota, token,<br/>no keys"]
    B --> C["User opens the link,<br/>chooses a passphrase"]
    C --> D["Client derives the keys<br/>and completes the account"]
    D --> E["active"]

    classDef default fill:#3b4252,stroke:#7b88a1,color:#eceff4;
    classDef accent fill:#3b5a82,stroke:#88c0d0,color:#eceff4;
    classDef ok fill:#2f5a4f,stroke:#8fbcbb,color:#eceff4;
    class B accent;
    class E ok;
```

The schema enforces the two shapes: a `provisioned` row **must** carry an invitation token and **must not**
carry keys; any other state must carry all of them. There is no half-initialised middle where a row with a
login and no keys could own data.

| State | Meaning |
|---|---|
| `provisioned` | an unclaimed invitation |
| `active` | a working account |
| `disabled` | sessions revoked, writes refused, data intact |
| `deleting` | the deletion procedure is running |
| `tombstone` | the reserved account that account deletion reassigns authorship to; no keys, no login, never altered (#55) |

**The last active administrator cannot be demoted, disabled or deleted** — enforced by a trigger, because
locking yourself out of your own server is otherwise a single keystroke.

## Administration zone

| Section | Contents |
|---|---|
| Users | list with state, quota, usage, last seen; invite, disable, enable, change quota, start deletion |
| Invitations | outstanding invitations, expiry, revoke, reissue |
| Quotas | change a limit. Lowering it below current usage deletes nothing: the account simply freezes (SH-20), across every vault and share at once, with reads and deletions still available. The console says so, and says why |
| Storage | total size, deduplication effect, blobs in quarantine, the last garbage-collection pass |
| Backups | history, status, verification — see below |
| Audit | who did what to whom and when |

### Audit log

Every administrative action on someone else's account is recorded: quota changes, disable, enable,
deletion, invitation issue and revocation. The log is **append-only** — a record that can
be edited answers no question worth asking.

This is not compliance theatre on a home server. It is how you answer "why does this account hold 200 GB"
six months later, and how you tell a mistake from a misunderstanding.

## What the user sees, and where

Not here. Each of these is about the user's own data and needs the keys to render, so each belongs in the
plugin — which is the only place that has them:

| Section | Contents |
|---|---|
| Vaults | list; rename or delete an empty one; usage split into current content and history. **Creating** one mints a vault key from the seed (#86, AC-11), so it could never have been done from a browser. A share replica counts as ordinary content of the vault it lives in ([03](03-data-model.md)) |
| Devices | list, last seen, **sign out this device**, sign out everywhere |
| Shares | what I have shared and to whom; what I have accepted; revoke, leave |
| Security | change passphrase, and regenerate the recovery code once [M7](10-roadmap.md) builds one |
| History | retention — `users.history_days`, the outer bound of the ladder in [03](03-data-model.md). The rungs are fixed; how far back they reach is the user's own trade against quota |

**Changing the passphrase never re-encrypts anything.** The account **seed** stays the same, and every
vault key derives from it (`KV = HKDF(seed, vault_id)`); changing the passphrase only re-wraps the seed
under a new key-encryption key — new salt and Argon2id parameters, but the **same** `auth_secret =
HKDF(seed, "auth")`. The same holds for regenerating the recovery code: a second wrapping of the same seed.
It does re-derive `kek_verifier`, since that verifier *is* the new key-encryption key's witness — the one
thing a passphrase change must not leave pointing at the old phrase. This follows the rule that runs through
the whole design — nothing ever re-encrypts existing content. (For this to hold the seed must be a **stable
random secret wrapped under the passphrase**, not derived from it — see AC-11.)

**Signing out one device is possible only because each device has its own refresh token.** A single
per-user token would make revocation all-or-nothing, which in practice means nobody uses it.

## Cryptographic operations live in the plugin

The web client does **not** perform key operations. Changing a passphrase requires the account seed (to
re-wrap it) in the browser — that is, the same cryptographic code that already exists in the plugin,
duplicated into a second environment before the first one is even written.

So for M5 the console shows the security section and hands the operation to the plugin ("open Obsidian to
change your passphrase"). The split is worth revisiting only when a browser-only client becomes a goal in
itself.

## Backup and restore from the console

The procedure and its reasoning are in [08 — Backup and restore](08-backup-restore.md); this is what the
console adds on top.

### Backups: trigger and observe, do not download

The console can start a backup and list previous runs with their status, size, blob
count, error and verification. A run records the **refusal window** and both legs (#114), and `CHECK`s reject a leg
taken outside it, or a blob leg the database leg did not precede — so a half-finished backup, or one whose two stores describe different instants, can
never be mistaken for a usable one.

**Verification is a first-class step**, not an aside: a Verify button on each finished run asks
the one integrity check — for every `nodes.sha256` and `versions.sha256`, does the copy hold
the bytes at that address — and reports the missing blobs by name. The check lives in
`server/src/backup.ts` (`verifyBackup`), shared with the restore rehearsal and any nightly
self-check that follows.

**Downloading a backup through the console is deliberately not a feature.** The reason is operational rather
than privacy — under E2EE the backup is ciphertext and would leak no content. A backup is the whole server's
data, and retrieval belongs at the operating-system / storage layer, at the same trust level as database
access, not as a convenience button in a management UI. The backup goes to its configured destination, and
getting it from there is an OS question.

**Backups require configuration.** Without `BACKUP_DESTINATION`, `BACKUP_DB_COMMAND` and
`BACKUP_BLOB_SOURCE` the button answers "not configured" rather than pretending; the three are
all-or-nothing (server/src/config.ts).

### Restore: the console cannot perform it

Restoring the database means replacing the database the console itself is running on. So the console does
not restore; it **prepares and confirms**:

- verify a backup: check that all `nodes.sha256` and `versions.sha256` values are present in the blob copy, report missing blobs;
- show the post-restore checklist;
- after a restore, take the confirmation and **raise `restore_epoch`** — an audited administrative action,
  because it forces every client into a full resync. The new value is `max(state file, restored database)
  + 1`, never a blind `+ 1` on what the restored database happens to hold: that value may be several
  restores behind, and re-issuing an epoch the server has already used makes stale cursors pass validation
  again. The console computes it and shows both inputs; the administrator confirms.

> **The console refuses to serve after an unconfirmed restore.** On every successful start the server
> writes the current epoch to a small state file that lives outside both the database dump and the blob
> store. If at startup the database's `restore_epoch` is *lower* than the file's, the database is older
> than this instance — a restore happened and nobody bumped the epoch.
>
> The server then halts and asks the administrator to choose: "restored from backup" (raise the epoch above
> the file's value, clients resync without applying deletions) or "this is not a restore" (investigate —
> the alternative is a database rollback nobody performed deliberately).
>
> The state file is also what makes the correct new epoch computable at all: it is the only record that
> survives the restore holding the newest epoch this server ever ran with.
>
> Without this guard the failure is silent: revision numbers get reused for different content, clients
> believe they are current, and the divergence surfaces weeks later as missing notes. Step 3 of the restore
> procedure — increment the epoch — is exactly the step a human forgets under pressure, so the machine
> checks it.

Automatic bumping is deliberately *not* done. A wrong automatic bump forces a full resync for everyone; a
wrong refusal costs one confirmation click.
