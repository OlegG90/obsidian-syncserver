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
import { accounts, audit, backups, bootstrap, confirmRestore, forgetSession, health, invite, restoreStatus, runBackup, setQuota, signedIn, signIn, verify, type AccountRow, type AuditRow, type BackupRun } from './api.js';
import { accountKind, accountState, accountUsage, auditAction, freezeWarning, mib } from './format.js';
import { chooseScreen, sessionEnded, type Screen } from './screen.js';

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
 * The first run, and the only screen a fresh server has.
 *
 * It **creates** a password rather than changing one (#107): there is no default here to be
 * left in place by somebody who never got round to it, which is why the wording says so
 * instead of asking for "a new password".
 */
const firstRun = (): void => {
  const form = el('div', { className: 'card' });
  const password = field('Choose a password for the administrator', 'password');
  const button = el('button', { textContent: 'Set it' });

  form.append(
    el('h1', { textContent: 'First run' }),
    el('p', {
      className: 'muted',
      textContent:
        'This server has no administrator yet. Setting this password is what creates one — ' +
        'there is no default, and nothing else is served until it exists.',
    }),
    password.row,
    button,
  );

  submits(button, form, async () => {
    await bootstrap(password.input.value);
    render();
  });

  app.replaceChildren(form);
};

const signInScreen = (note?: string): void => {
  const form = el('div', { className: 'card' });
  const login = field('Login');
  const password = field('Password', 'password');
  const button = el('button', { textContent: 'Sign in' });

  form.append(el('h1', { textContent: 'SyncServer' }));
  if (note) form.append(el('p', { className: 'muted', textContent: note }));
  form.append(login.row, password.row, button);

  submits(button, form, async () => {
    await signIn(login.input.value, password.input.value);
    render();
  });

  app.replaceChildren(form);
};

/**
 * The accounts, as a table (#123).
 *
 * A card each was readable at three accounts and stopped being readable at thirty: every row
 * carried a quota field and a Save button whether or not anybody was changing that account,
 * so a screen for **looking** at who exists was mostly a stack of forms for changing them.
 * Scanning is the ordinary act here; editing is the rare one, and the layout had them the
 * other way round.
 *
 * So the columns are what an operator scans for — who, what kind, how it stands, what it is
 * storing — and the act is a link that opens an editor under the row it belongs to. One at a
 * time, because two open editors are two half-finished decisions.
 */
const accountsTable = (rows: readonly AccountRow[], done: () => Promise<void>, report: Report): HTMLElement => {
  const table = el('table', { className: 'rows' });
  const head = el('tr', {});
  for (const h of ['Login', 'Kind', 'State', 'Storing', '']) head.append(el('th', { textContent: h }));
  table.append(el('thead', {}, head));

  const body = el('tbody', {});
  for (const a of rows) {
    const row = el('tr', {});
    row.append(
      el('td', {}, el('strong', { textContent: a.login })),
      el('td', { className: 'muted', textContent: accountKind(a) }),
      el('td', { className: 'muted', textContent: accountState(a) }),
      el('td', { className: a.frozenAt ? 'bad' : 'muted', textContent: accountUsage(a) }),
    );

    const act = el('td', {});
    row.append(act);
    body.append(row);

    // A console account holds no key and owns no vault (#115), so it has no quota to change —
    // and an invitation is not an account yet. Neither gets the control, rather than getting
    // one that refuses.
    if (a.role === 'admin' || a.state === 'provisioned') continue;

    // The editor lives in a row of its own, spanning the table, so opening it moves nothing
    // sideways and the account it belongs to stays directly above it.
    const drawer = el('tr', { className: 'drawer' });
    const cell = el('td', {});
    cell.colSpan = 5;
    drawer.append(cell);
    drawer.hidden = true;
    body.append(drawer);

    const open = el('button', { className: 'link', textContent: 'Quota…' });
    open.onclick = (): void => {
      // One at a time: another row's open editor is a decision somebody started and left, and
      // two of them on screen invite finishing the wrong one.
      body.querySelectorAll('tr.drawer').forEach((other) => ((other as HTMLElement).hidden = true));
      cell.replaceChildren(quotaControl(a, done, report, () => (drawer.hidden = true)));
      drawer.hidden = false;
    };
    act.append(open);
  }

  table.append(body);
  return table;
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

  const inviteCard = el('div', { className: 'card' });
  const login = field('Login for the new account');
  const quota = field('Quota in MiB');
  const button = el('button', { textContent: 'Invite' });
  inviteCard.append(
    el('h1', { textContent: 'Invite somebody' }),
    el('p', {
      className: 'muted',
      textContent:
        'They redeem this in Obsidian, where their keys are made. The token appears once and ' +
        'is not stored — reissue if it is lost.',
    }),
    login.row,
    quota.row,
    button,
  );

  submits(button, inviteCard, async () => {
    const bytes = String(Math.round(Number(quota.input.value) * 1024 * 1024));
    const out = await invite(login.input.value, bytes);
    inviteCard.append(say(`Invitation for ${login.input.value}. Token: ${out.token}`));
    await fill();
  });

  const fill = async (): Promise<void> => {
    const out = await accounts();
    list.replaceChildren(accountsTable(out.accounts, fill, report));
  };

  const toBackups = el('button', { textContent: 'Backups' });
  toBackups.onclick = () => backupsScreen();
  const toAudit = el('button', { textContent: 'Audit log' });
  toAudit.onclick = () => auditScreen();

  app.replaceChildren(el('nav', {}, toBackups, toAudit), page, notices, list, inviteCard);
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

  const back = el('button', { textContent: 'Accounts' });
  back.onclick = () => accountsScreen();

  const fill = async (): Promise<void> => {
    const out = await audit();
    list.replaceChildren(
      out.entries.length === 0
        ? el('p', { className: 'muted', textContent: 'Nothing has been done to an account yet.' })
        : auditTable(out.entries),
    );
  };

  app.replaceChildren(el('nav', {}, back), page, list);
  loads(list, fill);
};

/**
 * The audit log, as a table (#123).
 *
 * A sentence per row — "quota changed — oleh, by admin" — read well at seven entries and
 * stopped reading at seventy: five near-identical acts seconds apart became five paragraphs a
 * person had to compare word by word. The parts somebody scans a log for are one actor, one
 * target, one action, and a sentence buries each of them in a different position.
 *
 * Newest first, which is the server's order (#87, #94) and not this screen's to choose.
 */
const auditTable = (entries: readonly AuditRow[]): HTMLElement => {
  const table = el('table', { className: 'rows' });
  const head = el('tr', {});
  for (const h of ['When', 'Action', 'Account', 'By']) head.append(el('th', { textContent: h }));
  table.append(el('thead', {}, head));

  const body = el('tbody', {});
  for (const e of entries) {
    body.append(
      el(
        'tr',
        {},
        el('td', { className: 'muted', textContent: when(e.at) }),
        el('td', {}, el('strong', { textContent: auditAction(e) })),
        // A dash rather than a blank: some acts have no target — confirming a restore is done
        // to the server, not to somebody — and an empty cell reads as missing data.
        el('td', { textContent: e.targetLogin ?? '—' }),
        el('td', { className: 'muted', textContent: e.actorLogin }),
      ),
    );
  }
  table.append(body);
  return table;
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

  const accountsCard = el('button', { textContent: 'Accounts' });
  accountsCard.onclick = () => accountsScreen();

  app.replaceChildren(el('nav', {}, accountsCard), page, list, runCard);
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

  app.replaceChildren(page);
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
