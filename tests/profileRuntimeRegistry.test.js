import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { reconcileRegistry, syncRegistry } = require("../deploy/hermes-agent/profile-runtime-registry.cjs");

test("profile runtime registry preserves existing slots and appends newly discovered members", () => {
  const initial = reconcileRegistry({
    configuredProfiles: "team-seoyun,team-yuna",
    discoveredProfiles: ["team-doyun"],
    cdpBase: 9300,
    proxyBase: 9400,
  });
  assert.deepEqual(initial.profiles.map(({ profile, index, proxyPort, active }) => ({ profile, index, proxyPort, active })), [
    { profile: "team-seoyun", index: 0, proxyPort: 9400, active: true },
    { profile: "team-yuna", index: 1, proxyPort: 9401, active: true },
    { profile: "team-doyun", index: 2, proxyPort: 9402, active: true },
  ]);

  const next = reconcileRegistry({
    configuredProfiles: "team-yuna,team-seoyun",
    discoveredProfiles: ["team-new"],
    previous: initial,
    cdpBase: 9300,
    proxyBase: 9400,
  });
  const byName = Object.fromEntries(next.profiles.map((entry) => [entry.profile, entry]));
  assert.equal(byName["team-seoyun"].index, 0);
  assert.equal(byName["team-yuna"].index, 1);
  assert.equal(byName["team-doyun"].active, false);
  assert.equal(byName["team-new"].index, 3, "retired profile slots must not be reassigned to another identity");
});

test("agent supervisor discovers profiles and publishes only the internal registry", async () => {
  const [entrypoint, dockerfile, registry] = await Promise.all([
    readFile(new URL("../deploy/hermes-agent/entrypoint.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/profile-runtime-registry.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(entrypoint, /managed_profile_rows/);
  assert.match(entrypoint, /HERMES_PROFILE_DISCOVERY_ROOT/);
  assert.match(entrypoint, /start_profile_registry/);
  assert.match(dockerfile, /profile-runtime-registry\.cjs/);
  assert.match(registry, /127\.0\.0\.1|0\.0\.0\.0/);
  assert.doesNotMatch(registry, /Access-Control-Allow-Origin/);
});

test("registry HTTP service resolves a discovered member and rejects unknown or malformed profiles", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-profile-registry-test-"));
  const stateFile = path.join(root, "registry.json");
  syncRegistry({ stateFile, configuredProfiles: "team-one", discoveredProfiles: ["team-new"] });
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../deploy/hermes-agent/profile-runtime-registry.cjs", import.meta.url)), "serve"], {
    env: { ...process.env, HERMES_PROFILE_RUNTIME_REGISTRY: stateFile, HERMES_PROFILE_REGISTRY_HOST: "127.0.0.1", HERMES_PROFILE_REGISTRY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (data) => { if (String(data).includes("listening")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`registry exited ${code}`)));
    });
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/profiles/team-new`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { profile: "team-new", index: 1, cdpPort: 9301, proxyPort: 9401 });
    assert.equal((await fetch(`${origin}/profiles/unknown`)).status, 404);
    assert.equal((await fetch(`${origin}/profiles/%`)).status, 404);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200, "malformed input must not kill the registry");
  } finally {
    child.kill();
    await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  }
});

test("registry does not reuse a retired slot or duplicate persisted identity", () => {
  const state = reconcileRegistry({
    configuredProfiles: "team-new",
    previous: { profiles: [{ profile: "team-old", index: 0 }, { profile: "team-old", index: 1 }] },
  });
  assert.equal(state.profiles.find((entry) => entry.profile === "team-old").index, 0);
  assert.equal(state.profiles.find((entry) => entry.profile === "team-new").index, 1);
  assert.throws(() => reconcileRegistry({ configuredProfiles: "team-new", previous: state, limit: 1 }), /No browser profile slots remain/);
});

test("registry sync never overwrites corrupt state or reassigns its browser slots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-profile-registry-corrupt-"));
  const stateFile = path.join(root, "registry.json");
  try {
    for (const contents of ["not-json", "{}", JSON.stringify({ profiles: [
      { profile: "team-one", index: 0 }, { profile: "team-two", index: 0 },
    ] })]) {
      await writeFile(stateFile, contents);
      assert.throws(() => syncRegistry({ stateFile, configuredProfiles: "team-new", discoveredProfiles: [] }), /refusing to reassign/);
      assert.equal(await readFile(stateFile, "utf8"), contents);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
