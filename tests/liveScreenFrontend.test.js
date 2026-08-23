import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_RELAY_TEXT_LENGTH,
  clampRelayText,
  liveScreenAspectRatio,
  liveScreenBlocksFrame,
  liveScreenConnectionIdentity,
  liveTicketExpired,
  relayPoint,
  relayReconnectDelay,
  relayViewport,
} from "../src/liveScreenUi.js";

test("Live Screen preserves safe metadata and received-frame aspect ratios", () => {
  assert.equal(liveScreenAspectRatio(4 / 3), 4 / 3);
  assert.equal(liveScreenAspectRatio(9 / 16), 9 / 16);
  assert.equal(liveScreenAspectRatio(0), 16 / 9);
  assert.equal(liveScreenAspectRatio(10), 16 / 9);
  assert.equal(liveScreenAspectRatio("invalid"), 16 / 9);
});

test("Live Screen pointer and wheel coordinates clamp and scale to the frame", () => {
  const point = relayPoint({ left: 10, top: 20, width: 200, height: 100 }, { width: 1600, height: 800 }, 260, -10);
  assert.deepEqual(point, { x: 1600, y: 0, scaleX: 8, scaleY: 8 });
  assert.equal(relayPoint({ width: 0, height: 100 }, { width: 1600, height: 900 }, 0, 0), null);
});

test("Live Screen viewport follows CSS bounds and caps DPR and reconnect backoff", () => {
  assert.deepEqual(relayViewport({ width: 390, height: 219 }, 3), { width: 390, height: 240, deviceScaleFactor: 1.5, mobile: true });
  assert.deepEqual(relayViewport({ width: 1920, height: 1080 }, 1), { width: 1600, height: 1080, deviceScaleFactor: 1, mobile: false });
  assert.equal(relayReconnectDelay(1), 500);
  assert.equal(relayReconnectDelay(20), 15000);
});

test("Live Screen limits inserted text and understands second or millisecond expiry", () => {
  assert.equal(clampRelayText("a".repeat(MAX_RELAY_TEXT_LENGTH + 20)).length, MAX_RELAY_TEXT_LENGTH);
  assert.equal(liveTicketExpired(2_000, 2_000_001), true);
  assert.equal(liveTicketExpired("2020-01-01T00:00:00.000Z", Date.now()), true);
  assert.equal(liveTicketExpired(2_000_000_000_000, 1_000), false);
  assert.equal(liveTicketExpired(undefined, 1_000), false);
});

test("StrictMode mounts twice but 1.8 second polling tickets cause no additional relay restart", () => {
  const first = {
    pageId: "page-1",
    viewerRefreshUrl: "/bridge/live-screens?profile=default&sessionId=s1",
    viewerSocketUrl: "/bridge/live-screens/socket?ticket=one",
    viewerTicketExpiresAt: 1000,
  };
  const polled = {
    ...first,
    viewerSocketUrl: "/bridge/live-screens/socket?ticket=two",
    viewerTicketExpiresAt: 2000,
  };
  assert.equal(liveScreenConnectionIdentity(first, "default", "s1"), liveScreenConnectionIdentity(polled, "default", "s1"));
  const pollingIdentities = Array.from({ length: 12 }, (_, index) => liveScreenConnectionIdentity({
    ...first,
    viewerSocketUrl: `/bridge/live-screens/socket?ticket=${index}`,
    viewerTicketExpiresAt: 1000 + index,
  }, "default", "s1"));
  const pollingRestarts = pollingIdentities.slice(1).filter((identity, index) => identity !== pollingIdentities[index]).length;
  assert.equal(2 + pollingRestarts, 2, "StrictMode의 초기 2회 외 polling 재시작이 없어야 합니다.");
  const zoomed = {
    ...polled,
    viewerRefreshUrl: "/bridge/live-screens?profile=default&sessionId=s1&url=https%3A%2F%2Fmap.naver.com%2F%3Fc%3D20.00",
  };
  assert.equal(liveScreenConnectionIdentity(first, "default", "s1"), liveScreenConnectionIdentity(zoomed, "default", "s1"));
  assert.notEqual(liveScreenConnectionIdentity(first, "default", "s1"), liveScreenConnectionIdentity({ ...polled, pageId: "page-2" }, "default", "s1"));
  assert.notEqual(liveScreenConnectionIdentity(first, "default", "s1"), liveScreenConnectionIdentity(polled, "other", "s1"));
  assert.notEqual(liveScreenConnectionIdentity(first, "default", "s1"), liveScreenConnectionIdentity(polled, "default", "s2"));
});

test("Live Screen keeps the last good frame during a same-page reconnect", () => {
  assert.equal(liveScreenBlocksFrame("connecting", true), false);
  assert.equal(liveScreenBlocksFrame("reconnecting", true), false);
  assert.equal(liveScreenBlocksFrame("live", true), false);
  assert.equal(liveScreenBlocksFrame("live", false), true);
  assert.equal(liveScreenBlocksFrame("error", true), true);
  assert.equal(liveScreenBlocksFrame("expired", true), true);
});

test("Live Screen source keeps secure heartbeat recovery, low-latency input and fullscreen contracts", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../src/LiveScreen.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(component, /Runtime\.enable/);
  assert.match(component, /fetch\(refreshUrl, \{ credentials: "same-origin", cache: "no-store" \}\)/);
  assert.match(component, /viewerTicketExpiresAt/);
  assert.match(component, /let ticketReady = !refreshUrl/);
  assert.match(component, /const initialView = latestViewRef\.current/);
  assert.match(component, /\}, \[connectionIdentity, isProducer, producerEpoch, retryKey, send, sendControlLocal, syncViewport, updateStatus\]\);/);
  assert.match(component, /clearRect/);
  assert.match(component, /frameSequence !== frameSequenceRef\.current/);
  assert.match(component, /bitmap\.width \/ bitmap\.height/);
  assert.match(component, /pendingFrameBlobRef\.current = blob/);
  assert.match(component, /socket\.binaryType = "arraybuffer"/);
  assert.match(component, /fixedAspectRatio=\{\["chat", "dock"\]\.includes\(variant\) \? 16 \/ 9 : 0\}/);
  assert.match(component, /--live-screen-aspect-ratio/);
  assert.match(component, /Input\.dispatchTouchEvent/);
  assert.match(component, /onPointerCancel/);
  assert.match(component, /lastPointerMoveAtRef\.current < 16/);
  assert.match(component, /heartbeatCallId = sendControlLocal\("Page\.enable"\)/);
  assert.match(component, /controlSocketRef\.current/);
  assert.match(component, /send\("Emulation\.setDeviceMetricsOverride"/);
  assert.doesNotMatch(component, /sendControl\("Emulation\.setDeviceMetricsOverride"/);
  assert.match(component, /now - heartbeatSentAt > 12_000/);
  assert.doesNotMatch(component, /화면 갱신이 지연되고 있습니다/);
  assert.match(component, /pendingWheelRef\.current/);
  assert.match(component, /requestAnimationFrame/);
  assert.match(component, /\(inputRef\.current \|\| canvas\)\.focus/);
  assert.match(component, /const viewport = LIVE_SCREEN_CANONICAL_VIEWPORT/);
  assert.match(component, /subscribeLiveScreenStream\(streamKey/);
  assert.match(component, /hubRef\.current\?\.publishFrame\(blob\)/);
  assert.doesNotMatch(component, /if \(!reconnectAttempt\) hubRef\.current\?\.clearFrame\(\)/);
  assert.doesNotMatch(component, /new ResizeObserver/);
  assert.match(component, /requestFullscreen/);
  assert.match(component, /role="dialog" aria-modal="true"/);
  assert.match(component, /data-native-fullscreen=\{fullscreen \? "true" : "false"\}/);
  assert.match(component, /document\.body\.style\.overflow = "hidden"/);
  assert.match(component, /className="agent-live-actions"/);
  assert.match(component, /className="agent-live-location"/);
  assert.match(component, /className="agent-live-help"/);
  assert.match(component, /className="chrome-relay-presence"/);
  assert.match(component, /aria-busy=\{!isLive\}/);
  assert.match(component, /statusRef\.current !== "live"/);
  assert.match(styles, /\.live-screen-modal:fullscreen/);
  assert.match(styles, /height: 100dvh/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /@media \(max-height: 600px\) and \(orientation: landscape\)/);
  assert.match(styles, /\.agent-live-view\.modal[\s\S]*?grid-template-rows: auto auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.office-chat-live \.agent-live-view \{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\)/s);
  assert.doesNotMatch(styles, /\.office-chat-live \.agent-live-view \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto/s);
  assert.match(styles, /\.chat-live-panel \.agent-live-view \{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\)/s);
  assert.doesNotMatch(styles, /\.chat-live-panel \.agent-live-view \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto/s);
  assert.match(styles, /\.chat-live-panel \.agent-live-frame,[\s\S]*?aspect-ratio: 16 \/ 9/);
  assert.match(styles, /aspect-ratio: var\(--live-screen-aspect-ratio/);
  assert.match(styles, /\.agent-live-view header button \{[^}]*min-height: 44px !important/s);
});
