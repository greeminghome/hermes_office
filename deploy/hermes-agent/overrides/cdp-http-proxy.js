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
const softTabLimit = Math.max(1, Number(process.env.CDP_PROXY_SOFT_TAB_LIMIT || 10));
const hardTabLimit = Math.max(softTabLimit, Number(process.env.CDP_PROXY_HARD_TAB_LIMIT || 16));
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
  const storedTabs = Array.isArray(value.tabs) ? value.tabs : [];
  const tabs = storedTabs
    .map((tab) => ({
      targetId: String(tab?.targetId || ""),
      slot: Math.max(1, Number(tab?.slot) || 0),
      createdAt: Number(tab?.createdAt) || Date.now(),
      lastUsedAt: Number(tab?.lastUsedAt) || Number(value.lastUsedAt) || Date.now(),
    }))
    .filter((tab) => tab.targetId && tab.slot);
  if (targetId && !tabs.some((tab) => tab.targetId === targetId)) {
    tabs.push({ targetId, slot: 1, createdAt: Number(value.createdAt) || Date.now(), lastUsedAt: Number(value.lastUsedAt) || Date.now() });
  }
  return {
    targetId,
    browserContextId,
    tabs,
    nextSlot: Math.max(Number(value.nextSlot) || 1, ...tabs.map((tab) => tab.slot + 1), 1),
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
    tabs: Array.isArray(record.tabs) ? record.tabs : (previous?.tabs || []),
    nextSlot: Math.max(Number(record.nextSlot) || Number(previous?.nextSlot) || 1, 1),
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
    const now = Date.now();
    const record = {
      targetId,
      browserContextId,
      tabs: [{ targetId, slot: 1, createdAt: now, lastUsedAt: now }],
      nextSlot: 2,
      createdAt: now,
      lastUsedAt: now,
      pageClosedAt: 0,
    };
    assignSessionTarget(sessionId, record);
    return record;
  } catch (error) {
    await browserCall("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    throw error;
  }
}

function assignStableTabs(record, targets) {
  const now = Date.now();
  const liveIds = new Set(targets.map((item) => String(item.targetId || "")).filter(Boolean));
  const existing = new Map((record.tabs || []).filter((tab) => liveIds.has(tab.targetId)).map((tab) => [tab.targetId, tab]));
  const usedSlots = new Set();
  for (const tab of [...existing.values()].sort((left, right) => Number(left.slot) - Number(right.slot))) {
    let slot = Math.max(1, Number(tab.slot) || 1);
    if (usedSlots.has(slot)) {
      slot = 1;
      while (usedSlots.has(slot)) slot += 1;
      tab.slot = slot;
    }
    usedSlots.add(slot);
  }
  for (const target of targets) {
    const targetId = String(target.targetId || "");
    if (!targetId || existing.has(targetId)) continue;
    let slot = 1;
    while (usedSlots.has(slot)) slot += 1;
    usedSlots.add(slot);
    existing.set(targetId, { targetId, slot, createdAt: now, lastUsedAt: now });
  }
  record.tabs = [...existing.values()].sort((left, right) => left.slot - right.slot);
  record.nextSlot = Math.max(1, ...record.tabs.map((tab) => Number(tab.slot) + 1));
  if (!record.targetId || !liveIds.has(record.targetId)) record.targetId = record.tabs[0]?.targetId || "";
  return record.tabs.map((tab) => ({
    ...targets.find((target) => target.targetId === tab.targetId),
    ...tab,
    active: tab.targetId === record.targetId,
  }));
}

async function sessionWorkspace(sessionId, { createIfMissing = false } = {}) {
  if (!validSessionId(sessionId)) throw new Error("invalid session identifier");
  let record = sessionTargets.get(sessionId);
  if (!record && createIfMissing) record = await createIsolatedSessionTarget(sessionId);
  if (!record) return null;
  const [targets, contexts] = await Promise.all([pageTargets(), browserContexts()]);
  if (!contexts.has(record.browserContextId)) {
    sessionTargets.delete(sessionId);
    persistSessionTargets();
    return createIfMissing ? sessionWorkspace(sessionId, { createIfMissing: true }) : null;
  }
  let ownedTargets = targets.filter((item) => item.browserContextId === record.browserContextId);
  if (!ownedTargets.length && createIfMissing) {
    const created = await browserCall("Target.createTarget", { url: "about:blank", browserContextId: record.browserContextId });
    const refreshed = await pageTargets();
    ownedTargets = refreshed.filter((item) => item.browserContextId === record.browserContextId);
    record.targetId = String(created.targetId || "");
  }
  const tabs = assignStableTabs(record, ownedTargets);
  assignSessionTarget(sessionId, record);
  return { record, tabs };
}

function workspacePayload(sessionId, workspace, host) {
  const { record, tabs } = workspace;
  return {
    sessionId,
    targetId: record.targetId,
    activeTargetId: record.targetId,
    browserContextId: record.browserContextId,
    isolation: "browser-context",
    tabs: tabs.map((tab) => ({
      targetId: tab.targetId,
      slot: tab.slot,
      active: tab.targetId === record.targetId,
      url: String(tab.url || ""),
      title: String(tab.title || ""),
      type: "page",
    })),
    policy: { softLimit: softTabLimit, hardLimit: hardTabLimit, overflow: tabs.length > softTabLimit },
    endpoint: `http://${host || `${listenHost}:${listenPort}`}`,
  };
}

async function ensureSessionTarget(sessionId) {
  const workspace = await sessionWorkspace(sessionId, { createIfMissing: true });
  const target = workspace.tabs.find((item) => item.targetId === workspace.record.targetId) || workspace.tabs[0];
  return { ...(target || { type: "page", url: "about:blank", title: "" }), ...workspace.record };
}

async function existingSessionTarget(sessionId) {
  const workspace = await sessionWorkspace(sessionId, { createIfMissing: false });
  if (!workspace?.record?.targetId) return null;
  const target = workspace.tabs.find((item) => item.targetId === workspace.record.targetId) || null;
  return target ? { ...target, ...workspace.record } : null;
}

async function closeSessionPage(sessionId, expectedLastUsedAt = null) {
  const record = sessionTargets.get(sessionId);
  if (!record?.targetId) return false;
  if (expectedLastUsedAt != null && Number(record.lastUsedAt) !== Number(expectedLastUsedAt)) return false;
  const targetId = record.targetId;
  const targetIds = (record.tabs || []).map((tab) => tab.targetId).filter(Boolean);
  await Promise.all(targetIds.map((ownedTargetId) => browserCall("Target.closeTarget", { targetId: ownedTargetId }).catch(() => {})));
  if (sessionTargets.get(sessionId) !== record || record.targetId !== targetId) return false;
  record.targetId = "";
  record.tabs = [];
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
  if (url.pathname === "/__session_tabs") {
    const sessionId = url.searchParams.get("session") || "";
    if (!validSessionId(sessionId)) return sendJson(response, 400, { error: "valid session is required" });
    try {
      const passive = url.searchParams.get("claim") === "0";
      const workspace = await sessionWorkspace(sessionId, { createIfMissing: !passive });
      if (!workspace) return sendJson(response, 404, { error: "session workspace is not active", reason: "workspace-inactive" });
      return sendJson(response, 200, workspacePayload(sessionId, workspace, request.headers.host));
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
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
  const attachedTargets = new Map();
  const refreshOwnedTargets = async () => {
    const workspace = await sessionWorkspace(sessionId, { createIfMissing: true });
    return {
      workspace,
      ids: new Set(workspace.tabs.map((tab) => tab.targetId)),
    };
  };
  const activateTarget = async (targetId) => {
    const { workspace, ids } = await refreshOwnedTargets();
    if (!ids.has(targetId)) return false;
    workspace.record.targetId = targetId;
    const tab = workspace.record.tabs.find((item) => item.targetId === targetId);
    if (tab) tab.lastUsedAt = Date.now();
    assignSessionTarget(sessionId, workspace.record);
    return true;
  };
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
      refreshOwnedTargets().then(({ workspace }) => {
        const requestedUrl = String(message.params?.url || "about:blank");
        const active = workspace.tabs.find((tab) => tab.targetId === workspace.record.targetId);
        if (requestedUrl === "about:blank" && workspace.tabs.length === 1 && String(active?.url || "") === "about:blank") {
          client.send(JSON.stringify({ id: message.id, result: { targetId: active.targetId } }));
          return;
        }
        if (workspace.tabs.length >= hardTabLimit) {
          client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: `Hermes session tab limit (${hardTabLimit}) reached` } }));
          return;
        }
        const routed = { ...message, params: { ...(message.params || {}), browserContextId: workspace.record.browserContextId } };
        pendingMethods.set(message.id, { method: message.method, requestedUrl });
        upstream.send(JSON.stringify(routed));
      }).catch((error) => client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } })));
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
    if (message.method === "Target.attachToTarget") {
      refreshOwnedTargets().then(({ ids }) => {
        if (!ids.has(message.params?.targetId)) {
          client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target belongs to another Hermes session" } }));
          return;
        }
        pendingMethods.set(message.id, { method: message.method, targetId: message.params.targetId });
        upstream.send(JSON.stringify(message));
      }).catch(() => client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target ownership could not be verified" } })));
      return;
    }
    if (message.method === "Target.activateTarget" && message.params?.targetId) {
      activateTarget(message.params.targetId).then((allowed) => {
        if (!allowed) {
          client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target belongs to another Hermes session" } }));
          return;
        }
        pendingMethods.set(message.id, { method: message.method, targetId: message.params.targetId });
        upstream.send(JSON.stringify(message));
      }).catch(() => client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target ownership could not be verified" } })));
      return;
    }
    if (message.params?.targetId) {
      refreshOwnedTargets().then(({ ids }) => {
        if (!ids.has(message.params.targetId)) {
          client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target belongs to another Hermes session" } }));
          return;
        }
        pendingMethods.set(message.id, { method: message.method || "", targetId: message.params.targetId });
        upstream.send(JSON.stringify(message));
      }).catch(() => client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Target ownership could not be verified" } })));
      return;
    }
    const attachedTargetId = message.sessionId ? attachedTargets.get(message.sessionId) : "";
    if (attachedTargetId && !["Target.getTargets", "Target.getBrowserContexts"].includes(message.method)) void activateTarget(attachedTargetId);
    if (message.id != null) pendingMethods.set(message.id, { method: message.method || "", targetId: attachedTargetId || "" });
    upstream.send(JSON.stringify(message));
  };
  client.off("message", queueMessage);
  client.on("message", forwardClientMessage);
  upstream.on("open", () => queuedMessages.splice(0).forEach(forwardClientMessage));
  upstream.on("message", (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const pending = message.id != null ? pendingMethods.get(message.id) : null;
    const method = pending?.method || "";
    if (method === "Target.getTargets" && message.result?.targetInfos) {
      message.result.targetInfos = message.result.targetInfos.filter((item) => item.browserContextId === target.browserContextId);
    }
    if (method === "Target.getBrowserContexts" && message.result?.browserContextIds) {
      message.result.browserContextIds = message.result.browserContextIds.filter((item) => item === target.browserContextId);
    }
    if (method === "Target.createTarget" && message.result?.targetId) void activateTarget(message.result.targetId);
    if (method === "Target.attachToTarget" && message.result?.sessionId && pending?.targetId) {
      attachedTargets.set(message.result.sessionId, pending.targetId);
      void activateTarget(pending.targetId);
    }
    if (message.method === "Target.attachedToTarget" && message.params?.sessionId && message.params?.targetInfo?.browserContextId === target.browserContextId) {
      attachedTargets.set(message.params.sessionId, message.params.targetInfo.targetId);
      void activateTarget(message.params.targetInfo.targetId);
    }
    if (message.method === "Target.detachedFromTarget" && message.params?.sessionId) attachedTargets.delete(message.params.sessionId);
    if (message.id != null) pendingMethods.delete(message.id);
    if (message.method?.startsWith("Target.") && message.params?.targetInfo?.browserContextId && message.params.targetInfo.browserContextId !== target.browserContextId) return;
    if (message.method === "Target.targetDestroyed" && message.params?.targetId) {
      const owned = (sessionTargets.get(sessionId)?.tabs || []).some((tab) => tab.targetId === message.params.targetId);
      if (!owned) return;
      void refreshOwnedTargets();
    }
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
