import { WebSocket } from "ws";
import {
  LIVE_SCREEN_MAX_BUFFERED_BYTES,
  LIVE_SCREEN_MAX_CLIENT_MESSAGE_BYTES,
  LIVE_SCREEN_MAX_FPS,
  LIVE_SCREEN_MAX_FRAME_BUFFERED_BYTES,
  LIVE_SCREEN_MAX_FRAME_BYTES,
  LIVE_SCREEN_IDLE_FPS,
  LIVE_SCREEN_INTERACTION_WINDOW_MS,
  LIVE_SCREEN_MAX_INPUTS_PER_SECOND,
  sanitizeCdpCommand,
} from "./liveScreenSecurity.js";

const MAX_PENDING_COMMANDS = 128;
const liveInteractionUntil = new Map();
const liveInteractionSubscribers = new Map();

function interactionKey(grant) {
  return `${grant.profile || "default"}:${grant.sessionId || "session"}:${grant.pageId}`;
}

function markLiveInteraction(key, current) {
  liveInteractionUntil.set(key, current + LIVE_SCREEN_INTERACTION_WINDOW_MS);
  for (const subscriber of liveInteractionSubscribers.get(key) || []) subscriber();
}

function subscribeLiveInteraction(key, subscriber) {
  const subscribers = liveInteractionSubscribers.get(key) || new Set();
  subscribers.add(subscriber);
  liveInteractionSubscribers.set(key, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) liveInteractionSubscribers.delete(key);
  };
}

export function liveScreenCdpSocketUrl(endpoint, pageId) {
  const url = new URL(endpoint);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error("unsupported live screen endpoint");
  url.pathname = `/devtools/page/${encodeURIComponent(pageId)}`;
  url.search = "";
  url.hash = "";
  return url;
}

function closeSocket(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try { socket.close(code, reason); } catch { socket.terminate(); }
  }
}

export function relayLiveScreenConnection(client, upstream, grant, options = {}) {
  const maxConnectionMs = options.maxConnectionMs || 15 * 60 * 1000;
  const now = options.now || (() => Date.now());
  const pending = new Map();
  let attachedSessionId = "";
  let width = 1600;
  let height = 900;
  let inputWindowStartedAt = now();
  let inputCount = 0;
  let lastFrameAt = 0;
  let internalId = 0x70000000;
  let finished = false;
  let binaryFrames = false;
  let pendingInputResponses = 0;
  let delayedAckTimer = null;
  let delayedFrameId = null;
  let lastActivityReportedAt = 0;
  const scopeKey = interactionKey(grant);

  const acknowledgeDroppedInput = (command) => {
    const coalescible = command.method === "Input.dispatchMouseEvent"
      ? ["mouseMoved", "mouseWheel"].includes(command.params.type)
      : command.method === "Input.dispatchTouchEvent" && command.params.type === "touchMove";
    if (!coalescible) return false;
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: command.id, result: {} }));
    return true;
  };

  const sendUpstream = (payload) => {
    if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > LIVE_SCREEN_MAX_BUFFERED_BYTES) return false;
    upstream.send(JSON.stringify(payload));
    return true;
  };
  const ackFrame = (frameId) => {
    if (!attachedSessionId || !Number.isInteger(frameId)) return;
    if (delayedFrameId === frameId) delayedFrameId = null;
    internalId = internalId >= 0x7ffffffe ? 0x70000000 : internalId + 1;
    sendUpstream({
      id: internalId,
      method: "Page.screencastFrameAck",
      params: { sessionId: frameId },
      sessionId: attachedSessionId,
    });
  };
  const finish = (code = 1000, reason = "closed") => {
    if (finished) return;
    finished = true;
    clearTimeout(lifetimeTimer);
    clearTimeout(delayedAckTimer);
    unsubscribeInteraction();
    if (attachedSessionId && upstream.readyState === WebSocket.OPEN) {
      internalId = internalId >= 0x7ffffffe ? 0x70000000 : internalId + 1;
      sendUpstream({ id: internalId, method: "Page.stopScreencast", params: {}, sessionId: attachedSessionId });
    }
    closeSocket(client, code, reason);
    closeSocket(upstream, code, reason);
  };
  const expediteDelayedFrame = () => {
    if (!Number.isInteger(delayedFrameId)) return;
    const frameId = delayedFrameId;
    delayedFrameId = null;
    clearTimeout(delayedAckTimer);
    ackFrame(frameId);
  };
  const unsubscribeInteraction = subscribeLiveInteraction(scopeKey, expediteDelayedFrame);
  const lifetimeTimer = setTimeout(() => finish(1000, "viewer expired"), maxConnectionMs);

  client.on("message", (data, isBinary) => {
    if (isBinary || data.length > LIVE_SCREEN_MAX_CLIENT_MESSAGE_BYTES) return finish(1008, "invalid command");
    let raw;
    try { raw = JSON.parse(data.toString("utf8")); } catch { return finish(1008, "invalid command"); }
    const command = sanitizeCdpCommand(raw, { pageId: grant.pageId, sessionId: attachedSessionId, width, height });
    if (!command || pending.size >= MAX_PENDING_COMMANDS) return finish(1008, "command denied");
    if (command.method === "Page.startScreencast" && raw.params?.transport === "binary") binaryFrames = true;
    if (command.method.startsWith("Input.")) {
      const current = now();
      markLiveInteraction(scopeKey, current);
      if (!lastActivityReportedAt || current - lastActivityReportedAt >= 60_000) {
        lastActivityReportedAt = current;
        Promise.resolve(options.onActivity?.()).catch(() => {});
      }
      if (current - inputWindowStartedAt >= 1000) {
        inputWindowStartedAt = current;
        inputCount = 0;
      }
      inputCount += 1;
      if (inputCount > LIVE_SCREEN_MAX_INPUTS_PER_SECOND) {
        if (acknowledgeDroppedInput(command)) return;
        return finish(1008, "input rate exceeded");
      }
    }
    if (command.method === "Emulation.setDeviceMetricsOverride") {
      width = command.params.width;
      height = command.params.height;
    }
    if (!sendUpstream(command)) return finish(1013, "viewer overloaded");
    if (command.method.startsWith("Input.")) pendingInputResponses += 1;
    pending.set(command.id, command.method);
  });

  upstream.on("message", (data, isBinary) => {
    if (isBinary || data.length > LIVE_SCREEN_MAX_FRAME_BYTES * 2) return finish(1009, "upstream message too large");
    let message;
    try { message = JSON.parse(data.toString("utf8")); } catch { return; }
    if (Number.isInteger(message.id) && pending.has(message.id)) {
      const method = pending.get(message.id);
      pending.delete(message.id);
      if (method.startsWith("Input.")) pendingInputResponses = Math.max(0, pendingInputResponses - 1);
      if (method === "Target.attachToTarget") {
        const sessionId = String(message.result?.sessionId || "");
        if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(sessionId)) return finish(1011, "attach failed");
        attachedSessionId = sessionId;
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, result: { sessionId } }));
        return;
      }
      const response = message.error
        ? { id: message.id, error: { code: Number(message.error.code) || -32000, message: "CDP command failed" } }
        : { id: message.id, result: {} };
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(response));
      return;
    }
    if (message.method !== "Page.screencastFrame" || message.sessionId !== attachedSessionId) return;
    const frameId = message.params?.sessionId;
    const dataText = message.params?.data;
    if (!Number.isInteger(frameId) || typeof dataText !== "string") return;
    const approximateBytes = Math.ceil(dataText.length * 0.75);
    const current = now();
    const interactive = Number(liveInteractionUntil.get(scopeKey) || 0) > current;
    const frameInterval = 1000 / (interactive ? LIVE_SCREEN_MAX_FPS : LIVE_SCREEN_IDLE_FPS);
    if (approximateBytes > LIVE_SCREEN_MAX_FRAME_BYTES
      || pendingInputResponses > 0
      || client.readyState !== WebSocket.OPEN
      || client.bufferedAmount > LIVE_SCREEN_MAX_FRAME_BUFFERED_BYTES) {
      ackFrame(frameId);
      return;
    }
    if (current - lastFrameAt < frameInterval) {
      clearTimeout(delayedAckTimer);
      delayedFrameId = frameId;
      delayedAckTimer = setTimeout(() => ackFrame(frameId), Math.max(1, frameInterval - (current - lastFrameAt)));
      delayedAckTimer.unref?.();
      return;
    }
    lastFrameAt = current;
    if (binaryFrames) {
      const jpeg = Buffer.from(dataText, "base64");
      const payload = Buffer.allocUnsafe(jpeg.length + 4);
      payload.writeUInt32BE(frameId, 0);
      jpeg.copy(payload, 4);
      client.send(payload, { binary: true });
      return;
    }
    client.send(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: dataText, sessionId: frameId, metadata: {} },
      sessionId: attachedSessionId,
    }));
  });

  client.on("close", () => finish());
  client.on("error", () => finish(1011, "viewer error"));
  upstream.on("close", () => finish(1011, "upstream closed"));
  upstream.on("error", () => finish(1011, "upstream error"));
  return { close: finish };
}

export function upgradeLiveScreenConnection({ request, socket, head, webSocketServer, grant, timeoutMs, maxConnectionMs, onActivity }) {
  let endpoint;
  try { endpoint = liveScreenCdpSocketUrl(grant.endpoint, grant.pageId); } catch {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = new WebSocket(endpoint, {
    origin: new URL(grant.endpoint).origin,
    handshakeTimeout: Math.min(timeoutMs, 5000),
    maxPayload: LIVE_SCREEN_MAX_FRAME_BYTES * 2,
    perMessageDeflate: false,
  });
  let upgraded = false;
  upstream.once("open", () => {
    if (socket.destroyed) return closeSocket(upstream, 1000, "client closed");
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      upgraded = true;
      relayLiveScreenConnection(client, upstream, grant, { maxConnectionMs, onActivity });
    });
  });
  upstream.once("error", () => {
    if (!upgraded && !socket.destroyed) socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    if (!upgraded) socket.destroy();
  });
  socket.once("close", () => {
    if (!upgraded) closeSocket(upstream, 1000, "client closed");
  });
}
