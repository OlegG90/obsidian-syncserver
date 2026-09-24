import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ShareMember } from '../src/api/client.js';
import type { ShareRow } from '../src/share-flow.js';
import { groupShares, memberState, peopleLine, whose } from '../src/share-list.js';

const share = (folder: string | undefined, isInitiator = true): ShareRow => ({
  shareId: folder ?? 'unplaced',
  isInitiator,
  state: 'active',
  ...(folder === undefined ? {} : { folder }),
});

const member = (login: string, over: Partial<ShareMember> = {}): ShareMember => ({
  user_id: login,
  login,
  is_initiator: false,
  invited_at: '2026-09-24T10:00:00Z',
  joined_at: '2026-09-24T11:00:00Z',
  finalizing: false,
  ...over,
});

describe('the shared-folders list, one line a share (#428)', () => {
  it('says each parent once, above its folders, and shows only the last segment on the line', () => {
    const groups = groupShares([
      share('Hub-Cases/Case - Keti - Visa'),
      share('Plans'),
      share('Hub-Cases/Case - Keti - Laptop'),
      share('Archive/2025/Trip'),
    ]);

    assert.deepEqual(
      groups.map((g) => [g.parent, g.shares.map((s) => s.name)]),
      [
        ['', ['Plans']],
        ['Archive/2025', ['Trip']],
        ['Hub-Cases', ['Case - Keti - Laptop', 'Case - Keti - Visa']],
      ],
    );
    assert.equal(groups[2]!.shares[0]!.row.folder, 'Hub-Cases/Case - Keti - Laptop', 'the full path stays on the row');
  });

  it('files a share not synced here last, under no parent, rather than at the top of the vault', () => {
    const groups = groupShares([share(undefined), share('Plans')]);
    assert.deepEqual(
      groups.map((g) => [g.parent, g.shares.map((s) => s.name)]),
      [
        ['', ['Plans']],
        [undefined, ['A folder not synced here yet']],
      ],
    );
  });

  it('says whose it is, and names the initiator once the members are known', () => {
    assert.equal(whose(share('A')), 'yours');
    assert.equal(whose(share('A', false)), 'shared with you');
    assert.equal(whose(share('A', false), [member('oleh'), member('keti', { is_initiator: true })]), 'from keti');
  });

  it('counts who holds a copy, who is invited and who is leaving, leaving out the zeros', () => {
    assert.equal(peopleLine([member('oleh', { is_initiator: true })]), '1 person');
    assert.equal(peopleLine([member('oleh', { is_initiator: true }), member('keti')]), '2 people');
    assert.equal(
      peopleLine([member('oleh', { is_initiator: true }), member('keti', { joined_at: null }), member('ann', { finalizing: true })]),
      '1 person · 1 invited · 1 leaving',
    );
  });

  it('says what each member is doing about the folder', () => {
    assert.equal(memberState(member('oleh', { is_initiator: true })), 'shared this folder');
    assert.equal(memberState(member('keti')), 'holds a copy');
    assert.equal(memberState(member('keti', { joined_at: null })), 'invited, no answer yet');
    assert.equal(memberState(member('keti', { finalizing: true })), 'leaving — their copy is being converted back');
  });
});
