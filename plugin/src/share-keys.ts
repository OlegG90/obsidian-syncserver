/**
 * Turning what the server stores into keys this device can actually use.
 *
 * A share's interior is named under `KS`, and `KS` reaches a device only wrapped — the
 * server holds both forms and can open neither. Opening a vault reports them; this turns
 * them into the map the engine already asks for, so a shared folder syncs like any other.
 *
 * **Two wrappings, and the difference is not cosmetic.** The initiator's copy is sealed
 * under `KV`, because it needed no delivery: the key was made on that device and only has
 * to survive a restart. A participant's arrived as an HPKE envelope to the account's public
 * key, because it had to cross to somebody who will never hold this account's seed. They
 * are opened with different keys, which is why the server says which is which rather than
 * leaving a client to try both and read a failure as the answer.
 *
 * The scope shape comes from `shared/`, where the wire's vocabulary lives. This module had
 * its own copy with `wrapping` widened to `string`, which is the drift that package exists
 * to prevent: a widened field accepts a value the server can never send, and the `switch`
 * that reads it stops being exhaustive without anything saying so.
 */
import type { Scope } from '@syncserver/shared';
import { fromBase64 } from './crypto/bytes.js';
import { openFrom } from './crypto/hpke.js';
import { unwrapShareKey } from './crypto/share.js';
import { shareEnvelopeAad } from './sharing.js';

export interface ShareKeyDeps {
  /** `KV` for the vault being opened — what the initiator's own copy is wrapped under. */
  vaultKey: Uint8Array;
  /**
   * The account's X25519 private half, unwrapped on demand.
   *
   * A function rather than the seed, so the seed stays inside the session that holds it:
   * receiving a share needs this identity and nothing else of it.
   */
  openIdentity(): Uint8Array;
  /** This account, because the envelope is bound to its id (docs/06). */
  userId: string;
}

/**
 * The vault's own scope, which everything outside a share is named under.
 *
 * A vault always has one — it is `KV`'s label, minted with the vault itself — so its absence
 * is a broken answer from the server rather than a case a caller can handle. Throwing here is
 * what lets the question be one expression at each of its five call sites: it had been written
 * out three times, in two files, down to the same sentence in the same `throw`.
 */
export const vaultScopeIdOf = (scopes: readonly Scope[]): string => {
  const id = scopes.find((s) => s.scope === 'vault')?.key_id;
  if (!id) throw new Error('the vault reports no key scope of its own');
  return id;
};

/**
 * The share keys among these scopes, by scope id.
 *
 * **A scope that cannot be opened is dropped, not thrown.** One unreadable share must not
 * stop a vault from syncing: the rest of the tree is fine, and the engine already refuses
 * loudly at the one place it matters — the moment it meets a name under a scope it holds no
 * key for. Failing here instead would turn one bad envelope into a vault that never syncs
 * again, which is the worse of the two failures by a distance.
 *
 * @returns the openable ones, and the scope ids of any that were not.
 */
export const shareKeysFrom = (
  scopes: readonly Scope[],
  deps: ShareKeyDeps,
): { keys: Map<string, Uint8Array>; unopenable: string[] } => {
  const keys = new Map<string, Uint8Array>();
  const unopenable: string[] = [];
  let identity: Uint8Array | undefined;

  for (const s of scopes) {
    if (s.scope !== 'share' || !s.wrapped_key || !s.share_id) continue;
    try {
      if (s.wrapping === 'vault') {
        keys.set(s.key_id, unwrapShareKey(deps.vaultKey, s.wrapped_key));
        continue;
      }
      // Unwrapped once and reused: the identity is the same for every envelope, and
      // unwrapping it per share would repeat an AEAD open for nothing.
      identity ??= deps.openIdentity();
      const envelope = fromBase64(s.wrapped_key);
      keys.set(
        s.key_id,
        openFrom(
          identity,
          { enc: envelope.subarray(0, ENC_BYTES), ciphertext: envelope.subarray(ENC_BYTES) },
          new Uint8Array(0),
          shareEnvelopeAad(s.share_id, deps.userId),
        ),
      );
    } catch {
      unopenable.push(s.key_id);
    }
  }

  return { keys, unopenable };
};

/**
 * One share's key and the scope it is labelled with — the pair, because they are one lookup.
 *
 * Every caller that needs `KS` needs its scope id too: the key opens the names, and the id
 * is what says which names it opens. Asked separately they were two `find` expressions over
 * the same array, run one line apart, and the second could quietly answer about a different
 * scope than the first if the shape of a scope ever changed.
 *
 * **A missing key here throws**, unlike `shareKeysFrom`, and the difference is the question.
 * That one is asked about every scope a vault reports, where one bad envelope must not stop
 * the other shares from syncing. This one is asked about a share the person just pressed a
 * button on, and silence would leave the operation to fail further in, about something else.
 *
 * Fetched rather than remembered: the wrapped form is the server's to hold and this device's
 * to open, and caching it would mean deciding when a cache is stale about a key that can
 * stop existing the moment somebody else ends the share.
 */
export const shareKeyFor = (
  scopes: readonly Scope[],
  shareId: string,
  deps: ShareKeyDeps,
): { keyId: string; key: Uint8Array } => {
  const scope = scopes.find((s) => s.share_id === shareId);
  if (!scope?.wrapped_key) throw new Error('this device holds no key for that share');

  // Both wrappings, through the one function that knows how to open either. This used to
  // refuse an account envelope — written before the account identity existed and left behind
  // once it did — which meant a PARTICIPANT could never leave: theirs is the envelope form
  // by definition, since it had to cross to somebody who will never hold the initiator's seed.
  const { keys } = shareKeysFrom([scope], deps);
  const key = keys.get(scope.key_id);
  if (!key) throw new Error('this device cannot open the key for that share');
  return { keyId: scope.key_id, key };
};

/** An X25519 public key, which is what an HPKE envelope carries in front of its ciphertext. */
const ENC_BYTES = 32;
