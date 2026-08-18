/**
 * The scopes of an opened vault, for a test that only cares about `KV`.
 *
 * Most engine tests are about paths, deletes and conflicts, not about sharing: they hand the
 * engine one vault key and a vault whose only scope is its own. Building that by hand in
 * every file would put `VaultScopes.open` and its dependency shape into a dozen tests that
 * have no opinion about either.
 *
 * Tests that ARE about shares build their own, because the thing they are testing is which
 * scopes the vault reports and which of them opened.
 */
import type { OpenedVault } from '@syncserver/shared';
import { randomBytes } from '../src/crypto/bytes.js';
import { VaultScopes } from '../src/share-keys.js';

export const scopesOf = (opened: OpenedVault, vaultKey: Uint8Array): VaultScopes =>
  VaultScopes.open(opened, {
    vaultKey,
    // Never reached: opening an account-wrapped share key is the one thing this needs an
    // identity for, and a vault with no share scopes has none to open.
    openIdentity: () => randomBytes(32),
    userId: '00000000-0000-4000-8000-000000000000',
  });
