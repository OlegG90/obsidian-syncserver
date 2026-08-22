/**
 * What removing a vault actually does, said before it is done (#175).
 *
 * The rule this sentence carries: **a vault removal is a server-side deletion and nothing else.** Files
 * on any device stay exactly where they are — this is not a command that reaches out and empties
 * somebody's folder. What ends is the vault the server keeps, along with the history and the versions
 * it held.
 *
 * The old wording said "it holds nothing, so nothing is lost", which was true only because the button
 * was offered for empty vaults alone. Now that a vault with notes in it can go, the count has to be in
 * the sentence: "remove" and "remove 1,204 items" are different decisions and must not read the same.
 *
 * **Not the vault this window syncs.** That one is refused before the button exists, in `session.ts`,
 * where the connection lives.
 *
 * Here rather than inline in the settings tab so it can be read by a test — the wording IS the safeguard
 * on this action, and a safeguard nothing watches is one that quietly drifts.
 */
export const removalWarning = (nodes: number): string => {
  const held =
    nodes === 0
      ? 'It holds nothing on the server, so only the vault itself goes.'
      : `${nodes} item${nodes === 1 ? '' : 's'} on the server go with it, along with their history.`;
  return (
    `${held} Nothing on any device is deleted: this removes the server's copy, not anybody's files. ` +
    'A device still connected to this vault will find it gone and say so the next time it syncs.'
  );
};

/**
 * What a device says when the vault it is connected to is no longer on the server (#175).
 *
 * The other end of the rule above. Now that a vault can be removed while another device is still
 * connected to it, that device meets a `404` where it expected its tree — and the failure it produced
 * was a bare `404 not_found` from somewhere deep in an operation, which reads as a broken server rather
 * than as a vault somebody deliberately removed.
 *
 * **It says the files are still here**, because that is the first thing anybody would want to know and
 * the answer is reassuring: nothing local was touched, and reconnecting to another vault is a normal act
 * rather than a recovery.
 */
export const VAULT_GONE =
  'This vault is no longer on the server — it was removed there, or this account no longer holds it. ' +
  'Nothing on this device was touched: the files are still here. Disconnect and connect again to sync ' +
  'them to another vault.';
