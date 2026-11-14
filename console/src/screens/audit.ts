/**
 * The audit log screen (issue #480 splits the screens apart; this is one).
 */
import { audit, type AuditRow } from '../api.js';
import { auditAction, human, when } from '../format.js';
import { el, pending, loads, shell } from '../shell.js';

/**
 * The audit log, newest first (D-87, D-94).
 *
 * Read-only, and there is nothing here that could make it otherwise: the table refuses updates
 * and deletes at the schema level, so this screen has no button because there is no act. What
 * it shows is the answer to "who did what to whom", which is the whole reason a log with no
 * foreign keys keeps snapshot logins (D-93) — an entry naming an account that has since been
 * deleted is still the answer.
 *
 * **Nothing here reaches a vault's contents.** A console account holds no key (D-115); the log
 * records administrative acts, and administrative acts never touch a note.
 */
export const auditScreen = (): void => {
  const page = el('div', {}, el('h1', { textContent: 'Audit log' }));
  const size = el('div', { className: 'usage' });
  const list = el('div', {}, pending());


  const fill = async (): Promise<void> => {
    const out = await audit();
    list.replaceChildren(
      out.entries.length === 0
        ? el('p', { className: 'muted', textContent: 'Nothing has been done to an account yet.' })
        : auditLog(out.entries),
    );
    // The whole log's size, beside a page of it (D-117). The sentence is for the reader; the number is
    // for the assumption underneath, which is the part nothing enforces.
    size.replaceChildren(
      el('span', {
        className: 'muted',
        textContent: `${out.size.rows} entries in all, ${human(out.size.bytes)} on disk — nothing is ever removed.`,
      }),
    );
  };

  shell('audit', page, size, list);
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
 * Newest first, which is the server order (D-87, D-94) and not this screen to choose.
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

