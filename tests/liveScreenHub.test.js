import assert from "node:assert/strict";
import test from "node:test";
import {
  liveScreenHubSnapshot,
  liveScreenStreamKey,
  resetLiveScreenHubsForTest,
  subscribeLiveScreenStream,
} from "../src/liveScreenHub.js";

test.afterEach(() => resetLiveScreenHubsForTest());

test("one session page has one producer and fans frames out to every consumer", () => {
  const key = liveScreenStreamKey("agent-a", "session-a", { pageId: "page-a" });
  const framesA = [];
  const framesB = [];
  const first = subscribeLiveScreenStream(key, { onFrame: (frame) => framesA.push(frame) });
  const second = subscribeLiveScreenStream(key, { onFrame: (frame) => framesB.push(frame) });

  assert.equal(first.isProducer(), true);
  assert.equal(second.isProducer(), false);
  assert.deepEqual(liveScreenHubSnapshot().map(({ consumers, producers }) => ({ consumers, producers })), [{ consumers: 2, producers: 1 }]);
  first.publishFrame("frame-1");
  assert.deepEqual(framesA, ["frame-1"]);
  assert.deepEqual(framesB, ["frame-1"]);
});

test("different sessions never share a stream producer", () => {
  const first = subscribeLiveScreenStream(liveScreenStreamKey("agent-a", "session-a", { pageId: "page" }), {});
  const second = subscribeLiveScreenStream(liveScreenStreamKey("agent-a", "session-b", { pageId: "page" }), {});
  assert.equal(first.isProducer(), true);
  assert.equal(second.isProducer(), true);
  assert.equal(liveScreenHubSnapshot().length, 2);
});

test("producer ownership moves to a remaining consumer without duplicating producers", () => {
  const producerChanges = [];
  const key = liveScreenStreamKey("agent-a", "session-a", { pageId: "page-a" });
  const first = subscribeLiveScreenStream(key, {});
  const second = subscribeLiveScreenStream(key, { onProducerChange: (value) => producerChanges.push(value) });
  first.release();
  assert.equal(second.isProducer(), true);
  assert.deepEqual(producerChanges, [false, true]);
  assert.deepEqual(liveScreenHubSnapshot().map(({ producers }) => producers), [1]);
});

test("a short per-stream control lease serializes input from multiple consumers", () => {
  const sent = [];
  const controlsA = [];
  const controlsB = [];
  const key = liveScreenStreamKey("agent-a", "session-a", { pageId: "page-a" });
  const first = subscribeLiveScreenStream(key, { onControlChange: (state) => controlsA.push(state) });
  const second = subscribeLiveScreenStream(key, { onControlChange: (state) => controlsB.push(state) });
  first.setTransport({ sendControl: (method) => sent.push(method) });

  assert.notEqual(first.sendControl("Input.dispatchMouseEvent", {}), false);
  assert.equal(second.sendControl("Input.insertText", {}), false);
  assert.deepEqual(sent, ["Input.dispatchMouseEvent"]);
  assert.equal(controlsA.at(-1).owned, true);
  assert.equal(controlsB.at(-1).busy, true);

  first.releaseControl();
  assert.notEqual(second.sendControl("Input.insertText", {}), false);
  assert.deepEqual(sent, ["Input.dispatchMouseEvent", "Input.insertText"]);
});
