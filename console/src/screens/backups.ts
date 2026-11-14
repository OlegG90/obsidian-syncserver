/**
 * The backups screen and everything it opens (issue #480 splits the screens apart; this is one).
 */
import {
  backups, removeBackup, restoreFromCopy, runBackup, saveSchedule, verify,
  type BackupRun, type BackupScheduleView,
} from '../api.js';
import {
  confirmLabel, human, keptLine, scheduleAlarm, scheduleLine, when, windowHeld, WEEKDAYS,
} from '../format.js';
import { el, say, pending, loads, shell, submits } from '../shell.js';

const backupRow = (b: BackupRun): HTMLElement => {
  const card = el('div', { className: 'card' });
  card.append(
    el('strong', { textContent: `${b.status} — ${when(b.startedAt)}` }),
    // Which of the two asked for it, on every row: a history in which a scheduled copy and a
    // copy somebody took before an upgrade look identical is one nobody can read afterwards.
    el('div', { className: 'muted', textContent: b.source === 'schedule' ? 'on a schedule' : 'by hand' }),
  );
  // A skipped run copied nothing, so sizes and a destination would be three dashes in a row.
  if (b.status !== 'skipped') {
    card.append(el('div', { className: 'muted', textContent: `${human(b.bytes)}, ${b.blobCount ?? '—'} blobs` }));
  }
  const held = windowHeld(b.windowOpenedAt, b.windowClosedAt);
  if (held) card.append(el('div', { className: 'muted', textContent: held }));
  if (b.error) card.append(el('p', { className: 'bad', textContent: b.error }));
  if (b.verifiedAt) card.append(el('div', { className: 'muted', textContent: `verified ${when(b.verifiedAt)}` }));
  if (b.status === 'ok') card.append(verifyButton(b));

  // A run whose copy is gone is no longer listed, except a skip, which never had one.
  if (b.destination !== null && b.status !== 'running') {
    card.append(whereItIs(b.destination));
    if (b.status === 'ok') card.append(restoreButton(b));
    card.append(removeButton(b));
  }
  return card;
};

/**
 * Where this copy is, on the server's side of the mount (issue #218).
 *
 * This line used to be a folded block holding three commands to type — and they were the *reference*
 * deployment's commands: a shell in the directory that holds `docker-compose.yml`, a project and a
 * service named the way that file names them. Installed from a stack manager there is no such directory
 * and the project is the stack's, so the commands did not run, and a block of commands that do not run
 * reads more authoritative than the button beside it that does. The button (D-92) is what replaced the
 * typing; the block was what remained of the answer it replaced.
 *
 * The path stays, and alone: it is the one thing only the console knows about a row, the by-hand route in
 * docs/15 asks for it by name, and nothing else on this screen says which directory a run wrote to.
 */
const whereItIs = (destination: string): HTMLElement =>
  el('div', { className: 'muted', textContent: destination });

/**
 * A control that asks twice, and says which subject on the second press.
 *
 * Two buttons on this screen do irreversible things to one named copy, and each had built the swap
 * itself: primary → confirm + cancel, then cancel restores the primary. **They had already drifted in
 * the cancel path** — one cleared what the first press had written into the message area and the other
 * did not, so cancelling a restore left its warning standing under a button that was no longer offered.
 *
 * The cancel path is exactly where this kind of duplication rots: it is the branch nobody demonstrates.
 *
 * `warning` is shown on the first press and taken back by cancel, so "pressed once and changed my mind"
 * always ends where it started.
 */
const twoPress = (opts: {
  label: string;
  verb: string;
  subject: string;
  warning?: string;
  after: string;
  run: () => Promise<void>;
}): HTMLElement => {
  const where = el('div', {});
  const button = el('button', { className: 'danger', textContent: opts.label });
  const confirm = el('button', { className: 'danger', textContent: confirmLabel(opts.verb, opts.subject) });
  const cancel = el('button', { className: 'link', textContent: 'Leave it alone' });

  button.onclick = (): void => {
    if (opts.warning) where.replaceChildren(say(opts.warning, true));
    button.replaceWith(confirm, cancel);
  };
  cancel.onclick = (): void => {
    confirm.replaceWith(button);
    cancel.remove();
    where.replaceChildren();
  };

  submits(confirm, where, async () => {
    await opts.run();
    confirm.remove();
    cancel.remove();
    where.replaceChildren(say(opts.after));
  });

  return el('div', {}, button, where);
};

/**
 * Remove one copy, per row, behind a confirmation that names it (#136).
 *
 * **Per row and not a selection with one button.** Checkboxes plus Delete is the most destructive
 * control a console can have: one press, many copies, and no chance to read what is about to go. Backups
 * are taken when somebody asks for one, so they pile up at the rate somebody asks — which is a rate a
 * person can keep up with, one row at a time.
 *
 * The confirmation names the date rather than asking "are you sure": the question is which
 * copy, and a dialogue that does not answer it is a speed bump instead of a check.
 */
const removeButton = (run: BackupRun): HTMLElement =>
  twoPress({
    label: 'Remove the copy',
    verb: 'remove the copy from',
    subject: when(run.startedAt),
    after: 'The copy is gone. This run stays in the history.',
    run: () => removeBackup(run.id),
  });

/**
 * Restore from **this** copy (D-92).
 *
 * This surface used to refuse the act and show the command to type instead — correct, and it left the
 * part somebody gets wrong at three in the morning. So the button asks, and the server carries the
 * request out **on its way back up**, before it opens a connection for serving, which is the moment
 * `pg_restore --clean` is safe. A server able to overwrite itself *while running* is still refused.
 *
 * **Two presses, and the second one names the copy.** A dialogue that does not say which copy is a speed
 * bump rather than a check — the same shape the removal uses, for a heavier act.
 *
 * The confirmation says the two things somebody cannot see from here: the server stops now, and it comes
 * back only if the deployment restarts it. And it says what happens after, because the halt that follows
 * would otherwise read as a failed restore rather than as the guard doing its job.
 */
const restoreButton = (run: BackupRun): HTMLElement =>
  twoPress({
    label: 'Restore from this copy',
    verb: 'restore from',
    subject: `${when(run.startedAt)} and stop the server`,
    warning:
      'This replaces the database and adds the copy’s files back. The server stops immediately and ' +
      'restores on its next start, so it returns only if your deployment restarts it (docker compose ' +
      'up -d does). When it is back it will refuse every request until you confirm the restore here.',
    after: 'Asked for. The server is stopping; reload this page once it is back, and confirm the restore.',
    run: () => restoreFromCopy(run.id).then(() => undefined),
  });

const verifyButton = (run: BackupRun): HTMLElement => {
  const button = el('button', { textContent: 'Verify' });
  const where = el('div', {});
  submits(button, where, async () => {
    const out = await verify(run.id);
    // A whole copy is the one the server stamps verified, now — said here rather than learned
    // by fetching every run again to read one field of this one.
    where.append(
      out.whole
        ? say(`whole: all ${out.checked} blobs present — verified ${when(new Date().toISOString())}`)
        : say(`${out.missing.length} of ${out.checked} blobs missing from the copy`, true),
    );
  });
  return el('div', {}, button, where);
};

/**
 * The schedule, as the operator sets it (#357, D-141).
 *
 * **Everything in one card and one Save.** The switch is a field beside the others rather than
 * its own control, because "on, Tuesdays at 02:00, keep seven" is a single intention — and a
 * switch that took effect on its own would arm yesterday's time while the operator was still
 * reading the row.
 *
 * The **zone** carries the choice this console exists to make easy: the server runs in UTC,
 * the operator does not, and the browser already knows which zone they are thinking in. It is
 * offered first, and the whole list is behind it for a server administered from elsewhere.
 */
const scheduleCard = (view: BackupScheduleView, runs: BackupRun[], reload: () => Promise<void>): HTMLElement => {
  const card = el('div', { className: 'card' }, el('h1', { textContent: 'On a schedule' }));

  const on = el('input', { type: 'checkbox', checked: view.enabled });
  const time = el('input', { type: 'time', value: view.time });
  const keep = el('input', { type: 'number', min: '1', max: String(view.keepMax), value: String(view.keep) });
  // Redrawn as the number changes, so what keeping it costs is read before it is saved (#357).
  const kept = el('p', { className: 'muted', textContent: keptLine(runs, view.keep) });
  keep.addEventListener('input', () => {
    kept.textContent = keptLine(runs, Number(keep.value));
  });
  const boxes = WEEKDAYS.map((name, day) => {
    const box = el('input', { type: 'checkbox', checked: view.days.includes(day) });
    return { day, box, row: el('label', {}, box, name) };
  });

  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const known = Intl.supportedValuesOf?.('timeZone') ?? [view.zone];
  const zone = el('select');
  for (const name of [...new Set([here, view.zone, ...known])]) {
    zone.append(el('option', { value: name, textContent: name === here ? `${name} (this browser)` : name }));
  }
  zone.value = view.zone;

  const alarm = scheduleAlarm(view);
  if (alarm) card.append(say(alarm, true));
  card.append(
    el('p', { className: 'muted', textContent: scheduleLine(view) }),
    el('div', {}, el('label', {}, on, 'Take a backup on a schedule')),
    el('div', {}, el('label', { textContent: 'At' }), time),
    el('label', { textContent: 'On these days' }),
    el('div', { className: 'choices' }, ...boxes.map((b) => b.row)),
    el('div', {}, el('label', { textContent: 'Time zone' }), zone),
    el('div', {}, el('label', { textContent: `Scheduled copies to keep (1–${view.keepMax})` }), keep),
    kept,
    el('p', {
      className: 'muted',
      textContent:
        'Only copies this schedule took are removed once there are more than that; a backup ' +
        'you took by hand is never swept. A run that arrives while the server is busy is ' +
        `skipped rather than queued, and one missed by more than ${view.catchUpHours} hours is not caught up.`,
    }),
  );

  const save = el('button', { textContent: 'Save the schedule' });
  card.append(save);
  submits(save, card, async () => {
    await saveSchedule({
      enabled: on.checked,
      time: time.value,
      days: boxes.filter((b) => b.box.checked).map((b) => b.day),
      zone: zone.value,
      keep: Number(keep.value),
    });
    card.append(say('Schedule saved.'));
    await reload();
  });
  return card;
};

export const backupsScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Backups' }));
  const list = el('div', {}, pending());

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
    const started = await runBackup();
    // The run goes on behind the 202 (issue #479): the dump, the copy and the self-check
    // take minutes, so this watches the run's row through the list rather than waiting on the
    // request that started it. A reload is still safe — the list shows the running row, and
    // the next press while it runs is refused with `backup_in_progress` rather than doubling it.
    const note = el('p', { className: 'muted', textContent: 'Backup started — watching it finish…' });
    runCard.append(note);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const { backups: runs } = await backups();
      const run = runs.find((b) => b.id === started.id);
      if (run !== undefined && run.status === 'running') continue;
      note.remove();
      if (run === undefined) {
        runCard.append(say('Backup finished, but its row is gone — the list below says what remains.', true));
      } else if (run.status === 'ok') {
        // Anything but a finished run is refused before the button's own line, so what is left
        // to say is whether the copy it wrote passed its own check — "Backup taken." over a
        // copy nobody can restore from is the one sentence this card must not print.
        runCard.append(
          run.error
            ? say(`Backup taken, and it is not restorable: ${run.error}`, true)
            : say('Backup taken.'),
        );
      } else {
        runCard.append(say(`Backup ${run.status}: ${run.error ?? 'no detail recorded'}`, true));
      }
      await fill();
      return;
    }
  });

  const fill = async (): Promise<void> => {
    const out = await backups();
    // The card is rebuilt from the answer rather than patched: the next run, the banner and
    // the fields are one description of one row, and a card half-updated would show a time
    // the server is not keeping.
    list.replaceChildren(scheduleCard(out.schedule, out.backups, fill), ...out.backups.map(backupRow));
  };

  shell('backups', page, list, runCard);
  loads(list, fill);
};
