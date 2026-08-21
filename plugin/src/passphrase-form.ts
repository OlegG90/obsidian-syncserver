/**
 * What a passphrase change needs before anything is sent, and why the stake is the claim
 * route's rather than the console's (#138).
 *
 * The new passphrase is not checked against anything — it *becomes* what the account's
 * envelope is sealed under, here and on the server. So a typo does not fail: it succeeds, and
 * surfaces at the next unlock, when nothing opens this vault. From there the only way back is
 * the recovery code, and an account without one is gone.
 *
 * That is why `whatIsWrong` takes what it knows about the code as well. A warning that says
 * "there is no way back from a typo here" is worth printing exactly when it is true, and
 * misleading when it is not.
 */
export interface PassphraseDraft {
  current: string;
  next: string;
  again: string;
}

export const whatIsWrong = (draft: PassphraseDraft): string | undefined => {
  if (!draft.current) return 'the current passphrase is needed — an open vault is not proof of the person.';
  if (!draft.next) return 'choose the new passphrase.';
  if (!draft.again) {
    return 'type the new passphrase a second time — nothing checks it, so a typo becomes the passphrase.';
  }
  if (draft.again !== draft.next) {
    return 'the two new passphrases are different. Neither has been used; check both and try again.';
  }
  if (draft.next === draft.current) return 'that is the passphrase this vault already has.';
  return undefined;
};

/**
 * What to say above the form about the way back, which depends on something only the server
 * knows: whether this account has a recovery code.
 *
 * `undefined` while the answer has not arrived. A screen that guessed would either frighten
 * somebody who is covered or reassure somebody who is not, and the second is worse.
 */
export const wayBack = (hasCode: boolean | undefined): string | undefined => {
  if (hasCode === undefined) return undefined;
  return hasCode
    ? 'This account has a recovery code, so a mistake here is recoverable — with that code, not by the server.'
    : 'This account has NO recovery code. Nothing checks the new passphrase, and nothing can reset it: a typo would end this account. Make a code first.';
};
