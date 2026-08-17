/**
 * Assert the whole solution ships as one version (#111).
 *
 * Five files have to carry the number and none of them can be deleted: npm requires a
 * `version` in every workspace manifest, and Obsidian requires one in `manifest.json` —
 * it is what the plugin list displays and what decides whether an update is offered. So
 * this is the case the repository's usual answer ("one description, no copies") cannot
 * reach, and the fallback is the other half of that rule: if a thing must be written
 * twice, a check must fail when the two disagree.
 *
 * The failure this prevents is quiet. A plugin bundle reporting 0.1.0 to a server that is
 * really 0.2.0 does not crash; it silently claims a compatibility the code went out of its
 * way to check for, which is worse than not checking at all.
 *
 * Run by `npm test`, so it cannot be the check nobody remembers.
 */
import { readFileSync } from 'node:fs';

// The root manifest leads because it is the version of the *solution* — the thing that is
// released. The rest follow it.
const files = [
  'package.json',
  'shared/package.json',
  'server/package.json',
  'console/package.json',
  'plugin/package.json',
  'plugin/manifest.json',
];

const found = files.map((file) => {
  const { version } = JSON.parse(readFileSync(file, 'utf8'));
  return { file, version };
});

const problems = [];
const [root, ...rest] = found;

// `major.minor.patch` exactly: npm and Obsidian both require three components, and the
// plugin's compatibility rule reads the first two. A two-part "0.1" parses nowhere.
for (const { file, version } of found) {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version ?? '')) {
    problems.push(`${file}: “${version}” is not major.minor.patch`);
  }
}

for (const { file, version } of rest) {
  if (version !== root.version) {
    problems.push(`${file}: ${version} — package.json says ${root.version}`);
  }
}

if (problems.length > 0) {
  console.error('version drift:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nEvery component of the solution ships as one version — see docs/09 #111.');
  process.exit(1);
}

console.log(`version: ${root.version} across all ${found.length} manifests`);
