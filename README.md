# SyncServer

[![tests](https://github.com/OlegG90/obsidian-syncserver/actions/workflows/ci.yml/badge.svg)](https://github.com/OlegG90/obsidian-syncserver/actions/workflows/ci.yml)

A self-hosted synchronisation server for [Obsidian](https://obsidian.md) vaults, and the plugin
that talks to it. Multi-device sync of a user's vaults, plus per-folder sharing with other users
of the same server — **end-to-end encrypted, with the server holding no key.**

The functional analogue of Joplin Server, built for an editor that has no synchronisation API of
its own.

> **Status: in development, version 0.4.0.** Two-way sync works on desktop and on Android against a
> self-hosted server: connect, pair a second device, adopt an existing vault, and conflicting edits
> keep both versions. **Folder sharing works too** — two accounts have shared a folder, written into
> it both ways and left it again, each keeping their copy — and **a vault can be recovered from the
> passphrase alone**, with no second device to ask. It has not yet been used to hold anything anyone
> would miss. See [Status](#status) for exactly how far it goes.

## What it does, and what it deliberately does not

The server stores **ciphertext and structure**. It never sees a note, a filename, or a key.

What it does see, and this is stated plainly rather than glossed over: the shape of the tree,
file sizes, modification times, version counts, and who synchronised when. Hiding that would be
a different product at a different price — the full list is in
[`docs/06`](docs/06-key-model.md#what-the-model-does-not-hide).

| | |
|---|---|
| **Encryption** | XChaCha20-Poly1305 per blob, under a key that is **random** — never derived from the content, so guessing a file does not decrypt it |
| **Keys** | `KEK = Argon2id(passphrase)` unwraps a random account seed; every vault key is an HKDF branch of it. Changing the passphrase re-wraps 32 bytes and re-encrypts nothing |
| **Sharing** | by **replication**, not mounting: each participant holds their own copy, so leaving a share leaves you with your files |
| **Deduplication** | per key scope, through an index keyed by `HMAC(scope key, hash)` — so it works where people share content and vanishes between strangers |
| **Storage** | metadata in PostgreSQL, content on disk, addressed by hash |

## How it is put together

```
plugin/   the Obsidian plugin — holds every key, does every encryption
  ├ crypto/   key hierarchy, blob format, names, envelopes, dedup tags
  ├ api/      the protocol client (transport injected, so it is testable without Obsidian)
  ├ engine/   what to push, what to pull, what is a conflict
  └ obsidian/ the adapters: requestUrl, the vault, the status surfaces

server/   Fastify + pg. No ORM
shared/   the wire contract, and only that
db/       schema.sql — the whole schema, and its tests
docs/     the design record: every rule lives here, and nowhere else
```

The server and the plugin are separate packages because they are separate programs with
opposite constraints: one runs under Node, the other is a single bundle inside an Electron
window and a Capacitor WebView with no Node APIs at all. The plugin's `tsconfig` declares
`"types": []`, so `fs` there is not merely discouraged — it is unreachable by the type checker.

**`shared/` exists to stop the contract being written twice.** Both sides have to know what a
`410` reason is, what a cursor payload contains, what a node type may be; two copies of that
drift, which is the failure this whole repository is arranged to avoid. Nothing that *runs*
goes in there — no configuration, no storage layout, nothing cryptographic (keys never leave
the client), and nothing either side can decide alone.

`db/` sits at the root beside `docs/` rather than inside `server/`, because the documentation
cites it as the executable half of the data model rather than as part of any one program.

### Using it

[`GUIDE.md`](GUIDE.md) is the one document written for the people who **use** this rather
than the people who build it: bringing a server up, claiming it, connecting a vault, adding
a second device, coming back after losing one, sharing a folder, and what actually frees
space. It is deliberately not normative — every rule it describes lives in `docs/`, and it
cites them rather than restating them.

### The design record

`docs/` is not commentary written after the fact — it is where decisions are made and the reason
each one holds is written down. [`docs/02`](docs/02-architecture.md) is the shortest way in.

| # | Document | Answers |
|---|---|---|
| 01 | [Context and scope](docs/01-context.md) | what problem, why not an existing tool, what is synchronised and what never is, limits |
| 02 | [Architecture](docs/02-architecture.md) | components, containers, deployment |
| 03 | [Data model](docs/03-data-model.md) | tables, invariants, quota accounting, garbage collection |
| 04 | [Synchronisation protocol](docs/04-sync-protocol.md) | cursors, delta, conflicts, blob transfer, authentication |
| 05 | [Sharing](docs/05-sharing.md) | replication, rights, propagation, history, quota and freezing, lifecycle |
| 06 | [Key model](docs/06-key-model.md) | key hierarchy, envelopes, threat model |
| 07 | [Onboarding and migration](docs/07-onboarding.md) | adoption of a non-empty vault, pre-flight checks, resets |
| 08 | [Backup and restore](docs/08-backup-restore.md) | backup order, restore epoch, client behaviour afterwards |
| 09 | [Decision index](docs/09-decisions.md) | `#N`, `AC-N`, `SH-N` → the rule the id names |
| 10 | [Roadmap](docs/10-roadmap.md) | milestones and the acceptance scenarios for the first release |
| 11 | [Management console](docs/11-management-console.md) | the two kinds of account, administration, audit, backup operations |
| 12 | [Sharing scenarios](docs/12-sharing-scenarios.md) | the conditions 05 implements — one situation, one outcome, permanent ids |
| 13 | [Deployment and quick start](docs/13-deployment.md) | building the image, running it on a home server, claiming the first administrator |
| 14 | [Using SyncServer](docs/14-user-manual.md) | **the user manual**: installing the plugin, connecting a vault, syncing, sharing, space |
| 15 | [Running a SyncServer](docs/15-operator-manual.md) | **the operator manual**: install, accounts, backups, restore, upgrade — as a procedure |

Decision ids are shared by these documents and by the comments in `db/schema.sql`, so a rule can
always be traced from the constraint that enforces it back to the sentence that decided it.

## Running it

Requires **PostgreSQL 18+** and **Node 22+**.

```bash
npm ci
npm run db:reset          # drop the dev database, apply schema.sql + tests.sql, report
npm test                  # every workspace, after asserting one version across all six manifests
npm run check:compose     # assert the shape the deployment depends on
```

`db:reset` recreates the database from nothing and runs the schema's own negative tests, which
live in one transaction that ends in `ROLLBACK` — so it leaves the database exactly as
`schema.sql` created it. `npm test` then runs the server's integration tests against it through
`app.inject()`: real handlers, real SQL, no port and no network.

`check:compose` exists because `docker-compose.yml` would otherwise be verified for the first
time on the machine it is meant to bring up. It parses the file and asserts two services, an
ordering that waits for health, both bind mounts, and no secret written down.

Both `psql` and Node must be on the **same side of the machine** as PostgreSQL. On Windows that
means running them from WSL: the development server listens on a unix socket there, and a
connection from the Windows side reports `client password must be a string`, which explains
nothing.

### Deploying it

Two containers — PostgreSQL and the server — and one file to edit:

```bash
cp .env.example .env      # generate the two secrets it asks for
docker compose up -d --build
curl -s localhost:8080/health
```

A fresh installation answers `{"status":"ok","bootstrap_pending":true,"version":"0.4.0"}` and serves
nothing but `/auth/kdf`, `/auth/redeem` and `/health` until its first administrator is claimed. The full
procedure, including the traps a NAS adds, is in [`docs/13`](docs/13-deployment.md).

### The plugin

```bash
npm run build --workspace @syncserver/plugin -- --vault /path/to/your/vault
```

That builds one CommonJS bundle straight into `<vault>/.obsidian/plugins/syncserver/`, which is
the installation — there is nothing to copy afterwards. Use `npm run dev --workspace
@syncserver/plugin -- --vault …` to rebuild on save.

### Changing the schema

**`db/schema.sql` is the only description of the schema, and it creates everything from
nothing.** There is no migration tool, deliberately: a migration directory is a second
description of the same thing, and two descriptions drift. Nothing is deployed with data worth
keeping, so a change is an edit plus `npm run db:reset`.

**That flips on the day of the first deployment that holds real data.** From then on migrations
are the source and `schema.sql` is generated from them — never the other way round, and never
both at once.

## Status

Current release: **0.4.0** — see [Versions](#versions).

| Milestone | |
|---|---|
| **M0** — schema, blob store, auth, `delta`/`put`/`delete`, deployed and walked end to end | done |
| **M0.5** — the plugin: one-way sync, an empty vault materialised from the server | done |
| **M1** — two-way sync on a real vault: adoption, conflict files, rename detection, full rescan, resync on a stale cursor | done — a live `journal_ttl` resync is the one path no suite can wait 90 days to run |
| **M2** — WebSocket push, resumable upload, mobile, `.obsidian/` exclusions | done — including **device pairing**, without which a phone cannot join an account at all |
| **M3** — folder sharing | works end to end and has been walked by two accounts: share, invite, accept, write from either side, leave. Thawing a frozen account with catch-up is the one path still unbuilt, and nothing yet marks a shared folder as shared in the file tree |
| **M3.5** — getting back in and getting out: recovery with the passphrase, an editable server address, disconnect, thawing with catch-up | done — walked on a third vault with no plugin state and no second device anywhere. Its last open item, a frozen account with nothing it could delete to free space, is closed by M4's purge |
| **M4** — space, and the history already on disk: emptying the trash, the nightly mark and sweep, the administrative API and its audit trail, the history/trash UI | done — walked by a person: a vault at 210% of its limit emptied its trash, the claim went with the row, and the collector unlinked the freed bytes. That pass found **six defects 302 green tests had no opinion about**, the quietest being a login the client stored without the server ever confirming it |
| **M5** — the operator's milestone: management console, backup operations, and an image pulled from a registry instead of built on the server | done — closed by a live walk that found nine defects, three of them regressions introduced by the fixes for the others |
| ~~**M6** — WebDAV gateway~~ | **dropped.** The vault is reached through the plugin; a second protocol into the same data is a second place to get the key model wrong |
| **M7** — the recovery code: the one loss nothing else answers, a forgotten passphrase | half done — an account can be given a code from the settings, and the server has taken it as a proof since M3.5. Redeeming one from the plugin is the remaining half |

M2 ended with a full pass on an Android phone against the home server: install, pair, adopt, sync both
ways, and a real conflict with neither version lost. That pass found **five defects a hundred and fifty
green tests had missed**, four of them at the Obsidian edge — which is why the adapters have had test
seams since, and why [`docs/10`](docs/10-roadmap.md) records what "mobile" had to mean before it could be
ticked.

M3 ended the same way, and more expensively. Two accounts on two machines shared a folder, wrote into
it from both sides and left it — and that pass found **eighteen defects that around five hundred green
tests had no opinion about**. They clustered: the client guessing at tables only the server can see, a
pass over a subtree that missed the trash and the version history, and refusals that stranded a vault
in a state its own buttons could not leave. Three tests were found to be asserting the bug rather than
the rule and were rewritten. The vault walked out of four broken states using nothing but the product's
own buttons, which is now a rule rather than an anecdote — see `AGENTS.md`.

[`docs/10`](docs/10-roadmap.md) has the acceptance scenarios each milestone is measured against.

**A device is no longer a single point of failure, and the passphrase now is.** A vault whose every device
is gone comes back from the address, the login and the passphrase — the client proves it can open the seed
envelope and the server returns it, having never seen the phrase. That trade is argued in full in
[`docs/06`](docs/06-key-model.md#bootstrap-on-a-device-that-has-no-seed): it makes the passphrase a single
factor, and a forgotten one still loses every vault, because the seed exists only inside envelopes it opens.

**Not yet suitable for data you cannot lose.** A schema change still means starting the database
again (above); backups are documented ([`docs/08`](docs/08-backup-restore.md)) but not
automated; and nothing here has been through the kind of use that finds the last category of
bug.

## Versions

**One number for the whole solution.** The server, the plugin, `shared/` and the management console
when it exists all ship the same `major.minor.patch` and are bumped together. They are one program
split across two machines by necessity, not four products with independent lives, and a compatibility
matrix between them would be a fiction nobody tests.

**The major number carries the compatibility promise.** Two builds with the same major are meant to
work together.

**While the major is `0`, the minor carries it instead** — which is what a leading zero means. `0.1`,
`0.2` and `0.3` are as unrelated as `1.x` and `2.x` will be. The rule collapses to the plain "same
major" on the day the first `1.0.0` ships, with no code change: the zero test simply stops being true.

`0.4.0` earns its number in both directions. Claiming an invitation now sends the login for the
server to **check**, so a `0.3` client omits a field a `0.4` server refuses on; and the trash answers
with a page and a total where it used to answer with a bare array, so a `0.3` client reading a `0.4`
server finds no list at all. The endpoints an operator uses — accounts, invitations, quotas, storage,
the audit log, account deletion — did not exist before it either.

`0.3.0` earned its number the same way: registration began requiring a recovery verifier and the
endpoints that hand an account back did not exist before it, so a `0.2` client could not claim an
invitation from a `0.3` server. That is the whole point of the number: neither build has to discover
any of this by failing.

The server reports its version from `/health`, and only there — it is the one endpoint open before
authentication and before an administrator exists, which is exactly when a client needs the answer:

```bash
curl -s localhost:8080/health
# {"status":"ok","bootstrap_pending":false,"version":"0.4.0"}
```

The plugin shows both numbers at the bottom of its settings tab and **warns** on a mismatch. It does
not refuse to sync: locking someone out of their own vault over a version string is the worse failure,
and it would happen in precisely the situation where the numbers are least trustworthy. The warning
exists because the alternative was watching a server eight commits behind its client answer `404` to a
route it had never heard of, with nothing on screen to say why.

Five files must carry the number and none can be dropped — npm requires one per workspace, Obsidian
requires one in `manifest.json`. `npm test` runs `scripts/check-version.mjs`, which fails when they
disagree. The rule itself is [#111](docs/09-decisions.md).

That check governs the repository, and its authority ends there. An **installed** plugin is two files
Obsidian reads separately — `manifest.json`, which it parses and shows in its plugin list, and
`main.js`, whose version was baked in at build time — and unpacking over an existing folder can
replace one and skip the other. The plugin compares the two at runtime and says the install is
incomplete, naming both. Exact equality there, not the major/minor rule: they leave one build
together, so a patch apart still means only one of them arrived.

One version it cannot report is the one that matters most on a running Obsidian: **`main.js` is read
once, when the plugin loads.** Copying a new bundle into a vault that is already open changes nothing
until the plugin is reloaded, while the plugin list — which re-reads manifests on its own — already
shows the new number. Toggle the plugin off and on; refreshing the list is not enough.

## Security

End-to-end encryption is the point of this project rather than a feature of it, so the design is
written down in [`docs/06`](docs/06-key-model.md) — including the two threats that are easy to
conflate, and what the model does *not* protect against.

If you find something wrong with it, please open an issue describing the failure rather than a
patch that quietly changes a key rule: several of them look redundant and are not.

## Licence

[MIT](LICENSE).
