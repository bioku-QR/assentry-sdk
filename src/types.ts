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
  /** The person hasn't allowed this site, or removed it. */
  | "site_not_allowed"
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
   * Only details your app declared in the console AND the person allowed,
   * each in its published format (see ProfileValue). `meta` says where each
   * came from; `missing` lists required details you declared but aren't
   * getting (the person has been asked); `undeclaredFields` lists requested
   * keys your app hasn't declared.
   */
  | {
      valid: true;
      profile: Record<string, ProfileValue>;
      meta: Record<string, { source: "person" | "agent"; updatedAt: string }>;
      missing?: string[];
      undeclaredFields?: string[];
    }
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
  /**
   * Not approved yet. `waitingFor: "person"` means the agent approved it but
   * this is the first sign-in to your site for that person, so they're
   * allowing your site in the Assentry app; `expiresAt` moves later then.
   */
  | { status: "pending"; expiresAt: string; waitingFor?: "person" }
  | { status: "expired" | "not_found" | "already_collected" | "assentry_unavailable" }
  | { status: "denied"; reason: "grant_revoked" | "grant_expired" | "agent_revoked" | "person_declined" }
  | { status: "approved"; credential: string; userId: string; agentId: string; expiresAt: string };

/** A structured address (OpenID Connect style). `country` is an ISO 3166-1 code. */
export interface ProfileAddress {
  street_address?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  formatted: string;
}

/**
 * A file detail. `url` works once, for 5 minutes, and only with your API
 * key: fetch it with `assentry.downloadFile(file)`.
 */
export interface ProfileFile {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  url: string;
  expiresAt: string;
}

/**
 * Values by type: text, long_text, email, phone (E.164), date (YYYY-MM-DD),
 * url, choice and country (ISO code) are strings; integer and decimal are
 * numbers; boolean is a boolean; address is a ProfileAddress; file a ProfileFile.
 */
export type ProfileValue = string | number | boolean | ProfileAddress | ProfileFile;
