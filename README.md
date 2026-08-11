# SyncServer

A self-hosted synchronisation server for [Obsidian](https://obsidian.md) vaults, and the plugin
that talks to it. Multi-device sync of a user's vaults, plus per-folder sharing with other users
of the same server — **end-to-end encrypted, with the server holding no key.**

The functional analogue of Joplin Server, built for an editor that has no synchronisation API of
its own.

> **Status: in development.** The server and the plugin both run and are exercised by tests
> against a real database and a real server, but this has not been used to hold anything anyone
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
| 11 | [Management console](docs/11-management-console.md) | the two zones, account lifecycle, audit, backup operations |
| 12 | [Sharing scenarios](docs/12-sharing-scenarios.md) | the conditions 05 implements — one situation, one outcome, permanent ids |
| 13 | [Deployment and quick start](docs/13-deployment.md) | building the image, running it on a home server, claiming the first administrator |

Decision ids are shared by these documents and by the comments in `db/schema.sql`, so a rule can
always be traced from the constraint that enforces it back to the sentence that decided it.

## Running it

Requires **PostgreSQL 18+** and **Node 22+**.

```bash
npm ci
npm run db:reset          # drop the dev database, apply schema.sql + tests.sql, report
npm test                  # every workspace
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

A fresh installation answers `{"status":"ok","bootstrap_pending":true}` and serves nothing but
`/auth/kdf`, `/auth/redeem` and `/health` until its first administrator is claimed. The full
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

| Milestone | |
|---|---|
| **M0** — schema, blob store, auth, `delta`/`put`/`delete`, deployed and walked end to end | done |
| **M0.5** — the plugin: one-way sync, an empty vault materialised from the server | done |
| **M1** — two-way sync on a real vault | in progress: adoption, content conflicts and file renames work; folder renames, trash reconciliation, resync after the journal TTL and migration pre-flight checks do not yet |
| **M2** — WebSocket push, resumable upload, mobile, `.obsidian/` exclusions | not started |
| **M3** — folder sharing | designed in full, not built |
| **M4** — management console, version thinning, blob GC | not started |

[`docs/10`](docs/10-roadmap.md) has the acceptance scenarios each milestone is measured against.

**Not yet suitable for data you cannot lose.** A schema change still means starting the database
again (above); backups are documented ([`docs/08`](docs/08-backup-restore.md)) but not
automated; and nothing here has been through the kind of use that finds the last category of
bug.

## Security

End-to-end encryption is the point of this project rather than a feature of it, so the design is
written down in [`docs/06`](docs/06-key-model.md) — including the two threats that are easy to
conflate, and what the model does *not* protect against.

If you find something wrong with it, please open an issue describing the failure rather than a
patch that quietly changes a key rule: several of them look redundant and are not.

## Licence

Not yet chosen — until one is added, no permission to use, copy or modify this code is granted.
