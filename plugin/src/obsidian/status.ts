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
import { categories, priority, type ReportCategory } from '../engine/report.js';

export type SyncPhase =
  | { kind: 'disconnected' }
  | { kind: 'locked' }
  | { kind: 'idle'; at?: number; report?: SyncReport }
  | { kind: 'syncing' }
  | { kind: 'failed'; message: string; at: number };

export const shortStatus = (phase: SyncPhase): string => {
  switch (phase.kind) {
    case 'disconnected':
      return 'Sync: not connected';
    case 'locked':
      return 'Sync: locked';
    case 'syncing':
      return 'Sync: working…';
    case 'failed':
      return 'Sync: failed';
    case 'idle': {
      if (!phase.report) return 'Sync: ready';
      // Which of the outcomes dominates is the report module's one precedence rule; this
      // surface only gives each mood a line.
      switch (priority(phase.report)) {
        case 'failed':
          return `Sync: ${phase.report.errors.length} failed`;
        case 'conflicts':
          return `Sync: ${phase.report.conflicts.length} conflict${phase.report.conflicts.length === 1 ? '' : 's'}`;
        case 'quarantined':
          return `Sync: ${phase.report.quarantined.length} kept aside after a reset`;
        case 'moved': {
          const r = phase.report;
          const moves = r.renamed.length ? ` ${r.renamed.length}→` : '';
          const dels = r.deleted.length || r.removed.length ? ` ${r.deleted.length + r.removed.length}✕` : '';
          return `Sync: ${r.pushed.length}↑ ${r.pulled.length}↓${moves}${dels}`;
        }
        case 'matched':
          return `Sync: up to date (${phase.report.matched.length} matched)`;
        case 'empty':
          return 'Sync: vault looks empty';
        case 'up_to_date':
          return 'Sync: up to date';
      }
    }
  }
};

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

/** The long form: everything the short one had to leave out. */
export const statusLines = (phase: SyncPhase, connection?: { serverUrl: string; login: string; vaultId: string }): string[] => {
  const lines: string[] = [];

  lines.push(connection ? `Server: ${connection.serverUrl}` : 'Server: not connected');
  if (connection) {
    lines.push(`Login: ${connection.login}`);
    lines.push(`Vault: ${connection.vaultId}`);
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
