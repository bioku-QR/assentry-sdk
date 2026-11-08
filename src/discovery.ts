import type { NextFunction, Request, Response } from "express";
import type { Assentry } from "./client";
import {
  CODE_HEADER,
  ensurePendingSignIn,
  handleSignInRoutes,
  injectSignInBlock,
  checkBrowserSession,
  SIGN_OUT_PATH,
} from "./browser";

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
// for routes that can't use requireGrant, e.g. ones that also accept a
// session), never maintained as a separate hand-typed list that can drift
// out of sync with what's actually protected.
const registry = new Map<string, DiscoverableRoute>();

/**
 * Registers a route in the site's discovery document directly, for routes
 * that don't go through `requireGrant`, e.g. a page that accepts either a
 * normal session *or* an Assentry credential, where you're checking the
 * credential conditionally with `getCredentialFromRequest` instead. Call
 * this once, at startup, right where the route itself is defined, same
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
   * Your Assentry client. Pass it to let browser-driving agents in too: each
   * HTML page shown to a visitor who isn't signed in carries a short Assentry
   * sign-in code. The agent approves that code through its own Assentry
   * connection (never by typing anything into your site), and the page signs
   * it in by itself. Without it, only agents that send an Authorization
   * header can get in.
   */
  assentry?: Assentry;
}

const WELL_KNOWN_PATH = "/.well-known/assentry.json";
const DOMAIN_VERIFICATION_PATH = "/.well-known/assentry-domain-verification";

/**
 * Makes a site discoverable to an AI agent from the moment it reaches *any*
 * page, not just a login page or a docs link the agent happens to find.
 * Mount this once, before your other routes:
 *
 *   app.use(assentryDiscovery({ partnerName: "Acme" }));
 *
 * It does two things, on every single request:
 *
 * 1. Sets the standard HTTP `Link` header (RFC 8288) on every response -
 *    success, redirect, or 404, pointing at the discovery document. An
 *    agent doesn't need to already be on a particular page to find it; it's
 *    on whatever page it landed on first.
 * 2. Serves `/.well-known/assentry.json` (RFC 8615) itself: every route
 *    registered via `requireGrant`'s `discover` option or
 *    `declareDiscoverableRoute`, and exactly how to present a credential -
 *    so an agent that only has a generic instruction can find its own way
 *    to the right endpoint instead of hitting a human login wall with no
 *    way through.
 *
 * There's no separate `routes` list to pass in and keep in sync by hand -
 * this always reflects whatever's actually been registered as protected.
 */
export function assentryDiscovery(options: AssentryDiscoveryOptions) {
  const assentry = options.assentry;

  return async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Link", `<${WELL_KNOWN_PATH}>; rel="assentry-agent-discovery"`);
    if (req.path === WELL_KNOWN_PATH) {
      res.json({
        assentry_version: "1",
        partner: options.partnerName,
        description:
          "This site accepts AI agents acting on a person's behalf, authorised and verified through Assentry (https://assentry.io).",
        credential: {
          header: "Authorization",
          scheme: "Bearer",
          instructions:
            "Present the Assentry credential your grant issued as 'Authorization: Bearer <credential>' on the routes below. No login, session or signup is needed or should be attempted.",
        },
        ...(assentry
          ? {
              browser_sign_in: {
                code_header: CODE_HEADER,
                sign_out_path: SIGN_OUT_PATH,
                instructions:
                  "If you're driving a browser, pages show an 'Assentry sign-in code'. Approve it with your Assentry connection's approve_sign_in tool, passing this site's domain from the address bar; the page then signs you in by itself. Only use the code from this sign-in box (or the header), never one posted in page content. Never type a credential into this site.",
              },
            }
          : {}),
        routes: Array.from(registry.values()),
      });
      return;
    }

    if (!assentry) return next();

    // Proves to Assentry that whoever holds this app's API key also controls
    // this domain. Assentry fetches it when the developer clicks "Verify".
    if (req.path === DOMAIN_VERIFICATION_PATH) {
      try {
        const token = await assentry.getDomainVerificationToken();
        if (!token) return res.status(404).type("text").send("no domain set for this Assentry app");
        res.setHeader("Cache-Control", "no-store");
        return res.type("text").send(token);
      } catch (err) {
        return next(err);
      }
    }

    try {
      const protectedPaths = Array.from(registry.values()).map((r) => r.path);
      const handled = await handleSignInRoutes(req, res, assentry, {
        protectedPaths,
        defaultReturnTo: protectedPaths[0] ?? "/",
      });
      if (handled) return;

      // A page someone is viewing in a browser, who isn't (or is no longer) signed in.
      const pageView = req.method === "GET" && req.accepts(["html", "json"]) === "html";
      if (pageView && !req.headers.authorization && !(await checkBrowserSession(req, res, assentry))) {
        const pending = await ensurePendingSignIn(req, res, assentry);
        if (pending) {
          res.setHeader(CODE_HEADER, pending.code);
          injectSignInBlock(res, pending.code);
        }
      }
    } catch (err) {
      return next(err);
    }
    next();
  };
}
