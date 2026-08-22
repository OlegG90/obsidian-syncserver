/**
 * The compatibility rule (D-111) — the one piece of versioning that is a decision rather
 * than a string.
 *
 * It is worth testing for a reason most version comparisons are not: **the rule changes
 * meaning at 1.0.0 without the code changing**. While the major is 0 the minor carries the
 * promise; from 1.0.0 on the major does, and the zero test simply stops being true. Both
 * halves are asserted here so that transition is a fact rather than a hope.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installWarning, PLUGIN_VERSION, versionWarning } from '../src/version.js';

describe('an install that is two halves of different builds', () => {
  it('says so when manifest.json lags the bundle beside it', () => {
    // The real case, from a phone on 14 August: the plugin list showed 0.0.0 while main.js
    // next to it was 0.1.0, because unpacking over the existing folder replaced one file
    // and skipped the other. Both numbers were on screen, in different screens, and nothing
    // connected them.
    const w = installWarning('0.0.0', '0.1.0');

    assert.match(w!, /main\.js is 0\.1\.0/);
    assert.match(w!, /manifest\.json is 0\.0\.0/);
    assert.match(w!, /Delete the plugin folder/, 'and says what to actually do about it');
  });

  it('is silent when the two agree', () => {
    assert.equal(installWarning('0.1.0', '0.1.0'), null);
  });

  it('catches a lagging bundle too, not just a lagging manifest', () => {
    // The other direction happens when main.js is the file that fails to overwrite, and it
    // is the more dangerous one: the manifest advertises a version the code is not.
    assert.ok(installWarning('0.2.0', '0.1.0'));
  });

  it('demands exact equality, because the two files leave one build together', () => {
    // Not the major/minor rule that governs client-versus-server. A patch apart still means
    // only one of the two files arrived.
    assert.ok(installWarning('0.1.1', '0.1.0'), 'a patch apart is still a broken install');
  });
});

describe('while the major is zero, the minor carries the promise', () => {
  it('accepts an exact match', () => {
    assert.equal(versionWarning('0.1.0', '0.1.0'), null);
  });

  it('accepts a differing patch, which is what a patch means', () => {
    assert.equal(versionWarning('0.1.7', '0.1.0'), null);
    assert.equal(versionWarning('0.1.0', '0.1.7'), null);
  });

  it('rejects a differing minor, because 0.x promises nothing across it', () => {
    // The case the whole rule exists for: 0.1 and 0.2 are as unrelated as 1.x and 2.x
    // will be, and treating them as compatible is what "major only" would wrongly do.
    const w = versionWarning('0.2.0', '0.1.0');
    assert.match(w!, /0\.2\.0/);
    assert.match(w!, /0\.1\.0/);
    assert.match(w!, /not meant to be used together/);
  });
});

describe('from 1.0.0 on, the major carries it and the minor stops mattering', () => {
  it('accepts a differing minor within one major', () => {
    assert.equal(versionWarning('1.4.0', '1.1.2'), null, 'the rule relaxes on its own at 1.0');
  });

  it('still rejects a differing major', () => {
    assert.ok(versionWarning('2.0.0', '1.9.9'));
    assert.ok(versionWarning('1.0.0', '0.1.0'), 'and 0.x is not compatible with 1.x either');
  });
});

describe('versions it cannot take at face value', () => {
  it('names a server too old to report one at all', () => {
    // `undefined` is what a pre-0.1.0 server's /health leaves out. That is an answer, not
    // a gap: no server that reports nothing is new enough to be compatible.
    const w = versionWarning(undefined, '0.1.0');
    assert.match(w!, /before 0\.1\.0/);
    assert.match(w!, /Update the server/);
  });

  it('refuses to guess at something it cannot parse', () => {
    // Guessing here would be the worst of both: a false "compatible" from a string that
    // was never a version.
    for (const bad of ['', 'v1', 'nightly', '1.2', 'main']) {
      assert.ok(versionWarning(bad, '0.1.0'), `“${bad}” is not a version`);
    }
  });

  it('reads a prerelease suffix by its numbers', () => {
    // `0.0.0-dev` is what an unbundled build calls itself, and it must not silently match
    // a real server.
    assert.ok(versionWarning('0.1.0', '0.0.0-dev'));
    assert.equal(versionWarning('0.1.0-rc1', '0.1.4'), null, 'same 0.1 line');
  });
});

describe('the version this build reports', () => {
  it('is a readable version, bundled or not', () => {
    // Under tsx there is no esbuild `define`, so this is the source-tree fallback. The
    // assertion that matters is that it is *parseable* — a plugin whose own version cannot
    // be read would warn against every server it ever met.
    assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(versionWarning(PLUGIN_VERSION), null, 'a build always agrees with itself');
  });
});
