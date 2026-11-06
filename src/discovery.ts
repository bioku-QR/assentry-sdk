import type { NextFunction, Request, Response } from "express";
import type { Assentry } from "./client";
import { handleBrowserSignIn, injectAgentNotice, SIGN_IN_PATH, SIGN_OUT_PATH } from "./browser";

export interface DiscoverableRoute {
  /** Path the route is mounted at, e.g. "/dashboard". */
  path: string;
  /** HTTP method an agent should use to reach it. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A short description of what this route does, for an agent deciding where to go. */
  description: string;
}

// One process = one site, so a single shared registry per process is the
// right scope. Populated as routes are defined at server startup (by
// requireGrant's `discover` option, or directly via declareDiscoverableRoute
// for routes that can't use requireGrant — e.g. ones that also accept a
// session) — never maintained as a separate hand-typed list that can drift
// out of sync with what's actually protected.
const registry = new Map<string, DiscoverableRoute>();

/**
 * Registers a route in the site's discovery document directly, for routes
 * that don't go through `requireGrant` — e.g. a page that accepts either a
 * normal session *or* an Assentry credential, where you're checking the
 * credential conditionally with `getCredentialFromRequest` instead. Call
 * this once, at startup, right where the route itself is defined — same
 * principle as `requireGrant`'s `discover` option, just for routes that
 * can't use `requireGrant` directly.
 */
export function declareDiscoverableRoute(route: DiscoverableRoute): void {
  registry.set(`${route.method} ${route.path}`, route);
}

export interface AssentryDiscoveryOptions {
  /** This site's display name, shown in the discovery document. */
  partnerName: string;
  /**
   * Your Assentry client. Pass it to let browser-driving agents in too: it
   * serves a sign-in page at /assentry/sign-in where an agent pastes its
   * credential once, and adds a short visible "Sign in with Assentry" line
   * to your HTML pages so those agents can find it. Without it, only agents
   * that send an Authorization header can get in.
   */
  assentry?: Assentry;
  /**
   * Set false to keep the visible notice off your pages (the sign-in page
   * still works). Defaults to true when `assentry` is given.
   */
  showAgentNotice?: boolean;
}

const WELL_KNOWN_PATH = "/.well-known/assentry.json";

/**
 * Makes a site discoverable to an AI agent from the moment it reaches *any*
 * page — not just a login page or a docs link the agent happens to find.
 * Mount this once, before your other routes:
 *
 *   app.use(assentryDiscovery({ partnerName: "Acme" }));
 *
 * It does two things, on every single request:
 *
 * 1. Sets the standard HTTP `Link` header (RFC 8288) on every response —
 *    success, redirect, or 404 — pointing at the discovery document. An
 *    agent doesn't need to already be on a particular page to find it; it's
 *    on whatever page it landed on first.
 * 2. Serves `/.well-known/assentry.json` (RFC 8615) itself: every route
 *    registered via `requireGrant`'s `discover` option or
 *    `declareDiscoverableRoute`, and exactly how to present a credential —
 *    so an agent that only has a generic instruction can find its own way
 *    to the right endpoint instead of hitting a human login wall with no
 *    way through.
 *
 * There's no separate `routes` list to pass in and keep in sync by hand —
 * this always reflects whatever's actually been registered as protected.
 */
export function assentryDiscovery(options: AssentryDiscoveryOptions) {
  const browser = options.assentry;
  const showNotice = browser !== undefined && options.showAgentNotice !== false;

  return async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Link", `<${WELL_KNOWN_PATH}>; rel="assentry-agent-discovery"`);
    if (req.path === WELL_KNOWN_PATH) {
      res.json({
        assentry_version: "1",
        partner: options.partnerName,
        description:
          "This site accepts AI agents acting on a person's behalf, authorised and verified through Assentry (https://github.com/bioku-QR/assentry).",
        credential: {
          header: "Authorization",
          scheme: "Bearer",
          instructions:
            "Present the Assentry credential your grant issued as 'Authorization: Bearer <credential>' on the routes below. No login, session or signup is needed or should be attempted.",
        },
        ...(browser
          ? {
              browser_sign_in: {
                path: SIGN_IN_PATH,
                sign_out_path: SIGN_OUT_PATH,
                instructions:
                  "If you are driving a browser and can't set headers, open this page, paste the credential into the form and submit. You'll be signed in until the person's permission ends.",
              },
            }
          : {}),
        routes: Array.from(registry.values()),
      });
      return;
    }

    if (browser) {
      try {
        const defaultReturnTo = registry.values().next().value?.path ?? "/";
        const handled = await handleBrowserSignIn(req, res, browser, {
          partnerName: options.partnerName,
          defaultReturnTo,
        });
        if (handled) return;
      } catch (err) {
        return next(err);
      }
      if (showNotice) injectAgentNotice(req, res);
    }
    next();
  };
}
