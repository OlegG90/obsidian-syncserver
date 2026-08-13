/**
 * What this device already knows about the vault it is syncing.
 *
 * The one place a **path** is resolved to a **node id** (docs/02). The server has no paths
 * at all — a node is `(vault_id, id)` with an encrypted name — so without this map the
 * client cannot say "the file I know as Notes/today.md" to anything.
 *
 * It also holds the plaintext hash of what was last synchronised, which is what makes
 * "changed since last time" answerable without re-encrypting the file: content sealed twice
 * lands at two different addresses (`KC` is random), so the ciphertext address can never be
 * compared against anything.
 */

export interface KnownNode {
  nodeId: string;
  /** The server's revision as of the last successful write or read. */
  rev: number;
  /** `sha256` of the PLAINTEXT — the only stable identity a client can compare against. */
  plainHash: string;
  /** The address of the ciphertext currently on the server, which `base_sha256` needs. */
  address: string;
}

export interface VaultState {
  /** The delta cursor, opaque and signed by the server. */
  cursor?: string;
  /** Keyed by vault-relative path. */
  nodes: Record<string, KnownNode>;
}

export interface StateStore {
  load(): Promise<VaultState>;
  save(state: VaultState): Promise<void>;
}

export const emptyState = (): VaultState => ({ nodes: {} });

/** For tests, and for a first run before anything has been persisted. */
export class MemoryStateStore implements StateStore {
  private state: VaultState = emptyState();

  async load(): Promise<VaultState> {
    return structuredClone(this.state);
  }

  async save(state: VaultState): Promise<void> {
    this.state = structuredClone(state);
  }
}
