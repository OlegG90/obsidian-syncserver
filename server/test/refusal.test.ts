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

import { refusalFromDatabase } from '../src/refusal.js';

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
