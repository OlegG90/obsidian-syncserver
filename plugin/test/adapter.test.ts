/**
 * The real Obsidian adapter — the one layer every other test replaces with a fake.
 *
 * `FakeVault` stands in for this everywhere else, which is what let a bug live here through
 * a hundred and fifty passing tests and reach a phone: writing a file into the vault ROOT
 * created a folder named after it minus its last character. `Ashford.md` produced a folder
 * `Ashford.m`, which then synced up as a real folder and came back down on every device.
 *
 * Nothing from `obsidian` is imported at runtime here — the module takes `Vault` as a type
 * only — so the adapter can be driven with a stub that records what it was asked to do.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Vault } from 'obsidian';

import { ObsidianVaultAdapter } from '../src/obsidian/adapter.js';

/** Just enough of `vault.adapter` to see which calls the write path makes. */
const stubVault = () => {
  /** What is on disk below the index — what `vault.adapter` can see and `getFiles()` cannot. */
  const onDisk = new Map<string, { mtime: number; size: number }>();
  const folders = new Set<string>();
  /** Listed, but gone by the time anything asks about them — a file rewritten mid-walk. */
  const ghosts = new Set<string>();
  const made: string[] = [];
  const written: string[] = [];
  /** Paths written THROUGH Obsidian, which is what an open note needs to be told about (#295). */
  const modified: string[] = [];
  /** What Obsidian tracks. A path in here is a file the app already knows and may have open. */
  const tracked = new Map<string, { stat: { mtime: number; size: number } }>();
  const present = new Set<string>();
  const vault = {
    getAbstractFileByPath: (p: string) => tracked.get(p) ?? null,
    modifyBinary: async (f: { stat: unknown }, _data: ArrayBuffer) => {
      const path = [...tracked.entries()].find(([, v]) => v === f)?.[0];
      modified.push(path ?? '(untracked)');
    },
    adapter: {
      exists: async (p: string) => present.has(p),
      mkdir: async (p: string) => {
        made.push(p);
        present.add(p);
      },
      writeBinary: async (p: string, _data: ArrayBuffer) => {
        written.push(p);
        present.add(p);
      },
      readBinary: async () => new ArrayBuffer(0),
      remove: async () => undefined,
      /** A directory listing, the way `DataAdapter` gives it: files and folders apart, full paths. */
      list: async (dir: string) => ({
        files: [...onDisk.keys(), ...ghosts].filter(
          (p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'),
        ),
        folders: [...folders].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')),
      }),
      stat: async (p: string) => onDisk.get(p),
    },
    getFiles: () => [],
    configDir: '.obsidian',
  };
  return { vault: vault as unknown as Vault, made, written, modified, present, tracked, onDisk, folders, ghosts };
};

describe('writing into the vault', () => {
  it('creates no folder for a file at the root', () => {
    // The bug, in one assertion. `lastIndexOf('/')` is -1 for a root path, and
    // `slice(0, -1)` is the path minus its last character rather than nothing at all.
    const { vault, made, written } = stubVault();
    return new ObsidianVaultAdapter(vault).write('Ashford.md', new Uint8Array([1])).then(() => {
      assert.deepEqual(made, [], 'a file in the root has no parent to create');
      assert.deepEqual(written, ['Ashford.md']);
    });
  });

  it('creates the parent chain for a nested file, and only the parent', async () => {
    const { vault, made, written } = stubVault();
    await new ObsidianVaultAdapter(vault).write('Folder AAA/deep/note.md', new Uint8Array([1]));

    assert.deepEqual(made, ['Folder AAA/deep'], 'the containing folder, not each segment separately');
    assert.deepEqual(written, ['Folder AAA/deep/note.md']);
  });

  it('does not remake a folder that is already there', async () => {
    const { vault, made, present } = stubVault();
    present.add('Folder AAA');
    await new ObsidianVaultAdapter(vault).write('Folder AAA/note.md', new Uint8Array([1]));

    assert.deepEqual(made, [], 'exists() is asked first');
  });

  it('writes a dotfile in the root without inventing a folder from its name', async () => {
    // `.obsidian`-style names are the case where "everything before the last dot" reasoning
    // would also have gone wrong; the separator is the only thing that decides a parent.
    const { vault, made, written } = stubVault();
    await new ObsidianVaultAdapter(vault).write('.hidden', new Uint8Array([1]));

    assert.deepEqual(made, []);
    assert.deepEqual(written, ['.hidden']);
  });
});

/**
 * A pull into a note the app already has open (#295).
 *
 * `vault.adapter.writeBinary` puts bytes on disk behind Obsidian's back. The editor keeps the buffer
 * it had, writes it back on its next save, and the pull is undone — which the next pass reads as a
 * local edit and resolves into a conflict file holding the OLD text. The whole of the fix is choosing
 * the write that tells the app.
 */
describe('a file Obsidian already tracks', () => {
  it('is written through the vault, not behind its back', async () => {
    const { vault, written, modified, tracked } = stubVault();
    tracked.set('Notes/open.md', { stat: { mtime: 1, size: 1 } });

    await new ObsidianVaultAdapter(vault).write('Notes/open.md', new Uint8Array([1, 2, 3]));

    assert.deepEqual(modified, ['Notes/open.md'], 'an open editor is never told by a raw adapter write');
    assert.deepEqual(written, [], 'and the raw write must not also happen');
  });

  it('is not preceded by a folder check, because its folder is already there', async () => {
    const { vault, made, tracked } = stubVault();
    tracked.set('Folder AAA/deep/note.md', { stat: { mtime: 1, size: 1 } });

    await new ObsidianVaultAdapter(vault).write('Folder AAA/deep/note.md', new Uint8Array([1]));

    assert.deepEqual(made, [], 'a tracked file has a parent by definition');
  });

  it('still creates one Obsidian does not know, through the adapter', async () => {
    // The other half, and the reason the module keeps both paths: a file the engine is about to
    // create has no `TFile` to hand to `modifyBinary`, which is the original argument for writing
    // by path.
    const { vault, written, modified, made } = stubVault();

    await new ObsidianVaultAdapter(vault).write('Folder AAA/new.md', new Uint8Array([1]));

    assert.deepEqual(modified, [], 'there is nothing tracked to modify');
    assert.deepEqual(written, ['Folder AAA/new.md']);
    assert.deepEqual(made, ['Folder AAA']);
  });

  // A folder answers `getAbstractFileByPath` too, and it has no `stat`. Writing bytes into one is a
  // bug wherever it comes from, and it must not become a `modifyBinary` call on a folder.
  it('does not mistake a folder for a file', async () => {
    const { vault, modified, tracked } = stubVault();
    (tracked as unknown as Map<string, unknown>).set('Folder AAA', { children: [] });

    await new ObsidianVaultAdapter(vault).write('Folder AAA/note.md', new Uint8Array([1]));

    assert.deepEqual(modified, [], 'only a file is modified');
  });
});

/**
 * The configuration walk (#304).
 *
 * `getFiles()` reads Obsidian's file index and the configuration directory is not in it, so for as
 * long as the engine's only view of local files was that call, the `.obsidian/` switch could pull
 * everything and push nothing. `FakeVault` could not show it — a fake answering one map is more
 * capable than Obsidian — which is why this lives here, beside the other bug the fake could not see.
 */
describe('walking the configuration directory', () => {
  it('finds files the file index does not carry, at every depth', async () => {
    const { vault, onDisk, folders } = stubVault();
    onDisk.set('.obsidian/appearance.json', { mtime: 11, size: 2 });
    onDisk.set('.obsidian/plugins/foo/data.json', { mtime: 22, size: 7 });
    folders.add('.obsidian/plugins');
    folders.add('.obsidian/plugins/foo');
    (vault as unknown as { adapter: { exists: (p: string) => Promise<boolean> } }).adapter.exists = async () => true;

    const found = await new ObsidianVaultAdapter(vault).listConfig();

    assert.deepEqual(
      found.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: '.obsidian/appearance.json', mtime: 11, size: 2 },
        { path: '.obsidian/plugins/foo/data.json', mtime: 22, size: 7 },
      ],
    );
  });

  it('answers nothing when there is no configuration directory', async () => {
    const { vault } = stubVault();
    assert.deepEqual(await new ObsidianVaultAdapter(vault).listConfig(), []);
  });

  it('skips a file that vanished between being listed and being asked about', async () => {
    // A plugin rewriting its own `data.json` mid-walk is ordinary. It is not a reason to fail a pass.
    const { vault, onDisk, ghosts } = stubVault();
    onDisk.set('.obsidian/appearance.json', { mtime: 11, size: 2 });
    ghosts.add('.obsidian/gone.json');
    (vault as unknown as { adapter: { exists: (p: string) => Promise<boolean> } }).adapter.exists = async () => true;

    const found = await new ObsidianVaultAdapter(vault).listConfig();

    assert.deepEqual(found.map((f) => f.path), ['.obsidian/appearance.json']);
  });

  it('reports the configuration directory Obsidian actually uses', () => {
    const { vault } = stubVault();
    assert.equal(new ObsidianVaultAdapter(vault).configDir, '.obsidian');
  });
});
