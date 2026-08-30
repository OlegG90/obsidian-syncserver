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
    return [...this.files.entries()].map(([path, f]) => ({ path, mtime: f.mtime, size: f.bytes.length }));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.bytes;
  }

  /**
   * **The advisory `mtime` is ignored, because the real adapter ignores it** (issue #237).
   *
   * It used to be stored, and that is a double being more capable than the thing it stands for. It hid
   * a real defect for a whole branch: the engine recorded `Date.now()` as the timestamp of a file it
   * had just written and used it as a skip hint, which works perfectly here and never once matches in
   * Obsidian, where the editor stamps the file itself. Tests were green on a path that could not work.
   *
   * So this stamps its own time, as Obsidian does. A test that needs a file at a chosen `mtime` seeds
   * it — `seed()` is the way to plant a file, and `write()` is the engine doing what the engine does.
   */
  async write(path: string, bytes: Uint8Array, _mtime?: number): Promise<void> {
    this.files.set(path, { bytes, mtime: Date.now() });
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}
