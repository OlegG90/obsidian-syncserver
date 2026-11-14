/**
 * The restore-confirm surface (issue #480 splits the screens apart; this is one).
 */
import { confirmRestore, restoreStatus } from '../api.js';
import { alone, el, pending, submits, loads } from '../shell.js';

export const restoreScreen = (): void => {
  const page = el('div', { className: 'card' });
  const status = el('div', {}, pending('Checking…'));
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
