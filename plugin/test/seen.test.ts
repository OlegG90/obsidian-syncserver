/**
 * The same words the console prints, on the plugin's side (#386).
 *
 * Two bundles, no runtime code between them — `shared` is declarations only, deliberately —
 * so what keeps the two copies in step is that both are tested against the same sentences.
 * A change to one that does not reach the other fails here or there, not on a screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aboutSpan, seenLine, seenNote } from '../src/seen.js';

describe('when a device was last seen (#386)', () => {
  const TTL = 15 * 60;
  const now = Date.parse('2026-09-23T12:00:00Z');
  const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

  it('says the interval the reading is good to, not the instant', () => {
    assert.equal(seenLine(ago(1), TTL, now), 'seen in the last 15 minutes');
    assert.equal(seenLine(ago(14), TTL, now), 'seen in the last 15 minutes');
  });

  it('takes the interval from the server rather than assuming fifteen minutes', () => {
    assert.equal(seenLine(ago(40), 60 * 60, now), 'seen in the last hour');
    assert.equal(seenLine(ago(4), 5 * 60, now), 'seen in the last 5 minutes');
  });

  it('reads a device that has genuinely gone quiet as hours and days', () => {
    assert.equal(seenLine(ago(90), TTL, now), 'seen about 2 hours ago');
    assert.equal(seenLine(ago(60 * 5), TTL, now), 'seen about 5 hours ago');
    assert.equal(seenLine(ago(60 * 26), TTL, now), 'seen about a day ago');
    assert.equal(seenLine(ago(60 * 24 * 9), TTL, now), 'seen 9 days ago');
  });

  it('does not report a clock a little ahead of ours as a negative age', () => {
    assert.equal(seenLine(new Date(now + 30_000).toISOString(), TTL, now), 'seen in the last 15 minutes');
  });

  it('says plainly when a device has never been seen', () => {
    assert.equal(seenLine(null, TTL, now), 'not seen since it was added');
    assert.equal(seenLine('not a date', TTL, now), 'not seen since it was added');
  });

  it('explains why a device that is syncing can read as idle', () => {
    assert.match(seenNote(TTL), /renews its session, about once every 15 minutes/);
    assert.match(seenNote(60 * 60), /about once every hour/);
    assert.match(seenNote(TTL), /syncing right now can read as seen a few minutes ago/);
  });
});

describe('a span in words', () => {
  it('rounds to units a person reads, never seconds', () => {
    assert.equal(aboutSpan(900), '15 minutes');
    assert.equal(aboutSpan(3600), 'hour');
    assert.equal(aboutSpan(2 * 3600), '2 hours');
    assert.equal(aboutSpan(30), 'minute');
  });
});
