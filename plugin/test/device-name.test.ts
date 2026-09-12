/**
 * The name a device registers with, and the one-time rename of devices called `obsidian` (#356).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEVICE_NAME_MAX, deviceName, nameIfUnnamed, UNNAMED, type DeviceNaming } from '../src/device-name.js';

describe('the name a device registers with', () => {
  it('is what the person typed, trimmed', () => {
    assert.equal(deviceName('  Laptop — hobby ', 'windows-desktop'), 'Laptop — hobby');
  });

  it('is the label when nothing was typed, rather than nothing', () => {
    assert.equal(deviceName('', 'android'), 'android');
    assert.equal(deviceName('   ', 'android'), 'android');
    assert.equal(deviceName(undefined, 'android'), 'android');
  });

  it('is never one the server would refuse', () => {
    // The server's rule: trimmed, 1–64 characters counted as code points, no control characters.
    const long = deviceName('ж'.repeat(80), 'ios');
    assert.equal([...long].length, DEVICE_NAME_MAX);
    assert.equal(deviceName('two\nlines', 'ios'), 'twolines');
    assert.equal(deviceName(`${'a'.repeat(63)}  b`, 'ios'), 'a'.repeat(63), 'a cut that ends on a space is trimmed again');
  });
});

describe('renaming a device that was never named', () => {
  const client = (rows: { id: string; name: string; current: boolean }[]) => {
    const renamed: string[] = [];
    const fake: DeviceNaming = {
      devices: async () => ({ devices: rows }),
      renameDevice: async (id, name) => void renamed.push(`${id}=${name}`),
    };
    return { fake, renamed };
  };

  it('renames this device from the old default to its label', async () => {
    const { fake, renamed } = client([
      { id: 'phone', name: UNNAMED, current: false },
      { id: 'me', name: UNNAMED, current: true },
    ]);
    assert.equal(await nameIfUnnamed(fake, 'windows-desktop'), 'windows-desktop');
    assert.deepEqual(renamed, ['me=windows-desktop'], 'only this one: the phone names itself when it next unlocks');
  });

  it('never replaces a name somebody chose', async () => {
    const { fake, renamed } = client([{ id: 'me', name: 'Laptop', current: true }]);
    assert.equal(await nameIfUnnamed(fake, 'windows-desktop'), undefined);
    assert.deepEqual(renamed, []);
  });

  it('does nothing when the server does not say which device is asking', async () => {
    const { fake, renamed } = client([{ id: 'other', name: UNNAMED, current: false }]);
    assert.equal(await nameIfUnnamed(fake, 'android'), undefined);
    assert.deepEqual(renamed, []);
  });
});
