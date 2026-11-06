import type { NextFunction, Request, Response } from "express";
import type { Assentry } from "./client";
import { readCredentialCookie } from "./browser";
import { declareDiscoverableRoute, type DiscoverableRoute } from "./discovery";

export interface AssentryGrant {
  userId: string;
  agentId: string;
  expiresAt: string;
}

export interface AssentryRequest extends Request {
  assentryGrant?: AssentryGrant;
  /** The raw credential the agent presented, reuse it for a /profile pull. */
  assentryCredential?: string;
}

export interface RequireGrantOptions {
  /**
   * Override the header the credential is read from. Defaults to the
   * standard `Authorization: Bearer <credential>` convention, the one any
   * reasonably capable agent will already try without being told a
   * site-specific trick. Only set this if you have a real reason to deviate.
   */
  credentialHeader?: string;
  /**
   * How this route should appear in the site's discovery document (see
   * `assentryDiscovery`), stated once, right here, so there's no separate list
   * elsewhere to keep in sync. Omit to keep this route out of discovery.
   */
  discover?: DiscoverableRoute;
}

/**
 * Reads the credential a request is carrying, using the standard
 * `Authorization: Bearer` convention by default, or the cookie set when a
 * browser agent signed in on the SDK's /assentry/sign-in page. Exported on its own (not
 * just used internally by `requireGrant`) for routes that need to check a
 * credential *conditionally*, e.g. a page that also accepts a normal
 * logged-in session, where you don't want to unconditionally reject
 * requests with no credential the way `requireGrant` does.
 */
export function getCredentialFromRequest(req: Request, options: RequireGrantOptions = {}): string | null {
  if (options.credentialHeader) {
    const value = req.headers[options.credentialHeader.toLowerCase()];
    return typeof value === "string" ? value : readCredentialCookie(req);
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  // A browser agent that signed in at /assentry/sign-in carries it as a cookie.
  return readCredentialCookie(req);
}

/**
 * Express middleware gating a route on a valid Assentry grant. On success,
 * attaches `req.assentryGrant` and calls next(); on failure, the agent is
 * treated exactly like any other unauthenticated request, your normal
 * fallback flow (login, CAPTCHA, manual signup) still applies.
 *
 * When no credential is presented, responds with a standard `401` plus a
 * `WWW-Authenticate: Bearer` header, the HTTP-native "send a credential"
 * challenge almost any HTTP-aware client or agent already recognises,
 * rather than a site-specific convention.
 */
export function requireGrant(assentry: Assentry, options: RequireGrantOptions = {}) {
  if (options.discover) {
    declareDiscoverableRoute(options.discover);
  }

  return async (req: AssentryRequest, res: Response, next: NextFunction) => {
    const credential = getCredentialFromRequest(req, options);
    if (!credential) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="Assentry"');
      return res.status(401).json({ error: "missing Assentry credential" });
    }

    const result = await assentry.verify(credential);
    if (!result.valid) {
      return res.status(403).json({ error: "not authorised", reason: result.reason });
    }

    req.assentryGrant = {
      userId: result.userId,
      agentId: result.agentId,
      expiresAt: result.expiresAt,
    };
    req.assentryCredential = credential;
    next();
  };
}
