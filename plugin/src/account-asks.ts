/**
 * What a screen may ask of the **account** — as opposed to the vault.
 *
 * Ten operations that touch the account itself: its vaults, its devices, its recovery code, its
 * passphrase. They were ten one-line methods on the plugin, each forwarding to the session, and the
 * forwarding was never the content. The content is a rule that differs per operation and lived only
 * in the prose above it.
 *
 * **The rule is which of two ways in an operation needs**, and the two wrappers below are it:
 *
 * - `seeded` — the operation needs the seed, so it goes through an unlock and **may ask for the
 *   passphrase**. Listing vaults reads names, changing a passphrase rewraps an envelope; neither can
 *   happen with the account locked.
 * - `handled` — a borrowed handle is enough. The device list and the recovery-code state are rows the
 *   server will hand to any authenticated caller, and asking for a passphrase to read one would be a
 *   question with no reason behind it.
 *
 * Choosing a wrapper is not optional: an operation cannot be written here without picking one, which
 * is the whole reason the route is expressed this way rather than as a table beside the definitions.
 * A table drifts the first time somebody adds an eleventh operation and forgets the second edit.
 *
 * **None of them takes the one-at-a-time gate, and that is one fact rather than ten.** Reading a list,
 * revoking a row, asking whether a recovery code exists — none touches what a sync touches (#131), and
 * a shared gate over them would refuse a screen filling itself in while a pass ran. The gate belongs to
 * the flows that move a vault's contents, and it is given to them there.
 *
 * **`BoundVault` is the other half of this distinction** and deliberately not this one: that value is
 * *one vault, opened once, for the length of one operation*, and everything here works without opening
 * any vault at all. An operation that needs a tree needs that, not this.
 *
 * The unlock, the borrow and the keeping arrive as functions rather than as a session, so this module
 * holds no state and no keys — and so a test can watch which way an operation went by counting calls,
 * which is the assertion the ten docblocks used to make in prose.
 */
import type { OwnDeviceRow } from '@syncserver/shared';
import type { Handle, Session } from './session/session.js';

/** The three things this module cannot do for itself, and nothing more. */
export interface AccountDeps {
  /**
   * The session, open — asking for the passphrase if it is not, once however many callers ask at
   * the same moment. That last part is why this is borrowed rather than rebuilt here: the promise
   * concurrent callers share lives as long as the plugin does.
   */
  seed: () => Promise<Session>;
  /** A borrowed handle, without unlocking. */
  handle: <T>(fn: (h: Handle) => Promise<T>) => Promise<T>;
  /**
   * Write down the envelope that a passphrase change has just replaced.
   *
   * Not simply "save": the session now holds a connection whose wrapped seed is a different one, and
   * the copy this device starts from has to become that. An unsaved one means the next start asks for
   * a passphrase that no longer opens anything — so the two are one act and belong behind one name.
   */
  keepEnvelope: () => Promise<void>;
}

/**
 * The asks themselves.
 *
 * Named as a type so a seam can seek the methods it uses rather than the whole of it —
 * `Pick<AccountAsks, 'devices' | 'revokeDevice'>` for a screen that lists devices — and so renaming
 * one fails at that seam rather than only at whoever passes a real value.
 */
export interface AccountAsks {
  /** Every vault on this account, with what each is using. */
  vaults(): Promise<{ id: string; name: string; nodes: number; bytes: number; shared: boolean; current: boolean }[]>;
  /** Remove one vault from the account; answers whether that lifted a freeze. */
  deleteVault(vaultId: string): Promise<{ thawed: boolean }>;
  /** The devices of this account. */
  devices(): Promise<OwnDeviceRow[]>;
  /** Take one device away. */
  revokeDevice(deviceId: string): Promise<void>;
  /** Whether a recovery code exists. A boolean is all there is to ask for. */
  hasRecoveryCode(): Promise<boolean>;
  /** Make one, and say whether it replaced an older one. */
  createRecoveryCode(): Promise<{ code: string; replaced: boolean }>;
  /** Approve another device's pairing from this one. */
  approvePairing(code: string): Promise<void>;
  /** Change the passphrase, and write the new envelope down. */
  changePassphrase(current: string, next: string): Promise<void>;
  /** Take on a passphrase changed on another device, and write the envelope down. */
  adoptPassphrase(passphrase: string): Promise<void>;
}

export const openAccountAsks = (deps: AccountDeps): AccountAsks => {
  /** Needs the seed: may ask for the passphrase. */
  const seeded = <T>(ask: (s: Session) => Promise<T>): Promise<T> => deps.seed().then(ask);

  /** Needs only a handle: never asks for anything. */
  const handled = <T>(ask: (h: Handle) => Promise<T>): Promise<T> => deps.handle(ask);

  return {
    vaults: () => seeded((s) => s.vaults()),
    deleteVault: (vaultId) => seeded((s) => s.deleteVault(vaultId)),

    // The envelope is unwrapped here rather than by the screen: `{ devices: [...] }` is the shape of a
    // response, and what a caller wants is the rows.
    devices: () => handled((h) => h.client.devices()).then((r) => r.devices),
    revokeDevice: (deviceId) => handled((h) => h.client.revokeDevice(deviceId)),
    hasRecoveryCode: () => handled((h) => h.client.recoveryCodeState()).then((r) => r.present),

    createRecoveryCode: () => seeded((s) => s.createRecoveryCode()),
    approvePairing: (code) => seeded((s) => s.approvePairing(code)),

    // The two that change what this device starts from. Keeping the envelope is not an afterthought
    // to them; it is the half that makes the change survive a restart.
    changePassphrase: async (current, next) => {
      await seeded((s) => s.changePassphrase(current, next));
      await deps.keepEnvelope();
    },
    adoptPassphrase: async (passphrase) => {
      await seeded((s) => s.adoptEnvelope(passphrase));
      await deps.keepEnvelope();
    },
  };
};
