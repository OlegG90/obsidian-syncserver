/**
 * Finding one deleted file among a page of them, and saying honestly how much is on screen
 * (#130).
 *
 * The trash listing is a **page** — the server sends the most recently deleted, not all of
 * them — so a filter here searches what arrived and nothing more. That is the whole reason
 * `showing` takes three numbers instead of two: a person who types a name and sees nothing
 * needs to know whether the file is absent or merely not on this page, and those are different
 * situations with different next steps.
 */
export interface Named {
  name: string;
}

/**
 * The rows whose name contains the query, case-insensitively.
 *
 * Contains rather than starts-with: a trashed file is looked for by the word somebody
 * remembers, which is rarely the first one — `notes/2026/august.md` is found by "august".
 * Trimmed, because a query pasted from anywhere carries a space that would match nothing and
 * look like a broken filter.
 */
export const matching = <T extends Named>(rows: readonly T[], query: string): T[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(needle));
};

/**
 * What the list is showing, out of what it has, out of what there is.
 *
 * Three numbers because there are three, and collapsing any two of them tells a lie somebody
 * acts on: `shown` is after the filter, `fetched` is what the page carried, `total` is what the
 * server holds. Silence when they are all the same — a listing showing everything needs no
 * sentence about it.
 */
export const showing = (shown: number, fetched: number, total: number): string | undefined => {
  if (shown === fetched && fetched === total) return undefined;
  if (shown === fetched) return `Showing the ${fetched} most recently deleted of ${total}.`;
  if (fetched === total) return `Showing ${shown} of ${total}.`;
  return `Showing ${shown} of the ${fetched} most recently deleted, out of ${total}.`;
};
