/**
 * The refusal vocabulary as a fact, apart from its HTTP mapping.
 *
 * Two things are asserted here and nowhere else. `refusalFromDatabase` has only ever been
 * exercised through a route, so its own rule — translate `check_violation` and **nothing
 * else** — was implied by a `400` rather than stated. And the separation the split exists
 * for is checked directly: a module every service imports must not pull in a web framework
 * to describe a database write.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isRefusal, refusalFromDatabase, txGuarded, type Refusal } from '../src/refusal.js';

const CHECK_VIOLATION = '23514';

describe('a schema refusal, turned into one the caller can act on', () => {
  it('translates a check violation and keeps the message the schema wrote', () => {
    // The trigger's own sentence is the most specific statement of what was wrong, and it
    // was written to be read — composing a vaguer one here would only make the reader guess.
    const refusal = refusalFromDatabase({
      code: CHECK_VIOLATION,
      message: 'private node 4d951bc5 name must use its vault key',
    });

    assert.deepEqual(refusal, {
      kind: 'invalid_write',
      detail: 'private node 4d951bc5 name must use its vault key',
    });
  });

  it('leaves every other database error alone, so a defect here stays a 500', () => {
    // A unique violation, a foreign key or a serialization failure usually mean a fault on
    // the server's side. Mapping them to `400` would file this codebase's own bugs under
    // the caller's name — which is the opposite of the rule that motivated the translation.
    for (const code of ['23505', '23503', '40001', '42P01', undefined]) {
      assert.equal(refusalFromDatabase({ code, message: 'x' }), undefined, `${code} must not be translated`);
    }
  });

  it('names a freeze as a freeze, by the hint the frozen trigger carries (#339)', () => {
    // The client explains being over quota only for `frozen`; as `invalid_write` the person
    // was told their write was malformed.
    const frozen = refusalFromDatabase({ code: '23001', hint: 'frozen', message: 'account … is over quota' });
    assert.deepEqual(frozen, { kind: 'frozen' });

    // Every other trigger refusal keeps its sentence — the hint is the mark, not the code.
    const other = refusalFromDatabase({ code: '23001', message: 'cannot leave before finalization starts' });
    assert.equal(other?.kind, 'invalid_write');
    const checked = refusalFromDatabase({ code: CHECK_VIOLATION, hint: 'frozen', message: 'x' });
    assert.equal(checked?.kind, 'invalid_write', 'and only on the code the frozen trigger raises');
  });

  it('survives being handed something that is not an error at all', () => {
    assert.equal(refusalFromDatabase(null), undefined);
    assert.equal(refusalFromDatabase('a string'), undefined);
  });

  it('says something useful even when the driver gave no message', () => {
    const refusal = refusalFromDatabase({ code: CHECK_VIOLATION });
    assert.deepEqual(refusal, { kind: 'invalid_write', detail: 'the write violates a schema rule' });
  });
});

describe('the vocabulary is a fact, not a response', () => {
  it('imports nothing from a web framework', () => {
    // The reason this module is separate from `refuse-http.ts`. Every service returns a
    // `Refusal` and therefore imports whatever declares it; while the union and the status
    // mapping shared a file, five services imported a Fastify type to describe a database
    // write, and a console or a CLI would have inherited it for the same non-reason.
    //
    // Asserted against the source because that is where the coupling would come back — a
    // single `import type { FastifyReply }` restores it silently and nothing else notices.
    const source = readFileSync(new URL('../src/refusal.ts', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /from 'fastify'/, 'the facts stay free of the transport');
    assert.doesNotMatch(source, /FastifyReply|FastifyInstance|reply\./, 'and free of its vocabulary');
  });
});

/**
 * A transaction that records how it ended, so the tests can ask whether a write survived.
 *
 * `txGuarded` is the whole mechanism of #334, and it needs no database to be asked the one question
 * that matters: did this callback's work commit or roll back? The fake runs the callback, then
 * does what `db.tx` does — commit on return, roll back on throw — and remembers which.
 */
const recordingDb = () => {
  const ended: ('commit' | 'rollback')[] = [];
  const db = {
    async tx<R>(fn: (c: never) => Promise<R>): Promise<R> {
      try {
        const out = await fn(undefined as never);
        ended.push('commit');
        return out;
      } catch (e) {
        ended.push('rollback');
        throw e;
      }
    },
  };
  return { db, ended };
};

describe('a refusal returned from inside a transaction (#334)', () => {
  it('rolls the transaction back, like a refusal the database throws', async () => {
    // The bug in one assertion. A callback that wrote, then returned a refusal, used to be
    // committed — `finalizeLeave` deleted a participant's whole version history that way and
    // left them still in the share.
    const { db, ended } = recordingDb();
    const out = await txGuarded(db, async () => ({ kind: 'invalid_write', detail: 'node x is not part of this share' }) as Refusal);

    assert.deepEqual(ended, ['rollback']);
    assert.deepEqual(out, { kind: 'invalid_write', detail: 'node x is not part of this share' }, 'and the caller gets the same answer');
  });

  it('still commits a success', async () => {
    const { db, ended } = recordingDb();
    assert.deepEqual(await txGuarded(db, async () => ({ shareId: 's1' })), { shareId: 's1' });
    assert.deepEqual(ended, ['commit']);
  });

  it('commits a success that is `undefined`, which most writes return', async () => {
    const { db, ended } = recordingDb();
    assert.equal(await txGuarded(db, async () => undefined), undefined);
    assert.deepEqual(ended, ['commit']);
  });

  it('still turns a thrown schema refusal into an answer', async () => {
    const { db, ended } = recordingDb();
    const out = await txGuarded(db, async () => {
      throw Object.assign(new Error('x'), { code: CHECK_VIOLATION, message: 'a schema rule' });
    });
    assert.deepEqual(ended, ['rollback']);
    assert.deepEqual(out, { kind: 'invalid_write', detail: 'a schema rule' });
  });

  it('lets a genuine defect through as the exception it is', async () => {
    const { db } = recordingDb();
    await assert.rejects(
      txGuarded(db, async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }),
      /duplicate key/,
    );
  });
});

describe('what counts as a refusal', () => {
  it('recognises every refusal by its kind', () => {
    assert.equal(isRefusal({ kind: 'frozen' }), true);
    assert.equal(isRefusal({ kind: 'finalization_incomplete', missing: [] }), true);
  });

  /**
   * The one way this could go wrong is a success mistaken for a refusal — its work would then roll
   * back. So a value that merely HAS a `kind` is not enough: the kind must be a refusal's.
   */
  it('does not mistake a success that happens to carry a kind', () => {
    assert.equal(isRefusal({ kind: 'ok', userId: 'u' }), false, 'OwnerAccess on the success arm');
    assert.equal(isRefusal({ kind: 'create', vaultId: 'v' }), false, 'a fan-out event');
    assert.equal(isRefusal({ kind: 'toString' }), false, 'not a prototype key either');
  });

  it('is false for everything that is not a tagged object', () => {
    for (const x of [undefined, null, 0, 'frozen', [], { shareId: 's' }, { kind: 7 }]) {
      assert.equal(isRefusal(x), false, JSON.stringify(x));
    }
  });
});
