/**
 * What went wrong, as a sentence — for anything a `catch` can hold.
 *
 * An `Error` carries its own message; anything else thrown is stringified rather than dropped,
 * because "undefined" on a screen is worse than the value that was actually thrown. Twelve
 * places spelled this out by hand.
 */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
