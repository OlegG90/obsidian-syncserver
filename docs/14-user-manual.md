# Using SyncServer

For the person syncing a vault. If you are the one **running** the server,
[15](15-operator-manual.md) is yours.

Everything here happens in Obsidian, in **Settings → SyncServer**.

---

## The one thing to understand first

**The passphrase never leaves your device, and the server cannot recover it.**

Your keys are made from it, here, and the server only ever stores ciphertext — it cannot read a note, a
file name, or a folder name. That is what makes it safe to run on a NAS in a cupboard. It is also what
makes the passphrase unrecoverable: there is nobody to ask, no reset link, and no administrator who can
help. Lose it and every vault goes with it.

Put it somewhere you will still have it in three years.

There is one thing an administrator **can** do — see [Recover this account](#recover-this-account--when-no-device-is-left) —
but it needs the passphrase too. It is a way back for a lost *device*, never for a lost passphrase.

---

## Installing

The plugin is not in Obsidian's community list yet, so it is installed with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Obsidian's community plugins.
2. BRAT → **Add beta plugin** → `OlegG90/obsidian-syncserver`.
3. Enable **SyncServer** in the plugin list.

BRAT offers updates from then on. The settings tab shows the running version at the bottom, and says so
in red if `main.js` and `manifest.json` disagree — which means a half-finished install, not a bug.

---

## Connecting a vault

You need three things, and all three routes below use the same three:

| | |
|---|---|
| **Server URL** | where the server is — `http://host:8087`, a host name, a tunnel. Only this device uses it. |
| **Login** | who you are on that server. |
| **Passphrase** | never sent anywhere. Read the section above before choosing one. |

Fill those in, then pick **one** of the three things underneath.

### Claim an invitation — a brand-new account

The only route that needs a token. Your administrator issues one from the console; it appears once and
is not stored, so if it is lost it has to be reissued.

**This is the only route that asks for the passphrase twice**, and it is worth knowing why. Everywhere
else the passphrase is *checked* against something that already exists, so a typo fails and costs you a
retry. Here it is what your keys are **made from** — so a typo does not fail. It succeeds, at creating
an account nobody can ever open, including you, including your administrator. There is no reset, because
the server never sees the passphrase at all.

There is a **show** button beside the field. Use it: this is a string you want to be right.

Paste the token and press **Connect**. Your keys are generated on this device, from the passphrase.
Deriving them takes a few seconds and is meant to — it is what makes a guessable passphrase expensive to
attack.

### Add this device to an account — a second phone, laptop, or desktop

For an account that already exists **and still has a working device**.

1. On the **new** device, press **Show pairing code**. A short code appears, with **Copy** beside it.
2. On a device that is **already connected**, open Settings → SyncServer → **Add another device**, enter
   the code, and press **Approve**.

The connected device seals your account key to the new one. The server relays the sealed envelope and
cannot open it. Case, dashes and stray whitespace do not matter — type it or paste it. A pairing lasts
ten minutes.

Then the new device asks **which vault** it should sync, which is the next section.

### Which vault — and a second one

Once a device is admitted to the account, it asks what it is syncing. That is a question and not a
default, because the two answers do opposite things:

| you choose | what happens |
|---|---|
| **an existing vault**, by name | its contents and this Obsidian vault are **merged** — identical files join up, different ones become conflict files, nothing is deleted on either side |
| **Make a new vault** | what is here is uploaded as a vault of its own. **Nothing is merged**, and no other vault is touched |

One account can hold **several vaults**, and that is how you sync two different Obsidian vaults under
one login: pair the second one, then choose *Make a new vault*. The name is suggested from the Obsidian
vault you are in, which is usually what you want it called.

The vaults never mix. Each has its own key, so the same note in two vaults is stored under two
different addresses — one vault can learn nothing about another, not even that they hold the same file.

**Your quota is per account, not per vault**: everything you store across all of them counts against
one limit.

### Recover this account — when no device is left

When there is no working device left to approve a new one.

The passphrase proves itself to the server, which hands back the account key it has always held sealed.
It cannot read that key, and it never sees the passphrase.

This is the door for a lost, broken or stolen device. It is **not** a door for a forgotten passphrase.

---

## Everyday syncing

**It syncs on its own a few seconds after you stop changing things.** Edit a note, leave it alone, and
the sync happens — you do not have to press anything. A burst of work costs one sync rather than one per
file, and the wait is there on purpose: it lets Obsidian finish writing the note before it is sent.

This is **on at a desk and off on a phone**, and it is per device. *Sync after local changes*, under
**Server and sync options**, is where you change it — a phone on a battery and a metered connection is a
different proposition from a desktop, which is why the two start differently.

You can also start one yourself, at any time:

- the **ribbon icon** (the one that shows the sync state) syncs on click;
- **Sync now** in the settings tab;
- **Sync now** in the command palette.

Changes **coming the other way** arrive on their own too — another of your devices saving a note, or a
shared folder moving. There is no timer anywhere in this; it is a live connection, so the change arrives
rather than being waited for.

**A sync that moved nothing says nothing.** You will not get a notice every few minutes telling you
there was nothing to do. Anything that needs you — a conflict, a file that failed, an account over its
limit — is still said, and the sync state is always on the ribbon icon.

### When a sync misses a change you know you made

A sync does not re-read a note whose size and modification time are both exactly what they were last
time — it takes the file's word that nothing happened. That is what makes a sync of a large vault quick,
and it is right almost always.

It is wrong in one situation: something changed a file **without** changing its modification time.
Restoring notes from a backup does that, so do some file-copying tools, and so does another sync program
writing into the same folder. Obsidian editing a note never does — it always stamps the file.

If you have done something like that and a sync reports nothing, run **Full rescan (read every file)**
from the command palette. It reads everything and costs a little time on a big vault. You do not need it
after ordinary editing, and you never need it after a restore *of the server* — the plugin already reads
everything on the pass that follows one.

**But only while this session is unlocked.** A change arriving in the background must never pop up a
passphrase prompt, so if the vault is locked the hint is ignored and nothing is pulled until you sync
yourself. That is the answer to "my laptop saved an hour ago and this device still has not seen it".

The passphrase is asked for **once per session** — the first time a sync runs after Obsidian starts.
Nothing is written down; closing Obsidian forgets it. To forget it sooner, run **Forget the passphrase
until next unlock** from the command palette.

### What the state surfaces tell you

Three places, on purpose, because none of them works everywhere:

| where | shows | note |
|---|---|---|
| **ribbon icon** | the mood, as an icon; the wording as a tooltip | works on mobile |
| **status bar** | one line | **does not render on mobile** |
| **Show sync status** (command palette) | the complete report | works everywhere |

The short line distinguishes two things that look alike and are not:

- **`up to date`** — nothing needed doing;
- **`vault looks empty`** — no local files were found at all. If your vault is not empty, the plugin is
  not seeing it. That is worth reporting, not a quiet success.

Two states outrank every sync result, because they are the *reason* for it, and they stay on screen
until they stop being true:

- **`over your limit — nothing new is accepted`.** The account is frozen. Reading and deleting keep
  working; deleting is the way out. See [Space](#space-and-the-trash).
- **`a shared folder ended — open settings to finish`.**

### Conflicts

When the same file changed in two places, **the server's version becomes the file** and yours is kept
beside it as `Note (conflict 2026-08-01 laptop).md` — the date and the device that had the other copy.

Nothing is thrown away. You decide which to keep, by hand.

### Files that vanished

If files are on the server but gone from this device, the plugin **does not delete them from the
server**. It says so and stops. A rescan cannot tell "the user deleted this" from "the folder was not
mounted yet", and one of those answers destroys work.

### Folders you have no key for

A shared folder whose key has not reached this device is listed as unreadable and **skipped in both
directions** — nothing inside it is changed. The key arrives when the folder is shared with this device
again, or when another of your devices approves it. Everything else keeps syncing.

### `.obsidian/` configuration

Off by default. Turning it on syncs plugins and appearance — **not** per-device state: workspace layout,
the graph view and plugin caches stay on this device.

---

## Sharing a folder

**Settings → SyncServer → Shared folders.**

Sharing gives another person on the same server a **replica** — their own copy of the folder, which they
keep even if the share later ends.

**Share a folder:** type its path and share it. The folder must be synced first. Its contents are re-keyed
so participants can read them; the folder's own name is not, so it stays private to you.

**Invite** someone by login. They see the invitation in their own settings and can **Accept** or
**Decline**. Accepting materialises a copy in their vault, which arrives on their next sync.

**Withdraw** an invitation nobody answered; **Revoke** somebody who joined. Either way **their copy
stays** — that is what replication means. What stops is propagation: nothing further reaches them.

**Leave** a share you are in. Your copy stays and quietly becomes private files again. Leaving needs
every name in the folder to be readable on this device, so it refuses rather than half-finishing.

A share ends when the person who started it leaves, or when the last other participant does.

---

## Space and the trash

**Settings → SyncServer → Trash and history.**

Deleting a note does not free space: the file goes to the trash, and its history stays behind it. The
usage line shows what the account is using against its limit.

**Restore** brings a deleted file back. **Discard** removes one for good. **Empty the trash** discards
every deleted file and all of its history — and it is **the only action that lowers what the account is
using.**

Space is not freed the instant you empty it: a background pass on the server clears the freed bytes
shortly afterwards.

### If the account freezes

Over the limit, the account stops accepting anything that grows usage — from you, and from anyone
sharing with you. Reading and deleting keep working, and **nothing is ever deleted for you**.

The way out is yours and needs no administrator: empty the trash, wait for the next collector pass, and
the account thaws on its own. Anything that arrived while it was frozen is delivered then.

---

## Moving the server

**Settings → SyncServer → Server address.** An IP, a host name, a tunnel — it only describes where *this
device* talks. Changing it locks the session, so the next sync asks for the passphrase again.

Do this rather than disconnecting and connecting again: the invitation that created your account is
one-time and already spent.

---

## Disconnecting

Stops this device syncing and forgets the connection. **Every file stays** — on this device and on the
server.

Coming back needs the passphrase, or another device that is still connected.

---

## When something looks wrong

| what you see | what it means |
|---|---|
| `nothing answered at <address>` | the address is the likeliest mistake — check the URL and the port |
| `Sync: vault looks empty` on a vault that is not | the plugin is not seeing your files; worth reporting |
| a red line under the version | `main.js` and `manifest.json` disagree — reinstall through BRAT |
| `Sync: over your limit` | see [If the account freezes](#if-the-account-freezes) |
| `restore_pending` from every request | the administrator restored a backup and has not confirmed it; their console has the way out |
| `the server is being backed up` | a backup is running. New writes wait; it is over in seconds |

The status panel — **Show sync status** — is the complete answer, and the place to look before reporting
anything: it lists what moved, what failed, what conflicted, and what was skipped.
