/**
 * The pairing code: enough entropy to survive ten minutes without rate limiting, and a
 * normalisation that cannot destroy a code typed correctly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newPairingCode, normalisePairingCode } from '../src/crypto/pairing-code.js';

describe('the code a human carries between two devices', () => {
  it('carries 128 bits, which is the floor and not a preference', () => {
    // 16 bytes at five bits a character. Shorter would be friendlier and brute-forceable
    // inside the ten minutes a pairing lives, since nothing rate-limits approval or claim.
    const code = newPairingCode();
    assert.equal(normalisePairingCode(code).length, 26, '128 bits, base32');
    assert.match(code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/, 'grouped for typing');
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newPairingCode()));
    assert.equal(seen.size, 50);
  });

  it('reads the same code however a person typed it', () => {
    const code = newPairingCode();
    const canonical = normalisePairingCode(code);

    assert.equal(normalisePairingCode(code.toLowerCase()), canonical, 'case');
    assert.equal(normalisePairingCode(code.replace(/-/g, '')), canonical, 'without the dashes');
    assert.equal(normalisePairingCode(` ${code} `), canonical, 'with stray spaces');
  });

  it('never contains a character it would then have to guess about', () => {
    // The whole reason for Crockford's alphabet. If `I`, `L`, `O` or `U` could appear in a
    // generated code, mapping them on input would corrupt codes that were read correctly.
    const codes = Array.from({ length: 200 }, () => normalisePairingCode(newPairingCode())).join('');
    assert.doesNotMatch(codes, /[ILOU]/, 'the confusable letters are not in the alphabet');
  });

  it('fixes the misreadings the alphabet made unambiguous', () => {
    // A person reading `0` as `O` and `1` as `I` or `l` is the ordinary case, and each of
    // these is a fact rather than a guess because the target is not in the alphabet.
    assert.equal(normalisePairingCode('O0OO'), '0000');
    assert.equal(normalisePairingCode('I1Ll'), '1111');
    assert.equal(normalisePairingCode('U'), 'V');
  });
});
