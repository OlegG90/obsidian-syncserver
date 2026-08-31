# SyncServer

[![tests](https://github.com/OlegG90/obsidian-syncserver/actions/workflows/ci.yml/badge.svg)](https://github.com/OlegG90/obsidian-syncserver/actions/workflows/ci.yml)

A self-hosted synchronisation server for [Obsidian](https://obsidian.md) vaults, and the plugin
that talks to it. Multi-device sync of a user's vaults, plus per-folder sharing with other users
of the same server — **end-to-end encrypted, with the server holding no key.**

The functional analogue of Joplin Server, built for an editor that has no synchronisation API of
its own.

> **Status: in development.** Two-way sync works on desktop and on Android against a self-hosted
> server, folders can be shared between accounts, and a vault comes back from the passphrase alone.
> It has not yet been used to hold anything anyone would miss. See [Status](#status) for what has
> actually been walked, and the [releases](https://github.com/OlegG90/obsidian-syncserver/releases)
> for the current version — a number written here is a number that goes stale here.

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

`server/db/schema.sql` is the executable half of `docs/03` — its comments cite decision ids and
are part of the record — but it lives under `server/` all the same, because the server is what
applies it. It travels in the server's image and runs against an empty database on first boot,
which is the whole reason an installation is two files and not three. Citation does not need
adjacency: `docs/03` is normative for the schema wherever the schema sits.

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
| 15 | [Running a SyncServer](docs/15-operator-manual.md) | **the operator manual**: a copy-paste quick start with `docker compose`, then accounts, backups, restore and upgrading — as a procedure |

Decision ids are shared by these documents and by the comments in `server/db/schema.sql`, so a rule can
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

A fresh installation answers `{"status":"ok","bootstrap_pending":true,"version":"…"}` — the version being
whatever that server runs — and serves nothing but `/auth/kdf`, `/auth/redeem` and `/health` until its
first administrator is claimed. The full
procedure, including the traps a NAS adds, is in [`docs/13`](docs/13-deployment.md).

### The plugin

```bash
npm run build --workspace @syncserver/plugin -- --vault /path/to/your/vault
```

That builds one CommonJS bundle straight into `<vault>/.obsidian/plugins/syncserver/`, which is
the installation — there is nothing to copy afterwards. Use `npm run dev --workspace
@syncserver/plugin -- --vault …` to rebuild on save.

### Changing the schema

**`server/db/schema.sql` is the only description of the schema, and it creates everything from
nothing.** There is no migration tool, deliberately: a migration directory is a second
description of the same thing, and two descriptions drift. Nothing is deployed with data worth
keeping, so a change is an edit plus `npm run db:reset`.

**That flips on the day of the first deployment that holds real data.** From then on migrations
are the source and `schema.sql` is generated from them — never the other way round, and never
both at once.

## Status

**In development.** What follows is what a person has walked on a real vault — not what the tests cover,
which is a different and much easier claim:

- two-way sync on desktop and on Android, against a self-hosted server;
- pairing a second device, and adopting a vault that already has files in it;
- conflicting edits keeping both versions;
- sharing a folder between two accounts, writing into it from either side, and leaving it with your copy;
- getting back in with nothing: the passphrase alone recovers a vault, and a recovery code answers a
  forgotten passphrase;
- the operator's half — a management console, and backups taken, verified and restored from it.

**Every one of those was closed by a walk, and every walk found defects the suites had no opinion
about.** Five on an Android phone against a hundred and fifty green tests, four of them at the Obsidian
edge — which is why the adapters have had test seams ever since. Eighteen when two accounts shared a
folder, against around five hundred; three of the tests involved were found to be asserting the bug
rather than the rule. Six when a vault at 210% of its limit emptied its trash, the quietest being a
login the client stored without the server ever confirming it. Nine on the operator's milestone, three
of them regressions introduced by the fixes for the others. That the vault walked out of four broken
states using nothing but the product's own buttons is a rule in `AGENTS.md` now, rather than an anecdote.

[`docs/10`](docs/10-roadmap.md) has the milestones, what each one had to mean before it could be ticked,
and the acceptance scenarios it was measured against. It is the roadmap; this section is not a second one.

**A device is no longer a single point of failure, and the passphrase now is.** A vault whose every device
is gone comes back from the address, the login and the passphrase — the client proves it can open the seed
envelope and the server returns it, having never seen the phrase. That trade is argued in full in
[`docs/06`](docs/06-key-model.md#bootstrap-on-a-device-that-has-no-seed): it makes the passphrase a single
factor, and a forgotten one still loses every vault, because the seed exists only inside envelopes it opens.

**Not yet suitable for data you cannot lose.** A schema change still means starting the database again
(above), and nothing here has been through the kind of use that finds the last category of bug. Backups
are built and documented ([`docs/08`](docs/08-backup-restore.md)) — and **nothing takes one on a
schedule, by decision** ([D-121](docs/09-decisions.md)): a copy exists when somebody asks for one, which
is a rhythm this server does not pretend to keep for you.

## Versions

**One number for the whole solution.** The server, the plugin, `shared/` and the management console all
ship the same `major.minor.patch` and are bumped together. They are one program split across two
machines by necessity, not four products with independent lives, and a compatibility matrix between
them would be a fiction nobody tests.

**The major number carries the compatibility promise.** Two builds with the same major are meant to
work together.

**While the major is `0`, the minor carries it instead** — which is what a leading zero means. `0.1`,
`0.2` and `0.3` are as unrelated as `1.x` and `2.x` will be. The rule collapses to the plain "same
major" on the day the first `1.0.0` ships, with no code change: the zero test simply stops being true.

Each minor so far earned its number in **both** directions, which is the test the rule is applied by.
`0.4.0`, for one: claiming an invitation began sending the login for the server to check, so a `0.3`
client omitted a field a `0.4` server refuses on — and the trash began answering with a page and a
total where it had answered with a bare array, so a `0.3` client reading a `0.4` server found no list
at all. `0.3.0` had done the same a release earlier, when registration began requiring a recovery
verifier. That is the whole point of the number: neither build has to discover any of this by failing.

**A minor is a promise about compatibility, not a measure of how much was added.** Both directions get
checked before the number is chosen, and a release full of work that breaks nothing stays a patch.

The server reports its version from `/health`, and only there — it is the one endpoint open before
authentication and before an administrator exists, which is exactly when a client needs the answer:

```bash
curl -s localhost:8080/health
# {"status":"ok","bootstrap_pending":false,"version":"…"}
```

The plugin shows both numbers at the bottom of its settings tab and **warns** on a mismatch. It does
not refuse to sync: locking someone out of their own vault over a version string is the worse failure,
and it would happen in precisely the situation where the numbers are least trustworthy. The warning
exists because the alternative was watching a server eight commits behind its client answer `404` to a
route it had never heard of, with nothing on screen to say why.

**Six** files must carry the number and none can be dropped — npm requires one per workspace, Obsidian
requires one in `manifest.json`. `npm test` runs `checks/check-version.mjs`, which fails when they
disagree; the count changed the day the console became a workspace, and the check is what noticed.
The rule itself is [D-111](docs/09-decisions.md).

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
