export type DenialReason =
  | "invalid_credential"
  | "grant_not_found"
  | "revoked"
  | "agent_revoked"
  | "expired"
  /** Issued for a different site, or this app's domain isn't verified. */
  | "wrong_site"
  /** The person ended this sign-in from their Sign-ins screen. */
  | "sign_in_ended"
  /**
   * Assentry couldn't be asked: it was unreachable, or it rejected this
   * site's API key (missing or wrong). Treated as a denial so a setup
   * mistake or an outage never crashes the site and never lets an agent in.
   */
  | "assentry_unavailable";

export type VerifyResult =
  /**
   * userId and agentId are specific to your developer account: stable for a
   * person across your apps, different for every other developer.
   */
  | { valid: true; userId: string; agentId: string; expiresAt: string }
  | { valid: false; reason: DenialReason };

export type ProfileResult =
  /**
   * Only fields your app declared in the console AND the person allowed.
   * `undeclaredFields` lists requested fields your app hasn't declared.
   */
  | { valid: true; profile: Record<string, unknown>; undeclaredFields?: string[] }
  | { valid: false; reason: DenialReason };

export interface LinkTokenResult {
  userId: string;
}

export interface SignInStart {
  requestId: string;
  code: string;
  expiresAt: string;
}

export type SignInCollectResult =
  | { status: "pending"; expiresAt: string }
  | { status: "expired" | "not_found" | "already_collected" | "assentry_unavailable" }
  | { status: "denied"; reason: "grant_revoked" | "grant_expired" | "agent_revoked" }
  | { status: "approved"; credential: string; userId: string; agentId: string; expiresAt: string };
