import type { NextFunction, Request, Response } from "express";
import type { HAPI } from "./client";

export interface HAPIGrant {
  userId: string;
  agentId: string;
  expiresAt: string;
}

export interface HAPIRequest extends Request {
  hapiGrant?: HAPIGrant;
  /** The raw credential the agent presented — reuse it for a /profile pull. */
  hapiCredential?: string;
}

export interface RequireGrantOptions {
  /**
   * Override the header the credential is read from. Defaults to the
   * standard `Authorization: Bearer <credential>` convention — the one any
   * reasonably capable agent will already try without being told a
   * site-specific trick. Only set this if you have a real reason to deviate.
   */
  credentialHeader?: string;
}

/**
 * Reads the credential a request is carrying, using the standard
 * `Authorization: Bearer` convention by default. Exported on its own (not
 * just used internally by `requireGrant`) for routes that need to check a
 * credential *conditionally* — e.g. a page that also accepts a normal
 * logged-in session, where you don't want to unconditionally reject
 * requests with no credential the way `requireGrant` does.
 */
export function getCredentialFromRequest(req: Request, options: RequireGrantOptions = {}): string | null {
  if (options.credentialHeader) {
    const value = req.headers[options.credentialHeader.toLowerCase()];
    return typeof value === "string" ? value : null;
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

/**
 * Express middleware gating a route on a valid HAPI grant. On success,
 * attaches `req.hapiGrant` and calls next(); on failure, the agent is
 * treated exactly like any other unauthenticated request — your normal
 * fallback flow (login, CAPTCHA, manual signup) still applies.
 */
export function requireGrant(hapi: HAPI, options: RequireGrantOptions = {}) {
  return async (req: HAPIRequest, res: Response, next: NextFunction) => {
    const credential = getCredentialFromRequest(req, options);
    if (!credential) {
      return res.status(401).json({ error: "missing HAPI credential" });
    }

    const result = await hapi.verify(credential);
    if (!result.valid) {
      return res.status(403).json({ error: "not authorised", reason: result.reason });
    }

    req.hapiGrant = {
      userId: result.userId,
      agentId: result.agentId,
      expiresAt: result.expiresAt,
    };
    req.hapiCredential = credential;
    next();
  };
}
