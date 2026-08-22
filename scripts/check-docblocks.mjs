/**
 * Assert that no docblock sits above another docblock (D-84).
 *
 * The prose in this repository is load-bearing — it is where the reasons live — so a block
 * that has drifted off its function is not untidy, it is wrong in the way a reader trusts.
 * `@param shareKey` above a function that takes no `shareKey` reads as documentation and is
 * a statement about a different function entirely.
 *
 * **The rule is structural, and that is what makes it checkable.** Two docblocks with
 * nothing between them means the first one describes nothing: whatever it was written above
 * has been pushed away from it, or was renamed out from under it. There is exactly one
 * legitimate shape of this — the file header, which sits above the first declaration's own
 * block — and it is the block opening on line 1.
 *
 * A narrower first version only flagged blocks carrying `@param` or `@returns`, on the
 * theory that those make a checkable claim. It found ten of the twelve. The two it missed
 * were the two whose *stranded* block happened to carry no tags, which is not a property
 * anybody was choosing — so the narrow rule was not a smaller version of the right one, it
 * was the right one plus a coin toss.
 *
 * The wide rule was measured before being enforced: twelve hits across this repository, and
 * every one of them a genuine defect from a mechanical slip — a new declaration inserted
 * with its docblock placed after the existing one, instead of before the code the existing
 * one belonged to. No false positives, which is what makes it worth failing a build over.
 *
 * What it cannot see is the editorial case: prose that still sits above its function and no
 * longer describes it. Nothing here can, and a check that guessed would cry wolf until
 * somebody deleted it.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files "*.ts" "*.mjs"', { encoding: 'utf8' }).trim().split('\n');
const problems = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\*\/\s*$/.test(lines[i])) continue;
    if (!(lines[i + 1] ?? '').trim().startsWith('/**')) continue;

    let open = i;
    while (open > 0 && !/^\s*\/\*\*/.test(lines[open])) open--;
    if (open === 0) continue; // the file header, above the first declaration's own block

    const summary = (lines[open + 1] ?? '').replace(/^\s*\*\s?/, '').trim();
    problems.push(`${file}:${open + 1} — “${summary}” is followed by a docblock, not by code`);
  }
}

if (problems.length > 0) {
  console.error('docblocks that sit above another docblock, and so describe nothing:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nMove it above the code it belongs to, or merge it into the block below when both\n' +
      'describe the same thing — see D-84.',
  );
  process.exit(1);
}

console.log(`docblocks: every block in ${files.length} files sits above code`);
