/**
 * The name a device gives itself, and the one rename of devices that were never given one (#356).
 *
 * Until this, every registration sent the one word `obsidian` — from a laptop, a phone, and each vault on
 * either — so an account's device list was six identical rows and revoking the lost phone was a guess.
 * The name now starts as the platform label (`device-label.ts`) and is whatever the person types over it.
 *
 * **Nothing here reads the machine.** No host name (one bundle for Electron and a WebView, so no Node API)
 * and no vault name (vault names are encrypted everywhere else, AC-08). What the server learns is the
 * label and what the person chose to type, and docs/06 says so.
 *
 * Outside `obsidian/` so a test can ask it directly, the same reason `device-label.ts` is.
 */

/** What every device was called before names were asked for. */
export const UNNAMED = 'obsidian';

/** The longest name the server accepts: its `device_name_is_readable` says the same. */
export const DEVICE_NAME_MAX = 64;

/**
 * A typed name, made into one the server accepts: control characters dropped, trimmed, cut to the limit.
 * The label when nothing is left — an empty field means "I did not choose", not "call it nothing".
 */
export const deviceName = (typed: string | undefined, label: string): string => {
  const cut = [...(typed ?? '').replace(/\p{Cc}/gu, '').trim()].slice(0, DEVICE_NAME_MAX).join('');
  return cut.trim() || label;
};

/** The two asks the rename needs, and no more of the client. */
export interface DeviceNaming {
  devices(): Promise<{ devices: { id: string; name: string; current: boolean }[] }>;
  renameDevice(deviceId: string, name: string): Promise<void>;
}

/**
 * Rename **this** device from the old default to its label, once. Answers the new name, or nothing.
 *
 * Only this one, and only while it is still called `obsidian`: every other row belongs to a device that
 * will do the same for itself when it next unlocks, and a name somebody typed is never replaced. That
 * makes it safe to ask at every unlock — after the first, the answer is always "nothing to do".
 */
export const nameIfUnnamed = async (client: DeviceNaming, label: string): Promise<string | undefined> => {
  const { devices } = await client.devices();
  const me = devices.find((d) => d.current);
  if (!me || me.name !== UNNAMED) return undefined;
  await client.renameDevice(me.id, label);
  return label;
};
