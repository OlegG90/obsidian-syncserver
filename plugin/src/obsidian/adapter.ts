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

  /** Where Obsidian keeps configuration. `.obsidian` unless the user renamed it. */
  get configDir(): string {
    return this.vault.configDir;
  }

  async list(): Promise<VaultFile[]> {
    // `getFiles()` is Obsidian's own view of the vault: files it tracks, folders excluded,
    // and the configuration directory already absent.
    return this.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
  }

  /**
   * The configuration directory, which `list()` cannot see (#304).
   *
   * That absence is not an oversight above — it is Obsidian's file index, and the index does not carry
   * the configuration directory. So the `.obsidian/` switch had a scope rule, a settings toggle and a
   * pull that all worked, over a set of local files that was always empty: everything under it could
   * come down and nothing could ever go up.
   *
   * `vault.adapter` is the layer below the index and answers about any path, which is why the walk is
   * here. `list()` returns files and folders separately, so this recurses on the folders; there is no
   * depth to speak of — a configuration directory is plugin folders and a handful of JSON files.
   *
   * **`stat` is asked per file and may answer nothing.** A plugin rewriting its own `data.json` while
   * this walks is ordinary, and a file that vanished between being listed and being asked about is not
   * an error worth failing a whole pass over: it is simply not there this time.
   */
  async listConfig(): Promise<VaultFile[]> {
    const out: VaultFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      const found = await this.vault.adapter.list(dir);
      for (const path of found.files) {
        const s = await this.vault.adapter.stat(path);
        if (s) out.push({ path, mtime: s.mtime, size: s.size });
      }
      for (const folder of found.folders) await walk(folder);
    };
    if (await this.vault.adapter.exists(this.vault.configDir)) await walk(this.vault.configDir);
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.vault.adapter.readBinary(path));
  }

  async write(path: string, bytes: Uint8Array, _mtime?: number): Promise<void> {
    // **A file Obsidian already tracks is written THROUGH Obsidian**, and this is the difference
    // between a pull landing and a pull being undone.
    //
    // `vault.adapter.writeBinary` puts bytes on disk without telling the app. A note open in the
    // editor therefore keeps the buffer it had, nothing invalidates it, and Obsidian writes that
    // stale buffer back on its next save — silently reverting what was just pulled. The pass after
    // that finds a file whose hash no longer matches what it recorded, which is indistinguishable
    // from a person having typed, and the pull comes back as a conflict file holding the OLD text
    // (#295). `modifyBinary` takes the same bytes and leaves the app knowing.
    //
    // **A duck check rather than `instanceof TFile`**, because this module imports nothing from
    // `obsidian` at runtime — that is what lets every test here drive it with a stub, and it is how
    // the folder-named-`Note.m` bug below was finally caught. `getFileByPath` would say it more
    // plainly and is `@since 1.5.7`, above this plugin's floor of 1.5.0.
    const tracked = this.vault.getAbstractFileByPath(path);
    if (tracked && 'stat' in tracked) {
      await this.vault.modifyBinary(tracked as Parameters<Vault['modifyBinary']>[0], arrayBufferOf(bytes));
      return;
    }

    // Not tracked: the file does not exist yet, and creating it is what the rest of this does.
    //
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

  async stat(path: string): Promise<{ mtime: number; size: number } | undefined> {
    const s = await this.vault.adapter.stat(path);
    // `null` for a path that is not there, and a folder is not a file this engine syncs.
    return s && s.type === 'file' ? { mtime: s.mtime, size: s.size } : undefined;
  }

  async delete(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
  }
}
