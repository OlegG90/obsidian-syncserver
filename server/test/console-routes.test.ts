/**
 * Every route the management console calls, answered by a route this server has.
 *
 * The console is a separate bundle talking to `/admin/*` by path, so nothing ties the two
 * together at compile time. The Reissue button POSTed to `/admin/invitations/:id` while the
 * server's route was `/admin/invitations/:id/reissue`, and every reissue answered 404 — for as
 * long as the button existed, with the server's own tests passing against the right path.
 *
 * So this reads the console's calls out of `console/src/api.ts` — every one is written
 * `call('METHOD', 'path')` — and asks the real app about each. It does not care what the route
 * says, only that one exists: Fastify's own "Route … not found" is the one answer that means the
 * client and the server disagree about the path. Needs the development database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

const API = new URL('../../console/src/api.ts', import.meta.url);

/** `call('GET', '/admin/x')` and `` call('POST', `/admin/x/${id}`) ``, with every placeholder filled. */
const consoleCalls = (): { method: string; url: string }[] => {
  const source = readFileSync(API, 'utf8');
  const calls = [...source.matchAll(/call\('(GET|POST|PUT|DELETE)',\s*[`']([^`']+)[`']/g)].map((m) => ({
    method: m[1]!,
    url: m[2]!.replace(/\$\{[^}]+\}/g, randomUUID()).split('?')[0]!,
  }));
  return calls;
};

let db: Db;
let app: FastifyInstance;

before(async () => {
  db = connect(loadConfig().databaseUrl);
  // Claimed, so the first-run guard does not answer every path the same way.
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );
  app = await buildApp(db, loadConfig());
});

after(async () => {
  await app.close();
  await db.close();
});

describe('the console and the server agree on paths', () => {
  it('finds every call the console makes', () => {
    // A pattern that matched nothing would pass the test below by asking about nothing.
    assert.ok(consoleCalls().length >= 20, `read ${consoleCalls().length} calls out of console/src/api.ts`);
  });

  it('has a route for each of them', async () => {
    const missing: string[] = [];
    for (const { method, url } of consoleCalls()) {
      const r = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      const body = r.statusCode === 404 ? (r.json() as { message?: string }) : {};
      if (body.message?.startsWith('Route ')) missing.push(`${method} ${url}`);
    }
    assert.deepEqual(missing, [], 'the console calls paths this server does not serve');
  });
});
