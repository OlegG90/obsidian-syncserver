/**
 * Changing this console account's password (issue #480 splits the screens apart; this is one).
 */
import { changePassword } from '../api.js';
import { whatIsWrong } from '../password-form.js';
import { el, shell, field, signOut, submits, type Navigator } from '../shell.js';

/**
 * Changing the password of the console account you are signed in as (#137).
 *
 * **Asked for twice, and the reason is not the one the plugin's form gives.** There a typo
 * creates keys nobody can derive again; here it locks a door that has no other key —
 * `/auth/bootstrap` creates the FIRST password and refuses once one exists, so there is
 * nobody who can put a new one back. Different cause, same finality.
 *
 * It ends with a sign-in screen rather than returning to the accounts, because the server has
 * just cleared this session's refresh token. That is deliberate on both sides: one console
 * device per account means anybody else holding that token is signed out too, which is the
 * case a password gets changed for.
 */
export const passwordScreen = (nav: Navigator): void => {
  const card = el('div', { className: 'card' });
  const current = field('Current password', 'password');
  const next = field('New password', 'password');
  const again = field('New password again', 'password');
  const button = el('button', { className: 'cta', textContent: 'Change it' });
  const back = el('button', { className: 'link', textContent: 'Cancel' });
  back.onclick = (): void => nav.accounts();

  card.append(
    el('h2', { textContent: 'Change your console password' }),
    el('p', {
      className: 'muted',
      textContent:
        'Nobody can reset this password, including you: the first-run screen refuses once a password ' +
        'exists. It is asked twice for that reason. Changing it signs this console out — and anyone ' +
        'else signed in with the old one.',
    }),
    current.row,
    next.row,
    again.row,
    button,
    back,
  );

  submits(button, card, async () => {
    const wrong = whatIsWrong({ current: current.input.value, next: next.input.value, again: again.input.value });
    // Thrown rather than shown here: `submits` already owns where a failure is drawn, and a
    // second place that draws them is a second wording of the same refusal.
    if (wrong) throw new Error(wrong);

    await changePassword(current.input.value, next.input.value);
    signOut('Password changed. Sign in with the new one.');
  });

  shell('none', card);
};
