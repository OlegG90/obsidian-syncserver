/**
 * What a connect attempt needs before anything is registered with the server.
 *
 * Extracted from the settings tab for the reason `pairing-flow.ts` was: a `PluginSettingTab`
 * cannot be constructed outside Obsidian, so anything decided inside one is decided where no
 * test can watch. The three routes into a vault share a form and do not share what makes an
 * attempt complete, and "which fields matter here" is exactly the kind of rule that drifts
 * when it lives in a click handler.
 *
 * It answers with the **sentence a person reads**, or nothing. Not a boolean and not a field
 * name: the caller has no better idea than this module which of several conditions failed, and
 * a screen composing its own wording from a `false` is how two messages for one rule appear.
 */

/** The three ways into a vault (docs/07). Only one of them creates anything. */
export type Route = 'claim' | 'pair' | 'recover';

/** The form, as the settings tab holds it. `again` is only ever filled on the claim route. */
export interface ConnectDraft {
  serverUrl: string;
  login: string;
  passphrase: string;
  again: string;
  token: string;
}

/**
 * What is wrong with this attempt, in a sentence, or `undefined` when nothing is.
 *
 * **The claim route is the one that asks twice**, and the asymmetry is the point rather than
 * an inconsistency. On that route the passphrase is not checked against anything — it is what
 * the account's keys are *derived from*, so a typo does not fail, it succeeds at making an
 * account nobody can ever open. There is no reset: the server never sees the passphrase, which
 * is the whole design (AC-11), so nobody can help afterwards. The invitation is one-time and
 * by then spent.
 *
 * Pairing and recovery ask once, deliberately. There the passphrase is *proved* against
 * something that already exists — an envelope, a verifier — so a typo fails loudly and costs
 * one retry. Asking twice would be ceremony charged to the routes that do not need it.
 */
export const whatIsMissing = (draft: ConnectDraft, route: Route): string | undefined => {
  if (!draft.serverUrl) return 'the server address is needed to connect.';
  if (!draft.login) return 'a login is needed to connect.';
  if (!draft.passphrase) return 'the passphrase is needed to connect.';

  if (route !== 'claim') return undefined;

  if (!draft.again) return 'type the passphrase a second time — a new account cannot be recovered from a typo.';
  if (draft.again !== draft.passphrase) {
    // Named as a mismatch rather than as "wrong", because neither of the two is wrong yet and
    // the person is the only one who knows which they meant.
    return 'the two passphrases are different. Neither has been used; check both and try again.';
  }
  if (!draft.token) return 'an invitation token is needed to claim an account.';
  return undefined;
};
