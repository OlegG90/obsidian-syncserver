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
import { accounts, bootstrap, health, invite, signedIn, signIn, type AccountRow } from './api.js';

const app = document.getElementById('app') as HTMLElement;

/** Bytes as something a person reads. Mebibytes, because quotas are set in them. */
const mib = (bytes: string): string => `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;

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

  button.onclick = (): void => {
    button.disabled = true;
    void attempt(form, async () => {
      await bootstrap(password.input.value);
      render();
    }).finally(() => (button.disabled = false));
  };

  app.replaceChildren(form);
};

const signInScreen = (): void => {
  const form = el('div', { className: 'card' });
  const login = field('Login');
  const password = field('Password', 'password');
  const button = el('button', { textContent: 'Sign in' });

  form.append(el('h1', { textContent: 'SyncServer' }), login.row, password.row, button);

  button.onclick = (): void => {
    button.disabled = true;
    void attempt(form, async () => {
      await signIn(login.input.value, password.input.value);
      render();
    }).finally(() => (button.disabled = false));
  };

  app.replaceChildren(form);
};

const accountRow = (a: AccountRow): HTMLElement => {
  const what =
    a.state === 'provisioned'
      ? `invitation${a.inviteExpiresAt ? `, expires ${new Date(a.inviteExpiresAt).toLocaleDateString()}` : ''}`
      : `${a.role === 'admin' ? 'console' : 'vault'} account · ${a.state}`;
  const usage =
    a.role === 'admin' || a.state === 'provisioned' ? '' : ` · ${mib(a.usedBytes)} of ${mib(a.quotaBytes)}`;

  return el(
    'div',
    { className: 'card' },
    el('strong', { textContent: a.login }),
    el('div', {
      className: 'muted',
      textContent: `${what}${usage}${a.frozenAt ? ' · over its limit' : ''}`,
    }),
  );
};

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

  button.onclick = (): void => {
    button.disabled = true;
    void attempt(inviteCard, async () => {
      const bytes = String(Math.round(Number(quota.input.value) * 1024 * 1024));
      const out = await invite(login.input.value, bytes);
      inviteCard.append(say(`Invitation for ${login.input.value}. Token: ${out.token}`));
      await fill();
    }).finally(() => (button.disabled = false));
  };

  const fill = async (): Promise<void> => {
    const out = await accounts();
    list.replaceChildren(...out.accounts.map(accountRow));
  };

  app.replaceChildren(page, list, inviteCard);
  void attempt(page, fill);
};

const render = (): void => {
  void attempt(app, async () => {
    if (signedIn()) {
      accountsScreen();
      return;
    }
    const state = await health();
    if (state.bootstrap_pending) firstRun();
    else signInScreen();
  });
};

render();
