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
// A backup with nowhere on the host to land writes into the container's writable layer and
// disappears with the next pull. The mount is what makes BACKUP_DESTINATION mean anything.
check(mounts(server).includes('/backups'), 'server must mount a backup destination');

// Every value that differs between installations comes from .env, so a deployment is a
// .env and never an edit to the compose file.
for (const [name, value] of Object.entries({ ...(db?.environment ?? {}), ...(server?.environment ?? {}) })) {
  if (!/PASSWORD|SECRET/.test(name)) continue;
  check(String(value).startsWith('${'), `${name} must come from the environment, not be written here`);
}

// The backup variables are all-or-nothing, defaulted to empty so an unset deployment is a
// truthful "not configured" rather than a secret or a path written here.
for (const name of ['BACKUP_DESTINATION', 'BACKUP_DB_COMMAND', 'BACKUP_BLOB_SOURCE']) {
  check(
    String(server?.environment?.[name] ?? '').startsWith('${'),
    `${name} must come from the environment, not be written here`,
  );
}

// Both secrets must fail loudly when unset rather than default to something.
for (const required of ['POSTGRES_PASSWORD', 'SERVER_SECRET']) {
  check(
    new RegExp(`\\$\\{${required}:\\?`).test(text),
    `${required} must use \${${required}:?…} so compose refuses to start without it`,
  );
}

// The image comes from CI, pinned to a version in .env — never built on the target and
// never `latest`. `latest` names a moving target a specific installation cannot be rolled
// back to. The `:?` makes an unset SERVER_IMAGE a refusal rather than a surprise pull of
// whatever compose decided.
check(
  /\$\{SERVER_IMAGE:\?/.test(text),
  'SERVER_IMAGE must come from .env with ${SERVER_IMAGE:?…}, never a default',
);
check(/image: \$\{SERVER_IMAGE/.test(text), 'server must pull the published image, not build one');
check(!/\n\s+build:/.test(text), 'the deployment compose file must not build — see docker-compose.dev.yml');

// The local-build override exists so development can run the source; it must be the
// mirror image of the above — a build, of the same image name.
const dev = readFileSync('docker-compose.dev.yml', 'utf8');
check(/\n\s+build: \./.test(dev), 'docker-compose.dev.yml must provide the build the deployment file lacks');
check(/image: syncserver:dev/.test(dev), 'docker-compose.dev.yml must name the same image for the switch back');

/**
 * The two PostgreSQL majors that must agree, and live in two different files.
 *
 * `pg_dump` refuses a server newer than itself outright, and an older one produces a dump
 * that restores into something subtly different — so the client in the image has to be the
 * same major as the database the compose file runs. `assertPgDumpMatches` checks the pair at
 * startup, which is the check that matters; this one catches the same drift a build earlier,
 * where it is one line to fix rather than a deployment that comes up unable to back itself up.
 *
 * Static on purpose: this whole file exists because the machine it runs on has no Docker.
 */
const dbMajor = /image:\s*postgres:(\d+)/.exec(text)?.[1];
const clientMajor = /apk add [^\n]*postgresql(\d+)-client/.exec(readFileSync('Dockerfile', 'utf8'))?.[1];
check(dbMajor !== undefined, 'docker-compose.yml must pin a postgres major, e.g. postgres:18-alpine');
check(clientMajor !== undefined, 'the Dockerfile runtime stage must install a pinned postgresqlNN-client');
check(
  dbMajor === undefined || clientMajor === undefined || dbMajor === clientMajor,
  `pg_dump major ${clientMajor} in the Dockerfile does not match postgres:${dbMajor} in ${file} — ` +
    'a backup on this deployment would fail the moment it was asked',
);

if (problems.length > 0) {
  console.error(`${file}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `${file}: two services, ordered on health, both mounts, no secrets written down, pulled not built; ` +
    `pg_dump ${clientMajor} matches postgres ${dbMajor}`,
);
