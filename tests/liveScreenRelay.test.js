import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { liveScreenCdpSocketUrl, relayLiveScreenConnection } from "../liveScreenRelay.js";

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
  }
  send(value, options = {}) {
    this.sent.push(Buffer.isBuffer(value) ? { binary: value, options } : JSON.parse(value));
  }
  close(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close");
  }
  terminate() { this.readyState = WebSocket.CLOSED; }
  receive(value, isBinary = false) { this.emit("message", Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), isBinary); }
}

test("relay maps the exact CDP page and forwards only sanitized screencast traffic", async () => {
  assert.equal(liveScreenCdpSocketUrl("https://agent.example/base?q=secret", "page/1").toString(), "wss://agent.example/devtools/page/page%2F1");
  const client = new MockSocket();
  const upstream = new MockSocket();
  let now = 1000;
  relayLiveScreenConnection(client, upstream, { pageId: "page-1" }, { maxConnectionMs: 5000, now: () => now });

  client.receive({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } });
  assert.equal(upstream.sent[0].method, "Target.attachToTarget");
  upstream.receive({ id: 1, result: { sessionId: "attached-1", forbidden: "not forwarded" } });
  assert.deepEqual(client.sent[0], { id: 1, result: { sessionId: "attached-1" } });

  client.receive({ id: 2, method: "Page.startScreencast", params: { format: "png", quality: 100 }, sessionId: "attached-1" });
  assert.deepEqual(upstream.sent[1].params, { format: "jpeg", quality: 45, maxWidth: 720, maxHeight: 405, everyNthFrame: 1 });
  upstream.receive({ method: "Runtime.consoleAPICalled", params: { args: ["secret"] }, sessionId: "attached-1" });
  assert.equal(client.sent.length, 1);
  upstream.receive({ method: "Page.screencastFrame", params: { data: "YWJj", sessionId: 7, metadata: { secret: "removed" } }, sessionId: "attached-1" });
  assert.deepEqual(client.sent[1], { method: "Page.screencastFrame", params: { data: "YWJj", sessionId: 7, metadata: {} }, sessionId: "attached-1" });

  now += 10;
  upstream.receive({ method: "Page.screencastFrame", params: { data: "ZGVm", sessionId: 8 }, sessionId: "attached-1" });
  const sentBeforeDelayedAck = upstream.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(upstream.sent.length, sentBeforeDelayedAck + 1, "rate-limited frames apply upstream backpressure before acknowledgement");
  assert.equal(upstream.sent.at(-1).method, "Page.screencastFrameAck");
  client.close(1000, "done");
});

test("relay negotiates compact binary JPEG frames for low-latency clients", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  relayLiveScreenConnection(client, upstream, { pageId: "page-1" }, { maxConnectionMs: 5000, now: () => 1000 });
  client.receive({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } });
  upstream.receive({ id: 1, result: { sessionId: "attached-1" } });
  client.receive({ id: 2, method: "Page.startScreencast", params: { maxWidth: 900, maxHeight: 600, transport: "binary" }, sessionId: "attached-1" });
  assert.equal(upstream.sent[1].params.transport, undefined, "transport negotiation never reaches CDP");
  upstream.receive({ method: "Page.screencastFrame", params: { data: "YWJj", sessionId: 7 }, sessionId: "attached-1" });
  const frame = client.sent[1];
  assert.equal(frame.options.binary, true);
  assert.equal(frame.binary.readUInt32BE(0), 7);
  assert.equal(frame.binary.subarray(4).toString("utf8"), "abc");
  client.close(1000, "done");
});

test("relay drops queued visual frames and coalescible input bursts without disconnecting", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  let now = 1000;
  relayLiveScreenConnection(client, upstream, { pageId: "page-1" }, { maxConnectionMs: 5000, now: () => now });

  client.receive({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } });
  upstream.receive({ id: 1, result: { sessionId: "attached-1" } });
  client.bufferedAmount = 600 * 1024;
  upstream.receive({ method: "Page.screencastFrame", params: { data: "YWJj", sessionId: 9 }, sessionId: "attached-1" });
  assert.equal(client.sent.length, 1, "a queued viewer receives no additional stale frame");
  assert.equal(upstream.sent.at(-1).method, "Page.screencastFrameAck");

  client.bufferedAmount = 0;
  for (let id = 2; id <= 122; id += 1) {
    client.receive({
      id,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 10, y: 10, button: "none", buttons: 0, clickCount: 0 },
      sessionId: "attached-1",
    });
  }
  assert.equal(client.readyState, WebSocket.OPEN, "trackpad or pointer bursts must not tear down the viewer");
  assert.deepEqual(client.sent.at(-1), { id: 122, result: {} });
});

test("relay prioritizes input acknowledgements over visual frames", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  let now = 1000;
  relayLiveScreenConnection(client, upstream, { pageId: "page-1" }, { maxConnectionMs: 5000, now: () => now });
  client.receive({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } });
  upstream.receive({ id: 1, result: { sessionId: "attached-1" } });
  client.receive({ id: 2, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 }, sessionId: "attached-1" });
  upstream.receive({ method: "Page.screencastFrame", params: { data: "YWJj", sessionId: 8 }, sessionId: "attached-1" });
  assert.equal(client.sent.length, 1, "frames wait while an input result is pending");
  upstream.receive({ id: 2, result: {} });
  now += 100;
  upstream.receive({ method: "Page.screencastFrame", params: { data: "ZGVm", sessionId: 9 }, sessionId: "attached-1" });
  assert.deepEqual(client.sent[1], { id: 2, result: {} });
  assert.equal(client.sent[2].params.data, "ZGVm");
  client.close(1000, "done");
});

test("input on the isolated control channel immediately releases the paired video channel", () => {
  const grant = { pageId: "page-1", profile: "hermes-operations", sessionId: "chat-1" };
  const videoClient = new MockSocket();
  const videoUpstream = new MockSocket();
  const controlClient = new MockSocket();
  const controlUpstream = new MockSocket();
  let now = 1000;
  let activityReports = 0;
  relayLiveScreenConnection(videoClient, videoUpstream, grant, { maxConnectionMs: 5000, now: () => now });
  relayLiveScreenConnection(controlClient, controlUpstream, grant, {
    maxConnectionMs: 5000,
    now: () => now,
    onActivity: () => { activityReports += 1; },
  });
  videoClient.receive({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } });
  videoUpstream.receive({ id: 1, result: { sessionId: "video-session" } });
  controlClient.receive({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } });
  controlUpstream.receive({ id: 1, result: { sessionId: "control-session" } });
  videoUpstream.receive({ method: "Page.screencastFrame", params: { data: "YWJj", sessionId: 1 }, sessionId: "video-session" });
  now += 20;
  videoUpstream.receive({ method: "Page.screencastFrame", params: { data: "ZGVm", sessionId: 2 }, sessionId: "video-session" });
  const beforeInput = videoUpstream.sent.length;
  controlClient.receive({
    id: 2,
    method: "Input.dispatchMouseEvent",
    params: { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 },
    sessionId: "control-session",
  });
  assert.equal(videoUpstream.sent.length, beforeInput + 1, "interaction releases an idle delayed frame without waiting for the idle timer");
  assert.equal(videoUpstream.sent.at(-1).method, "Page.screencastFrameAck");
  assert.equal(activityReports, 1);
  videoClient.close(1000, "done");
  controlClient.close(1000, "done");
});

test("relay rejects arbitrary CDP methods instead of becoming a raw DevTools tunnel", () => {
  const client = new MockSocket();
  const upstream = new MockSocket();
  relayLiveScreenConnection(client, upstream, { pageId: "page-1" }, { maxConnectionMs: 5000 });
  client.receive({ id: 1, method: "Runtime.evaluate", params: { expression: "fetch('/secret')" } });
  assert.equal(client.closeCode, 1008);
  assert.equal(upstream.sent.length, 0);
});
