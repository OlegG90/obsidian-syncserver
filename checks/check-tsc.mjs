/**
 * Assert the `tsc` every script runs is the TypeScript the root manifest asks for.
 *
 * Two packages declare a `tsc` binary: `typescript`, which is 7, and `typescript5`, the alias that
 * keeps 5.9's JavaScript API for `check-thenables.mjs`. npm links one of them into
 * `node_modules/.bin`, and which one is a matter of its link order — undocumented, so free to
 * change under an npm update.
 *
 * The failure would be silent, which is why it is a check. 5.9 typechecks this code exactly as
 * green as 7 does; it is only seven times slower, and blind to anything 7 alone reports.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const range = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.typescript;
const wanted = /\d+/.exec(range)[0];

// Resolved the way an npm script resolves it: the root `.bin` first on the PATH.
const env = { ...process.env, PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}` };
const version = execFileSync('tsc', ['--version'], { env, encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const got = /(\d+)\.\d+/.exec(version)?.[1];

if (got !== wanted) {
  console.error(
    `tsc: the scripts run TypeScript ${got ?? '?'} ("${version}"), but package.json asks for ${range}. ` +
      'node_modules/.bin/tsc points at the typescript5 alias; reinstall, and if it persists, npm has ' +
      'changed which of two packages claiming one binary it links.',
  );
  process.exit(1);
}
console.log(`tsc: the scripts run TypeScript ${version.replace(/^Version /, '')}, the major package.json asks for`);
