/**
 * What `.env` has to say before this server will start.
 *
 * This file exists because of a defect no other test could have caught: nothing else here loads a
 * configuration the way a deployment does. The backup trio was "all or none", which was right while
 * all three variables were empty by default — and stopped being right the moment `BACKUP_DB_COMMAND`
 * was given a working one, because then one of the three is ALWAYS set and every unconfigured
 * deployment read as a half-configured one. The server refused to boot, in a restart loop, on a NAS,
 * with the fault in a variable the operator had never touched.
 *
 * The rule that replaced it made the **destination** decide, and it is gone too (issue #219): a switch
 * for backups answered a question this server stopped asking when backups stopped happening on a
 * schedule (D-121). What is left is the rule these cases hold to — **an `.env` says what only this
 * machine can say**, and every path and binary inside the image has a working default.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

/** Restored after each case, so one test cannot bleed into the next. */
const KEYS = ['BACKUP_DESTINATION', 'BACKUP_DB_COMMAND', 'BLOB_STORE_PATH'] as const;
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

describe('what a deployment has to say about backups', () => {
  it('is nothing: a bare server can take one, and says where it would land', () => {
    // The whole of issue #219 in one case. An operator who names four directories and a password gets
    // a server that backs up; the two variables that used to be mandatory named a path inside the
    // image and a directory the server already knew.
    set({});

    const backup = loadConfig().backup;
    assert.equal(backup.destination, 'var/backups');
    assert.deepEqual(backup.dumpCommand, ['pg_dump', '--format=custom'], 'split on whitespace, as a command');
  });

  it('takes the destination and the dump command from the environment when they are named', () => {
    set({ BACKUP_DESTINATION: '/backups', BACKUP_DB_COMMAND: 'pg_dump --format=custom -Z 9' });

    const backup = loadConfig().backup;
    assert.equal(backup.destination, '/backups');
    assert.deepEqual(backup.dumpCommand, ['pg_dump', '--format=custom', '-Z', '9']);
  });

  it('has no second name for the blob store', () => {
    // `BACKUP_BLOB_SOURCE` is gone rather than defaulted: the backup copies the LIVE store, so the
    // configuration already holds that directory, and a second variable for it was a fact a
    // deployment could answer twice and disagree with itself.
    set({ BLOB_STORE_PATH: '/data/blobs' });

    assert.equal(loadConfig().blobStorePath, '/data/blobs');
    assert.equal(process.env['BACKUP_BLOB_SOURCE'], undefined, 'nothing here sets it, and nothing reads it');
  });
});
