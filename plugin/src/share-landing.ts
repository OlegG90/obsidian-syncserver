/**
 * What a shared folder is called when it lands, and what it must not collide with.
 *
 * Accepting an invitation puts a folder in this vault, and the person is asked to name it. Four rules
 * decide what happens around that question, and all four lived inside a closure in the composition
 * root — where nothing could ask them anything:
 *
 * - **only the top level can collide.** A replica lands at the vault root (docs/05), so `Notes/Shared`
 *   is not in the way of a folder called `Shared` and must not push the name to `Shared 2`;
 * - **the suggestion names the person who invited you**, because "Shared folder" tells somebody with
 *   three invitations nothing about which one they just took;
 * - **the suggestion is already free.** Offering a name that is taken means the person types a name,
 *   presses accept, and gets a different one — which reads as the plugin ignoring them;
 * - **so is whatever they type instead.** The same set governs both, which is why they come from one
 *   value here rather than two calls that could be given different sets.
 *
 * The asking itself stays in `obsidian/` — this decides what to offer and what to do with the answer.
 */
import { freeName } from './sharing.js';

export interface Landing {
  /** Offer this. It is free, and it says who invited them. */
  suggestion: string;
  /**
   * What the name they settle on becomes.
   *
   * A blank answer is refused rather than defaulted: somebody who cleared the box and pressed accept
   * has not chosen the suggestion, and landing a folder called `Shared by someone` on that would be
   * this plugin deciding something it was told nothing about.
   */
  settle(chosen: string): string;
}

/**
 * @param paths every path the walked tree holds — the whole vault, from which only the top level
 *   matters. Taking all of them rather than a pre-filtered set keeps the collision rule here, where
 *   it is written down, instead of at the call site where it was a `filter` nobody could see.
 * @param initiatorLogin who sent the invitation, when the server said.
 */
export const landingFor = (paths: Iterable<string>, initiatorLogin: string | undefined): Landing => {
  const siblings = new Set<string>();
  for (const p of paths) if (!p.includes('/')) siblings.add(p);

  return {
    suggestion: freeName(`Shared by ${initiatorLogin ?? 'someone'}`, siblings),
    settle: (chosen) => {
      const trimmed = chosen.trim();
      if (trimmed === '') throw new Error('a name is needed for the folder before it can land here');
      return freeName(trimmed, siblings);
    },
  };
};
