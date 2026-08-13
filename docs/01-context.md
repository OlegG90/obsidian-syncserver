# 01 — Context and scope

## The problem

One person keeps one or more Obsidian **vaults** on several devices and wants them synchronised.
Additionally, they want to open **individual folders** to other people using the same server, with **write**
access, revocable at any time. Resources outside the folder are not included; outward links intentionally
remain broken for participants.

The second requirement is the only reason this project exists. Multi-device sync alone is solved.

## Why not an existing tool

| Tool | Multi-device | Folder sharing with another **user** | Why it does not fit |
|---|---|---|---|
| Obsidian Sync (official) | yes | no | proprietary, not self-hostable |
| Self-hosted LiveSync (CouchDB) | best in class | no | no notion of "another user", no per-folder rights |
| Syncthing | yes | devices only | no rights, no invitations, no ACL; every peer holds a full copy |
| Remotely Save + S3/MinIO | yes | only via bucket policy | no invitations, no delta |
| git | yes | via repositories | poor with binaries and on mobile |

If per-folder ACL between users of one server ever stops being a requirement, this project should be
abandoned in favour of LiveSync or Syncthing. It is not otherwise better.

## The constraint that shapes everything

Joplin is an application over its own database, so its server synchronises *items* — a note is a row.
Obsidian is an editor over **a folder of files**, and it exposes **no synchronisation API** that a third
party can plug a backend into.

Two consequences follow, and every other decision descends from them:

1. **The system is necessarily in two parts**: a server and a purpose-built **Obsidian plugin** for
   desktop and mobile. There is no other way to connect.
2. **The unit of synchronisation is a file, not a note.** This simplifies the server — it never parses
   Markdown — and complicates sharing: a folder of notes is not a self-contained set of data, because
   attachments live elsewhere in the vault.

## What is synchronised

The vault is a folder of files, so the boundary has to be stated explicitly rather than implied.

| | Contents |
|---|---|
| **Always** | the whole vault tree — `.md`, attachments, canvas, bases, and any other file the user keeps in it |
| **Optional**, behind a separate switch | `.obsidian/` — the plugin and appearance configuration, with **per-device exceptions**: `workspace.json`, `graph.json`, plugin caches |
| **Never** | `.trash/`, `.git/`, `node_modules/`, anything in the user's own ignore list, and the artefacts of other synchronisers: `.stfolder`, `.stversions`, `~sync-conflict-*`, `_remotely-save-metadata-on-remote.json`, `conflicted copy` |

Three notes on the middle row, because it is the one that surprises people.

`.obsidian/` is **off by default** (#7): synchronising it wholesale makes desktop and mobile fight over
window layout and plugin state forever. Someone arriving from Obsidian Sync expects the opposite and will
wonder where their plugins went, so this belongs in the onboarding text and not only here.

Even when it is on, the per-device exceptions are not optional. `workspace.json` describes which panes are
open *on this screen*; propagating it between a laptop and a phone is not synchronisation, it is
interference.

The "never" list is enforced in two places: the watcher never queues those paths, and the pre-flight check
before a migration reports them (see [07](07-onboarding.md)). A file already uploaded by an earlier version
of the plugin is not retroactively removed — that would be a deletion the user did not ask for.

**Placeholder files are never uploaded.** iCloud, OneDrive and similar leave stubs on disk when "optimise
storage" is on; uploading a stub in place of the content is silent data loss, so the client refuses and
reports instead.

## Limits

| Limit | Purpose |
|---|---|
| quota per account | the accounting unit, summed across the account's vaults; see [03](03-data-model.md) |
| upload rate and unfinished-upload ceilings | anti-abuse; see [04](04-sync-protocol.md) |

These two are the whole list. There is no cap on the size of a single file and none on the number of nodes
in a vault: the account quota is what bounds both, and a second limit that nothing enforces reads as a
safeguard while being none.

## Scope

**In scope**

- synchronisation of the whole vault tree, as defined above;
- version history and server-side trash — a deleted node is a row that still has versions, not a separate
  entity;
- per-folder sharing between users of one server, **write access** (no read-only role, SH-10);
- **end-to-end encryption always** — the server reads neither content nor names (AC-08);
- quota accounting, garbage collection, backup and restore.

**Out of scope**

- real-time collaborative editing (no CRDT; see decision #4 — the slot is left open, the feature is not);
- a public multi-tenant service — the target is a family-sized self-hosted server behind a private
  network perimeter;
- migration of history from other tools: version history begins with the first write to this server.

## Deployment target

A home server (Docker), reachable only from inside a private network. Public exposure is deliberately out
of scope until authentication has been reviewed separately.
