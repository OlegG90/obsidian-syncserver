/**
 * What Obsidian records **once** is registered from constants, never from the phase.
 *
 * `addRibbonIcon(icon, title, callback)` takes its icon and its title one time and hands back only an
 * element; the registered item is not exposed, so neither string can ever be corrected. On a phone the
 * action sheet is drawn from that registration rather than from the live element — so a value computed
 * from the sync phase is frozen at load, and the phase at load is `disconnected` or `locked` almost
 * every time.
 *
 * That is not a hypothetical. It shipped twice. The **title** carried `shortStatus(this.phase)` and a
 * vault that had connected and synced was offered "Sync: not connected" for ever (#285); the fix left
 * the **icon** doing the identical thing, and `cloud-off` sat beside a healthy vault until #290. Both
 * were read past by a person editing that exact line, because prose above a call does not stop an
 * argument being written.
 *
 * A type cannot hold this rule: `addRibbonIcon` is somebody else's signature and its parameters are
 * `string`. So the check looks at the **shape of the call** instead — the two recorded arguments must
 * be bare module constants, and a call or a template in either position is the mistake itself.
 *
 * It deliberately says nothing about the third argument. A callback is invoked when pressed, so it may
 * read whatever it likes; and it says nothing about the status bar, whose element is live and is meant
 * to change.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Obsidian's registrations that keep what they are given. `addStatusBarItem` is not one — it returns a live element. */
const RECORDED_ONCE = [{ call: 'addRibbonIcon', keeps: 2, what: 'its icon and its title' }];

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.startsWith('plugin/src/') && f.endsWith('.ts'));

/**
 * The arguments of one call, split at depth zero.
 *
 * Hand-scanned rather than matched with a pattern: the last argument is a lambda full of its own
 * parentheses and commas, and a regular expression that claims to split those is a regular expression
 * that will one day split them wrongly and quietly.
 */
const argumentsOf = (text, openParen) => {
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' && depth === 0) {
      args.push(text.slice(start, i).trim());
      return args;
    } else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined; // unbalanced: the file does not parse, and something louder than this will say so
};

const CONSTANT = /^[A-Z][A-Z0-9_]*$/;

const problems = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { call, keeps, what } of RECORDED_ONCE) {
    for (const m of text.matchAll(new RegExp(`\\b${call}\\(`, 'g'))) {
      const open = m.index + m[0].length - 1;
      const line = text.slice(0, m.index).split('\n').length;
      const args = argumentsOf(text, open);
      if (!args) {
        problems.push(`${file}:${line} — could not read the arguments of ${call}(, so this check is blind here`);
        continue;
      }
      checked += 1;
      for (let i = 0; i < keeps; i += 1) {
        const arg = args[i] ?? '';
        if (!CONSTANT.test(arg)) {
          problems.push(
            `${file}:${line} — ${call} keeps ${what} for the life of the plugin, and argument ${i + 1} is ` +
              `\`${arg}\` rather than a constant. Anything computed there is frozen at load: on a phone the ` +
              'action sheet draws from this registration and never reads the element again (#285, #290).',
          );
        }
      }
    }
  }
}

if (checked === 0) {
  console.error('registration: no addRibbonIcon call found in plugin/src — the plugin changed and this check is blind');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('a registration that is kept was given something that can change:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nGive it a module constant, and put the state on the element `setPhase` can reach.');
  process.exit(1);
}

console.log(`registration: ${checked} call kept for the life of the plugin, and it takes constants`);
