/**
 * Naming a folder that is about to land, which used to happen inside a closure in `main.ts`.
 *
 * Every case here was previously reachable only by accepting a real invitation against a real server
 * with a real dialog open. The rules are small; that is not the same as obvious, and three of the
 * four are the kind that reads fine and behaves wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { landingFor } from '../src/share-landing.js';

/** A vault with a few notes and folders, as the walked tree reports paths. */
const vault = ['Notes', 'Notes/a.md', 'Projects', 'Projects/HomeLab/x.md', 'inbox.md'];

describe('what to offer', () => {
  it('names the person who invited you', () => {
    assert.equal(landingFor(vault, 'oleh').suggestion, 'Shared by oleh');
  });

  it('says someone when the server did not say who', () => {
    assert.equal(landingFor(vault, undefined).suggestion, 'Shared by someone');
  });

  /**
   * Offering a taken name means the person accepts the suggestion and gets something else — which
   * reads as the plugin ignoring what they pressed.
   */
  it('offers a name that is already free', () => {
    const taken = [...vault, 'Shared by oleh'];
    assert.equal(landingFor(taken, 'oleh').suggestion, 'Shared by oleh 2');
    assert.equal(landingFor([...taken, 'Shared by oleh 2'], 'oleh').suggestion, 'Shared by oleh 3');
  });
});

describe('what to do with the answer', () => {
  it('takes a free name as given', () => {
    assert.equal(landingFor(vault, 'oleh').settle('Recipes'), 'Recipes');
  });

  it('moves aside from a folder that is already there', () => {
    assert.equal(landingFor(vault, 'oleh').settle('Notes'), 'Notes 2');
  });

  it('trims, because a trailing space is not a different folder', () => {
    assert.equal(landingFor(vault, 'oleh').settle('  Recipes  '), 'Recipes');
  });

  /**
   * Somebody who cleared the box and pressed accept has not chosen the suggestion. Landing
   * `Shared by someone` on that would be the plugin deciding something it was told nothing about.
   */
  it('refuses a blank answer rather than falling back to the suggestion', () => {
    for (const blank of ['', '   ', '\t']) {
      assert.throws(() => landingFor(vault, 'oleh').settle(blank), /a name is needed/);
    }
  });
});

describe('what counts as being in the way', () => {
  /**
   * A replica lands at the vault root, so only the top level can collide. Counting nested paths
   * would push a perfectly free name to `… 2` because something four folders down shares its name —
   * and the person would have no way to see why.
   */
  it('ignores everything below the top level', () => {
    const deep = ['Notes/Shared by oleh', 'Projects/HomeLab/Shared by oleh', 'a/b/c/Recipes'];
    assert.equal(landingFor(deep, 'oleh').suggestion, 'Shared by oleh', 'nested namesakes are not siblings');
    assert.equal(landingFor(deep, 'oleh').settle('Recipes'), 'Recipes');
  });

  it('counts a top-level file, because a folder cannot take its name either', () => {
    assert.equal(landingFor(['inbox.md'], 'oleh').settle('inbox.md'), 'inbox.md 2');
  });

  /**
   * One value, two answers, one set. Built as two calls that each computed their own siblings, this
   * is the case that would drift: a suggestion checked against one set and an answer against another.
   */
  it('governs the suggestion and the answer by the same siblings', () => {
    const landing = landingFor([...vault, 'Shared by oleh'], 'oleh');
    assert.equal(landing.suggestion, 'Shared by oleh 2');
    assert.equal(landing.settle('Shared by oleh'), 'Shared by oleh 2', 'the answer sees what the offer saw');
  });
});
