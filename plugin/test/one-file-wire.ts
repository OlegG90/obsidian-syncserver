/**
 * A server holding a handful of files, for the engine tests that only need one.
 *
 * Six test files had written this class out, each with its own copy of the same fifteen fields a
 * `Change` needs, and a seventh was about to. It is not the thing any of them is testing: they are
 * about scope, deletes, known nodes, and now pacing — and what they all need is a server that answers
 * honestly about a small fixed set of files.
 *
 * `VaultConstants` is what varies between them, so it is a parameter rather than four module-level
 * bindings this file could not see. The tests that are about SHARING still build their own wire: what
 * they exercise is which scopes a vault reports, which is exactly what this hard-codes away.
 */
import type { Change, Delta, OpenedVault } from '@syncserver/shared';
import type { CursorRejected, CursorUnverifiable, Envelope } from '../src/api/client.js';
import type { VaultWire } from '../src/engine/wire.js';
import type { StateStore, VaultState } from '../src/engine/state.js';
import { sealBlob } from '../src/crypto/blob.js';
import { utf8 } from '../src/crypto/bytes.js';
import { envelopesFor, rootRow, row } from './wire-shapes.js';

/** The four values an engine test picks for itself, and the wire needs to answer consistently. */
export interface VaultConstants {
  vaultId: string;
  rootNodeId: string;
  scopeId: string;
  /** `KV`, the vault's own key — every name and every content key here is under it. */
  kv: Uint8Array;
}

/** One file the server already holds. */
export interface ServerFile {
  path: string;
  text: string;
  nodeId: string;
  rev: number;
}

/** The state store, in memory, cloning both ways so a test cannot hold the engine's own object. */
export class Store implements StateStore {
  constructor(public state: VaultState) {}
  async load(): Promise<VaultState> {
    return structuredClone(this.state);
  }
  async save(state: VaultState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** An opened vault whose only scope is its own. */
export const openedWith = (v: VaultConstants): OpenedVault => ({
  root_node_id: v.rootNodeId,
  head_rev: 1,
  scopes: [{ scope: 'vault', key_id: v.scopeId }],
});

export class OneFileWire implements VaultWire {
  created = 0;
  deleted: string[] = [];
  private readonly sealed = new Map<string, { sha256: string; bytes: Uint8Array; contentKey: Uint8Array }>();
  constructor(
    private readonly vault: VaultConstants,
    private readonly server: ServerFile[],
    private readonly deltaAnswer: Delta | CursorRejected | CursorUnverifiable,
  ) {
    for (const f of server) this.sealed.set(f.path, sealBlob(utf8(f.text)));
  }

  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    const nodes: Change[] = [rootRow(this.vault.rootNodeId)];
    for (const f of this.server) {
      const s = this.sealed.get(f.path)!;
      nodes.push(
        row({
          nodeId: f.nodeId, parentId: this.vault.rootNodeId, name: f.path,
          key: this.vault.kv, scopeId: this.vault.scopeId, rev: f.rev,
          content: { sha256: s.sha256, size: s.bytes.length },
        }),
      );
    }
    return { nodes, snapshot: 'cursor-new' };
  }

  async delta(): Promise<Delta | CursorRejected | CursorUnverifiable> {
    return this.deltaAnswer;
  }

  async dedupLookup(): Promise<Map<string, string>> {
    return new Map();
  }

  async putBlob(sealed: { sha256: string; bytes: Uint8Array; keyId: string }): Promise<{ sha256: string; size: number }> {
    return { sha256: sealed.sha256, size: sealed.bytes.length };
  }

  async getBlob(address: string): Promise<Uint8Array | undefined> {
    for (const s of this.sealed.values()) {
      if (s.sha256 === address) return s.bytes;
    }
    return undefined;
  }

  async blobKeys(_v: string, addresses: string[]): Promise<Map<string, Envelope[]>> {
    const offers = [...this.sealed.values()].map((s) => ({
      sha256: s.sha256, contentKey: s.contentKey, scopeId: this.vault.scopeId, key: this.vault.kv,
    }));
    return envelopesFor(offers, addresses);
  }

  async createNode(): Promise<{ node_id: string; rev: number }> {
    this.created++;
    return { node_id: `new-${this.created}`, rev: 10 + this.created };
  }

  async putContent(): Promise<{ rev: number }> {
    return { rev: 20 };
  }

  async moveNode(): Promise<{ rev: number }> {
    return { rev: 30 };
  }

  async deleteNode(_v: string, nodeId: string): Promise<{ rev: number }> {
    this.deleted.push(nodeId);
    return { rev: 40 };
  }
}
