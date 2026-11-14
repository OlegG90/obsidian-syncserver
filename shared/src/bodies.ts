/**
 * Every JSON request body the server reads, declared once (D-143).
 *
 * Each is a schema and a type of the same name: the server validates a body against the schema before
 * its route runs, and the plugin and the console type what they send with the type, which is inferred
 * from the schema rather than written beside it. A field cannot be added to one and not the other.
 *
 * The rules a schema follows are `docs/04`'s. Every field a route reads is typed. A field is required
 * only where nothing else would name it missing: one whose absence a route answers with its own code
 * (`login_required`, `bad_vault_id`) is `Optional` here and checked there, because clients read those
 * codes. A field the route checks entirely itself — a device name, the KDF parameters — is `Unknown`.
 * Nothing is coerced, and fields a schema does not list are neither refused nor removed.
 */
import { Type, type Static } from '@sinclair/typebox';

/** A field the route checks itself and names what is wrong with: any value, and it may be absent. */
const Unchecked = () => Type.Optional(Type.Unknown());

/** The name a node is placed under: encrypted, its HMAC, and the key that sealed it. */
const placedName = { name_enc: Type.String(), name_hmac: Type.String(), name_key_id: Type.String() };

const Envelope = Type.Object({ sha256: Type.String(), scope_id: Type.String(), wrapped_key: Type.String() });
const DedupTag = Type.Object({ sha256: Type.String(), scope_id: Type.String(), content_tag: Type.String() });

/** The key material a node write carries: both lists optional, each entry whole. */
const keyMaterial = { blob_envelopes: Type.Optional(Type.Array(Envelope)), dedup_tags: Type.Optional(Type.Array(DedupTag)) };

// ---- nodes: every handler reads its body without asking, so what it cannot do without is required ----

export const CreateNodeBody = Type.Object({
  ...keyMaterial,
  ...placedName,
  parent_id: Type.String(),
  // `enum`, not a union of literals: a refusal of a union lists every branch it tried, and a client
  // reading the detail should see the two values it may send.
  type: Type.Unsafe<'file' | 'folder'>({ type: 'string', enum: ['file', 'folder'] }),
  sha256: Type.Optional(Type.String()),
  size: Type.Optional(Type.Integer()),
  mtime: Type.String(),
});
export type CreateNodeBody = Static<typeof CreateNodeBody>;

export const PutContentBody = Type.Object({
  ...keyMaterial,
  sha256: Type.String(),
  size: Type.Integer(),
  mtime: Type.String(),
  base_sha256: Type.Optional(Type.Unsafe<string | null>({ type: ['string', 'null'] })),
});
export type PutContentBody = Static<typeof PutContentBody>;

export const MoveNodeBody = Type.Object({ ...placedName, parent_id: Type.String() });
export type MoveNodeBody = Static<typeof MoveNodeBody>;

// ---- vaults and history ----

export const CreateVaultBody = Type.Object({ id: Type.Optional(Type.String()), name_enc: Type.Optional(Type.String()) });
export type CreateVaultBody = Static<typeof CreateVaultBody>;

export const RenameVaultBody = Type.Object({ name_enc: Type.Optional(Type.String()) });
export type RenameVaultBody = Static<typeof RenameVaultBody>;

export const RemoveVaultBody = Type.Object({ auth_secret: Unchecked() });
export type RemoveVaultBody = Static<typeof RemoveVaultBody>;

export const RestoreVersionBody = Type.Object({ node_id: Type.Optional(Type.String()), rev: Type.Optional(Type.Integer()) });
export type RestoreVersionBody = Static<typeof RestoreVersionBody>;

// ---- sharing: ids and names are each route's to check (`bad_*`, `name_required`) ----

export const CreateShareBody = Type.Object({
  vault_id: Type.Optional(Type.String()),
  node_id: Type.Optional(Type.String()),
  subtree_key_id: Type.Optional(Type.String()),
  wrapped_key_initiator: Type.Optional(Type.String()),
});
export type CreateShareBody = Static<typeof CreateShareBody>;

const convertedName = { node_id: Type.Optional(Type.String()), name_enc: Type.Optional(Type.String()), name_hmac: Type.Optional(Type.String()), name_key_id: Type.Optional(Type.String()) };

export const PrepareShareBody = Type.Object({ items: Type.Optional(Type.Array(Type.Object({ ...convertedName, ...keyMaterial }))) });
export type PrepareShareBody = Static<typeof PrepareShareBody>;

export const InviteBody = Type.Object({ user_id: Type.Optional(Type.String()), wrapped_key: Type.Optional(Type.String()) });
export type InviteBody = Static<typeof InviteBody>;

export const JoinShareBody = Type.Object({
  vault_id: Type.Optional(Type.String()),
  parent_id: Type.Optional(Type.String()),
  name_enc: Type.Optional(Type.String()),
  name_hmac: Type.Optional(Type.String()),
  name_key_id: Type.Optional(Type.String()),
});
export type JoinShareBody = Static<typeof JoinShareBody>;

export const FinalizeLeaveBody = Type.Object({
  nodes: Type.Optional(
    Type.Array(
      Type.Object({
        ...convertedName,
        vault_envelopes: Type.Optional(Type.Array(Envelope)),
        vault_dedup_tags: Type.Optional(Type.Array(DedupTag)),
      }),
    ),
  ),
});
export type FinalizeLeaveBody = Static<typeof FinalizeLeaveBody>;

// ---- pairing: every field has its own refusal ----

export const BeginPairingBody = Type.Object({ device_pubkey: Type.Optional(Type.String()), pairing_token_hash: Type.Optional(Type.String()) });
export type BeginPairingBody = Static<typeof BeginPairingBody>;

export const LookupPairingBody = Type.Object({ pairing_secret: Type.Optional(Type.String()) });
export type LookupPairingBody = Static<typeof LookupPairingBody>;

export const ApprovePairingBody = Type.Object({ pairing_secret: Type.Optional(Type.String()), seed_envelope: Type.Optional(Type.String()) });
export type ApprovePairingBody = Static<typeof ApprovePairingBody>;

export const ClaimPairingBody = Type.Object({ pairing_secret: Type.Optional(Type.String()), name: Unchecked(), platform: Type.Optional(Type.String()) });
export type ClaimPairingBody = Static<typeof ClaimPairingBody>;

// ---- authentication and the account ----

export const BootstrapBody = Type.Object({ login: Type.Optional(Type.String()), password: Type.Optional(Type.String()) });
export type BootstrapBody = Static<typeof BootstrapBody>;

export const RedeemBody = Type.Object({
  invitation_token: Type.String(),
  login: Type.Optional(Type.String()),
  auth_secret: Type.String(),
  account_salt: Type.String(),
  kdf_params: Unchecked(),
  pubkey: Type.String(),
  enc_privkey: Type.String(),
  wrapped_seed: Type.String(),
  kek_verifier: Type.Optional(Type.String()),
  recovery_key: Type.Optional(Type.String()),
  recovery_code_hash: Type.Optional(Type.String()),
  initial_vault_id: Type.String(),
  initial_vault_name_enc: Type.String(),
  device_name: Unchecked(),
  device_platform: Type.Optional(Type.String()),
});
export type RedeemBody = Static<typeof RedeemBody>;

export const ConsoleSignInBody = Type.Object({ login: Type.Optional(Type.String()), password: Type.Optional(Type.String()), device_name: Unchecked() });
export type ConsoleSignInBody = Static<typeof ConsoleSignInBody>;

export const LoginBody = Type.Object({ login: Type.String(), auth_secret: Type.String(), device_id: Type.Optional(Type.String()) });
export type LoginBody = Static<typeof LoginBody>;

export const RecoverBody = Type.Object({
  login: Type.Optional(Type.String()),
  kek_verifier: Type.Optional(Type.String()),
  recovery_code: Type.Optional(Type.String()),
  device_name: Unchecked(),
  device_platform: Type.Optional(Type.String()),
});
export type RecoverBody = Static<typeof RecoverBody>;

export const RefreshBody = Type.Object({ refresh: Type.String() });
export type RefreshBody = Static<typeof RefreshBody>;

export const RegisterDeviceBody = Type.Object({ name: Unchecked(), platform: Type.String() });
export type RegisterDeviceBody = Static<typeof RegisterDeviceBody>;

export const KekVerifierBody = Type.Object({ kek_verifier: Type.Optional(Type.String()) });
export type KekVerifierBody = Static<typeof KekVerifierBody>;

export const ChangePasswordBody = Type.Object({ current: Type.Optional(Type.String()), password: Type.Optional(Type.String()) });
export type ChangePasswordBody = Static<typeof ChangePasswordBody>;

export const ChangePassphraseBody = Type.Object({ wrapped_seed: Type.Optional(Type.String()), kek_verifier: Type.Optional(Type.String()) });
export type ChangePassphraseBody = Static<typeof ChangePassphraseBody>;

export const RecoveryCodeBody = Type.Object({ recovery_key: Type.Optional(Type.String()), recovery_code_hash: Type.Optional(Type.String()) });
export type RecoveryCodeBody = Static<typeof RecoveryCodeBody>;

export const RenameDeviceBody = Type.Object({ name: Unchecked() });
export type RenameDeviceBody = Static<typeof RenameDeviceBody>;

// ---- the operator's: the console's fields keep their refusals, the counts it sends are typed ----

export const InviteAccountBody = Type.Object({ login: Type.Optional(Type.String()), quota_bytes: Unchecked(), ttl_seconds: Type.Optional(Type.Integer()) });
export type InviteAccountBody = Static<typeof InviteAccountBody>;

export const ReissueBody = Type.Object({ ttl_seconds: Type.Optional(Type.Integer()) });
export type ReissueBody = Static<typeof ReissueBody>;

export const SetEnabledBody = Type.Object({ enabled: Unchecked() });
export type SetEnabledBody = Static<typeof SetEnabledBody>;

export const SetQuotaBody = Type.Object({ quota_bytes: Unchecked() });
export type SetQuotaBody = Static<typeof SetQuotaBody>;

/** Each field is read through its own check in the route, which names what was wrong (`ScheduleRefusalCode`). */
export const SaveScheduleBody = Type.Object({
  enabled: Unchecked(),
  time: Unchecked(),
  days: Unchecked(),
  zone: Unchecked(),
  keep: Unchecked(),
});
export type SaveScheduleBody = Static<typeof SaveScheduleBody>;
