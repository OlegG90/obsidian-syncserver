/**
 * The trash and the version list, which the server has served since M0 and no screen ever
 * called.
 *
 * Three endpoints existed before this file: the versions of a node, the trash of a vault, and
 * restore as a new write with an old hash. A person could delete a note and the server kept
 * every revision of it — with no way at all to see either. M4 adds the fourth, discarding for
 * good, and it is the one that makes the other three worth having a screen for: a trash you
 * cannot empty is a cupboard with no door.
 *
 * The same shape as `share-flow.ts` and for the same reason: a `PluginSettingTab` cannot be
 * constructed outside Obsidian, so anything decided inside one is decided where no test can
 * watch.
 *
 * What this owns, and a settings tab must not:
 *
 * - **names are ciphertext, and the key depends on the node.** A trashed node of a shared
 *   folder is still named under `KS` (SH-01 keeps the root under `KV`, the interior under the
 *   share key), so decrypting the listing means knowing which scope each row belongs to. The
 *   server says the scope id; only this side holds the keys;
 * - **nothing runs twice at once.** Restoring is a write, discarding is irreversible, and a
 *   second press partway through a list is how somebody discards what they meant to restore;
 * - **what "discard" actually costs**, said before it happens rather than after. It is the
 *   only act in the product that cannot be undone, and the answer says whether it freed
 *   enough to lift a freeze — because making room is usually why anybody asked.
 */
import { ApiError } from './api/client.js';

/** One node in the trash, as the person sees it. */
export interface TrashRow {
  nodeId: string;
  /** Decrypted, or the node id when this device holds no key for the scope it is named under. */
  name: string;
  type: string;
  deletedAt: string;
  /** How many revisions are still behind it — what restoring has to choose from. */
  versions: number;
  /** True when this node belonged to a shared folder, which changes nothing but is worth seeing. */
  shared: boolean;
}

/** One revision of a node, newest first. */
export interface VersionRow {
  rev: number;
  size: number;
  at: string;
}

/** A page of the trash, and how much of it there is. */
export interface TrashPage {
  rows: TrashRow[];
  /** The whole trash, which is what `Empty` acts on — never the length of `rows`. */
  total: number;
}

export interface HistoryFlowDeps {
  /** The trash, with names already decrypted — the scopes are the caller's to resolve. */
  trash(): Promise<TrashPage>;
  versions(nodeId: string): Promise<VersionRow[]>;
  /** Bring a node back at a revision. `409 name_taken` names what blocks it. */
  restore(nodeId: string, rev: number): Promise<void>;
  /** Discard for good: one subtree, or the whole trash. */
  discard(nodeId?: string): Promise<{ purged: number; thawed: boolean }>;
  /** How much of the limit is used, and whether the account is frozen. */
  usage(): Promise<{ used: number; quota: number; frozen: boolean }>;
  /** Asked before anything irreversible. `false` means the person said no. */
  confirm(question: string): Promise<boolean>;
  notify(message: string, durationMs?: number): void;
  /** The screen showing this is now out of date. */
  done(): void;
}

export interface HistoryFlow {
  trash(): Promise<TrashPage | undefined>;
  versions(nodeId: string): Promise<VersionRow[] | undefined>;
  restore(nodeId: string, rev: number): Promise<void>;
  discard(nodeId: string, name: string): Promise<void>;
  empty(count: number): Promise<void>;
  usage(): Promise<{ used: number; quota: number; frozen: boolean } | undefined>;
}

export const openHistoryFlow = (deps: HistoryFlowDeps): HistoryFlow => {
  /**
   * A failure becomes a sentence rather than an exception nobody catches.
   *
   * **Reads are not gated**, and that distinction cost a live walk. The screen asks for the
   * usage and the trash at the same moment — neither waits for the other, because both fill
   * in parts of one page — and a guard that covered every call let whichever arrived second
   * fail with "something else is running". The result read as a broken trash while the
   * server had answered both correctly.
   */
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (e) {
      deps.notify(`SyncServer: could not ${what} — ${reason(e)}`, 10000);
      return undefined;
    }
  };

  /**
   * One irreversible act at a time, which is what the guard was always for: discarding
   * cannot be undone, and a second press partway through a list is how somebody discards
   * what they meant to restore. Listing twice costs a round-trip and nothing else.
   */
  let busy = false;
  const once = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
    if (busy) {
      deps.notify('SyncServer: another trash operation is still running.');
      return undefined;
    }
    busy = true;
    try {
      return await attempt(what, run);
    } finally {
      busy = false;
    }
  };

  return {
    trash: () => attempt('read the trash', () => deps.trash()),

    versions: (nodeId) => attempt('read the history', () => deps.versions(nodeId)),

    restore: async (nodeId, rev) => {
      const out = await once('restore', async () => {
        await deps.restore(nodeId, rev);
        return true;
      });
      if (out) {
        deps.notify('SyncServer: restored. It will appear on the next sync.');
        deps.done();
      }
    },

    discard: async (nodeId, name) => {
      // The one act in this product that cannot be undone, so it is the one that asks. The
      // question names the file rather than the count: "discard 1 item" is what somebody
      // agrees to by reflex.
      if (!(await deps.confirm(`Discard “${name}” and its history for good? This cannot be undone.`))) return;

      const out = await once('discard it', () => deps.discard(nodeId));
      if (!out) return;
      deps.notify(said(out));
      deps.done();
    },

    empty: async (count) => {
      if (count === 0) {
        deps.notify('SyncServer: the trash is already empty.');
        return;
      }
      if (
        !(await deps.confirm(
          `Discard everything in the trash — ${count} item${count === 1 ? '' : 's'} — and all of its history? ` +
            'This cannot be undone.',
        ))
      ) {
        return;
      }

      const out = await once('empty the trash', () => deps.discard());
      if (!out) return;
      deps.notify(said(out));
      deps.done();
    },

    usage: () => attempt('read the usage', () => deps.usage()),
  };
};

/**
 * What to say afterwards, and the thaw is the half that matters.
 *
 * Somebody emptying their trash is usually doing it to make room, so "3 items discarded" is
 * an answer to a question they did not ask. Whether the freeze lifted is the one they did.
 */
const said = (out: { purged: number; thawed: boolean }): string => {
  const items = `${out.purged} item${out.purged === 1 ? '' : 's'} discarded`;
  return out.thawed
    ? `SyncServer: ${items}. That was enough — the account is no longer over its limit.`
    : `SyncServer: ${items}.`;
};

/**
 * A blocked restore is the one refusal a person can act on, so it says what blocks it rather
 * than repeating the status.
 */
const reason = (e: unknown): string => {
  if (e instanceof ApiError && e.code === 'name_taken') {
    return 'something is already there under that name. Rename it and try again.';
  }
  if (e instanceof ApiError && e.code === 'frozen') {
    return 'the account is over its limit, and restoring would add to it. Discard something first.';
  }
  return e instanceof Error ? e.message : String(e);
};
