export type DenialReason =
  | "invalid_credential"
  | "grant_not_found"
  | "revoked"
  | "agent_revoked"
  | "expired"
  | "scope_not_permitted"
  | "scope_mismatch";

export type VerifyResult =
  | { valid: true; userId: string; agentId: string; scope: string; expiresAt: string }
  | { valid: false; reason: DenialReason };

export type ProfileResult =
  | { valid: true; profile: Record<string, unknown> }
  | { valid: false; reason: DenialReason };

export interface LinkTokenResult {
  userId: string;
}
