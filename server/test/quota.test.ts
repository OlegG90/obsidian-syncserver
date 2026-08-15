/**
 * The quota rule, on its own terms.
 *
 * These do not go through a route, on purpose. What the module exists for is that the
 * number `GET /usage` reports and the number that refuses an upload are the same number;
 * a test that entered through either endpoint would be testing that endpoint, and the
 * drift the module prevents happens *between* them.
 *
 * Needs the development database — `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { fits, usageOf } from '../src/quota.js';

const cfg = loadConfig();
let db: Db;

const sha = () => createHash('sha256').update(randomBytes(32)).digest();

/** An account with a quota, and nothing held. */
const makeAccount = async (quotaBytes: number): Promise<string> => {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', $3)`,
    [userId, `quota-${randomUUID()}`, quotaBytes],
  );
  return userId;
};

/** A blob of `size` bytes, held by `userId` — the only thing AC-Q2 counts. */
const hold = async (userId: string, size: number): Promise<Buffer> => {
  const address = sha();
  await db.query(
    `INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
     VALUES ($1, $2, $3, 'xchacha20-poly1305', $4)`,
    [address, size, address.toString('hex'), randomUUID()],
  );
  await db.query(
    `INSERT INTO user_blobs (user_id, sha256, refs_own) VALUES ($1, $2, 1)`,
    [userId, address],
  );
  return address;
};

before(async () => {
  db = connect(cfg.databaseUrl);
});

after(async () => {
  await db.close();
});

describe('the quota rule (AC-Q2)', () => {
  it('counts SUM(size) over the blobs the account holds, and nothing else', async () => {
    const userId = await makeAccount(1_000_000);
    assert.deepEqual(await usageOf(db, userId), { used: 0n, quota: 1_000_000n });

    await hold(userId, 400);
    await hold(userId, 600);

    const usage = await usageOf(db, userId);
    assert.equal(usage!.used, 1000n, 'two blobs, summed');

    // A blob somebody ELSE holds is on the server and is not this account's usage.
    const stranger = await makeAccount(1_000_000);
    await hold(stranger, 5000);
    assert.equal((await usageOf(db, userId))!.used, 1000n, 'usage is per account, not per server');
  });

  it('refuses what does not fit, and accepts what exactly does', async () => {
    const userId = await makeAccount(1000);
    await hold(userId, 900);

    assert.equal(await fits(db, userId, sha(), 101), false, 'one byte over');
    assert.equal(await fits(db, userId, sha(), 100), true, 'exactly full still fits');
  });

  it('charges nothing for content the account already holds (#46)', async () => {
    // The account is full. Sending the same bytes again must still be accepted: the address
    // IS the content, so a second copy adds nothing to the disk, and charging for it would
    // bill the same bytes twice at the boundary where being wrong refuses a legitimate write.
    const userId = await makeAccount(1000);
    const held = await hold(userId, 1000);

    assert.equal(await fits(db, userId, held, 1000), true, 'zero growth, so it fits a full account');
    assert.equal(await fits(db, userId, sha(), 1), false, 'while one new byte does not');
  });

  it('reports and enforces the same number, which is the whole point of one module', async () => {
    // Walk the account up to its limit and check at every step that "what is left" as the
    // surface reports it agrees with what the intake will actually accept. A second SQL
    // form for either side would have to disagree somewhere along here.
    const userId = await makeAccount(1000);
    for (const size of [100, 250, 300]) {
      await hold(userId, size);
      const { used, quota } = (await usageOf(db, userId))!;
      const left = Number(quota - used);
      assert.equal(await fits(db, userId, sha(), left), true, `${left} left, so ${left} fits`);
      assert.equal(await fits(db, userId, sha(), left + 1), false, `but ${left + 1} does not`);
    }
  });

  it('fails closed on an account that does not exist', async () => {
    const nobody = randomUUID();
    assert.equal(await usageOf(db, nobody), undefined);
    assert.equal(await fits(db, nobody, sha(), 1), false, 'no account, no room — never a default yes');
  });
});
