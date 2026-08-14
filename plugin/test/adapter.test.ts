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
  const made: string[] = [];
  const written: string[] = [];
  const present = new Set<string>();
  const vault = {
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
    },
    getFiles: () => [],
  };
  return { vault: vault as unknown as Vault, made, written, present };
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
