/**
 * The `.obsidian/` switch and its per-device exceptions (D-7, docs/01).
 *
 * Three gates share one filter: what the engine scans locally, what it pulls from the
 * server, and what it treats as vanished. The switch is off by default; turning it off
 * freezes `.obsidian/` in place rather than deleting it.
 */
import assert from 'node:assert/strict';
import type { Delta } from '@syncserver/shared';
import type { VaultState } from '../src/engine/state.js';
import { dedupTag } from '../src/crypto/scope.js';
import type { OpenedVault } from '@syncserver/shared';
import { describe, it } from 'node:test';

import { vaultKey } from '../src/crypto/account.js';
import { sealBlob } from '../src/crypto/blob.js';
import { toHex, utf8, randomBytes } from '../src/crypto/bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { isSyncable } from '../src/engine/vault.js';
import { SyncEngine } from '../src/engine/engine.js';
import { scopesOf } from './vault-scopes.js';
import { OneFileWire, Store, type VaultConstants } from './one-file-wire.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const scopeId = 'scope-vault';
const kv = vaultKey(randomBytes(32), vaultId);
const V: VaultConstants = { vaultId, rootNodeId, scopeId, kv };


describe('isSyncable and the .obsidian/ switch', () => {
  it('excludes .obsidian/ entirely when the switch is off (the default)', () => {
    assert.equal(isSyncable('.obsidian/appearance.json', false), false);
    assert.equal(isSyncable('.obsidian/plugins/foo/data.json', false), false);
    assert.equal(isSyncable('Notes/a.md', false), true);
    assert.equal(isSyncable('.trash/gone.md', false), false);
  });

  it('includes what belongs to the vault when the switch is on', () => {
    assert.equal(isSyncable('.obsidian/appearance.json', true), true);
    assert.equal(isSyncable('.obsidian/hotkeys.json', true), true);
    assert.equal(isSyncable('.obsidian/snippets/mermaid-palette.css', true), true);
    assert.equal(isSyncable('.obsidian/themes/Minimal/theme.css', true), true);
    assert.equal(isSyncable('.obsidian/templates.json', true), true);
  });

  /**
   * The inversion, and the reason for it (#314).
   *
   * These three were synchronised until an allow list replaced the deny list, and one vault showed
   * within a day what that meant: `community-plugins.json` held eleven plugins on a desktop and one
   * on a phone, `core-plugins.json` disagreed about `switcher`, and `app.json` carried a mobile
   * toolbar on the machine with no touchscreen. Every reconciliation produced a conflict file,
   * because the two files were never two edits — they were two machines.
   */
  it('leaves what describes the machine on the machine', () => {
    for (const path of [
      '.obsidian/app.json',
      '.obsidian/core-plugins.json',
      '.obsidian/community-plugins.json',
      '.obsidian/workspaces.json',
      '.obsidian/workspace.json',
      '.obsidian/graph.json',
      '.obsidian/cache/whatever',
    ]) {
      assert.equal(isSyncable(path, true), false, path);
    }
  });

  /**
   * Plugins are installed deliberately, per device — so the whole subtree stays put, and that is
   * what now keeps this plugin's own `data.json` out of scope rather than a rule of its own (#303).
   * `checks/check-config-scope.mjs` refuses any future allow-list entry under `plugins/`.
   */
  it('never synchronises a plugin, its code or its data', () => {
    for (const on of [true, false]) {
      assert.equal(isSyncable('.obsidian/plugins/syncserver/data.json', on), false, 'ours');
      assert.equal(isSyncable('.obsidian/plugins/obsidian42-brat/data.json', on), false, "BRAT's beta list");
      assert.equal(isSyncable('.obsidian/plugins/dataview/main.js', on), false, 'somebody else code');
      assert.equal(isSyncable('.obsidian/plugins', on), false, 'the folder itself');
    }
  });

  // The entries are path segments. A theme called `appearance.json.old` is not `appearance.json`.
  it('matches an allow-list entry as a whole segment', () => {
    assert.equal(isSyncable('.obsidian/appearance.json.bak', true), false);
    assert.equal(isSyncable('.obsidian/snippets-old/a.css', true), false);
    assert.equal(isSyncable('.obsidian/snippets/nested/deep.css', true), true, 'but depth inside one is fine');
  });

  /**
   * The **Never** column of `docs/01`, which the rule never enforced (#312).
   *
   * Latent until #304: `getFiles()` could not see a hidden `.git` or anything under `.obsidian/`, so
   * the missing rule had nothing to match. The configuration walk reads `vault.adapter`, which sees
   * every path — and a plugin that vendors its dependencies put 29 MB of Windows debug symbols and
   * native binaries in scope on a real vault.
   */
  it('never syncs node_modules or .git, at any depth or switch position', () => {
    for (const on of [true, false]) {
      assert.equal(isSyncable('.obsidian/plugins/lean-terminal/node_modules/node-pty/pty.node', on), false);
      assert.equal(isSyncable('.obsidian/plugins/x/node_modules', on), false, 'the folder itself');
      assert.equal(isSyncable('Projects/thing/node_modules/left-pad/index.js', on), false, 'outside the config dir too');
      assert.equal(isSyncable('Projects/thing/.git/config', on), false);
      assert.equal(isSyncable('.git/HEAD', on), false, 'a repository at the vault root');
    }
  });

  // A segment, not a substring. Somebody writing about their dependencies keeps their notes.
  it('does not take a note whose folder merely contains the word', () => {
    assert.equal(isSyncable('Notes/my node_modules notes/a.md', true), true);
    assert.equal(isSyncable('Notes/node_modules_explained.md', true), true);
    assert.equal(isSyncable('Notes/.gitignore-explained/a.md', true), true);
  });

  /**
   * Obsidian lets a vault rename its configuration directory, and reports it as `vault.configDir`
   * (#304). The per-device exceptions are named relative to it, so a rule that assumed the default
   * would hand `workspace.json` to every other device — and would treat the renamed directory as
   * ordinary notes, syncing the whole of it with the switch OFF.
   */
  it('takes the configuration directory from the vault rather than assuming it', () => {
    assert.equal(isSyncable('.myconfig/appearance.json', false, '.myconfig'), false, 'off means off');
    assert.equal(isSyncable('.myconfig/appearance.json', true, '.myconfig'), true);
    assert.equal(isSyncable('.myconfig/workspace.json', true, '.myconfig'), false, 'still per-device');
    assert.equal(isSyncable('.myconfig/plugins/syncserver/data.json', true, '.myconfig'), false, 'still ours');
    // And a folder that merely looks like the default is then just a folder.
    assert.equal(isSyncable('.obsidian/appearance.json', false, '.myconfig'), true);
  });

  /**
   * The four the deny list used to name explicitly. They are still out, and now for a duller reason:
   * nothing admits them. Kept as a test because they are the cases somebody will check by hand, and
   * an allow list that quietly started matching `workspace.json` would be a laptop and a phone
   * fighting over which panes are open — the original argument, still true.
   */
  it('keeps the old per-device exceptions out, now by not naming them', () => {
    assert.equal(isSyncable('.obsidian/workspace.json', true), false, 'window layout');
    assert.equal(isSyncable('.obsidian/workspace-mobile.json', true), false, 'mobile twin');
    assert.equal(isSyncable('.obsidian/graph.json', true), false, 'graph view');
    assert.equal(isSyncable('.obsidian/cache/some-file', true), false, 'plugin cache');
  });
});

/**
 * The vault as the engine is now given it, rather than as it used to ask for it.
 *
 * The seam lost `openVault` when the caller took over opening: one value per
 * operation, passed to everything that operation needs (docs/06).
 */
const opened: OpenedVault = {
  root_node_id: rootNodeId,
  head_rev: 5,
  scopes: [{ scope: 'vault', key_id: scopeId }],
};

/** A minimal wire: serves the given server files (sealed once) and records pushes. */

const continuous: Delta = { changes: [], events: [], next_cursor: 'cursor-new', has_more: false };

describe('the engine applies the scope to scan, pull and delete', () => {
  it('does not pull .obsidian/ files from the server when the switch is off', async () => {
    // The server has a note AND an .obsidian file (uploaded by a device with the switch on).
    const wire = new OneFileWire(V, [
        { path: 'Notes/a.md', text: 'a note', nodeId: 'node-1', rev: 2 },
        { path: '.obsidian/appearance.json', text: '{}', nodeId: 'node-2', rev: 3 },
      ],
      continuous,
    );
    const vault = new FakeVault();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, new Store({ nodes: {} }));

    const report = await engine.sync();

    assert.equal(vault.contents('Notes/a.md'), 'a note', 'the ordinary file is pulled');
    assert.equal(vault.contents('.obsidian/appearance.json'), undefined, '.obsidian is not pulled');
    assert.ok(report.pulled.some((p) => p.path === 'Notes/a.md'));
    assert.ok(!report.pulled.some((p) => p.path.startsWith('.obsidian/')));
  });

  it('does not push .obsidian/ files when the switch is off', async () => {
    const wire = new OneFileWire(V, [], continuous);
    const vault = new FakeVault();
    vault.seed('Notes/a.md', 'a note');
    vault.seed('.obsidian/appearance.json', '{}');
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, new Store({ nodes: {} }));

    const report = await engine.sync();

    assert.ok(report.pushed.some((p) => p.path === 'Notes/a.md'));
    assert.ok(!report.pushed.some((p) => p.path.startsWith('.obsidian/')), 'nothing from .obsidian is pushed');
  });

  it('turning the switch off freezes .obsidian/ instead of deleting it', async () => {
    // The device synced .obsidian while the switch was on; it is now off. The file is still
    // in state but no longer on disk (the scan excludes it). It must NOT be pushed as a delete.
    const appearance = sealBlob(utf8('{}'));
    const state: VaultState = {
      cursor: 'cursor-old',
      nodes: {
        '.obsidian/appearance.json': {
          nodeId: 'node-9',
          rev: 4,
          plainHash: toHex(sha256(utf8('{}'))),
          address: appearance.sha256,
        },
      },
    };
    // The server still holds it.
    const wire = new OneFileWire(V, [{ path: '.obsidian/appearance.json', text: '{}', nodeId: 'node-9', rev: 4 }],
      continuous,
    );
    const vault = new FakeVault();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, new Store(state));

    const report = await engine.sync();

    assert.equal(report.deleted.length, 0, 'no delete is pushed for .obsidian');
    assert.equal(report.removed.length, 0, 'and it is not removed locally');
    assert.equal(vault.contents('.obsidian/appearance.json'), undefined, 'the local copy stays gone — the switch froze it');
    // State kept the entry, so flipping the switch back on resumes it rather than re-uploading.
  });

  /**
   * The switch ON, which is the configuration this matters in (#303).
   *
   * The rule is `isSyncable`'s and is tested directly above; this asks the engine, because the two
   * directions are what the bug actually was. A `data.json` pulled from another device is the
   * device's identity landing on this one, and a `data.json` pushed is this device handing its own
   * away — and the plugin's own `save` at the end of the pass is what turns either into a node the
   * two devices then push back and forth for ever.
   */
  it('leaves this plugin alone in both directions with the switch on', async () => {
    const wire = new OneFileWire(V, [
        { path: '.obsidian/appearance.json', text: '{}', nodeId: 'node-1', rev: 2 },
        { path: '.obsidian/plugins/syncserver/data.json', text: '{"connection":{"deviceId":"other"}}', nodeId: 'node-2', rev: 3 },
      ],
      continuous,
    );
    const vault = new FakeVault();
    vault.seed('.obsidian/plugins/syncserver/data.json', '{"connection":{"deviceId":"mine"}}');
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, new Store({ nodes: {} }), 'device', true);

    const report = await engine.sync();

    assert.equal(vault.contents('.obsidian/appearance.json'), '{}', 'ordinary configuration still travels');
    assert.equal(
      vault.contents('.obsidian/plugins/syncserver/data.json'),
      '{"connection":{"deviceId":"mine"}}',
      "the other device's identity did not land here",
    );
    assert.ok(!report.pulled.some((p) => p.path.startsWith('.obsidian/plugins/syncserver/')), 'nothing of ours is pulled');
    assert.ok(!report.pushed.some((p) => p.path.startsWith('.obsidian/plugins/syncserver/')), 'nothing of ours is pushed');
  });

  /**
   * The upload half of the switch, which never worked (#304).
   *
   * `FakeVault` now splits `list()` from `listConfig()` the way Obsidian's index does, and that split
   * is what gives this test teeth: before it, every fake answered configuration files from the same
   * map the engine already read, so a scan that never asked for them still looked complete.
   */
  it('pushes configuration once the switch is on', async () => {
    const wire = new OneFileWire(V, [], continuous);
    const vault = new FakeVault();
    vault.seed('Notes/a.md', 'a note');
    vault.seed('.obsidian/appearance.json', '{}');
    vault.seed('.obsidian/workspace.json', '{}');
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, new Store({ nodes: {} }), 'device', true);

    const report = await engine.sync();

    assert.ok(report.pushed.some((p) => p.path === 'Notes/a.md'), 'the note still goes');
    assert.ok(report.pushed.some((p) => p.path === '.obsidian/appearance.json'), 'and now the configuration does');
    assert.ok(!report.pushed.some((p) => p.path === '.obsidian/workspace.json'), 'except what is this screen only');
  });

  // The other half of the same call: with the switch off the walk is not even made, so a vault that
  // never opted in pays nothing for the directory being there.
  it('does not walk the configuration directory when the switch is off', async () => {
    const wire = new OneFileWire(V, [], continuous);
    const vault = new FakeVault();
    vault.seed('.obsidian/appearance.json', '{}');
    let walked = 0;
    const counting = Object.create(vault) as FakeVault;
    counting.listConfig = async () => {
      walked += 1;
      return vault.listConfig();
    };
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), counting, new Store({ nodes: {} }));

    await engine.sync();

    assert.equal(walked, 0);
  });
});
