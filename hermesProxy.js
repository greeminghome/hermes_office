import http from "node:http";
import https from "node:https";

const PREFIX = "/hermes";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PRIVATE_REQUEST_HEADERS = new Set([
  "authorization",
  "x-hermes-session-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-forwarded-proto",
  "forwarded",
  "host",
  "origin",
]);

function publicUrl(publicOrigin, request) {
  if (publicOrigin) return new URL(publicOrigin);
  const proto = request?.socket?.encrypted ? "https:" : "http:";
  return new URL(`${proto}//${request?.headers?.host || "localhost"}`);
}

function connectionTokens(headers = {}) {
  return new Set(String(headers.connection || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

export function hermesCookieHeader(rawCookie = "") {
  return String(rawCookie)
    .split(";")
    .map((value) => value.trim())
    .filter((value) => {
      const name = value.split("=", 1)[0];
      return /^(?:__Host-|__Secure-)?hermes_(?:session_|sso_)/.test(name);
    })
    .join("; ");
}

export function buildHermesRequestHeaders(headers = {}, {
  publicOrigin = "",
  request,
  contentLength,
  serverAuthorization = "",
} = {}) {
  const url = publicUrl(publicOrigin, request);
  const nominated = connectionTokens(headers);
  const output = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value == null || HOP_BY_HOP.has(name) || PRIVATE_REQUEST_HEADERS.has(name) || nominated.has(name) || name === "cookie") continue;
    output[name] = value;
  }
  const cookies = hermesCookieHeader(headers.cookie);
  if (cookies) output.cookie = cookies;
  if (contentLength != null) output["content-length"] = String(contentLength);
  output.host = url.host;
  output.origin = url.origin;
  output["x-forwarded-host"] = url.host;
  output["x-forwarded-prefix"] = PREFIX;
  output["x-forwarded-proto"] = url.protocol.slice(0, -1);
  if (request?.socket?.remoteAddress) output["x-forwarded-for"] = request.socket.remoteAddress;
  if (serverAuthorization) output.authorization = serverAuthorization;
  return output;
}

export function upstreamSetCookies(upstream) {
  if (Array.isArray(upstream?.headers?.["set-cookie"])) return upstream.headers["set-cookie"];
  const values = [];
  for (let index = 0; index < (upstream?.rawHeaders?.length || 0); index += 2) {
    if (String(upstream.rawHeaders[index]).toLowerCase() === "set-cookie") values.push(upstream.rawHeaders[index + 1]);
  }
  return values;
}

export function scopeHermesSetCookie(value, { secure = true } = {}) {
  const parts = String(value).split(";").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  const attributes = parts.slice(1).filter((part) => !/^domain=/i.test(part) && !/^path=/i.test(part));
  attributes.push(`Path=${PREFIX}`);
  const name = parts[0].split("=", 1)[0];
  if (/hermes_(?:session_|sso_)/.test(name) && !attributes.some((part) => /^httponly$/i.test(part))) attributes.push("HttpOnly");
  if (secure && !attributes.some((part) => /^secure$/i.test(part))) attributes.push("Secure");
  return [parts[0], ...attributes].join("; ");
}

function responseHeaders(upstream, { publicOrigin = "", transformedBody = false } = {}) {
  const output = {};
  const nominated = connectionTokens(upstream.headers);
  for (const [rawName, value] of Object.entries(upstream.headers)) {
    const name = rawName.toLowerCase();
    if (
      value == null
      || name === "set-cookie"
      || name === "location"
      || HOP_BY_HOP.has(name)
      || nominated.has(name)
      || (transformedBody && ["content-encoding", "content-length", "etag"].includes(name))
    ) continue;
    output[name] = value;
  }
  const cookies = upstreamSetCookies(upstream)
    .map((value) => scopeHermesSetCookie(value, { secure: String(publicOrigin).startsWith("https://") }))
    .filter(Boolean);
  if (cookies.length) output["set-cookie"] = cookies;
  const location = upstream.headers.location;
  if (location) output.location = location.startsWith("/") && !location.startsWith(`${PREFIX}/`) ? `${PREFIX}${location}` : location;
  return output;
}

export function sanitizeHermesDashboardHtml(html = "") {
  let source = String(html);
  source = source.replace(
    /(window\.)?__HERMES_SESSION_TOKEN__\s*=\s*(["'])[^"'\\]*\2/g,
    'window.__HERMES_SESSION_TOKEN__=""',
  );
  if (/window\.__HERMES_AUTH_REQUIRED__\s*=/.test(source)) {
    source = source.replace(
      /window\.__HERMES_AUTH_REQUIRED__\s*=\s*(?:true|false)/g,
      "window.__HERMES_AUTH_REQUIRED__=true",
    );
  } else {
    const authBootstrap = "<script>window.__HERMES_SESSION_TOKEN__=\"\";window.__HERMES_AUTH_REQUIRED__=true;</script>";
    source = source.includes("</head>")
      ? source.replace("</head>", `${authBootstrap}</head>`)
      : `${authBootstrap}${source}`;
  }
  return source;
}

function clientFor(target) {
  return target.protocol === "https:" ? https : http;
}

export function proxyHermesHttp(request, response, {
  target,
  publicOrigin = "",
  timeoutMs = 30000,
  serverAuthorization = "",
  onUnauthorized,
  blockHtmlResponses = false,
  allowSanitizedDashboardHtml = false,
} = {}) {
  const targetPath = request.url.replace(/^\/hermes/, "") || "/";
  const headers = buildHermesRequestHeaders(request.headers, { publicOrigin, request, serverAuthorization });
  if (allowSanitizedDashboardHtml) headers["accept-encoding"] = "identity";
  const upstreamRequest = clientFor(target).request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: targetPath,
    headers,
  }, (upstream) => {
    if (upstream.statusCode === 401) onUnauthorized?.();
    const contentType = String(upstream.headers["content-type"] || "").toLowerCase();
    if (blockHtmlResponses && (contentType.includes("text/html") || contentType.includes("application/xhtml"))) {
      upstream.resume();
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (allowSanitizedDashboardHtml && (contentType.includes("text/html") || contentType.includes("application/xhtml"))) {
      const chunks = [];
      let size = 0;
      upstream.on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          upstream.destroy(new Error("Hermes dashboard HTML exceeded the relay limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      upstream.on("end", () => {
        const body = Buffer.from(sanitizeHermesDashboardHtml(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(upstream.statusCode || 502, {
          ...responseHeaders(upstream, { publicOrigin, transformedBody: true }),
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Content-Length": String(body.length),
        });
        if (request.method === "HEAD") response.end();
        else response.end(body);
      });
      upstream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "Hermes dashboard unavailable" }));
        } else response.destroy();
      });
      return;
    }
    response.writeHead(upstream.statusCode || 502, responseHeaders(upstream, { publicOrigin }));
    upstream.pipe(response);
  });
  upstreamRequest.setTimeout(timeoutMs, () => upstreamRequest.destroy(new Error("Hermes upstream timed out")));
  request.on("aborted", () => upstreamRequest.destroy());
  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "Hermes upstream unavailable" }));
    } else response.destroy();
  });
  request.pipe(upstreamRequest);
}

export function requestHermes({
  target,
  method = "GET",
  path = "/",
  headers = {},
  body = Buffer.alloc(0),
  publicOrigin = "",
  timeoutMs = 10000,
  request,
  serverAuthorization = "",
}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const requestHeaders = buildHermesRequestHeaders(headers, {
    publicOrigin,
    request,
    contentLength: payload.length,
    serverAuthorization,
  });
  return new Promise((resolve, reject) => {
    const upstreamRequest = clientFor(target).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method,
      path,
      headers: requestHeaders,
    }, (upstream) => {
      const chunks = [];
      upstream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      upstream.on("end", () => resolve({
        status: upstream.statusCode || 502,
        headers: responseHeaders(upstream, { publicOrigin }),
        cookies: upstreamSetCookies(upstream).map((value) => scopeHermesSetCookie(value, { secure: String(publicOrigin).startsWith("https://") })),
        body: Buffer.concat(chunks),
      }));
    });
    upstreamRequest.setTimeout(timeoutMs, () => upstreamRequest.destroy(new Error("Hermes upstream timed out")));
    upstreamRequest.on("error", reject);
    if (payload.length) upstreamRequest.write(payload);
    upstreamRequest.end();
  });
}

export function cookieHeaderFromSetCookies(cookies = []) {
  return cookies.map((cookie) => String(cookie).split(";", 1)[0]).filter(Boolean).join("; ");
}

export async function loginHermesPassword({ target, publicOrigin, provider, username, password, request, timeoutMs }) {
  const body = Buffer.from(JSON.stringify({ provider, username, password, next: "/" }));
  const login = await requestHermes({
    target,
    method: "POST",
    path: "/auth/password-login",
    headers: { "content-type": "application/json", "user-agent": request?.headers?.["user-agent"] || "Hermes Office" },
    body,
    publicOrigin,
    timeoutMs,
    request,
  });
  if (login.status !== 200) return { ...login, identity: null };
  const cookie = cookieHeaderFromSetCookies(login.cookies);
  const readback = await requestHermes({
    target,
    method: "GET",
    path: "/api/auth/me",
    headers: { cookie, accept: "application/json" },
    publicOrigin,
    timeoutMs,
    request,
  });
  let identity = null;
  if (readback.status === 200) {
    try { identity = JSON.parse(readback.body.toString("utf8")); } catch { identity = null; }
  }
  return { ...login, identity, readbackStatus: readback.status, cookies: [...login.cookies, ...(readback.cookies || [])] };
}

export async function logoutHermes({ target, publicOrigin, request, timeoutMs }) {
  return requestHermes({
    target,
    method: "POST",
    path: "/auth/logout",
    headers: { cookie: request?.headers?.cookie || "" },
    publicOrigin,
    timeoutMs,
    request,
  });
}

export function buildHermesWebSocketHeaders(request, { publicOrigin = "", serverAuthorization = "" } = {}) {
  return buildHermesRequestHeaders(request.headers, { publicOrigin, request, serverAuthorization });
}

export function extractLegacyHermesSessionToken(html = "") {
  const source = String(html);
  if (Buffer.byteLength(source, "utf8") > 5 * 1024 * 1024) return "";
  const token = source.match(/__HERMES_SESSION_TOKEN__\s*=\s*["']([^"'\\\s]{16,4096})["']/)?.[1] || "";
  return /^[A-Za-z0-9._~+/-]{16,4096}$/.test(token) ? token : "";
}

export function legacyHermesWebSocketPath(requestPath = "/", serverAuthorization = "") {
  const token = String(serverAuthorization).match(/^Bearer ([A-Za-z0-9._~+/-]{16,4096})$/)?.[1] || "";
  if (!token) throw new Error("legacy Hermes WebSocket authorization unavailable");
  const url = new URL(String(requestPath), "http://legacy-hermes.internal");
  for (const credential of ["token", "ticket", "internal"]) url.searchParams.delete(credential);
  url.searchParams.set("token", token);
  return `${url.pathname}${url.search}`;
}

export function createLegacyHermesAuth({ target, publicOrigin = "", timeoutMs = 10000, ttlMs = 15000 } = {}) {
  let cachedAuthorization = "";
  let expiresAt = 0;
  let resolving = null;

  const resolveAuthorization = async (request, { forceRefresh = false } = {}) => {
    if (!forceRefresh && cachedAuthorization && expiresAt > Date.now()) return cachedAuthorization;
    if (resolving) return resolving;
    resolving = (async () => {
      const chat = await requestHermes({ target, path: "/chat", publicOrigin, timeoutMs, request });
      if (chat.status !== 200) throw new Error("legacy Hermes bootstrap unavailable");
      const token = extractLegacyHermesSessionToken(chat.body.toString("utf8"));
      if (!token) throw new Error("legacy Hermes bootstrap contract unavailable");
      const authorization = `Bearer ${token}`;
      const readback = await requestHermes({
        target,
        path: "/api/version",
        headers: { accept: "application/json" },
        publicOrigin,
        timeoutMs,
        request,
        serverAuthorization: authorization,
      });
      const parseReadbackJson = (response) => {
        if (response.status !== 200 || !response.body.length || response.body.length > 64 * 1024
          || !String(response.headers["content-type"] || "").includes("application/json")) return null;
        try {
          const payload = JSON.parse(response.body.toString("utf8"));
          return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
        } catch {
          return null;
        }
      };
      const versionPayload = parseReadbackJson(readback);
      let recognizedReadback = versionPayload
        && ["version", "api_version", "status"].some((key) => typeof versionPayload[key] === "string" && versionPayload[key]);
      if (!recognizedReadback && readback.status === 404) {
        const configReadback = await requestHermes({
          target,
          path: "/api/config",
          headers: { accept: "application/json" },
          publicOrigin,
          timeoutMs,
          request,
          serverAuthorization: authorization,
        });
        const configPayload = parseReadbackJson(configReadback);
        const expectedKeys = ["model", "providers", "toolsets", "agent", "dashboard"];
        recognizedReadback = configPayload
          && expectedKeys.filter((key) => Object.hasOwn(configPayload, key)).length >= 3;
      }
      if (!recognizedReadback) {
        throw new Error("legacy Hermes authorization readback failed");
      }
      cachedAuthorization = authorization;
      expiresAt = Date.now() + Math.min(Math.max(Number(ttlMs) || 15000, 1000), 60000);
      return authorization;
    })();
    try {
      return await resolving;
    } finally {
      resolving = null;
    }
  };

  return {
    resolveAuthorization,
    invalidate() {
      cachedAuthorization = "";
      expiresAt = 0;
    },
  };
}
