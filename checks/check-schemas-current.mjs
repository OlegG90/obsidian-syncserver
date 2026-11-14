/**
 * The committed schemas are current with the TypeBox that declares them (issue #482).
 *
 * `shared/src/schemas-gen.ts` is generated from `shared/src/bodies.ts` and committed beside
 * it, so the server runs plain JSON Schema without TypeBox and a stale copy fails here rather
 * than reaching the image. Regenerate with `npm run emit:schemas --workspace @syncserver/shared`.
 *
 * Run with tsx rather than node, because the emitter reads TypeScript source.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSchemas } from '../shared/scripts/emit-schemas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const committed = readFileSync(path.join(here, '..', 'shared', 'src', 'schemas-gen.ts'), 'utf8');
const fresh = emitSchemas();
if (committed !== fresh) {
  const a = committed.split('\n');
  const b = fresh.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  console.error(
    'schemas-gen.ts is older than src/bodies.ts — regenerate it:\n' +
      '  npm run emit:schemas --workspace @syncserver/shared\n' +
      `first difference at line ${at + 1}:\n` +
      `  committed: ${JSON.stringify(a[at])}\n` +
      `  fresh:     ${JSON.stringify(b[at])}`,
  );
  process.exit(1);
}
console.log('schemas: every body in bodies.ts is current in schemas-gen.ts');
