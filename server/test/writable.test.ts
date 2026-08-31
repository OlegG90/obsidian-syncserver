/**
 * The startup check that turns a wrong mount into a sentence.
 *
 * Needs no database: it is a question about directories.
 *
 * **Two of these need a filesystem that enforces permissions, and the development machine
 * here does not.** The repository sits on a Windows drive mounted into WSL as `v9fs`, where
 * `chmod 0555` returns success and changes nothing — so a test that sealed a directory and
 * expected a refusal would fail for a reason that has nothing to do with the code. Rather
 * than assume, the seal is attempted once at load and checked; where it does not take, those
 * two skip and say why, and CI runs them on ext4.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertWritable } from '../src/writable.js';
import { testStore } from './support/store.js';

const ROOT = testStore('writable');

const sealingWorks = ((): boolean => {
  const probe = join(ROOT, 'probe');
  mkdirSync(probe, { recursive: true });
  chmodSync(probe, 0o555);
  try {
    mkdirSync(join(probe, 'inner'));
    return false; // the seal did not take: this filesystem does not enforce it
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o755);
    rmSync(probe, { recursive: true, force: true });
  }
})();

const unenforced = { skip: sealingWorks ? false : 'this filesystem does not enforce directory permissions' };

after(async () => {
  await chmod(join(ROOT, 'sealed'), 0o755).catch(() => {});
  await rm(ROOT, { recursive: true, force: true });
});

describe('a directory the server must write', () => {
  it('is created when it is missing, rather than demanded', async () => {
    const dir = join(ROOT, 'not', 'there', 'yet');
    await assertWritable([{ what: 'the blob store', dir, setting: 'BLOB_STORE_PATH' }]);
    assert.ok((await stat(dir)).isDirectory());
  });

  it('passes when it exists already', async () => {
    const dir = join(ROOT, 'existing');
    await mkdir(dir, { recursive: true });
    await assertWritable([{ what: 'the blob store', dir, setting: 'BLOB_STORE_PATH' }]);
  });

  it('says which setting to change when it cannot be created', unenforced, async () => {
    const sealed = join(ROOT, 'sealed');
    await mkdir(sealed, { recursive: true });
    await chmod(sealed, 0o555);

    const err = await assertWritable([
      { what: 'the restore state file', dir: join(sealed, 'state'), setting: 'RESTORE_STATE_FILE' },
    ]).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    assert.ok(err, 'a directory under a read-only parent was accepted');
    // The three things the person reading it needs: what broke, where, and what to change.
    assert.match(err.message, /the restore state file is not writable/);
    assert.match(err.message, /sealed.state/);
    assert.match(err.message, /RESTORE_STATE_FILE/);
  });

  it('names the first failure and does not go on', unenforced, async () => {
    const sealed = join(ROOT, 'sealed');
    await mkdir(sealed, { recursive: true });
    await chmod(sealed, 0o555);

    const err = await assertWritable([
      { what: 'the restore state file', dir: join(sealed, 'one'), setting: 'RESTORE_STATE_FILE' },
      { what: 'the backup destination', dir: join(sealed, 'two'), setting: 'BACKUP_DESTINATION' },
    ]).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    assert.ok(err);
    assert.match(err.message, /RESTORE_STATE_FILE/);
    assert.doesNotMatch(err.message, /BACKUP_DESTINATION/);
  });
});
