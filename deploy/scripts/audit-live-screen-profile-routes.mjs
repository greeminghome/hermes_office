#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
let WsPackage;
try { WsPackage = require("ws"); } catch { WsPackage = require("/app/node_modules/ws"); }
const { WebSocket } = WsPackage;

const mappings = String(process.env.LIVE_SCREEN_PROFILE_CDP_URLS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const separator = item.indexOf("=");
    assert.ok(separator > 0, `invalid LIVE_SCREEN_PROFILE_CDP_URLS entry: ${item}`);
    return { profile: item.slice(0, separator).trim(), endpoint: item.slice(separator + 1).trim().replace(/\/$/, "") };
  });

assert.ok(mappings.length > 0, "LIVE_SCREEN_PROFILE_CDP_URLS must not be empty");
assert.equal(new Set(mappings.map((item) => item.profile)).size, mappings.length, "profile mappings must be unique");
assert.equal(new Set(mappings.map((item) => item.endpoint)).size, mappings.length, "router endpoints must be unique");

const officePort = Number(process.env.PORT || 4173);
const publicHost = new URL(process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${officePort}`).host;
const authUser = process.env.HERMES_OFFICE_USER || "admin";
const secret = String(process.env.HERMES_OFFICE_SESSION_SECRET || "");
assert.ok(Buffer.byteLength(secret, "utf8") >= 32, "HERMES_OFFICE_SESSION_SECRET is unavailable");

const cookiePayload = Buffer.from(JSON.stringify({
  user: authUser,
  exp: Date.now() + 10 * 60 * 1000,
  nonce: crypto.randomUUID(),
})).toString("base64url");
const cookieSignature = crypto.createHmac("sha256", secret).update(cookiePayload).digest("base64url");
const cookie = `hermes_office_sid=${cookiePayload}.${cookieSignature}`;
const runId = `${Date.now()}-${process.pid}`;
const created = [];

async function routerJson(mapping, pathname, { method = "GET", expected = 200 } = {}) {
  const response = await fetch(`${mapping.endpoint}${pathname}`, { method, signal: AbortSignal.timeout(8000) });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, expected, `${method} ${mapping.profile}${pathname}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function officeBridge(profile, sessionId, browserSessionId = sessionId) {
  const query = new URLSearchParams({ profile, sessionId, browserSessionId, passive: "1" });
  return await new Promise((resolve, reject) => {
    const request = http.get({
      host: "127.0.0.1",
      port: officePort,
      path: `/bridge/live-screens?${query}`,
      headers: { Accept: "application/json", Cookie: cookie, Host: publicHost },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : {} }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error("Office bridge timed out")));
    request.once("error", reject);
  });
}

async function sessionCall(mapping, sessionId, method, params = {}) {
  const url = new URL(mapping.endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${mapping.profile}: ${method} timed out`));
    }, 8000);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message || `${method} failed`));
      else resolve(message.result || {});
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForOwnBridge(profile, sessionId) {
  let latest = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await officeBridge(profile, sessionId);
    if (latest.status === 200 && latest.body?.workspace?.id === sessionId && latest.body?.activity?.view?.viewerSocketUrl) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latest;
}

let failure = null;
let crossProfileProbes = 0;
try {
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    const sessionId = `office-route-audit-${runId}-${index}`;
    const workspace = await routerJson(mapping, `/__session_target?session=${encodeURIComponent(sessionId)}`);
    created.push({ mapping, sessionId });
    assert.equal(workspace.isolation, "browser-context");
    const page = await sessionCall(mapping, sessionId, "Target.createTarget", {
      url: `https://example.com/?hermes_profile_audit=${encodeURIComponent(mapping.profile)}`,
    });
    assert.ok(page.targetId, `${mapping.profile}: visible audit target was not created`);

    const own = await waitForOwnBridge(mapping.profile, sessionId);
    assert.equal(own.status, 200, `${mapping.profile}: Office bridge returned ${own.status}`);
    assert.equal(own.body?.workspace?.id, sessionId, `${mapping.profile}: Office returned the wrong workspace`);
    assert.ok(own.body?.activity?.view?.viewerSocketUrl, `${mapping.profile}: viewer ticket was not issued`);
  }

  for (const owner of created) {
    for (const other of mappings) {
      if (owner.mapping.profile === other.profile) continue;
      const foreign = await officeBridge(other.profile, owner.sessionId);
      assert.equal(foreign.status, 200, `${other.profile}: foreign probe returned ${foreign.status}`);
      assert.equal(foreign.body?.activity || null, null, `${other.profile}: foreign workspace leaked through Office`);
      crossProfileProbes += 1;
    }
  }

  if (created.length >= 2) {
    const mismatch = await officeBridge(created[0].mapping.profile, created[0].sessionId, created[1].sessionId);
    assert.equal(mismatch.status, 400, "Office accepted a mismatched durable/browser session pair");
  }
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const item of created.reverse()) {
    try {
      await routerJson(item.mapping, `/__session_target?session=${encodeURIComponent(item.sessionId)}`, { method: "DELETE" });
      await routerJson(item.mapping, `/__session_tabs?session=${encodeURIComponent(item.sessionId)}&claim=0`, { expected: 404 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    const cleanupFailure = new AggregateError(cleanupErrors, "Office route audit cleanup failed");
    failure = failure ? new AggregateError([failure, cleanupFailure]) : cleanupFailure;
  }
}

if (failure) throw failure;

console.log(JSON.stringify({
  ok: true,
  profiles: mappings.map((item) => item.profile),
  ownRoutesVerified: mappings.length,
  crossProfileProbes,
  sessionBindingMismatchRejected: true,
  cleanup: true,
}));
