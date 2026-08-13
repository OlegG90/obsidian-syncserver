/**
 * What state the sync is in, and where the user is allowed to read it.
 *
 * Two surfaces on purpose. The **status bar** is glanceable and is where anyone used to
 * Obsidian's own sync will look first — but it *does not render on mobile* (docs/02), so it
 * may carry a state and must never be the only place one appears. The **status panel** is
 * therefore the complete one, reachable by command on every platform.
 *
 * The panel exists for a reason this project met immediately: the first real sync reported
 * "0 up, 0 down" and there was no way to tell whether nothing had changed or the vault had
 * looked empty. A summary that cannot distinguish success from doing nothing is not a status.
 */
import type { SyncReport } from '../engine/engine.js';
import { priority } from '../engine/report.js';

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
      lines.push(`Uploaded: ${r.pushed.length}`);
      lines.push(`Downloaded: ${r.pulled.length}`);
      if (r.deleted.length) lines.push(`Deleted here, deleted on the server: ${r.deleted.length}`);
      if (r.removed.length) lines.push(`Deleted on the server, removed here: ${r.removed.length}`);
      // Zero, most of the time — worth a line only when adoption actually recognised
      // something, so an ordinary sync's summary is not padded with a row that reads "0."
      if (r.matched.length) lines.push(`Already on both sides, nothing sent: ${r.matched.length}`);
      if (r.scanned === 0 && r.pulled.length === 0 && r.pushed.length === 0 && r.matched.length === 0) {
        lines.push('');
        lines.push('No local files were found. If this vault is not empty, the plugin is not');
        lines.push('seeing it — which is a fault worth reporting rather than a quiet success.');
      }
      if (r.renamed.length) {
        lines.push('');
        lines.push(`Moved (${r.renamed.length}) — the same note, so its history followed it:`);
        for (const mv of r.renamed) lines.push(`  ${mv.from}  →  ${mv.to}`);
      }
      if (r.removed.length) {
        lines.push('');
        lines.push(`Deleted on the server, removed here (${r.removed.length}):`);
        for (const d of r.removed) lines.push(`  ${d.path}`);
      }
      if (r.quarantined.length) {
        lines.push('');
        lines.push(`This vault was reset on another device. Your unsynced work was kept, moved aside:`);
        for (const q of r.quarantined) lines.push(`  ${q.from}  →  ${q.to}`);
      }
      if (r.vanished.length) {
        lines.push('');
        lines.push(`Gone from this device (${r.vanished.length}), still on the server:`);
        for (const v of r.vanished) lines.push(`  ${v.path}`);
        lines.push('');
        lines.push('Nothing was deleted. A rescan cannot tell "the user deleted this" from');
        lines.push('"the folder was not mounted yet", and one of those answers destroys work.');
      }
      if (r.conflicts.length) {
        lines.push('');
        lines.push(`Conflicts (${r.conflicts.length}) — the server version is now the file; yours is beside it:`);
        for (const c of r.conflicts) lines.push(`  ${c.path}  →  ${c.conflictPath}`);
      }
      if (r.errors.length) {
        lines.push('');
        lines.push(`Failed (${r.errors.length}):`);
        for (const e of r.errors) lines.push(`  ${e.path} — ${e.message}`);
      }
      break;
    }
  }

  return lines;
};

const when = (at: number): string => new Date(at).toLocaleTimeString();
