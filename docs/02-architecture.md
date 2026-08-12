# 02 — Architecture

## Context (C4 level 1)

```mermaid
C4Context
    title SyncServer — context

    Person(owner, "Vault owner", "Syncs their vault across devices, shares individual folders")
    Person(member, "Another user of the server", "Accepts a share and sees the folder in their own vault")

    System(sync, "SyncServer", "Vault synchronisation and per-folder sharing between users")

    System_Ext(obsidian, "Obsidian", "Editor over a folder of files; has no synchronisation API")
    System_Ext(net, "Private network", "The only route to the server")

    Rel(owner, obsidian, "Writes notes")
    Rel(member, obsidian, "Reads and writes within their rights")
    Rel(obsidian, sync, "Synchronises through the plugin", "HTTPS; WebSocket from M2")
    Rel(sync, net, "Reachable only from inside")
```

Obsidian is an **external** system. It knows nothing about synchronisation, which is why the plugin
exists and why the system is in two parts.

## Containers (C4 level 2)

```mermaid
C4Container
    title SyncServer — containers

    Person(owner, "Vault owner", "")

    Container_Boundary(client, "User device") {
        Container(plugin, "Sync plugin", "TypeScript, Obsidian API", "Runs a sync on command, keeps local state, applies the remote tree")
        ContainerDb(idb, "Local state", "data.json", "Node tree: path to node_id, rev, hash. Path resolution lives only here")
    }

    Container_Boundary(server, "SyncServer") {
        Container(api, "Sync API", "TypeScript, Fastify", "Delta, node writes, blobs, shares, quota")
        Container(worker, "Background worker", "TypeScript", "Version thinning, quota reconciliation, blob GC, quarantine")
        Container(web, "Web UI", "TypeScript", "Account and share management, history metadata; no content browsing — the server cannot read content")
        ContainerDb(pg, "Metadata", "PostgreSQL", "Vaults, nodes, delta journal, versions, shares, blob accounting, key envelopes, dedup index")
        ContainerDb(blobs, "Blob store", "Filesystem or S3-compatible", "File content by sha256, immutable")
        ContainerQueue(bus, "Event bus", "LISTEN/NOTIFY", "New-revision notifications")
    }

    Rel(owner, plugin, "Works in the vault")
    Rel(plugin, idb, "Reads and updates state")
    Rel(plugin, api, "Delta, writes, blobs", "HTTPS")
    Rel(api, plugin, "Change notifications (M2)", "WebSocket")
    Rel(api, pg, "Reads and writes", "SQL")
    Rel(api, blobs, "Uploads and serves content")
    Rel(api, bus, "Publishes new-revision events")
    Rel(bus, api, "Fans out to subscribed connections")
    Rel(worker, pg, "Thins versions, marks dead blobs")
    Rel(worker, blobs, "Deletes after quarantine")
    Rel(web, api, "Same endpoints", "HTTPS")
```

Two things are worth reading from this level.

**Content and metadata are separate stores.** Everything that makes the system cheap — deduplication,
free renames, history, blobs shared between vaults through a share — rests on that split.

**The worker is separate from the API.** Version thinning and garbage collection must run as one nightly
pass in a specific order (see [03](03-data-model.md)); tying them to user requests would make that order
impossible to guarantee.

Cryptography is almost invisible on these diagrams, and that is the point: the keys live on the clients,
the server stores envelopes and never opens them.

## Sync API components (C4 level 3)

```mermaid
C4Component
    title Sync API — components

    Container(plugin, "Sync plugin", "TypeScript", "")
    ContainerDb(pg, "Metadata", "PostgreSQL", "")
    ContainerDb(blobs, "Blob store", "FS or S3", "")

    Container_Boundary(api, "Sync API") {
        Component(auth, "AuthService", "JWT, refresh", "Login, tokens, device registration, KDF parameters")
        Component(nodes, "NodeService", "TypeScript", "create, put, delete, move by node_id; one server transaction writes node, journal and version; recomputes ancestry on move")
        Component(delta, "DeltaService", "TypeScript", "Reads one journal — the caller's own; pins a snapshot, collapses changes")
        Component(blobsvc, "BlobService", "TypeScript", "Upload with quota and rate verdicts, authorisation by the caller's own live reference, Range serving")
        Component(history, "HistoryService", "TypeScript", "Version list, trash, restore as a new write with an old hash; transfers history on join and on thaw")
        Component(shares, "ShareService — M3", "TypeScript", "Shares, invitations, membership, freezing; fans a write out to live non-frozen participants")
        Component(events, "EventPublisher — M2", "TypeScript", "Fans out new-revision notifications over WebSocket")
    }

    Rel(plugin, auth, "Login and token refresh")
    Rel(plugin, delta, "Pulls changes")
    Rel(plugin, nodes, "Pushes local changes")
    Rel(plugin, blobsvc, "Checks presence, uploads content")
    Rel(plugin, history, "Versions, trash, restore")
    Rel(plugin, shares, "Creates, joins, leaves shares (M3)")
    Rel(nodes, shares, "A write inside a shared folder fans out to live non-frozen participants (M3)")
    Rel(nodes, events, "Announces a new revision (M2)")
    Rel(history, nodes, "Restore is an ordinary write")
    Rel(shares, history, "Hands over the interval on join and on thaw (M3)")
    Rel(nodes, pg, "One server transaction: node, journal, version — per eligible participant")
    Rel(blobsvc, blobs, "Reads and writes content")
```

`NodeService` is the only place a revision is born, which is why the three-way transaction converges on it.
A second write path bypassing it would desynchronise history from delta. For a shared write, the service
command owns the complete cross-vault transaction and its integration test; database triggers protect
row-local invariants but do not by themselves prove all-or-none fan-out.

**`ShareService` does not stand between a reader and someone else's data.** A participant reads their own
nodes, so nothing is evaluated at read time at all: the service's whole job is on the **write** path, where
one node write becomes up to eight ([05](05-sharing.md)).

Quota is not a component: the verdict an upload needs is computed inside `BlobService` (`mayAccept`), and
the accounting itself is schema counters — there is no separate service to place on this diagram.

## Plugin components (C4 level 3)

```mermaid
C4Component
    title Sync plugin — components

    Container(api, "Sync API", "HTTPS", "")
    System_Ext(obsidian, "Obsidian", "Vault API")

    Container_Boundary(plugin, "Sync plugin") {
        Component(ui, "UI", "Obsidian API", "Commands, settings, status bar and modal. Status bar is desktop-only, so it is never the only place a state appears")
        Component(sess, "Session", "TypeScript", "connect, open, lock, use. Owns the seed for the length of a session and the client for the length of a run; persists nothing")
        Component(engine, "SyncEngine", "TypeScript", "One pass reconciles: pushes, pulls, adopts a non-empty local vault on first contact, writes conflict files on a failed content precondition, and pushes and applies deletes — gated by the epoch the cursor probe answers (restore never wipes, reset quarantines)")
        Component(state, "LocalState", "data.json", "Node tree and what is already on the server; the only place paths are resolved to node ids")
        Component(vault, "VaultAdapter", "Obsidian API", "list, read, write, delete — the seam between the engine and the Obsidian vault")
        Component(shareui, "ShareManager — M3", "TypeScript", "Creates and joins shares; runs the additive key pass and the leave-time re-key")
        Component(attach, "AttachmentRouter — M2", "Obsidian API", "Keeps attachments created inside a shared folder inside it — a convenience, not a rule")
    }

    Rel(ui, sess, "Connects, unlocks, locks")
    Rel(ui, engine, "Runs one sync, inside session.use")
    Rel(sess, api, "Redeem, login, refresh")
    Rel(engine, api, "Pushes changes, pulls the tree — nine operations the engine declares as VaultWire")
    Rel(engine, state, "Reads and updates")
    Rel(engine, vault, "Lists, reads, writes")
    Rel(vault, obsidian, "Vault API")
    Rel(engine, shareui, "Share events: joined, ended; freeze and thaw (M3)")
    Rel(shareui, api, "Key envelopes and share-key names (M3)")
    Rel(attach, shareui, "Asks whether the note is inside a shared folder (M2)")
```

**A shared folder is an ordinary folder to every component above `ShareManager`.** That component handles
joining and leaving plus the two key passes described in [06](06-key-model.md); nothing else on the client
needs to know that a folder is shared. There is no read-only state to emulate (SH-10), nothing to mount, and
no detachment protocol for the client to drive — a participant's copy is their own from the start.

There is no watcher: sync is a command the user runs, and the engine's one pass is the whole reconciliation.
Adoption and conflict resolution are not components of their own — they are branches of that pass, and the
diagram above names no module the code does not have. `Session` is the one the M0.5 code grew into: it owns
the lifecycle `main.ts` used to hold in pieces, and it is what makes the passphrase-to-keys wiring testable
without launching an editor.

## Deployment

```mermaid
C4Deployment
    title Deployment on a home server

    Deployment_Node(host, "Home server", "Docker") {
        Deployment_Node(compose, "Docker Compose", "") {
            Container(caddy, "Caddy", "Reverse proxy", "TLS and routing")
            Container(api, "Sync API", "TypeScript, Fastify", "")
            Container(worker, "Background worker", "TypeScript", "")
            ContainerDb(pg, "PostgreSQL", "Database", "Vaults, metadata, journal, versions, shares")
        }
        Deployment_Node(vol, "Data volume", "Filesystem") {
            ContainerDb(blobs, "Blob store", "Hash-prefixed directories", "")
        }
    }

    Deployment_Node(desk, "Desktop", "Windows, macOS, Linux") {
        Container(pd, "Obsidian with the plugin", "Electron", "")
    }

    Deployment_Node(mob, "Phone", "Android, iOS") {
        Container(pm, "Obsidian with the plugin", "Capacitor WebView", "")
    }

    Rel(pd, caddy, "Sync", "HTTPS")
    Rel(pm, caddy, "Same; no background sync on iOS", "HTTPS")
    Rel(caddy, api, "Proxies")
    Rel(api, pg, "SQL")
    Rel(api, blobs, "Content")
    Rel(worker, pg, "SQL")
    Rel(worker, blobs, "Deletes after quarantine")
```

**The server is not published externally.** Access is from inside a private perimeter only, until
authentication has had a review of its own. That is a deployment constraint rather than an architectural
one — but while it holds, it is the boundary of the system.

## Deliberately absent

Named so that their absence reads as a decision rather than an omission:

- **the code level of C4** — there is no code yet, and describing classes in advance is fiction;
- **a WebDAV gateway** — a roadmap item (M5), not part of the system today;
- **a separate search service** — search stays in Obsidian, on the client. Server-side search is impossible
  under E2EE (the server cannot read content) and is not planned;
- **a cache or CDN in front of the blobs** — premature at the scale of a handful of people.

## Client constraints

The plugin ships as **one JavaScript bundle that runs both in Electron and in a Capacitor WebView**, which
rules out Node APIs and native dependencies. Practical consequences:

- no `fs`, no native image libraries — vault access goes through the Obsidian API;
- `manifest.json` must set `isDesktopOnly: false`;
- files are processed sequentially — mobile memory limits are real;
- iOS has no background synchronisation: sync happens when the app is open;
- **the status bar does not render on mobile.** It may carry a state, never alone.

Two further constraints shape the protocol rather than the code, and they are the reason for the section
below:

- **a plugin instance can only reach the vault it runs in.** Plugins are installed per vault, the API
  exposes that vault and no other, and switching vaults restarts the application. Anything the design asks
  a client to do "in another vault" is unimplementable;
- **the plugin exists only while the application is open.** There is no background execution to fall back
  on, so the server can never depend on a timely answer from a person.

## Talking to the user: states, not questions

The server does not ask questions. It holds **states**, and the client displays them; a question is only
posed when the user has already started the operation that needs it, and only for something the client
cannot observe on its own.

This is not a UI preference. A question needs an answer, an answer needs the application open on a
particular device, and there is no guarantee either ever happens. Anything built on a reply that may never
arrive stalls silently.

| Signal | Not this | This |
|---|---|---|
| over quota (SH-20) | a message to acknowledge | a state: sync stops, the panel says what is wrong. There is no decision to make — the way out is deleting something, which is ordinary vault editing |
| a share invitation | a dialog that interrupts | a list the user opens when they choose (`GET /shares`). Declining deletes it and frees the slot; ignoring it leaves it in the list |
| somebody joined, declined, or left | a push to the initiator | the membership list (`GET /shares/{id}/members`). The plugin diffs it against its own copy and writes a line in its log — the fact lives in the list, not in a message that can be missed |
| revocation, share ended | a notification | a state: the folder quietly becomes ordinary content; the event appears in the plugin's log |
| leave/revoke finalization (SH-29) | a task the user performs | a background metadata pass. It waits for the device to be opened, and blocks nobody while it waits |
| a conflict | a prompt to resolve | a file plus an entry in the conflict list — the pattern the rest of this table follows |
| which vault a share lands in | a choice to answer | **observed, not asked**: it is the vault the accepting client runs in (AC-Q4). This is the constraint above turned into a simplification — the question could not have been honoured anyway |
| `410 reset` on another device | — | **a real dialog, and the only one required by the server.** Deletions are about to be applied; the cost of guessing wrong is data ([07](07-onboarding.md)) |

Two dialogs remain in the whole design, and both open inside an action the user just started: choosing where
a replica root goes and what it is called, and confirming a reset on a second device.
