# @assentry/sdk

[MIT licensed](./LICENSE). Server-side SDK for partner sites that accept authorised [Assentry](https://github.com/bioku-QR/assentry) agent traffic — wraps the `/verify`, `/profile`, and account-linking handshake against the Assentry backend. Install this instead of calling the raw API yourself.

Not published to npm yet; install directly from this repo in the meantime:

```bash
npm install github:bioku-QR/assentry-sdk
```

## Usage

```ts
import { Assentry, requireGrant, AssentryRequest } from "@assentry/sdk";
import express from "express";

const assentry = new Assentry({ apiKey: process.env.ASSENTRY_API_KEY! });

const app = express();
app.use(express.json());

app.get(
  "/account",
  requireGrant(assentry, {
    discover: { path: "/account", method: "GET", description: "View the person's account" },
  }),
  async (req: AssentryRequest, res) => {
    const profile = await assentry.getProfile(req.assentryCredential!, ["name", "email"]);
    if (!profile.valid) return res.status(403).json({ error: profile.reason });

    // req.assentryGrant has { userId, agentId, expiresAt }; profile.profile has
    // only the fields the user actually consented to disclose for this grant.
    res.json({ account: profile.profile });
  }
);
```

An agent presents its credential as a standard `Authorization: Bearer <credential>` header — `requireGrant` expects this by default, which matters: it's the convention any reasonably capable agent will already use without needing a site-specific instruction, so there's nothing for you to document or for an agent to guess. When no credential is presented, `requireGrant` responds with a standard `401` plus a `WWW-Authenticate: Bearer` header — the HTTP-native "send a credential" challenge, not a site-specific one.

A valid grant means the agent may act for the person who issued it — there's no separate per-action scope check for now, only `getProfile`'s existing per-field consent. If you need a route to only be reachable by certain grants, that's on your own application logic for the moment, same as any other authorization decision your site makes.

If you'd rather not use the Express middleware, call `assentry.verify(credential)` and `assentry.getProfile(credential, fields)` directly — `requireGrant` is a thin convenience wrapper over both. If you need to check a credential *conditionally* instead of unconditionally requiring one (e.g. a page that also accepts a normal logged-in session), use the lower-level `getCredentialFromRequest(req)` that `requireGrant` uses internally — same convention, without the automatic 401.

## Letting an agent discover where to go

An agent given a generic instruction has to find your `requireGrant`-protected route by browsing — and without a human login, it'll only ever find your human login wall, correctly refuse to work around it, and give up. `assentryDiscovery` fixes that: mount it once, before your other routes, and it makes the site discoverable from *any* page the agent lands on, not just one you happen to document:

```ts
import { assentryDiscovery } from "@assentry/sdk";

app.use(assentryDiscovery({ partnerName: "Acme" }));
```

This does two things on every single response, including 404s: sets the standard HTTP `Link` header (RFC 8288) pointing at a discovery document, and serves that document at `/.well-known/assentry.json` (RFC 8615) — listing every agent-accessible route and that credentials go in a standard `Authorization: Bearer` header. An agent that only ever reaches your 404 page or your human login screen still gets the signal that there's another way in.

There's no `routes` list to pass in here — a route becomes discoverable by stating it once, right where it's defined: either via `requireGrant`'s `discover` option (above), or, for a route that can't use `requireGrant` directly (e.g. one that also accepts a normal session), by calling `declareDiscoverableRoute` once at startup:

```ts
import { declareDiscoverableRoute, getCredentialFromRequest } from "@assentry/sdk";

declareDiscoverableRoute({ path: "/dashboard", method: "GET", description: "View protected content" });

app.get("/dashboard", async (req, res) => {
  if (req.session?.user) return res.send(renderDashboard(req.session.user));

  const credential = getCredentialFromRequest(req);
  if (!credential) return res.redirect("/login");
  // ...verify the credential yourself, same as requireGrant does internally
});
```

Either way, there's nothing to keep in sync by hand — the discovery document always reflects whatever's actually been declared as protected, not a separate list that can drift out of date.

## Linking an existing account

`verify`/`getProfile` cover agents acting on *new* flows your site builds for them. If a user already has an account with you from before they connected Assentry, a credential alone doesn't tell you which of your accounts it belongs to — you need a one-time confirmation first:

```ts
const assentry = new Assentry({
  apiKey: process.env.ASSENTRY_API_KEY!,
  partnerId: process.env.ASSENTRY_PARTNER_PUBLIC_ID!, // safe to expose, unlike the API key
});

// 1. An already-logged-in user on your site clicks "Link your Assentry account"
app.get("/link/start", (req, res) => {
  res.redirect(assentry.getAccountLinkUrl({ redirectUri: "https://yoursite.com/link/callback" }));
});

// 2. Assentry sends them back here after they log in and confirm
app.get("/link/callback", async (req, res) => {
  const { userId } = await assentry.exchangeLinkCode(String(req.query.code));
  // store userId against the current user's existing account record
  res.send("Linked!");
});
```

After that, any credential that resolves to that `userId` is proof of *this specific* existing account — still no password at any point.

## License

MIT — see [LICENSE](./LICENSE). The Assentry backend and personal app this SDK talks to are separate, proprietary services.
