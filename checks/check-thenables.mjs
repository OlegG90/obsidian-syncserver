/**
 * Nothing Obsidian draws is handed to a promise (#440, #442).
 *
 * Obsidian 1.14 gave `Setting` and every component a `then(cb)` that calls `cb(this)` and returns
 * `this` — a convenience for configuring one in a chain. It also made every one of them a **thenable**,
 * and a promise resolved with a thenable adopts it: it calls `then`, which hands back the same object,
 * which is adopted again. The loop never yields — it runs in the microtask queue, below anything a
 * debugger can pause — and Obsidian freezes.
 *
 * It shipped as one arrow body: `.catch(() => setting.setDesc('…'))`. `setDesc` returns the setting, so
 * the catch resolved with it. Offline, the recovery-code row of the settings tab took that path the
 * moment an unlock failed, and the whole application stopped answering until it was killed.
 *
 * A type cannot hold this rule — TypeScript checks a thenable only where something awaits it — so the
 * check reads the program: in a callback given to `then`, `catch` or `finally`, and in any `async`
 * function, nothing returned may be a value whose `then` Obsidian declares. A block body that does
 * not return the chain is the fix, and `void` in front of the call is another.
 */
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.join(root, 'plugin', 'tsconfig.json');
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();

const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);

/** Whether `then` on this type is the one Obsidian added, rather than a promise's. */
const obsidianThenable = (type) => {
  for (const t of type.isUnion() ? type.types : [type]) {
    const then = t.getProperty('then');
    if (then?.declarations?.some((d) => d.getSourceFile().fileName.includes('/node_modules/obsidian/'))) return true;
  }
  return false;
};

/** A function whose return value a promise will adopt. */
const settles = (fn) => {
  if (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) return true;
  const call = fn.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(fn) &&
    ts.isPropertyAccessExpression(call.expression) &&
    PROMISE_METHODS.has(call.expression.name.text)
  );
};

/** What a function returns, without descending into the functions inside it. */
const returned = (fn) => {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  const walk = (n) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(fn.body, walk);
  return out;
};

const problems = [];
for (const file of program.getSourceFiles()) {
  if (!file.fileName.includes('/plugin/src/')) continue;
  const visit = (n) => {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && settles(n)) {
      for (const e of returned(n)) {
        if (!obsidianThenable(checker.getTypeAtLocation(e))) continue;
        const { line } = file.getLineAndCharacterOfPosition(e.getStart());
        problems.push(`${path.relative(root, file.fileName)}:${line + 1}: ${e.getText().slice(0, 70)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
}

if (problems.length) {
  console.error('thenables: a promise would adopt something Obsidian draws, and loop on it for ever:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('Give the callback a block body, or put `void` before the call.');
  process.exit(1);
}
console.log(`thenables: ${program.getSourceFiles().filter((f) => f.fileName.includes('/plugin/src/')).length} files checked, and no promise is handed anything Obsidian draws`);
