/**
 * Lending a buffer to Obsidian instead of copying it — and the case where copying is the
 * only correct answer.
 *
 * The identity assertions are not pinning an implementation: "no copy was made" is the
 * whole contract, and there is no other way to state it. The rest is the safety half —
 * what is handed over must be exactly what was offered, never the allocation it sits in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { arrayBufferOf } from '../src/obsidian/buffer.js';

describe('bytes at the Obsidian boundary', () => {
  it('lends the buffer when the view covers all of it', () => {
    // What a decrypted blob looks like: the AEAD returns a fresh, exact allocation.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    assert.equal(arrayBufferOf(bytes), bytes.buffer, 'the buffer is handed over, not copied');
  });

  it('copies a view into a larger buffer, and copies only the view', () => {
    // The resumable upload's parts are `subarray`s of one sealed blob. Handing over
    // `.buffer` here would send the entire file as every part — the exact bug this guard
    // exists for, and one that would pass every small-file test.
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const part = whole.subarray(2, 5);

    const out = arrayBufferOf(part);

    assert.notEqual(out, whole.buffer, 'not the underlying allocation');
    assert.equal(out.byteLength, 3, 'the view, not what it sits in');
    assert.deepEqual(new Uint8Array(out), new Uint8Array([1, 2, 3]));
  });

  it('copies a view that starts at zero but stops short', () => {
    // Offset alone is not the test: a prefix view shares the buffer's start and still must
    // not carry the tail along.
    const whole = new Uint8Array([1, 2, 3, 7, 7]);
    const prefix = whole.subarray(0, 3);

    const out = arrayBufferOf(prefix);

    assert.notEqual(out, whole.buffer);
    assert.deepEqual(new Uint8Array(out), new Uint8Array([1, 2, 3]));
  });

  it('leaves the caller free to keep reading its own bytes', () => {
    // A pull hashes the plaintext on the line after it writes it, so the lend must not
    // detach or empty the view it came from.
    const bytes = new Uint8Array([5, 6, 7]);
    const lent = arrayBufferOf(bytes);

    assert.equal(bytes.byteLength, 3, 'still readable after being handed over');
    assert.deepEqual(new Uint8Array(lent), bytes);
  });

  it('handles an empty payload without pretending it is a view into something', () => {
    const out = arrayBufferOf(new Uint8Array(0));
    assert.equal(out.byteLength, 0);
  });
});
