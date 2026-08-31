# AGENTS.md — working in this repository

A self-hosted synchronisation server for Obsidian vaults, plus the Obsidian plugin that talks
to it. Everything is end-to-end encrypted: **the server stores ciphertext and holds no key.**

## The one rule that shapes everything else

`docs/` is the **design record and the only normative place a rule lives**. Code implements it;
comments explain themselves; nothing else states a contract.

- A new or changed rule goes into the right `docs/NN-*.md` file **in the same change** that
  implements it. A rule stated in two places is a contradiction waiting on a seam.
- `db/schema.sql` is the executable half of `docs/03`. Its comments cite decision ids and are
  part of the record, not decoration.
- Decision ids are cited, never re-explained: `D-N` general and `AC-N` accounts/vaults live in
  `docs/09-decisions.md`, `SH-N` sharing in `docs/12-sharing-scenarios.md`. If you cite one,
  it must exist there — `checks/check-citations.mjs` fails when it does not.
- **`#N` means a GitHub issue and nothing else.** It used to mean a decision, which put two
  numbering spaces in one notation until they collided: D-111 and D-114 through D-119 are all
  real issue numbers as well. GitHub renders `#N` as a link to issue N whether or not the
  repository agrees, so the platform owns that spelling and the decisions moved. Where the issue
  is genuinely meant and its number collides, write `issue #N` — `check-citations.mjs` insists.
- `docs/` carries the **current** state only — no changelogs, no "previously", no audit
  history. Git already keeps that.

## Layout

| Path | What it is |
|---|---|
| `docs/` | architecture, protocol, key model, roadmap — read before changing behaviour |
| `db/schema.sql` | the whole schema: tables, constraints, triggers. There is no migration tool, deliberately |
| `db/tests.sql` | negative tests for the schema, run inside a transaction that ends in `ROLLBACK` |
| `shared/` | types both sides agree on. Nothing runtime-heavy belongs here |
| `server/` | Fastify + `pg`. No ORM |
| `plugin/` | the Obsidian plugin: one bundle for Electron and a Capacitor WebView |
| `checks/` | the repository's own tests: one version across six manifests, `D-N` kept apart from `#N`, docblocks above their code, no workspace redeclaring a `shared` export, a compose file still shaped the way `docs/13` promises. Run by `npm test` and by CI |
| `tools/` | things a person picks up: database reset, packing a deployment archive, deploying, smoke-walking a server. Nothing in CI runs these |

## Commands

```bash
npm run db:reset      # drop the dev database, apply schema.sql + tests.sql, report assertions
npm test              # every workspace's tests
npm run typecheck     # every workspace, including test-only tsconfigs
npm run test:live     # plugin tests against a REAL server it starts itself
```

`db:reset` also sweeps `server/var/tmp`, where every suite writes its blob store — teardown
removes those, but a run that crashes or is interrupted never reaches its own, and residue
sitting beside `var/blobs` and `var/backups` reads as data.

`npm run test:live` resets its own database (`syncserver_plugin`), builds the server and runs
the plugin suite against it. It is the only thing that proves client, keys and server agree.

Run the plugin suite **only** through it. Started any other way it reaches whatever database is
already there, and the live tests fail on `bootstrap_pending` — "this test needs a fresh
database" is that message, not a broken client. Two suites sharing one database is the same
mistake in another shape: the first to claim the seeded administrator leaves the second
answering 503 to everything.

## Development environment

PostgreSQL 18+ and Node 22+ must be on the **same side of the machine**. On Windows that means
running everything from WSL: the development database listens on a unix socket there, and a
connection from the Windows side reports `client password must be a string`, which explains
nothing.

Two traps, both of which have cost real time here:

- **`bash -lc` may not see a Node installed under `~/.local`** — `-l` reads `.profile`, while a
  manual install usually appends to `.bashrc`, which non-interactive shells skip. Export the
  path explicitly rather than concluding Node is missing.
- **`node_modules` must be installed from the same side that runs the code.** Installing from
  Windows and running under WSL (or the reverse) leaves platform-specific binaries — esbuild,
  tsx — that fail with a message about the wrong platform.

## Conventions

**Comments say why, never what.** The code already says what. A comment earns its place by
recording a decision, a trap, or a consequence that is not visible locally — and prose in
this repository is written to be read, not skimmed.

**Failures explain themselves.** A refusal names what was wrong and, where it helps, what to
do instead. `500` for something the caller could fix is a defect; so is a message that makes
the reader guess which of several conditions failed.

**Statuses carry meaning.** `404` on a blob means "you hold no live reference", not "it is
missing"; `409` means the precondition failed; `410` says resync and why. Client code reads
the reason rather than assuming, because more than one condition can share a status.

**Tests assert behaviour, not implementation.** Prefer one that would fail if the rule were
broken over one that pins the current shape of the code. When a test and the design disagree,
find out which is wrong before changing either.

**One scenario is global, and it runs first.** "No administrator exists yet" is the server's
first-run state (D-107), and claiming the seeded administrator is **irreversible**: the last
active one cannot be demoted or disabled (D-88), and deleting an account is a procedure rather
than a statement (D-55). So `auth.test.ts` must meet a database no other suite has claimed —
which alphabetical order is what actually delivers, since the runner takes files in the order
the glob gives them. A new suite that needs an administrator therefore sorts **after** it, and
says so in its own header; that is why the operator's suite is `operator.test.ts`.

**A suite is split by scenario, never by module.** Following the source's file layout would
make the tests assert the implementation by arrangement even where each one asserts behaviour.
Fixtures shared by several suites live in `test/support/`, and each suite builds its **own**
world from them — its own app, accounts and vaults — because whoever claims the seeded
administrator first would otherwise leave the others answering 503 to everything.

**A test that talks to a live server never fakes the key derivation.** The plugin's session
module takes a derivation seam (`Session.forTests`) so unit tests can run fast and
deterministically — but `roundtrip.test.ts` is the only place that proves client, keys and
server agree, and it must run real Argon2id. A faked derivation there would silently void the
one proof the suite exists for. The separation is structural: the production entry points take
no derivation parameter, so substituting one on the live path requires calling a different,
test-only factory — visible in review, impossible to do by accident.

**Commits explain the change in prose.** What was wrong, why this is the fix, and what was
verified — enough that the reasoning survives without the conversation that produced it.

## What a live walk taught that ~500 green tests did not

Two accounts sharing a folder for real found eighteen defects the suite had no opinion about.
They were not exotic; they clustered, and the clusters are worth stating as rules.

**Every intermediate state must be walkable out of, using the product's own buttons.** Sharing,
inviting, leaving and revoking each leave the system half-converted for a while. A refusal that
strands a vault there — because the only way forward needs material an earlier defect never
wrote — is worse than the defect that caused it. Conversions that cannot proceed skip rather
than throw, and a departure in particular must always be able to finish.

**The server answers what only the server can see.** `blob_keys`, `dedup_index` and `versions`
are its tables. Every time the client guessed what they contained it guessed wrong in both
directions at once — convert everything and it fails on material that was never there, skip and
the write is refused instead. If a rule lives in the schema, the endpoint reports what that rule
still wants; the client produces it and does not decide what is owed.

**A node is not one blob, and a listing is not a tree.** History, the trash, and nodes another
participant created are all part of "the folder" and appear in none of the client's own
listings. Any pass over a subtree has to ask what the set actually is.

**Say the reason, not the category.** Half the walk was spent narrowing failures that arrived as
`invalid_write`. The refusal detail now reaches the screen, and the first message that carried
one identified its defect immediately.

**Content addressing reaches into the tests.** A blob is its bytes, so two tests writing the same
string share one blob — and material added by either answers the other's question. Fixtures that
must own their blob generate their content.

## Working on the schema and its tests

1. **Every new constraint ships with a negative test.** A rule with no test is a comment.
2. **A test that passes for the wrong reason is worse than no test.** `expect_fail` takes the
   expected `SQLSTATE` **and** a fragment of the message, and compares both (D-101). Neither is
   optional: nearly every trigger raises `check_violation`, exactly like a plain `CHECK`, so the
   code alone identifies nothing. The fragment is a constraint name for declarative constraints
   and a piece of the `RAISE` text for triggers.
3. **Deferred constraints need forcing.** `tests.sql` runs in one transaction ending in
   `ROLLBACK`, so a `DEFERRABLE INITIALLY DEFERRED` trigger would never fire at all. Tests force
   it with `SET CONSTRAINTS … IMMEDIATE`, and the file closes with `SET CONSTRAINTS ALL
   IMMEDIATE` so that a wrong fixture cannot sit there while every test aimed at it passes.
   Flush pending events *before* a test that targets a specific arm of such a trigger —
   otherwise the parent's queued event fires first and the failure arrives by the wrong path.
4. **A deferred check may not trust `NEW`.** It holds the row as it was when the event was
   queued, not as it stands at commit, so the trigger re-reads the row.
5. **Nothing derived from guessable user data may be stored unkeyed** — not a key, not a nonce,
   not "just a hash for uniqueness". Ask "can the input be guessed?", not "is this a key?".

There is no migration tool, deliberately: a change is an edit to `schema.sql` plus
`npm run db:reset`. That flips on the first deployment holding data worth keeping, after which
migrations become the source and `schema.sql` is generated from them — never both at once.

## Security invariants — do not weaken without changing `docs/06` first

- The passphrase never reaches the server; `auth_secret = HKDF(seed, "auth")` does.
- The content key `KC` is **random**, never derived from content. A convergent key hands the
  file to anyone who can guess it, and notes are guessable.
- Blob reads require a **live reference belonging to the caller** — a hash is not a capability.
- Argon2id at 64 MiB is a floor the server enforces (D-62). Do not lower it "for tests"; build
  the fixture around it instead.
