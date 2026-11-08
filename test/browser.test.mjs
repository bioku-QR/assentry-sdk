// Run with `npm test` (builds first). Uses Node's built-in test runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePendingSignIn, injectSignInBlock } from "../dist/browser.js";

const GOOD_CODE = "asq_" + "ABCD2345".repeat(7).slice(0, 52);
const REQUEST_ID = "3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const future = () => new Date(Date.now() + 4 * 60 * 1000).toISOString();

function fakeReq({ cookie, secure = false } = {}) {
  return { headers: cookie ? { cookie } : {}, secure };
}
function fakeRes() {
  const cookies = [];
  let sent;
  return {
    cookies,
    get sent() { return sent; },
    append(name, value) { if (name === "Set-Cookie") cookies.push(value); },
    getHeader() { return "text/html; charset=utf-8"; },
    send(body) { sent = body; return this; },
  };
}
function fakeAssentry() {
  return { startSignIn: async () => ({ requestId: REQUEST_ID, code: GOOD_CODE, expiresAt: future() }) };
}

test("a planted pending cookie with markup in it is ignored, not reused", async () => {
  const evil = encodeURIComponent(`${REQUEST_ID}|"><script>alert(1)</script>|${future()}`);
  const res = fakeRes();
  const pending = await ensurePendingSignIn(fakeReq({ cookie: `assentry_sign_in=${evil}` }), res, fakeAssentry());
  assert.equal(pending.code, GOOD_CODE);
});

test("a well-formed pending sign-in is reused", async () => {
  const value = encodeURIComponent(`${REQUEST_ID}|${GOOD_CODE}|${future()}`);
  let started = false;
  const assentry = { startSignIn: async () => { started = true; return {}; } };
  const pending = await ensurePendingSignIn(fakeReq({ cookie: `assentry_sign_in=${value}` }), fakeRes(), assentry);
  assert.equal(pending.code, GOOD_CODE);
  assert.equal(started, false);
});

test("over HTTPS the cookies use the __Host- prefix and Secure", async () => {
  const res = fakeRes();
  await ensurePendingSignIn(fakeReq({ secure: true }), res, fakeAssentry());
  assert.match(res.cookies[0], /^__Host-assentry_sign_in=/);
  assert.match(res.cookies[0], /; Secure/);
  // A cookie without the prefix (which another subdomain could set) is ignored over HTTPS.
  const value = encodeURIComponent(`${REQUEST_ID}|${GOOD_CODE}|${future()}`);
  let started = false;
  const assentry = { startSignIn: async () => { started = true; return { requestId: REQUEST_ID, code: GOOD_CODE, expiresAt: future() }; } };
  await ensurePendingSignIn(fakeReq({ secure: true, cookie: `assentry_sign_in=${value}` }), fakeRes(), assentry);
  assert.equal(started, true);
});

test("the code placed into the page is escaped", () => {
  const res = fakeRes();
  injectSignInBlock(res, `"><img src=x onerror=alert(1)>`);
  res.send("<!doctype html><html><body><p>hi</p></body></html>");
  assert.ok(!res.sent.includes("<img src=x"));
  assert.ok(res.sent.includes("&lt;img src=x onerror=alert(1)&gt;"));
});
