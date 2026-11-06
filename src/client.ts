import type { LinkTokenResult, ProfileResult, SignInCollectResult, SignInStart, VerifyResult } from "./types";

export class AssentryRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface AssentryOptions {
  apiKey: string;
  /** Assentry API origin. Defaults to the local dev server. */
  baseUrl?: string;
  /**
   * Your partner `publicId` — safe to put in a browser-facing URL, unlike
   * the API key. Only needed if you use `getAccountLinkUrl`.
   */
  partnerId?: string;
}

/**
 * Server-side client for the Assentry partner handshake. Never put the API key
 * in frontend code — this talks to Assentry from your backend, the same way
 * you'd use a Stripe secret key.
 */
export class Assentry {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly partnerId?: string;

  constructor(options: AssentryOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "http://localhost:4000").replace(/\/$/, "");
    this.partnerId = options.partnerId;
  }

  /**
   * Verifies a credential an agent presented. Always re-checks Assentry's
   * authorisation service — never trust the agent's claim alone. A valid
   * result means the grant is current (not revoked/expired); there's no
   * separate per-action scope check for now — see getProfile for the one
   * remaining restriction (which data fields may be disclosed).
   *
   * Never throws: if Assentry can't be reached or rejects your API key, this
   * returns `{ valid: false, reason: "assentry_unavailable" }` (and logs the
   * cause), so the request is simply denied rather than crashing your route.
   */
  async verify(credential: string): Promise<VerifyResult> {
    return this.denyOnFailure(() => this.request<VerifyResult>("/verify", { credential }));
  }

  /**
   * Pulls only the profile fields the user actually consented to disclose
   * for this grant. Requesting a field the user didn't consent to simply
   * omits it from the response rather than erroring. Like `verify`, never
   * throws — failures come back as `reason: "assentry_unavailable"`.
   */
  async getProfile(credential: string, fields: string[]): Promise<ProfileResult> {
    return this.denyOnFailure(() => this.request<ProfileResult>("/profile", { credential, fields }));
  }

  /**
   * Starts a browser-agent sign-in: Assentry returns a short code for your
   * page to show. The agent approves it through its own Assentry connection,
   * never by typing into your site. Throws if Assentry can't be reached.
   * `assentryDiscovery({ assentry })` does all of this for you.
   */
  async startSignIn(): Promise<SignInStart> {
    return this.request<SignInStart>("/sign-in-requests", {});
  }

  /**
   * Checks a sign-in started with `startSignIn`. Once approved, returns the
   * person's credential exactly once. Never throws.
   */
  async collectSignIn(requestId: string): Promise<SignInCollectResult> {
    try {
      return await this.request<SignInCollectResult>("/sign-in-requests/collect", { requestId });
    } catch (err) {
      console.error(`[assentry] sign-in check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "assentry_unavailable" };
    }
  }

  private async denyOnFailure<T>(call: () => Promise<T>): Promise<T | { valid: false; reason: "assentry_unavailable" }> {
    try {
      return await call();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[assentry] request failed, denying: ${why}`);
      return { valid: false, reason: "assentry_unavailable" };
    }
  }

  /**
   * Builds the URL to send an *already-logged-in* user of yours to, so they
   * can confirm their Assentry identity matches their existing account with
   * you. Requires `partnerId` to have been passed to the constructor.
   * See `exchangeLinkCode` for the other half of this flow.
   */
  getAccountLinkUrl(params: { redirectUri: string; state?: string }): string {
    if (!this.partnerId) {
      throw new Error("Assentry client was constructed without a partnerId — required for getAccountLinkUrl");
    }
    const qs = new URLSearchParams({
      partner_id: this.partnerId,
      redirect_uri: params.redirectUri,
      state: params.state ?? "",
    });
    return `${this.baseUrl}/link/authorize?${qs}`;
  }

  /**
   * Exchanges the one-time code your redirect_uri received for the Assentry
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
        "x-assentry-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      throw new AssentryRequestError("invalid Assentry api key", 401);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new AssentryRequestError(
        typeof data?.error === "string" ? data.error : `Assentry request failed (${res.status})`,
        res.status
      );
    }

    return (await res.json()) as T;
  }
}
