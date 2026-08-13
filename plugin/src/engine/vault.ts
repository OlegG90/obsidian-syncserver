/**
 * What the engine is allowed to know about a vault.
 *
 * Obsidian's `Vault` is behind this on purpose. The engine has to be exercised without
 * launching Obsidian — the same reason the transport is injected — and a narrow interface is
 * also the honest statement of what synchronising actually needs: list, read, write, delete.
 *
 * Paths are vault-relative and use `/`, which is what Obsidian's API gives on every
 * platform. Nothing here understands folders as objects: a folder exists because a file is
 * under it, which is also how the server sees a tree it never names.
 */

export interface VaultFile {
  /** Vault-relative, `/`-separated, never leading-slashed. The root itself is never listed. */
  path: string;
  /** Epoch milliseconds, as the vault reports them. */
  mtime: number;
}

/**
 * Text and binary files are both `Uint8Array` here.
 *
 * Obsidian reads notes as strings and attachments as binary, and the **adapter** is the one
 * place that translation exists. Above it there is no such distinction: a note is bytes to
 * be sealed, and a sealed note is bytes, so a boundary that sometimes hands over a string
 * would only be a place to forget an encoding.
 */
export interface VaultAdapter {
  list(): Promise<VaultFile[]>;
  read(path: string): Promise<Uint8Array>;
  /**
   * Creates parent folders as needed, and overwrites.
   *
   * `mtime` is advisory. The editor usually decides what a written file's mtime is — Obsidian
   * sets it to now — and an engine that fights the editor over it would be arguing to lose.
   * It is passed along; the adapter does what it can with it.
   */
  write(path: string, bytes: Uint8Array, mtime?: number): Promise<void>;
  delete(path: string): Promise<void>;
}

/**
 * `.obsidian/` is skipped for now, and this is a decision rather than an oversight.
 *
 * It holds device-local state — window sizes, workspace layout, the plugin's own settings
 * including this vault's credentials — and synchronising it means one device's layout
 * overwriting another's every few seconds. docs/10 puts exclusions in M2; until then the
 * rule is the simplest one that cannot surprise anybody.
 */
export const isSyncable = (path: string): boolean => !path.startsWith('.obsidian/') && !path.startsWith('.trash/');
