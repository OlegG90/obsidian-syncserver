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
- Decision ids are cited, never re-explained: `#N` general and `AC-N` accounts/vaults live in
  `docs/09-decisions.md`, `SH-N` sharing in `docs/12-sharing-scenarios.md`. If you cite one,
  it must exist there.
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
| `scripts/` | database reset, packing a deployment archive, deploying, smoke-walking a server |

## Commands

```bash
npm run db:reset      # drop the dev database, apply schema.sql + tests.sql, report assertions
npm test              # every workspace's tests
npm run typecheck     # every workspace, including test-only tsconfigs
npm run test:live     # plugin tests against a REAL server it starts itself
```

`npm run test:live` resets its own database (`syncserver_plugin`), builds the server and runs
the plugin suite against it. It is the only thing that proves client, keys and server agree.

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

**Commits explain the change in prose.** What was wrong, why this is the fix, and what was
verified — enough that the reasoning survives without the conversation that produced it.

## Working on the schema and its tests

1. **Every new constraint ships with a negative test.** A rule with no test is a comment.
2. **A test that passes for the wrong reason is worse than no test.** `expect_fail` takes the
   expected `SQLSTATE` **and** a fragment of the message, and compares both (#101). Neither is
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
- Argon2id at 64 MiB is a floor the server enforces (#62). Do not lower it "for tests"; build
  the fixture around it instead.
