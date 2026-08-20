/**
 * One bundle, straight into a vault's plugin folder.
 *
 * Obsidian loads a plugin as a single CommonJS `main.js` beside its `manifest.json`, so this
 * is not a library build with an output directory to be copied later: the output directory
 * IS the installation. `--watch` therefore reinstalls on every save, and reloading the
 * plugin in Obsidian is the whole edit loop.
 *
 *     node esbuild.mjs --vault "C:/Workspace/Library/Obsidian/testVault/testVault"
 *     node esbuild.mjs --vault ... --watch
 *
 * `--out` is the same build with the installation left out, and exists for the one caller
 * that has no vault to install into: the release job, which collects `main.js` and
 * `manifest.json` as assets for BRAT to fetch. Deliberately a second flag rather than a
 * temporary directory passed to `--vault`, because a release naming a vault it does not have
 * is the kind of small lie that survives into somebody's mental model of the build.
 */
import { context } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const out = arg('out');
const vault = arg('vault') ?? process.env.SYNCSERVER_TEST_VAULT;
if (!out && !vault) {
  console.error('a destination is required: --vault <path> (or SYNCSERVER_TEST_VAULT), or --out <dir>');
  process.exit(1);
}

// A vault names where the plugin *lives*; `--out` names a directory directly. The plugin
// folder is only appended for the former, because that path is Obsidian's rule about vaults
// rather than anything this build decides.
const outDir = out ?? path.join(vault, '.obsidian', 'plugins', 'syncserver');
await mkdir(outDir, { recursive: true });

// The bundle's version comes from the same file Obsidian reads for its plugin list, so the
// number a person sees there and the number this build reports cannot disagree (#111).
const manifestPath = path.join(here, 'manifest.json');
const { version } = JSON.parse(await readFile(manifestPath, 'utf8'));
await copyFile(manifestPath, path.join(outDir, 'manifest.json'));

const ctx = await context({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(outDir, 'main.js'),
  bundle: true,
  // CommonJS and no splitting: Obsidian `require`s this file, and nothing fetches a chunk.
  format: 'cjs',
  platform: 'browser',
  // What both runtimes have: Electron's Chromium and the WebView on a phone that is not new.
  target: 'es2020',
  // Provided by the host. Bundling it would ship a second, dead copy of the editor's API.
  external: ['obsidian', 'electron'],
  define: { __SYNCSERVER_VERSION__: JSON.stringify(version) },
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  minify: !process.argv.includes('--watch'),
  logLevel: 'info',
});

if (process.argv.includes('--watch')) {
  await ctx.watch();
  console.log(`watching → ${outDir}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`built → ${outDir}`);
}
