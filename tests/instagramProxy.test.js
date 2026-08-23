import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { proxyInstagramRequest, resolveInstagramProxyRoute } from "../instagramProxy.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request({ port, method = "GET", path = "/", headers = {}, body = Buffer.alloc(0) }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

test("resolver exposes only the exact public and admin contracts", () => {
  assert.deepEqual(resolveInstagramProxyRoute("GET", "/integrations/instagram/oauth/callback"), {
    access: "public",
    targetPath: "/integrations/instagram/oauth/callback",
  });
  assert.deepEqual(resolveInstagramProxyRoute("POST", "/integrations/instagram/webhook"), {
    access: "public",
    targetPath: "/integrations/instagram/webhook",
  });
  assert.equal(resolveInstagramProxyRoute("GET", "/integrations/instagram/webhook/extra"), null);
  assert.deepEqual(resolveInstagramProxyRoute("DELETE", "/bridge/instagram/accounts/1784%2Fencoded"), {
    access: "admin",
    targetPath: "/admin/accounts/1784%2Fencoded",
  });
  assert.deepEqual(resolveInstagramProxyRoute("POST", "/bridge/instagram/status"), {
    access: "admin",
    methodNotAllowed: true,
    allow: ["GET"],
  });
  assert.deepEqual(resolveInstagramProxyRoute("GET", "/bridge/instagram/unknown"), {
    access: "admin",
    notFound: true,
  });
});

test("public webhook preserves raw body, signature, content type and query without forwarding browser credentials", async (t) => {
  let observed;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      observed = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(202, { "Content-Type": "application/json", "Set-Cookie": "should-not-leak=1" });
      res.end('{"accepted":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const gateway = http.createServer((req, res) => {
    proxyInstagramRequest(req, res, {
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
      targetPath: "/integrations/instagram/webhook",
      search: "?hub.mode=subscribe",
    });
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const rawBody = Buffer.from('{\n  "entry": [ { "id": "123" } ]\n}\n', "utf8");
  const result = await request({
    port: gatewayPort,
    method: "POST",
    path: "/integrations/instagram/webhook?hub.mode=subscribe",
    headers: {
      Authorization: "Bearer client-secret",
      Cookie: "hermes_office_sid=client-cookie",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(rawBody.length),
      "X-Hub-Signature": "sha1=legacy",
      "X-Hub-Signature-256": "sha256=official-signature",
      Connection: "x-client-hop",
      "X-Client-Hop": "must-not-reach-upstream",
    },
    body: rawBody,
  });

  assert.equal(result.status, 202);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/integrations/instagram/webhook?hub.mode=subscribe");
  assert.deepEqual(observed.body, rawBody);
  assert.equal(observed.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(observed.headers["x-hub-signature"], "sha1=legacy");
  assert.equal(observed.headers["x-hub-signature-256"], "sha256=official-signature");
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers["x-client-hop"], undefined);
});

test("admin proxy replaces client credentials with the server-side bearer token", async (t) => {
  let observed;
  const upstream = http.createServer((req, res) => {
    observed = { method: req.method, url: req.url, headers: req.headers };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"connected":false}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const gateway = http.createServer((req, res) => {
    proxyInstagramRequest(req, res, {
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
      targetPath: "/admin/status",
      search: "?detail=1",
      adminToken: "server-only-token",
    });
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const result = await request({
    port: gatewayPort,
    path: "/bridge/instagram/status?detail=1",
    headers: {
      Authorization: "Bearer untrusted-client-token",
      Cookie: "hermes_office_sid=browser-cookie",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(observed.method, "GET");
  assert.equal(observed.url, "/admin/status?detail=1");
  assert.equal(observed.headers.authorization, "Bearer server-only-token");
  assert.equal(observed.headers.cookie, undefined);
});

test("admin connect and account delete preserve the scoped contract", async (t) => {
  const observed = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      observed.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const gateway = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gateway.test");
    const route = resolveInstagramProxyRoute(req.method, url.pathname);
    assert.equal(route?.access, "admin");
    proxyInstagramRequest(req, res, {
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
      targetPath: route.targetPath,
      search: url.search,
      adminToken: "scoped-admin-token",
    });
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const connectBody = Buffer.from(JSON.stringify({ profile_id: "hermes-content", redirect_path: "/?view=plugins" }));
  const connect = await request({
    port: gatewayPort,
    method: "POST",
    path: "/bridge/instagram/connect",
    headers: { "Content-Type": "application/json", "Content-Length": String(connectBody.length) },
    body: connectBody,
  });
  const disconnect = await request({
    port: gatewayPort,
    method: "DELETE",
    path: "/bridge/instagram/accounts/1784%2Fencoded?profile_id=hermes-content",
  });

  assert.equal(connect.status, 200);
  assert.equal(disconnect.status, 200);
  assert.deepEqual(observed.map(({ method, url }) => ({ method, url })), [
    { method: "POST", url: "/admin/connect" },
    { method: "DELETE", url: "/admin/accounts/1784%2Fencoded?profile_id=hermes-content" },
  ]);
  assert.equal(observed[0].body, connectBody.toString("utf8"));
  assert.equal(observed[0].headers.authorization, "Bearer scoped-admin-token");
  assert.equal(observed[1].headers.authorization, "Bearer scoped-admin-token");
});

test("proxy failures are logged server-side but return a topology-free client error", async (t) => {
  const unavailable = http.createServer();
  const unavailablePort = await listen(unavailable);
  await close(unavailable);

  const messages = [];
  const originalConsoleError = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  t.after(() => { console.error = originalConsoleError; });

  const gateway = http.createServer((req, res) => {
    proxyInstagramRequest(req, res, {
      target: new URL(`http://127.0.0.1:${unavailablePort}`),
      targetPath: "/admin/status",
      adminToken: "server-token",
      timeoutMs: 500,
    });
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const result = await request({ port: gatewayPort, path: "/bridge/instagram/status" });
  const responseText = result.body.toString("utf8");
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(responseText), { error: "Instagram bridge unavailable" });
  assert.equal(responseText.includes("127.0.0.1"), false);
  assert.equal(responseText.includes(String(unavailablePort)), false);
  assert.equal(messages.length > 0, true);
  assert.equal(messages.some((message) => message.includes("/admin/status")), true);
});
