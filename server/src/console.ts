/**
 * The console, served by the server that it administers.
 *
 * "One deployment, one session" ([11](docs/11-management-console.md)) read literally: the
 * same process, the same origin, the same version, and the same `/health`. A second
 * container would be a moving part that document already refuses, and a second origin would
 * buy CORS and a token in two places for nothing.
 *
 * **Read once at boot, held in memory.** Two files and a few tens of kilobytes: a static
 * handler that stats the disk per request would be machinery for a problem this does not
 * have, and the bundle cannot change under a running process anyway — it is baked into the
 * image beside the server.
 *
 * **Absent is not an error.** A development checkout has no `console/dist` until somebody
 * builds it, and a server that refused to start over a missing web page would make the API
 * hostage to a front end nobody asked for. The path answers a sentence saying how to build
 * it instead.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** Where the console's build lands, relative to this file once compiled into `server/dist`. */
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../console/dist');

/**
 * What the console's page may load, enforced by the responses below rather than by the bundle.
 *
 * The page holds both console tokens in memory (D-102), so script running in it holds them too.
 * The bundle builds no markup from strings and fetches same-origin only — but those are conditions,
 * and this is the guarantee: script from this origin only, style inline or same-origin, data and
 * images same-origin only, no base to hijack, no form target to exfiltrate to, and no framing at all.
 */
export const CONSOLE_CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self'; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'";

/** The four response headers the console's two paths carry, and why each is there. */
export const CONSOLE_SECURITY_HEADERS: Record<string, string> = {
  // Script and style as above; `frame-ancestors 'none'` so the page cannot be framed into
  // somewhere that reads its pixels or its clicks.
  'content-security-policy': CONSOLE_CSP,
  // The old spelling of the same refusal, for browsers that do not read `frame-ancestors`.
  'x-frame-options': 'DENY',
  // A script served as `text/html` by a misconfigured proxy would otherwise run as script.
  'x-content-type-options': 'nosniff',
  // The page's URLs name administrative things; no destination needs to receive them.
  'referrer-policy': 'no-referrer',
};

const MISSING =
  '<!doctype html><meta charset="utf-8"><title>SyncServer</title>' +
  '<p style="font:15px/1.5 system-ui;margin:3rem auto;max-width:30rem">' +
  'The console has not been built. Run <code>npm run build --workspace @syncserver/console</code>.';

/** The two paths the page is made of. Anything else here would be a route, not a file. */
export const CONSOLE_PATHS = ['/', '/app.js'] as const;

export const registerConsoleRoutes = async (app: FastifyInstance): Promise<void> => {
  const read = async (name: string): Promise<string | undefined> =>
    readFile(path.join(DIST, name), 'utf8').catch(() => undefined);

  const page = (await read('index.html')) ?? MISSING;
  const bundle = await read('app.js');

  app.get('/', async (_req, reply) => {
    for (const [name, value] of Object.entries(CONSOLE_SECURITY_HEADERS)) reply.header(name, value);
    return reply.type('text/html; charset=utf-8').send(page);
  });

  app.get('/app.js', async (_req, reply) => {
    for (const [name, value] of Object.entries(CONSOLE_SECURITY_HEADERS)) reply.header(name, value);
    if (bundle === undefined) return reply.code(404).send({ error: 'console_not_built' });
    return reply.type('application/javascript; charset=utf-8').send(bundle);
  });
};
