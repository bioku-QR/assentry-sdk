# @assentry/sdk

[MIT licensed](./LICENSE). Server-side SDK for partner sites that accept authorised [Assentry](https://assentry.io) agent traffic. It wraps the `/verify`, `/profile`, and account-linking handshake against the Assentry backend. Install this instead of calling the raw API yourself.

```bash
npm install @assentry/sdk
```

## Usage

```ts
import { Assentry, requireGrant, AssentryRequest } from "@assentry/sdk";
import express from "express";

const assentry = new Assentry({ apiKey: process.env.ASSENTRY_API_KEY! });
// Talks to https://api.assentry.io. For a local Assentry, add baseUrl: "http://localhost:4000".

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

An agent presents its credential as a standard `Authorization: Bearer <credential>` header. `requireGrant` expects this by default, which matters: it's the convention any reasonably capable agent will already use without needing a site-specific instruction, so there's nothing for you to document or for an agent to guess. When no credential is presented, `requireGrant` responds with a standard `401` plus a `WWW-Authenticate: Bearer` header: the HTTP-native "send a credential" challenge, not a site-specific one.

Each credential is issued for one site's verified domain and refused anywhere else, so a site can't reuse a credential it received to get into another site. `verify` returns a `userId` and `agentId` specific to your developer account: stable for a person across your apps (key your accounts on `userId`), but different for every other developer, so sites can't link a person between them. `getProfile` only returns details your app declared in the Assentry developer console *and* the person allowed.

Every detail has a fixed type and format, shown next to it in the console: text, long text, email, phone (E.164, e.g. `+447700900123`), date (`YYYY-MM-DD`), url, integer, decimal, boolean, choice, country (ISO code), address (an object with `street_address`, `locality`, `region`, `postal_code`, `country`, `formatted`) and file. You can also declare your own details (with a label and one of these types), and mark each detail required or optional. If a person's agent signs in without a required detail, Assentry asks the person for it, and `getProfile` lists it in `missing` until they provide it. `meta` tells you whether each value was entered by the person or suggested by their agent and confirmed by them.

Files arrive as a link that works once, for 5 minutes, and only with your API key:

```ts
const { profile } = await assentry.getProfile(credential, ["resume"]);
if (profile.resume) {
  const { bytes, filename } = await assentry.downloadFile(profile.resume as ProfileFile);
}
```

A valid grant means the agent may act for the person who issued it, and `getProfile` only returns the fields they agreed to share. Which routes a verified person may reach is your application's decision, like any other authorization decision your site makes.

If you'd rather not use the Express middleware, call `assentry.verify(credential)` and `assentry.getProfile(credential, fields)` directly; `requireGrant` is a thin convenience wrapper over both. If you need to check a credential *conditionally* instead of unconditionally requiring one (e.g. a page that also accepts a normal logged-in session), use the lower-level `getCredentialFromRequest(req)` that `requireGrant` uses internally: same convention, without the automatic 401.

## Letting an agent discover where to go

An agent given a generic instruction has to find your `requireGrant`-protected route by browsing, and without a human login, it'll only ever find your human login wall, correctly refuse to work around it, and give up. `assentryDiscovery` fixes that: mount it once, before your other routes, and it makes the site discoverable from *any* page the agent lands on, not just one you happen to document:

```ts
import { assentryDiscovery } from "@assentry/sdk";

app.use(assentryDiscovery({ partnerName: "Acme" }));
```

This does two things on every single response, including 404s: sets the standard HTTP `Link` header (RFC 8288) pointing at a discovery document, and serves that document at `/.well-known/assentry.json` (RFC 8615), listing every agent-accessible route and that credentials go in a standard `Authorization: Bearer` header. An agent that only ever reaches your 404 page or your human login screen still gets the signal that there's another way in.

There's no `routes` list to pass in here: a route becomes discoverable by stating it once, right where it's defined: either via `requireGrant`'s `discover` option (above), or, for a route that can't use `requireGrant` directly (e.g. one that also accepts a normal session), by calling `declareDiscoverableRoute` once at startup:

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

Either way, there's nothing to keep in sync by hand: the discovery document always reflects whatever's actually been declared as protected, not a separate list that can drift out of date.

## Letting browser agents in

Some agents drive a real browser (clicking and reading pages, like a person). They can't attach an `Authorization` header, and they must never type a credential into a website. Pass your Assentry client to `assentryDiscovery` and they can still sign in, without handing your site anything:

```ts
app.use(assentryDiscovery({ partnerName: "Acme", assentry }));
```

First, in the Assentry developer console, give your app its domain (e.g. `shop.example.com`) and click **Verify**. The SDK serves the proof at `/.well-known/assentry-domain-verification` for you, so you only need to deploy the site first. Until the domain is verified, no sign-in codes are shown: agents are told which site a code belongs to by its verified domain, so it has to be real.

How it works:

1. When someone who isn't signed in opens one of your HTML pages, the SDK asks Assentry (server-to-server, with your API key) for a sign-in code and shows it at the bottom of the page: "Assentry sign-in code: asq_ZV4V2FYS…" (`asq_` plus 52 random characters, so it can't be guessed). It's also in a `<meta name="assentry-sign-in-code">` tag and an `Assentry-Sign-In-Code` response header.
2. The agent approves that code through its own Assentry connection (the `approve_sign_in` tool), passing the domain from its address bar. Assentry refuses unless the code was issued to that verified domain, so a code copied from another site can't be approved here. Approving is also what ties the code to a person: whichever agent approves it, using that person's permission. The first time a person's agent signs in to your site, the person allows your site in the Assentry app; the page says it's waiting for them and continues once they do.
3. The page checks back every few seconds. Once approved, your server collects the result from Assentry (once only), keeps the credential in an httpOnly cookie that expires with the person's permission, and the page moves on to your first protected route.

`getCredentialFromRequest` (and so `requireGrant`) reads that cookie as well as the header, so your protected routes need no changes. Every request is still re-checked with Assentry, so withdrawing permission takes effect immediately. `/assentry/sign-out` clears it.

Codes are random, single-use, tied to your site, and expire after 5 minutes. Each visitor gets their own code. The page uses a small inline script to check back; if your site's Content Security Policy blocks inline scripts, allow it or reload the page after approving.

## When Assentry can't be reached

`verify` and `getProfile` never throw. If Assentry is unreachable, or rejects your API key (missing or wrong `ASSENTRY_API_KEY`), they return `{ valid: false, reason: "assentry_unavailable" }` and log the cause, so the agent is denied cleanly instead of your route crashing.

## Linking an existing account

`verify`/`getProfile` cover agents acting on *new* flows your site builds for them. If a user already has an account with you from before they connected Assentry, a credential alone doesn't tell you which of your accounts it belongs to. You need a one-time confirmation first:

```ts
const assentry = new Assentry({
  apiKey: process.env.ASSENTRY_API_KEY!,
  partnerId: process.env.ASSENTRY_PARTNER_PUBLIC_ID!, // safe to expose, unlike the API key
});

// 1. An already-logged-in user on your site clicks "Link your Assentry account".
//    state is a fresh random value kept in their session and checked on return.
app.get("/link/start", (req, res) => {
  req.session.linkState = crypto.randomBytes(32).toString("base64url");
  res.redirect(assentry.getAccountLinkUrl({ redirectUri: "https://yoursite.com/link/callback", state: req.session.linkState }));
});

// 2. Assentry sends them back here after they log in and confirm
app.get("/link/callback", async (req, res) => {
  const expected = req.session.linkState;
  delete req.session.linkState;
  if (!expected || req.query.state !== expected) return res.status(400).send("Linking expired. Try again.");
  const { userId } = await assentry.exchangeLinkCode(String(req.query.code));
  // store userId against the current user's existing account record
  res.send("Linked!");
});
```

After that, any credential that resolves to that `userId` is proof of *this specific* existing account, still with no password at any point.

## License

MIT, see [LICENSE](./LICENSE). The Assentry backend and personal app this SDK talks to are separate, proprietary services.
