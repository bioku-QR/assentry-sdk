# @hapi-id/sdk

[MIT licensed](./LICENSE). Server-side SDK for partner sites that accept authorised [HAPI](https://github.com/bioku-QR/hapi) agent traffic — wraps the `/verify`, `/profile`, and account-linking handshake against the HAPI backend. Install this instead of calling the raw API yourself.

Not published to npm yet; install directly from this repo in the meantime:

```bash
npm install github:bioku-QR/hapi-sdk
```

## Usage

```ts
import { HAPI, requireGrant, HAPIRequest } from "@hapi-id/sdk";
import express from "express";

const hapi = new HAPI({ apiKey: process.env.HAPI_API_KEY! });

const app = express();
app.use(express.json());

app.post("/apply", requireGrant(hapi, "job_application:submit"), async (req: HAPIRequest, res) => {
  const profile = await hapi.getProfile(req.hapiCredential!, ["name", "email", "resume"]);
  if (!profile.valid) return res.status(403).json({ error: profile.reason });

  // req.hapiGrant has { userId, agentId, scope, expiresAt }; profile.profile
  // has only the fields the user actually consented to disclose for this grant.
  res.json({ status: "submitted", applicant: profile.profile });
});
```

An agent presents its credential as a standard `Authorization: Bearer <credential>` header — `requireGrant` expects this by default, which matters: it's the convention any reasonably capable agent will already use without needing a site-specific instruction, so there's nothing for you to document or for an agent to guess.

If you'd rather not use the Express middleware, call `hapi.verify(credential, action)` and `hapi.getProfile(credential, fields)` directly — `requireGrant` is a thin convenience wrapper over both. If you need to check a credential *conditionally* instead of unconditionally requiring one (e.g. a page that also accepts a normal logged-in session), use the lower-level `getCredentialFromRequest(req)` that `requireGrant` uses internally — same convention, without the automatic 401.

## Linking an existing account

`verify`/`getProfile` cover agents acting on *new* flows your site builds for them. If a user already has an account with you from before they connected HAPI, a credential alone doesn't tell you which of your accounts it belongs to — you need a one-time confirmation first:

```ts
const hapi = new HAPI({
  apiKey: process.env.HAPI_API_KEY!,
  partnerId: process.env.HAPI_PARTNER_PUBLIC_ID!, // safe to expose, unlike the API key
});

// 1. An already-logged-in user on your site clicks "Link your HAPI account"
app.get("/link/start", (req, res) => {
  res.redirect(hapi.getAccountLinkUrl({ redirectUri: "https://yoursite.com/link/callback" }));
});

// 2. HAPI sends them back here after they log in and confirm
app.get("/link/callback", async (req, res) => {
  const { userId } = await hapi.exchangeLinkCode(String(req.query.code));
  // store userId against the current user's existing account record
  res.send("Linked!");
});
```

After that, any credential that resolves to that `userId` is proof of *this specific* existing account — still no password at any point.

## License

MIT — see [LICENSE](./LICENSE). The HAPI backend and personal app this SDK talks to are separate, proprietary services.
