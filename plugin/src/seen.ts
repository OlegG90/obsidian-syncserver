/**
 * When a device was last seen, as an interval rather than an instant (#386).
 *
 * **The server writes that column when a device refreshes its session, not when it syncs**
 * (D-118) — about once per access-token lifetime — so the freshest it can ever be is that
 * lifetime, and the server says which by sending `seen_within_seconds` beside the rows. A
 * precise timestamp claimed an exactness the value does not have: on a live server, two
 * devices reading eleven minutes behind a vault that was visibly busy looked like two devices
 * that had stopped talking, and that is how they were read.
 *
 * **The console says the same thing in the same words** — `console/src/format.ts`. They are
 * two bundles with no runtime code between them, because `shared` is declarations only and
 * deliberately so; what keeps the wording in step is that both sides are written the same and
 * tested the same. A change here belongs there in the same commit.
 */

/**
 * A span of seconds in words, for a sentence about how stale a reading may be.
 *
 * Coarse on purpose: this describes a bound, and "every 900 seconds" invites the reader to
 * take the number literally, which is the mistake the whole of #386 is about.
 */
export const aboutSpan = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  // `<= 1`, not `< 1`: half a minute rounds to one, and "1 minutes" is the kind of wrong that
  // makes a sentence read as generated rather than written.
  if (minutes <= 1) return 'minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'hour' : `${hours} hours`;
};

/** What a device row says about when it was last seen. The exact instant goes in the tooltip. */
export const seenLine = (lastSeenAt: string | null, withinSeconds: number, now = Date.now()): string => {
  if (!lastSeenAt) return 'not seen since it was added';
  const at = Date.parse(lastSeenAt);
  if (Number.isNaN(at)) return 'not seen since it was added';

  // A clock a little ahead of ours gives a negative age, and that needs no clamp of its own:
  // it falls into the first bucket by arithmetic, which is the honest reading — a device whose
  // stamp is in the future was seen as recently as this list can tell.
  const ageMinutes = (now - at) / 60_000;
  if (ageMinutes <= Math.max(1, withinSeconds / 60)) return `seen in the last ${aboutSpan(withinSeconds)}`;

  const hours = Math.round(ageMinutes / 60);
  if (hours < 2) return 'seen about an hour ago';
  if (hours < 24) return `seen about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'seen about a day ago' : `seen ${days} days ago`;
};

/** The sentence under a device list that says why a busy device can read as idle (#386). */
export const seenNote = (withinSeconds: number): string =>
  `A device is marked seen when it renews its session, about once every ${aboutSpan(withinSeconds)} ` +
  'while it is in use — so one that is syncing right now can read as seen a few minutes ago.';
