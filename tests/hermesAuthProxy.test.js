import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildHermesRequestHeaders,
  buildHermesWebSocketHeaders,
  createLegacyHermesAuth,
  extractLegacyHermesSessionToken,
  hermesCookieHeader,
  loginHermesPassword,
  legacyHermesWebSocketPath,
  proxyHermesHttp,
  sanitizeHermesDashboardHtml,
  scopeHermesSetCookie,
} from "../hermesProxy.js";

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
    const outgoing = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    if (body.length) outgoing.write(body);
    outgoing.end();
  });
}

test("legacy Hermes token remains server-side, is read back, cached and cannot be overridden by the browser", async (t) => {
  const token = "legacy-server-token-1234567890";
  const observed = [];
  const upstream = http.createServer((req, res) => {
    observed.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<script>window.__HERMES_SESSION_TOKEN__ = "${token}";</script>`);
      return;
    }
    if (req.url === "/api/version" && req.headers.authorization === `Bearer ${token}`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"version":"0.16.0"}');
      return;
    }
    res.writeHead(401).end();
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const broker = createLegacyHermesAuth({ target: new URL(`http://127.0.0.1:${port}`), publicOrigin: "http://office.test", ttlMs: 15000 });
  const fakeRequest = { headers: { host: "office.test" }, socket: { remoteAddress: "127.0.0.1" } };
  const authorization = await broker.resolveAuthorization(fakeRequest);
  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(observed.length, 2);
  assert.equal(await broker.resolveAuthorization(fakeRequest), authorization);
  assert.equal(observed.length, 2, "a short cache avoids scraping the SPA on every request");
  assert.equal(await broker.resolveAuthorization(fakeRequest, { forceRefresh: true }), authorization);
  assert.equal(observed.length, 4, "login forces a fresh bootstrap and authorization readback");
  const headers = buildHermesRequestHeaders({ authorization: "Bearer browser-token" }, {
    publicOrigin: "http://office.test", request: fakeRequest, serverAuthorization: authorization,
  });
  assert.equal(headers.authorization, authorization);
  assert.equal(JSON.stringify(headers).includes(token), true, "the token exists only in the upstream header object");
  assert.equal(extractLegacyHermesSessionToken(`<script>__HERMES_SESSION_TOKEN__="${token}"</script>`), token);
  assert.equal(extractLegacyHermesSessionToken('<script>__HERMES_SESSION_TOKEN__="short"</script>'), "");
  assert.equal(buildHermesWebSocketHeaders({ ...fakeRequest, headers: { authorization: "Bearer browser-token" } }, {
    publicOrigin: "http://office.test", serverAuthorization: authorization,
  }).authorization, authorization);
  assert.equal(
    legacyHermesWebSocketPath("/api/pty?attach=abc&token=browser&ticket=browser&internal=browser", authorization),
    `/api/pty?attach=abc&token=${token}`,
  );
  broker.invalidate();
  assert.equal(await broker.resolveAuthorization(fakeRequest), authorization);
  assert.equal(observed.length, 6, "an invalidated authorization is never reused");
});

test("legacy Hermes token broker fails closed on an unverified or HTML readback", async (t) => {
  const token = "legacy-server-token-1234567890";
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": req.url === "/chat" ? "text/html" : "text/html" });
    res.end(req.url === "/chat"
      ? `<script>__HERMES_SESSION_TOKEN__="${token}"</script>`
      : "<html>SPA fallback</html>");
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const broker = createLegacyHermesAuth({ target: new URL(`http://127.0.0.1:${port}`), publicOrigin: "http://office.test" });
  await assert.rejects(() => broker.resolveAuthorization({ headers: {}, socket: {} }), /readback failed/);
});

test("legacy Hermes auth falls back from version 404 to a bounded semantic config readback", async (t) => {
  const token = "legacy-config-fallback-token-12345";
  const observed = [];
  const upstream = http.createServer((req, res) => {
    observed.push({ url: req.url, authorization: req.headers.authorization || "" });
    if (req.url === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<script>__HERMES_SESSION_TOKEN__="${token}"</script>`);
      return;
    }
    if (req.url === "/api/version") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"detail":"Not Found"}');
      return;
    }
    if (req.url === "/api/config" && req.headers.authorization === `Bearer ${token}`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"model":{},"providers":[],"agent":{},"unrelated":"ignored"}');
      return;
    }
    res.writeHead(401).end();
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const broker = createLegacyHermesAuth({ target: new URL(`http://127.0.0.1:${port}`), publicOrigin: "http://office.test" });
  assert.equal(await broker.resolveAuthorization({ headers: {}, socket: {} }), `Bearer ${token}`);
  assert.deepEqual(observed.map((entry) => entry.url), ["/chat", "/api/version", "/api/config"]);
  assert.equal(observed[2].authorization, `Bearer ${token}`);
});

test("legacy Hermes auth never falls back on 401 or accepts a weak config shape", async () => {
  const token = "legacy-config-reject-token-123456";
  for (const scenario of ["unauthorized", "weak-config"]) {
    const paths = [];
    const upstream = http.createServer((req, res) => {
      paths.push(req.url);
      if (req.url === "/chat") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<script>__HERMES_SESSION_TOKEN__="${token}"</script>`);
        return;
      }
      if (req.url === "/api/version") {
        res.writeHead(scenario === "unauthorized" ? 401 : 404, { "Content-Type": "application/json" });
        res.end('{"detail":"no"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"model":{},"providers":[]}');
    });
    const port = await listen(upstream);
    const broker = createLegacyHermesAuth({ target: new URL(`http://127.0.0.1:${port}`), publicOrigin: "http://office.test" });
    await assert.rejects(() => broker.resolveAuthorization({ headers: {}, socket: {} }), /readback failed/);
    await close(upstream);
    assert.deepEqual(paths, scenario === "unauthorized" ? ["/chat", "/api/version"] : ["/chat", "/api/version", "/api/config"]);
  }
});

test("legacy HTTP relay injects only server authorization and invalidates it on upstream 401", async (t) => {
  let upstreamAuthorization = "";
  let invalidated = 0;
  const upstream = http.createServer((req, res) => {
    upstreamAuthorization = req.headers.authorization || "";
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"detail":"unauthorized"}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = http.createServer((req, res) => proxyHermesHttp(req, res, {
    target: new URL(`http://127.0.0.1:${upstreamPort}`),
    publicOrigin: "http://office.test",
    serverAuthorization: "Bearer server-only-token",
    onUnauthorized: () => { invalidated += 1; },
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const response = await request({ port: proxyPort, path: "/hermes/api/version", headers: { authorization: "Bearer browser-token" } });
  assert.equal(response.status, 401);
  assert.equal(upstreamAuthorization, "Bearer server-only-token");
  assert.equal(invalidated, 1);
  assert.equal(response.body.includes("server-only-token"), false);
});

test("legacy HTTP relay never forwards an HTML bootstrap containing the server token", async (t) => {
  const token = "legacy-server-token-never-exposed";
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<script>__HERMES_SESSION_TOKEN__="${token}"</script>`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = http.createServer((req, res) => proxyHermesHttp(req, res, {
    target: new URL(`http://127.0.0.1:${upstreamPort}`),
    publicOrigin: "http://office.test",
    serverAuthorization: `Bearer ${token}`,
    blockHtmlResponses: true,
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const response = await request({ port: proxyPort, path: "/hermes/chat" });
  assert.equal(response.status, 404);
  assert.equal(response.body.includes("__HERMES_SESSION_TOKEN__"), false);
  assert.equal(response.body.includes(token), false);
});

test("dashboard HTML relay removes the legacy token and switches the SPA to ticket auth", async (t) => {
  const token = "legacy-server-token-never-exposed";
  let forwardedPrefix = "";
  const upstream = http.createServer((req, res) => {
    forwardedPrefix = req.headers["x-forwarded-prefix"] || "";
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      ETag: '"upstream-token-bearing-html"',
    });
    res.end(
      `<html><head><script>window.__HERMES_SESSION_TOKEN__="${token}";`
      + "window.__HERMES_BASE_PATH__=\"/hermes\";"
      + "window.__HERMES_AUTH_REQUIRED__=false;</script></head><body>dashboard</body></html>",
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = http.createServer((req, res) => proxyHermesHttp(req, res, {
    target: new URL(`http://127.0.0.1:${upstreamPort}`),
    publicOrigin: "https://office.test",
    serverAuthorization: `Bearer ${token}`,
    allowSanitizedDashboardHtml: true,
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await request({ port: proxyPort, path: "/hermes/chat" });
  const html = response.body.toString("utf8");
  assert.equal(response.status, 200);
  assert.equal(forwardedPrefix, "/hermes");
  assert.equal(html.includes(token), false);
  assert.match(html, /window\.__HERMES_SESSION_TOKEN__=""/);
  assert.match(html, /window\.__HERMES_AUTH_REQUIRED__=true/);
  assert.match(html, /window\.__HERMES_BASE_PATH__="\/hermes"/);
  assert.equal(response.headers.etag, undefined);
  assert.equal(Number(response.headers["content-length"]), response.body.length);
});

test("dashboard sanitizer injects ticket auth when an older bootstrap omits the auth flag", () => {
  const html = sanitizeHermesDashboardHtml(
    '<html><head><script>__HERMES_SESSION_TOKEN__="server-secret-value"</script></head><body></body></html>',
  );
  assert.equal(html.includes("server-secret-value"), false);
  assert.match(html, /window\.__HERMES_SESSION_TOKEN__=""/);
  assert.match(html, /window\.__HERMES_AUTH_REQUIRED__=true/);
});

test("forwarded auth headers are replaced and only Hermes cookies reach upstream", () => {
  const fakeRequest = { headers: { host: "office.example.test" }, socket: { remoteAddress: "203.0.113.8" } };
  const headers = buildHermesRequestHeaders({
    host: "attacker.test",
    origin: "https://attacker.test",
    authorization: "Bearer reusable-secret",
    "x-hermes-session-token": "legacy-secret",
    "x-forwarded-host": "attacker.test",
    "x-forwarded-prefix": "/evil",
    "x-forwarded-proto": "http",
    forwarded: "host=attacker.test",
    cookie: "hermes_office_sid=office; __Secure-hermes_session_at=access; unrelated=secret; hermes_session_rt=refresh",
    connection: "x-hop",
    "x-hop": "drop-me",
    accept: "application/json",
  }, { publicOrigin: "https://office.example.test", request: fakeRequest });

  assert.equal(headers.host, "office.example.test");
  assert.equal(headers.origin, "https://office.example.test");
  assert.equal(headers["x-forwarded-host"], "office.example.test");
  assert.equal(headers["x-forwarded-prefix"], "/hermes");
  assert.equal(headers["x-forwarded-proto"], "https");
  assert.equal(headers["x-forwarded-for"], "203.0.113.8");
  assert.equal(headers.cookie, "__Secure-hermes_session_at=access; hermes_session_rt=refresh");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-hermes-session-token"], undefined);
  assert.equal(headers["x-hop"], undefined);
  assert.equal(hermesCookieHeader("hermes_office_sid=x; unrelated=y"), "");
});

test("cookie scoping removes Domain, enforces /hermes and preserves independent cookies", () => {
  const access = scopeHermesSetCookie("__Secure-hermes_session_at=at; Path=/; Domain=internal.test; SameSite=Lax; HttpOnly; Secure");
  const refresh = scopeHermesSetCookie("__Secure-hermes_session_rt=rt; Max-Age=3600; Path=/");
  assert.match(access, /^__Secure-hermes_session_at=at;/);
  assert.match(access, /Path=\/hermes/);
  assert.doesNotMatch(access, /Domain=/i);
  assert.match(refresh, /Path=\/hermes/);
  assert.match(refresh, /HttpOnly/);
  assert.match(refresh, /Secure/);
});

test("official password login requires identity readback and relays multiple refreshed cookies", async (t) => {
  const observed = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      observed.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/auth/password-login") {
        const payload = JSON.parse(observed.at(-1).body);
        if (payload.password !== "correct") {
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
      if (req.url === "/api/auth/me" && req.headers.cookie?.includes("hermes_session_at=access")) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "__Secure-hermes_session_at=rotated; HttpOnly; Secure; SameSite=Lax; Path=/hermes",
        });
        res.end('{"user_id":"dave","provider":"basic","expires_at":9999999999}');
        return;
      }
      res.writeHead(401).end();
    });
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const target = new URL(`http://127.0.0.1:${port}`);
  const fakeRequest = { headers: { host: "office.test", "user-agent": "test" }, socket: { remoteAddress: "127.0.0.1" } };

  const failed = await loginHermesPassword({ target, publicOrigin: "https://office.test", provider: "basic", username: "dave", password: "wrong", request: fakeRequest });
  assert.equal(failed.status, 401);
  assert.equal(failed.identity, null);

  const success = await loginHermesPassword({ target, publicOrigin: "https://office.test", provider: "basic", username: "dave", password: "correct", request: fakeRequest });
  assert.equal(success.status, 200);
  assert.equal(success.readbackStatus, 200);
  assert.equal(success.identity.user_id, "dave");
  assert.equal(success.cookies.length, 3);
  assert.equal(success.cookies.every((cookie) => cookie.includes("Path=/hermes")), true);
  assert.equal(observed.filter((entry) => entry.url === "/api/auth/me").length, 1);
  assert.equal(observed[1].headers["x-forwarded-prefix"], "/hermes");
  assert.equal(observed[1].headers["x-forwarded-proto"], "https");
});

test("HTTP proxy relays multiple cookies, prefix and refresh without leaking Office credentials", async (t) => {
  let observed;
  const upstream = http.createServer((req, res) => {
    observed = { url: req.url, headers: req.headers };
    res.writeHead(302, {
      Location: "/login",
      "Set-Cookie": [
        "__Secure-hermes_session_at=new-access; HttpOnly; Secure; Path=/; SameSite=Lax",
        "__Secure-hermes_session_rt=new-refresh; HttpOnly; Secure; Path=/; SameSite=Lax",
      ],
    });
    res.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const proxy = http.createServer((req, res) => proxyHermesHttp(req, res, {
    target: new URL(`http://127.0.0.1:${upstreamPort}`),
    publicOrigin: "https://office.test",
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const result = await request({
    port: proxyPort,
    path: "/hermes/api/auth/me",
    headers: {
      Host: "office.test",
      Cookie: "hermes_office_sid=office-secret; __Secure-hermes_session_at=old-access",
      Authorization: "Bearer must-not-leak",
      "X-Hermes-Session-Token": "legacy-must-not-leak",
      "X-Forwarded-Prefix": "/evil",
    },
  });

  assert.equal(result.status, 302);
  assert.equal(result.headers.location, "/hermes/login");
  assert.equal(result.headers["set-cookie"].length, 2);
  assert.equal(result.headers["set-cookie"].every((cookie) => cookie.includes("Path=/hermes")), true);
  assert.equal(observed.url, "/api/auth/me");
  assert.equal(observed.headers.cookie, "__Secure-hermes_session_at=old-access");
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.headers["x-hermes-session-token"], undefined);
  assert.equal(observed.headers["x-forwarded-prefix"], "/hermes");
});

test("mocked upstream mints a ticket and rejects replay; proxy never substitutes a reusable token", async (t) => {
  const consumed = new Set();
  const upstream = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/ws-ticket" && req.headers.cookie?.includes("hermes_session_at=access")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ticket":"single-use-1","ttl_seconds":30}');
      return;
    }
    const url = new URL(req.url, "http://upstream.test");
    if (url.pathname === "/api/ws-ticket-check") {
      const ticket = url.searchParams.get("ticket");
      if (!ticket || consumed.has(ticket)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"detail":"invalid or consumed ticket"}');
        return;
      }
      consumed.add(ticket);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(401).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = http.createServer((req, res) => proxyHermesHttp(req, res, {
    target: new URL(`http://127.0.0.1:${upstreamPort}`),
    publicOrigin: "https://office.test",
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const headers = { Cookie: "__Secure-hermes_session_at=access; hermes_office_sid=office" };

  const minted = await request({ port: proxyPort, method: "POST", path: "/hermes/api/auth/ws-ticket", headers });
  const payload = JSON.parse(minted.body.toString("utf8"));
  assert.deepEqual(payload, { ticket: "single-use-1", ttl_seconds: 30 });
  assert.equal(minted.body.includes("access"), false);
  const first = await request({ port: proxyPort, path: `/hermes/api/ws-ticket-check?ticket=${payload.ticket}`, headers });
  const replay = await request({ port: proxyPort, path: `/hermes/api/ws-ticket-check?ticket=${payload.ticket}`, headers });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 401);
});
