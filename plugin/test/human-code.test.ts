/**
 * The pairing code: enough entropy to survive ten minutes without rate limiting, and a
 * normalisation that cannot destroy a code typed correctly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newHumanCode, normaliseHumanCode } from '../src/crypto/human-code.js';

describe('the code a human carries between two devices', () => {
  it('carries 128 bits, which is the floor and not a preference', () => {
    // 16 bytes at five bits a character. Shorter would be friendlier and brute-forceable
    // inside the ten minutes a pairing lives, since nothing rate-limits approval or claim.
    const code = newHumanCode();
    assert.equal(normaliseHumanCode(code).length, 26, '128 bits, base32');
    assert.match(code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/, 'grouped for typing');
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newHumanCode()));
    assert.equal(seen.size, 50);
  });

  it('reads the same code however a person typed it', () => {
    const code = newHumanCode();
    const canonical = normaliseHumanCode(code);

    assert.equal(normaliseHumanCode(code.toLowerCase()), canonical, 'case');
    assert.equal(normaliseHumanCode(code.replace(/-/g, '')), canonical, 'without the dashes');
    assert.equal(normaliseHumanCode(` ${code} `), canonical, 'with stray spaces');
    // Or pasted rather than typed. A copied code can arrive carrying the line it sat on, and
    // a paste that read as "wrong code" would be the one failure a person cannot act on —
    // they did not type it, so there is nothing to look at again.
    assert.equal(normaliseHumanCode(`${code}
`), canonical, 'pasted, with the newline it came with');
    assert.equal(normaliseHumanCode(`
${code}	`), canonical, 'and whatever else a clipboard adds');
  });

  it('never contains a character it would then have to guess about', () => {
    // The whole reason for Crockford's alphabet. If `I`, `L`, `O` or `U` could appear in a
    // generated code, mapping them on input would corrupt codes that were read correctly.
    const codes = Array.from({ length: 200 }, () => normaliseHumanCode(newHumanCode())).join('');
    assert.doesNotMatch(codes, /[ILOU]/, 'the confusable letters are not in the alphabet');
  });

  it('fixes the misreadings the alphabet made unambiguous', () => {
    // A person reading `0` as `O` and `1` as `I` or `l` is the ordinary case, and each of
    // these is a fact rather than a guess because the target is not in the alphabet.
    assert.equal(normaliseHumanCode('O0OO'), '0000');
    assert.equal(normaliseHumanCode('I1Ll'), '1111');
    assert.equal(normaliseHumanCode('U'), 'V');
  });
});
