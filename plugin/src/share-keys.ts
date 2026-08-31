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
import type { OpenedVault, Scope } from '@syncserver/shared';
import { fromBase64 } from './crypto/bytes.js';
import { openFrom } from './crypto/hpke.js';
import { decryptName } from './crypto/scope.js';
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
 * stop a vault from syncing: the rest of the tree is fine. Failing here instead would turn
 * one bad envelope into a vault that never syncs again, which is the worse of the two
 * failures by a distance.
 *
 * That promise was not kept for a while, and it is worth saying where it broke rather than
 * only that it is fixed. This dropped the scope, and the engine then met a name under it in
 * the listing and threw — from the one read with no `try` around it, before a report existed.
 * So dropping the scope bought nothing: the pass died anyway, further along. The tree read
 * now asks `VaultScopes.keyIfOpenable` and skips what it cannot read, which is what makes the
 * sentence above true.
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

/**
 * What stands in for a name this device cannot read.
 *
 * A sentence, not the node id. The id looks exactly like something a file could be called, so
 * a person had no way to tell "this file is named that" from "this device has no key for it"
 * — and the second is the only one of the two they can do anything about. Reading as prose is
 * also what keeps it from being mistaken for a value: see `readName` on why writing it back
 * would be the real damage.
 */
export const UNREADABLE_NAME = '(name unavailable)';

/**
 * The scopes of one opened vault: which key opens which name, and which names it cannot.
 *
 * **One value per operation, and it can only come from opening a vault.** The pieces existed
 * already — the vault key, the vault's own scope id, the share keys this device could unwrap,
 * the ids of the ones it could not — and every operation assembled them by hand from three
 * separate calls. The comment on the engine's constructor records where that leads: "nine
 * arguments assembled twice is nine chances for the two to differ, and they already did".
 * Handing out one value makes the ordering a type rather than a paragraph: the scopes cannot
 * be held without having opened the vault they describe.
 *
 * **The failure policy is the interface, not a flag.** `keyFor` throws and `keyIfOpenable`
 * answers with a value, and the difference is in the return type, so a caller that must be
 * strict cannot silently become lenient. This is the same shape `shareKeysFrom` and
 * `shareKeyFor` already chose one level down, for the same reason: which failure you want is
 * a property of the question being asked, and a string argument saying so is a thing that
 * gets read wrong. Three call sites wrote this rule out by hand and the three disagreed.
 *
 * Not cached across operations: a share can be ended by somebody else between two syncs, and
 * a key kept from before would be offered for a scope nothing is named under any more.
 *
 * **How a seam asks for it** (D-86). A function that needs the scopes takes exactly the
 * methods it uses — `Pick<VaultScopes, 'keyFor'>`, `Pick<VaultScopes, 'readName'>` — rather
 * than the whole class. Narrow, so a caller supplies nothing it does not use and a test can
 * satisfy it without opening a vault; anchored to this type, so the seam names the domain term
 * and renaming a method here fails **at the seam** rather than only at whoever passes a real
 * value. Three call sites in one milestone each chose a different shape, which is one shape
 * too many for a term `CONTEXT.md` defines.
 *
 * A hand-written `{ keyFor }` is not unsafe — rename the method and the caller passing a real
 * `VaultScopes` still stops compiling. It is worse in two smaller ways: the error lands on the
 * caller and names the wrong file, and a seam whose every caller is a fake stops being checked
 * at all.
 *
 * The exception is a module this one imports, which therefore cannot import back —
 * `sharing.ts` is the only case, and it says so where it hand-writes the shape.
 *
 * **Only the caller that OPENS a vault holds the whole value.** That is where the guarantee
 * CONTEXT.md describes lives: scopes can be born no other way. Below that point the provenance
 * is already established, and a mapping function asking for a class it will call one method on
 * is asking for a guarantee somebody else has already made.
 */
export class VaultScopes {
  private constructor(
    /** The vault as it stood when this operation began — the same instant these keys describe. */
    readonly opened: OpenedVault,
    /** `KV = HKDF(seed, vault_id)` — what everything outside a share is named under. */
    readonly vaultKey: Uint8Array,
    readonly vaultScopeId: string,
    private readonly shareKeys: ReadonlyMap<string, Uint8Array>,
    /**
     * Scopes this device holds no key for.
     *
     * Reported rather than thrown, because a share whose envelope has not arrived is a state
     * and not a fault: the rest of the vault is fine, and the key may yet be delivered.
     */
    readonly unopenable: readonly string[],
  ) {}

  /**
   * Which keys this device can read this vault's **names** with, as one comparable string.
   *
   * The server holds no paths: a path exists only once every name above it has been opened, so the tree
   * a walk produces is a function of the nodes **and** of this — a subtree whose scope will not open is
   * absent from it and listed as unreadable instead (`tree.ts`).
   *
   * That is why it exists (issue #252). Anything caching a walked tree has to notice when this changes,
   * and a cursor cannot tell it: share membership travels as delta *events*, outside the journal, so a
   * key arriving or a share ending can move this while the node listing has not changed at all. Keyed
   * on the cursor alone, a cache would go on hiding a share whose key had just arrived.
   *
   * Both halves are in it, not only what opened: a scope that appears as unopenable is a difference the
   * tree can see, and one that disappears is too.
   */
  fingerprint(): string {
    const openable = [...this.shareKeys.keys()].sort();
    return `${this.vaultScopeId}|${openable.join(',')}|${[...this.unopenable].sort().join(',')}`;
  }

  static open(opened: OpenedVault, deps: ShareKeyDeps): VaultScopes {
    const { keys, unopenable } = shareKeysFrom(opened.scopes, deps);
    return new VaultScopes(opened, deps.vaultKey, vaultScopeIdOf(opened.scopes), keys, unopenable);
  }

  /**
   * The key for a name, or `undefined` when this device holds none.
   *
   * For the caller who has something to do about it: show the row anyway, skip the subtree,
   * carry on with the rest of the vault.
   */
  keyIfOpenable(nameKeyId: string | null | undefined): Uint8Array | undefined {
    // No scope named is the vault's own — the root's default, which every node inherits
    // until a share overrides it.
    if (!nameKeyId || nameKeyId === this.vaultScopeId) return this.vaultKey;
    return this.shareKeys.get(nameKeyId);
  }

  /**
   * The key for a name this caller must be able to read.
   *
   * For the caller with nothing to do about it — one that would otherwise carry on and write
   * a wrong name somewhere. Silently falling back to the vault key would decrypt nothing
   * while looking like success, which is the failure this throw exists to prevent.
   */
  keyFor(nameKeyId: string | null | undefined): Uint8Array {
    const key = this.keyIfOpenable(nameKeyId);
    if (!key) throw new Error(`a node is named under a scope this client cannot open: ${nameKeyId}`);
    return key;
  }

  /**
   * A name to show a person: the real one, or `UNREADABLE_NAME` when this device holds no key.
   *
   * **Never for a name that is going to be written back.** The stand-in is a sentence, and
   * `encryptName` would take it as happily as a filename — so a conversion built on this
   * would rename somebody's file to "(name unavailable)". That is a wrong name rather than a
   * missing one, and nothing downstream could tell. Callers that must write use `keyFor`,
   * which refuses instead.
   *
   * The `try` is not defensive noise: `decryptName` is an AEAD open, so the wrong key throws
   * rather than returning nonsense, and a row is worth showing either way.
   */
  readName(nameKeyId: string | null | undefined, nameEnc: string | null): string {
    if (!nameEnc) return UNREADABLE_NAME;
    const key = this.keyIfOpenable(nameKeyId);
    if (!key) return UNREADABLE_NAME;
    try {
      return decryptName(key, nameEnc);
    } catch {
      return UNREADABLE_NAME;
    }
  }

  /**
   * Share id → the scope its interior is named under.
   *
   * A share root's OWN label is under `KV` (SH-01), so the scope its children belong to
   * cannot be read off it; the server reports the pairing when the vault is opened, which is
   * the only place it exists as one fact.
   */
  shareScopes(): Map<string, string> {
    return new Map(this.opened.scopes.filter((s) => s.share_id).map((s) => [s.share_id!, s.key_id] as const));
  }
}
