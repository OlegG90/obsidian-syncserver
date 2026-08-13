/**
 * What a `SyncReport` means to a person — one module, instead of one per surface.
 *
 * Two consumers used to compute this twice with different precedence. The status bar
 * (status.ts) let errors and conflicts dominate the ordinary counts, while the post-sync
 * Notice (main.ts) listed everything flat and never mentioned quarantine at all — a reset
 * that moved work aside could read "0 up, 0 down" and then "up to date" on the status bar.
 * Meaning lives here now: `priority` is the one precedence rule, `summary` is the ordered
 * parts, and every surface reads from the same two answers.
 *
 * Neither function depends on Obsidian, so the precedence is testable where the UI classes
 * are not (report.test.ts).
 */
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
 * The "what happened" parts, most important first, zeros skipped.
 *
 * A surface joins them (main.ts's Notice) or ignores them in favour of `priority` (the
 * status bar). The order is `priority`'s order, so the same report reads the same way on
 * both surfaces.
 */
export const summary = (report: SyncReport): string[] => {
  const parts: string[] = [];
  if (report.errors.length) parts.push(`${report.errors.length} failed`);
  if (report.conflicts.length) {
    parts.push(`${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'}`);
  }
  if (report.quarantined.length) parts.push(`${report.quarantined.length} kept aside`);
  if (report.pushed.length) parts.push(`${report.pushed.length} up`);
  if (report.pulled.length) parts.push(`${report.pulled.length} down`);
  if (report.renamed.length) parts.push(`${report.renamed.length} moved`);
  if (report.deleted.length) parts.push(`${report.deleted.length} deleted`);
  if (report.removed.length) parts.push(`${report.removed.length} removed`);
  if (report.matched.length) parts.push(`${report.matched.length} already in sync`);
  return parts;
};
