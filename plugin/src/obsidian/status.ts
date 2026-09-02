/**
 * What state the sync is in, and where the user is allowed to read it.
 *
 * Three surfaces on purpose. The **status bar** is glanceable and is where anyone used to
 * Obsidian's own sync will look first — but it *does not render on mobile* (docs/02), so it
 * may carry a state and must never be the only place one appears. The **ribbon icon** is the
 * glanceable one that does render on a phone. The **status panel** is the complete one,
 * reachable by command on every platform.
 *
 * The ribbon exists because "not the only place" was satisfied on paper and not in practice:
 * the commands were there, so the rule was met, and a phone still showed *nothing at all*
 * until the user went looking for a command. A state you have to ask for is not a status.
 *
 * The panel exists for a reason this project met immediately: the first real sync reported
 * "0 up, 0 down" and there was no way to tell whether nothing had changed or the vault had
 * looked empty. A summary that cannot distinguish success from doing nothing is not a status.
 */
import type { SyncReport } from '../engine/engine.js';
import { counterText, displayFor, type PassProgress } from '../pass-progress.js';
import { categories, priority, type ReportCategory } from '../engine/report.js';

export type SyncPhase =
  | { kind: 'disconnected' }
  | { kind: 'locked' }
  | { kind: 'idle'; at?: number; report?: SyncReport }
  | { kind: 'syncing'; progress?: PassProgress }
  | { kind: 'failed'; message: string; at: number };

/**
 * An account state the server keeps repeating, if the last pass carried one.
 *
 * These are STATES, not events (docs/04): recomputed on every delta from what is true now,
 * repeated until they stop being true, and never a log. So they belong on a surface that is
 * always there — a person who never opens the settings has the status bar and the ribbon, and
 * nothing else.
 *
 * They used to be told once, as a twenty-second notice, beside a comment saying these were
 * "the two things nothing else on any screen would tell somebody". A live walk landed exactly
 * where that leads: an account went over its limit, said so once, and then every surface read
 * "up to date" while every write was being refused. The notice stays — the first time it is
 * news — and this is what makes it a state rather than a moment.
 *
 * Outranks every sync outcome, because it is the reason for them: files stopped moving because
 * the account stopped accepting them, and a status bar reporting "3 failed" is answering a
 * smaller question than the one the person has.
 */
const accountState = (phase: SyncPhase): string | undefined => {
  const events = phase.kind === 'idle' ? phase.report?.events : undefined;
  if (events?.some((e) => e.type === 'account_frozen')) return 'over your limit — nothing new is accepted';
  if (events?.some((e) => e.type === 'share_ended')) return 'a shared folder ended — open settings to finish';
  return undefined;
};

/**
 * The state on its own, without the word a surface puts in front of it.
 *
 * Split out because the ribbon needs both halves separately: on mobile it is an entry in a
 * menu of ACTIONS, so its registered name has to say what pressing it does, while its
 * accessible name — the desktop tooltip — is the place the state belongs. One string cannot
 * be both, and the one that was tried read as a report and reported the wrong thing (#285).
 */
export const phaseState = (phase: SyncPhase, now = Date.now()): string => {
  const state = accountState(phase);
  if (state) return state;
  switch (phase.kind) {
    case 'disconnected':
      return 'not connected';
    case 'locked':
      return 'locked';
    case 'syncing': {
      // The counter only once the pass has earned it (#319): a pass over an unchanged vault is over
      // in a fraction of a second, and a number that appeared and vanished on every save would be
      // movement rather than information. `working…` is what those say, as they always did.
      const display = phase.progress ? displayFor(phase.progress, now) : { kind: 'quiet' as const };
      return display.kind === 'counting' ? `working… ${counterText(display)}` : 'working…';
    }
    case 'failed':
      return 'failed';
    case 'idle': {
      if (!phase.report) return 'ready';
      // Which of the outcomes dominates is the report module's one precedence rule; this
      // surface only gives each mood a line.
      switch (priority(phase.report)) {
        case 'failed':
          return `${phase.report.errors.length} failed`;
        case 'conflicts':
          return `${phase.report.conflicts.length} conflict${phase.report.conflicts.length === 1 ? '' : 's'}`;
        case 'quarantined':
          return `${phase.report.quarantined.length} kept aside after a reset`;
        case 'moved': {
          const r = phase.report;
          const moves = r.renamed.length ? ` ${r.renamed.length}→` : '';
          const dels = r.deleted.length || r.removed.length ? ` ${r.deleted.length + r.removed.length}✕` : '';
          return `${r.pushed.length}↑ ${r.pulled.length}↓${moves}${dels}`;
        }
        case 'matched':
          return `up to date (${phase.report.matched.length} matched)`;
        case 'empty':
          return 'vault looks empty';
        case 'up_to_date':
          return 'up to date';
      }
    }
  }
};

/** What the status bar and the status screen say: the state, under the word they head it with. */
export const shortStatus = (phase: SyncPhase): string => `Sync: ${phaseState(phase)}`;

/**
 * The mood of a phase, as a Lucide icon name — what the ribbon shows.
 *
 * Deliberately few, and every one of them a name Obsidian has shipped for years. An icon
 * that does not resolve renders as nothing, which on the ribbon is indistinguishable from
 * the bug this surface was added to fix; a precise name that might not exist is a worse
 * trade than a general one that does.
 *
 * The icon carries the mood and the tooltip carries `shortStatus`, so nothing depends on
 * reading a glyph correctly — the same division the status bar and the panel already have.
 * `conflicts` and `quarantined` share the warning icon because to a person glancing at a
 * ribbon they are one thing: something needs you.
 */
export const phaseIcon = (phase: SyncPhase): string => {
  // The same precedence the words use: a frozen account is not a healthy tick, whatever the
  // pass that discovered it managed to move.
  if (accountState(phase)) return 'alert-triangle';
  switch (phase.kind) {
    case 'disconnected':
      return 'cloud-off';
    case 'locked':
      return 'lock';
    case 'syncing':
      return 'refresh-cw';
    case 'failed':
      return 'alert-triangle';
    case 'idle': {
      if (!phase.report) return 'check-circle';
      switch (priority(phase.report)) {
        case 'failed':
        case 'conflicts':
        case 'quarantined':
          return 'alert-triangle';
        case 'empty':
          return 'help-circle';
        default:
          return 'check-circle';
      }
    }
  }
};

/**
 * What the account is using, and whether it has been stopped for using too much.
 *
 * A freeze is an account **state**, not a message (docs/02): the server does not ask
 * anything, it stops accepting what would grow usage and waits. Which means the only way a
 * person learns of it is a surface that says so — and until this line existed there was
 * none, in any client, while the server computed and shipped the fact on every delta page
 * to nobody.
 */
export interface AccountUsage {
  used: number;
  quota: number;
  frozen: boolean;
}

const bytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
};

/** The long form: everything the short one had to leave out. */
export const statusLines = (
  phase: SyncPhase,
  connection?: { serverUrl: string; login: string; vaultId: string },
  usage?: AccountUsage,
): string[] => {
  const lines: string[] = [];

  lines.push(connection ? `Server: ${connection.serverUrl}` : 'Server: not connected');
  if (connection) {
    lines.push(`Login: ${connection.login}`);
    lines.push(`Vault: ${connection.vaultId}`);
  }

  if (usage) {
    lines.push(`Account: ${bytes(usage.used)} of ${bytes(usage.quota)} used`);
    if (usage.frozen) {
      // Said in full, because every part of it is a question somebody would ask next: what
      // stopped, what still works, and what to do about it (SH-20).
      lines.push(
        'FROZEN — over the limit. Nothing new is accepted, here or from anyone sharing with ' +
          'you; reading and deleting still work, and freeing space lifts it.',
      );
    }
  }

  switch (phase.kind) {
    case 'disconnected':
      lines.push('State: this vault is not connected to a server yet.');
      break;
    case 'locked':
      lines.push('State: locked — the passphrase is asked for once per session.');
      break;
    case 'syncing':
      lines.push('State: syncing now.');
      break;
    case 'failed':
      lines.push(`State: failed at ${when(phase.at)}`);
      lines.push(phase.message);
      break;
    case 'idle': {
      if (!phase.report) {
        lines.push('State: connected, nothing synced yet this session.');
        break;
      }
      const r = phase.report;
      lines.push(`Last sync: ${when(phase.at ?? Date.now())}`);
      lines.push(`Local files seen: ${r.scanned}`);
      // One precedence rule, one set of counts — report.ts's categories, in their order.
      for (const c of categories(r)) {
        lines.push('');
        lines.push(...categoryLines(c));
      }
      if (r.vanished.length) {
        lines.push('');
        lines.push(`Gone from this device (${r.vanished.length}), still on the server:`);
        for (const v of r.vanished) lines.push(`  ${v.path}`);
        lines.push('');
        lines.push('Nothing was deleted. A rescan cannot tell "the user deleted this" from');
        lines.push('"the folder was not mounted yet", and one of those answers destroys work.');
      }
      // The "saw nothing" warning is exactly the report module's `empty` mood — not a
      // conjunction that can fire beside a conflict list it contradicts.
      if (priority(r) === 'empty') {
        lines.push('');
        lines.push('No local files were found. If this vault is not empty, the plugin is not');
        lines.push('seeing it — which is a fault worth reporting rather than a quiet success.');
      }
      break;
    }
  }

  return lines;
};

/** The long form of one outcome: a count line, and the items when they are worth naming. */
const categoryLines = (c: ReportCategory): string[] => {
  switch (c.kind) {
    case 'failed':
      return [`Failed (${c.items.length}):`, ...c.items.map((e) => `  ${e.path} — ${e.message}`)];
    case 'conflicts':
      return [
        `Conflicts (${c.items.length}) — the server version is now the file; yours is beside it:`,
        ...c.items.map((x) => `  ${x.path}  →  ${x.conflictPath}`),
      ];
    case 'quarantined':
      return [
        `This vault was reset on another device. Your unsynced work was kept, moved aside:`,
        ...c.items.map((q) => `  ${q.from}  →  ${q.to}`),
      ];
    case 'unreadable':
      // Says what was NOT done and why, because the folder looks perfectly ordinary on disk
      // and its files silently stopped moving. "Nothing was changed" is the part that stops
      // this reading as damage.
      return [
        `Shared folder${c.items.length === 1 ? '' : 's'} this device has no key for (${c.items.length}):`,
        ...c.items.map((u) => `  ${u.path}`),
        '',
        'Nothing inside was changed, in either direction. The key reaches this device when',
        'the folder is shared with it again, or when another of your devices approves it.',
      ];
    case 'pushed':
      return [`Uploaded: ${c.items.length}`];
    case 'pulled':
      return [`Downloaded: ${c.items.length}`];
    case 'renamed':
      return [
        `Moved (${c.items.length}) — the same note, so its history followed it:`,
        ...c.items.map((mv) => `  ${mv.from}  →  ${mv.to}`),
      ];
    case 'deleted':
      return [`Deleted here, deleted on the server: ${c.items.length}`];
    case 'removed':
      return [
        `Deleted on the server, removed here (${c.items.length}):`,
        ...c.items.map((d) => `  ${d.path}`),
      ];
    case 'matched':
      return [`Already on both sides, nothing sent: ${c.items.length}`];
  }
};

const when = (at: number): string => new Date(at).toLocaleTimeString();
