export type DenialReason =
  | "invalid_credential"
  | "grant_not_found"
  | "revoked"
  | "agent_revoked"
  | "expired"
  /**
   * Assentry couldn't be asked: it was unreachable, or it rejected this
   * site's API key (missing or wrong). Treated as a denial so a setup
   * mistake or an outage never crashes the site and never lets an agent in.
   */
  | "assentry_unavailable";

export type VerifyResult =
  | { valid: true; userId: string; agentId: string; expiresAt: string }
  | { valid: false; reason: DenialReason };

export type ProfileResult =
  | { valid: true; profile: Record<string, unknown> }
  | { valid: false; reason: DenialReason };

export interface LinkTokenResult {
  userId: string;
}
