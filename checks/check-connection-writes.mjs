/**
 * `data.connection` is written in one module, and `session-hold.ts` is that module.
 *
 * The rule it protects is that a device's identity and its private account of what it has synced move
 * together — the failure #303 was, where a device holding one of each looks perfectly healthy and
 * writes conflict files for ever.
 *
 * A type cannot hold this: `data.connection` is a field, and assigning to a field is well-typed
 * wherever it happens. Nor is prose enough, which is the part with evidence. `adopt()` existed,
 * containing exactly the six lines that enforce the rule, with a docblock saying so — and `connect`
 * and `pair` still re-typed those six lines rather than calling it, while `changeServerUrl` and
 * `keepEnvelope` wrote the field on their own. Five sites, one of them named.
 *
 * So the recurrence to guard against is not somebody deciding the rule is wrong. It is somebody with
 * one more field to write, writing it where they are standing. That edit looks reasonable in the
 * diff; it only looks wrong from here.
 *
 * The check is deliberately narrow. It says nothing about `data.state`, which a sync pass writes on
 * every run through the engine's state store — the ledger moving alone is ordinary, and only the
 * connection moving alone is the bug.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Where the rule lives. Every other file is checked against it. */
const OWNER = 'plugin/src/session-hold.ts';

/**
 * An assignment to the connection field, in the shapes it can take:
 * `this.data.connection = …`, `data.connection = …`, and `delete …data.connection`.
 */
const WRITE = /(?:^|[^\w.])(?:this\.)?data\.connection\s*=(?!=)|delete\s+(?:this\.)?data\.connection/;

/**
 * The hold's own wiring is not a bypass of the hold.
 *
 * `session-hold.ts` deliberately does not own the plugin's data — it performs the transition and
 * writes through a `record` dep, so the two lines that touch the field for real live in the
 * `openSessionHold({…})` call. Scoping by FILE would flag those, and the only ways to satisfy such a
 * check are worse than the check: give the module the composition root's data shape, or move the
 * rule back where it was.
 *
 * So the scope is the CALL. Hand-balanced rather than matched with a pattern, for the reason
 * `check-registration.mjs` gives about the same problem: the argument is an object full of arrow
 * functions, and a regular expression that claims to find its end is one that will one day find the
 * wrong one quietly.
 */
const wiringRange = (text) => {
  const at = text.indexOf('openSessionHold(');
  if (at === -1) return undefined;
  const open = at + 'openSessionHold('.length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return [open, i];
    }
  }
  return undefined; // unbalanced: the file does not parse, and something louder will say so
};

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.startsWith('plugin/src/') && f.endsWith('.ts') && f !== OWNER);

const problems = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const wiring = wiringRange(text);
  let offset = 0;
  for (const [i, line] of text.split('\n').entries()) {
    const start = offset;
    offset += line.length + 1;
    // A line that only mentions the field in prose is not a write; the pattern needs the `=`.
    if (!WRITE.test(line)) continue;
    if (wiring && start > wiring[0] && start < wiring[1]) continue;
    problems.push(`${file}:${i + 1} — ${line.trim()}`);
  }
}

// The owner has to actually be there, or this check passes by describing a rule nobody holds.
const owner = readFileSync(OWNER, 'utf8');
if (!owner.includes('openSessionHold')) {
  console.error(`connection-writes: ${OWNER} no longer exports the hold — this check is blind`);
  process.exit(1);
}

if (problems.length > 0) {
  console.error('the connection is written outside the one module that owns it:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nUse the hold in ${OWNER}: take, resume, keep or release. Writing the field here means the\n` +
      'connection can move without the sync ledger, which is what #303 was.',
  );
  process.exit(1);
}

console.log(`connection-writes: ${files.length} files checked, and the connection is written only in the hold`);
