/**
 * The label a conflict file carries, and the ordering that decides it (#301).
 *
 * Testable only because the decision takes the flags rather than reading `Platform`: a module that
 * imports `obsidian` at run time cannot be loaded here at all. The label was written on 2026-08-13 and
 * was wrong from that day; nothing here could ask it a question until it moved out.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { labelFor, type DeviceFlags } from '../src/device-label.js';

const none: DeviceFlags = {
  isDesktop: false,
  isAndroidApp: false,
  isIosApp: false,
  isMacOS: false,
  isWin: false,
  isLinux: false,
};

const machine = (over: Partial<DeviceFlags>): DeviceFlags => ({ ...none, ...over });

describe('the label a device gives its conflict files', () => {
  // The regression, in one case. Obsidian reports Linux on Android, so a ladder that asks about the
  // kernel first can never reach `android` — and every conflict file this vault got from a phone was
  // called `linux`, indistinguishable from a Linux desktop's.
  it('says android on a phone that also reports Linux', () => {
    assert.equal(labelFor(machine({ isAndroidApp: true, isLinux: true })), 'android');
  });

  // The same shape on the other platform. Whether iPadOS actually reports `isMacOS` is not something
  // observed here — the rule is what is pinned: a machine that says it is an app on a phone or tablet
  // is that, whatever else it also says.
  it('says ios when the flags disagree', () => {
    assert.equal(labelFor(machine({ isIosApp: true, isMacOS: true })), 'ios');
  });

  it('marks a desktop as one, so a phone and a laptop never collide', () => {
    assert.equal(labelFor(machine({ isDesktop: true, isLinux: true })), 'linux-desktop');
    assert.equal(labelFor(machine({ isDesktop: true, isWin: true })), 'windows-desktop');
    assert.equal(labelFor(machine({ isDesktop: true, isMacOS: true })), 'macos-desktop');
  });

  it('never gives a phone the desktop suffix', () => {
    for (const label of [
      labelFor(machine({ isAndroidApp: true, isLinux: true })),
      labelFor(machine({ isIosApp: true })),
    ]) {
      assert.ok(!label.includes('-desktop'), `“${label}” claims to be a desktop`);
    }
  });

  it('answers something filename-safe for a machine it cannot name', () => {
    // Not a hypothetical worth much, but a label is going into a filename either way — an empty one
    // would produce `Note (conflict 2026-08-01 ).md`.
    const label = labelFor(machine({ isDesktop: true }));
    assert.equal(label, 'device-desktop');
    assert.match(label, /^[a-z-]+$/);
  });

  it('gives every kind of machine a different answer', () => {
    // The one property the label has to have: two devices must not name their copies the same.
    const labels = [
      labelFor(machine({ isAndroidApp: true, isLinux: true })),
      labelFor(machine({ isIosApp: true })),
      labelFor(machine({ isDesktop: true, isLinux: true })),
      labelFor(machine({ isDesktop: true, isWin: true })),
      labelFor(machine({ isDesktop: true, isMacOS: true })),
    ];
    assert.equal(new Set(labels).size, labels.length, `two kinds of machine share a label: ${labels.join(', ')}`);
  });
});
