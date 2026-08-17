/**
 * One bundle and one page, written where the server can read them at boot.
 *
 * The server serves the console from its own process (docs/11: one deployment, one
 * session), so the output directory is what it reads — not something a later step copies.
 * There is no framework and no CSS pipeline: the console is thin because M4 put the
 * decisions behind the API, and what is left is reading and calling.
 */
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

await copyFile(path.join(here, 'src/index.html'), path.join(out, 'index.html'));
console.log(`built → ${out}`);
