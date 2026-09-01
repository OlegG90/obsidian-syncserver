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
  /** Size in bytes, as the vault reports it — a hint along with `mtime` to skip re-hashing (#237). */
  size: number;
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

  /**
   * What the vault says about one path right now — `undefined` if there is nothing there.
   *
   * **Asked after this device writes a file** (issue #237). The incremental pass skips reading a file
   * whose `mtime` and `size` still match what it recorded, and the engine does not get to decide what a
   * written file's timestamp is: the editor stamps it (`write` above says so). So after writing, the
   * engine asks rather than assuming — a number it invented would be one `list()` never reports back,
   * and the file would be re-read on every pass while the state claimed it had been checked.
   */
  stat(path: string): Promise<{ mtime: number; size: number } | undefined>;
  delete(path: string): Promise<void>;
}

/**
 * This plugin's own folder under `.obsidian/plugins/`, which is never synchronised (#303).
 *
 * The id is checked against `plugin/manifest.json` by `checks/check-self-exclusion.mjs`, because a
 * rename there and a stale string here would silently put `data.json` back in scope — and nothing
 * about the resulting sync would look wrong until two devices had been running for a while.
 */
export const SELF = 'plugins/syncserver';

/**
 * `.obsidian/` is behind a switch, off by default (D-7, docs/01). Off, the whole directory
 * is skipped. On, everything is synced EXCEPT the per-device exceptions — files that
 * describe *this screen*, not the vault: the workspace layout, its mobile twin, the graph
 * view, the plugin cache, and this plugin's own folder.
 *
 * Propagating the first four is not synchronisation, it is interference: a laptop and a phone
 * must not fight over which panes are open (docs/01).
 *
 * **`SELF` is there for a stronger reason than interference** (#303). `data.json` is where this
 * plugin keeps `connection.deviceId`, `connection.wrappedSeed`, `state.cursor` and `state.nodes` —
 * the device's identity and its private account of what it has synced. Handing that to another
 * device is not a preference travelling, it is one device being told it is another; and since the
 * plugin loads `this.data` once and writes memory back at the end of every pass, a pulled copy is
 * overwritten in the same pass it arrived. What survives is the recorded hash, which no longer
 * matches the file — indistinguishable from a person having edited it. Two devices then push one
 * node back and forth for ever, and any pass where both pushed between their pulls leaves a
 * conflict file inside a directory the file explorer does not show.
 *
 * The folder rather than the one file: `main.js` and `manifest.json` are the running plugin, and a
 * pass that overwrites its own code mid-walk is the same self-reference wearing different clothes.
 * Nothing is lost by excluding them — a device cannot sync at all until the plugin is installed on
 * it, so this folder is never how it arrives.
 *
 * The exceptions apply even when the switch is on; they are not optional. Everything else
 * under `.obsidian/` — appearance, hotkeys, the enabled-plugin list, other plugins' data — is
 * configuration the user wants on every device.
 *
 * `_Reset ` is the quarantine folder a `410 reset` moves the losing device's work into
 * (docs/07): it lives inside the vault so nothing is erased, and it must not be synced or
 * the very files the reset displaced come back up on the next pass.
 */
const OBSIDIAN_DEVICE_LOCAL = ['workspace.json', 'workspace-mobile.json', 'graph.json', 'cache', SELF];

export const isSyncable = (path: string, syncObsidian: boolean): boolean => {
  if (path.startsWith('.trash/') || path.startsWith('_Reset ')) return false;
  if (path.startsWith('.obsidian/')) {
    if (!syncObsidian) return false;
    const rel = path.slice('.obsidian/'.length);
    return !OBSIDIAN_DEVICE_LOCAL.some((name) => rel === name || rel.startsWith(`${name}/`));
  }
  return true;
};
