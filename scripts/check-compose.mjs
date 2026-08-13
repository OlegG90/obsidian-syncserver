/**
 * Check docker-compose.yml without Docker.
 *
 * The machine this is developed on has no Docker, so the deployment file would otherwise
 * be verified for the first time on the server it is meant to bring up. This parses it and
 * asserts the shape the deployment depends on — two containers, an ordering that waits for
 * health, both bind mounts, and no secret written down.
 *
 * It is not a substitute for `docker compose config`; it is what can be checked here.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const file = 'docker-compose.yml';
const text = readFileSync(file, 'utf8');
const doc = parse(text);
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

const services = Object.keys(doc.services ?? {});
check(services.length === 2, `expected exactly two services, found ${services.length}: ${services.join(', ')}`);
check(services.includes('db') && services.includes('server'), 'expected services named db and server');

const { db, server } = doc.services ?? {};

// Not "started": the server reads the seeded rows at boot, so against a database still
// initialising it comes up and answers wrongly.
check(
  server?.depends_on?.db?.condition === 'service_healthy',
  'server must depend on db with condition: service_healthy',
);
check(Array.isArray(db?.healthcheck?.test), 'db needs a healthcheck, or the condition above can never be met');

/**
 * The container path of a bind mount, which is not simply "the part after the first
 * colon": a host side written as `${DB_DIR:-./data/db}` contains one of its own, and a
 * `:ro` puts another at the end.
 */
const mounts = (svc) =>
  (svc?.volumes ?? []).map((v) => {
    const parts = String(v).split(':');
    const last = parts[parts.length - 1];
    return last === 'ro' || last === 'rw' ? parts[parts.length - 2] : last;
  });
// The exact path matters: from 18 the image owns the version subdirectory below it, and
// mounting /var/lib/postgresql/data instead makes it refuse to start.
check(mounts(db).includes('/var/lib/postgresql'), 'db must mount /var/lib/postgresql, not the data directory inside it');
check(mounts(server).includes('/data/blobs'), 'server must mount the blob directory');

// Every value that differs between installations comes from .env, so a deployment is a
// .env and never an edit to the compose file.
for (const [name, value] of Object.entries({ ...(db?.environment ?? {}), ...(server?.environment ?? {}) })) {
  if (!/PASSWORD|SECRET/.test(name)) continue;
  check(String(value).startsWith('${'), `${name} must come from the environment, not be written here`);
}

// Both secrets must fail loudly when unset rather than default to something.
for (const required of ['POSTGRES_PASSWORD', 'SERVER_SECRET']) {
  check(
    new RegExp(`\\$\\{${required}:\\?`).test(text),
    `${required} must use \${${required}:?…} so compose refuses to start without it`,
  );
}

if (problems.length > 0) {
  console.error(`${file}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${file}: two services, ordered on health, both mounts, no secrets written down`);
