import http from "node:http";
import https from "node:https";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PUBLIC_ROUTES = new Map([
  ["GET /integrations/instagram/oauth/callback", "/integrations/instagram/oauth/callback"],
  ["GET /integrations/instagram/webhook", "/integrations/instagram/webhook"],
  ["POST /integrations/instagram/webhook", "/integrations/instagram/webhook"],
]);

const ADMIN_ROUTES = new Map([
  ["GET /bridge/instagram/status", "/admin/status"],
  ["POST /bridge/instagram/connect", "/admin/connect"],
  ["POST /bridge/instagram/refresh", "/admin/refresh"],
]);

const PUBLIC_PATHS = new Map([
  ["/integrations/instagram/oauth/callback", ["GET"]],
  ["/integrations/instagram/webhook", ["GET", "POST"]],
]);

const ADMIN_PATHS = new Map([
  ["/bridge/instagram/status", ["GET"]],
  ["/bridge/instagram/connect", ["POST"]],
  ["/bridge/instagram/refresh", ["POST"]],
]);

export function resolveInstagramProxyRoute(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const key = `${normalizedMethod} ${pathname}`;
  if (PUBLIC_ROUTES.has(key)) {
    return { access: "public", targetPath: PUBLIC_ROUTES.get(key) };
  }
  if (PUBLIC_PATHS.has(pathname)) {
    return { access: "public", methodNotAllowed: true, allow: PUBLIC_PATHS.get(pathname) };
  }
  if (ADMIN_ROUTES.has(key)) {
    return { access: "admin", targetPath: ADMIN_ROUTES.get(key) };
  }
  if (ADMIN_PATHS.has(pathname)) {
    return { access: "admin", methodNotAllowed: true, allow: ADMIN_PATHS.get(pathname) };
  }
  const accountMatch = pathname.match(/^\/bridge\/instagram\/accounts\/([^/]+)$/);
  if (accountMatch) {
    if (normalizedMethod !== "DELETE") {
      return { access: "admin", methodNotAllowed: true, allow: ["DELETE"] };
    }
    return { access: "admin", targetPath: `/admin/accounts/${accountMatch[1]}` };
  }
  if (pathname === "/bridge/instagram" || pathname.startsWith("/bridge/instagram/")) {
    return { access: "admin", notFound: true };
  }
  return null;
}

function sanitizedRequestHeaders(headers, target, adminToken = "") {
  const result = {};
  const connectionHeaders = new Set(String(headers.connection || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean));
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || connectionHeaders.has(name) || name === "host" || name === "authorization" || name === "cookie") continue;
    if (value !== undefined) result[name] = value;
  }
  result.host = target.host;
  if (adminToken) result.authorization = `Bearer ${adminToken}`;
  return result;
}

function sanitizedResponseHeaders(headers) {
  const result = {};
  const connectionHeaders = new Set(String(headers.connection || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean));
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || connectionHeaders.has(name) || name === "set-cookie") continue;
    if (value !== undefined) result[name] = value;
  }
  result["cache-control"] = "no-store";
  result["x-content-type-options"] = "nosniff";
  return result;
}

export function proxyInstagramRequest(request, response, {
  target,
  targetPath,
  search = "",
  adminToken = "",
  timeoutMs = 30000,
} = {}) {
  if (!(target instanceof URL) || !["http:", "https:"].includes(target.protocol)) {
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Instagram bridge is not configured" }));
    return null;
  }
  const transport = target.protocol === "https:" ? https : http;
  const upstreamPath = `${target.pathname.replace(/\/$/, "")}${targetPath}${search}` || "/";
  const proxy = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: request.method,
    path: upstreamPath,
    headers: sanitizedRequestHeaders(request.headers, target, adminToken),
  }, (upstream) => {
    response.writeHead(upstream.statusCode || 502, sanitizedResponseHeaders(upstream.headers));
    upstream.pipe(response);
  });
  proxy.setTimeout(timeoutMs, () => proxy.destroy(new Error("Instagram bridge timed out")));
  request.on("aborted", () => proxy.destroy());
  proxy.on("error", (error) => {
    console.error(`[instagram-bridge] ${request.method} ${targetPath} failed: ${error.message}`);
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "Instagram bridge unavailable" }));
    } else {
      response.destroy(error);
    }
  });
  request.pipe(proxy);
  return proxy;
}
