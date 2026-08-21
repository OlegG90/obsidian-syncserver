/**
 * What a password change needs before it is attempted, and why it asks twice.
 *
 * **A mistyped new password locks this console permanently.** There is no reset: the server
 * hashes what it is given, `/auth/bootstrap` refuses once a password exists, and nobody —
 * administrator or not — can put one back. That is the same shape as the vault passphrase
 * (#126) with a different cause: not that nothing can check it, but that nothing can replace
 * it afterwards.
 *
 * So the second field is not ceremony here either, and the message says which of the two
 * risks it is guarding against rather than borrowing the passphrase's sentence.
 *
 * Separate from `main.ts` because that file cannot be tested: it reaches for `document` at
 * import. This is the rule, and the rule is the part worth watching.
 */
export interface PasswordDraft {
  current: string;
  next: string;
  again: string;
}

/** The floor the server enforces, restated here so the refusal arrives before the request. */
export const MIN_LENGTH = 12;

export const whatIsWrong = (draft: PasswordDraft): string | undefined => {
  if (!draft.current) return 'the current password is needed — a signed-in browser is not proof of the person.';
  if (!draft.next) return 'choose the new password.';
  if (draft.next.length < MIN_LENGTH) {
    return `the new password is too short: at least ${MIN_LENGTH} characters, because nothing slows a guess down before it reaches the server.`;
  }
  if (!draft.again) return 'type the new password a second time — a typo would lock this console for good.';
  if (draft.again !== draft.next) {
    // Neither is called wrong, for the reason the plugin's form gives: the person is the only
    // one who knows which they meant, and neither has been used yet.
    return 'the two new passwords are different. Neither has been set; check both and try again.';
  }
  if (draft.next === draft.current) return 'that is the password this account already has.';
  return undefined;
};
