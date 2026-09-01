/**
 * The plugin's own folder is named the same in the scope rule and in the manifest.
 *
 * `isSyncable` refuses to synchronise `.obsidian/plugins/syncserver/` (#303), and it does so by
 * comparing a path against a string. The manifest is what decides the real folder name: Obsidian
 * installs a plugin under its `id`. Two places, one fact, and a rename in the manifest would leave
 * the scope rule excluding a directory that no longer exists.
 *
 * Nothing about the result would look wrong. The vault would sync, the switch would still say
 * `.obsidian` was on, and `data.json` would quietly travel between devices again — carrying the
 * `deviceId` and `state.nodes` that made #303 what it was. It would show up as conflict files
 * inside a directory the file explorer does not display, on a vault that had been fine for weeks.
 *
 * The engine cannot import the manifest to settle this itself: `plugin/src/engine/` is the part
 * that runs without Obsidian, and a manifest is Obsidian's word about an install. So the two
 * strings stay apart and this check holds them together.
 */
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('plugin/manifest.json', 'utf8'));
const source = readFileSync('plugin/src/engine/vault.ts', 'utf8');

const declared = source.match(/^export const SELF = '([^']*)';$/m)?.[1];

if (declared === undefined) {
  console.error("self-exclusion: no `export const SELF = '…'` in plugin/src/engine/vault.ts — the check is blind");
  process.exit(1);
}

const expected = `plugins/${manifest.id}`;

if (declared !== expected) {
  console.error('the plugin does not exclude the folder it is installed into:');
  console.error(`  - plugin/manifest.json says id \`${manifest.id}\`, so Obsidian installs it at \`.obsidian/${expected}/\``);
  console.error(`  - plugin/src/engine/vault.ts excludes \`.obsidian/${declared}/\``);
  console.error('\nThat puts `data.json` — deviceId, wrappedSeed, cursor, nodes — back in scope (#303).');
  process.exit(1);
}

console.log(`self-exclusion: the scope rule and the manifest agree on \`${expected}\``);
