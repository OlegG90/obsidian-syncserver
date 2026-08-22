/**
 * Every `D-N` cited anywhere resolves to a row in `docs/09-decisions.md`.
 *
 * The rule existed in AGENTS.md and nothing enforced it, which is how the decisions came to share a
 * notation with GitHub issue numbers and then to collide with them outright — `D-111` and `D-114`
 * through `D-119` are all real issue numbers too. A reader following `#117` landed somewhere
 * plausible and wrong, and no check could tell them apart because both were spelled the same.
 *
 * Two things are checked, and the second is the one that keeps the split honest:
 *
 * 1. every `D-N` names a row that exists — a citation of a decision nobody wrote is a claim with no
 *    referent, and it reads exactly like a real one;
 * 2. no `#N` in the tree matches a decision row's number, because that spelling now belongs to
 *    GitHub. An id that is both would put the ambiguity straight back.
 *
 * `#N` for an actual issue is left alone: it is what GitHub links, and it is how a commit closes one.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DECISIONS = 'docs/09-decisions.md';
const rows = new Set([...readFileSync(DECISIONS, 'utf8').matchAll(/^\|\s*D-(\d+)\s*\|/gm)].map((m) => m[1]));
if (rows.size === 0) {
  console.error(`${DECISIONS}: no decision rows found — the table format changed and this check is blind`);
  process.exit(1);
}

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|md|sql|mjs|ya?ml)$/.test(f) && !f.startsWith('shared/dist'));

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\bD-(\d+)\b/g)) {
      if (!rows.has(m[1])) problems.push(`${file}:${i + 1} cites D-${m[1]}, which is not a row in ${DECISIONS}`);
    }
    // The decisions file itself carries issue numbers in its prose, exactly like every other file.
    for (const m of line.matchAll(/#(\d{1,3})\b/g)) {
      if (rows.has(m[1]) && !/exists because|the issue|GitHub/i.test(line)) {
        problems.push(
          `${file}:${i + 1} writes #${m[1]}, which is also decision D-${m[1]} — ` +
            'use D-N for the decision, or say plainly that the issue is meant',
        );
      }
    }
  });
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`${problems.length} citation problem(s)`);
  process.exit(1);
}
console.log(`citations: every D-N resolves to one of ${rows.size} decisions, and no #N claims to be one`);
