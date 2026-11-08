import type { Request, Response } from "express";
import type { Assentry } from "./client";

// Browser-driving agents (an assistant clicking through Chrome) can't attach
// an Authorization header, and must never type a credential into a website.
// So the site never receives anything from the agent directly:
//
// 1. When a page loads, the SDK asks Assentry (server-to-server, with the
//    site's API key) for a long random sign-in code, and shows it on the page.
// 2. The agent reads the code and approves it through its own Assentry
//    connection (the approve_sign_in tool). That's what ties the code to a
//    person: whichever agent approves it, with that person's permission.
// 3. The page checks back with the site, which collects the result from
//    Assentry, keeps the issued credential in an httpOnly cookie, and moves on.
//
// The credential is re-verified with Assentry on every protected request,
// so withdrawing permission cuts the browser session off immediately.

export const STATUS_PATH = "/assentry/sign-in/status";
export const SIGN_OUT_PATH = "/assentry/sign-out";
export const CREDENTIAL_COOKIE = "assentry_credential";
const PENDING_COOKIE = "assentry_sign_in";
export const CODE_HEADER = "Assentry-Sign-In-Code";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value || null;
    }
  }
  return null;
}

// Set on a request once its cookie credential has been found to be dead,
// so the rest of the request treats the visitor as signed out.
const DEAD_SESSION = Symbol("assentryDeadSession");

function isSecure(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Over HTTPS the cookies use the __Host- prefix: browsers only accept such a
 * cookie from this exact host over HTTPS, so another subdomain (or a plain
 * HTTP response) can't plant a sign-in or a credential in a visitor's browser.
 */
function cookieName(req: Request, base: string): string {
  return isSecure(req) ? `__Host-${base}` : base;
}

export function readCredentialCookie(req: Request): string | null {
  if ((req as unknown as Record<symbol, boolean>)[DEAD_SESSION]) return null;
  return readCookie(req, cookieName(req, CREDENTIAL_COOKIE));
}

/**
 * For a page view carrying a browser-agent session: checks the credential
 * is still good. If the person withdrew the permission (or it expired), the
 * cookie is cleared and the visitor is treated as signed out, so the page
 * offers a fresh sign-in code instead of a dead end. If Assentry can't be
 * reached, the session is left alone. Returns true if still signed in.
 */
export async function checkBrowserSession(req: Request, res: Response, assentry: Assentry): Promise<boolean> {
  const credential = readCredentialCookie(req);
  if (!credential) return false;
  const result = await assentry.verify(credential);
  if (result.valid || result.reason === "assentry_unavailable") return true;
  clearCookie(req, res, CREDENTIAL_COOKIE);
  (req as unknown as Record<symbol, boolean>)[DEAD_SESSION] = true;
  return false;
}

function setCookie(req: Request, res: Response, base: string, value: string, maxAgeSeconds: number) {
  const attrs = [`${cookieName(req, base)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (isSecure(req)) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function clearCookie(req: Request, res: Response, base: string) {
  const secure = isSecure(req) ? "; Secure" : "";
  res.append("Set-Cookie", `${cookieName(req, base)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

interface PendingSignIn {
  requestId: string;
  code: string;
  expiresAt: string;
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^asq_[2-9A-HJ-NP-Z]{52}$/;

/** The visitor's pending sign-in, only if every part looks exactly as Assentry issues it. */
function readPending(req: Request): PendingSignIn | null {
  const raw = readCookie(req, cookieName(req, PENDING_COOKIE));
  if (!raw) return null;
  const [requestId, code, expiresAt] = raw.split("|");
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId) || !code || !CODE_PATTERN.test(code) || !expiresAt) return null;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry) || expiry <= Date.now() + 15_000) return null;
  return { requestId, code, expiresAt };
}

/** Only same-site relative paths, so `next` can't become an open redirect. */
function isSafePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

/** Answers the status and sign-out routes. Returns true if it handled the request. */
export async function handleSignInRoutes(
  req: Request,
  res: Response,
  assentry: Assentry,
  opts: { protectedPaths: string[]; defaultReturnTo: string }
): Promise<boolean> {
  if (req.path === SIGN_OUT_PATH) {
    clearCookie(req, res, CREDENTIAL_COOKIE);
    clearCookie(req, res, PENDING_COOKIE);
    res.redirect(303, "/");
    return true;
  }
  if (req.path !== STATUS_PATH) return false;

  res.setHeader("Cache-Control", "no-store");
  const raw = readCookie(req, cookieName(req, PENDING_COOKIE));
  const requestId = raw?.split("|")[0];
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    res.json({ status: "expired" });
    return true;
  }

  const result = await assentry.collectSignIn(requestId);
  if (result.status === "approved") {
    setCookie(req, res, CREDENTIAL_COOKIE, result.credential, secondsUntil(result.expiresAt));
    clearCookie(req, res, PENDING_COOKIE);
    // Back to the page the agent was on if it's a protected one; otherwise
    // (e.g. it was bounced to a login page) to the first protected page.
    const from = req.query.from;
    const next = isSafePath(from) && opts.protectedPaths.includes(from) ? from : opts.defaultReturnTo;
    res.json({ status: "approved", next });
    return true;
  }
  if (result.status === "pending") {
    // While the person allows the site, Assentry gives the code longer; keep
    // the visitor's pending sign-in for as long.
    const current = readPending(req);
    if (current && result.expiresAt && new Date(result.expiresAt).getTime() > new Date(current.expiresAt).getTime()) {
      setCookie(req, res, PENDING_COOKIE, `${current.requestId}|${current.code}|${result.expiresAt}`, secondsUntil(result.expiresAt));
    }
    res.json({ status: "pending", waitingFor: result.waitingFor });
    return true;
  }
  if (result.status === "assentry_unavailable") {
    res.json({ status: "unavailable" });
    return true;
  }
  clearCookie(req, res, PENDING_COOKIE);
  if (result.status === "denied") {
    res.json({ status: "denied", reason: result.reason === "person_declined" ? "declined" : "invalid" });
    return true;
  }
  res.json({ status: "expired" });
  return true;
}

/**
 * For a page view by someone not yet signed in: reuse this visitor's pending
 * code, or ask Assentry for a new one. Returns null if Assentry can't be
 * reached, in which case the page is served without a code.
 */
export async function ensurePendingSignIn(req: Request, res: Response, assentry: Assentry): Promise<PendingSignIn | null> {
  const existing = readPending(req);
  if (existing) return existing;
  try {
    const started = await assentry.startSignIn();
    const pending = { requestId: started.requestId, code: started.code, expiresAt: started.expiresAt };
    setCookie(req, res, PENDING_COOKIE, `${pending.requestId}|${pending.code}|${pending.expiresAt}`, secondsUntil(pending.expiresAt));
    return pending;
  } catch (err) {
    console.error(`[assentry] couldn't start an agent sign-in: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const MARKER = "data-assentry-sign-in";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function signInBlock(rawCode: string): string {
  // Codes are checked against Assentry's format before they get here; this
  // is a second guard so nothing can ever be injected into the page.
  const code = escapeHtml(rawCode);
  // Plain text the agent can read, a meta tag for machine reading, and a
  // small script that checks back every few seconds and moves on once the
  // agent has approved the code through its Assentry connection.
  return `<meta name="assentry-sign-in-code" content="${code}">
<div ${MARKER} style="margin:32px auto 16px;max-width:640px;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font:14px -apple-system,system-ui,sans-serif;color:#333;text-align:center">
AI agent acting for someone? <strong>Assentry sign-in code:</strong>
<code id="assentry-sign-in-code" style="display:block;margin:6px 0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;user-select:all">${code}</code>
<span style="color:#666;font-size:13px">Approve it through your Assentry connection, with this site&#39;s domain from the address bar; this page continues by itself. Never type a credential here.</span>
<span id="assentry-sign-in-state" style="display:block;color:#666;font-size:13px"></span>
</div>
<script>(function(){var from=location.pathname,s=document.getElementById("assentry-sign-in-state");
function poll(){if(document.hidden){return setTimeout(poll,4000);}
fetch("${STATUS_PATH}?from="+encodeURIComponent(from),{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
if(d.status==="approved"){s.textContent="Approved. Signing in…";location.href=d.next;}
else if(d.status==="pending"){if(d.waitingFor==="person"){s.textContent="Waiting for the person to allow this site in their Assentry app.";}setTimeout(poll,2500);}
else if(d.status==="denied"){s.textContent=d.reason==="declined"?"The person declined this site.":"That permission is no longer valid.";}
else if(d.status==="unavailable"){s.textContent="Couldn't reach Assentry. Reload to try again.";}
else{s.textContent="This code has expired. Reload the page for a new one.";}
}).catch(function(){setTimeout(poll,5000);});}
setTimeout(poll,2500);})();</script>
`;
}

/**
 * Wraps res.send so the HTML page being served carries the sign-in code.
 * Only touches string bodies that are HTML and have a closing body tag.
 */
export function injectSignInBlock(res: Response, code: string) {
  const originalSend = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (typeof body === "string" && !body.includes(MARKER)) {
      const type = String(res.getHeader("Content-Type") ?? "");
      const looksHtml = type.includes("text/html") || (!type && /^\s*<(!doctype|html)/i.test(body));
      const close = body.lastIndexOf("</body>");
      if (looksHtml && close !== -1) body = body.slice(0, close) + signInBlock(code) + body.slice(close);
    }
    return originalSend(body as never);
  }) as typeof res.send;
}
