/**
 * Finding the folder to share by typing part of its path, without bringing back a misspelling
 * that reads like a refusal (issue #455).
 *
 * The picker was a dropdown of every folder `shareable-folders.ts` offers, which in a vault of a
 * few hundred folders is a list scrolled rather than read. It became a text field with
 * suggestions — and a text field is exactly what issue #125 replaced, because "the server does
 * not know that folder yet" answered a typo and a genuine refusal in the same words. So the field
 * only ever **names** a folder from the offered list: whatever is typed is resolved against it
 * here, and anything that resolves to nothing is answered on this device and never sent.
 */

/**
 * The offered folders that match what has been typed so far.
 *
 * Every word must appear somewhere in the path, case-insensitively and in any order: a folder is
 * remembered by a word or two from different levels (`2026 archive` for `Projects/Archive/2026`),
 * rarely by its first characters. A folder whose own name holds the last word comes before one
 * that only sits under a parent holding it — typing `notes` is looking for a folder called that,
 * not for everything beneath one. Otherwise the offered order stands, which is alphabetical.
 */
export const suggestFolders = (offered: readonly string[], query: string): string[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...offered];
  const last = words[words.length - 1]!;
  const hits = offered.filter((f) => {
    const path = f.toLowerCase();
    return words.every((w) => path.includes(w));
  });
  const ownName = (f: string): boolean => f.slice(f.lastIndexOf('/') + 1).toLowerCase().includes(last);
  return [...hits.filter(ownName), ...hits.filter((f) => !ownName(f))];
};

/**
 * The folder the field names, or the sentence that says why it names none.
 *
 * Exact first; then the one folder that matches ignoring case and a trailing slash, because
 * `work/notes/` typed by hand means `Work/Notes` and nothing else could be meant. Two folders
 * that differ only by case are both real on a case-sensitive file system, and then only the exact
 * spelling picks one.
 *
 * The two refusals are different situations: text that is the beginning of something offered
 * needs a choice from the list, while text that matches nothing offered will not start matching
 * by being sent — the folder is unsynced, inside a share, or not there at all.
 */
export const pickFolder = (
  offered: readonly string[],
  typed: string,
): { folder: string } | { reason: string } => {
  const text = typed.trim().replace(/\/+$/, '');
  if (!text) return { reason: 'Type part of a folder path, then pick the folder from the list.' };
  if (offered.includes(text)) return { folder: text };
  const folded = offered.filter((f) => f.toLowerCase() === text.toLowerCase());
  if (folded.length === 1) return { folder: folded[0]! };
  if (suggestFolders(offered, text).length > 0) {
    return { reason: `"${text}" is not a whole folder path. Pick the folder from the list.` };
  }
  return {
    reason: `No folder that can be shared matches "${text}". Only synced folders outside every existing share are offered.`,
  };
};
