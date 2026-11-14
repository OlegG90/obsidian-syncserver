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
import { Optional, Type, type Static } from '@sinclair/typebox';

const Str = () => Type.String();
const Int = () => Type.Integer();
const Opt = Optional;
/** Any value: the route checks it and names what is wrong. */
const Unchecked = () => Optional(Type.Unknown());

/** The name a node is placed under: encrypted, its HMAC, and the key that sealed it. */
const placedName = { name_enc: Str(), name_hmac: Str(), name_key_id: Str() };

const Envelope = Type.Object({ sha256: Str(), scope_id: Str(), wrapped_key: Str() });
const DedupTag = Type.Object({ sha256: Str(), scope_id: Str(), content_tag: Str() });

/** The key material a node write carries: both lists optional, each entry whole. */
const keyMaterial = { blob_envelopes: Opt(Type.Array(Envelope)), dedup_tags: Opt(Type.Array(DedupTag)) };

// ---- nodes: every handler reads its body without asking, so what it cannot do without is required ----

export const CreateNodeBody = Type.Object({
  ...keyMaterial,
  ...placedName,
  parent_id: Str(),
  type: Type.Union([Type.Literal('file'), Type.Literal('folder')]),
  sha256: Opt(Str()),
  size: Opt(Int()),
  mtime: Str(),
});
export type CreateNodeBody = Static<typeof CreateNodeBody>;

export const PutContentBody = Type.Object({
  ...keyMaterial,
  sha256: Str(),
  size: Int(),
  mtime: Str(),
  base_sha256: Opt(Type.Union([Str(), Type.Null()])),
});
export type PutContentBody = Static<typeof PutContentBody>;

export const MoveNodeBody = Type.Object({ ...placedName, parent_id: Str() });
export type MoveNodeBody = Static<typeof MoveNodeBody>;

// ---- vaults and history ----

export const CreateVaultBody = Type.Object({ id: Opt(Str()), name_enc: Opt(Str()) });
export type CreateVaultBody = Static<typeof CreateVaultBody>;

export const RenameVaultBody = Type.Object({ name_enc: Opt(Str()) });
export type RenameVaultBody = Static<typeof RenameVaultBody>;

export const RemoveVaultBody = Type.Object({ auth_secret: Unchecked() });
export type RemoveVaultBody = Static<typeof RemoveVaultBody>;

export const RestoreVersionBody = Type.Object({ node_id: Opt(Str()), rev: Opt(Int()) });
export type RestoreVersionBody = Static<typeof RestoreVersionBody>;

// ---- sharing: ids and names are each route's to check (`bad_*`, `name_required`) ----

export const CreateShareBody = Type.Object({
  vault_id: Opt(Str()),
  node_id: Opt(Str()),
  subtree_key_id: Opt(Str()),
  wrapped_key_initiator: Opt(Str()),
});
export type CreateShareBody = Static<typeof CreateShareBody>;

const convertedName = { node_id: Opt(Str()), name_enc: Opt(Str()), name_hmac: Opt(Str()), name_key_id: Opt(Str()) };

export const PrepareShareBody = Type.Object({ items: Opt(Type.Array(Type.Object({ ...convertedName, ...keyMaterial }))) });
export type PrepareShareBody = Static<typeof PrepareShareBody>;

export const InviteBody = Type.Object({ user_id: Opt(Str()), wrapped_key: Opt(Str()) });
export type InviteBody = Static<typeof InviteBody>;

export const JoinShareBody = Type.Object({
  vault_id: Opt(Str()),
  parent_id: Opt(Str()),
  name_enc: Opt(Str()),
  name_hmac: Opt(Str()),
  name_key_id: Opt(Str()),
});
export type JoinShareBody = Static<typeof JoinShareBody>;

export const FinalizeLeaveBody = Type.Object({
  nodes: Opt(
    Type.Array(
      Type.Object({
        ...convertedName,
        vault_envelopes: Opt(Type.Array(Envelope)),
        vault_dedup_tags: Opt(Type.Array(DedupTag)),
      }),
    ),
  ),
});
export type FinalizeLeaveBody = Static<typeof FinalizeLeaveBody>;

// ---- pairing: every field has its own refusal ----

export const BeginPairingBody = Type.Object({ device_pubkey: Opt(Str()), pairing_token_hash: Opt(Str()) });
export type BeginPairingBody = Static<typeof BeginPairingBody>;

export const LookupPairingBody = Type.Object({ pairing_secret: Opt(Str()) });
export type LookupPairingBody = Static<typeof LookupPairingBody>;

export const ApprovePairingBody = Type.Object({ pairing_secret: Opt(Str()), seed_envelope: Opt(Str()) });
export type ApprovePairingBody = Static<typeof ApprovePairingBody>;

export const ClaimPairingBody = Type.Object({ pairing_secret: Opt(Str()), name: Unchecked(), platform: Opt(Str()) });
export type ClaimPairingBody = Static<typeof ClaimPairingBody>;

// ---- authentication and the account ----

export const BootstrapBody = Type.Object({ login: Opt(Str()), password: Opt(Str()) });
export type BootstrapBody = Static<typeof BootstrapBody>;

export const RedeemBody = Type.Object({
  invitation_token: Str(),
  login: Opt(Str()),
  auth_secret: Str(),
  account_salt: Str(),
  kdf_params: Unchecked(),
  pubkey: Str(),
  enc_privkey: Str(),
  wrapped_seed: Str(),
  kek_verifier: Opt(Str()),
  recovery_key: Opt(Str()),
  recovery_code_hash: Opt(Str()),
  initial_vault_id: Str(),
  initial_vault_name_enc: Str(),
  device_name: Unchecked(),
  device_platform: Opt(Str()),
});
export type RedeemBody = Static<typeof RedeemBody>;

export const ConsoleSignInBody = Type.Object({ login: Opt(Str()), password: Opt(Str()), device_name: Unchecked() });
export type ConsoleSignInBody = Static<typeof ConsoleSignInBody>;

export const LoginBody = Type.Object({ login: Str(), auth_secret: Str(), device_id: Opt(Str()) });
export type LoginBody = Static<typeof LoginBody>;

export const RecoverBody = Type.Object({
  login: Opt(Str()),
  kek_verifier: Opt(Str()),
  recovery_code: Opt(Str()),
  device_name: Unchecked(),
  device_platform: Opt(Str()),
});
export type RecoverBody = Static<typeof RecoverBody>;

export const RefreshBody = Type.Object({ refresh: Str() });
export type RefreshBody = Static<typeof RefreshBody>;

export const RegisterDeviceBody = Type.Object({ name: Unchecked(), platform: Str() });
export type RegisterDeviceBody = Static<typeof RegisterDeviceBody>;

export const KekVerifierBody = Type.Object({ kek_verifier: Opt(Str()) });
export type KekVerifierBody = Static<typeof KekVerifierBody>;

export const ChangePasswordBody = Type.Object({ current: Opt(Str()), password: Opt(Str()) });
export type ChangePasswordBody = Static<typeof ChangePasswordBody>;

export const ChangePassphraseBody = Type.Object({ wrapped_seed: Opt(Str()), kek_verifier: Opt(Str()) });
export type ChangePassphraseBody = Static<typeof ChangePassphraseBody>;

export const RecoveryCodeBody = Type.Object({ recovery_key: Opt(Str()), recovery_code_hash: Opt(Str()) });
export type RecoveryCodeBody = Static<typeof RecoveryCodeBody>;

export const RenameDeviceBody = Type.Object({ name: Unchecked() });
export type RenameDeviceBody = Static<typeof RenameDeviceBody>;

// ---- the operator's: the console's fields keep their refusals, the counts it sends are typed ----

export const InviteAccountBody = Type.Object({ login: Opt(Str()), quota_bytes: Unchecked(), ttl_seconds: Opt(Int()) });
export type InviteAccountBody = Static<typeof InviteAccountBody>;

export const ReissueBody = Type.Object({ ttl_seconds: Opt(Int()) });
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
