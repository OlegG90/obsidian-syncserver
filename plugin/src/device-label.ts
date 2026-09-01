/**
 * The label a device gives the conflict files it writes.
 *
 * Outside `obsidian/` on purpose: the binding that reads `Platform` is in there and imports `obsidian`
 * at run time, which puts it out of reach of every test in this suite. The decision — what kind of
 * machine, and therefore what to call it — is here, where a test can ask it directly. That the two were
 * one file is why the ordering below was wrong for as long as it was (#301).
 *
 * The label is not an identity: nothing checks it and nothing depends on it matching between syncs. Its
 * one job is that two devices editing the same note do not also collide on the conflict file's own name —
 * `Note (conflict 2026-08-01 laptop).md` (docs/04). Readable and distinct is the whole requirement.
 */
/**
 * What Obsidian says about the machine, as the flags this file reads and no others.
 *
 * A `Pick` of `Platform` in all but name: asked for as an argument so the decision below can be
 * tested, which the module could not be while it read `Platform` directly — importing `obsidian` at
 * run time is what makes a file unreachable from a test here.
 */
export interface DeviceFlags {
  isDesktop: boolean;
  isAndroidApp: boolean;
  isIosApp: boolean;
  isMacOS: boolean;
  isWin: boolean;
  isLinux: boolean;
}

/**
 * **What kind of machine first, then which operating system** — and that order is the whole of it.
 *
 * The other order does not work, and shipped: `isLinux` was tested before `isAndroidApp`, and Obsidian
 * reports Linux on Android. The `android` arm was unreachable, so every conflict file a phone wrote was
 * called `linux` and could not be told from one written by a Linux desktop — the exact collision this
 * label exists to prevent (#301). It went unnoticed because a wrong label still reads plausibly; only
 * the missing `-desktop` suffix gave it away.
 */
export const labelFor = (p: DeviceFlags): string => {
  // A phone or a tablet answers here and never reaches the desktop ladder, whatever it also reports
  // about its kernel.
  if (p.isAndroidApp) return 'android';
  if (p.isIosApp) return 'ios';

  const os = p.isMacOS ? 'macos' : p.isWin ? 'windows' : p.isLinux ? 'linux' : 'device';
  // Mobile that is neither Android nor iOS is not a thing Obsidian ships, and if it becomes one this
  // says so plainly rather than claiming a desktop.
  return p.isDesktop ? `${os}-desktop` : os;
};
