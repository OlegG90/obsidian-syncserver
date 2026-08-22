/**
 * A refusal, as an HTTP response — the one place statuses are decided.
 *
 * The facts live in `refusal.ts` and know nothing of this file; this is the adapter that
 * turns one into an answer. Keeping them apart is what lets a service describe a refused
 * write without importing a web framework to do it.
 *
 * "Statuses carry meaning" (AGENTS.md): `404` means "you hold no live reference", `409` that
 * a precondition failed, `410` resync and why. Clients read them, so this switch is the
 * closest thing the protocol has to a contract about them.
 */
import type { FastifyReply } from 'fastify';
import type { Refusal } from './refusal.js';

/** One place decides what a refusal looks like, so every route family answers the same way. */
export const refuse = (reply: FastifyReply, refusal: Refusal): FastifyReply => {
  switch (refusal.kind) {
    case 'not_found':
    case 'no_such_version':
      return reply.code(404).send({ error: refusal.kind });
    case 'device_revoked':
      return reply.code(401).send({ error: 'device_revoked' });
    case 'frozen':
    case 'over_quota':
    case 'too_large':
    case 'part_too_large':
    case 'too_many_unfinished':
      return reply.code(413).send({ error: refusal.kind });
    case 'address_mismatch':
    case 'size_mismatch':
      return reply.code(400).send({ error: refusal.kind });
    case 'share_boundary':
      return reply.code(409).send({ error: 'share_boundary' });
    case 'base_mismatch':
      // The caller is told what the content actually is, because that is what lets the
      // client decide between "same text reached independently" and a real conflict.
      return reply
        .code(409)
        .send({ error: 'base_mismatch', sha256: refusal.currentSha256, rev: refusal.rev });
    case 'rev_mismatch':
      return reply.code(409).send({ error: 'rev_mismatch', rev: refusal.rev });
    case 'name_taken':
      // The blocking node is named because the client has to offer the user a choice, and
      // "something is in the way" is not a choice.
      return reply.code(409).send({ error: 'name_taken', blocked_by: refusal.blockedBy });
    case 'rate_limited':
      return reply
        .code(429)
        .header('retry-after', String(refusal.retryAfterSeconds))
        .send({ error: 'rate_limited', retry_after: refusal.retryAfterSeconds });
    case 'parts_missing':
      return reply.code(409).send({ error: 'parts_missing', have: refusal.have });
    case 'named_by_a_share':
    case 'vault_exists':
      // 409 rather than 403: nothing is forbidden, the vault is simply still in use — and
      // which kind of use is the difference between an answer a person can act on and one
      // that baffles them a month after their last share ended.
      return reply.code(409).send({ error: refusal.kind });
    case 'invalid_write':
      return reply.code(400).send({ error: 'invalid_write', detail: refusal.detail });
    case 'already_settled':
      return reply.code(409).send({ error: 'already_settled' });
    case 'not_approved':
      // 409 rather than 404: the caller holds a valid pairing and the answer is "not yet",
      // which is what it should keep asking about. A 404 would tell it to give up.
      return reply.code(409).send({ error: 'not_approved' });
    case 'share_not_active':
      return reply.code(409).send({ error: 'share_not_active', state: refusal.state });
    case 'share_not_prepared':
      // 409, and it carries the work list: this is not a malformed request, it is one that
      // arrived before the client had finished a job only the client can do.
      return reply.code(409).send({ error: 'share_not_prepared', gaps: refusal.gaps });
    case 'invite_failed':
      return reply.code(409).send({ error: 'invite_failed' });
    case 'console_account':
      return reply.code(409).send({
        error: 'console_account',
        detail:
          'that login administers the server and holds no keys, so there is nothing to seal a ' +
          'share to. Whoever it is has a separate account for their own notes — invite that one.',
      });
    case 'initiator_cannot_be_removed':
      return reply.code(409).send({ error: 'initiator_cannot_be_removed' });
    case 'finalization_incomplete':
      return reply.code(409).send({ error: 'finalization_incomplete', missing: refusal.missing });
    case 'share_not_preparing':
      // The state travels with it: "cancel" is wrong for an active share, and what is
      // right — end it by finalizing — depends on which state it actually reached.
      return reply.code(409).send({ error: 'share_not_preparing', state: refusal.state });
  }
};
