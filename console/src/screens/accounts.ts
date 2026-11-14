/**
 * The accounts screen and everything it opens (issue #480 splits the screens apart; this is one).
 */
import {
  accounts, storage, invite, reissue, revokeInvitation, setEnabled, renameDevice, revokeDevice,
  devicesOf, beginDeletion, deletionProgress, setQuota,
  type AccountRow, type DeletionProgress, type StorageTotals,
} from '../api.js';
import {
  accountBadge, problemsBadge, quotaProblem, accountState, accountUsage, bytesFromMib, freezeWarning,
  holdsStorage, human, isOver, mib, mibOf, seenLine, seenNote, usageFraction, usageMarker, when,
} from '../format.js';
import { el, say, pending, field, submits, loads, shell } from '../shell.js';

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
  // Refusals this account's devices met lately (#355): a count to go and look at, not the detail itself.
  if (a.recentProblems > 0) top.append(el('span', { className: 'badge is-frozen', textContent: problemsBadge(a.recentProblems) }));
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

  if (holdsStorage(a)) {
    // **The bar is red for being OVER, not for being frozen.** It asked the second question and
    // printed the first, so an account at 115% of its quota looked exactly like one at 1% —
    // found on a live console. The two come apart: a freeze is raised where somebody else's
    // write crosses the boundary, so an account syncing alone stays unfrozen while over.
    const marker = usageMarker(a);
    const bar = el('div', { className: isOver(a) ? 'bar over' : 'bar' });
    const fill = el('span', {});
    fill.style.width = `${(usageFraction(a) * 100).toFixed(1)}%`;
    bar.append(fill);
    const line = el('div', { className: 'usage' }, el('span', { textContent: accountUsage(a) }));
    if (marker) line.append(el('span', { className: 'right bad', textContent: marker }));
    card.append(bar, line);
  } else {
    // Said rather than left blank, because "no bar" and "a bar at zero" mean different things
    // and only one of them is true here (D-115).
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
    act('Reissue', opens(() => reissueForm(a, done, report)));
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
    act('Devices…', opens(() => deviceList(a, report)));
    act(a.state === 'disabled' ? 'Enable' : 'Disable', opens(() => enableForm(a, done, report)));
    act('Delete…', opens(() => deletionForm(a, done, report)), true);
  }

  card.append(drawer);
  return card;
};

/** A fresh token for an invitation nobody redeemed — shown once here, exactly as the first was. */
const reissueForm = (a: AccountRow, done: () => Promise<void>, report: Report): HTMLElement => {
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
    // Reported OUTSIDE the card, like every outcome here: `done()` replaces the card, and a token
    // drawn inside it was gone the moment it appeared — the one time it is ever shown.
    report(`New token for ${a.login}: ${out.token}`);
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
 * The devices of one account, and taking one away (#156).
 *
 * **This exists for the person the owner cannot be.** Somebody with a working device revokes from their
 * own plugin; somebody whose only device is the one that was lost has nobody but the operator — and
 * until now the operator had no device surface at all, so a phone left in a taxi stayed authorised for
 * ever.
 *
 * Names, platforms and times. No cursors, no keys: an administrator holds nothing that opens a vault
 * (D-115), and a list of somebody's devices is not where that would start.
 *
 * Every revocation here lands in the audit log, because it is done TO an account rather than by it.
 */
const deviceList = (a: AccountRow, report: Report): HTMLElement => {
  const box = el('div', {});
  const list = el('div', {}, pending());
  box.append(
    el('p', {
      className: 'muted',
      textContent:
        `What can reach ${a.login} right now. Revoking one stops it syncing at once and it cannot sign ` +
        'in again; nothing on it is deleted.',
    }),
    list,
  );

  const fill = async (): Promise<void> => {
    const out = await devicesOf(a.id);
    list.replaceChildren();
    if (out.devices.length === 0) {
      list.append(el('p', { className: 'muted', textContent: 'No devices reach this account.' }));
      return;
    }
    list.append(el('p', { className: 'muted', textContent: seenNote(out.seen_within_seconds) }));
    // Grouped by the vault each device syncs (#364, D-139). A group is named by the vault's id: its name is
    // encrypted under the account's key, which an administrator never holds (D-115).
    const groupOf = (d: (typeof out.devices)[number]): string =>
      d.vault_id ? `vault ${d.vault_id.slice(0, 8)}…` : d.platform === 'console' ? 'console' : 'vault not known yet';
    const sorted = [...out.devices].sort((x, y) => groupOf(x).localeCompare(groupOf(y)));
    let group = '';
    for (const d of sorted) {
      if (groupOf(d) !== group) {
        group = groupOf(d);
        list.append(el('h4', { textContent: group }));
      }
      const row = el('div', { className: 'entry' });
      row.append(
        el('strong', { textContent: d.name }),
        el('span', { className: 'muted', textContent: d.platform }),
        // "Last seen" and not "signed in": D-118 made the column move on every refresh, so the old
        // label claimed LESS than it holds. The plugin's copy of this row was corrected then and this
        // one was not — two screens, one column, and only one of them told the truth about it.
        // **An interval, and the instant behind it on hover** (#386). The column moves on a
        // refresh rather than on a sync (D-118), so a timestamp to the second was an exactness
        // it does not have — and a device syncing right now read as one that had gone quiet.
        el('span', {
          className: 'when',
          textContent: seenLine(d.last_seen_at, out.seen_within_seconds),
          title: d.last_seen_at ? when(d.last_seen_at) : '',
        }),
      );
      // Not the console's own row: a sign-in writes that name every time, and the server refuses it (#356).
      if (d.platform !== 'console') {
        const rename = el('button', { textContent: 'Rename' });
        rename.onclick = () => {
          const name = field('New name');
          name.input.value = d.name;
          const save = el('button', { textContent: 'Save' });
          rename.replaceWith(name.row, save);
          submits(save, row, async () => {
            const next = name.input.value.trim();
            await renameDevice(a.id, d.id, next);
            // Reported outside the list, which `fill` is about to replace.
            report(`${d.name} is now called ${next}.`);
            await fill();
          });
        };
        row.append(rename);
      }
      const go = el('button', { className: 'danger', textContent: 'Revoke' });
      submits(go, list, async () => {
        await revokeDevice(a.id, d.id);
        report(`${d.name} can no longer reach ${a.login}.`);
        await fill();
      });
      row.append(go);
      list.append(row);
    }
  };

  loads(list, fill);
  return box;
};

/**
 * Deleting an account, which is a **procedure and not a button** (D-55).
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
 * this account, by design (D-93), since a history that forgets who did what is worse than one
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
      // Refreshed only when the row itself changed. A deletion still waiting is the same row it
      // was, and the refresh replaced this card — progress just drawn, gone, and a request to
      // read it back when the operator opened the drawer again.
      if (!next.finished) return;
      report(`${a.login} was deleted.`);
      await done();
    });
    submits(look, body, async () => underway(await deletionProgress(a.id)));
  };

  // Already begun — by a previous session, or by this one before a reload.
  if (a.state === 'deleting') {
    body.replaceChildren(el('p', { className: 'muted', textContent: 'Reading where it got to…' }));
    loads(body, async () => underway(await deletionProgress(a.id)));
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
    // Two counts, because they are two facts and the operator's question — "is anybody in
    // trouble" — is answered by the first. They should agree, since setting a limit settles
    // the freeze (#333); when they do not, the difference is the thing worth looking at.
    ['Over limit', String(rows.filter(isOver).length)],
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
  quota.input.value = mibOf(a.quotaBytes);
  const save = el('button', { textContent: 'Save' });
  box.append(quota.row, save);

  // Takes the bytes rather than reading the field again: what is applied is exactly what the
  // warning described, even if the field was edited between the two presses.
  const apply = async (bytes: string): Promise<void> => {
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
    // Before anything reads it as a number (#374): what is typed here is the one input on this screen
    // that a person composes rather than picks, and `BigInt("NaN")` throws where a sentence belongs.
    const problem = quotaProblem(quota.input.value);
    if (problem) return report(`That limit will not do — ${problem}`, true);

    const bytes = bytesFromMib(quota.input.value);
    const warning = freezeWarning(bytes, a.usedBytes);
    if (!warning) return apply(bytes);

    // Said once, and replaced by the act rather than stacking: pressing Save twice with the
    // same number should not grow a column of identical warnings.
    save.remove();
    const anyway = el('button', { textContent: 'Lower it anyway' });
    box.append(say(warning, true), anyway);
    submits(anyway, box, () => apply(bytes));
  });

  return box;
};

export const accountsScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Accounts' }));
  // Outcomes live here rather than in the cards, because the cards are replaced by the very
  // refresh that follows an act. One line at a time: the last thing done is the thing worth
  // reading, and a column of them is a log nobody asked this screen for.
  const notices = el('div', {});
  const report: Report = (message, bad = false) => notices.replaceChildren(say(message, bad));
  const list = el('div', {}, pending());

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
      const out = await invite(login.input.value, bytesFromMib(quota.input.value));
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

  shell('accounts', page, notices, list, inviteCard);
  loads(list, fill);
};
