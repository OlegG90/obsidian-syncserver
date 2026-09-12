/**
 * Whether a path segment is a uuid, asked before it reaches a query that casts it.
 *
 * PostgreSQL answers a malformed uuid with `22P02`, which no refusal translates, so a mistyped id in a URL
 * surfaced as a 500 — a defect by this repository's own rule, since the caller is the one who can fix it.
 * A route checks the segment instead and answers with the status it would give an id that names nothing.
 */
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
