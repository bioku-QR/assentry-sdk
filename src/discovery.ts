import type { NextFunction, Request, Response } from "express";

export interface HAPIDiscoveryRoute {
  /** Path the route is mounted at, e.g. "/dashboard". */
  path: string;
  /** HTTP method an agent should use to reach it. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A short description of what this route does, for an agent deciding where to go. */
  description: string;
}

export interface HAPIDiscoveryOptions {
  /** This site's display name, shown in the discovery document. */
  partnerName: string;
  /** Every route on this site that accepts a HAPI credential. */
  routes: HAPIDiscoveryRoute[];
}

const WELL_KNOWN_PATH = "/.well-known/hapi.json";

/**
 * Makes a site discoverable to an AI agent from the moment it reaches *any*
 * page — not just a login page or a docs link the agent happens to find.
 * Mount this once, before your other routes:
 *
 *   app.use(hapiDiscovery({ partnerName: "Acme Jobs", routes: [...] }));
 *
 * It does two things, on every single request:
 *
 * 1. Sets the standard HTTP `Link` header (RFC 8288) on every response —
 *    success, redirect, or 404 — pointing at the discovery document. An
 *    agent doesn't need to already be on a particular page to find it; it's
 *    on whatever page it landed on first.
 * 2. Serves `/.well-known/hapi.json` (RFC 8615) itself: every
 *    `requireGrant`-protected route on the site and exactly how to present
 *    a credential — so an agent that only has a generic instruction can
 *    find its own way to the right endpoint instead of hitting a human
 *    login wall with no way through.
 */
export function hapiDiscovery(options: HAPIDiscoveryOptions) {
  const document = {
    hapi_version: "1",
    partner: options.partnerName,
    description:
      "This site accepts AI agents acting on a person's behalf, authorised and verified through HAPI (https://github.com/bioku-QR/hapi).",
    credential: {
      header: "Authorization",
      scheme: "Bearer",
      instructions:
        "Present the HAPI credential your grant issued as 'Authorization: Bearer <credential>' on the routes below. No login, session or signup is needed or should be attempted.",
    },
    routes: options.routes,
  };

  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Link", `<${WELL_KNOWN_PATH}>; rel="hapi-agent-discovery"`);
    if (req.path === WELL_KNOWN_PATH) {
      res.json(document);
      return;
    }
    next();
  };
}
