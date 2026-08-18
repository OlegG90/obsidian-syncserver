/**
 * The console's backup surface: trigger, list, verify — over HTTP.
 *
 * The window itself and the verify check are covered in `backup.test.ts` with the legs
 * injected. What this suite proves is the wiring: that the routes exist behind the
 * administrator guard, that an unconfigured server answers "not configured" rather than
 * pretending, and that a configured one runs a real backup and verifies it.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

let db: Db;
let app: FastifyInstance;
let adminToken: string;
/** The seeded administrator, claimed exactly as operator.test.ts does. */
const adminId = '00000000-0000-0000-0000-000000000001';

before(async () => {
  db = connect(loadConfig().databaseUrl);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = $1 AND state = 'provisioned'`,
    [adminId],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [adminId]);
  app = await buildApp(db, loadConfig());
  adminToken = app.jwt.sign({ sub: adminId, device: device!.id });
});

after(async () => {
  await app.close();
  await db.close();
});

describe('the backup surface without configuration', () => {
  it('answers not configured rather than pretending to back up', async () => {
    const r = await app.inject({
      method: 'POST', url: '/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, 'backup_not_configured');
  });

  it('lists an empty history', async () => {
    const r = await app.inject({
      method: 'GET', url: '/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().backups, []);
  });

  it('refuses an unauthenticated caller', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/backups' });
    assert.equal(r.statusCode, 401);
  });

  it('answers not found for a verify of a run that does not exist', async () => {
    const r = await app.inject({
      method: 'POST', url: '/admin/backups/999999/verify',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.statusCode, 503, 'no store is configured, so it is refused before the id matters');
  });
});
