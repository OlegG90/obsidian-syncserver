/**
 * The first run: creating the administrator (issue #480 splits the screens apart; this is one).
 */
import { bootstrap } from '../api.js';
import { alone, el, field, submits, type Navigator } from '../shell.js';

/**
 * The first run, and the only screen a fresh server has.
 *
 * It **creates** the administrator rather than changing one (D-107): there is no default here
 * to be left in place by somebody who never got round to it, which is why the wording says so
 * instead of asking for "a new password".
 *
 * **And it names it** (#123). The schema seeds the row as `admin`, which meant the login of
 * the most privileged account was the same word on every installation of this server — in the
 * schema, in the docs, and in whatever an attacker would try first. Offered rather than
 * demanded: the field arrives filled in with `admin`, because most operators will keep it and
 * a forced choice on the first screen of a fresh server is a decision nobody asked to make.
 */
export const firstRun = (nav: Navigator): void => {
  const form = el('div', { className: 'card' });
  const login = field('Name for the administrator');
  login.input.value = 'admin';
  const password = field('Choose a password for it', 'password');
  const button = el('button', { className: 'cta', textContent: 'Create it' });

  form.append(
    el('h1', { textContent: 'First run' }),
    el('p', {
      className: 'muted',
      textContent:
        'This server has no administrator yet. What you set here is what creates one — there ' +
        'is no default password, and nothing else is served until it exists.',
    }),
    login.row,
    el('p', {
      className: 'muted',
      textContent:
        'The name is yours to choose. Keeping “admin” is fine; changing it means the login of ' +
        'this server’s most privileged account is not the one everybody guesses first.',
    }),
    password.row,
    button,
  );

  submits(button, form, async () => {
    await bootstrap(login.input.value.trim(), password.input.value);
    nav.render();
  });

  alone(form);
};
