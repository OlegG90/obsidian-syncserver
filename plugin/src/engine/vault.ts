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
  /**
   * Where configuration lives, vault-relative and with no trailing slash — `.obsidian` unless the
   * user changed it, which Obsidian allows and reports as `vault.configDir`.
   *
   * The scope rule needs it because the per-device exceptions are named relative to it, and a rule
   * that assumed the default would let a renamed directory's `workspace.json` through as an ordinary
   * file. It is a property rather than a constructor argument to the engine: the adapter is what
   * knows where the vault keeps things, and one fact travelling from where it is known beats the same
   * fact assembled by every caller.
   */
  readonly configDir: string;

  /**
   * Everything Obsidian tracks — which is the vault minus its configuration directory.
   *
   * That exclusion is Obsidian's, not a choice made here: `getFiles()` reads the file index, and the
   * configuration directory is not in it.
   */
  list(): Promise<VaultFile[]>;

  /**
   * The configuration directory, walked separately (#304).
   *
   * Asked only when the `.obsidian/` switch is on, because it is a directory walk the index cannot
   * answer, and a vault with the switch off has no use for the paths. What comes back is filtered by
   * the same `isSyncable` as everything else — the split is in how files are *found*, never in what
   * is in scope.
   */
  listConfig(): Promise<VaultFile[]>;
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
 * What under the configuration directory belongs to the **vault**, and therefore travels (#314).
 *
 * An allow list, and the inversion is the decision. The rule used to synchronise everything under
 * `.obsidian/` except a handful of named exceptions, on the assumption that configuration is mostly
 * shared and per-device state is the special case. A live vault said the opposite a day after the
 * switch first worked: `community-plugins.json` held eleven plugins on a desktop and one on a phone,
 * `core-plugins.json` disagreed about `switcher` and `backlink`, and `app.json` carried a mobile
 * toolbar on the machine that has no touchscreen. Those are not two edits meeting. They are two
 * different machines, and a deny list has to grow by one entry every time somebody finds another.
 *
 * So this names the minority instead: how the vault LOOKS and what it is made of.
 *
 * - `snippets/` and `themes/` — CSS the person chose or wrote, about this vault's appearance;
 * - `appearance.json` — which of those themes and snippets are on;
 * - `templates.json`, `daily-notes.json`, `types.json`, `bookmarks.json` — what the vault's own
 *   content is shaped by;
 * - `hotkeys.json` — a person's own bindings, which follow them rather than a machine.
 *
 * **Everything else stays on the device**, and `plugins/` is the entry worth saying out loud:
 * plugins are installed deliberately, per device. A phone and a laptop do not run the same set,
 * and telling one that it runs the other's is how you get a conflict file every single pass.
 *
 * That also settles #303 without a rule of its own. This plugin's `data.json` — `deviceId`,
 * `wrappedSeed`, `cursor`, `nodes` — is out of scope because all of `plugins/` is, and
 * `checks/check-config-scope.mjs` refuses any future entry under `plugins/` so the answer cannot be
 * undone by an edit that looks reasonable in isolation.
 *
 * `_Reset ` is the quarantine folder a `410 reset` moves the losing device's work into
 * (docs/07): it lives inside the vault so nothing is erased, and it must not be synced or
 * the very files the reset displaced come back up on the next pass.
 */
export const OBSIDIAN_SHARED = [
  'snippets',
  'themes',
  'appearance.json',
  'templates.json',
  'daily-notes.json',
  'types.json',
  'bookmarks.json',
  'hotkeys.json',
];

/**
 * Directories that are never synchronised, at any depth, whichever side of the switch they are on
 * (docs/01, the **Never** column — #312).
 *
 * `docs/01` has named these since the beginning and `isSyncable` never implemented them. That cost
 * nothing for as long as it could not: `getFiles()` returns Obsidian's index, and neither a hidden
 * `.git` nor anything under `.obsidian/` was ever in it. The configuration walk added in #304 reads
 * `vault.adapter` instead, which sees every path — so a plugin that vendors its dependencies handed
 * the engine 29 MB of Windows debug symbols and native binaries, encrypted them, and sent them to a
 * phone that can do nothing with any of it.
 *
 * **Matched as a path SEGMENT**, so a note folder called `my node_modules notes` is somebody's writing
 * and syncs like anything else. A prefix test would take it, and a `includes()` would take more.
 *
 * Not a list to grow casually: everything here is a directory a person did not write and cannot lose.
 * The other-synchroniser artefacts `docs/01` also names are a different argument — they are about not
 * fighting another tool over the same vault — and are not settled here.
 */
const NEVER = ['node_modules', '.git'];

export const isSyncable = (path: string, syncObsidian: boolean, configDir = '.obsidian'): boolean => {
  if (path.split('/').some((segment) => NEVER.includes(segment))) return false;
  if (path.startsWith('.trash/') || path.startsWith('_Reset ')) return false;
  if (path === configDir || path.startsWith(`${configDir}/`)) {
    if (!syncObsidian) return false;
    const rel = path.slice(configDir.length + 1);
    return OBSIDIAN_SHARED.some((name) => rel === name || rel.startsWith(`${name}/`));
  }
  return true;
};
