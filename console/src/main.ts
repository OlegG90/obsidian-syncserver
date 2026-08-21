/**
 * The console: the first run, signing in, the accounts, the backups, the audit log, and the
 * restore-confirm surface.
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
import {
  accounts, audit, backups, beginDeletion, bootstrap, confirmRestore, currentLogin, deletionProgress,
  changePassword, forgetSession, health, invite, reissue, restoreStatus, revokeInvitation, runBackup, setEnabled,
  setQuota,
  signedIn, signIn, storage, verify,
  type AccountRow, type AuditRow, type BackupRun, type DeletionProgress, type StorageTotals,
} from './api.js';
import { accountBadge, accountState, accountUsage, auditAction, freezeWarning, human, mib, serverLine, usageFraction } from './format.js';
import { chooseScreen, sessionEnded, type Screen } from './screen.js';
import { whatIsWrong } from './password-form.js';

const app = document.getElementById('app') as HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

const say = (message: string, bad = false): HTMLElement =>
  el('p', { className: bad ? 'bad' : 'ok', textContent: message });

/** Every failure reaches the screen as the sentence the server sent, not as a status. */
const attempt = async (where: HTMLElement, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (e) {
    if (endedSession(e)) return;
    where.append(say(e instanceof Error ? e.message : String(e), true));
  }
};

/**
 * A session that has run out, handled as a change of screen rather than a message.
 *
 * `unauthenticated` is not something the person did; it is the console saying it no longer
 * has anything to act with. There is one thing to do about it and the sign-in screen is it,
 * so that is what happens — with the reason carried across, because arriving at a login form
 * unasked is otherwise indistinguishable from the page having crashed.
 */
const endedSession = (e: unknown): boolean => {
  if (!sessionEnded(e)) return false;
  forgetSession();
  signInScreen(
    'Your session ended. Nothing about it is written down, so a reload or a closed tab means ' +
      'signing in again — and so does an administrator revoking this console.',
  );
  return true;
};

/**
 * Fill a list that is currently saying "Loading…".
 *
 * The placeholder is a promise the screen made, and it has to be kept on both paths. The live
 * walk found the other half: an expired token put `unauthenticated` on the page and left the
 * "Loading…" underneath it, waiting for something that was never coming. A failure replaces
 * the placeholder; it does not queue up behind it.
 */
const loads = (list: HTMLElement, fill: () => Promise<void>): void => {
  void fill().catch((e: unknown) => {
    if (endedSession(e)) return;
    list.replaceChildren(say(e instanceof Error ? e.message : String(e), true));
  });
};

const field = (label: string, type = 'text'): { row: HTMLElement; input: HTMLInputElement } => {
  const input = el('input', { type });
  return { row: el('div', {}, el('label', { textContent: label }), input), input };
};

/**
 * A button that does one thing and cannot be asked to do it twice at once.
 *
 * All three screens are the same shape — disable, call the API, put whatever it refused with
 * on the card, enable again — and each wrote it out. The disabling is the part that matters:
 * every act behind these buttons is once-only on the server (the first password, an
 * invitation), so a second click while the first is in flight asks for a refusal the person
 * did not earn.
 */
const submits = (button: HTMLButtonElement, card: HTMLElement, run: () => Promise<void>): void => {
  button.onclick = (): void => {
    button.disabled = true;
    void attempt(card, run).finally(() => (button.disabled = false));
  };
};

/**
 * Where the sidebar says you are — or `'none'`, for a screen that is not a destination.
 *
 * Changing a password is reached from the sidebar and is not one of the three places this
 * console holds; marking Accounts as current while showing a password form would be the
 * navigation telling a small lie about where the reader is.
 */
type Where = 'accounts' | 'backups' | 'audit' | 'none';

/**
 * The frame every signed-in screen sits in: where you are, and who you are (#123).
 *
 * A sidebar rather than a row of buttons above the heading, for the reason the mockups give
 * and a stack of cards made obvious: the navigation was competing with the content for the
 * top of the page, so the first thing a person read was three destinations rather than the
 * thing they had opened.
 *
 * **`#app` is the `<main>`**; the nav is its sibling, created once and reused. Redrawing the
 * navigation on every screen change would make the current-page marker flicker on the one
 * element whose job is to not move.
 *
 * The screens that are not part of the shell — the first run, signing in, a pending restore —
 * take it away entirely. Each is the only thing the server will talk about at that moment, and
 * a sidebar offering three destinations that all answer `restore_pending` is an offer the
 * server will refuse.
 */

let side: HTMLElement | undefined;

/**
 * The server's version, once it has been asked for.
 *
 * `undefined` means "not asked yet", `null` means "asked, and this server is old enough not to
 * report one" — two different states that a single optional string would have flattened into
 * one, leaving the console asking a server that had already answered.
 */
let serverVersion: string | null | undefined;

const shell = (current: Where, login: string, ...content: Node[]): void => {
  side ??= el('nav', { className: 'side' });
  app.before(side);
  side.replaceChildren(el('div', { className: 'brand', textContent: 'SyncServer' }));

  const destinations: [Where, string, () => void][] = [
    ['accounts', 'Accounts', accountsScreen],
    ['backups', 'Backups', backupsScreen],
    ['audit', 'Audit log', auditScreen],
  ];
  for (const [key, label, go] of destinations) {
    const b = el('button', { textContent: label });
    if (key === current) b.setAttribute('aria-current', 'page');
    b.onclick = go;
    side.append(b);
  }

  // Who, and the way out. `forgetSession` has existed since M4 with nothing calling it (#123):
  // a console that can be signed into and not out of leaves a session on a shared machine with
  // no way to end it but closing the tab and hoping.
  const who = el('div', { className: 'who' });
  who.append(el('div', { className: 'muted', textContent: `Signed in as ${login}` }));
  const out = el('button', { className: 'link', textContent: 'Sign out' });
  out.onclick = (): void => {
    forgetSession();
    side?.remove();
    signInScreen();
  };
  who.append(out);

  // Beside the way out, because both are about the person using the console rather than the
  // accounts it manages — and because there was no way to do this at all until #137.
  const change = el('button', { className: 'link', textContent: 'Change password' });
  change.onclick = passwordScreen;
  who.append(change);

  // Which server this is, under the way out (#135). Asked once per page load and remembered:
  // `/health` answers before authentication, and the version does not change under a running
  // console — an image is replaced by restarting the container, which ends this session anyway.
  const line = el('div', { className: 'muted version', textContent: serverLine(serverVersion, serverVersion !== undefined) });
  who.append(line);
  if (serverVersion === undefined) {
    void health()
      .then((h) => {
        serverVersion = h.version ?? null;
        line.textContent = serverLine(serverVersion);
      })
      .catch(() => (line.textContent = serverLine(undefined, false)));
  }
  side.append(who);

  app.replaceChildren(...content);
};

/** A screen with nothing else on it: the first run, signing in, a halt nobody can leave yet. */
const alone = (...content: Node[]): void => {
  side?.remove();
  app.replaceChildren(el('div', { className: 'centred' }, ...content));
};

/**
 * The first run, and the only screen a fresh server has.
 *
 * It **creates** the administrator rather than changing one (#107): there is no default here
 * to be left in place by somebody who never got round to it, which is why the wording says so
 * instead of asking for "a new password".
 *
 * **And it names it** (#123). The schema seeds the row as `admin`, which meant the login of
 * the most privileged account was the same word on every installation of this server — in the
 * schema, in the docs, and in whatever an attacker would try first. Offered rather than
 * demanded: the field arrives filled in with `admin`, because most operators will keep it and
 * a forced choice on the first screen of a fresh server is a decision nobody asked to make.
 */
const firstRun = (): void => {
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
    render();
  });

  alone(form);
};

const signInScreen = (note?: string): void => {
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
    render();
  });

  alone(form);
};

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
const passwordScreen = (): void => {
  const card = el('div', { className: 'card' });
  const current = field('Current password', 'password');
  const next = field('New password', 'password');
  const again = field('New password again', 'password');
  const button = el('button', { className: 'cta', textContent: 'Change it' });
  const back = el('button', { className: 'link', textContent: 'Cancel' });
  back.onclick = accountsScreen;

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
    forgetSession();
    side?.remove();
    signInScreen('Password changed. Sign in with the new one.');
  });

  shell('none', currentLogin(), card);
};

/**
 * One account, as a card (#123).
 *
 * A row of a table said everything in the same weight; a card gives the login the top line and
 * the storage a **bar**, which is the point of the redesign. "9.1 GiB of 7.5 GiB" needs
 * arithmetic to read as trouble; a full red bar does not.
 *
 * The actions live on the card and open under it, so a decision about one account never
 * appears next to a different one.
 */
const accountCard = (a: AccountRow, done: () => Promise<void>, report: Report): HTMLElement => {
  const card = el('div', { className: 'card' });
  const badge = accountBadge(a);
  const top = el(
    'div',
    { className: 'top' },
    el('span', { className: 'login', textContent: a.login }),
    el('span', { className: `badge is-${badge.tone}`, textContent: badge.text }),
  );
  const acts = el('div', { className: 'acts' });
  top.append(acts);
  card.append(top);

  // Where an action draws its form. One at a time per card, and empty means nothing is open.
  const drawer = el('div', {});
  const opens = (build: () => HTMLElement) => (): void => {
    // A second press on the same action closes it: an operator who opened a form to look at it
    // needs a way back that is not filling it in.
    if (drawer.firstChild) return drawer.replaceChildren();
    drawer.replaceChildren(el('div', { className: 'drawer' }, build()));
  };

  const storing = a.role !== 'admin' && a.state !== 'provisioned';
  if (storing) {
    const over = a.frozenAt !== null;
    const bar = el('div', { className: over ? 'bar over' : 'bar' });
    const fill = el('span', {});
    fill.style.width = `${(usageFraction(a) * 100).toFixed(1)}%`;
    bar.append(fill);
    const line = el('div', { className: 'usage' }, el('span', { textContent: accountUsage(a) }));
    if (over) line.append(el('span', { className: 'right bad', textContent: 'over its limit' }));
    card.append(bar, line);
  } else {
    // Said rather than left blank, because "no bar" and "a bar at zero" mean different things
    // and only one of them is true here (#115).
    card.append(
      el('div', {
        className: 'muted',
        textContent: a.state === 'provisioned' ? accountState(a) : 'holds no key, no vault',
      }),
    );
  }

  const act = (label: string, onClick: () => void, danger = false): void => {
    const b = el('button', { className: danger ? 'row danger' : 'row', textContent: label });
    b.onclick = onClick;
    acts.append(b);
  };

  if (a.state === 'provisioned') {
    // An invitation nobody claimed: the two things an operator actually does with one. The
    // token is shown once and never stored, so reissuing is the only answer to a lost one.
    act('Reissue', opens(() => reissueForm(a, done)));
    act(
      'Revoke',
      opens(() =>
        confirmForm(
          `Withdraw the invitation for ${a.login}? The token stops working and the account is never created.`,
          'Revoke',
          async () => {
            await revokeInvitation(a.id);
            report(`The invitation for ${a.login} was withdrawn.`);
            await done();
          },
        ),
      ),
      true,
    );
  } else if (a.state === 'deleting') {
    // An account being taken apart has one thing left that can be done to it. Offering to
    // change the limit of something that is being removed is offering an act with no future,
    // and the operator would be right to wonder which of the two they had misunderstood.
    act('Deletion…', opens(() => deletionForm(a, done, report)), true);
  } else if (a.role !== 'admin') {
    act('Change quota', opens(() => quotaControl(a, done, report, () => drawer.replaceChildren())));
    act(a.state === 'disabled' ? 'Enable' : 'Disable', opens(() => enableForm(a, done, report)));
    act('Delete…', opens(() => deletionForm(a, done, report)), true);
  }

  card.append(drawer);
  return card;
};

/** A fresh token for an invitation nobody redeemed — shown once here, exactly as the first was. */
const reissueForm = (a: AccountRow, done: () => Promise<void>): HTMLElement => {
  const box = el('div', {});
  const go = el('button', { textContent: 'Reissue the token' });
  box.append(
    el('p', {
      className: 'muted',
      textContent: `A new token for ${a.login}. The old one stops working, and this one is shown once.`,
    }),
    go,
  );
  submits(go, box, async () => {
    const out = await reissue(a.id);
    box.append(say(`Token: ${out.token}`));
    await done();
  });
  return box;
};

/**
 * Switch an account off, or back on — the reversible neighbour of deletion.
 *
 * Worth its own sentence because the two are confused constantly: disabling stops the account
 * working and keeps everything, and it is undone by pressing the other one.
 */
const enableForm = (a: AccountRow, done: () => Promise<void>, report: Report): HTMLElement => {
  const off = a.state !== 'disabled';
  return confirmForm(
    off
      ? `Disable ${a.login}? Its devices stop syncing at once and every file is kept, here and on their machines. You can enable it again.`
      : `Enable ${a.login} again? Its devices resume syncing on their next attempt.`,
    off ? 'Disable' : 'Enable',
    async () => {
      await setEnabled(a.id, !off);
      report(`${a.login} is now ${off ? 'disabled' : 'active'}.`);
      await done();
    },
  );
};

/**
 * Deleting an account, which is a **procedure and not a button** (#55).
 *
 * It dissolves the shares this account started and then waits: only each participant's own
 * client holds the key to convert their copy back to private files, so the server cannot
 * finish on their behalf. That wait is why this draws a progress surface rather than a
 * dialogue that closes and claims success.
 *
 * **Two states, and each offers only what exists in it.** Both buttons used to be on screen
 * from the start, so "Check again" sat there before anything had begun — an offer to look at
 * a procedure that did not exist. Pressed, it would have said "Deletion is active", because
 * `GET …/deletion` answers with the account's state and an account nobody is deleting is
 * simply active. A control whose honest answer is nonsense should not be on the screen yet.
 *
 * So: before, a warning and one way forward. After, the progress and the two acts that now
 * mean something — carry on, or look without moving it. `POST` advances and `GET` only looks,
 * deliberately, since a poll that pushed the state would make watching a deletion
 * indistinguishable from driving one.
 *
 * An account already in `deleting` when the console opens goes straight to the progress: the
 * operator who comes back the next day has already agreed, and asking them again would be
 * asking about a decision that has been taken.
 *
 * The confirmation leads with the half that surprises people — deleting one account ends
 * shared folders for everybody in them — and says what survives: the audit log keeps naming
 * this account, by design (#93), since a history that forgets who did what is worse than one
 * naming somebody who has gone.
 */
const deletionForm = (a: AccountRow, done: () => Promise<void>, report: Report): HTMLElement => {
  const box = el('div', {});
  const body = el('div', {});
  box.append(body);

  const underway = (p: DeletionProgress): void => {
    if (p.finished) {
      body.replaceChildren(say(`${a.login} and everything it held are gone.`));
      return;
    }

    // Said as a sentence, not as the enum. `state` is a column value — "Deletion of marta is
    // deleting" is what interpolating it produces, and it reads like a machine talking to
    // itself. An unfamiliar state still gets shown under its own name, for the audit log's
    // reason: a surface that hides what it does not recognise is worse than a clumsy one.
    const lines: HTMLElement[] = [
      el('p', {
        textContent: p.state === 'deleting' ? `${a.login} is being deleted.` : `${a.login} is ${p.state}.`,
      }),
    ];
    if (p.awaiting.length === 0) {
      lines.push(el('p', { className: 'muted', textContent: 'Nothing is outstanding. Carry on to finish it.' }));
    } else {
      // Named, not counted. "Waiting on 3" is a number somebody can do nothing with; a list of
      // logins is a list of people to ask.
      lines.push(
        el('p', {
          className: 'muted',
          textContent: 'Waiting for these people to finish converting their copy of a shared folder:',
        }),
        el('ul', {}, ...p.awaiting.map((w) => el('li', { textContent: w.login }))),
      );
    }

    const carry = el('button', { className: 'danger', textContent: 'Carry on' });
    const look = el('button', { textContent: 'Check again' });
    lines.push(carry, look);
    body.replaceChildren(...lines);

    submits(carry, body, async () => {
      const next = await beginDeletion(a.id);
      underway(next);
      if (next.finished) report(`${a.login} was deleted.`);
      await done();
    });
    submits(look, body, async () => underway(await deletionProgress(a.id)));
  };

  // Already begun — by a previous session, or by this one before a reload.
  if (a.state === 'deleting') {
    body.replaceChildren(el('p', { className: 'muted', textContent: 'Reading where it got to…' }));
    void attempt(body, async () => underway(await deletionProgress(a.id)));
    return box;
  }

  const start = el('button', { className: 'danger', textContent: 'Delete this account' });
  body.replaceChildren(
    el('p', {
      className: 'bad',
      textContent:
        `Delete ${a.login}? This cannot be undone. Every vault it owns is removed, and any folder ` +
        'it shared is ended for everybody in it — their copies stay, and stop receiving.',
    }),
    el('p', {
      className: 'muted',
      textContent:
        'The audit log keeps naming this account afterwards, deliberately: a history that forgets ' +
        'who did what is worse than one naming somebody who is gone.',
    }),
    start,
  );

  submits(start, body, async () => {
    const p = await beginDeletion(a.id);
    underway(p);
    report(p.finished ? `${a.login} was deleted.` : `Deletion of ${a.login} has begun.`, !p.finished);
    await done();
  });
  return box;
};

/** A sentence, a verb, and the act — the shape every irreversible answer on this screen takes. */
const confirmForm = (question: string, verb: string, run: () => Promise<void>): HTMLElement => {
  const box = el('div', {});
  const go = el('button', { className: 'danger', textContent: verb });
  box.append(el('p', { textContent: question }), go);
  submits(go, box, run);
  return box;
};

/**
 * The totals only the server can count (#123).
 *
 * `GET /admin/storage` exists and was never called. **Stored and charged are different
 * numbers**: a blob two accounts reference is stored once and charged twice, so a console
 * summing its own rows could produce one of them and would be quietly reporting the other.
 */
const tiles = (rows: readonly AccountRow[], totals: StorageTotals): HTMLElement => {
  const saved = Number(totals.chargedBytes) - Number(totals.storedBytes);
  const shown: [string, string][] = [
    ['Accounts', String(rows.filter((a) => a.state !== 'provisioned').length)],
    ['On disk', human(totals.storedBytes)],
    ['Frozen', String(rows.filter((a) => a.frozenAt).length)],
    ['Pending invites', String(rows.filter((a) => a.state === 'provisioned').length)],
  ];
  // Only when there is something to say: on a fresh server the answer is zero, and a tile
  // reading "0 B saved" is a fact nobody asked for.
  if (saved > 0) shown.push(['Saved by dedup', human(String(saved))]);
  if (Number(totals.quarantined) > 0) shown.push(['Quarantined', totals.quarantined]);

  return el(
    'div',
    { className: 'tiles' },
    ...shown.map(([label, value]) =>
      el(
        'div',
        { className: 'tile' },
        el('div', { className: 'label', textContent: label }),
        el('div', { className: 'value', textContent: value }),
      ),
    ),
  );
};

/**
 * Where an outcome goes so that it survives being acted upon.
 *
 * The result of changing a quota used to be appended to the account's own card, and the
 * refresh that follows the change replaces every card in the list — so the sentence rendered
 * and vanished in the same instant. A live walk caught it: "a green message flashes and
 * disappears, I cannot read it". Anything a person is meant to READ has to be written
 * somewhere the reload does not own.
 */
type Report = (message: string, bad?: boolean) => void;

/**
 * Change one account's limit, explaining a freeze **before** applying it.
 *
 * Two presses when it would freeze them, one when it would not. The confirmation is not
 * ceremony: an operator lowering a limit usually expects the account to be trimmed, and what
 * actually happens is that nothing is deleted and writes stop — which is a different thing to
 * have decided (SH-20). The sentence is `freezeWarning`'s, so what is shown and what is tested
 * are the same string.
 */
const quotaControl = (
  a: AccountRow,
  done: () => Promise<void>,
  report: Report,
  /** Shut the drawer. A person who opened an editor to look must be able to leave without acting. */
  close: () => void,
): HTMLElement => {
  const box = el('div', {});
  const quota = field('Quota in MiB');
  quota.input.value = String(Math.round(Number(a.quotaBytes) / (1024 * 1024)));
  const save = el('button', { textContent: 'Save' });
  box.append(quota.row, save);

  const apply = async (): Promise<void> => {
    const bytes = String(Math.round(Number(quota.input.value) * 1024 * 1024));
    const out = await setQuota(a.id, bytes);
    // Reported before the refresh and OUTSIDE the list, because `done()` replaces every card
    // — including the one this control is drawn in.
    report(
      out.freezes
        ? `${a.login} now stores more than its limit and is frozen; deleting is the way out.`
        : `${a.login} may now store ${mib(bytes)}.`,
      out.freezes,
    );
    await done();
  };

  const cancel = el('button', { className: 'link', textContent: 'Cancel' });
  cancel.onclick = close;
  box.append(cancel);

  submits(save, box, async () => {
    const bytes = String(Math.round(Number(quota.input.value) * 1024 * 1024));
    const warning = freezeWarning(bytes, a.usedBytes);
    if (!warning) return apply();

    // Said once, and replaced by the act rather than stacking: pressing Save twice with the
    // same number should not grow a column of identical warnings.
    save.remove();
    const anyway = el('button', { textContent: 'Lower it anyway' });
    box.append(say(warning, true), anyway);
    submits(anyway, box, apply);
  });

  return box;
};

const accountsScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Accounts' }));
  // Outcomes live here rather than in the cards, because the cards are replaced by the very
  // refresh that follows an act. One line at a time: the last thing done is the thing worth
  // reading, and a column of them is a log nobody asked this screen for.
  const notices = el('div', {});
  const report: Report = (message, bad = false) => notices.replaceChildren(say(message, bad));
  const list = el('div', {}, el('p', { className: 'muted', textContent: 'Loading…' }));

  /**
   * Inviting somebody, folded away until it is wanted (#123).
   *
   * It was a form standing open under every list of accounts — two fields and a button, always
   * there, on the screen an operator opens to LOOK at who exists. Inviting is the rare act and
   * reading the list is the ordinary one, and the page was laid out the other way round.
   *
   * A link rather than a modal: the form belongs to this screen, and it lands where the link
   * was, so pressing it moves nothing that was already on the page.
   */
  const inviteCard = el('div', {});
  const open = el('button', { className: 'link', textContent: '+ Invite somebody' });
  inviteCard.append(open);

  open.onclick = (): void => {
    const form = el('div', { className: 'card' });
    const login = field('Login for the new account');
    const quota = field('Quota in MiB');
    const button = el('button', { className: 'cta', textContent: 'Invite' });
    const cancel = el('button', { textContent: 'Cancel' });
    cancel.onclick = (): void => inviteCard.replaceChildren(open);

    form.append(
      el('p', {
        className: 'muted',
        textContent:
          'They redeem this in Obsidian, where their keys are made. The token appears once and ' +
          'is not stored — reissue if it is lost.',
      }),
      login.row,
      quota.row,
      button,
      cancel,
    );
    inviteCard.replaceChildren(form);
    login.input.focus();

    submits(button, form, async () => {
      const bytes = String(Math.round(Number(quota.input.value) * 1024 * 1024));
      const out = await invite(login.input.value, bytes);
      // The token stays where it was produced, and the form stays open behind it: this is the
      // one value in the console that is shown once and never again, so a screen that tidied
      // itself away on success would take it with it.
      form.append(say(`Invitation for ${login.input.value}. Token: ${out.token}`));
      await fill();
    });
  };

  const fill = async (): Promise<void> => {
    // Both, together: the tiles describe the same moment the cards do, and two fetches drawn as
    // they arrived would show an account that the totals had not counted yet.
    const [out, totals] = await Promise.all([accounts(), storage()]);
    list.replaceChildren(tiles(out.accounts, totals), ...out.accounts.map((a) => accountCard(a, fill, report)));
  };

  shell('accounts', currentLogin(), page, notices, list, inviteCard);
  loads(list, fill);
};

/**
 * The audit log, newest first (#87, #94).
 *
 * Read-only, and there is nothing here that could make it otherwise: the table refuses updates
 * and deletes at the schema level, so this screen has no button because there is no act. What
 * it shows is the answer to "who did what to whom", which is the whole reason a log with no
 * foreign keys keeps snapshot logins (#93) — an entry naming an account that has since been
 * deleted is still the answer.
 *
 * **Nothing here reaches a vault's contents.** A console account holds no key (#115); the log
 * records administrative acts, and administrative acts never touch a note.
 */
const auditScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Audit log' }));
  const list = el('div', {}, el('p', { className: 'muted', textContent: 'Loading…' }));


  const fill = async (): Promise<void> => {
    const out = await audit();
    list.replaceChildren(
      out.entries.length === 0
        ? el('p', { className: 'muted', textContent: 'Nothing has been done to an account yet.' })
        : auditLog(out.entries),
    );
  };

  shell('audit', currentLogin(), page, list);
  loads(list, fill);
};

/**
 * The audit log: one line each, the time in a column of its own (#123).
 *
 * A card per entry read well at seven and stopped reading at seventy — five near-identical
 * acts seconds apart became five paragraphs to compare word by word. What a person scans a log
 * for is one actor, one target, one action, and a sentence buries each in a different place.
 *
 * The action is bold and the rest is not, because the action is what the eye is looking for
 * and the actor is what it checks once it has found one.
 *
 * Newest first, which is the server order (#87, #94) and not this screen to choose.
 */
const auditLog = (entries: readonly AuditRow[]): HTMLElement => {
  const list = el('div', { className: 'log' });
  for (const e of entries) {
    const line = el('div', { className: 'entry' });
    line.append(el('strong', { textContent: auditAction(e) }));
    // The target belongs to the action and reads as part of it; the actor is a separate fact.
    if (e.targetLogin) line.append(el('span', { textContent: `— ${e.targetLogin}` }));
    line.append(el('span', { className: 'muted', textContent: `by ${e.actorLogin}` }));
    line.append(el('span', { className: 'when', textContent: when(e.at) }));
    list.append(line);
  }
  return list;
};

/** When a run happened, as a person reads a table. */
const when = (iso: string | null): string =>
  iso === null ? '—' : new Date(iso).toLocaleString();

const backupRow = (b: BackupRun): HTMLElement => {
  const card = el('div', { className: 'card' });
  card.append(
    el('strong', { textContent: `${b.status} — ${when(b.startedAt)}` }),
    el('div', { className: 'muted', textContent: `${mib(b.bytes)}, ${b.blobCount ?? '—'} blobs` }),
  );
  if (b.error) card.append(el('p', { className: 'bad', textContent: b.error }));
  if (b.verifiedAt) card.append(el('div', { className: 'muted', textContent: `verified ${when(b.verifiedAt)}` }));
  if (b.status === 'ok') card.append(verifyButton(b));
  return card;
};

const verifyButton = (run: BackupRun): HTMLElement => {
  const button = el('button', { textContent: 'Verify' });
  const where = el('div', {});
  submits(button, where, async () => {
    const out = await verify(run.id);
    where.append(
      out.whole
        ? say(`whole: all ${out.checked} blobs present`)
        : say(`${out.missing.length} of ${out.checked} blobs missing from the copy`, true),
    );
    // Refresh the list so `verified` appears.
    void attempt(where, async () => {
      const fresh = await backups();
      const row = fresh.backups.find((x) => x.id === run.id);
      if (row?.verifiedAt) where.append(say(`verified ${when(row.verifiedAt)}`));
    });
  });
  return el('div', {}, button, where);
};

const backupsScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Backups' }));
  const list = el('div', {}, el('p', { className: 'muted', textContent: 'Loading…' }));

  const runCard = el('div', { className: 'card' });
  const runButton = el('button', { textContent: 'Back up now' });
  runCard.append(
    el('h1', { textContent: 'Take a backup' }),
    el('p', {
      className: 'muted',
      textContent:
        'The database is dumped first, then the blobs are copied — the order that makes the ' +
        'copy a whole thing (docs/08). Downloads are deliberately not a feature: the copy ' +
        'goes to its configured destination.',
    }),
    runButton,
  );
  submits(runButton, runCard, async () => {
    const out = await runBackup();
    runCard.append(say(out.status === 'ok' ? 'Backup taken.' : `Backup: ${out.status}`));
    await fill();
  });

  const fill = async (): Promise<void> => {
    const out = await backups();
    list.replaceChildren(...out.backups.map(backupRow));
  };

  shell('backups', currentLogin(), page, list, runCard);
  loads(list, fill);
};

const restoreScreen = (): void => {
  const page = el('div', { className: 'card' });
  const status = el('div', {}, el('p', { className: 'muted', textContent: 'Checking…' }));
  const button = el('button', { textContent: 'Confirm the restore' });

  page.append(
    el('h1', { textContent: 'Restore pending' }),
    el('p', {
      className: 'muted',
      textContent:
        'This database is older than this server has ever run with — a restore happened and was ' +
        'not confirmed. Until you confirm, every client is refused, because the alternative is ' +
        'silent divergence: revision numbers reused, and files missing weeks later.',
    }),
    status,
  );

  const fill = async (): Promise<void> => {
    const s = await restoreStatus();
    status.replaceChildren(
      el('p', { textContent: `database epoch ${s.dbEpoch}, server has run with ${s.fileEpoch ?? '—'}` }),
    );
    page.append(button);
  };

  submits(button, page, async () => {
    const out = await confirmRestore();
    button.remove();
    page.append(
      el('p', { className: 'ok', textContent: `Confirmed. The restore epoch is now ${out.epoch}.` }),
      el('h2', { textContent: 'After the restore' }),
      el('ul', {},
        ...afterRestore.map((step) => el('li', { textContent: step })),
      ),
    );
  });

  alone(page);
  loads(status, fill);
};

/**
 * What follows a confirmed restore (docs/08). The confirmation is the machine's act — it
 * raised the epoch so every client resyncs — and the rest is what only the administrator
 * can decide: which copy was restored, and who to tell that the resync is not a fault.
 */
const afterRestore = [
  'Every client will resync on its next pass — a long synchronisation is expected, not a fault.',
  'Verify the restored copy against the blobs, and note any files the copy could not restore.',
  'Tell anyone who uses this server that the restore happened, so the resync does not read as data loss.',
];

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
        firstRun();
        break;
      case 'signIn':
        signInScreen();
        break;
    }
  });
};

render();
