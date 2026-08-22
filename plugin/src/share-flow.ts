/**
 * The sharing coordinator: every decision "share a folder" needs, outside a settings tab.
 *
 * The same shape as `sync.ts` and `pairing-flow.ts`, for the reason a phone taught this
 * project on 14 August: a `PluginSettingTab` cannot be constructed outside Obsidian, so
 * anything decided inside one is decided where no test can watch. Four of the five defects
 * that pass found lived in exactly that gap.
 *
 * What this owns, and the settings tab no longer does:
 *
 * - **nothing runs twice at once.** Sharing is several requests that leave the server in an
 *   intermediate state between them; a second press partway through would create a second
 *   share over a folder that already has one, and the failure would arrive from the schema
 *   rather than from anything a person could act on;
 * - **a folder must be synced before it can be shared.** Its node id is what the share is
 *   rooted at, and a folder this device has never uploaded has none;
 * - **the passphrase question happens once**, at the start, rather than partway through a
 *   sequence that has already changed the server;
 * - **what every outcome says**, including the one that is not a failure: leaving may end
 *   the share for everybody, and "you left" would be the wrong sentence for it.
 */
import { ApiError, type ShareMember } from './api/client.js';
import { busyLine, type Gate } from './gate.js';
import { holdsSynced, nothingToShare, shareableFolders } from './shareable-folders.js';

/** A share as the person sees it in the list. */
export interface ShareRow {
  shareId: string;
  isInitiator: boolean;
  state: string;
  /**
   * The folder this share is, as a path in THIS vault.
   *
   * Absent when the client cannot resolve it — a share whose replica it has not synced yet.
   * The server can never supply it: it holds no paths, and could not read the names if it
   * did.
   */
  folder?: string;
}

/** An invitation waiting for an answer. */
export interface InvitationRow {
  shareId: string;
  initiatorLogin: string;
}

export interface ShareFlowDeps {
  /** The one gate every operation family shares — one operation at a time, across all of them. */
  gate: Gate;
  /** What this account is in and what is waiting for it. */
  list(): Promise<{ joined: ShareRow[]; invitations: InvitationRow[] }>;
  /** Share a folder by its vault-relative path. Resolving it to a node is the caller's. */
  share(folderPath: string): Promise<{ shareId: string }>;
  /** Seal the share key to a login and register the invitation. */
  invite(shareId: string, login: string): Promise<void>;
  accept(shareId: string): Promise<void>;
  decline(shareId: string): Promise<void>;
  /** Leave; `ended` is true when this departure closed the share for everybody. */
  leave(shareId: string): Promise<{ ended: boolean }>;
  members(shareId: string): Promise<ShareMember[]>;
  /**
   * Withdraw an invitation, or revoke a participant. Which of the two it is belongs to the
   * server — it depends on whether they ever joined — so this asks and is told.
   */
  remove(shareId: string, userId: string): Promise<{ outcome: 'withdrawn' | 'revoked'; ended?: boolean }>;
  /** Every path the server knows, as this device last recorded them. */
  syncedPaths(): string[];
  /** Every folder that exists in this vault. */
  folders(): string[];
  notify(message: string, durationMs?: number): void;
  /** The screen showing this is now out of date. */
  done(): void;
}

export interface ShareFlow {
  list(): Promise<{ joined: ShareRow[]; invitations: InvitationRow[] } | undefined>;
  /**
   * The folders that could be shared right now, and — when there are none — why.
   *
   * Takes the folders already in a share rather than reading them: the caller has just
   * fetched the share list, and a share ended elsewhere while this screen was closed must
   * not still be filtered against.
   */
  shareable(shared: readonly string[]): { offered: string[]; reason?: string | undefined };
  share(folderPath: string): Promise<void>;
  invite(shareId: string, login: string): Promise<void>;
  accept(shareId: string): Promise<void>;
  decline(shareId: string): Promise<void>;
  leave(shareId: string): Promise<void>;
  members(shareId: string): Promise<ShareMember[] | undefined>;
  remove(shareId: string, userId: string, login: string): Promise<void>;
}

/**
 * What to tell somebody about a refusal, including the part they can act on.
 *
 * Two of the sharing refusals carry a work list the server went to trouble to compute:
 * which nodes are not prepared, which the finalization pass missed. Shown as
 * `409 share_not_prepared`, that trouble reaches nobody — and the one instruction a person
 * could follow ("sync, then try again") is exactly what is missing.
 */
const message = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  if (!(e instanceof ApiError)) return e.message;

  const gaps = e.carries('share_not_prepared')?.gaps.length ?? 0;
  if (gaps > 0) {
    return `${e.message}: ${gaps} item(s) in the folder are not ready to be shared. Sync this vault and try again.`;
  }

  const missing = e.carries('finalization_incomplete')?.missing.length ?? 0;
  if (missing > 0) {
    return `${e.message}: ${missing} file(s) of your copy were not converted. Sync this vault and try again.`;
  }

  // The schema's own sentence, when there is one. It is the most specific statement of what
  // was wrong that exists anywhere — written to be read, naming the node and the rule — and
  // dropping it left `400 invalid_write` on screen, which says only that something did.
  const detail = e.carries('invalid_write')?.detail;
  return detail ? `${e.message}: ${detail}` : e.message;
};

export const openShareFlow = (deps: ShareFlowDeps): ShareFlow => {
  /** One operation at a time, with its failure reported rather than thrown at the UI. */
  const once = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    // The shared gate, taken synchronously before any await, for the reason `sync.ts`
    // gives: two presses arrive as two calls before either has reached the network. It is
    // the SAME gate a sync takes, so a departure cannot start mid-pass or vice versa.
    if (!deps.gate.tryBegin(what)) {
      deps.notify(`SyncServer: ${busyLine(deps.gate.holding() ?? 'another operation')}`, 8000);
      return undefined;
    }
    try {
      return await fn();
    } catch (e) {
      deps.notify(`SyncServer: ${what} failed — ${message(e)}`, 10000);
      return undefined;
    } finally {
      deps.gate.end();
    }
  };

  return {
    list: () => once('reading the share list', () => deps.list()),

    // Not through `once`: nothing leaves this device, so taking the gate for it would make a
    // dropdown refuse while a sync ran, and there is nothing here for a sync to disturb.
    shareable(shared) {
      const folders = deps.folders();
      const offered = shareableFolders(folders, deps.syncedPaths(), shared);
      return { offered, reason: nothingToShare(offered, folders, shared) };
    },

    async share(folderPath) {
      // Checked before anything is created: a share rooted at a folder the server has never
      // seen cannot be made, and finding that out after the passphrase prompt and a request
      // would be a worse way to learn it.
      if (!folderPath.trim()) {
        deps.notify('SyncServer: choose a folder to share.');
        return;
      }
      // Kept although the screen now picks from a list rather than taking a typed path: the
      // list is built when the tab is drawn, and a folder can stop being synced-and-free
      // between then and the press. It is no longer the message a typo produces, which is
      // the whole point of the list.
      if (!holdsSynced(folderPath, deps.syncedPaths())) {
        deps.notify(`SyncServer: sync this vault first — the server does not know “${folderPath}” yet.`, 10000);
        return;
      }

      const out = await once('sharing the folder', async () => {
        const { shareId } = await deps.share(folderPath);
        return shareId;
      });
      if (!out) return;

      deps.notify(`SyncServer: “${folderPath}” is shared. Invite somebody to it.`);
      deps.done();
    },

    async invite(shareId, login) {
      if (!login.trim()) {
        deps.notify('SyncServer: enter the login to invite.');
        return;
      }
      const done = await once('inviting', async () => {
        await deps.invite(shareId, login.trim());
        return true;
      });
      if (!done) return;

      // Deliberately not "invited <login>": the pubkey endpoint answers an unknown login
      // with a deterministic fake rather than a 404 (D-73), so a success here does not mean
      // the account exists — and a message claiming it does would turn this into the
      // enumeration oracle that endpoint exists to prevent.
      deps.notify('SyncServer: invitation sent, if that login exists.');
      deps.done();
    },

    async accept(shareId) {
      const done = await once('accepting', async () => {
        await deps.accept(shareId);
        return true;
      });
      if (!done) return;

      deps.notify('SyncServer: joined. The folder arrives on the next sync.');
      deps.done();
    },

    async decline(shareId) {
      const done = await once('declining', async () => {
        await deps.decline(shareId);
        return true;
      });
      if (!done) return;

      // Absence from the member list is the whole record of a decline (docs/05), so this
      // notice is the only place it is ever said.
      deps.notify('SyncServer: invitation declined.');
      deps.done();
    },

    async leave(shareId) {
      const out = await once('leaving', () => deps.leave(shareId));
      if (!out) return;

      // Two different facts, and the wrong one is misleading: leaving as the initiator, or
      // as the last participant besides them, ends the share for everybody.
      deps.notify(
        out.ended
          ? 'SyncServer: the share is over for everybody. Your copy is yours now.'
          : 'SyncServer: you left. Your copy is yours now.',
      );
      deps.done();
    },

    members: (shareId) => once('reading the members', () => deps.members(shareId)),

    async remove(shareId, userId, login) {
      const out = await once('removing', () => deps.remove(shareId, userId));
      if (!out) return;

      // Three different things happened, and one word for all of them would be wrong twice.
      // Withdrawing takes back something nobody accepted; revoking leaves a person holding a
      // copy they still have to convert, which is not a punishment and should not read like
      // one; and revoking the last participant ends the share for everybody (SH-07).
      deps.notify(
        out.ended
          ? `SyncServer: ${login} was removed, and that ended the share. Your copy is yours — finish leaving to return it to your own key.`
          : out.outcome === 'withdrawn'
            ? `SyncServer: the invitation to ${login} was withdrawn. Nothing had been sent to them.`
            : `SyncServer: ${login} no longer receives this folder. They keep the copy they already have (SH-05).`,
        12000,
      );
      deps.done();
    },
  };
};
