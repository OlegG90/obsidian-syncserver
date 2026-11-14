/**
 * Emit the request-body schemas as plain JSON Schema (issue #482).
 *
 * `src/bodies.ts` declares each body once in TypeBox and infers its type from it (D-143) —
 * and TypeBox is how the *types* are made, not what the server reads. What Ajv validates
 * against is plain JSON Schema, so this script evaluates the TypeBox once at build time and
 * writes the result out as data: `src/schemas-gen.ts`, committed beside its source. The
 * runtime image then needs no TypeBox, and `checks/check-schemas-current.mjs` fails when
 * the committed file is older than the source it was generated from.
 *
 * Run directly to regenerate (`npm run emit:schemas --workspace @syncserver/shared`), or
 * with `--check` to compare instead of writing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bodies from '../src/bodies.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BODIES = path.join(here, '..', 'src', 'bodies.ts');
const OUT = path.join(here, '..', 'src', 'schemas-gen.ts');

/** Every value `export const` in the source, in source order — the whole runtime surface. */
const schemaNames = (): string[] => {
  const source = readFileSync(BODIES, 'utf8');
  const names = [...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!);
  if (names.length === 0) throw new Error('emit-schemas: no schemas found in src/bodies.ts');
  return names;
};

const isObjectSchema = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'object';

export const emitSchemas = (): string => {
  const names = schemaNames();
  const lines = [
    '/**',
    ' * The request-body schemas as plain JSON Schema — GENERATED, do not edit (issue #482).',
    ' *',
    ' * Regenerate with `npm run emit:schemas --workspace @syncserver/shared`. The source of truth',
    ' * is the TypeBox in `src/bodies.ts`, which is also where the types are inferred from; this file',
    ' * carries only what Ajv reads, so the runtime image needs no TypeBox.',
    ' */',
    '',
    "import type * as BodyTypes from './bodies.js';",
    '',
  ];
  for (const name of names) {
    const value = (bodies as Record<string, unknown>)[name];
    // Loud rather than lossy: a schema this test does not recognise must teach the emitter
    // what it is, not pass through it as something Ajv would read differently.
    if (!isObjectSchema(value)) {
      throw new Error(`emit-schemas: ${name} is not an object schema — teach the emitter what it is`);
    }
    lines.push(`export const ${name} = ${JSON.stringify(value, null, 2)} as const;`, '');
  }
  // Local aliases, not re-exports: a value star and a type star with the same names do not
  // merge, and neither do two re-exports — but a co-located `const` and `type` is exactly
  // what the source already is, so the barrel sees one entry with both meanings.
  // (The blank line above is the last const's own trailing one.)
  for (const name of names) lines.push(`export type ${name} = BodyTypes.${name};`);
  lines.push('');
  return lines.join('\n');
};

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  writeFileSync(OUT, emitSchemas());
  console.log(`schemas: wrote ${schemaNames().length} bodies to src/schemas-gen.ts`);
}
