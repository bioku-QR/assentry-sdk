import type { LinkTokenResult, ProfileResult, VerifyResult } from "./types";

export class HAPIRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface HAPIOptions {
  apiKey: string;
  /** HAPI API origin. Defaults to the local dev server. */
  baseUrl?: string;
  /**
   * Your partner `publicId` — safe to put in a browser-facing URL, unlike
   * the API key. Only needed if you use `getAccountLinkUrl`.
   */
  partnerId?: string;
}

/**
 * Server-side client for the HAPI partner handshake. Never put the API key
 * in frontend code — this talks to HAPI from your backend, the same way
 * you'd use a Stripe secret key.
 */
export class HAPI {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly partnerId?: string;

  constructor(options: HAPIOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "http://localhost:4000").replace(/\/$/, "");
    this.partnerId = options.partnerId;
  }

  /**
   * Verifies a credential an agent presented, for a specific action/scope.
   * Always re-checks HAPI's authorisation service — never trust the agent's
   * claim alone.
   */
  async verify(credential: string, action: string): Promise<VerifyResult> {
    return this.request<VerifyResult>("/verify", { credential, action });
  }

  /**
   * Pulls only the profile fields the user actually consented to disclose
   * for this grant. Requesting a field the user didn't consent to simply
   * omits it from the response rather than erroring.
   */
  async getProfile(credential: string, fields: string[]): Promise<ProfileResult> {
    return this.request<ProfileResult>("/profile", { credential, fields });
  }

  /**
   * Builds the URL to send an *already-logged-in* user of yours to, so they
   * can confirm their HAPI identity matches their existing account with
   * you. Requires `partnerId` to have been passed to the constructor.
   * See `exchangeLinkCode` for the other half of this flow.
   */
  getAccountLinkUrl(params: { redirectUri: string; state?: string }): string {
    if (!this.partnerId) {
      throw new Error("HAPI client was constructed without a partnerId — required for getAccountLinkUrl");
    }
    const qs = new URLSearchParams({
      partner_id: this.partnerId,
      redirect_uri: params.redirectUri,
      state: params.state ?? "",
    });
    return `${this.baseUrl}/link/authorize?${qs}`;
  }

  /**
   * Exchanges the one-time code your redirect_uri received for the HAPI
   * `userId` to store against your own account record. After this, a
   * credential that resolves to that `userId` is proof of *this specific*
   * existing account — no password involved at any point.
   */
  async exchangeLinkCode(code: string): Promise<LinkTokenResult> {
    return this.request<LinkTokenResult>("/link/token", { code });
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hapi-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      throw new HAPIRequestError("invalid HAPI api key", 401);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new HAPIRequestError(
        typeof data?.error === "string" ? data.error : `HAPI request failed (${res.status})`,
        res.status
      );
    }

    return (await res.json()) as T;
  }
}
