import assert from "node:assert/strict";
import test from "node:test";
import {
  LiveScreenTicketStore,
  liveScreenOriginMatches,
  sanitizeCdpCommand,
  sanitizeLiveViewUrl,
  validateLiveScreenScope,
} from "../liveScreenSecurity.js";

test("Live Screen tickets are session-bound, one-use, expiring and revocable", () => {
  let now = 1000;
  const store = new LiveScreenTicketStore({ ttlMs: 1000, now: () => now });
  const scope = { binding: "office-session-a", profile: "greeming-seoyun", sessionId: "chat-1", pageId: "page-1" };
  const first = store.issue(scope);
  assert.equal(store.consume(first.token, "office-session-b"), null);
  assert.equal(store.consume(first.token, "office-session-a"), null, "wrong binding still burns the ticket");

  const replay = store.issue(scope);
  assert.equal(store.consume(replay.token, "office-session-a")?.pageId, "page-1");
  assert.equal(store.consume(replay.token, "office-session-a"), null);

  const expired = store.issue(scope);
  now = expired.expiresAt;
  assert.equal(store.consume(expired.token, "office-session-a"), null);

  now += 1;
  const revoked = store.issue(scope);
  store.revoke(scope.profile, scope.sessionId);
  assert.equal(store.consume(revoked.token, "office-session-a"), null);
});

test("Live Screen Origin and scope checks fail closed", () => {
  const canonical = new URL("https://office.example.com");
  assert.equal(liveScreenOriginMatches({ headers: { origin: canonical.origin, host: canonical.host } }, canonical), true);
  assert.equal(liveScreenOriginMatches({ headers: { origin: "https://evil.example", host: canonical.host } }, canonical), false);
  assert.equal(liveScreenOriginMatches({ headers: { host: canonical.host } }, canonical), false);
  assert.equal(liveScreenOriginMatches({ headers: { origin: "https://office.example.com.evil", host: canonical.host } }, canonical), false);
  assert.equal(liveScreenOriginMatches({ headers: { origin: "https://office.local", host: "office.local" } }), true);

  const allowedProfiles = new Set(["greeming-seoyun"]);
  assert.deepEqual(validateLiveScreenScope({
    profile: "greeming-seoyun", sessionId: "chat-1", targetId: "page.1", browserSessionId: "browser:1", allowedProfiles,
  }), { profile: "greeming-seoyun", sessionId: "chat-1", targetId: "page.1", browserSessionId: "browser:1" });
  assert.throws(() => validateLiveScreenScope({ profile: "default", sessionId: "chat-1", allowedProfiles }));
  assert.throws(() => validateLiveScreenScope({ profile: "greeming-seoyun", sessionId: "../chat", allowedProfiles }));
  assert.throws(() => validateLiveScreenScope({ profile: "greeming-seoyun", sessionId: "chat", browserSessionId: "x".repeat(257), allowedProfiles }));
});

test("Live Screen metadata removes credentials and sensitive query values", () => {
  const safe = sanitizeLiveViewUrl("https://user:pass@example.com/path?token=abc&view=ok&session_id=secret#fragment");
  assert.equal(safe, "https://example.com/path?token=%5Bredacted%5D&view=ok&session_id=%5Bredacted%5D");
});

test("CDP command policy allows only exact rendering and bounded input commands", () => {
  const unattached = { pageId: "page-1", sessionId: "", width: 800, height: 600 };
  assert.deepEqual(sanitizeCdpCommand({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } }, unattached), {
    id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true },
  });
  assert.equal(sanitizeCdpCommand({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-2", flatten: true } }, unattached), null);

  const attached = { ...unattached, sessionId: "cdp-session" };
  assert.equal(sanitizeCdpCommand({ id: 2, method: "Runtime.evaluate", params: { expression: "document.cookie" }, sessionId: "cdp-session" }, attached), null);
  assert.equal(sanitizeCdpCommand({ id: 3, method: "Network.enable", params: {}, sessionId: "cdp-session" }, attached), null);
  assert.equal(sanitizeCdpCommand({ id: 4, method: "Page.enable", params: {}, sessionId: "wrong" }, attached), null);
  assert.equal(sanitizeCdpCommand({ id: 5, method: "Input.insertText", params: { text: "x".repeat(4097) }, sessionId: "cdp-session" }, attached), null);
  assert.equal(sanitizeCdpCommand({ id: 6, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 801, y: 1 }, sessionId: "cdp-session" }, attached), null);
  assert.equal(sanitizeCdpCommand({ id: 7, method: "Emulation.setDeviceMetricsOverride", params: { width: 319, height: 600 }, sessionId: "cdp-session" }, attached), null);
  assert.equal(sanitizeCdpCommand({ id: 8, method: "Input.insertText", params: { text: "안녕" }, sessionId: "cdp-session" }, attached)?.params.text, "안녕");
  assert.deepEqual(sanitizeCdpCommand({
    id: 9,
    method: "Input.dispatchTouchEvent",
    params: { type: "touchStart", touchPoints: [{ x: 20, y: 30, id: 4, radiusX: 1, radiusY: 2, force: 0.5 }], modifiers: 0 },
    sessionId: "cdp-session",
  }, attached)?.params.touchPoints, [{ x: 20, y: 30, id: 4, radiusX: 1, radiusY: 2, force: 0.5 }]);
  assert.equal(sanitizeCdpCommand({
    id: 10, method: "Input.dispatchTouchEvent", params: { type: "touchMove", touchPoints: [{ x: 900, y: 1, id: 1 }] }, sessionId: "cdp-session",
  }, attached), null);
  assert.equal(sanitizeCdpCommand({
    id: 11, method: "Input.dispatchTouchEvent", params: { type: "touchCancel", touchPoints: [{ x: 1, y: 1, id: 1 }] }, sessionId: "cdp-session",
  }, attached), null);
  assert.deepEqual(sanitizeCdpCommand({
    id: 12, method: "Emulation.setDeviceMetricsOverride", params: { width: 800, height: 600, deviceScaleFactor: 2, mobile: true }, sessionId: "cdp-session",
  }, attached)?.params, { width: 800, height: 600, deviceScaleFactor: 2, mobile: true });
  assert.deepEqual(sanitizeCdpCommand({
    id: 13, method: "Page.startScreencast", params: { maxWidth: 800, maxHeight: 600, quality: 100 }, sessionId: "cdp-session",
  }, attached)?.params, { format: "jpeg", quality: 45, maxWidth: 720, maxHeight: 405, everyNthFrame: 1 });
  assert.deepEqual(sanitizeCdpCommand({
    id: 14, method: "Page.startScreencast", params: { maxWidth: 1600, maxHeight: 1080 }, sessionId: "cdp-session",
  }, attached)?.params, { format: "jpeg", quality: 45, maxWidth: 720, maxHeight: 405, everyNthFrame: 1 });
});
