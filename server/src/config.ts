/**
 * Configuration, and the defaults documented in docs/04-sync-protocol.md.
 *
 * The numbers live here rather than scattered through the code because they are a
 * documented contract, not tuning knobs someone can move in one place and forget in
 * another.
 */

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return n;
};

const str = (name: string, fallback?: string): string => {
  const raw = process.env[name];
  if (raw !== undefined && raw !== '') return raw;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} must be set`);
};

export interface Config {
  /** Undefined when the environment describes the connection in PG* variables instead. */
  databaseUrl: string | undefined;
  /**
   * Signs access tokens, the delta cursor and the fake salt an unknown login receives
   * (#73). One secret with three uses, because all three are "the server proving it
   * produced this" and none of them ever leaves the server.
   *
   * A development default exists so the first run needs no ceremony; production must set
   * it, and the server says so loudly at startup rather than silently signing with a
   * value that is public knowledge.
   */
  serverSecret: string;
  serverSecretIsDefault: boolean;
  /** Where blobs live. Content only — metadata is in PostgreSQL, and the split is what makes rename, sharing and dedup cheap (#1). */
  blobStorePath: string;
  accessTokenTtlSeconds: number;
  limits: {
    /** docs/04: 200 MB/min per account. */
    uploadBytesPerMinute: number;
    /** docs/04: 2 GB of unfinished uploads per account. */
    unfinishedUploadBytes: number;
    /** docs/04: 24 h on abandoned parts. Strictly below the next one — see below. */
    abandonedPartTtlSeconds: number;
    /**
     * docs/04: 48 h on an unbound blob. It MUST stay above the parts TTL: reversed, the
     * blob is swept while its own upload is still running and the client retries into the
     * same wall for ever. Checked at startup rather than trusted.
     */
    unboundBlobTtlSeconds: number;
    /** docs/04: 90 days on the delta journal. */
    journalTtlSeconds: number;
  };
  /**
   * How often the collector wakes. Operational, not a protocol contract: it decides only
   * how promptly a swept blob disappears, never what gets swept.
   */
  sweepIntervalSeconds: number;
}

const DEV_SECRET = 'development-only-server-secret';

export const loadConfig = (): Config => {
  const cfg: Config = {
    // Three cases, in order. An explicit DATABASE_URL wins. Failing that, PGHOST means
    // the environment already describes the connection in discrete variables — which is
    // what the container uses, because a password does not have to be escaped into
    // anything there. Failing both, the development socket: that is how the local
    // PostgreSQL authenticates (peer), and over TCP it would demand a password and say
    // only "client password must be a string".
    databaseUrl:
      process.env['DATABASE_URL'] ||
      (process.env['PGHOST'] ? undefined : 'postgres:///syncserver_dev?host=/var/run/postgresql'),
    serverSecret: str('SERVER_SECRET', DEV_SECRET),
    serverSecretIsDefault: (process.env['SERVER_SECRET'] ?? '') === '',
    blobStorePath: str('BLOB_STORE_PATH', 'var/blobs'),
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    limits: {
      uploadBytesPerMinute: int('UPLOAD_BYTES_PER_MINUTE', 200 * 1024 * 1024),
      unfinishedUploadBytes: int('UNFINISHED_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),
      abandonedPartTtlSeconds: int('ABANDONED_PART_TTL_SECONDS', 24 * 60 * 60),
      unboundBlobTtlSeconds: int('UNBOUND_BLOB_TTL_SECONDS', 48 * 60 * 60),
      journalTtlSeconds: int('JOURNAL_TTL_SECONDS', 90 * 24 * 60 * 60),
    },
    sweepIntervalSeconds: int('SWEEP_INTERVAL_SECONDS', 60 * 60),
  };

  if (cfg.limits.abandonedPartTtlSeconds >= cfg.limits.unboundBlobTtlSeconds) {
    throw new Error(
      'ABANDONED_PART_TTL_SECONDS must be strictly below UNBOUND_BLOB_TTL_SECONDS: otherwise a ' +
        'blob is swept while its own upload is still in progress, and the client retries for ever',
    );
  }

  return cfg;
};
