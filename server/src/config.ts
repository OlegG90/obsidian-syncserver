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
   * How often the collector re-opens the latest backup's blob copy and confirms it is whole
   * (docs/10, "periodic restore rehearsal"). Rare, because the check walks every blob the
   * database references. Independent of `sweepIntervalSeconds`, which thins history.
   */
  backupVerifyIntervalSeconds: number;
  /**
   * How often a backup is TAKEN, when one is configured at all (docs/10).
   *
   * Defaulted ON rather than off, and the reason is what configuring a backup means: nobody
   * sets a destination, a dump command and a blob source in order to press a button by hand
   * for ever. The opt-in already happened when those three were set — this only decides how
   * often, and an unattended NAS with backups configured and none being taken is the failure
   * this milestone is about.
   *
   * `0` turns it off for a deployment that drives backups from outside — cron on the host, or
   * a storage appliance's own snapshotting — where a second schedule would be two windows
   * where the operator asked for one.
   */
  backupEverySeconds: number;
  /**
   * Where backups go, and how they are taken. All three are deployment facts, not protocol:
   * a destination directory, the `pg_dump` invocation (or whatever this deployment calls
   * it), and the blob store to copy. Absent until configured — a server without them can
   * still serve, but the console's backup button answers "not configured".
   */
  backup?:
    | {
        /** Where each run's two legs land. */
        destination: string;
        /** `pg_dump`, or whatever this deployment calls it. Must match the server's PG. */
        dumpCommand: string[];
        /** The blob store directory, copied after the dump (#114). */
        blobSource: string;
        /**
         * How many finished copies to keep on disk, or `undefined` for all of them (#136).
         *
         * Unset is the default and means **nothing is ever pruned**, which is what every
         * deployment has done until now. Deleting backups is not a behaviour to acquire by
         * upgrading: an operator who has not asked for it should find their copies where they
         * left them.
         */
        keep?: number | undefined;
      }
    | undefined;
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
    backupVerifyIntervalSeconds: int('BACKUP_VERIFY_INTERVAL_SECONDS', 24 * 60 * 60),
    backupEverySeconds: int('BACKUP_EVERY_SECONDS', 24 * 60 * 60),
    restoreStateFile: str('RESTORE_STATE_FILE', 'var/restore.epoch'),
  };

  const destination = process.env['BACKUP_DESTINATION'];
  const dumpCommand = process.env['BACKUP_DB_COMMAND'];
  const blobSource = process.env['BACKUP_BLOB_SOURCE'];
  // **The DESTINATION is the switch**, not "any of the three". It used to be any of them,
  // which was right while all three were empty by default and stopped being right the moment
  // `BACKUP_DB_COMMAND` got a working one: with `pg_dump` in the image there is a sensible
  // default for HOW to dump, so that variable is now always set — and "any of the three"
  // then read every unconfigured deployment as a half-configured one and refused to boot.
  //
  // Found by deploying, not by a test: nothing here starts a server from `.env.example`.
  //
  // Where to put a copy is the part only this installation knows, so it is the part that
  // decides. Unset destination means backups are not configured, the console's button says
  // so, and nothing is scheduled — which is what the documents promised all along.
  if (destination) {
    // With a destination named, the rest must be answerable: a run that cannot find the
    // blobs it is meant to copy is a backup that fails halfway, having already opened a
    // window. `dumpCommand` has a default and `blobSource` does not.
    if (!(dumpCommand && blobSource)) {
      throw new Error(
        'BACKUP_DESTINATION is set, so BACKUP_DB_COMMAND and BACKUP_BLOB_SOURCE must be too — ' +
          'a partial backup configuration would start a run that cannot finish',
      );
    }
    const keep = process.env['BACKUP_KEEP'];
    if (keep !== undefined && !/^[1-9][0-9]*$/.test(keep)) {
      throw new Error('BACKUP_KEEP must be a whole number of copies to keep, at least 1 — or unset, to keep all');
    }
    cfg.backup = {
      destination,
      dumpCommand: dumpCommand.split(/\s+/),
      blobSource,
      ...(keep === undefined ? {} : { keep: Number(keep) }),
    };
  }

  if (cfg.limits.abandonedPartTtlSeconds >= cfg.limits.unboundBlobTtlSeconds) {
    throw new Error(
      'ABANDONED_PART_TTL_SECONDS must be strictly below UNBOUND_BLOB_TTL_SECONDS: otherwise a ' +
        'blob is swept while its own upload is still in progress, and the client retries for ever',
    );
  }

  return cfg;
};
