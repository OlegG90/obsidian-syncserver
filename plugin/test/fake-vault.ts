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

  /**
   * `foldCase`: behave like Windows, where `Plan.md` and `plan.md` are one file (#421). A path that
   * differs from an existing one only in case reads, writes and deletes THAT file, keeping its name —
   * which is exactly what made write-then-delete lose it.
   */
  constructor(private readonly options: { foldCase?: boolean } = {}) {}

  /** The key a path lands on: itself, or — folding case — the existing file it names. */
  private at(path: string): string {
    if (!this.options.foldCase) return path;
    const lower = path.toLowerCase();
    for (const key of this.files.keys()) if (key.toLowerCase() === lower) return key;
    return path;
  }

  /** Put a file there as if the user had written it. */
  seed(path: string, content: string, mtime = Date.now()): void {
    this.files.set(path, { bytes: utf8(content), mtime });
  }

  /** What is at that path now, as text. `undefined` if nothing is. */
  contents(path: string): string | undefined {
    const f = this.files.get(this.at(path));
    return f ? fromUtf8(f.bytes) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /**
   * **The split mirrors Obsidian's, and that is the one quirk this double does model** (#304).
   *
   * Obsidian's file index does not carry the configuration directory, so `list()` cannot see it and a
   * separate walk has to. A fake that answered everything from one map was more capable than the thing
   * it stands for, and it hid #304 completely: the switch had a scope rule, a toggle and a pull that
   * all passed here, over a set of local files that in Obsidian was always empty.
   *
   * The same argument as `write()` ignoring its advisory `mtime` below. A double that is easier to
   * satisfy than reality is a suite that is green on a path that cannot work.
   */
  readonly configDir = '.obsidian';

  private entries(under: (path: string) => boolean): VaultFile[] {
    return [...this.files.entries()]
      .filter(([path]) => under(path))
      .map(([path, f]) => ({ path, mtime: f.mtime, size: f.bytes.length }));
  }

  private inConfig = (path: string): boolean => path === this.configDir || path.startsWith(`${this.configDir}/`);

  async list(): Promise<VaultFile[]> {
    return this.entries((path) => !this.inConfig(path));
  }

  async listConfig(): Promise<VaultFile[]> {
    return this.entries(this.inConfig);
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(this.at(path));
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
    this.files.set(this.at(path), { bytes, mtime: Date.now() });
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | undefined> {
    const f = this.files.get(this.at(path));
    return f ? { mtime: f.mtime, size: f.bytes.length } : undefined;
  }

  async delete(path: string): Promise<void> {
    this.files.delete(this.at(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const key = this.at(from);
    const f = this.files.get(key);
    if (!f) throw new Error(`no such file: ${from}`);
    this.files.delete(key);
    this.files.set(to, f);
  }

  /** Folders made on their own, with nothing in them — Obsidian keeps those (#413). */
  private readonly emptyFolders = new Set<string>();

  /** Make an empty folder, as a person does before putting anything in it. */
  mkdir(path: string): void {
    this.emptyFolders.add(path);
  }

  /** Remove a folder and everything in it, as deleting it in the file tree does. */
  rmdir(path: string): void {
    this.emptyFolders.delete(path);
    for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) this.files.delete(p);
  }

  async folderExists(path: string): Promise<boolean> {
    return this.emptyFolders.has(path) || [...this.files.keys()].some((p) => p.startsWith(`${path}/`));
  }
}
