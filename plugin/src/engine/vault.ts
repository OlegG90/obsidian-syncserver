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
 * `.obsidian/` is behind a switch, off by default (#7, docs/01). Off, the whole directory
 * is skipped. On, everything is synced EXCEPT the per-device exceptions — files that
 * describe *this screen*, not the vault: the workspace layout, its mobile twin, the graph
 * view, and the plugin cache. Propagating those is not synchronisation, it is interference:
 * a laptop and a phone must not fight over which panes are open (docs/01).
 *
 * The exceptions apply even when the switch is on; they are not optional. Everything else
 * under `.obsidian/` — appearance, hotkeys, the enabled-plugin list, plugin data — is
 * configuration the user wants on every device.
 *
 * `_Reset ` is the quarantine folder a `410 reset` moves the losing device's work into
 * (docs/07): it lives inside the vault so nothing is erased, and it must not be synced or
 * the very files the reset displaced come back up on the next pass.
 */
const OBSIDIAN_DEVICE_LOCAL = ['workspace.json', 'workspace-mobile.json', 'graph.json', 'cache'];

export const isSyncable = (path: string, syncObsidian: boolean): boolean => {
  if (path.startsWith('.trash/') || path.startsWith('_Reset ')) return false;
  if (path.startsWith('.obsidian/')) {
    if (!syncObsidian) return false;
    const rel = path.slice('.obsidian/'.length);
    return !OBSIDIAN_DEVICE_LOCAL.some((name) => rel === name || rel.startsWith(`${name}/`));
  }
  return true;
};
