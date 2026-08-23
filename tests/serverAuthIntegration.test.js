import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_START_TIMEOUT_MS = 15_000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request({ port, method = "GET", path: requestPath = "/", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path: requestPath, headers: { Host: "office.test", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function rawRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => socket.end(payload));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function websocketUpgrade({ port, path: requestPath, cookie }) {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        "Host: office.test",
        "Origin: https://office.test",
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGVzdC1rZXktMTIzNDU2Nw==",
        "",
        "",
      ].join("\r\n"));
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket upgrade timed out"));
    }, 3000);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function passwordHash(password) {
  const salt = "integration-salt";
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function startOffice(t, upstreamPort, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: "0",
      PUBLIC_ORIGIN: "https://office.test",
      HERMES_TARGET: `http://127.0.0.1:${upstreamPort}`,
      HERMES_AUTH_PROVIDER: "basic",
      HERMES_OFFICE_USER: "office-user",
      HERMES_OFFICE_PASSWORD_HASH: passwordHash("office-pass"),
      HERMES_OFFICE_SESSION_SECRET: "test-only-7c9f4b2e6a8d1c3f5b7e9a2d4c6f8b0e",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timed out: ${stderr.join("")}`)), SERVER_START_TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}): ${stderr.join("")}`));
    });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/ listening on (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });
}

test("login page uses the configured deployment brand and escapes it safely", async (t) => {
  const upstream = http.createServer((_req, res) => res.writeHead(404).end());
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const officePort = await startOffice(t, upstreamPort, {
    OFFICE_BRAND_NAME: "Example & Partners Office",
  });

  const response = await request({ port: officePort, path: "/login" });
  assert.equal(response.status, 200);
  assert.match(response.body, /<title>Example &amp; Partners Office Login<\/title>/);
  assert.match(response.body, /<h1>Example &amp; Partners Office<\/h1>/);
  assert.doesNotMatch(response.body, /Example & Partners Office/);
});

test("agent calendar broker is bearer/profile protected without an Office browser session", async (t) => {
  const upstream = http.createServer((_req, res) => res.writeHead(404).end());
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const token = "test-agent-calendar-read-token-32-bytes-minimum";
  const officePort = await startOffice(t, upstreamPort, {
    RESERVATION_AGENT_READ_TOKEN: token,
    RESERVATION_AGENT_ALLOWED_PROFILES: "hermes-operations",
  });

  const missing = await request({ port: officePort, path: "/agent-api/calendar/events" });
  assert.equal(missing.status, 401);
  const wrongProfile = await request({
    port: officePort,
    path: "/agent-api/calendar/events",
    headers: { Authorization: `Bearer ${token}`, "X-Hermes-Agent-Profile": "hermes-brand" },
  });
  assert.equal(wrongProfile.status, 401);
  const authorized = await request({
    port: officePort,
    path: "/agent-api/calendar/events?limit=1",
    headers: { Authorization: `Bearer ${token}`, "X-Hermes-Agent-Profile": "hermes-operations" },
  });
  assert.equal(authorized.status, 503);
  assert.equal(JSON.parse(authorized.body).error, "calendar temporarily unavailable");
});

test("legacy v0.16 auth keeps the bootstrap token server-side while relaying the sanitized dashboard", async (t) => {
  const token = "legacy-integration-token-1234567890";
  const observed = [];
  const upgrades = [];
  const upstream = http.createServer((req, res) => {
    observed.push({ url: req.url, authorization: req.headers.authorization || "" });
    if (req.url === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<script>window.__HERMES_SESSION_TOKEN__="${token}"</script>`);
      return;
    }
    if (req.url === "/api/version" && req.headers.authorization === `Bearer ${token}`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"version":"0.16.0"}');
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"detail":"unauthorized"}');
  });
  upstream.on("upgrade", (req, socket) => {
    upgrades.push({ url: req.url, authorization: req.headers.authorization || "" });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const officePort = await startOffice(t, upstreamPort, { HERMES_AUTH_MODE: "legacy-server-token" });

  const loginPage = await request({ port: officePort, path: "/login" });
  assert.equal(loginPage.status, 200);
  assert.doesNotMatch(loginPage.body, /name="hermes_password"/);
  const body = new URLSearchParams({ user: "office-user", password: "office-pass", next: "/" }).toString();
  const login = await request({
    port: officePort,
    method: "POST",
    path: "/login",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body,
  });
  assert.equal(login.status, 302);
  assert.equal(JSON.stringify(login.headers).includes(token), false);
  assert.equal(login.body.includes(token), false);
  const officeCookie = login.headers["set-cookie"]?.find((cookie) => cookie.startsWith("hermes_office_sid="))?.split(";", 1)[0];
  assert.ok(officeCookie);

  const version = await request({ port: officePort, path: "/hermes/api/version", headers: { Cookie: officeCookie } });
  assert.equal(version.status, 200);
  assert.equal(version.body, '{"version":"0.16.0"}');
  const dashboardHtml = await request({ port: officePort, path: "/hermes/chat", headers: { Cookie: officeCookie } });
  assert.equal(dashboardHtml.status, 200);
  assert.equal(dashboardHtml.body.includes(token), false);
  assert.match(dashboardHtml.body, /window\.__HERMES_SESSION_TOKEN__=""/);
  assert.match(dashboardHtml.body, /window\.__HERMES_AUTH_REQUIRED__=true/);
  assert.equal(observed.filter((entry) => entry.url === "/chat").length, 2);
  assert.equal(observed.some((entry) => entry.url === "/api/version" && entry.authorization === `Bearer ${token}`), true);

  const mintTicket = async () => {
    const response = await request({ port: officePort, method: "POST", path: "/hermes/api/auth/ws-ticket", headers: { Cookie: officeCookie } });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ttl_seconds, 30);
    assert.ok(payload.ticket);
    assert.equal(response.body.includes(token), false);
    return payload.ticket;
  };
  const connections = [
    ["/hermes/api/ws", await mintTicket()],
    ["/hermes/api/ws", await mintTicket()],
    ["/hermes/api/pty?channel=one", await mintTicket()],
    ["/hermes/api/pty?channel=two", await mintTicket()],
  ];
  for (const [target, ticket] of connections) {
    const separator = target.includes("?") ? "&" : "?";
    const upgraded = await websocketUpgrade({ port: officePort, path: `${target}${separator}ticket=${encodeURIComponent(ticket)}`, cookie: officeCookie });
    assert.match(upgraded, /^HTTP\/1\.1 101/m);
  }
  assert.equal(upgrades.length, 4);
  assert.equal(upgrades.every((entry) => entry.authorization === `Bearer ${token}`), true);
  assert.equal(upgrades.every((entry) => !entry.url.includes("ticket=")), true);
  assert.equal(upgrades.every((entry) => entry.url.includes(`token=${token}`)), true);
  const replay = await websocketUpgrade({ port: officePort, path: `/hermes/api/ws?ticket=${encodeURIComponent(connections[0][1])}`, cookie: officeCookie });
  assert.match(replay, /^HTTP\/1\.1 401/m);
  assert.equal(upgrades.length, 4, "a replay never reaches the upstream WebSocket server");
});

test("dual login fails closed, reads identity back, relays cookies, and logs both sessions out", async (t) => {
  let logoutCookie = "";
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/auth/password-login") {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (payload.provider !== "basic" || payload.username !== "hermes-user" || payload.password !== "hermes-pass") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end('{"detail":"Invalid credentials"}');
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": [
            "__Secure-hermes_session_at=access; HttpOnly; Secure; SameSite=Lax; Path=/hermes",
            "__Secure-hermes_session_rt=refresh; HttpOnly; Secure; SameSite=Lax; Path=/hermes",
          ],
        });
        res.end('{"ok":true,"next":"/"}');
        return;
      }
      if (req.method === "GET" && req.url === "/api/auth/me" && req.headers.cookie?.includes("hermes_session_at=access")) {
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "__Secure-hermes_session_at=rotated; HttpOnly; Secure; SameSite=Lax; Path=/hermes" });
        res.end('{"user_id":"hermes-user","provider":"basic","expires_at":9999999999}');
        return;
      }
      if (req.method === "POST" && req.url === "/auth/logout") {
        logoutCookie = req.headers.cookie || "";
        res.writeHead(302, {
          Location: "/hermes/login",
          "Set-Cookie": [
            "__Secure-hermes_session_at=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/hermes",
            "__Secure-hermes_session_rt=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/hermes",
            "unrelated_cookie=; Max-Age=0; Path=/",
          ],
        });
        res.end();
        return;
      }
      res.writeHead(401).end();
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.listening ? close(upstream) : undefined);
  const officePort = await startOffice(t, upstreamPort);

  const alternateHost = await request({ port: officePort, path: "/login?next=%2Fchat", headers: { Host: "office.example.com" } });
  assert.equal(alternateHost.status, 308);
  assert.equal(alternateHost.headers.location, "https://office.test/login?next=%2Fchat");
  const wrongHostPost = await request({ port: officePort, method: "POST", path: "/login", headers: { Host: "office.example.com" } });
  assert.equal(wrongHostPost.status, 421);
  const malformedUpgrade = await rawRequest(officePort, "GET /hermes/api/ws HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  assert.match(malformedUpgrade, /^HTTP\/1\.1 421 Misdirected Request/m);
  const malformedHttp = await rawRequest(officePort, "GET http://[ HTTP/1.1\r\nHost: office.test\r\nConnection: close\r\n\r\n");
  assert.match(malformedHttp, /^HTTP\/1\.1 400 /m);
  const afterMalformedUpgrade = await request({ port: officePort, path: "/login" });
  assert.equal(afterMalformedUpgrade.status, 200);

  const malformedCookie = await request({
    port: officePort,
    path: "/",
    headers: { Cookie: "hermes_office_sid=%" },
  });
  assert.equal(malformedCookie.status, 302);
  assert.equal(malformedCookie.headers.location, "/login");
  const stillAlive = await request({ port: officePort, path: "/login" });
  assert.equal(stillAlive.status, 200);

  const wrongBody = new URLSearchParams({ user: "office-user", password: "office-pass", hermes_user: "hermes-user", hermes_password: "wrong" }).toString();
  const wrong = await request({ port: officePort, method: "POST", path: "/login", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(wrongBody) }, body: wrongBody });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["set-cookie"], undefined);
  assert.match(wrong.body, /Hermes 아이디 또는 비밀번호/);

  const correctBody = new URLSearchParams({ user: "office-user", password: "office-pass", hermes_user: "hermes-user", hermes_password: "hermes-pass", next: "/?view=chat" }).toString();
  const correct = await request({ port: officePort, method: "POST", path: "/login", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(correctBody) }, body: correctBody });
  assert.equal(correct.status, 302);
  assert.equal(correct.headers.location, "/?view=chat");
  assert.equal(correct.headers["set-cookie"].some((cookie) => cookie.startsWith("hermes_office_sid=")), true);
  assert.equal(correct.headers["set-cookie"].filter((cookie) => cookie.includes("hermes_session_")).length, 3);
  assert.equal(correct.headers["set-cookie"].filter((cookie) => cookie.includes("hermes_session_")).every((cookie) => cookie.includes("Path=/hermes")), true);
  const cookieHeader = correct.headers["set-cookie"].map((cookie) => cookie.split(";", 1)[0]).join("; ");

  for (const unsafeNext of ["/\\evil.test", "//evil.test/path", "/ok\r\nX-Test: injected", "/%5cevil.test"]) {
    const unsafeBody = new URLSearchParams({
      user: "office-user",
      password: "office-pass",
      hermes_user: "hermes-user",
      hermes_password: "hermes-pass",
      next: unsafeNext,
    }).toString();
    const unsafeRedirect = await request({
      port: officePort,
      method: "POST",
      path: "/login",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(unsafeBody) },
      body: unsafeBody,
    });
    assert.equal(unsafeRedirect.status, 302);
    assert.equal(unsafeRedirect.headers.location, "/");
  }

  const normalizedBody = new URLSearchParams({
    user: "office-user",
    password: "office-pass",
    hermes_user: "hermes-user",
    hermes_password: "hermes-pass",
    next: "/chat/../?view=team",
  }).toString();
  const normalizedRedirect = await request({
    port: officePort,
    method: "POST",
    path: "/login",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(normalizedBody) },
    body: normalizedBody,
  });
  assert.equal(normalizedRedirect.status, 302);
  assert.equal(normalizedRedirect.headers.location, "/?view=team");

  const logoutRedirect = await request({ port: officePort, path: "/logout", headers: { Cookie: cookieHeader } });
  assert.equal(logoutRedirect.status, 302);
  assert.equal(logoutRedirect.headers.location, "/hermes/logout");
  const logout = await request({ port: officePort, path: "/hermes/logout", headers: { Cookie: cookieHeader } });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.location, "/login");
  assert.equal(logout.headers["set-cookie"].some((cookie) => cookie.startsWith("hermes_office_sid=") && cookie.includes("Max-Age=0")), true);
  const authDeletions = logout.headers["set-cookie"].filter((cookie) => cookie.includes("hermes_session_") || cookie.includes("hermes_sso_attempt"));
  assert.equal(authDeletions.length, 12);
  assert.equal(authDeletions.every((cookie) => cookie.includes("Max-Age=0") && cookie.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT") && cookie.includes("Path=/hermes")), true);
  assert.equal(logout.headers["set-cookie"].some((cookie) => cookie.startsWith("unrelated_cookie=")), false);
  assert.match(logoutCookie, /hermes_session_at=/);
  assert.match(logoutCookie, /hermes_session_rt=refresh/);
  assert.doesNotMatch(logoutCookie, /hermes_office_sid/);

  await close(upstream);
  const offlineLogout = await request({ port: officePort, path: "/hermes/logout", headers: { Cookie: cookieHeader } });
  assert.equal(offlineLogout.status, 302);
  assert.equal(offlineLogout.headers.location, "/login");
  assert.equal(offlineLogout.headers["set-cookie"].filter((cookie) => cookie.includes("hermes_session_") || cookie.includes("hermes_sso_attempt")).length, 12);
});

function createLoginUpstream({ delayMs = 0 } = {}) {
  return http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = () => {
        if (req.method === "POST" && req.url === "/auth/password-login") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": "__Secure-hermes_session_at=access; HttpOnly; Secure; SameSite=Lax; Path=/hermes",
          });
          res.end('{"ok":true}');
          return;
        }
        if (req.method === "GET" && req.url === "/api/auth/me") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"user_id":"hermes-user","provider":"basic"}');
          return;
        }
        res.writeHead(404).end();
      };
      if (delayMs) setTimeout(reply, delayMs);
      else reply();
    });
  });
}

function loginForm(overrides = {}) {
  return new URLSearchParams({
    user: "office-user",
    password: "office-pass",
    hermes_user: "hermes-user",
    hermes_password: "hermes-pass",
    ...overrides,
  }).toString();
}

function postLogin(port, overrides = {}) {
  const body = loginForm(overrides);
  return request({
    port,
    method: "POST",
    path: "/login",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body,
  });
}

test("login rate limits reset the exact IP and username key after success", async (t) => {
  const upstream = createLoginUpstream();
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const officePort = await startOffice(t, upstreamPort, {
    LOGIN_RATE_MAX_PER_KEY: "2",
    LOGIN_RATE_MAX_PER_IP: "20",
    LOGIN_RATE_GLOBAL_MAX: "20",
  });

  assert.equal((await postLogin(officePort)).status, 302);
  assert.equal((await postLogin(officePort, { password: "wrong" })).status, 401);
  assert.equal((await postLogin(officePort, { password: "wrong" })).status, 401);
  const limited = await postLogin(officePort, { password: "wrong" });
  assert.equal(limited.status, 429);
  assert.match(String(limited.headers["retry-after"]), /^\d+$/);
});

test("login global budget stops distributed username bypass", async (t) => {
  const upstream = createLoginUpstream();
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const officePort = await startOffice(t, upstreamPort, {
    LOGIN_RATE_MAX_PER_KEY: "10",
    LOGIN_RATE_MAX_PER_IP: "10",
    LOGIN_RATE_GLOBAL_MAX: "3",
  });

  assert.equal((await postLogin(officePort, { user: "unknown-1" })).status, 401);
  assert.equal((await postLogin(officePort, { user: "unknown-2" })).status, 401);
  assert.equal((await postLogin(officePort, { user: "unknown-3" })).status, 401);
  const limited = await postLogin(officePort, { user: "unknown-4" });
  assert.equal(limited.status, 429);
  assert.match(String(limited.headers["retry-after"]), /^\d+$/);
});

test("async scrypt concurrency is bounded", async (t) => {
  const upstream = createLoginUpstream({ delayMs: 25 });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const officePort = await startOffice(t, upstreamPort, {
    LOGIN_RATE_MAX_PER_KEY: "10",
    LOGIN_RATE_MAX_PER_IP: "20",
    LOGIN_RATE_GLOBAL_MAX: "20",
    LOGIN_SCRYPT_CONCURRENCY: "1",
  });

  const responses = await Promise.all([postLogin(officePort), postLogin(officePort)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [302, 429]);
  assert.equal(responses.find((response) => response.status === 429).headers["retry-after"], "1");
});
