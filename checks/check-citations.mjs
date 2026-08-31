/**
 * Every `D-N` cited anywhere resolves to a row in `docs/09-decisions.md`.
 *
 * The rule existed in AGENTS.md and nothing enforced it, which is how the decisions came to share a
 * notation with GitHub issue numbers and then to collide with them outright — `D-111` and `D-114`
 * through `D-119` are all real issue numbers too. A reader following the bare hash form landed
 * somewhere plausible and wrong, and no check could tell them apart because both were spelled alike.
 *
 * **It scans tracked files AND untracked ones that are not ignored.** The first version read `git
 * ls-files` alone, so a file it could not see was exactly the file most likely to be wrong: a new one,
 * whose author has just written its docblock. It failed on its own docblock that way, and then on a new
 * module's, both times in CI and never locally. `--others --exclude-standard` is what makes a local run
 * mean something.
 *
 * Two things are checked, and the second is the one that keeps the split honest:
 *
 * 1. every `D-N` names a row that exists — a citation of a decision nobody wrote is a claim with no
 *    referent, and it reads exactly like a real one;
 * 2. no **bare** `#N` matches a decision row's number — it has to be written `issue #N`. That is not a
 *    formality: fourteen citations in the plugin meant the pairing bug, a mechanical
 *    rename turned them into `D-117` meaning the audit log, and nothing in the tree could tell them
 *    apart. **This check cannot catch that**; what it can do is keep the two spellings distinct, so the
 *    next rename has something to read.
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

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
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
    // An issue number that collides with a decision must say so — the `issue` prefix, not a bare hash.
    // The first version sniffed the line for phrases like "exists because", which is guessing — and a
    // heuristic that guesses right is still one somebody will word around by accident.
    for (const m of line.matchAll(/(issues?\s+)?#(\d{1,3})\b/gi)) {
      if (rows.has(m[2]) && !m[1]) {
        problems.push(
          `${file}:${i + 1} writes #${m[2]}, which is also decision D-${m[2]} — ` +
            `write \`D-${m[2]}\` for the decision, or \`issue #${m[2]}\` when the issue is meant`,
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
