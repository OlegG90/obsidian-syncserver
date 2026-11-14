/**
 * Every route's `Body:` names the same schema its `body(...)` attaches (issue #483).
 *
 * A route states its body twice: the generic names the type and the options carry the
 * schema (`app.post<{ Body: CreateNodeBody }>(..., ...body(CreateNodeBody))`), and nothing
 * tied the two together — pairing one body's schema with another's type compiled. A typed
 * helper cannot close it: the schemas are plain JSON since issue #482, so `Static` has no
 * TypeBox brand to infer from, and any helper still takes the name twice. So this check
 * reads both spellings out of each route call, in order, and fails when a pair disagrees
 * or when one side is missing its other half.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /^server\/src\/.*\/routes\.ts$/.test(f));

const bodyName = String.raw`\bBody\s*:\s*([A-Za-z_]\w*)`;
const schemaName = String.raw`\bbody\(\s*(?:optional\(\s*)?([A-Za-z_]\w*)`;

/** `Body: Name` and `body(Name)` / `body(optional(Name))`, in textual order with line numbers. */
const pairsOf = (file) => {
  const text = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const at = (index) => text.slice(0, index).split('\n').length;
  const bodies = [...text.matchAll(new RegExp(bodyName, 'g'))].map((m) => ({ name: m[1], line: at(m.index) }));
  const schemas = [...text.matchAll(new RegExp(schemaName, 'g'))].map((m) => ({ name: m[1], line: at(m.index) }));
  return { bodies, schemas };
};

const problems = [];
for (const file of files) {
  const { bodies, schemas } = pairsOf(file);
  if (bodies.length !== schemas.length) {
    problems.push(`${file}: ${bodies.length} \`Body:\` against ${schemas.length} \`body(...)\` — one side is missing its other half`);
    continue;
  }
  bodies.forEach((b, i) => {
    if (b.name !== schemas[i].name) {
      problems.push(
        `${file}:${b.line}: \`Body: ${b.name}\` is answered by \`body(${schemas[i].name})\` on line ${schemas[i].line} — one body per route`,
      );
    }
  });
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`${problems.length} route body pairing problem(s)`);
  process.exit(1);
}
console.log('route bodies: every Body names the schema its body() attaches');
