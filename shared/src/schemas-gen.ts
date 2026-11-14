/**
 * The request-body schemas as plain JSON Schema — GENERATED, do not edit (issue #482).
 *
 * Regenerate with `npm run emit:schemas --workspace @syncserver/shared`. The source of truth
 * is the TypeBox in `src/bodies.ts`, which is also where the types are inferred from; this file
 * carries only what Ajv reads, so the runtime image needs no TypeBox.
 */

import type * as BodyTypes from './bodies.js';

export const WireEnvelope = {
  "type": "object",
  "required": [
    "sha256",
    "scope_id",
    "wrapped_key"
  ],
  "properties": {
    "sha256": {
      "type": "string"
    },
    "scope_id": {
      "type": "string"
    },
    "wrapped_key": {
      "type": "string"
    }
  }
} as const;

export const WireDedupTag = {
  "type": "object",
  "required": [
    "sha256",
    "scope_id",
    "content_tag"
  ],
  "properties": {
    "sha256": {
      "type": "string"
    },
    "scope_id": {
      "type": "string"
    },
    "content_tag": {
      "type": "string"
    }
  }
} as const;

export const CreateNodeBody = {
  "type": "object",
  "required": [
    "name_enc",
    "name_hmac",
    "name_key_id",
    "parent_id",
    "type",
    "mtime"
  ],
  "properties": {
    "blob_envelopes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "sha256",
          "scope_id",
          "wrapped_key"
        ],
        "properties": {
          "sha256": {
            "type": "string"
          },
          "scope_id": {
            "type": "string"
          },
          "wrapped_key": {
            "type": "string"
          }
        }
      }
    },
    "dedup_tags": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "sha256",
          "scope_id",
          "content_tag"
        ],
        "properties": {
          "sha256": {
            "type": "string"
          },
          "scope_id": {
            "type": "string"
          },
          "content_tag": {
            "type": "string"
          }
        }
      }
    },
    "name_enc": {
      "type": "string"
    },
    "name_hmac": {
      "type": "string"
    },
    "name_key_id": {
      "type": "string"
    },
    "parent_id": {
      "type": "string"
    },
    "type": {
      "type": "string",
      "enum": [
        "file",
        "folder"
      ]
    },
    "sha256": {
      "type": "string"
    },
    "size": {
      "type": "integer"
    },
    "mtime": {
      "type": "string"
    }
  }
} as const;

export const PutContentBody = {
  "type": "object",
  "required": [
    "sha256",
    "size",
    "mtime"
  ],
  "properties": {
    "blob_envelopes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "sha256",
          "scope_id",
          "wrapped_key"
        ],
        "properties": {
          "sha256": {
            "type": "string"
          },
          "scope_id": {
            "type": "string"
          },
          "wrapped_key": {
            "type": "string"
          }
        }
      }
    },
    "dedup_tags": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "sha256",
          "scope_id",
          "content_tag"
        ],
        "properties": {
          "sha256": {
            "type": "string"
          },
          "scope_id": {
            "type": "string"
          },
          "content_tag": {
            "type": "string"
          }
        }
      }
    },
    "sha256": {
      "type": "string"
    },
    "size": {
      "type": "integer"
    },
    "mtime": {
      "type": "string"
    },
    "base_sha256": {
      "type": [
        "string",
        "null"
      ]
    }
  }
} as const;

export const MoveNodeBody = {
  "type": "object",
  "required": [
    "name_enc",
    "name_hmac",
    "name_key_id",
    "parent_id"
  ],
  "properties": {
    "name_enc": {
      "type": "string"
    },
    "name_hmac": {
      "type": "string"
    },
    "name_key_id": {
      "type": "string"
    },
    "parent_id": {
      "type": "string"
    }
  }
} as const;

export const CreateVaultBody = {
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name_enc": {
      "type": "string"
    }
  }
} as const;

export const RenameVaultBody = {
  "type": "object",
  "properties": {
    "name_enc": {
      "type": "string"
    }
  }
} as const;

export const RemoveVaultBody = {
  "type": "object",
  "properties": {
    "auth_secret": {}
  }
} as const;

export const RestoreVersionBody = {
  "type": "object",
  "properties": {
    "node_id": {
      "type": "string"
    },
    "rev": {
      "type": "integer"
    }
  }
} as const;

export const CreateShareBody = {
  "type": "object",
  "properties": {
    "vault_id": {
      "type": "string"
    },
    "node_id": {
      "type": "string"
    },
    "subtree_key_id": {
      "type": "string"
    },
    "wrapped_key_initiator": {
      "type": "string"
    }
  }
} as const;

export const PrepareShareBody = {
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "node_id": {
            "type": "string"
          },
          "name_enc": {
            "type": "string"
          },
          "name_hmac": {
            "type": "string"
          },
          "name_key_id": {
            "type": "string"
          },
          "blob_envelopes": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "sha256",
                "scope_id",
                "wrapped_key"
              ],
              "properties": {
                "sha256": {
                  "type": "string"
                },
                "scope_id": {
                  "type": "string"
                },
                "wrapped_key": {
                  "type": "string"
                }
              }
            }
          },
          "dedup_tags": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "sha256",
                "scope_id",
                "content_tag"
              ],
              "properties": {
                "sha256": {
                  "type": "string"
                },
                "scope_id": {
                  "type": "string"
                },
                "content_tag": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

export const InviteBody = {
  "type": "object",
  "properties": {
    "user_id": {
      "type": "string"
    },
    "wrapped_key": {
      "type": "string"
    }
  }
} as const;

export const JoinShareBody = {
  "type": "object",
  "properties": {
    "name_enc": {
      "type": "string"
    },
    "name_hmac": {
      "type": "string"
    },
    "name_key_id": {
      "type": "string"
    },
    "vault_id": {
      "type": "string"
    },
    "parent_id": {
      "type": "string"
    }
  }
} as const;

export const FinalizeLeaveBody = {
  "type": "object",
  "properties": {
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "node_id": {
            "type": "string"
          },
          "name_enc": {
            "type": "string"
          },
          "name_hmac": {
            "type": "string"
          },
          "name_key_id": {
            "type": "string"
          },
          "vault_envelopes": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "sha256",
                "scope_id",
                "wrapped_key"
              ],
              "properties": {
                "sha256": {
                  "type": "string"
                },
                "scope_id": {
                  "type": "string"
                },
                "wrapped_key": {
                  "type": "string"
                }
              }
            }
          },
          "vault_dedup_tags": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "sha256",
                "scope_id",
                "content_tag"
              ],
              "properties": {
                "sha256": {
                  "type": "string"
                },
                "scope_id": {
                  "type": "string"
                },
                "content_tag": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

export const BeginPairingBody = {
  "type": "object",
  "properties": {
    "device_pubkey": {
      "type": "string"
    },
    "pairing_token_hash": {
      "type": "string"
    }
  }
} as const;

export const LookupPairingBody = {
  "type": "object",
  "properties": {
    "pairing_secret": {
      "type": "string"
    }
  }
} as const;

export const ApprovePairingBody = {
  "type": "object",
  "properties": {
    "pairing_secret": {
      "type": "string"
    },
    "seed_envelope": {
      "type": "string"
    }
  }
} as const;

export const ClaimPairingBody = {
  "type": "object",
  "properties": {
    "pairing_secret": {
      "type": "string"
    },
    "name": {},
    "platform": {
      "type": "string"
    }
  }
} as const;

export const BootstrapBody = {
  "type": "object",
  "properties": {
    "login": {
      "type": "string"
    },
    "password": {
      "type": "string"
    }
  }
} as const;

export const RedeemBody = {
  "type": "object",
  "required": [
    "invitation_token",
    "auth_secret",
    "account_salt",
    "pubkey",
    "enc_privkey",
    "wrapped_seed",
    "initial_vault_id",
    "initial_vault_name_enc"
  ],
  "properties": {
    "invitation_token": {
      "type": "string"
    },
    "login": {
      "type": "string"
    },
    "auth_secret": {
      "type": "string"
    },
    "account_salt": {
      "type": "string"
    },
    "kdf_params": {},
    "pubkey": {
      "type": "string"
    },
    "enc_privkey": {
      "type": "string"
    },
    "wrapped_seed": {
      "type": "string"
    },
    "kek_verifier": {
      "type": "string"
    },
    "recovery_key": {
      "type": "string"
    },
    "recovery_code_hash": {
      "type": "string"
    },
    "initial_vault_id": {
      "type": "string"
    },
    "initial_vault_name_enc": {
      "type": "string"
    },
    "device_name": {},
    "device_platform": {
      "type": "string"
    }
  }
} as const;

export const ConsoleSignInBody = {
  "type": "object",
  "properties": {
    "login": {
      "type": "string"
    },
    "password": {
      "type": "string"
    },
    "device_name": {}
  }
} as const;

export const LoginBody = {
  "type": "object",
  "required": [
    "login",
    "auth_secret"
  ],
  "properties": {
    "login": {
      "type": "string"
    },
    "auth_secret": {
      "type": "string"
    },
    "device_id": {
      "type": "string"
    }
  }
} as const;

export const RecoverBody = {
  "type": "object",
  "properties": {
    "login": {
      "type": "string"
    },
    "kek_verifier": {
      "type": "string"
    },
    "recovery_code": {
      "type": "string"
    },
    "device_name": {},
    "device_platform": {
      "type": "string"
    }
  }
} as const;

export const RefreshBody = {
  "type": "object",
  "required": [
    "refresh"
  ],
  "properties": {
    "refresh": {
      "type": "string"
    }
  }
} as const;

export const RegisterDeviceBody = {
  "type": "object",
  "required": [
    "platform"
  ],
  "properties": {
    "name": {},
    "platform": {
      "type": "string"
    }
  }
} as const;

export const KekVerifierBody = {
  "type": "object",
  "properties": {
    "kek_verifier": {
      "type": "string"
    }
  }
} as const;

export const ChangePasswordBody = {
  "type": "object",
  "properties": {
    "current": {
      "type": "string"
    },
    "password": {
      "type": "string"
    }
  }
} as const;

export const ChangePassphraseBody = {
  "type": "object",
  "properties": {
    "wrapped_seed": {
      "type": "string"
    },
    "kek_verifier": {
      "type": "string"
    }
  }
} as const;

export const RecoveryCodeBody = {
  "type": "object",
  "properties": {
    "recovery_key": {
      "type": "string"
    },
    "recovery_code_hash": {
      "type": "string"
    }
  }
} as const;

export const RenameDeviceBody = {
  "type": "object",
  "properties": {
    "name": {}
  }
} as const;

export const InviteAccountBody = {
  "type": "object",
  "properties": {
    "login": {
      "type": "string"
    },
    "quota_bytes": {},
    "ttl_seconds": {
      "type": "integer"
    }
  }
} as const;

export const ReissueBody = {
  "type": "object",
  "properties": {
    "ttl_seconds": {
      "type": "integer"
    }
  }
} as const;

export const SetEnabledBody = {
  "type": "object",
  "properties": {
    "enabled": {}
  }
} as const;

export const SetQuotaBody = {
  "type": "object",
  "properties": {
    "quota_bytes": {}
  }
} as const;

export const SaveScheduleBody = {
  "type": "object",
  "properties": {
    "enabled": {},
    "time": {},
    "days": {},
    "zone": {},
    "keep": {}
  }
} as const;

export type WireEnvelope = BodyTypes.WireEnvelope;
export type WireDedupTag = BodyTypes.WireDedupTag;
export type CreateNodeBody = BodyTypes.CreateNodeBody;
export type PutContentBody = BodyTypes.PutContentBody;
export type MoveNodeBody = BodyTypes.MoveNodeBody;
export type CreateVaultBody = BodyTypes.CreateVaultBody;
export type RenameVaultBody = BodyTypes.RenameVaultBody;
export type RemoveVaultBody = BodyTypes.RemoveVaultBody;
export type RestoreVersionBody = BodyTypes.RestoreVersionBody;
export type CreateShareBody = BodyTypes.CreateShareBody;
export type PrepareShareBody = BodyTypes.PrepareShareBody;
export type InviteBody = BodyTypes.InviteBody;
export type JoinShareBody = BodyTypes.JoinShareBody;
export type FinalizeLeaveBody = BodyTypes.FinalizeLeaveBody;
export type BeginPairingBody = BodyTypes.BeginPairingBody;
export type LookupPairingBody = BodyTypes.LookupPairingBody;
export type ApprovePairingBody = BodyTypes.ApprovePairingBody;
export type ClaimPairingBody = BodyTypes.ClaimPairingBody;
export type BootstrapBody = BodyTypes.BootstrapBody;
export type RedeemBody = BodyTypes.RedeemBody;
export type ConsoleSignInBody = BodyTypes.ConsoleSignInBody;
export type LoginBody = BodyTypes.LoginBody;
export type RecoverBody = BodyTypes.RecoverBody;
export type RefreshBody = BodyTypes.RefreshBody;
export type RegisterDeviceBody = BodyTypes.RegisterDeviceBody;
export type KekVerifierBody = BodyTypes.KekVerifierBody;
export type ChangePasswordBody = BodyTypes.ChangePasswordBody;
export type ChangePassphraseBody = BodyTypes.ChangePassphraseBody;
export type RecoveryCodeBody = BodyTypes.RecoveryCodeBody;
export type RenameDeviceBody = BodyTypes.RenameDeviceBody;
export type InviteAccountBody = BodyTypes.InviteAccountBody;
export type ReissueBody = BodyTypes.ReissueBody;
export type SetEnabledBody = BodyTypes.SetEnabledBody;
export type SetQuotaBody = BodyTypes.SetQuotaBody;
export type SaveScheduleBody = BodyTypes.SaveScheduleBody;
