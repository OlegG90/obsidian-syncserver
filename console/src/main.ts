/**
 * The console, as three screens: the first run, signing in, and the accounts.
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
import { accounts, backups, bootstrap, confirmRestore, health, invite, restoreStatus, runBackup, signedIn, signIn, verify, type AccountRow, type BackupRun } from './api.js';
import { describeAccount } from './format.js';

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
    where.append(say(e instanceof Error ? e.message : String(e), true));
  }
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

const signInScreen = (): void => {
  const form = el('div', { className: 'card' });
  const login = field('Login');
  const password = field('Password', 'password');
  const button = el('button', { textContent: 'Sign in' });

  form.append(el('h1', { textContent: 'SyncServer' }), login.row, password.row, button);

  submits(button, form, async () => {
    await signIn(login.input.value, password.input.value);
    render();
  });

  app.replaceChildren(form);
};

const accountRow = (a: AccountRow): HTMLElement =>
  el(
    'div',
    { className: 'card' },
    el('strong', { textContent: a.login }),
    el('div', { className: 'muted', textContent: describeAccount(a) }),
  );

const accountsScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Accounts' }));
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
    list.replaceChildren(...out.accounts.map(accountRow));
  };

  const backupsCard = el('button', { textContent: 'Backups' });
  backupsCard.onclick = () => backupsScreen();

  app.replaceChildren(el('nav', {}, backupsCard), page, list, inviteCard);
  void attempt(page, fill);
};

/** When a run happened, as a person reads a table. */
const mib = (bytes: string | null): string => (bytes === null ? '—' : `${(Number(bytes) / 1024 / 1024).toFixed(1)} MiB`);

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
  void attempt(page, fill);
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
  void attempt(page, fill);
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
    if (signedIn()) {
      // A pending restore is the one thing that outranks the accounts screen: the server
      // answers everything else with restore_pending anyway, so the first thing the console
      // shows is the way out.
      const status = await restoreStatus();
      if (status.pending) {
        restoreScreen();
        return;
      }
      accountsScreen();
      return;
    }
    const state = await health();
    if (state.bootstrap_pending) firstRun();
    else signInScreen();
  });
};

render();
