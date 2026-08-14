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
 */
import { fromBase64 } from './crypto/bytes.js';
import { openFrom } from './crypto/hpke.js';
import { unwrapShareKey } from './crypto/share.js';
import { shareEnvelopeAad } from './sharing.js';

/** One scope as `GET /vaults/{id}` reports it. */
export interface ReportedScope {
  scope: string;
  key_id: string;
  share_id?: string;
  wrapped_key?: string;
  wrapping?: string;
}

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
  scopes: readonly ReportedScope[],
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

/** An X25519 public key, which is what an HPKE envelope carries in front of its ciphertext. */
const ENC_BYTES = 32;
