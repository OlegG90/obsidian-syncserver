/**
 * The sync problems screen (issue #480 splits the screens apart; this is one).
 */
import { syncProblems } from '../api.js';
import { when } from '../format.js';
import { el, pending, loads, shell } from '../shell.js';

/**
 * What went wrong for which device, as the server counted it while answering (#355, D-134).
 *
 * One line per device and kind of refusal, newest first. A count and two times rather than a stream of
 * events: the question an operator brings is "is this still happening, and to whom", and a repeat
 * answers it by moving its time rather than by adding a line. Nothing here names a file or a note —
 * the server never had one to name.
 */
export const problemsScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Sync problems' }));
  const note = el('p', {
    className: 'muted',
    textContent:
      'Refusals the server gave to a device, counted. Conflicts, pairing waits and rate limits are the ' +
      'ordinary course of syncing and are not listed. A problem that stops recurring leaves after 30 days.',
  });
  const list = el('div', {}, pending());

  const fill = async (): Promise<void> => {
    const out = await syncProblems();
    if (out.problems.length === 0) {
      list.replaceChildren(el('p', { className: 'muted', textContent: 'No device has been refused anything lately.' }));
      return;
    }
    // Grouped by account and device, which is the question an operator brings ("what is going wrong for
    // whom"); within a group, the server's order — the most recent first. The sort is stable, so it keeps it.
    const groupOf = (p: (typeof out.problems)[number]): string => `${p.login} · ${p.deviceName} (${p.platform})`;
    const sorted = [...out.problems].sort((x, y) => groupOf(x).localeCompare(groupOf(y)));
    const log = el('div', { className: 'log' });
    let group = '';
    for (const p of sorted) {
      if (groupOf(p) !== group) {
        group = groupOf(p);
        log.append(el('h4', { textContent: group }));
      }
      const line = el('div', { className: 'entry' });
      line.append(
        el('strong', { textContent: `${p.status} ${p.code}` }),
        el('span', { textContent: `${p.method} ${p.route}` }),
        el('span', { className: 'muted', textContent: `${p.count}×` }),
        el('span', { className: 'when', textContent: `last ${when(p.lastAt)}, first ${when(p.firstAt)}` }),
      );
      log.append(line);
      // The rule the last one broke, which is what tells two `invalid_write` loops apart (#433).
      if (p.detail) log.append(el('div', { className: 'muted', textContent: p.detail }));
    }
    list.replaceChildren(log);
  };

  shell('problems', page, note, list);
  loads(list, fill);
};
