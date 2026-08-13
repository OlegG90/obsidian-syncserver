/**
 * A short, filename-safe label for THIS device, for one purpose only: naming a conflict file
 * so two devices editing the same note do not also collide on the conflict file's own name —
 * `Note (conflict 2026-08-01 laptop).md` (docs/04). It is not an identity; nothing checks it,
 * nothing depends on it matching between syncs. Readable is the only requirement.
 */
import { Platform } from 'obsidian';

export const deviceLabel = (): string => {
  const os = Platform.isMacOS
    ? 'macos'
    : Platform.isWin
      ? 'windows'
      : Platform.isLinux
        ? 'linux'
        : Platform.isIosApp
          ? 'ios'
          : Platform.isAndroidApp
            ? 'android'
            : 'device';
  return Platform.isDesktop ? `${os}-desktop` : os;
};
