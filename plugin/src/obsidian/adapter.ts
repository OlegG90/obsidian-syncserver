/**
 * `VaultAdapter` over the real Obsidian vault.
 *
 * Everything path-based, through `vault.adapter`, rather than through `TFile` objects: the
 * engine deals in paths because that is what a vault has, and resolving a path to a `TFile`
 * only to hand it back is a step that can fail for a file the engine is about to create.
 *
 * This is also the only place in the plugin that knows a note is text and an attachment is
 * not — and it declines to know it. Everything is read and written as binary, so a `.md` and
 * a `.png` travel the same path and no encoding decision is made twice.
 */
import type { Vault } from 'obsidian';
import type { VaultAdapter, VaultFile } from '../engine/vault.js';
import { arrayBufferOf } from './buffer.js';

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  async list(): Promise<VaultFile[]> {
    // `getFiles()` is Obsidian's own view of the vault: files it tracks, folders excluded,
    // and the configuration directory already absent.
    return this.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.vault.adapter.readBinary(path));
  }

  async write(path: string, bytes: Uint8Array, _mtime?: number): Promise<void> {
    // The parent folders first: writing into a folder that does not exist fails, and a pull
    // into an empty vault creates every folder it needs on the way down.
    //
    // **A file at the root has no parent, and saying so takes an explicit check.**
    // `lastIndexOf('/')` answers -1 there, and `slice(0, -1)` is not "nothing" — it is the
    // path minus its last character. That created a FOLDER called `Note.m` beside every
    // `Note.md` pulled into the root, which then synced up as a real folder and came back
    // down on every other device.
    const cut = path.lastIndexOf('/');
    const parent = cut === -1 ? '' : path.slice(0, cut);
    if (parent && !(await this.vault.adapter.exists(parent))) {
      await this.vault.adapter.mkdir(parent);
    }

    await this.vault.adapter.writeBinary(path, arrayBufferOf(bytes));
    // `mtime` is deliberately not forced. Obsidian stamps a written file with now, and the
    // engine compares content hashes rather than times, so nothing depends on winning here.
  }

  async delete(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
  }
}
