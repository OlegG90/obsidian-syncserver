/**
 * The two sentences the recovery-code row is made of, from the one fact it turns on.
 *
 * Extracted for the reason the walk on 2026-08-21 gave: the row was rendered once, from the
 * server's answer at page load, and the act on it changes that answer. After making a code the
 * line still said the account had none and the button still believed it was creating one —
 * so a second press would have taken the creating path, replacing the code just written down
 * with no confirmation at all.
 *
 * Neither branch was wrong. What was wrong was which one the screen thought it was in, and
 * that is not a thing a `PluginSettingTab` lets anybody test. Here it is one function of one
 * boolean, and the property worth asserting is that the label and the sentence **cannot
 * disagree** — a button reading "Create" beside a line reading "has a recovery code" is the
 * shape of the defect, not a cosmetic mismatch.
 */
export interface RecoveryRow {
  /** What is true of the account, said after its name. */
  desc: string;
  /** What the button does, which is a different act on each side. */
  button: string;
  /** Whether pressing it needs a confirmation first: replacing takes a way in away. */
  confirms: boolean;
}

export const recoveryRow = (present: boolean): RecoveryRow =>
  present
    ? {
        desc: 'has a recovery code. Making another replaces it, and the old one stops working.',
        button: 'Replace the recovery code',
        confirms: true,
      }
    : {
        desc: 'has no recovery code. A forgotten passphrase would be the end of it.',
        button: 'Create a recovery code',
        confirms: false,
      };
