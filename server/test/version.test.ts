/**
 * The server's own version, read rather than compiled in (#111).
 *
 * The interesting failure is not the number — it is the **path**. `version.ts` resolves
 * `../package.json` relative to itself, which has to mean `server/package.json` from three
 * different places: `src/` under tsx here, `dist/` under node in production, and `/app/server/`
 * inside the image. `rootDir` and `outDir` sit at the same depth so one relative path covers
 * all three, but that is a property of the tsconfig, and a tsconfig can be edited.
 *
 * A broken path does not throw at the request — it throws at import, taking the whole server
 * down on start. Asserting it here costs nothing and needs no database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { SERVER_VERSION } from '../src/version.js';

describe('the release this server reports', () => {
  it('is the one npm has recorded, read from the file npm keeps', () => {
    const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

    assert.equal(SERVER_VERSION, declared);
    assert.notEqual(SERVER_VERSION, '0.0.0', 'the fallback means the manifest was not found');
  });

  it('is major.minor.patch, which is what the client parses', () => {
    // The plugin reads the first two components and refuses to guess at anything it cannot
    // parse — so a version that fails this makes every client warn against this server.
    assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });
});
