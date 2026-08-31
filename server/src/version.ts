/**
 * What release this server is, read from the one file that must already be right.
 *
 * `server/package.json` is not a copy of the version — it is npm's own record of it, and
 * the Dockerfile already copies it into the runtime image because npm needs it there. So
 * reading it costs nothing and adds no second place to keep in step. A constant compiled in
 * here would be exactly that second place, and `checks/check-version.mjs` exists because
 * the three manifests that genuinely cannot be merged are already one more than ideal.
 *
 * The path is the same from both sides of the build: `rootDir: src` and `outDir: dist` sit
 * at the same depth, so `../package.json` is `server/package.json` whether this file is
 * running as `src/version.ts` under tsx or as `dist/version.js` under node.
 */
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version?: string;
};

/** `major.minor.patch`, reported by `/health` and by nothing else (D-111). */
export const SERVER_VERSION: string = manifest.version ?? '0.0.0';
