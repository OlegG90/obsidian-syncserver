/**
 * The sharing coordinator — the decisions that would otherwise live in a settings tab.
 *
 * Two of the defects a real phone found on 14 August were in that class, which is why these
 * exist at all. What is asserted is mostly what the person is *told*: sharing is a sequence
 * of requests that change the server between them, so a message that overstates what
 * happened is not cosmetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/client.js';
import { openShareFlow, type ShareFlowDeps } from '../src/share-flow.js';

const harness = (over: Partial<ShareFlowDeps> = {}) => {
  const notices: string[] = [];
  const shared: string[] = [];
  const invited: { shareId: string; login: string }[] = [];
  let rebuilt = 0;

  const deps: ShareFlowDeps = {
    list: async () => ({ joined: [], invitations: [] }),
    share: async (folderPath) => {
      shared.push(folderPath);
      return { shareId: 'share-1' };
    },
    invite: async (shareId, login) => {
      invited.push({ shareId, login });
    },
    accept: async () => undefined,
    decline: async () => undefined,
    leave: async () => ({ ended: false }),
    members: async () => [],
    remove: async () => ({ outcome: 'revoked' as const }),
    isSynced: () => true,
    notify: (m) => notices.push(m),
    done: () => {
      rebuilt++;
    },
    ...over,
  };

  return { flow: openShareFlow(deps), notices, shared, invited, rebuilt: () => rebuilt };
};

describe('sharing a folder', () => {
  it('refuses a folder the server has never seen, before anything is created', async () => {
    // A share is rooted at a node id, and a folder this device never uploaded has none.
    // Finding that out after a passphrase prompt and a request would be a worse way to
    // learn it.
    const h = harness({ isSynced: () => false });
    await h.flow.share('Team');

    assert.deepEqual(h.shared, [], 'nothing was created');
    assert.match(h.notices[0]!, /sync this vault first/);
    assert.equal(h.rebuilt(), 0);
  });

  it('refuses an empty choice without calling anything', async () => {
    const h = harness();
    await h.flow.share('   ');
    assert.deepEqual(h.shared, []);
    assert.match(h.notices[0]!, /choose a folder/);
  });

  it('reports the folder by name and rebuilds the screen', async () => {
    const h = harness();
    await h.flow.share('Team');

    assert.deepEqual(h.shared, ['Team']);
    assert.match(h.notices[0]!, /“Team” is shared/);
    assert.equal(h.rebuilt(), 1);
  });

  it('surfaces a failure instead of leaving the screen looking successful', async () => {
    const h = harness({
      share: async () => {
        throw new Error('already_shared');
      },
    });
    await h.flow.share('Team');

    assert.match(h.notices[0]!, /already_shared/);
    assert.equal(h.rebuilt(), 0, 'the screen is not rebuilt as if it had worked');
  });

  it('refuses a second operation while one is in flight', async () => {
    // Sharing is several requests with the server in an intermediate state between them; a
    // second press partway through would try to create a second share over the same folder.
    let release: (() => void) | undefined;
    const h = harness({ share: () => new Promise((resolve) => (release = () => resolve({ shareId: 's' }))) });

    const first = h.flow.share('Team');
    await h.flow.share('Other');
    assert.match(h.notices.at(-1)!, /still running/);

    release!();
    await first;
  });

  it('releases the guard after a failure, so a retry is possible', async () => {
    let fail = true;
    const h = harness({
      share: async () => {
        if (fail) throw new Error('nope');
        return { shareId: 's' };
      },
    });
    await h.flow.share('Team');
    fail = false;
    await h.flow.share('Team');

    assert.equal(h.rebuilt(), 1, 'the second attempt got through');
  });
});

describe('inviting', () => {
  it('never claims the login exists', async () => {
    // The pubkey endpoint answers an unknown login with a deterministic fake rather than a
    // 404 (#73). A message saying "invited alice" would rebuild, in the interface, exactly
    // the enumeration oracle that endpoint exists to prevent.
    const h = harness();
    await h.flow.invite('share-1', 'alice');

    assert.deepEqual(h.invited, [{ shareId: 'share-1', login: 'alice' }]);
    assert.match(h.notices[0]!, /if that login exists/);
    assert.ok(!h.notices[0]!.includes('alice'), 'and does not name them back');
  });

  it('trims what was typed, because a trailing space is not a different person', async () => {
    const h = harness();
    await h.flow.invite('share-1', '  alice  ');
    assert.equal(h.invited[0]!.login, 'alice');
  });

  it('refuses an empty login without calling anything', async () => {
    const h = harness();
    await h.flow.invite('share-1', '');
    assert.deepEqual(h.invited, []);
    assert.match(h.notices[0]!, /enter the login/);
  });
});

describe('answering an invitation', () => {
  it('says the folder is not here yet, because joining only makes it on the server', async () => {
    // The replica is materialised server-side; the files arrive with the next delta. A
    // message implying otherwise sends somebody looking for a folder that is not there.
    const h = harness();
    await h.flow.accept('share-1');

    assert.match(h.notices[0]!, /arrives on the next sync/);
    assert.equal(h.rebuilt(), 1);
  });

  it('confirms a decline, which is the only place it is ever recorded', async () => {
    // The membership row is deleted, so absence from the list is the whole record (docs/05).
    const h = harness();
    await h.flow.decline('share-1');
    assert.match(h.notices[0]!, /declined/);
  });
});

describe('leaving', () => {
  it('says "you left" when the share carries on without you', async () => {
    const h = harness();
    await h.flow.leave('share-1');

    assert.match(h.notices[0]!, /you left/i);
    assert.match(h.notices[0]!, /copy is yours/, 'and that the files stay (SH-05)');
  });

  it('says the share is over when the departure ended it for everybody', async () => {
    // The initiator leaving, or the last participant besides them, ends it. Telling that
    // person "you left" would be true and misleading.
    const h = harness({ leave: async () => ({ ended: true }) });
    await h.flow.leave('share-1');

    assert.match(h.notices[0]!, /over for everybody/);
  });

  it('does not rebuild the screen when leaving failed', async () => {
    const h = harness({
      leave: async () => {
        throw new Error('finalization_incomplete');
      },
    });
    await h.flow.leave('share-1');

    assert.match(h.notices[0]!, /finalization_incomplete/);
    assert.equal(h.rebuilt(), 0);
  });
});

describe('reading the lists', () => {
  it('hands back undefined rather than throwing at the screen', async () => {
    const h = harness({
      list: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(await h.flow.list(), undefined);
    assert.match(h.notices[0]!, /offline/);
  });

  it('passes the lists through when the server answers', async () => {
    const h = harness({
      list: async () => ({
        joined: [{ shareId: 's1', isInitiator: true, state: 'active' }],
        invitations: [{ shareId: 's2', initiatorLogin: 'bob' }],
      }),
    });
    const out = await h.flow.list();
    assert.equal(out!.joined[0]!.shareId, 's1');
    assert.equal(out!.invitations[0]!.initiatorLogin, 'bob');
  });
});

describe('a refusal that carries work', () => {
  /**
   * The refusal as it actually arrives: a status, a code, and the body the server sent.
   *
   * It used to be `Object.assign(new Error(message), { details })` — a duck that satisfied a
   * reader which accepted any object with a bag of fields on it. That reader is gone, and
   * with it the possibility of a test passing against a shape the client never meets.
   */
  const refusal = (status: number, code: string, details: Record<string, unknown>) =>
    new ApiError(status, code, JSON.stringify({ error: code, ...details }));

  it('says how much is not ready, and what to do about it', async () => {
    // The server computes the gap list precisely so the client need not re-scan a subtree
    // to find what it already knows. Shown as `409 share_not_prepared`, that reaches nobody.
    const h = harness({
      share: async () => {
        throw refusal(409, 'share_not_prepared', { gaps: [{ nodeId: 'a' }, { nodeId: 'b' }] });
      },
    });
    await h.flow.share('Team');

    assert.match(h.notices[0]!, /2 item\(s\)/);
    assert.match(h.notices[0]!, /Sync this vault and try again/, 'and the one instruction they can follow');
  });

  it('says how much of a departure was missed', async () => {
    const h = harness({
      leave: async () => {
        throw refusal(409, 'finalization_incomplete', { missing: ['n1', 'n2', 'n3'] });
      },
    });
    await h.flow.leave('share-1');

    assert.match(h.notices[0]!, /3 file\(s\)/);
  });

  it('adds nothing when the refusal carries nothing', async () => {
    // Most do not, and inventing a count for them would be noise.
    const h = harness({
      share: async () => {
        throw refusal(409, 'already_shared', {});
      },
    });
    await h.flow.share('Team');

    assert.match(h.notices[0]!, /already_shared/);
    assert.ok(!/item\(s\)/.test(h.notices[0]!));
  });

  it('survives an error that is not one of ours at all', async () => {
    const h = harness({
      share: async () => {
        throw 'a string, from somewhere careless';
      },
    });
    await h.flow.share('Team');
    assert.match(h.notices[0]!, /careless/);
  });
});

describe('a refusal the schema explained', () => {
  it('shows the schema’s sentence rather than just the code', async () => {
    // `400 invalid_write` says only that something was wrong. The detail names the node and
    // the rule, and was written to be read — dropping it left a live vault with a failure
    // nobody could act on.
    const h = harness({
      leave: async () => {
        throw new ApiError(
          400,
          'invalid_write',
          JSON.stringify({
            error: 'invalid_write',
            detail: 'node abc cannot be unmarked before blob def has its vault envelope',
          }),
        );
      },
    });
    await h.flow.leave('share-1');

    assert.match(h.notices[0]!, /cannot be unmarked before blob def/);
  });
});

describe('taking somebody out of a share', () => {
  it('says an invitation was withdrawn, and that nothing had reached them', async () => {
    // Withdrawing and revoking are one call — the server decides which by whether they ever
    // joined — and one sentence for both would be wrong in whichever case it did not fit.
    const h = harness({ remove: async () => ({ outcome: 'withdrawn' }) });

    await h.flow.remove('share-1', 'user-9', 'bob');

    assert.match(h.notices.join(' '), /withdrawn/i);
    assert.match(h.notices.join(' '), /Nothing had been sent/i);
    assert.equal(h.rebuilt(), 1, 'and the screen showing the old list is rebuilt');
  });

  it('says a revoked participant keeps the copy they already have', async () => {
    // SH-05 is the promise replication exists to make, and the moment somebody is most
    // likely to fear otherwise is the moment they are removed.
    const h = harness({ remove: async () => ({ outcome: 'revoked' }) });

    await h.flow.remove('share-1', 'user-9', 'bob');

    assert.match(h.notices.join(' '), /keep the copy/i);
  });

  it('says when removing the last participant ended the share', async () => {
    // SH-07: the share is over for everybody, including the initiator who pressed it, and
    // they now owe the same finalization pass as anyone else. "bob was removed" would be
    // true and would hide the part that changed for them.
    const h = harness({ remove: async () => ({ outcome: 'revoked', ended: true }) });

    await h.flow.remove('share-1', 'user-9', 'bob');

    assert.match(h.notices.join(' '), /ended the share/i);
    assert.match(h.notices.join(' '), /finish leaving/i);
  });

  it('reports a refusal rather than throwing it at the screen', async () => {
    const h = harness({
      remove: async () => {
        throw new Error('409 member_not_removable');
      },
    });

    await h.flow.remove('share-1', 'user-9', 'bob');

    assert.match(h.notices.join(' '), /removing failed/i);
    assert.equal(h.rebuilt(), 0, 'nothing changed, so nothing is redrawn');
  });
});

describe('reading a refusal by the code that decides what it holds', () => {
  it('answers only for the code the refusal actually is', async () => {
    // The typing is the point: `carries('share_not_prepared')` yields `gaps`, and asking a
    // different pair does not compile. What is left to assert at runtime is that a refusal
    // does not answer for a code it is not.
    const refused = new ApiError(
      409,
      'share_not_prepared',
      JSON.stringify({ error: 'share_not_prepared', gaps: [{ nodeId: 'n1', missing: 'name' }] }),
    );

    assert.equal(refused.carries('share_not_prepared')?.gaps.length, 1);
    assert.equal(refused.carries('invalid_write'), undefined);
  });
});
