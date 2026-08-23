/**
 * No workspace both **imports** a name from `shared` and **declares its own** under that name.
 *
 * This is narrower than "nothing may shadow a shared name", and deliberately. Two shadows exist on
 * purpose: `Material` and `DeletionProgress` are the wire shape in `shared` (snake_case, what crosses
 * the network) and the internal shape in the server (camelCase, what the code holds). One concept with
 * two faces, in two workspaces that never see each other's version — no reader can be confused by it.
 *
 * What is not on purpose is the case this was written for. `OpenedVault` has meant *what
 * `GET /vaults/:id` returns* since the beginning; a second `OpenedVault` was added to the plugin for a
 * different value **in a workspace that already imported the first one**, and it reached a release. The
 * two are one letter apart in meaning and identical in name, so importing the wrong one compiles until
 * a field is missing.
 *
 * The rule is therefore about ambiguity where it can actually bite: one workspace, one name, two things.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SHARED = 'shared/src/index.ts';
const exported = new Set(
  [...readFileSync(SHARED, 'utf8').matchAll(/^export (?:interface|type|const|class) ([A-Za-z_]\w*)/gm)].map((m) => m[1]),
);
if (exported.size === 0) {
  console.error(`${SHARED}: no exports found — the format changed and this check is blind`);
  process.exit(1);
}

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /^(plugin|server|console)\/(src|test)\/.*\.ts$/.test(f));

/** Which workspace a path belongs to — the first segment, which is also the npm workspace name. */
const workspaceOf = (file) => file.split('/')[0];
const declares = new Map();
const imports = new Map();
const note = (into, ws, name, file) => {
  if (!into.has(ws)) into.set(ws, new Map());
  if (!into.get(ws).has(name)) into.get(ws).set(name, file);
};

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const ws = workspaceOf(file);
  for (const m of text.matchAll(/^export (?:interface|type|class) ([A-Za-z_]\w*)/gm)) {
    if (exported.has(m[1])) note(declares, ws, m[1], file);
  }
  // The names inside the braces, split out rather than searched for: a pattern over the whole
  // statement would also hit a name mentioned in a comment above the import — and the first version
  // of this line used a word boundary written in a template literal, where it is a backspace
  // character instead. It matched nothing, so this check passed vacuously until a mutation asked it
  // to fail and it would not.
  for (const m of text.matchAll(/import[^;]*?from '@syncserver\/shared'/g)) {
    const braces = /\{([\s\S]*?)\}/.exec(m[0]);
    if (!braces) continue;
    for (const raw of braces[1].split(',')) {
      const cleaned = raw.replace(/type/, '').trim();
      // `Material as WireMaterial` is a reader disambiguating on purpose, and that is the remedy rather
      // than the disease — `nodes/routes.ts` holds both shapes and aliases one, which is exactly what
      // somebody importing the wrong `OpenedVault` never had the chance to do.
      if (/\s+as\s+/.test(cleaned)) continue;
      if (exported.has(cleaned)) note(imports, ws, cleaned, file);
    }
  }
}

const problems = [];
for (const [ws, names] of declares) {
  for (const [name, where] of names) {
    const alsoImported = imports.get(ws)?.get(name);
    if (alsoImported) {
      problems.push(
        `${where} declares \`${name}\`, and ${alsoImported} imports a different \`${name}\` from shared — ` +
          'one workspace, one name, two things',
      );
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`names: no workspace declares its own version of one of shared's ${exported.size} exports`);
