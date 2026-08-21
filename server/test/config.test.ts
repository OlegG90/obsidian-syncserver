/**
 * What `.env` has to say before this server will start.
 *
 * This file exists because of a defect no other test could have caught: nothing else here
 * loads a configuration the way a deployment does. The backup trio was "all or none", which
 * was right while all three variables were empty by default — and stopped being right the
 * moment `BACKUP_DB_COMMAND` was given a working one, because then one of the three is
 * ALWAYS set and every unconfigured deployment read as a half-configured one. The server
 * refused to boot, in a restart loop, on a NAS, with the fault in a variable the operator
 * had never touched.
 *
 * The rule is now: the **destination** decides. Where a copy goes is the part only this
 * installation knows; how to dump and where the blobs live have sensible defaults or are
 * answerable from the deployment.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

/** The three that decide, restored after each case so one test cannot bleed into the next. */
const KEYS = ['BACKUP_DESTINATION', 'BACKUP_DB_COMMAND', 'BACKUP_BLOB_SOURCE', 'BACKUP_KEEP'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

const set = (values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void => {
  for (const k of KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('whether this deployment takes backups', () => {
  it('is not configured when no destination is named, whatever else is set', () => {
    // The regression, exactly: `BACKUP_DB_COMMAND` ships with a working default now, so this
    // is what an ordinary deployment looks like — and it must be a running server with the
    // console's button saying "not configured", not a refusal to start.
    set({ BACKUP_DB_COMMAND: 'pg_dump --format=custom' });

    assert.equal(loadConfig().backup, undefined);
  });

  it('is not configured when nothing at all is set', () => {
    set({});
    assert.equal(loadConfig().backup, undefined);
  });

  it('is configured when a destination is named and the rest is answerable', () => {
    set({
      BACKUP_DESTINATION: '/backups',
      BACKUP_DB_COMMAND: 'pg_dump --format=custom',
      BACKUP_BLOB_SOURCE: '/data/blobs',
    });

    const backup = loadConfig().backup;
    assert.equal(backup?.destination, '/backups');
    assert.deepEqual(backup?.dumpCommand, ['pg_dump', '--format=custom'], 'split on whitespace, as a command');
    assert.equal(backup?.blobSource, '/data/blobs');
  });

  it('refuses a destination with nowhere to copy the blobs from', () => {
    // The half-configuration that IS worth refusing: a run that cannot find the blobs fails
    // halfway, having already opened a window and stopped the server accepting writes.
    set({ BACKUP_DESTINATION: '/backups', BACKUP_DB_COMMAND: 'pg_dump' });

    assert.throws(() => loadConfig(), /BACKUP_BLOB_SOURCE/);
  });

  it('refuses a destination with no way to dump', () => {
    set({ BACKUP_DESTINATION: '/backups', BACKUP_BLOB_SOURCE: '/data/blobs' });

    assert.throws(() => loadConfig(), /BACKUP_DB_COMMAND/);
  });
});

describe('how many copies to keep', () => {
  const configured = { BACKUP_DESTINATION: '/backups', BACKUP_DB_COMMAND: 'pg_dump', BACKUP_BLOB_SOURCE: '/data/blobs' };

  it('treats an EMPTY value as unset, like every other variable this file reads', () => {
    // `docker compose` passes `${BACKUP_KEEP:-}` as an empty string when nobody has set it,
    // and this block was the only reader here that did not know `''` means absent. The server
    // refused to boot — in a restart loop, on a NAS, over a variable the operator had never
    // touched. Which is the failure the docblock at the top of this file describes, one
    // variable earlier.
    set({ ...configured, BACKUP_KEEP: '' });
    assert.equal(loadConfig().backup?.keep, undefined);
    set({ ...configured, BACKUP_KEEP: '   ' });
    assert.equal(loadConfig().backup?.keep, undefined, 'and whitespace is the same kind of nothing');
  });

  it('keeps a number', () => {
    set({ ...configured, BACKUP_KEEP: '7' });
    assert.equal(loadConfig().backup?.keep, 7);
  });

  it('refuses what is neither, and shows what it was given', () => {
    // A rejected value has to be quotable: "must be a whole number" over an invisible string
    // is what makes this class of fault take an hour instead of a minute.
    set({ ...configured, BACKUP_KEEP: 'seven' });
    assert.throws(() => loadConfig(), /got "seven"/);
    set({ ...configured, BACKUP_KEEP: '0' });
    assert.throws(() => loadConfig(), /at least 1/);
  });

  it('is unset when there are no backups at all', () => {
    set({ BACKUP_KEEP: '7' });
    assert.equal(loadConfig().backup, undefined, 'no destination, no backups, nothing to keep');
  });
});
