/**
 * Making a shared folder look shared, in the place a person actually looks: the file tree.
 *
 * A two-account walk ended with both sides holding a folder that behaved differently from
 * its neighbours — writes reaching another person, a departure to perform — and nothing on
 * screen said so. The plugin's settings knew; the file explorer, which is where somebody
 * decides whether to drop a note into a folder, did not.
 *
 * **Done with CSS rather than by touching the explorer's elements.** Obsidian renders
 * `data-path` on every row of the tree, so a stylesheet can select them without reaching
 * into a view's internals — which means no private API, nothing to re-apply when the tree
 * re-renders or a folder is collapsed, and a decision that is a pure function of the paths.
 */

/**
 * Escape a path for use inside a CSS attribute selector's double-quoted string.
 *
 * Vault paths are user-chosen, so both characters happen: a backslash on a Windows-flavoured
 * name, a quote in a title. Unescaped, either ends the string early and the rule silently
 * matches something else — or everything.
 */
const cssString = (path: string): string => path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** What the badge says. Short, because it sits inside a tree row that already has a name. */
const LABEL = 'shared';

/**
 * The stylesheet marking each of these folders, and nothing else.
 *
 * Returns `''` for an empty list rather than an empty rule set, so the caller can treat "no
 * shares" and "no stylesheet" as the same thing.
 */
export const sharedFolderCss = (paths: readonly string[]): string => {
  const rows = [...new Set(paths)].filter((p) => p.length > 0);
  if (rows.length === 0) return '';

  const selector = rows.map((p) => `.nav-folder-title[data-path="${cssString(p)}"]`).join(',\n');
  return `${selector} {
  --syncserver-shared: 1;
}
${selector} .nav-folder-title-content::after {
  content: '${LABEL}';
  margin-inline-start: 0.5em;
  padding: 0 0.4em;
  border-radius: 0.4em;
  font-size: var(--font-ui-smaller);
  /* The accent, at low opacity: visible enough to notice while scanning, quiet enough that
     a vault where everything is shared does not become a wall of badges. */
  color: var(--text-on-accent);
  background: var(--interactive-accent);
  opacity: 0.65;
  vertical-align: middle;
}
`;
};
