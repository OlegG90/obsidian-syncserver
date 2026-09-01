/**
 * The route each account operation takes, which used to be a sentence above it.
 *
 * Three things are asserted, and each catches a different mistake this repository has actually made:
 *
 * - **which way in** — the rule that lived in ten docblocks and nowhere a check could reach;
 * - **what reaches the session** — two `string` arguments in the wrong order compile perfectly, and
 *   the plugin suite runs through `tsx`, which strips types rather than checking them;
 * - **what comes back** — a response envelope returned where its contents were meant, which is the
 *   shape of mistake `typecheck` caught in a test written earlier the same day.
 *
 * No session and no keys: the two ways in are functions, so a fake counts them.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openAccountAsks, type AccountAsks } from '../src/account-asks.js';

/** What the fake session and the fake handle were asked, in order. */
let asked: string[];
let seeds: number;
let handles: number;
let kept: number;

const session = {
  vaults: async () => [{ id: 'v1', name: 'Notes', nodes: 3, bytes: 9, shared: false, current: true }],
  deleteVault: async (id: string) => {
    asked.push(`deleteVault:${id}`);
    return { thawed: true };
  },
  createRecoveryCode: async () => ({ code: 'aaaa-bbbb', replaced: false }),
  approvePairing: async (code: string) => void asked.push(`approvePairing:${code}`),
  changePassphrase: async (current: string, next: string) => void asked.push(`changePassphrase:${current}>${next}`),
  adoptEnvelope: async (phrase: string) => void asked.push(`adoptEnvelope:${phrase}`),
};

const handle = {
  client: {
    devices: async () => ({ devices: [{ deviceId: 'd1' }, { deviceId: 'd2' }] }),
    revokeDevice: async (id: string) => void asked.push(`revokeDevice:${id}`),
    recoveryCodeState: async () => ({ present: true }),
  },
};

const open = (): AccountAsks =>
  openAccountAsks({
    seed: async () => {
      seeds += 1;
      return session as never;
    },
    handle: async (fn) => {
      handles += 1;
      return fn(handle as never);
    },
    keepEnvelope: async () => void (kept += 1),
  });

beforeEach(() => {
  asked = [];
  seeds = 0;
  handles = 0;
  kept = 0;
});

describe('the way in each ask takes', () => {
  // The whole table, in one place, which is what the ten docblocks could not be.
  const seeded: [string, (a: AccountAsks) => Promise<unknown>][] = [
    ['vaults', (a) => a.vaults()],
    ['deleteVault', (a) => a.deleteVault('v1')],
    ['createRecoveryCode', (a) => a.createRecoveryCode()],
    ['approvePairing', (a) => a.approvePairing('code')],
    ['changePassphrase', (a) => a.changePassphrase('old', 'new')],
    ['adoptPassphrase', (a) => a.adoptPassphrase('phrase')],
  ];

  const handled: [string, (a: AccountAsks) => Promise<unknown>][] = [
    ['devices', (a) => a.devices()],
    ['revokeDevice', (a) => a.revokeDevice('d1')],
    ['hasRecoveryCode', (a) => a.hasRecoveryCode()],
  ];

  for (const [name, run] of seeded) {
    it(`${name} unlocks, because it needs the seed`, async () => {
      await run(open());
      assert.equal(seeds, 1, `${name} did not unlock`);
      assert.equal(handles, 0, `${name} borrowed a handle instead of unlocking`);
    });
  }

  for (const [name, run] of handled) {
    it(`${name} borrows a handle, and never asks for a passphrase`, async () => {
      await run(open());
      assert.equal(handles, 1, `${name} did not borrow a handle`);
      assert.equal(seeds, 0, `${name} would ask for a passphrase to read a row`);
    });
  }
});

describe('what reaches the session', () => {
  it('carries the vault id through a delete', async () => {
    await open().deleteVault('v-42');
    assert.deepEqual(asked, ['deleteVault:v-42']);
  });

  it('carries the device id through a revoke', async () => {
    await open().revokeDevice('d-7');
    assert.deepEqual(asked, ['revokeDevice:d-7']);
  });

  // Two strings of the same type: the compiler cannot tell them apart, and swapping them would
  // offer the new passphrase as proof of the old one.
  it('keeps current and next in that order', async () => {
    await open().changePassphrase('the-old-one', 'the-new-one');
    assert.deepEqual(asked, ['changePassphrase:the-old-one>the-new-one']);
  });

  it('adopts through the envelope, which is the session method that does it', async () => {
    await open().adoptPassphrase('a-phrase');
    assert.deepEqual(asked, ['adoptEnvelope:a-phrase']);
  });
});

describe('what comes back', () => {
  it('answers devices with the rows, not the envelope around them', async () => {
    const rows = await open().devices();
    assert.ok(Array.isArray(rows), 'a response object was returned where its contents were meant');
    assert.equal(rows.length, 2);
  });

  it('answers hasRecoveryCode with the boolean', async () => {
    assert.equal(await open().hasRecoveryCode(), true);
  });

  it('passes the vault list through unchanged', async () => {
    const [only] = await open().vaults();
    assert.equal(only?.name, 'Notes');
  });
});

describe('the envelope a passphrase change replaces', () => {
  it('is kept after changing one', async () => {
    await open().changePassphrase('old', 'new');
    assert.equal(kept, 1, 'the new wrapped seed was never written down');
  });

  it('is kept after adopting one', async () => {
    await open().adoptPassphrase('phrase');
    assert.equal(kept, 1);
  });

  // The order is the point: keeping an envelope the server has not accepted yet would write down
  // a seed wrapped under a passphrase this account does not have.
  it('is kept AFTER the session has accepted the change, not before', async () => {
    let keptAt = -1;
    const asks = openAccountAsks({
      seed: async () => ({ changePassphrase: async () => void asked.push('session') }) as never,
      handle: async () => undefined as never,
      keepEnvelope: async () => {
        keptAt = asked.length;
      },
    });
    await asks.changePassphrase('old', 'new');
    assert.equal(keptAt, 1, 'the envelope was kept before the session accepted the change');
  });

  it('is not kept by an ask that changes nothing stored here', async () => {
    await open().vaults();
    await open().devices();
    assert.equal(kept, 0);
  });
});
