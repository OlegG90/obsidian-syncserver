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
| **Optional**, behind a separate switch | under `.obsidian/`, an **allow list** — `snippets/`, `themes/`, `appearance.json`, `templates.json`, `daily-notes.json`, `types.json`, `bookmarks.json`, `hotkeys.json`. Nothing else: not `app.json`, not `core-plugins.json`, not `community-plugins.json`, not `workspaces.json`, and not `plugins/` |
| **Never** | `.trash/`, `.git/`, `node_modules/`, the `_Reset ` quarantine folder a `410 reset` moves the losing device's work into (docs/07), anything in the user's own ignore list, and the artefacts of other synchronisers: `.stfolder`, `.stversions`, `~sync-conflict-*`, `_remotely-save-metadata-on-remote.json`, `conflicted copy` |

Three notes on the middle row, because it is the one that surprises people.

`.obsidian/` is **off by default** (D-7): synchronising it wholesale makes desktop and mobile fight over
window layout and plugin state forever. Someone arriving from Obsidian Sync expects the opposite and will
wonder where their plugins went, so this belongs in the onboarding text and not only here.

**It is an allow list, and the inversion was learned rather than designed** (#314). The rule used to be
"everything under `.obsidian/` except a few per-device exceptions", on the assumption that configuration
is mostly shared and the machine-specific part is the special case. A real vault answered that a day
after the switch first worked: `community-plugins.json` held eleven plugins on a desktop and one on a
phone, `core-plugins.json` disagreed about `switcher` and `backlink`, and `app.json` carried a mobile
toolbar on the machine that has no touchscreen. Each produced a conflict file, and each would produce
another after every reconciliation, because those files were never two edits meeting — they were two
different machines. A deny list has to grow by one entry every time somebody finds another; an allow list
names the minority that actually belongs to the vault, which turns out to be short.

What travels is how the vault **looks** and what its content is shaped by: the snippets and themes a
person chose or wrote, which of them are on, and the templates, daily-note settings, property types and
bookmarks that describe the notes themselves. `hotkeys.json` travels with them because bindings follow a
person rather than a machine.

**`plugins/` stays on the device, all of it.** Plugins are installed deliberately, and a phone and a
laptop do not run the same set. That covers the code — `main.js` is the running plugin, and a pass that
overwrites its own code mid-walk is a self-reference, while nothing is lost by excluding it, since a
device cannot sync at all until the plugin is installed on it. It also covers plugin `data.json`, which
the earlier wording promised and should not have: BRAT's is the list of betas installed on *that*
machine, and this plugin's holds `connection.deviceId`, `connection.wrappedSeed`, `state.cursor` and
`state.nodes` — this device's identity and its private account of what it has synced. Another device
receiving those is not a preference travelling; it is one device being told it is another, believing it
has already synced files it does not have. Because the plugin reads `data.json` once at load and writes
memory back at the end of every pass, a copy that did arrive would be overwritten inside the same pass,
leaving a recorded hash that no longer matches the file — which reads as a local edit, so two devices
would push one node back and forth for ever (#303). `checks/check-config-scope.mjs` refuses any allow-list
entry under `plugins/`, because "plugin settings are configuration" is the most reasonable-looking edit
anyone will ever propose to that array.

Two mechanics follow from where the configuration directory lives, and both surprised us (#304).
Obsidian's file index does not carry it, so the plugin walks it separately — `vault.adapter` rather than
`getFiles()` — and only when the switch is on. And Obsidian raises no `create`/`modify`/`delete`/`rename`
for anything inside it, so a configuration change **starts no pass**: it travels with the next one, which
on a desk is the next note edit or the next press of the ribbon. The toggle says so, because a person who
changes a hotkey and watches nothing happen will otherwise conclude the switch is broken.

The directory is also not necessarily called `.obsidian` — a vault may rename it, and `vault.configDir` is
what says so. The scope rule takes the name from the adapter rather than assuming it; the per-device
exceptions are relative to it.

Turning the switch off does not delete what is already on the server: `.obsidian/` files are frozen in
place, exactly as the "never" list below treats files an earlier version uploaded. They stop being
scanned and pulled, and their state rows are kept so the switch can come back on without re-uploading.

`node_modules/` and `.git/` are enforced by `isSyncable` as **path segments**, at any depth and whichever
side of the `.obsidian/` switch they fall on. That sentence used to describe a watcher and a pre-flight
check rather than the scope rule, and the scope rule was where it had to be: for as long as the local scan
was `getFiles()`, neither a hidden `.git` nor anything under `.obsidian/` could reach it, so the missing
rule had nothing to match. The configuration walk reads `vault.adapter`, which sees every path — and a
plugin that vendors its dependencies put 29 MB of native binaries and Windows debug symbols in scope on a
real vault before anyone noticed (#312). The pre-flight check before a migration still reports these paths
(see [07](07-onboarding.md)); it is the second place, not the first.

A file already uploaded by an earlier version of the plugin is not retroactively removed — that would be a
deletion the user did not ask for. Which means a vault that ran 0.7.5 with the switch on keeps whatever it
sent: out-of-scope paths are frozen, and freezing is the right default even here, because the alternative
is one device deciding to delete a directory off every other device that still uses it.

**Placeholder files are never uploaded.** iCloud, OneDrive and similar leave stubs on disk when "optimise
storage" is on; uploading a stub in place of the content is silent data loss, so the client refuses and
reports instead.

## Limits

| Limit | Purpose |
|---|---|
| quota per account | the accounting unit, summed across the account's vaults; see [03](03-data-model.md) |
| upload rate and unfinished-upload ceilings | anti-abuse; see [04](04-sync-protocol.md) |
| one file, 2 GB | the same unfinished-upload ceiling, applied to a single blob: an upload that could never fit inside it could never complete, so it is refused at its first part rather than after the last (`413 too_large`) |

There is **no** cap on the number of nodes in a vault: the account quota is what bounds it, and a second
limit that nothing enforces reads as a safeguard while being none.

### What a device can carry

The 2 GB above is a rule the server applies. This is not a rule at all, and the difference matters: it is a
property of the machine, which no server can know and the client cannot honestly enforce.

**Reckon on a file costing twice its size in memory, briefly.** One nonce and one Poly1305 tag cover the
whole ciphertext ([06](06-key-model.md)), so a blob is sealed and opened in one pass over the whole value —
there is no chunk that can be encrypted and released before the next is read. Sending holds the plaintext
and the sealed blob together; receiving holds the ciphertext and the plaintext. Resumable upload
([04](04-sync-protocol.md)) divides what crosses the *wire*, not what is held in memory, and Obsidian's
request API buffers a whole request and a whole response besides.

On a desktop this is irrelevant — the 2 GB ceiling is reached long before the memory is. On a phone, where
the plugin runs in a WebView working within a few hundred megabytes and the operating system ends the
process rather than slowing it, the practical ceiling is **tens of megabytes, not hundreds**: a 100 MB
attachment is 200 MB of transient allocation before Obsidian's own filesystem layer takes its copy.

This is written down so it is told rather than discovered, since what a user sees when it is exceeded is
Obsidian closing, not an error. It is deliberately not enforced as a number in the client: the budget
depends on the device, the platform and what else is open, and a fixed figure would refuse files that work
on one phone while still failing on another. **Going below two copies would need a framed blob format** — a
nonce and a tag per frame — which is a format decision, not a limit ([10](10-roadmap.md)).

## Scope

**In scope**

- synchronisation of the whole vault tree, as defined above;
- version history and server-side trash — a deleted node is a row that still has versions, not a separate
  entity;
- per-folder sharing between users of one server, **write access** (no read-only role, SH-10);
- **end-to-end encryption always** — the server reads neither content nor names (AC-08);
- quota accounting, garbage collection, backup and restore.

**Out of scope**

- real-time collaborative editing (no CRDT; see decision D-4 — the slot is left open, the feature is not);
- a public multi-tenant service — the target is a family-sized self-hosted server behind a private
  network perimeter;
- migration of history from other tools: version history begins with the first write to this server.

## Deployment target

A home server (Docker), reachable only from inside a private network. Public exposure is deliberately out
of scope until authentication has been reviewed separately.
