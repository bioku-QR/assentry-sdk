import type { Request, Response } from "express";
import type { Assentry } from "./client";

// Browser-driving agents (an assistant clicking through Chrome) can read and
// type into pages, but can't attach an Authorization header. This module lets
// them hand their credential over once through an ordinary form; the SDK
// verifies it and keeps it in an httpOnly cookie, which
// getCredentialFromRequest then reads like a header. The credential is still
// re-verified with Assentry on every protected request, so revoking or
// expiring the grant cuts the browser session off immediately.

export const SIGN_IN_PATH = "/assentry/sign-in";
export const SIGN_OUT_PATH = "/assentry/sign-out";
export const CREDENTIAL_COOKIE = "assentry_credential";

export function readCredentialCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === CREDENTIAL_COOKIE) {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value || null;
    }
  }
  return null;
}

function isHttps(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setCredentialCookie(req: Request, res: Response, credential: string, expiresAt: string) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const attrs = [
    `${CREDENTIAL_COOKIE}=${encodeURIComponent(credential)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function clearCredentialCookie(res: Response) {
  res.append("Set-Cookie", `${CREDENTIAL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Only same-site relative paths, so the form can't be used as an open redirect. */
function safeReturnTo(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function readFormBody(req: Request): Promise<Record<string, string>> {
  // Use whatever body parser the site already mounted, if any.
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return req.body as Record<string, string>;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function signInPage(opts: { partnerName: string; returnTo: string; error?: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in with Assentry · ${escapeHtml(opts.partnerName)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:440px;margin:72px auto;padding:0 16px;color:#111}
textarea{width:100%;box-sizing:border-box;padding:8px;font-family:ui-monospace,monospace;font-size:12px}
button{margin-top:12px;padding:8px 16px}.error{color:#b91c1c}.note{color:#555;font-size:14px}</style></head>
<body>
  <h2>Sign in with Assentry</h2>
  <p class="note">For AI agents acting on a person's behalf. Paste the Assentry credential your
  grant issued for ${escapeHtml(opts.partnerName)} below. ${escapeHtml(opts.partnerName)} checks it with Assentry,
  then signs you in for as long as the person's permission lasts. No password or signup needed.</p>
  ${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="${SIGN_IN_PATH}">
    <label for="assentry-credential">Assentry credential</label>
    <textarea id="assentry-credential" name="credential" rows="6" required autocomplete="off" spellcheck="false"></textarea>
    <input type="hidden" name="return_to" value="${escapeHtml(opts.returnTo)}">
    <button type="submit">Sign in</button>
  </form>
  <p class="note">A person signing in normally? <a href="/">Go back</a>.</p>
</body></html>`;
}

const DENIAL_TEXT: Record<string, string> = {
  invalid_credential: "That credential isn't valid. Fetch a fresh one from Assentry and try again.",
  grant_not_found: "That permission no longer exists. Ask the person to authorise you again.",
  revoked: "The person has withdrawn this permission.",
  agent_revoked: "The person has disconnected this agent.",
  expired: "That permission has expired. Ask the person to renew it.",
  assentry_unavailable: "This site couldn't reach Assentry to check the credential. Try again shortly.",
};

/**
 * Handles the browser sign-in routes. Returns true if it answered the request.
 */
export async function handleBrowserSignIn(
  req: Request,
  res: Response,
  assentry: Assentry,
  opts: { partnerName: string; defaultReturnTo: string }
): Promise<boolean> {
  if (req.path === SIGN_OUT_PATH) {
    clearCredentialCookie(res);
    res.redirect(303, "/");
    return true;
  }
  if (req.path !== SIGN_IN_PATH) return false;

  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const returnTo = safeReturnTo(req.query.return_to, opts.defaultReturnTo);
    res.type("html").send(signInPage({ partnerName: opts.partnerName, returnTo }));
    return true;
  }

  if (req.method === "POST") {
    const body = await readFormBody(req);
    const credential = String(body.credential ?? "").trim().replace(/^Bearer\s+/i, "");
    const returnTo = safeReturnTo(body.return_to, opts.defaultReturnTo);
    if (!credential) {
      res.status(400).type("html").send(signInPage({ ...opts, returnTo, error: "Paste a credential first." }));
      return true;
    }
    const result = await assentry.verify(credential);
    if (!result.valid) {
      const status = result.reason === "assentry_unavailable" ? 503 : 403;
      res
        .status(status)
        .type("html")
        .send(signInPage({ ...opts, returnTo, error: DENIAL_TEXT[result.reason] ?? "Not authorised." }));
      return true;
    }
    setCredentialCookie(req, res, credential, result.expiresAt);
    res.redirect(303, returnTo);
    return true;
  }

  res.status(405).setHeader("Allow", "GET, POST").end();
  return true;
}

const NOTICE_MARKER = "data-assentry-notice";

function noticeHtml(): string {
  return `<div ${NOTICE_MARKER} style="margin:32px auto 16px;max-width:640px;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font:14px -apple-system,system-ui,sans-serif;color:#333;text-align:center">
AI agent acting for someone? <a href="${SIGN_IN_PATH}">Sign in with Assentry</a> instead of using a password.
</div>`;
}

/**
 * Wraps res.send so every HTML page the site serves carries a short, visible
 * line pointing browser agents at the sign-in page. Agents that read pages
 * (rather than HTTP headers) would otherwise never learn there's a way in
 * besides the human login form.
 */
export function injectAgentNotice(req: Request, res: Response) {
  if (req.path === SIGN_IN_PATH) return;
  if (readCredentialCookie(req)) return; // already signed in through Assentry
  const originalSend = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (typeof body === "string" && !body.includes(NOTICE_MARKER)) {
      const type = String(res.getHeader("Content-Type") ?? "");
      const looksHtml = type.includes("text/html") || (!type && /^\s*<(!doctype|html)/i.test(body));
      const close = body.lastIndexOf("</body>");
      if (looksHtml && close !== -1) {
        body = body.slice(0, close) + noticeHtml() + body.slice(close);
      }
    }
    return originalSend(body as never);
  }) as typeof res.send;
}
