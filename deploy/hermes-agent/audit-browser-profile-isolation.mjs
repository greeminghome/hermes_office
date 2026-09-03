#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let WsPackage;
try {
  WsPackage = require("ws");
} catch {
  WsPackage = require("/opt/hermes/node_modules/ws");
}
const { WebSocket } = WsPackage;

const configuredProfiles = String(process.env.HERMES_GATEWAY_PROFILES || "")
  .split(",")
  .map((profile) => profile.trim())
  .filter(Boolean);

assert.ok(configuredProfiles.length > 0, "HERMES_GATEWAY_PROFILES must list the deployed profiles");
assert.equal(new Set(configuredProfiles).size, configuredProfiles.length, "profile names must be unique");

const cdpBasePort = Number(process.env.HERMES_PROFILE_CDP_BASE_PORT || 9300);
const routerBasePort = Number(process.env.HERMES_PROFILE_CDP_PROXY_BASE_PORT || 9400);
const includeDefault = process.env.AUDIT_INCLUDE_DEFAULT_PROFILE !== "0";
const profiles = [
  ...(includeDefault ? [{ profile: "default", cdpPort: 9222, routerPort: 9223 }] : []),
  ...configuredProfiles.map((profile, index) => ({
    profile,
    cdpPort: cdpBasePort + index,
    routerPort: routerBasePort + index,
  })),
];
const runId = `${Date.now()}-${process.pid}`;
const created = [];

async function requestJson(base, pathname, { expected = 200, method = "GET" } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, signal: AbortSignal.timeout(8000) });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  assert.equal(response.status, expected, `${method} ${base}${pathname}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function sessionCall(base, sessionId, method, params = {}) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${method} timed out for ${sessionId}`));
    }, 8000);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function createAuditPair(config, index) {
  const base = `http://127.0.0.1:${config.routerPort}`;
  const firstId = `profile-isolation-audit-${runId}-${index}-a`;
  const secondId = `profile-isolation-audit-${runId}-${index}-b`;
  const first = await requestJson(base, `/__session_target?session=${encodeURIComponent(firstId)}`);
  created.push({ base, sessionId: firstId });
  const second = await requestJson(base, `/__session_target?session=${encodeURIComponent(secondId)}`);
  created.push({ base, sessionId: secondId });

  assert.equal(first.isolation, "browser-context");
  assert.equal(second.isolation, "browser-context");
  assert.ok(first.browserContextId && second.browserContextId, `${config.profile}: missing BrowserContext`);
  assert.notEqual(first.browserContextId, second.browserContextId, `${config.profile}: sessions share a BrowserContext`);
  assert.notEqual(first.targetId, second.targetId, `${config.profile}: sessions share a page target`);

  const firstWorkspace = await requestJson(base, `/__session_tabs?session=${encodeURIComponent(firstId)}&claim=0`);
  assert.equal(firstWorkspace.sessionId, firstId);
  assert.equal(firstWorkspace.browserContextId, first.browserContextId);
  assert.ok(firstWorkspace.tabs.length >= 1, `${config.profile}: audit workspace has no tabs`);
  assert.ok(firstWorkspace.tabs.every((tab) => tab.targetId !== second.targetId), `${config.profile}: foreign target leaked into tab list`);

  const visible = await sessionCall(base, firstId, "Target.getTargets");
  assert.equal(Boolean(visible.error), false, `${config.profile}: Target.getTargets failed`);
  assert.ok(
    (visible.result?.targetInfos || []).every((target) => target.browserContextId === first.browserContextId),
    `${config.profile}: Target.getTargets exposed another session`,
  );

  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget"]) {
    const params = method === "Target.attachToTarget"
      ? { targetId: second.targetId, flatten: true }
      : { targetId: second.targetId };
    const response = await sessionCall(base, firstId, method, params);
    assert.match(String(response.error?.message || ""), /another Hermes session/, `${config.profile}: ${method} did not reject a foreign target`);
  }

  return { config, firstId, secondId, first, second };
}

async function cleanup() {
  const failures = [];
  for (const item of created.reverse()) {
    try {
      await requestJson(item.base, `/__session_target?session=${encodeURIComponent(item.sessionId)}`, { method: "DELETE" });
      await requestJson(item.base, `/__session_tabs?session=${encodeURIComponent(item.sessionId)}&claim=0`, { expected: 404 });
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length) throw new Error(`audit cleanup failed: ${failures.join("; ")}`);
}

let results = [];
let failure = null;
try {
  for (const config of profiles) {
    const cdp = `http://127.0.0.1:${config.cdpPort}`;
    const router = `http://127.0.0.1:${config.routerPort}`;
    await requestJson(cdp, "/json/version");
    await requestJson(router, "/json/version");
  }

  results = await Promise.all(profiles.map(createAuditPair));

  for (const owner of results) {
    for (const other of results) {
      if (owner.config.profile === other.config.profile) continue;
      const otherBase = `http://127.0.0.1:${other.config.routerPort}`;
      await requestJson(
        otherBase,
        `/__session_tabs?session=${encodeURIComponent(owner.firstId)}&claim=0`,
        { expected: 404 },
      );
    }
  }
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], "profile isolation audit and cleanup failed")
      : cleanupError;
  }
}

if (failure) throw failure;

console.log(JSON.stringify({
  ok: true,
  profiles: results.map(({ config }) => ({
    profile: config.profile,
    cdpPort: config.cdpPort,
    routerPort: config.routerPort,
    sessionIsolation: true,
    crossProfileVisibility: false,
    cleanup: true,
  })),
  checks: {
    profileCount: results.length,
    browserContextsCreated: results.length * 2,
    crossProfilePassiveProbes: results.length * (results.length - 1),
    foreignTargetOperationsRejected: results.length * 3,
  },
}));
