/**
 * The console: the first render, and the wiring that puts each screen where it goes.
 *
 * Every screen used to live here, until one file held them all (issue #480): the frame and
 * the DOM helpers are `shell.ts`, each screen is a module under `screens/`, and what is left
 * here is the navigator — which screen each destination draws — and the render that chooses
 * one by what the server says.
 *
 * No framework, and the reason is not taste. Almost every decision this surface could make
 * was made by the API in M4 — who may act, what a refusal means, what lowering a quota will
 * do — so what is left is reading answers and drawing them. A component library would be a
 * dependency carrying state management for a page with no state to manage.
 *
 * The screens are chosen by what the **server** says rather than by what the browser
 * remembers: `bootstrap_pending` decides the first one, and holding a token decides the
 * third. A reload is therefore never wrong, which is the cheapest correctness a web page can
 * have.
 */
import { health, restoreStatus, signedIn } from './api.js';
import { chooseScreen } from './screen.js';
import { app, attempt, setNavigator, type Navigator } from './shell.js';
import { accountsScreen } from './screens/accounts.js';
import { auditScreen } from './screens/audit.js';
import { backupsScreen } from './screens/backups.js';
import { firstRun } from './screens/first-run.js';
import { passwordScreen } from './screens/password.js';
import { problemsScreen } from './screens/problems.js';
import { restoreScreen } from './screens/restore.js';
import { signInScreen } from './screens/sign-in.js';

const render = (): void => {
  void attempt(app, async () => {
    const screen = await chooseScreen({ signedIn, restoreStatus, health });
    switch (screen) {
      case 'restore':
        restoreScreen();
        break;
      case 'accounts':
        accountsScreen();
        break;
      case 'firstRun':
        firstRun(nav);
        break;
      case 'signIn':
        signInScreen(nav);
        break;
    }
  });
};

const nav: Navigator = {
  accounts: accountsScreen,
  backups: backupsScreen,
  problems: problemsScreen,
  audit: auditScreen,
  password: () => passwordScreen(nav),
  signIn: (note) => signInScreen(nav, note),
  render,
};
setNavigator(nav);

render();
