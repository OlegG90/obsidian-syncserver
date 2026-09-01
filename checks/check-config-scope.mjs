/**
 * Nothing under `plugins/` is ever admitted to the configuration allow list.
 *
 * `OBSIDIAN_SHARED` (`plugin/src/engine/vault.ts`) names what under `.obsidian/` belongs to the vault
 * rather than to the machine reading it. Adding `plugins/<id>/data.json` to that list is the single most
 * reasonable-looking edit anyone will ever propose to it — plugin settings ARE configuration, and the
 * documentation used to promise them — and it is the one that must not happen.
 *
 * This plugin's own `data.json` holds `connection.deviceId`, `connection.wrappedSeed`, `state.cursor`
 * and `state.nodes`: the device's identity and its private account of what it has synced. In scope,
 * a pulled copy is overwritten by the plugin's own `save` at the end of the same pass, leaving a
 * recorded hash that no longer matches the file — indistinguishable from a person having edited it.
 * Two devices then push one node back and forth for ever, and a process killed between the pull and
 * the save wakes up believing it is the other device (#303).
 *
 * Third-party plugins are not safer, only differently unsafe: BRAT's `data.json` is the list of beta
 * plugins installed on THAT machine, and it produced a conflict file the first day the switch worked.
 *
 * A type cannot hold this: the list is an array of strings and every string is well-typed. So the
 * check reads the array and refuses the segment.
 *
 * It replaces `check-self-exclusion.mjs`, which compared a constant against `manifest.json`. That
 * constant is gone — our folder is out of scope because ALL of `plugins/` is, which is a stronger
 * statement and needs no name to keep in sync.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync('plugin/src/engine/vault.ts', 'utf8');

const block = source.match(/export const OBSIDIAN_SHARED = \[([^\]]*)\]/)?.[1];

if (block === undefined) {
  console.error('config-scope: no `export const OBSIDIAN_SHARED = [...]` in plugin/src/engine/vault.ts — the check is blind');
  process.exit(1);
}

const entries = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]);

if (entries.length === 0) {
  console.error('config-scope: OBSIDIAN_SHARED is empty, so the .obsidian/ switch would synchronise nothing');
  process.exit(1);
}

const offenders = entries.filter((e) => e === 'plugins' || e.startsWith('plugins/'));

if (offenders.length > 0) {
  console.error('the configuration allow list admits a plugin folder:');
  for (const o of offenders) console.error(`  - \`${o}\``);
  console.error(
    '\nPlugins are installed per device, and a plugin `data.json` is that device\'s state — ours holds\n' +
      'its identity and its sync ledger (#303), and BRAT\'s holds which betas that machine runs (#314).',
  );
  process.exit(1);
}

console.log(`config-scope: ${entries.length} entries share the vault, none of them under plugins/`);
