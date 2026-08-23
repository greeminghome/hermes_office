import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MINJUN_HERMES_PROFILE_ID,
  MINJUN_UI_PROFILE_ID,
  normalizeUiProfiles,
  normalizeUiSession,
  toHermesProfileId,
  toUiProfileId,
  withHermesProfile,
} from "../src/profileIds.js";

test("Minjun's UI alias resolves to the deployed Hermes profile", () => {
  assert.equal(MINJUN_UI_PROFILE_ID, "default");
  assert.equal(MINJUN_HERMES_PROFILE_ID, "greeming-minjun");
  assert.equal(toHermesProfileId("default"), "greeming-minjun");
  assert.equal(toHermesProfileId("greeming-seoyun"), "greeming-seoyun");
  assert.equal(toHermesProfileId(""), "");
  assert.equal(toUiProfileId("greeming-minjun"), "default");
  assert.equal(toUiProfileId("greeming-seoyun"), "greeming-seoyun");
});

test("Minjun aliases collapse into one UI profile while preserving the deployed runtime state", () => {
  const profiles = normalizeUiProfiles([
    { name: "default", description: "legacy alias", gateway_running: false },
    { name: "greeming-minjun", description: "canonical runtime", gateway_running: true, model: "gpt-5" },
    { name: "greeming-seoyun", gateway_running: true },
  ]);
  assert.deepEqual(profiles.map((profile) => profile.name), ["default", "greeming-seoyun"]);
  assert.deepEqual(profiles[0], {
    name: "default",
    description: "canonical runtime",
    gateway_running: true,
    model: "gpt-5",
  });
  assert.equal(normalizeUiSession({ id: "s1", profile: "greeming-minjun" }).profile, "default");
});

test("Gateway profile normalization is immutable and leaves unrelated requests alone", () => {
  const original = { cols: 96, profile: "default" };
  assert.deepEqual(withHermesProfile(original), { cols: 96, profile: "greeming-minjun" });
  assert.deepEqual(original, { cols: 96, profile: "default" });

  const unrelated = { session_id: "session-1", text: "hello" };
  assert.equal(withHermesProfile(unrelated), unrelated);
});

test("Chat, HTTP profile APIs and Live Browser share the canonical profile boundary", async () => {
  const [gateway, hermes] = await Promise.all([
    readFile(new URL("../src/gateway.js", import.meta.url), "utf8"),
    readFile(new URL("../src/hermes.js", import.meta.url), "utf8"),
  ]);
  assert.match(gateway, /params: withHermesProfile\(params\)/);
  assert.match(hermes, /query\.set\("profile", toHermesProfileId\(profile\)\)/);
  assert.match(hermes, /profile: toHermesProfileId\(profile\), sessionId/);
});
