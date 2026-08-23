import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_START_TIMEOUT_MS = 15_000;

test("runtime image and compose include the Instagram bridge module and admin-only secret", async () => {
  const [dockerfile, compose, serverSource, hermesClient, gatewayClient] = await Promise.all([
    readFile(path.join(projectRoot, "Dockerfile"), "utf8"),
    readFile(path.join(projectRoot, "docker-compose.office.yml"), "utf8"),
    readFile(path.join(projectRoot, "server.js"), "utf8"),
    readFile(path.join(projectRoot, "src", "hermes.js"), "utf8"),
    readFile(path.join(projectRoot, "src", "gateway.js"), "utf8"),
  ]);
  assert.match(dockerfile, /^COPY instagramProxy\.js \.\/instagramProxy\.js$/m);
  assert.match(dockerfile, /^COPY hermesProxy\.js \.\/hermesProxy\.js$/m);
  assert.match(dockerfile, /^COPY googleDriveMirror\.js \.\/googleDriveMirror\.js$/m);
  assert.match(dockerfile, /^COPY liveScreenBridge\.js \.\/liveScreenBridge\.js$/m);
  assert.match(dockerfile, /^COPY liveScreenRelay\.js \.\/liveScreenRelay\.js$/m);
  assert.match(dockerfile, /^COPY liveScreenSecurity\.js \.\/liveScreenSecurity\.js$/m);
  assert.match(dockerfile, /^COPY organizationHierarchy\.js \.\/organizationHierarchy\.js$/m);
  assert.match(dockerfile, /^COPY agentCalendarAccess\.js \.\/agentCalendarAccess\.js$/m);
  assert.match(dockerfile, /^COPY reservationIntegrations\.js \.\/reservationIntegrations\.js$/m);
  assert.match(dockerfile, /^COPY src\/profileIds\.js \.\/src\/profileIds\.js$/m);
  assert.match(compose, /^\s+INSTAGRAM_BRIDGE_TARGET: "\$\{INSTAGRAM_BRIDGE_TARGET:-\}"$/m);
  assert.match(compose, /^\s+HERMES_AUTH_MODE: "\$\{HERMES_AUTH_MODE:-official\}"$/m);
  assert.match(compose, /^\s+INSTAGRAM_BRIDGE_ADMIN_TOKEN: "\$\{INSTAGRAM_BRIDGE_ADMIN_TOKEN:-\}"$/m);
  assert.match(compose, /^\s+HERMES_OFFICE_SESSION_SECRET: "\$\{HERMES_OFFICE_SESSION_SECRET:\?[^}]+\}"$/m);
  assert.match(compose, /^\s+RESERVATION_SOURCES_PATH: "\$\{RESERVATION_SOURCES_PATH:-\/run\/secrets\/reservation_sources\.json\}"$/m);
  assert.match(compose, /^\s+RESERVATION_GOOGLE_CLIENT_SECRET_PATH: "\/data\/reservations\/google_reservation_client_secret\.json"$/m);
  assert.match(compose, /^\s+RESERVATION_GOOGLE_TOKEN_PATH: "\/data\/reservations\/google_reservation_oauth_token\.json"$/m);
  assert.match(compose, /^\s+read_only: true$/m);
  assert.match(compose, /^\s+user: "\$\{HERMES_RUNTIME_UID:-1000\}:\$\{HERMES_RUNTIME_GID:-1000\}"$/m);
  assert.match(compose, /^\s+- \.\/deploy\/secrets:\/run\/secrets:ro$/m);
  assert.doesNotMatch(compose, /\/docker\//);
  assert.doesNotMatch(compose, /hstgr\.cloud/);
  assert.doesNotMatch(compose, /RESERVATION_(?:NAVER_BIZ|NAVER_PRODUCT|SPACECLOUD_PRODUCT|SPACECLOUD_SPACE)_ID: "\d+"/);
  assert.doesNotMatch(compose, /INSTAGRAM_BRIDGE_TOOL_TOKEN/);
  assert.doesNotMatch(serverSource, /__HERMES_SESSION_TOKEN__/);
  assert.doesNotMatch(hermesClient, /X-Hermes-Session-Token|Authorization\s*:\s*`Bearer|fetch\(["'`]\/bridge\/session["'`]/);
  assert.doesNotMatch(gatewayClient, /[?&]token=|getSessionToken/);
  assert.match(gatewayClient, /[?&]ticket=/);
});

test("runtime health check is local and build context excludes environment secrets", async () => {
  const [server, dockerignore] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
  ]);
  assert.match(server, /url\.pathname === "\/healthz"/);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^secrets\/$/m);
});

test("production server imports its runtime modules and denies internal routes before authentication", async (t) => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: "0",
      HERMES_OFFICE_USER: "runtime-smoke",
      HERMES_OFFICE_PASSWORD_HASH: "disabled:disabled",
      HERMES_OFFICE_SESSION_SECRET: "runtime-only-8d2f4a6c1e3b5d7f9a0c2e4b6d8f1a3c",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timed out: ${stderr.join("")}`)), SERVER_START_TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening (${code}): ${stderr.join("")}`));
    });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/Hermes Office listening on (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });

  const response = await fetch(`http://127.0.0.1:${port}/internal/tool/status`, { redirect: "manual" });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(await response.json(), { error: "not found" });
});

test("production server rejects a weak or missing session signing secret", async () => {
  for (const secret of ["", "short"]) {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: "0",
        HERMES_OFFICE_SESSION_SECRET: secret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("weak-secret server did not exit"));
      }, SERVER_START_TIMEOUT_MS);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.notEqual(code, 0);
    assert.match(stderr.join(""), /HERMES_OFFICE_SESSION_SECRET must be at least 32 bytes/);
  }
});
