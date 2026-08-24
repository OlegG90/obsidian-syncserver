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
   * (D-73). One secret with three uses, because all three are "the server proving it
   * produced this" and none of them ever leaves the server.
   *
   * A development default exists so the first run needs no ceremony; production must set
   * it, and the server says so loudly at startup rather than silently signing with a
   * value that is public knowledge.
   */
  serverSecret: string;
  serverSecretIsDefault: boolean;
  /** Where blobs live. Content only — metadata is in PostgreSQL, and the split is what makes rename, sharing and dedup cheap (D-1). */
  blobStorePath: string;
  accessTokenTtlSeconds: number;
  limits: {
    /** docs/04: 200 MB/min per account. */
    uploadBytesPerMinute: number;
    /** docs/04: 2 GB of unfinished uploads per account. */
    unfinishedUploadBytes: number;
    /**
     * docs/04: 8 MB per part of a resumable upload.
     *
     * It is also the threshold: a blob at or below it goes in one `POST`, because a
     * one-part resumable upload costs the same bytes on retry as a retried `POST`. There
     * is deliberately no second number for the threshold to be set wrong against.
     */
    uploadPartBytes: number;
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
    /**
     * docs/03: how long a blob nobody references waits before its bytes go.
     *
     * The hold is the only thing standing between "the last reference went away" and "the
     * file is unlinked", and it matters more now that emptying the trash makes losing a
     * last reference an ordinary event rather than one that never happened. An upload of
     * the same content writes its file before it commits its row, so a delete that raced
     * that gap would leave a committed row pointing at nothing. Seven days makes the race
     * theoretical instead of merely unlikely.
     */
    gcQuarantineSeconds: number;
    /**
     * docs/04: 10 minutes on an unclaimed device pairing.
     *
     * The clock a human runs on while carrying a code from one device to the other, with
     * room for fumbling — and short because an unapproved pairing is an open invitation to
     * be approved by mistake.
     */
    pairingTtlSeconds: number;
  };
  /**
   * How often the collector wakes. Operational, not a protocol contract: it decides only
   * how promptly a swept blob disappears, never what gets swept.
   */
  sweepIntervalSeconds: number;
  /**
   * Where backups go, and how they are taken.
   *
   * **Always present** (issue #219). It used to be absent until `BACKUP_DESTINATION` was named, and
   * that switch answered a question this server no longer asks: it was built while backups ran
   * nightly, and it decided whether the schedule should run at all. Since D-121 a backup happens
   * exactly when somebody presses the button, so a server that will not take one is a server whose
   * button nobody presses — and the configuration that produced it cost every deployment two
   * variables repeating constants of its own image.
   *
   * The blob store is **not** one of these. The backup copies the live store, so `blobStorePath`
   * already says which directory that is; asking a second variable for the same fact meant a
   * deployment could answer it twice and disagree.
   */
  backup: {
    /** Where each run's two legs land. */
    destination: string;
    /** `pg_dump`, or whatever this deployment calls it. Must match the server's PG. */
    dumpCommand: string[];
  };
  /**
   * How to put a dump back (#155) — `pg_restore` and its flags, split into argv.
   *
   * Separate from `BACKUP_DB_COMMAND` rather than derived from it: it is a different binary with
   * different flags, and the two are not symmetrical in the way the names suggest. The dump file is
   * appended by the caller, so this ends at `-d`.
   */
  restoreCommand: string[];
  /**
   * Where the server records the newest `restore_epoch` it has ever run with. This file is
   * what makes an unconfirmed restore detectable at the next start, and what the confirm
   * step raises the epoch ABOVE — it has to survive a restore, so it lives outside both
   * the database dump and the blob store (docs/08).
   */
  restoreStateFile: string;
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
      uploadPartBytes: int('UPLOAD_PART_BYTES', 8 * 1024 * 1024),
      abandonedPartTtlSeconds: int('ABANDONED_PART_TTL_SECONDS', 24 * 60 * 60),
      unboundBlobTtlSeconds: int('UNBOUND_BLOB_TTL_SECONDS', 48 * 60 * 60),
      journalTtlSeconds: int('JOURNAL_TTL_SECONDS', 90 * 24 * 60 * 60),
      gcQuarantineSeconds: int('GC_QUARANTINE_SECONDS', 7 * 24 * 60 * 60),
      pairingTtlSeconds: int('PAIRING_TTL_SECONDS', 10 * 60),
    },
    sweepIntervalSeconds: int('SWEEP_INTERVAL_SECONDS', 60 * 60),
    // How to put a dump back (#155). Symmetric with BACKUP_DB_COMMAND, and separate because the
    // restore is a different binary with different flags: `--clean --if-exists` is what makes it
    // replace what is there rather than collide with it, and `--no-owner` is what lets a dump taken
    // as one role load as another. The database and the archive are appended by the caller, in that
    // order and through `restoreArgv` — a trailing `-d` here is optional because that is where the
    // two callers used to disagree (#171).
    restoreCommand: str('RESTORE_DB_COMMAND', 'pg_restore --clean --if-exists --no-owner -d').split(/\s+/),
    restoreStateFile: str('RESTORE_STATE_FILE', 'var/restore.epoch'),
    // Both have working defaults, and that is the point: `pg_dump` is in the image at the database's
    // own major, and where a copy lands is a directory this deployment mounts. Neither is a fact a
    // person has to supply, so neither belongs in an `.env` — which is for what only this machine can
    // say (issue #219). `var/backups` is the bare-`node` answer, the same convention the restore state
    // file above already uses; compose names the container's side.
    backup: {
      destination: str('BACKUP_DESTINATION', 'var/backups'),
      dumpCommand: str('BACKUP_DB_COMMAND', 'pg_dump --format=custom').split(/\s+/),
    },
  };

  if (cfg.limits.abandonedPartTtlSeconds >= cfg.limits.unboundBlobTtlSeconds) {
    throw new Error(
      'ABANDONED_PART_TTL_SECONDS must be strictly below UNBOUND_BLOB_TTL_SECONDS: otherwise a ' +
        'blob is swept while its own upload is still in progress, and the client retries for ever',
    );
  }

  return cfg;
};
