import assert from "node:assert/strict";
import test from "node:test";
import {
  liveScreenEndpointCandidates,
  liveScreenFallbackEndpoint,
  normalizeLiveScreenCdpUrl,
  parseLiveScreenProfileMap,
  selectLiveScreenFallbackPage,
} from "../liveScreenBridge.js";

test("profile-mapped Live Screen routes fail closed instead of falling back across profiles", () => {
  const mapped = parseLiveScreenProfileMap([
    "hermes-content=http://hermes-agent:9401",
    "default=http://hermes-agent:9223",
  ].join(","));

  assert.deepEqual(liveScreenEndpointCandidates("hermes-content", mapped, ["http://fallback:9223"]), ["http://hermes-agent:9401"]);
  assert.deepEqual(liveScreenEndpointCandidates("unmapped", mapped, ["http://fallback:9223"]), []);
  assert.deepEqual(liveScreenEndpointCandidates("default", mapped, ["http://fallback:9223"]), ["http://hermes-agent:9223"]);
});

test("CDP URLs are normalized and unsupported schemes are rejected", () => {
  assert.equal(normalizeLiveScreenCdpUrl("ws://agent:9223/devtools/browser?id=1"), "http://agent:9223");
  assert.equal(normalizeLiveScreenCdpUrl("file:///tmp/chrome"), "");
});

test("current-tab fallback remains inside one isolated profile endpoint", () => {
  const mapped = parseLiveScreenProfileMap([
    "hermes-operations=http://hermes-agent:9405",
    "hermes-content=http://hermes-agent:9401",
  ].join(","));

  assert.equal(liveScreenFallbackEndpoint("hermes-operations", mapped, ["http://fallback:9223"]), "http://hermes-agent:9405");
  assert.equal(liveScreenFallbackEndpoint("hermes-content", mapped, ["http://fallback:9223"]), "http://hermes-agent:9401");
  assert.equal(liveScreenFallbackEndpoint("unmapped", mapped, ["http://fallback:9223"]), "");
});

test("fallback selection prefers the focused tab, then URL evidence, and fails closed on ambiguity", () => {
  const pages = [
    { id: "instagram", type: "page", url: "https://www.instagram.com/accounts/login/" },
    { id: "drive", type: "page", url: "https://drive.google.com/drive/u/0/my-drive" },
    { id: "blank", type: "page", url: "about:blank" },
  ];

  assert.equal(selectLiveScreenFallbackPage(pages, { hintUrl: pages[0].url, focusedPageIds: ["drive"] })?.id, "drive");
  assert.equal(selectLiveScreenFallbackPage(pages, { focusedPageIds: ["drive"] })?.id, "drive");
  assert.equal(selectLiveScreenFallbackPage(pages, { hintUrl: pages[0].url })?.id, "instagram");
  assert.equal(selectLiveScreenFallbackPage(pages), null);
  assert.equal(selectLiveScreenFallbackPage([pages[0]])?.id, "instagram");
});
