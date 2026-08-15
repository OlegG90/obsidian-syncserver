/**
 * What a `SyncReport` means to a person — one module, instead of one per surface.
 *
 * Consumers used to compute this with different precedence. The status bar (status.ts) let
 * errors and conflicts dominate the ordinary counts, the post-sync Notice (main.ts) listed
 * everything flat and never mentioned quarantine at all, and the long form (statusLines)
 * re-derived the same counts with its own labels — a reset that moved work aside could read
 * "0 up, 0 down" and then "up to date" on the status bar. Meaning lives here now:
 * `priority` is the one precedence rule, `categories` is the one structured answer (the
 * nonzero outcomes in precedence order, with the items that back them), `summary` is the
 * short projection of it, and every surface reads from the same answers.
 *
 * Nothing here depends on Obsidian, so the precedence is testable where the UI classes are
 * not (report.test.ts).
 */
import type { DeltaEvent } from '@syncserver/shared';
import type { SyncReport } from './engine.js';

/** The one precedence rule, in descending order of what demands attention. */
export type ReportMood =
  | 'failed'
  | 'conflicts'
  | 'quarantined'
  | 'moved'
  | 'matched'
  | 'empty'
  | 'up_to_date';

/**
 * What this report most importantly says.
 *
 * Failures and conflicts need a person, not just an eye — they dominate even when ordinary
 * movement also happened. Quarantine is the one outcome whose cost is data, so a reset that
 * moved work aside must never read as "up to date". Below that, ordinary movement beats
 * "nothing moved" — where matched (adoption recognised everything) is deliberately distinct
 * from an empty vault, which is the case this whole surface exists for.
 */
export const priority = (report: SyncReport): ReportMood => {
  if (report.errors.length) return 'failed';
  if (report.conflicts.length) return 'conflicts';
  if (report.quarantined.length) return 'quarantined';
  if (
    report.pushed.length ||
    report.pulled.length ||
    report.renamed.length ||
    report.deleted.length ||
    report.removed.length
  ) {
    return 'moved';
  }
  if (report.matched.length) return 'matched';
  return report.scanned === 0 ? 'empty' : 'up_to_date';
};

/**
 * What an account state means to the person it is true of (docs/04).
 *
 * The wording carries the consequence, not the name: "your share ended" tells somebody
 * nothing they can act on, while "the folder is yours to keep, press Leave to finish"
 * says what is owed and by whom. Both of these states are ones the server will keep
 * repeating until they stop being true, so the sentence has to survive being read twice.
 */
export const eventSentence = (event: DeltaEvent): string => {
  switch (event.type) {
    case 'share_ended':
      return 'A shared folder has ended. Your copy stays — open the plugin settings and press Leave to finish, which returns it to your own key.';
    case 'account_frozen':
      return 'Your account is over its limit and is frozen. Nothing new is accepted, from you or from anyone sharing with you; reading and deleting still work, and freeing space lifts it.';
    default:
      // A state this build does not know is still worth saying: the server is newer, and
      // silence would be indistinguishable from nothing being wrong.
      return 'The server reports a state this version does not recognise. Updating the plugin will name it.';
  }
};

/** One nonzero outcome, in precedence order, with the report's items that back it. */
export type ReportCategory =
  | { kind: 'failed'; items: SyncReport['errors'] }
  | { kind: 'conflicts'; items: SyncReport['conflicts'] }
  | { kind: 'quarantined'; items: SyncReport['quarantined'] }
  | { kind: 'pushed'; items: SyncReport['pushed'] }
  | { kind: 'pulled'; items: SyncReport['pulled'] }
  | { kind: 'renamed'; items: SyncReport['renamed'] }
  | { kind: 'deleted'; items: SyncReport['deleted'] }
  | { kind: 'removed'; items: SyncReport['removed'] }
  | { kind: 'matched'; items: SyncReport['matched'] };

/**
 * The report's outcomes, most important first, zeros skipped.
 *
 * The one place the counts and their order are decided. `vanished` is deliberately absent:
 * it is reported, never acted on, and neither `priority` nor `summary` reads it — a surface
 * that wants it reads the report directly.
 */
export const categories = (report: SyncReport): ReportCategory[] => {
  const out: ReportCategory[] = [];
  if (report.errors.length) out.push({ kind: 'failed', items: report.errors });
  if (report.conflicts.length) out.push({ kind: 'conflicts', items: report.conflicts });
  if (report.quarantined.length) out.push({ kind: 'quarantined', items: report.quarantined });
  if (report.pushed.length) out.push({ kind: 'pushed', items: report.pushed });
  if (report.pulled.length) out.push({ kind: 'pulled', items: report.pulled });
  if (report.renamed.length) out.push({ kind: 'renamed', items: report.renamed });
  if (report.deleted.length) out.push({ kind: 'deleted', items: report.deleted });
  if (report.removed.length) out.push({ kind: 'removed', items: report.removed });
  if (report.matched.length) out.push({ kind: 'matched', items: report.matched });
  return out;
};

const PHRASE: Record<ReportCategory['kind'], (count: number) => string> = {
  failed: (n) => `${n} failed`,
  conflicts: (n) => `${n} conflict${n === 1 ? '' : 's'}`,
  quarantined: (n) => `${n} kept aside`,
  pushed: (n) => `${n} up`,
  pulled: (n) => `${n} down`,
  renamed: (n) => `${n} moved`,
  deleted: (n) => `${n} deleted`,
  removed: (n) => `${n} removed`,
  matched: (n) => `${n} already in sync`,
};

/**
 * The "what happened" short parts, in `categories`' order — most important first.
 *
 * A surface joins them (main.ts's Notice) or ignores them in favour of `priority` (the
 * status bar). A projection of `categories`, so the counts and their order are decided once.
 */
export const summary = (report: SyncReport): string[] =>
  categories(report).map((c) => PHRASE[c.kind](c.items.length));
