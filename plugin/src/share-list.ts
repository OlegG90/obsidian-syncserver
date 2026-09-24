/**
 * The shared-folders list as one line per share, grouped by the folder each sits in (#428).
 *
 * The panel drew every share as a name, a row of controls and a full settings row per member —
 * four or five rows a share, in a sidebar leaf, with the same parent folder repeated on each. What
 * a person scans that list for is *which* folder and *whose*; the members and the actions are what
 * they open one share to reach. So the line carries the name, whose it is and how many hold it,
 * and the parent is said once, above its folders.
 *
 * Pure, and apart from the panel, because the panel is Obsidian's DOM and this is the part with
 * rules in it.
 */
import type { ShareMember } from './api/client.js';
import type { ShareRow } from './share-flow.js';

/**
 * The folders sharing one parent, under it. `parent` is `''` at the top of the vault, and
 * `undefined` for shares whose folder is not on this device yet.
 */
export interface ShareGroup {
  parent: string | undefined;
  shares: { row: ShareRow; name: string }[];
}

/**
 * Shares grouped by parent folder: the top of the vault first, then parents by name, each
 * group's folders by name.
 *
 * **A share with no folder here goes last, in a group of its own** (`parent` = `undefined`):
 * its replica has not synced to this device, so there is no parent to file it under — and
 * filing it under the top of the vault would say where it is, which nobody knows yet.
 */
export const groupShares = (rows: readonly ShareRow[]): ShareGroup[] => {
  const byParent = new Map<string, { parent: string; shares: ShareGroup['shares'] }>();
  const unplaced: ShareGroup['shares'] = [];
  for (const row of rows) {
    if (!row.folder) {
      unplaced.push({ row, name: 'A folder not synced here yet' });
      continue;
    }
    const cut = row.folder.lastIndexOf('/');
    const parent = cut < 0 ? '' : row.folder.slice(0, cut);
    const group = byParent.get(parent) ?? { parent, shares: [] };
    group.shares.push({ row, name: row.folder.slice(cut + 1) });
    byParent.set(parent, group);
  }

  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
  const groups: ShareGroup[] = [...byParent.values()]
    .sort((a, b) => a.parent.localeCompare(b.parent))
    .map((g) => ({ parent: g.parent, shares: g.shares.sort(byName) }));
  if (unplaced.length) groups.push({ parent: undefined, shares: unplaced });
  return groups;
};

/**
 * Whose the share is, in two words: `yours`, or `from <login>`.
 *
 * The initiator's login is in the membership, not in the share row, so until the members have
 * been read a share somebody else started says only that it is shared with you.
 */
export const whose = (row: ShareRow, members?: readonly ShareMember[]): string => {
  if (row.isInitiator) return 'yours';
  const initiator = members?.find((m) => m.is_initiator)?.login;
  return initiator ? `from ${initiator}` : 'shared with you';
};

/**
 * How many people the folder reaches, counted by what each one is doing about it.
 *
 * Three counts and not one, because they are three different answers to "who can read this":
 * a member holds a copy, an invitation not yet answered may become one, and somebody leaving
 * is on their way out. Zero counts are left out rather than printed as "0 invited".
 */
export const peopleLine = (members: readonly ShareMember[]): string => {
  const leaving = members.filter((m) => m.finalizing).length;
  const invited = members.filter((m) => !m.finalizing && !m.joined_at).length;
  const holding = members.length - leaving - invited;
  const parts = [`${holding} ${holding === 1 ? 'person' : 'people'}`];
  if (invited) parts.push(`${invited} invited`);
  if (leaving) parts.push(`${leaving} leaving`);
  return parts.join(' · ');
};

/**
 * What one member's line says about them. Three states, and they are not decoration: an
 * invitation has been sent and not answered, a member holds a copy, and somebody finalizing is
 * on their way out and cannot be removed again.
 */
export const memberState = (m: ShareMember): string =>
  m.finalizing
    ? 'leaving — their copy is being converted back'
    : m.joined_at
      ? m.is_initiator
        ? 'shared this folder'
        : 'holds a copy'
      : 'invited, no answer yet';
