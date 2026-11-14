/**
 * Signing in (issue #480 splits the screens apart; this is one).
 */
import { signIn } from '../api.js';
import { alone, el, field, submits, type Navigator } from '../shell.js';

export const signInScreen = (nav: Navigator, note?: string): void => {
  const form = el('div', { className: 'card' });
  const login = field('Login');
  const password = field('Password', 'password');
  const button = el('button', { textContent: 'Sign in' });

  button.className = 'cta';
  form.append(el('h1', { textContent: 'SyncServer' }));
  if (note) form.append(el('p', { className: 'muted', textContent: note }));
  form.append(login.row, password.row, button);

  submits(button, form, async () => {
    await signIn(login.input.value, password.input.value);
    nav.render();
  });

  alone(form);
};
