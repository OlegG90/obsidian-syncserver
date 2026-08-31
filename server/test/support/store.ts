/**
 * Where a test puts its blob store.
 *
 * Everything under `var/tmp` is disposable at any moment, by anyone, without asking what
 * wrote it. That is the whole promise, and it is the reason the directory is named for
 * deletability rather than for provenance: what a person needs to know at the moment they
 * are looking at a stray directory is whether they may remove it, not who left it.
 *
 * It replaces `var/test-<name>-<pid>`, which sat directly beside `var/blobs` and
 * `var/backups` — the development server's own store and its copies. Telling residue from
 * data was then a matter of reading directory names carefully, and a wrong reading loses
 * real encrypted content.
 *
 * **Teardown is not what makes this safe.** Every suite removes its own store on the way
 * out, and a leftover directory is still what a crashed run, an interrupt, or a throwing
 * hook produces — the case cleanup cannot cover is precisely the case that creates residue.
 * So the layout carries the guarantee instead: `db:reset` sweeps this directory, and a run
 * that dies leaves nothing anyone has to think about.
 *
 * The pid keeps two runs on one machine apart. The label keeps two suites in one run apart,
 * which matters for the same reason each share suite builds its own world: whoever claims
 * the seeded administrator first leaves the others answering 503 (`AGENTS.md`).
 */
export const testStore = (label: string): string => `var/tmp/${label}-${process.pid}`;
