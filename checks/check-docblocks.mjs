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

// Tracked files AND untracked ones that are not ignored. Reading `git ls-files` alone made the blind
// spot exactly the wrong shape: a file this cannot see is most often a NEW one, whose docblock was
// written minutes ago by somebody who has not yet met this rule. That happened three times in one day —
// twice to `check-citations.mjs` before it was fixed there, and once here, each time found by CI.
const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((f) => /\.(ts|mjs)$/.test(f));
const problems = [];

// Where a block ends: its own closing line, or the whole block on one line. Both shapes strand the
// same way — the first version saw only the first, and seven one-line and blank-line-separated
// strays sat in the plugin undetected until a review found them by hand.
const closesMultiLine = /^\s*\*\/\s*$/;
const oneLine = /^\s*\/\*\*.*\*\/\s*$/;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const single = oneLine.test(lines[i]);
    if (!single && !closesMultiLine.test(lines[i])) continue;

    // Blank lines between are no excuse: a block with only whitespace under it before the next
    // block describes nothing either.
    let next = i + 1;
    while (next < lines.length && lines[next].trim() === '') next++;
    if (!(lines[next] ?? '').trim().startsWith('/**')) continue;

    let open = i;
    if (!single) while (open > 0 && !/^\s*\/\*\*/.test(lines[open])) open--;
    if (open === 0) continue; // the file header, above the first declaration's own block

    const summary = single
      ? lines[open].replace(/^\s*\/\*\*\s?/, '').replace(/\s*\*\/\s*$/, '').trim()
      : (lines[open + 1] ?? '').replace(/^\s*\*\s?/, '').trim();
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
