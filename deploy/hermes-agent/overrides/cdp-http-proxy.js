#!/usr/bin/env node
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const { URL } = require("node:url");
let WsPackage;
try { WsPackage = require("ws"); } catch { WsPackage = require("/opt/hermes/node_modules/ws"); }
const { WebSocket, WebSocketServer } = WsPackage;

const listenHost = process.env.CDP_PROXY_HOST || "0.0.0.0";
const listenPort = Number(process.env.CDP_PROXY_PORT || process.env.HERMES_BROWSER_CDP_PROXY_PORT || 9223);
const targetHost = process.env.CDP_PROXY_TARGET_HOST || "127.0.0.1";
const targetPort = Number(process.env.CDP_PROXY_TARGET_PORT || process.env.HERMES_BROWSER_CDP_PORT || 9222);
const sessionStateFile = process.env.CDP_PROXY_SESSION_STATE_FILE || `/opt/data/browser-session-targets-${targetPort}.json`;
const sessionTtlMs = Number(process.env.CDP_PROXY_SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const sessionContextTtlMs = Number(process.env.CDP_PROXY_SESSION_CONTEXT_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const cleanupIntervalMs = Number(process.env.CDP_PROXY_CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
const sessionTargets = new Map();
const webSocketServer = new WebSocketServer({ noServer: true });

function validSessionId(value) {
  return /^[a-zA-Z0-9._:-]{1,256}$/.test(String(value || ""));
}

function normalizeSessionRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const targetId = String(value.targetId || "");
  const browserContextId = String(value.browserContextId || "");
  if (!browserContextId) return null;
  return {
    targetId,
    browserContextId,
    lastUsedAt: Number(value.lastUsedAt) || Date.now(),
    createdAt: Number(value.createdAt) || Number(value.lastUsedAt) || Date.now(),
    pageClosedAt: Number(value.pageClosedAt) || 0,
  };
}

try {
  const stored = JSON.parse(fs.readFileSync(sessionStateFile, "utf8"));
  Object.entries(stored || {}).forEach(([sessionId, value]) => {
    const record = normalizeSessionRecord(value);
    if (validSessionId(sessionId) && record) sessionTargets.set(sessionId, record);
  });
} catch { /* first run or invalid state */ }

function persistSessionTargets() {
  try {
    const temporary = `${sessionStateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(sessionTargets)), { mode: 0o600 });
    fs.renameSync(temporary, sessionStateFile);
  } catch (error) {
    console.error(`Could not persist session targets: ${error.message}`);
  }
}

function assignSessionTarget(sessionId, record) {
  const previous = sessionTargets.get(sessionId);
  sessionTargets.set(sessionId, {
    ...record,
    createdAt: Number(record.createdAt) || Number(previous?.createdAt) || Date.now(),
    lastUsedAt: Date.now(),
    pageClosedAt: 0,
  });
  persistSessionTargets();
}

function touchSessionTarget(sessionId, record) {
  const now = Date.now();
  const shouldPersist = now - Number(record.lastUsedAt || 0) > 60_000;
  record.lastUsedAt = now;
  sessionTargets.set(sessionId, record);
  if (shouldPersist) persistSessionTargets();
}

async function browserWebSocketUrl() {
  const payload = await fetch(`http://${targetHost}:${targetPort}/json/version`).then((response) => response.json());
  return String(payload.webSocketDebuggerUrl || "").replace("ws://127.0.0.1:", `ws://${targetHost}:`);
}

async function browserCall(method, params = {}) {
  const url = await browserWebSocketUrl();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: `http://${targetHost}:${targetPort}` });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`${method} timed out`)); }, 5000);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message || `${method} failed`));
      else resolve(message.result || {});
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function pageTargets() {
  const result = await browserCall("Target.getTargets");
  return (result.targetInfos || []).filter((item) => item.type === "page");
}

async function browserContexts() {
  const result = await browserCall("Target.getBrowserContexts");
  return new Set(result.browserContextIds || []);
}

async function createIsolatedSessionTarget(sessionId) {
  const context = await browserCall("Target.createBrowserContext", { disposeOnDetach: false });
  const browserContextId = String(context.browserContextId || "");
  if (!browserContextId) throw new Error("Chrome did not create an isolated browser context");
  try {
    const created = await browserCall("Target.createTarget", { url: "about:blank", browserContextId });
    const targetId = String(created.targetId || "");
    if (!targetId) throw new Error("Chrome did not create an isolated page target");
    const record = { targetId, browserContextId, createdAt: Date.now(), lastUsedAt: Date.now(), pageClosedAt: 0 };
    assignSessionTarget(sessionId, record);
    return record;
  } catch (error) {
    await browserCall("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    throw error;
  }
}

async function ensureSessionTarget(sessionId) {
  if (!validSessionId(sessionId)) throw new Error("invalid session identifier");
  const record = sessionTargets.get(sessionId);
  if (!record) return createIsolatedSessionTarget(sessionId);
  const [targets, contexts] = await Promise.all([pageTargets(), browserContexts()]);
  if (!contexts.has(record.browserContextId)) {
    sessionTargets.delete(sessionId);
    persistSessionTargets();
    return createIsolatedSessionTarget(sessionId);
  }
  let target = record.targetId
    ? targets.find((item) => item.targetId === record.targetId && item.browserContextId === record.browserContextId)
    : null;
  if (!target) {
    const created = await browserCall("Target.createTarget", { url: "about:blank", browserContextId: record.browserContextId });
    record.targetId = String(created.targetId || "");
    if (!record.targetId) throw new Error("Chrome did not recreate the isolated page target");
    assignSessionTarget(sessionId, record);
    const refreshed = await pageTargets();
    target = refreshed.find((item) => item.targetId === record.targetId && item.browserContextId === record.browserContextId);
  } else {
    touchSessionTarget(sessionId, record);
  }
  return { ...(target || { type: "page", url: "about:blank", title: "" }), ...record };
}

async function existingSessionTarget(sessionId) {
  if (!validSessionId(sessionId)) return null;
  const record = sessionTargets.get(sessionId);
  if (!record) return null;
  const [targets, contexts] = await Promise.all([pageTargets(), browserContexts()]);
  if (!contexts.has(record.browserContextId)) {
    sessionTargets.delete(sessionId);
    persistSessionTargets();
    return null;
  }
  if (!record.targetId) return null;
  const target = targets.find((item) => item.targetId === record.targetId && item.browserContextId === record.browserContextId) || null;
  return target ? { ...target, ...record } : null;
}

async function closeSessionPage(sessionId, expectedLastUsedAt = null) {
  const record = sessionTargets.get(sessionId);
  if (!record?.targetId) return false;
  if (expectedLastUsedAt != null && Number(record.lastUsedAt) !== Number(expectedLastUsedAt)) return false;
  const targetId = record.targetId;
  await browserCall("Target.closeTarget", { targetId }).catch(() => {});
  if (sessionTargets.get(sessionId) !== record || record.targetId !== targetId) return false;
  record.targetId = "";
  record.pageClosedAt = Date.now();
  sessionTargets.set(sessionId, record);
  persistSessionTargets();
  return true;
}

async function disposeSessionTarget(sessionId, expectedLastUsedAt = null) {
  const record = sessionTargets.get(sessionId);
  if (expectedLastUsedAt != null && Number(record?.lastUsedAt) !== Number(expectedLastUsedAt)) return false;
  sessionTargets.delete(sessionId);
  persistSessionTargets();
  if (record?.browserContextId) {
    await browserCall("Target.disposeBrowserContext", { browserContextId: record.browserContextId }).catch(() => {});
  }
  return Boolean(record);
}

async function cleanupExpiredSessionTargets() {
  const now = Date.now();
  const pageCutoff = now - Math.max(60_000, sessionTtlMs);
  const contextCutoff = now - Math.max(sessionTtlMs, sessionContextTtlMs);
  const stalePages = [...sessionTargets.entries()].filter(([, record]) => (
    record.targetId && Number(record.lastUsedAt || 0) < pageCutoff
  ));
  for (const [sessionId, record] of stalePages) {
    await closeSessionPage(sessionId, record.lastUsedAt);
  }
  const staleContexts = [...sessionTargets.entries()].filter(([, record]) => (
    !record.targetId && Number(record.lastUsedAt || 0) < contextCutoff
  ));
  for (const [sessionId, record] of staleContexts) {
    await disposeSessionTarget(sessionId, record.lastUsedAt);
  }
}

const cleanupTimer = setInterval(
  () => cleanupExpiredSessionTargets().catch((error) => console.error(`Session cleanup failed: ${error.message}`)),
  Math.max(30_000, cleanupIntervalMs),
);
cleanupTimer.unref();

function sessionIdFromPath(pathname) {
  const prefix = "/session/";
  if (!pathname.startsWith(prefix)) return "";
  try { return decodeURIComponent(pathname.slice(prefix.length)); } catch { return ""; }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/__session_target") {
    const sessionId = url.searchParams.get("session") || "";
    if (!validSessionId(sessionId)) return sendJson(response, 400, { error: "valid session is required" });
    try {
      if (request.method === "DELETE") {
        const disposed = await disposeSessionTarget(sessionId);
        return sendJson(response, 200, { disposed, sessionId });
      }
      if (request.method === "POST") {
        const record = sessionTargets.get(sessionId);
        if (!record?.targetId) return sendJson(response, 404, { error: "session target is not active" });
        touchSessionTarget(sessionId, record);
        return sendJson(response, 200, { touched: true, sessionId, lastUsedAt: record.lastUsedAt });
      }
      const passive = url.searchParams.get("claim") === "0";
      const target = passive ? await existingSessionTarget(sessionId) : await ensureSessionTarget(sessionId);
      if (!target) return sendJson(response, 404, { error: "session target is not active" });
      return sendJson(response, 200, {
        sessionId,
        targetId: target.targetId,
        browserContextId: target.browserContextId,
        isolation: "browser-context",
        url: target.url || "",
        title: target.title || "",
        endpoint: `http://${request.headers.host || `${listenHost}:${listenPort}`}`,
      });
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }

  const upstream = http.request({
    hostname: targetHost,
    port: targetPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `${targetHost}:${targetPort}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => sendJson(response, 502, { error: error.message }));
  request.pipe(upstream);
});

async function handleSessionSocket(client, sessionId) {
  if (!validSessionId(sessionId)) return client.close(1008, "Invalid session identifier");
  const queuedMessages = [];
  const queueMessage = (raw) => queuedMessages.push(raw);
  client.on("message", queueMessage);
  const target = await ensureSessionTarget(sessionId);
  const upstream = new WebSocket(await browserWebSocketUrl(), { origin: `http://${targetHost}:${targetPort}` });
  const pendingMethods = new Map();
  const forwardClientMessage = (raw) => {
    if (upstream.readyState !== WebSocket.OPEN) {
      queuedMessages.push(raw);
      return;
    }
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const activityRecord = sessionTargets.get(sessionId);
    if (activityRecord) touchSessionTarget(sessionId, activityRecord);
    if (message.method === "Target.createTarget") {
      client.send(JSON.stringify({ id: message.id, result: { targetId: target.targetId } }));
      return;
    }
    if (message.method === "Target.createBrowserContext") {
      client.send(JSON.stringify({ id: message.id, result: { browserContextId: target.browserContextId } }));
      return;
    }
    if (message.method === "Target.disposeBrowserContext") {
      client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Hermes session context lifecycle is managed by the router" } }));
      return;
    }
    if (message.params?.browserContextId && message.params.browserContextId !== target.browserContextId) {
      client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Browser context belongs to another Hermes session" } }));
      return;
    }
    if (message.method === "Target.attachToTarget" && message.params?.targetId !== target.targetId) {
      client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target belongs to another Hermes session" } }));
      return;
    }
    if (message.id != null) pendingMethods.set(message.id, message.method || "");
    upstream.send(JSON.stringify(message));
  };
  client.off("message", queueMessage);
  client.on("message", forwardClientMessage);
  upstream.on("open", () => queuedMessages.splice(0).forEach(forwardClientMessage));
  upstream.on("message", (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const method = message.id != null ? pendingMethods.get(message.id) : "";
    if (method === "Target.getTargets" && message.result?.targetInfos) {
      message.result.targetInfos = message.result.targetInfos.filter((item) => item.targetId === target.targetId);
    }
    if (method === "Target.getBrowserContexts" && message.result?.browserContextIds) {
      message.result.browserContextIds = message.result.browserContextIds.filter((item) => item === target.browserContextId);
    }
    if (message.id != null) pendingMethods.delete(message.id);
    if (message.method?.startsWith("Target.") && message.params?.targetInfo?.targetId && message.params.targetInfo.targetId !== target.targetId) return;
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  });
  upstream.on("close", () => client.close());
  upstream.on("error", () => client.close(1011, "Chrome connection failed"));
  client.on("close", () => upstream.close());
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const sessionId = sessionIdFromPath(url.pathname);
  if (sessionId) {
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      handleSessionSocket(client, sessionId).catch(() => client.close(1011, "Session target failed"));
    });
    return;
  }

  const upstream = net.connect(targetPort, targetHost, () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = String(name).toLowerCase() === "host" ? `${targetHost}:${targetPort}` : request.rawHeaders[index + 1];
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.log(`Session-aware CDP proxy listening on ${listenHost}:${listenPort}, target ${targetHost}:${targetPort}`);
  cleanupExpiredSessionTargets().catch((error) => console.error(`Initial session cleanup failed: ${error.message}`));
});
