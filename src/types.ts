export type DenialReason = "invalid_credential" | "grant_not_found" | "revoked" | "agent_revoked" | "expired";

export type VerifyResult =
  | { valid: true; userId: string; agentId: string; expiresAt: string }
  | { valid: false; reason: DenialReason };

export type ProfileResult =
  | { valid: true; profile: Record<string, unknown> }
  | { valid: false; reason: DenialReason };

export interface LinkTokenResult {
  userId: string;
}
