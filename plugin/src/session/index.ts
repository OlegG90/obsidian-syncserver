/**
 * The real session factory, bound to the real derivation.
 *
 * This is the only place production code gets a session. The binding lives here — not in a
 * parameter, not in a default — so the real path has no knob to turn: you call `connect()`
 * or `create()`, and the derivation is the real one. A test that wants a fake calls
 * `Session.forTests(deps)` below, which is a *different function*, visible in review, and
 * impossible to reach by accident.
 *
 * Transport is the one thing the real factory cannot supply: it is Obsidian's networking,
 * and importing it here would make the module untestable outside the app. So `create()` and
 * `connect()` take the transport from the caller — which is the plugin, the one place that
 * already knows it.
 */

import { createAccount, openAccount, type Account } from '../crypto/account.js';
import type { KdfParams } from '@syncserver/shared';
import type { Transport } from '../api/transport.js';
import {
  Session,
  type ConnectArgs,
  type Connection,
  type Derivation,
  type PairArgs,
  type RecoverArgs,
  type RecoverWithCodeArgs,
} from './session.js';

export type {
  AskVault, Connection, ConnectArgs, Derivation, Handle, PairArgs, RecoverArgs, RecoverWithCodeArgs, VaultChoice,
} from './session.js';
export { Session };

const realDerivation: Derivation = {
  create: (passphrase: string, params?: KdfParams): Account => createAccount(passphrase, params),
  open: (passphrase: string, accountSalt: Uint8Array, kdfParams: KdfParams, wrappedSeed: string) =>
    openAccount(passphrase, accountSalt, kdfParams, wrappedSeed),
};

/** Production: real derivation, transport from the caller. */
export const session = {
  connect: (args: ConnectArgs, transport: Transport) =>
    Session.connect(args, { derivation: realDerivation, transport }),
  create: (conn: Connection, transport: Transport) => Session.create(conn, { derivation: realDerivation, transport }),
  /** A second device joining an account that already exists (docs/07). */
  pair: (args: PairArgs, transport: Transport, poll?: () => Promise<boolean>) =>
    Session.pair(args, { derivation: realDerivation, transport }, poll),
  /** The last device gone: take the account back with the passphrase alone (docs/07). */
  recover: (args: RecoverArgs, transport: Transport) =>
    Session.recover(args, { derivation: realDerivation, transport }),
  /** The passphrase gone: take it back with the recovery code, and set a new one (#34). */
  recoverWithCode: (args: RecoverWithCodeArgs, transport: Transport) =>
    Session.recoverWithCode(args, { derivation: realDerivation, transport }),
};

/** Tests: a factory the caller binds to fakes. The real path above has no such parameter. */
export const forTests = (deps: { derivation: Derivation; transport: Transport }) => ({
  connect: (args: ConnectArgs) => Session.connect(args, deps),
  create: (conn: Connection) => Session.create(conn, deps),
  pair: (args: PairArgs, poll?: () => Promise<boolean>) => Session.pair(args, deps, poll),
  recover: (args: RecoverArgs) => Session.recover(args, deps),
  recoverWithCode: (args: RecoverWithCodeArgs) => Session.recoverWithCode(args, deps),
});
