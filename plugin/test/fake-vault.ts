/**
 * A vault in memory, standing in for Obsidian's.
 *
 * It exists so the engine can be run end to end without launching an application — the same
 * argument as the injected transport. What it deliberately does NOT do is model Obsidian's
 * quirks; it models the `VaultAdapter` contract, and anything the real adapter has to
 * special-case belongs in that adapter with a comment saying why.
 */
import { fromUtf8, utf8 } from '../src/crypto/bytes.js';
import type { VaultAdapter, VaultFile } from '../src/engine/vault.js';

export class FakeVault implements VaultAdapter {
  private files = new Map<string, { bytes: Uint8Array; mtime: number }>();

  /** Put a file there as if the user had written it. */
  seed(path: string, content: string, mtime = Date.now()): void {
    this.files.set(path, { bytes: utf8(content), mtime });
  }

  /** What is at that path now, as text. `undefined` if nothing is. */
  contents(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? fromUtf8(f.bytes) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async list(): Promise<VaultFile[]> {
    return [...this.files.entries()].map(([path, f]) => ({ path, mtime: f.mtime }));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.bytes;
  }

  async write(path: string, bytes: Uint8Array, mtime = Date.now()): Promise<void> {
    this.files.set(path, { bytes, mtime });
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}
