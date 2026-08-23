import Busboy from "busboy";
import crypto from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { proxyInstagramRequest, resolveInstagramProxyRoute } from "./instagramProxy.js";
import { getGoogleDriveMirrorStatus, startGoogleDriveMirror } from "./googleDriveMirror.js";
import {
  buildHermesWebSocketHeaders,
  createLegacyHermesAuth,
  loginHermesPassword,
  legacyHermesWebSocketPath,
  logoutHermes,
  proxyHermesHttp,
} from "./hermesProxy.js";
import {
  liveScreenEndpointCandidates,
  liveScreenFallbackEndpoint,
  normalizeLiveScreenCdpUrl,
  parseLiveScreenProfileMap,
  selectLiveScreenFallbackPage,
} from "./liveScreenBridge.js";
import {
  LIVE_SCREEN_MAX_CLIENT_MESSAGE_BYTES,
  LiveScreenTicketStore,
  liveScreenOriginMatches,
  sanitizeLiveViewUrl,
  validateLiveScreenScope,
} from "./liveScreenSecurity.js";
import { upgradeLiveScreenConnection } from "./liveScreenRelay.js";
import { ORGANIZATION_VERSION, validateOrganizationNodes } from "./organizationHierarchy.js";
import { authorizeAgentCalendarRequest, parseAgentCalendarQuery } from "./agentCalendarAccess.js";
import {
  connectReservationGoogle,
  getReservationIntegrationStatus,
  reservationGoogleAuthorizationUrl,
  saveReservationGoogleClient,
} from "./reservationIntegrations.js";
import { createReservationSyncController } from "./reservationSync/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const hermesTarget = new URL(process.env.HERMES_TARGET || "http://127.0.0.1:9119");
const instagramBridgeTarget = process.env.INSTAGRAM_BRIDGE_TARGET ? new URL(process.env.INSTAGRAM_BRIDGE_TARGET) : null;
const instagramBridgeAdminToken = process.env.INSTAGRAM_BRIDGE_ADMIN_TOKEN || "";
const publicOrigin = process.env.PUBLIC_ORIGIN || "";
const canonicalOrigin = publicOrigin ? new URL(publicOrigin) : null;
const authUser = process.env.HERMES_OFFICE_USER || "greeming_home";
const authPasswordHash = process.env.HERMES_OFFICE_PASSWORD_HASH || "";
const hermesAuthProvider = process.env.HERMES_AUTH_PROVIDER || "basic";
const hermesAuthMode = process.env.HERMES_AUTH_MODE || "official";
if (!new Set(["official", "legacy-server-token"]).has(hermesAuthMode)) {
  throw new Error("HERMES_AUTH_MODE must be official or legacy-server-token");
}
const sessionSecret = validatedSessionSecret(process.env.HERMES_OFFICE_SESSION_SECRET);
const fileStoreRoot = process.env.FILE_STORE_ROOT || path.join(__dirname, "chat-files");
const agentFileRoot = process.env.AGENT_FILE_ROOT || fileStoreRoot;
const sessionArchivePath = process.env.SESSION_ARCHIVE_PATH || path.join(fileStoreRoot, "session-archive.json");
const pluginStatePath = process.env.PLUGIN_STATE_PATH || path.join(fileStoreRoot, "plugin-state.json");
const organizationStatePath = process.env.ORGANIZATION_STATE_PATH || path.join(fileStoreRoot, "organization-state.json");
const configuredDataRoomRoots = (process.env.DATA_ROOM_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
const dataRoomRoots = [
  ...configuredDataRoomRoots,
  fileStoreRoot,
];
const maxFileSize = 100 * 1024 * 1024;
const dataRoomMaxPreview = 256 * 1024;
const dataRoomMaxFiles = Number(process.env.DATA_ROOM_MAX_FILES || 10000);
const dataRoomListCacheTtlMs = Number(process.env.DATA_ROOM_CACHE_TTL_MS || 15000);
const hermesProxyTimeoutMs = Number(process.env.HERMES_PROXY_TIMEOUT_MS || 30000);
const liveScreenCacheTtlMs = Number(process.env.LIVE_SCREEN_CACHE_TTL_MS || 1200);
const liveScreenTicketTtlMs = positiveInteger(process.env.LIVE_SCREEN_TICKET_TTL_MS, 15000);
const liveScreenConnectionMaxMs = positiveInteger(process.env.LIVE_SCREEN_CONNECTION_MAX_MS, 15 * 60 * 1000);
const loginRateWindowMs = positiveInteger(process.env.LOGIN_RATE_WINDOW_MS, 5 * 60 * 1000);
const loginRateMaxPerKey = positiveInteger(process.env.LOGIN_RATE_MAX_PER_KEY, 5);
const loginRateMaxPerIp = positiveInteger(process.env.LOGIN_RATE_MAX_PER_IP, 25);
const loginRateGlobalWindowMs = positiveInteger(process.env.LOGIN_RATE_GLOBAL_WINDOW_MS, 60 * 1000);
const loginRateGlobalMax = positiveInteger(process.env.LOGIN_RATE_GLOBAL_MAX, 100);
const loginRateMaxBuckets = positiveInteger(process.env.LOGIN_RATE_MAX_BUCKETS, 1024);
const loginScryptConcurrency = positiveInteger(process.env.LOGIN_SCRYPT_CONCURRENCY, 2);
const staticRoot = path.join(__dirname, "dist");
const secureCookie = publicOrigin.startsWith("https://") || process.env.COOKIE_SECURE === "true";
const dataRoomListCache = new Map();
const liveScreenCache = new Map();
const liveScreenAllowedProfiles = new Set(splitList(process.env.LIVE_SCREEN_ALLOWED_PROFILES || [
  "default",
  "greeming-seoyun",
  "greeming-jian",
  "greeming-taeo",
  "greeming-harin",
  "greeming-doyun",
  "greeming-yuna",
  "greeming-junseo",
  "greeming-jaehyun",
  "greeming-minjun",
].join(",")));
const reservationAgentReadToken = String(process.env.RESERVATION_AGENT_READ_TOKEN || "");
const reservationAgentAllowedProfiles = new Set(splitList(process.env.RESERVATION_AGENT_ALLOWED_PROFILES || [
  "default",
  "greeming-seoyun",
  "greeming-jian",
  "greeming-taeo",
  "greeming-harin",
  "greeming-doyun",
  "greeming-yuna",
  "greeming-junseo",
  "greeming-jaehyun",
  "greeming-minjun",
].join(",")));
const liveScreenTickets = new LiveScreenTicketStore({ ttlMs: liveScreenTicketTtlMs });
const liveScreenWebSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: LIVE_SCREEN_MAX_CLIENT_MESSAGE_BYTES,
  perMessageDeflate: false,
});
const legacyHermesAuth = hermesAuthMode === "legacy-server-token"
  ? createLegacyHermesAuth({ target: hermesTarget, publicOrigin, timeoutMs: hermesProxyTimeoutMs })
  : null;
const legacyHermesWsTickets = legacyHermesAuth
  ? new LiveScreenTicketStore({ ttlMs: 30000, maxEntries: 1024 })
  : null;
const loginRateBuckets = new Map();
let globalLoginAttempts = 0;
let globalLoginResetAt = 0;
let scryptInFlight = 0;
let sessionArchiveWrite = Promise.resolve();
let pluginStateWrite = Promise.resolve();
let organizationStateWrite = Promise.resolve();
const reservationSync = createReservationSyncController();

const HERMES_AUTH_COOKIE_NAMES = [
  "hermes_session_at",
  "hermes_session_rt",
  "hermes_session_pkce",
  "hermes_sso_attempt",
];
const HERMES_COOKIE_PREFIXES = ["", "__Host-", "__Secure-"];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
};

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    const encoded = value.join("=") || "";
    try {
      return [key, decodeURIComponent(encoded)];
    } catch {
      // Keep malformed values opaque. In particular, a malformed session
      // cookie can no longer escape the request handler and still fails the
      // signature check below.
      return [key, encoded];
    }
  }).filter(([key]) => key));
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validatedSessionSecret(value) {
  const secret = String(value || "");
  if (Buffer.byteLength(secret, "utf8") < 32 || new Set(secret).size < 12) {
    throw new Error("HERMES_OFFICE_SESSION_SECRET must be at least 32 bytes with at least 12 distinct characters");
  }
  return secret;
}

function canonicalHostMatches(request) {
  if (!canonicalOrigin) return true;
  return String(request.headers.host || "").trim().toLowerCase() === canonicalOrigin.host.toLowerCase();
}

function canonicalRequestLocation(requestUrl) {
  if (!canonicalOrigin) return "/";
  try {
    const parsed = new URL(requestUrl, canonicalOrigin);
    return new URL(`${parsed.pathname}${parsed.search}`, canonicalOrigin).toString();
  } catch {
    return canonicalOrigin.toString();
  }
}

function verifyPassword(password) {
  const [salt, expected] = authPasswordHash.split(":");
  if (!salt || !expected) return Promise.resolve(false);
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      resolve(!error && timingSafeEqual(derivedKey.toString("hex"), expected));
    });
  });
}

function loginClientAddress(request) {
  // Never trust a browser-supplied forwarding header here. The connected
  // peer is either the client or the reverse proxy selected by the server.
  return String(request.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function loginRateKey(request, username) {
  return `pair:${loginClientAddress(request)}:${String(username).trim().toLowerCase().slice(0, 256)}`;
}

function pruneLoginRateBuckets(now) {
  for (const [key, bucket] of loginRateBuckets) {
    if (bucket.resetAt <= now) loginRateBuckets.delete(key);
  }
  while (loginRateBuckets.size > loginRateMaxBuckets) {
    let oldestKey = "";
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of loginRateBuckets) {
      if (bucket.lastSeen < oldestSeen) {
        oldestKey = key;
        oldestSeen = bucket.lastSeen;
      }
    }
    if (!oldestKey) break;
    loginRateBuckets.delete(oldestKey);
  }
}

function loginRateBucket(key, now) {
  const current = loginRateBuckets.get(key);
  if (current && current.resetAt > now) return current;
  const created = { count: 0, resetAt: now + loginRateWindowMs, lastSeen: now };
  loginRateBuckets.set(key, created);
  return created;
}

function consumeLoginAttempt(request, username) {
  const now = Date.now();
  pruneLoginRateBuckets(now);
  if (globalLoginResetAt <= now) {
    globalLoginAttempts = 0;
    globalLoginResetAt = now + loginRateGlobalWindowMs;
  }

  const pair = loginRateBucket(loginRateKey(request, username), now);
  const ip = loginRateBucket(`ip:${loginClientAddress(request)}`, now);
  const blockedUntil = [
    pair.count >= loginRateMaxPerKey ? pair.resetAt : 0,
    ip.count >= loginRateMaxPerIp ? ip.resetAt : 0,
    globalLoginAttempts >= loginRateGlobalMax ? globalLoginResetAt : 0,
  ].reduce((latest, value) => Math.max(latest, value), 0);
  if (blockedUntil > now) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
  }

  pair.count += 1;
  pair.lastSeen = now;
  ip.count += 1;
  ip.lastSeen = now;
  globalLoginAttempts += 1;
  pruneLoginRateBuckets(now);
  return { allowed: true, retryAfter: 0 };
}

function resetLoginRateKey(request, username) {
  loginRateBuckets.delete(loginRateKey(request, username));
}

async function verifyPasswordBounded(password) {
  if (scryptInFlight >= loginScryptConcurrency) return { busy: true, valid: false };
  scryptInFlight += 1;
  try {
    return { busy: false, valid: await verifyPassword(password) };
  } finally {
    scryptInFlight -= 1;
  }
}

function hermesLogoutCookieDeletions() {
  const expires = "Thu, 01 Jan 1970 00:00:00 GMT";
  return HERMES_AUTH_COOKIE_NAMES.flatMap((name) => HERMES_COOKIE_PREFIXES.map((prefix) => {
    const forceSecure = secureCookie || prefix === "__Host-" || prefix === "__Secure-";
    return `${prefix}${name}=; Max-Age=0; Expires=${expires}; HttpOnly; SameSite=Lax; ${forceSecure ? "Secure; " : ""}Path=/hermes`;
  }));
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    user,
    exp: Date.now() + 1000 * 60 * 60 * 12,
    nonce: crypto.randomUUID(),
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function currentUser(request) {
  const sid = parseCookies(request.headers.cookie).hermes_office_sid;
  if (!sid) return "";
  const [payload, signature] = sid.split(".");
  if (!payload || !signature || !timingSafeEqual(signature, sign(payload))) return "";
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.exp < Date.now()) return "";
    return data.user === authUser ? data.user : "";
  } catch {
    return "";
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function sendJson(response, status, payload, headers = {}) {
  send(response, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

function officeSessionBinding(request) {
  const sid = parseCookies(request.headers.cookie).hermes_office_sid || "";
  return sid ? crypto.createHash("sha256").update(sid).digest("base64url") : "";
}

function makeReservationOAuthState(request) {
  const payload = Buffer.from(JSON.stringify({
    binding: officeSessionBinding(request),
    exp: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomUUID(),
  })).toString("base64url");
  return `${payload}.${sign(`reservation-oauth:${payload}`)}`;
}

function validReservationOAuthState(request, state) {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature || !timingSafeEqual(signature, sign(`reservation-oauth:${payload}`))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded.exp >= Date.now() && decoded.binding && decoded.binding === officeSessionBinding(request);
  } catch {
    return false;
  }
}

function splitList(value = "") {
  return String(value)
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultLiveScreenCdpUrls() {
  const configured = splitList(process.env.LIVE_SCREEN_CDP_URLS || process.env.LIVE_SCREEN_CDP_URL || process.env.BROWSER_CDP_URL || "");
  return configured.map(normalizeLiveScreenCdpUrl).filter(Boolean);
}

function liveScreenProfileMap() {
  return parseLiveScreenProfileMap(process.env.LIVE_SCREEN_PROFILE_CDP_URLS || "");
}

function visibleCdpPage(tab) {
  const url = String(tab?.url || "");
  if (tab?.type !== "page") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (url.includes("chrome-devtools-frontend")) return false;
  return true;
}

function livePageActivity(page, source = "session-target") {
  const safeUrl = sanitizeLiveViewUrl(page.url);
  return {
    state: "working",
    text: "Chrome 탭 동기화",
    view: {
      url: safeUrl,
      title: String(page.title || (safeUrl ? new URL(safeUrl).hostname : "Chrome")).slice(0, 240),
      tool: "agent chrome",
      source,
      pageId: page.id,
      targetId: page.id,
      faviconUrl: page.faviconUrl || "",
      aspectRatio: 16 / 9,
      updatedAt: Date.now(),
    },
  };
}

function liveScreenPageSocketUrl(endpoint, debuggerUrl) {
  try {
    const base = new URL(normalizeLiveScreenCdpUrl(endpoint));
    const socket = new URL(debuggerUrl);
    socket.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    socket.host = base.host;
    return socket.toString();
  } catch {
    return "";
  }
}

async function pageHasFocus(endpoint, page, timeoutMs = 900) {
  const socketUrl = liveScreenPageSocketUrl(endpoint, page?.webSocketDebuggerUrl);
  if (!socketUrl) return false;
  return await new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (focused = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* best-effort probe cleanup */ }
      resolve(Boolean(focused));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = new WebSocket(socketUrl, {
        headers: { Origin: new URL(endpoint).origin },
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
      });
      socket.once("open", () => {
        socket.send(JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "document.hasFocus()", returnByValue: true },
        }));
      });
      socket.on("message", (raw) => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (message.id !== 1) return;
        finish(message.result?.result?.value === true);
      });
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function readProfileCurrentLiveView(profile, urlHint, profileMap, defaults) {
  const endpoint = liveScreenFallbackEndpoint(profile, profileMap, defaults);
  if (!endpoint) return { endpoint: "", activity: null, errors: [] };
  try {
    const tabs = await fetchJsonWithTimeout(`${normalizeLiveScreenCdpUrl(endpoint)}/json/list`, 3000);
    const pages = (Array.isArray(tabs) ? tabs : []).filter(visibleCdpPage);
    const focusChecks = await Promise.all(pages.slice(0, 12).map(async (page) => (
      await pageHasFocus(endpoint, page) ? page.id : ""
    )));
    const page = selectLiveScreenFallbackPage(pages, {
      hintUrl: urlHint,
      focusedPageIds: focusChecks.filter(Boolean),
    });
    return {
      endpoint: page ? endpoint : "",
      activity: page ? livePageActivity(page, "profile-current-tab") : null,
      errors: [],
    };
  } catch (error) {
    return { endpoint: "", activity: null, errors: [`${endpoint}: ${error.message}`] };
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 1500, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readExactLiveView(profile, targetId, profileMap, defaults) {
  const candidates = liveScreenEndpointCandidates(profile, profileMap, defaults);
  const errors = [];
  for (const endpoint of candidates) {
    try {
      const tabs = await fetchJsonWithTimeout(`${normalizeLiveScreenCdpUrl(endpoint)}/json/list`);
      const page = (Array.isArray(tabs) ? tabs : []).find((tab) => visibleCdpPage(tab) && tab.id === targetId);
      if (page) return { endpoint, activity: livePageActivity(page), errors };
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  return { endpoint: "", activity: null, errors };
}

async function readSessionLiveView(profile, browserSessionId, profileMap, defaults, passive = false) {
  if (!browserSessionId) return { endpoint: "", activity: null, errors: [] };
  const candidates = liveScreenEndpointCandidates(profile, profileMap, defaults);
  const errors = [];
  for (const endpoint of candidates) {
    try {
      const query = new URLSearchParams({ session: browserSessionId });
      if (passive) query.set("claim", "0");
      const target = await fetchJsonWithTimeout(`${normalizeLiveScreenCdpUrl(endpoint)}/__session_target?${query}`, 3000);
      const targetId = String(target?.targetId || "");
      if (!targetId) continue;
      const tabs = await fetchJsonWithTimeout(`${normalizeLiveScreenCdpUrl(endpoint)}/json/list`, 3000);
      const page = (Array.isArray(tabs) ? tabs : []).find((tab) => visibleCdpPage(tab) && tab.id === targetId);
      if (page) return { endpoint, activity: livePageActivity(page), errors };
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  return { endpoint: "", activity: null, errors };
}

async function touchSessionLiveView(endpoint, browserSessionId) {
  if (!endpoint || !browserSessionId) return false;
  const query = new URLSearchParams({ session: browserSessionId });
  try {
    const payload = await fetchJsonWithTimeout(
      `${normalizeLiveScreenCdpUrl(endpoint)}/__session_target?${query}`,
      3000,
      { method: "POST" },
    );
    return payload?.touched === true;
  } catch {
    return false;
  }
}

async function disposeSessionLiveView(profile, browserSessionId) {
  if (!browserSessionId) return false;
  const profileMap = liveScreenProfileMap();
  const defaults = defaultLiveScreenCdpUrls();
  for (const endpoint of liveScreenEndpointCandidates(profile, profileMap, defaults)) {
    const query = new URLSearchParams({ session: browserSessionId });
    try {
      const payload = await fetchJsonWithTimeout(
        `${normalizeLiveScreenCdpUrl(endpoint)}/__session_target?${query}`,
        5000,
        { method: "DELETE" },
      );
      if (payload?.disposed === true) return true;
    } catch {
      // The exact profile endpoint may be unavailable during an agent restart.
    }
  }
  return false;
}

async function handleLiveScreenBridge(request, response, url) {
  if (!["GET", "DELETE"].includes(request.method) || url.pathname !== "/bridge/live-screens") {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  const profile = String(url.searchParams.get("profile") || "default");
  const sessionId = String(url.searchParams.get("sessionId") || "").trim();
  const targetId = String(url.searchParams.get("targetId") || "").trim();
  const browserSessionId = String(url.searchParams.get("browserSessionId") || "").trim();
  const urlHint = sanitizeLiveViewUrl(String(url.searchParams.get("url") || "").slice(0, 2048));
  const passive = url.searchParams.get("passive") === "1";
  try {
    validateLiveScreenScope({ profile, sessionId, targetId, browserSessionId, allowedProfiles: liveScreenAllowedProfiles });
  } catch {
    sendJson(response, 400, { error: "invalid live screen scope" });
    return;
  }
  if (sessionId && browserSessionId !== sessionId) {
    sendJson(response, 400, { error: "live screen session binding mismatch" });
    return;
  }
  if (request.method === "DELETE") {
    liveScreenTickets.revoke(profile, sessionId);
    for (const key of liveScreenCache.keys()) {
      try {
        const cachedRequest = JSON.parse(key);
        if (cachedRequest.profile === profile && cachedRequest.sessionId === sessionId) liveScreenCache.delete(key);
      } catch {
        liveScreenCache.delete(key);
      }
    }
    send(response, 204, "", { "Cache-Control": "no-store" });
    return;
  }
  const profileMap = liveScreenProfileMap();
  const defaults = defaultLiveScreenCdpUrls();
  const cacheKey = JSON.stringify({ profile, sessionId, browserSessionId, targetId, urlHint, passive, map: [...profileMap], defaults });
  const cached = liveScreenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(response, 200, issueLiveScreenViewer(cached.discovery, request, url));
    return;
  }

  const sessionScoped = Boolean(sessionId);
  const routed = browserSessionId
    ? await readSessionLiveView(profile, browserSessionId, profileMap, defaults, passive)
    : { endpoint: "", activity: null, errors: sessionScoped ? ["browser session is required"] : [] };
  let current = routed;
  let errors = [...routed.errors];
  if (!sessionScoped && !routed.activity) {
    const exact = await readExactLiveView(profile, targetId, profileMap, defaults);
    current = exact.activity ? exact : await readProfileCurrentLiveView(profile, urlHint, profileMap, defaults);
    errors = [...errors, ...exact.errors, ...(exact.activity ? [] : current.errors)];
  }
  const { endpoint, activity: exactActivity } = current;
  if (!exactActivity?.view?.pageId) {
    sendJson(response, 200, { activity: null, unavailable: errors.length > 0, updatedAt: Date.now() });
    return;
  }
  const discovery = { endpoint, activity: exactActivity, profile, sessionId };
  liveScreenCache.set(cacheKey, { expiresAt: Date.now() + liveScreenCacheTtlMs, discovery });
  sendJson(response, 200, issueLiveScreenViewer(discovery, request, url));
}

function issueLiveScreenViewer(discovery, request, requestUrl) {
  const { token, expiresAt } = liveScreenTickets.issue({
    binding: officeSessionBinding(request),
    endpoint: discovery.endpoint,
    pageId: discovery.activity.view.pageId,
    profile: discovery.profile,
    sessionId: discovery.sessionId,
  });
  const refreshQuery = new URLSearchParams(requestUrl.searchParams);
  return {
    activity: {
      ...discovery.activity,
      view: {
        ...discovery.activity.view,
        viewerSocketUrl: `/bridge/live-screens/socket?ticket=${encodeURIComponent(token)}`,
        viewerRefreshUrl: `/bridge/live-screens?${refreshQuery}`,
        viewerTicketExpiresAt: expiresAt,
        sessionId: discovery.sessionId,
      },
    },
    updatedAt: Date.now(),
  };
}

function safeNextPath(value = "/") {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const hasControlCharacter = (candidate) => [...candidate].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  const unsafePath = (candidate) => candidate.startsWith("//") || candidate.includes("\\") || hasControlCharacter(candidate);
  if (unsafePath(value)) return "/";

  // Form/query parsing already decodes once. Validate one additional layer so
  // encoded network paths, backslashes, and control characters cannot become
  // unsafe after another URL-decoding hop.
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/") || unsafePath(decoded)) return "/";
  } catch {
    return "/";
  }

  try {
    const base = new URL("https://hermes-office.invalid/");
    const normalized = new URL(value, base);
    if (normalized.origin !== base.origin) return "/";
    return `${normalized.pathname}${normalized.search}${normalized.hash}`;
  } catch {
    return "/";
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function redirectLogin(response, next = "/") {
  const suffix = next && next !== "/" ? `?next=${encodeURIComponent(safeNextPath(next))}` : "";
  send(response, 302, "", { Location: `/login${suffix}` });
}

function isPublicPwaAsset(pathname) {
  return pathname === "/sw.js" ||
    pathname.startsWith("/workbox-") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/hermes-mark.svg";
}

// eslint-disable-next-line no-unused-vars
function loginPage(message = "", next = "/") {
  const safeNext = safeNextPath(next);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Greeming Hermes Login</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#14231f;color:#f8f1e5;font-family:system-ui,"Noto Sans KR",sans-serif;overflow-x:hidden}
form{width:min(360px,100%);padding:28px;border:1px solid #466156;border-radius:18px;background:#1e332b;box-shadow:0 20px 60px #0005}
h1{margin:0 0 6px;font-size:24px}p{margin:0 0 20px;color:#a9bcb4;font-size:13px;line-height:1.6}
label{display:block;margin:14px 0 6px;color:#c9d7d0;font-size:12px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #5d786d;border-radius:10px;background:#12231d;color:white}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:#e0a35c;color:#16241f;font-weight:800;cursor:pointer}.error{color:#ffb4a5}
</style></head><body><form method="post" action="/login?next=${encodeURIComponent(safeNext)}">
<h1>Greeming Hermes</h1><p>팀 워크스페이스에 로그인하세요.</p>
${message ? `<p class="error">${message}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(safeNext)}">
<label>ID</label><input name="user" autocomplete="username" required>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<button>로그인</button></form></body></html>`;
}

function loginPageV2(message = "", next = "/") {
  const safeNext = safeNextPath(next);
  const hermesCredentialFields = hermesAuthMode === "official"
    ? `<div class="section"><h2>Hermes 계정</h2><p class="hint">비워두면 위 Office 계정 정보를 사용합니다.</p>
<label>Hermes ID</label><input name="hermes_user" autocomplete="username">
<label>Hermes Password</label><input name="hermes_password" type="password" autocomplete="current-password"></div>`
    : `<div class="section"><h2>Hermes 연결</h2><p class="hint">이 호환 모드에서는 Hermes 자격증명을 브라우저에서 수집하지 않습니다.</p></div>`;
  const errorMarkup = message
    ? `<div class="error" role="alert"><strong>로그인 실패</strong><span>${escapeHtml(message)}</span></div>`
    : "";
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Greeming Hermes Login</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#14231f;color:#f8f1e5;font-family:system-ui,"Noto Sans KR",sans-serif;overflow-x:hidden}
form{width:min(380px,100%);padding:28px;border:1px solid #466156;border-radius:18px;background:#1e332b;box-shadow:0 20px 60px #0005}
h1{margin:0 0 6px;font-size:24px}p{margin:0 0 20px;color:#a9bcb4;font-size:13px;line-height:1.6}
label{display:block;margin:14px 0 6px;color:#c9d7d0;font-size:12px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #5d786d;border-radius:10px;background:#12231d;color:white;font:inherit}
.section{margin-top:18px;padding-top:16px;border-top:1px solid #466156}.section h2{margin:0 0 4px;font-size:14px}.hint{margin:0;color:#a9bcb4;font-size:11px}
.password-field{position:relative}.password-field input{padding-right:72px}
.toggle-password{position:absolute;top:50%;right:7px;width:auto;margin:0;padding:7px 10px;transform:translateY(-50%);border:1px solid #5d786d;border-radius:8px;background:#263c34;color:#dce8e2;font-size:12px;font-weight:800;cursor:pointer}
.submit{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:#e0a35c;color:#16241f;font-weight:800;cursor:pointer}
.error{display:grid;gap:3px;margin:0 0 16px;padding:12px;border:1px solid #d97966;border-radius:12px;background:#4b211d;color:#ffd1c8;font-size:13px;line-height:1.45}.error strong{color:#fff;font-size:12px}
</style></head><body><form method="post" action="/login?next=${encodeURIComponent(safeNext)}">
<h1>Greeming Hermes</h1><p>Office와 Hermes에 함께 로그인합니다.</p>
${errorMarkup}
<input type="hidden" name="next" value="${escapeHtml(safeNext)}">
<label>Office ID</label><input name="user" autocomplete="username" required>
<label>Office Password</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" required><button class="toggle-password" type="button" aria-controls="password" aria-label="비밀번호 보이기">보기</button></div>
${hermesCredentialFields}
<button class="submit" type="submit">로그인</button>
<script>
const toggle = document.querySelector(".toggle-password");
const password = document.querySelector("#password");
toggle.addEventListener("click", () => {
  const visible = password.type === "text";
  password.type = visible ? "password" : "text";
  toggle.textContent = visible ? "보기" : "숨김";
  toggle.setAttribute("aria-label", visible ? "비밀번호 보이기" : "비밀번호 숨기기");
});
</script></form></body></html>`;
}

function collectBody(request, maxBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error("request too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safeSegment(value, fallback = "chat") {
  const cleaned = String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || fallback;
}

function archiveKey(profile, sessionId) {
  return `${String(profile || "default")}:${String(sessionId || "session")}`;
}

function normalizeArchivedSessions(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item && typeof item === "object" && item.profile && item.sessionId)
    .map(([key, item]) => [key, {
      profile: String(item.profile || "default"),
      sessionId: String(item.sessionId || "session"),
      archivedAt: item.archivedAt || new Date().toISOString(),
      archivedBy: item.archivedBy || authUser,
    }]));
}

async function readSessionArchive() {
  try {
    const payload = JSON.parse(await fs.readFile(sessionArchivePath, "utf8"));
    return normalizeArchivedSessions(payload.archivedSessions ?? payload);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function updateSessionArchive(mutator) {
  sessionArchiveWrite = sessionArchiveWrite.catch(() => {}).then(async () => {
    const archive = await readSessionArchive();
    const result = await mutator(archive);
    await fs.mkdir(path.dirname(sessionArchivePath), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      archivedSessions: normalizeArchivedSessions(archive),
    };
    await fs.writeFile(sessionArchivePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const written = payload.archivedSessions;
    return result ?? written;
  });
  return sessionArchiveWrite;
}

function normalizePluginState(value) {
  if (!value || typeof value !== "object") return { installations: {} };
  return {
    installations: value.installations && typeof value.installations === "object" ? value.installations : {},
  };
}

async function readPluginState() {
  try {
    return normalizePluginState(JSON.parse(await fs.readFile(pluginStatePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { installations: {} };
    throw error;
  }
}

async function writePluginState(state) {
  await fs.mkdir(path.dirname(pluginStatePath), { recursive: true });
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...normalizePluginState(state),
  };
  pluginStateWrite = pluginStateWrite.catch(() => {}).then(() =>
    fs.writeFile(pluginStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"));
  await pluginStateWrite;
  return payload;
}

function normalizeOrganizationState(value) {
  const nodes = validateOrganizationNodes(value?.nodes ?? []);
  return {
    version: ORGANIZATION_VERSION,
    revision: Math.max(0, Number.parseInt(String(value?.revision ?? 0), 10) || 0),
    updatedAt: value?.updatedAt ? String(value.updatedAt) : "",
    updatedBy: value?.updatedBy ? String(value.updatedBy) : "",
    nodes,
    audit: Array.isArray(value?.audit) ? value.audit.slice(-100).map((entry) => ({
      revision: Math.max(0, Number.parseInt(String(entry?.revision ?? 0), 10) || 0),
      actor: String(entry?.actor ?? "office"),
      action: String(entry?.action ?? "structure.updated"),
      at: String(entry?.at ?? ""),
      nodeCount: Math.max(0, Number.parseInt(String(entry?.nodeCount ?? 0), 10) || 0),
    })) : [],
  };
}

async function readOrganizationState() {
  try {
    return normalizeOrganizationState(JSON.parse(await fs.readFile(organizationStatePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeOrganizationState({});
    throw error;
  }
}

async function updateOrganizationState({ baseRevision, nodes, actor }) {
  organizationStateWrite = organizationStateWrite.catch(() => {}).then(async () => {
    const current = await readOrganizationState();
    if (Number(baseRevision) !== current.revision) {
      const conflict = new Error("Organization changed in another session. Reload and try again.");
      conflict.statusCode = 409;
      conflict.current = current;
      throw conflict;
    }
    const canonicalNodes = validateOrganizationNodes(nodes);
    const revision = current.revision + 1;
    const updatedAt = new Date().toISOString();
    const next = normalizeOrganizationState({
      revision,
      updatedAt,
      updatedBy: actor,
      nodes: canonicalNodes,
      audit: [...current.audit, {
        revision,
        actor,
        action: "structure.updated",
        at: updatedAt,
        nodeCount: canonicalNodes.length,
      }],
    });
    await fs.mkdir(path.dirname(organizationStatePath), { recursive: true });
    const temporaryPath = `${organizationStatePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, organizationStatePath);
    return next;
  });
  return organizationStateWrite;
}

async function handleOrganizationBridge(request, response, url) {
  if (request.method === "GET" && url.pathname === "/bridge/organization") {
    sendJson(response, 200, await readOrganizationState(), { "Cache-Control": "no-store" });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/bridge/organization") {
    let payload;
    try {
      payload = JSON.parse(await collectBody(request, 256 * 1024) || "{}");
    } catch {
      sendJson(response, 400, { error: "invalid json" });
      return;
    }
    try {
      const state = await updateOrganizationState({
        baseRevision: payload.baseRevision,
        nodes: payload.nodes,
        actor: currentUser(request) || authUser,
      });
      sendJson(response, 200, state, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error.statusCode === 409) {
        sendJson(response, 409, { error: error.message, current: error.current }, { "Cache-Control": "no-store" });
        return;
      }
      sendJson(response, 400, { error: error.message });
    }
    return;
  }
  send(response, 405, "Method Not Allowed", { Allow: "GET, PUT" });
}

function safeFilename(value) {
  const extension = path.extname(value).slice(0, 20);
  const stem = path.basename(value, extension).replace(/[^a-zA-Z0-9가-힣._ -]/g, "_").slice(0, 120);
  return `${stem || "file"}${extension}`;
}

function scopedPaths(conversation, scope = "") {
  const safeConversation = safeSegment(conversation);
  const storeBase = path.join(fileStoreRoot, safeConversation);
  const agentBase = `${agentFileRoot}/${safeConversation}`;
  return scope
    ? { store: path.join(storeBase, scope), agent: `${agentBase}/${scope}` }
    : { store: storeBase, agent: agentBase };
}

async function prepareFiles(conversation) {
  const input = scopedPaths(conversation, "inputs");
  const output = scopedPaths(conversation, "outputs");
  await fs.mkdir(input.store, { recursive: true });
  await fs.mkdir(output.store, { recursive: true });
  await fs.chmod(input.store, 0o755).catch(() => {});
  await fs.chmod(output.store, 0o777).catch(() => {});
  return { inputDirectory: input.agent, outputDirectory: output.agent };
}

async function handleFileBridge(request, response, url) {
  const conversation = safeSegment(url.searchParams.get("conversation"));
  if (request.method === "POST" && url.pathname === "/bridge/files/prepare") {
    sendJson(response, 200, await prepareFiles(conversation));
    return;
  }

  if (request.method === "POST" && url.pathname === "/bridge/files/upload") {
    await prepareFiles(conversation);
    const input = scopedPaths(conversation, "inputs");
    const busboy = Busboy({ headers: request.headers, defParamCharset: "utf8", limits: { fileSize: maxFileSize, files: 20 } });
    const pending = [];
    busboy.on("file", (_field, stream, info) => {
      const originalName = safeFilename(info.filename);
      const storedName = `${crypto.randomUUID()}-${originalName}`;
      const temporary = path.join(tmpdir(), `hermes-office-${storedName}`);
      pending.push(new Promise((resolve, reject) => {
        let size = 0;
        const output = createWriteStream(temporary, { flags: "wx" });
        stream.on("data", (chunk) => { size += chunk.length; });
        stream.on("limit", () => reject(new Error(`${originalName}: 100MB 제한을 초과했습니다.`)));
        stream.on("error", reject);
        output.on("error", reject);
        output.on("finish", async () => {
          const target = path.join(input.store, storedName);
          try {
            try {
              await fs.rename(temporary, target);
            } catch (error) {
              if (error.code !== "EXDEV") throw error;
              await fs.copyFile(temporary, target);
              await fs.unlink(temporary);
            }
            resolve({ name: storedName, originalName, storedName, size, mime: info.mimeType, scope: "inputs", path: `${input.agent}/${storedName}` });
          } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            reject(error);
          }
        });
        stream.pipe(output);
      }));
    });
    busboy.on("finish", async () => {
      try {
        const files = await Promise.all(pending);
        sendJson(response, 200, { files, outputDirectory: scopedPaths(conversation, "outputs").agent });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    request.pipe(busboy);
    return;
  }

  if (request.method === "GET" && url.pathname === "/bridge/files/list") {
    const files = [];
    for (const scope of ["inputs", "outputs"]) {
      const paths = scopedPaths(conversation, scope);
      await fs.mkdir(paths.store, { recursive: true });
      await fs.chmod(paths.store, scope === "outputs" ? 0o777 : 0o755).catch(() => {});
      const entries = await fs.readdir(paths.store, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const stat = await fs.stat(path.join(paths.store, entry.name));
        files.push({
          name: entry.name,
          scope,
          size: stat.size,
          modified: stat.mtimeMs / 1000,
          mime: mimeTypes[path.extname(entry.name).toLowerCase()] || "application/octet-stream",
          path: `${paths.agent}/${entry.name}`,
        });
      }
    }
    sendJson(response, 200, { files: files.sort((a, b) => a.modified - b.modified), outputDirectory: scopedPaths(conversation, "outputs").agent });
    return;
  }

  if ((request.method === "GET" && url.pathname === "/bridge/files/download") || (request.method === "DELETE" && url.pathname === "/bridge/files/item")) {
    const scope = url.searchParams.get("scope");
    const name = url.searchParams.get("name");
    if (!["inputs", "outputs"].includes(scope) || !name || [".", ".."].includes(name) || path.basename(name) !== name || safeFilename(name) !== name) {
      sendJson(response, 400, { error: "잘못된 파일 경로입니다." });
      return;
    }
    const filePath = path.join(scopedPaths(conversation, scope).store, name);
    if (request.method === "DELETE") {
      await fs.rm(filePath, { force: true });
      sendJson(response, 200, { removed: true });
      return;
    }
    const inline = url.searchParams.get("inline") === "1";
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(name).toLowerCase()] || "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

function uniqueDataRoots() {
  const seen = new Set();
  return dataRoomRoots
    .map((root) => path.resolve(root))
    .filter((root) => {
      if (seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

function encodeDataId(rootIndex, relativePath) {
  return Buffer.from(JSON.stringify([rootIndex, relativePath])).toString("base64url");
}

function decodeDataId(id) {
  try {
    const [rootIndex, relativePath] = JSON.parse(Buffer.from(String(id), "base64url").toString("utf8"));
    if (!Number.isInteger(rootIndex) || typeof relativePath !== "string") return null;
    return { rootIndex, relativePath };
  } catch {
    return null;
  }
}

function isTextPreviewExtension(extension) {
  return [".md", ".txt", ".csv", ".json", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".yml", ".yaml", ".xml", ".log"].includes(extension);
}

function dataCategory(relativePath, extension) {
  const normalized = relativePath.toLowerCase();
  if (normalized.includes("01_") || normalized.includes("brand") || normalized.includes("브랜드")) return "brand";
  if (normalized.includes("02_") || normalized.includes("product") || normalized.includes("상품") || normalized.includes("가격")) return "product";
  if (normalized.includes("meeting") || normalized.includes("회의")) return "meeting";
  if (normalized.includes("outputs")) return "outputs";
  if (normalized.includes("inputs") || normalized.includes("upload")) return "uploads";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) return "images";
  if ([".xlsx", ".xls", ".csv", ".tsv"].includes(extension)) return "sheets";
  if ([".ppt", ".pptx"].includes(extension)) return "slides";
  if ([".doc", ".docx", ".pdf", ".md", ".txt", ".html", ".htm"].includes(extension)) return "documents";
  return "system";
}

function dataKind(extension) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ([".md", ".txt", ".csv", ".json", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".yml", ".yaml", ".xml", ".log"].includes(extension)) return "text";
  if ([".xlsx", ".xls", ".csv", ".tsv"].includes(extension)) return "sheet";
  if ([".ppt", ".pptx"].includes(extension)) return "slide";
  if ([".doc", ".docx"].includes(extension)) return "document";
  return "file";
}

function dataMime(filename) {
  return mimeTypes[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function dataRootLabel(root) {
  if (root === fileStoreRoot) return "Hermes files";
  if (root.includes("google-drive")) return "데이터 공간";
  if (root.includes("profiles")) return "구성원 작업 공간";
  if (root.includes("workspace")) return "전체 문서";
  if (root.includes("greeminghome")) return "GitHub 문서함";
  if (root.includes("archive")) return "Archive";
  return path.basename(root) || root;
}

function dataRootsPayload(roots = uniqueDataRoots()) {
  return roots.map((root, index) => ({ id: index, label: dataRootLabel(root) }));
}

async function handleSessionArchive(request, response, url) {
  if (request.method === "GET" && url.pathname === "/bridge/session-archive") {
    const profile = url.searchParams.get("profile");
    const archive = await readSessionArchive();
    const archivedSessions = Object.fromEntries(Object.entries(archive)
      .filter(([, item]) => !profile || item.profile === String(profile)));
    sendJson(response, 200, { archivedSessions });
    return;
  }

  if (request.method === "POST" && url.pathname === "/bridge/session-archive") {
    const body = await collectBody(request);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(response, 400, { error: "invalid json" });
      return;
    }
    const profile = String(payload.profile || "default");
    const sessionId = String(payload.sessionId || "");
    if (!sessionId) {
      sendJson(response, 400, { error: "sessionId is required" });
      return;
    }
    const item = {
      profile,
      sessionId,
      archivedAt: new Date().toISOString(),
      archivedBy: currentUser(request) || authUser,
    };
    await updateSessionArchive((archive) => {
      archive[archiveKey(profile, sessionId)] = item;
      return item;
    });
    const browserDisposed = await disposeSessionLiveView(profile, sessionId);
    liveScreenTickets.revoke(profile, sessionId);
    sendJson(response, 200, { archived: item, browserDisposed });
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/bridge/session-archive") {
    const profile = String(url.searchParams.get("profile") || "default");
    const sessionId = String(url.searchParams.get("sessionId") || "");
    if (!sessionId) {
      sendJson(response, 400, { error: "sessionId is required" });
      return;
    }
    await updateSessionArchive((archive) => {
      delete archive[archiveKey(profile, sessionId)];
      return { restored: true };
    });
    sendJson(response, 200, { restored: true });
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

function normalizePluginItem(item = {}) {
  const id = safeSegment(item.id || item.name || "");
  if (!id) return null;
  return {
    id,
    name: String(item.name || id),
    provider: String(item.provider || "community"),
    kind: String(item.kind || "plugin"),
    category: String(item.category || "general"),
    requiresConfig: Boolean(item.requiresConfig),
    command: item.command ? String(item.command) : "",
    source: item.source ? String(item.source) : "",
  };
}

function pluginInstallState(item) {
  if (item.requiresConfig) return "needs-config";
  return "verified";
}

async function handlePluginBridge(request, response, url) {
  if (request.method === "GET" && url.pathname === "/bridge/plugins/state") {
    sendJson(response, 200, await readPluginState());
    return;
  }

  if ((request.method === "POST" && url.pathname === "/bridge/plugins/install") ||
      (request.method === "POST" && url.pathname === "/bridge/plugins/test")) {
    let payload;
    try {
      payload = JSON.parse(await collectBody(request) || "{}");
    } catch {
      sendJson(response, 400, { error: "invalid json" });
      return;
    }
    const profile = safeSegment(payload.profile || "default");
    const item = normalizePluginItem(payload.item);
    if (!item) {
      sendJson(response, 400, { error: "plugin item is required" });
      return;
    }

    const state = await readPluginState();
    const installations = { ...(state.installations ?? {}) };
    const profileInstallations = { ...(installations[profile] ?? {}) };
    const current = profileInstallations[item.id] ?? {};
    const status = url.pathname.endsWith("/test") ? pluginInstallState(item) : pluginInstallState(item);
    const installation = {
      ...current,
      ...item,
      profile,
      status,
      testedAt: new Date().toISOString(),
      installedAt: current.installedAt || (url.pathname.endsWith("/install") ? new Date().toISOString() : ""),
      note: item.requiresConfig
        ? "API token, OAuth, or local MCP command configuration is required before activation."
        : "Local manifest and endpoint requirements passed the Agent Office registry check.",
    };
    profileInstallations[item.id] = installation;
    installations[profile] = profileInstallations;
    const nextState = await writePluginState({ ...state, installations });
    sendJson(response, 200, { installation, state: nextState });
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

function dataRoomCacheKey({ roots, query, category }) {
  return JSON.stringify({ roots, query, category });
}

function getCachedDataRoomList(key) {
  const cached = dataRoomListCache.get(key);
  if (!cached || cached.expiresAt < Date.now()) {
    dataRoomListCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCachedDataRoomList(key, payload) {
  dataRoomListCache.set(key, {
    expiresAt: Date.now() + dataRoomListCacheTtlMs,
    payload,
  });
}

function clearDataRoomListCache() {
  dataRoomListCache.clear();
}

function shouldSkipDataEntry(name) {
  return [
    ".git",
    ".env",
    ".deploy_tmp",
    ".playwright-mcp",
    "node_modules",
    "dist",
    "dev-dist",
    "__pycache__",
    ".drive-mirror-state.json",
  ].includes(name);
}

async function resolveDataPath(rootIndex, relativePath = "") {
  const roots = uniqueDataRoots();
  if (!Number.isInteger(rootIndex) || !roots[rootIndex]) return null;
  const root = roots[rootIndex];
  const cleanRelativePath = String(relativePath || "").split(/[\\/]+/).filter(Boolean).join(path.sep);
  const resolved = path.resolve(root, cleanRelativePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  const stat = await fs.stat(resolved);
  return { root, rootIndex, resolved, relativePath: cleanRelativePath, stat };
}

async function resolveDataItem(id) {
  const decoded = decodeDataId(id);
  if (!decoded) return null;
  const item = await resolveDataPath(decoded.rootIndex, decoded.relativePath);
  if (!item?.stat.isFile()) return null;
  return item;
}

async function scanDataRoot(root, rootIndex, options, collection, depth = 0, relativeBase = "") {
  if (collection.length >= dataRoomMaxFiles || depth > 8) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relativeBase), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (collection.length >= dataRoomMaxFiles) return;
    if (shouldSkipDataEntry(entry.name)) continue;
    const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      await scanDataRoot(root, rootIndex, options, collection, depth + 1, relativePath);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const category = dataCategory(relativePath, extension);
    if (options.category && options.category !== "all" && category !== options.category) continue;
    if (options.query && !relativePath.toLowerCase().includes(options.query)) continue;
    const stat = await fs.stat(absolutePath);
    collection.push({
      id: encodeDataId(rootIndex, relativePath),
      rootId: rootIndex,
      name: entry.name,
      relativePath: relativePath.split(path.sep).join("/"),
      category,
      kind: dataKind(extension),
      extension,
      size: stat.size,
      modified: stat.mtimeMs / 1000,
      mime: dataMime(entry.name),
      source: dataRootLabel(root),
    });
  }
}

async function handleDataRoom(request, response, url) {
  if (request.method === "GET" && url.pathname === "/bridge/data-room/drive-status") {
    sendJson(response, 200, getGoogleDriveMirrorStatus());
    return;
  }
  if (request.method === "GET" && url.pathname === "/bridge/data-room/browse") {
    const roots = uniqueDataRoots();
    const rootIndex = Number(url.searchParams.get("root") || 0);
    const relativePath = url.searchParams.get("path") || "";
    const current = await resolveDataPath(rootIndex, relativePath);
    if (!current || !current.stat.isDirectory()) {
      sendJson(response, 404, { error: "folder not found" });
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(current.resolved, { withFileTypes: true });
    } catch {
      sendJson(response, 403, { error: "folder unavailable" });
      return;
    }
    const items = [];
    for (const entry of entries) {
      if (shouldSkipDataEntry(entry.name)) continue;
      const entryRelativePath = current.relativePath ? path.join(current.relativePath, entry.name) : entry.name;
      const absolutePath = path.join(current.resolved, entry.name);
      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const isDirectory = entry.isDirectory();
      items.push({
        id: isDirectory ? encodeDataId(rootIndex, entryRelativePath) : encodeDataId(rootIndex, entryRelativePath),
        type: isDirectory ? "folder" : "file",
        name: entry.name,
        relativePath: entryRelativePath.split(path.sep).join("/"),
        category: isDirectory ? "folder" : dataCategory(entryRelativePath, extension),
        kind: isDirectory ? "folder" : dataKind(extension),
        extension,
        size: isDirectory ? null : stat.size,
        modified: stat.mtimeMs / 1000,
        mime: isDirectory ? "" : dataMime(entry.name),
        source: dataRootLabel(current.root),
      });
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "ko");
    });
    sendJson(response, 200, {
      roots: dataRootsPayload(roots),
      root: { id: rootIndex, label: dataRootLabel(current.root) },
      path: current.relativePath.split(path.sep).filter(Boolean),
      relativePath: current.relativePath.split(path.sep).join("/"),
      items,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/bridge/data-room/list") {
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const category = url.searchParams.get("category") || "all";
    const roots = uniqueDataRoots();
    const cacheKey = dataRoomCacheKey({ roots, query, category });
    const cached = getCachedDataRoomList(cacheKey);
    if (cached) {
      sendJson(response, 200, cached);
      return;
    }
    const files = [];
    await Promise.all(roots.map((root, index) => scanDataRoot(root, index, { query, category }, files)));
    files.sort((a, b) => b.modified - a.modified);
    const categories = files.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    }, {});
    const payload = {
      roots: dataRootsPayload(roots),
      categories,
      files,
    };
    setCachedDataRoomList(cacheKey, payload);
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/bridge/data-room/item") {
    const item = await resolveDataItem(url.searchParams.get("id"));
    if (!item) {
      sendJson(response, 404, { error: "file not found" });
      return;
    }
    const extension = path.extname(item.resolved).toLowerCase();
    const name = path.basename(item.resolved);
    let preview = "";
    let truncated = false;
    if (isTextPreviewExtension(extension)) {
      const handle = await fs.open(item.resolved, "r");
      try {
        const buffer = Buffer.alloc(Math.min(item.stat.size, dataRoomMaxPreview));
        await handle.read(buffer, 0, buffer.length, 0);
        preview = buffer.toString("utf8");
        truncated = item.stat.size > dataRoomMaxPreview;
      } finally {
        await handle.close();
      }
    }
    sendJson(response, 200, {
      id: url.searchParams.get("id"),
      name,
      relativePath: item.relativePath.split(path.sep).join("/"),
      category: dataCategory(item.relativePath, extension),
      kind: dataKind(extension),
      extension,
      size: item.stat.size,
      modified: item.stat.mtimeMs / 1000,
      mime: dataMime(name),
      preview,
      truncated,
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/bridge/data-room/item") {
    const item = await resolveDataItem(url.searchParams.get("id"));
    if (!item) {
      sendJson(response, 404, { error: "file not found" });
      return;
    }
    const extension = path.extname(item.resolved).toLowerCase();
    if (!isTextPreviewExtension(extension)) {
      sendJson(response, 415, { error: "only text files can be edited" });
      return;
    }
    const body = await collectBody(request, dataRoomMaxPreview * 2);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(response, 400, { error: "invalid json" });
      return;
    }
    if (typeof payload.content !== "string") {
      sendJson(response, 400, { error: "content is required" });
      return;
    }
    if (Buffer.byteLength(payload.content, "utf8") > dataRoomMaxPreview * 2) {
      sendJson(response, 413, { error: "content too large" });
      return;
    }
    await fs.writeFile(item.resolved, payload.content, "utf8");
    clearDataRoomListCache();
    const stat = await fs.stat(item.resolved);
    const name = path.basename(item.resolved);
    sendJson(response, 200, {
      id: url.searchParams.get("id"),
      name,
      relativePath: item.relativePath.split(path.sep).join("/"),
      category: dataCategory(item.relativePath, extension),
      kind: dataKind(extension),
      extension,
      size: stat.size,
      modified: stat.mtimeMs / 1000,
      mime: dataMime(name),
      preview: payload.content,
      truncated: false,
      saved: true,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/bridge/data-room/download") {
    const item = await resolveDataItem(url.searchParams.get("id"));
    if (!item) {
      sendJson(response, 404, { error: "file not found" });
      return;
    }
    const name = path.basename(item.resolved);
    const inline = url.searchParams.get("inline") === "1";
    response.writeHead(200, {
      "Content-Type": dataMime(name),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(item.resolved).pipe(response);
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

function rawHeaders(headers) {
  return Object.entries(headers)
    .flatMap(([key, value]) => Array.isArray(value) ? value.map((item) => `${key}: ${item}`) : [`${key}: ${value}`])
    .join("\r\n");
}

async function serveStatic(request, response, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(staticRoot, `.${requested}`);
  const noStoreStatic = requested === "/index.html" ||
    requested === "/sw.js" ||
    requested.startsWith("/workbox-") ||
    requested === "/manifest.webmanifest";
  if (!resolved.startsWith(staticRoot)) {
    send(response, 403, "Forbidden");
    return;
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("not file");
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(resolved).toLowerCase()] || "application/octet-stream",
      "Cache-Control": noStoreStatic ? "no-store" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(resolved).pipe(response);
  } catch {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    createReadStream(path.join(staticRoot, "index.html")).pipe(response);
  }
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, publicOrigin || `http://${request.headers.host}`);
  } catch {
    sendJson(response, 400, { error: "invalid request URL" });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" }, { "Cache-Control": "no-store" });
    return;
  }

  if (url.pathname === "/agent-api/calendar/events") {
    if (request.method !== "GET") {
      send(response, 405, "Method Not Allowed", { Allow: "GET" });
      return;
    }
    const profile = authorizeAgentCalendarRequest({
      authorization: request.headers.authorization,
      profile: request.headers["x-hermes-agent-profile"],
      expectedToken: reservationAgentReadToken,
      allowedProfiles: reservationAgentAllowedProfiles,
    });
    if (!profile) {
      sendJson(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    try {
      const query = parseAgentCalendarQuery(url.searchParams);
      sendJson(response, 200, await reservationSync.listGoogleCalendarEvents(query, profile), { "Cache-Control": "no-store" });
    } catch (error) {
      const invalidQuery = /형식|시각|기간|캘린더|검색어|조회 개수/.test(String(error?.message || ""));
      if (!invalidQuery) console.error("Agent Calendar read failed:", String(error?.message || error).slice(0, 200));
      sendJson(response, invalidQuery ? 400 : 503, {
        error: invalidQuery ? "invalid calendar query" : "calendar temporarily unavailable",
        message: invalidQuery ? String(error.message).slice(0, 200) : "Google 예약 캘린더를 불러오지 못했습니다.",
      }, { "Cache-Control": "no-store" });
    }
    return;
  }
  const instagramRoute = resolveInstagramProxyRoute(request.method, url.pathname);

  if (!canonicalHostMatches(request)) {
    if (request.method === "GET" || request.method === "HEAD") {
      send(response, 308, "", { Location: canonicalRequestLocation(request.url) });
    } else {
      sendJson(response, 421, { error: "canonical host required" });
    }
    return;
  }

  if (url.pathname === "/internal" || url.pathname.startsWith("/internal/")) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  const reservationFeedMatch = url.pathname.match(/^\/calendar\/feeds\/([^/]+)\/(hourplace|spacecloud)\.ics$/);
  if ((request.method === "GET" || request.method === "HEAD") && reservationFeedMatch) {
    const body = reservationSync.calendarFeed(reservationFeedMatch[2], reservationFeedMatch[1]);
    if (!body) {
      sendJson(response, 404, { error: "not found" }, { "Cache-Control": "no-store" });
      return;
    }
    send(response, 200, request.method === "HEAD" ? "" : body, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/webhooks/google/gmail") {
    try {
      const payload = JSON.parse(await collectBody(request, 64 * 1024) || "{}");
      const result = await reservationSync.handleGmailPush({ authorization: request.headers.authorization, body: payload });
      sendJson(response, 202, { accepted: true, state: result.state }, { "Cache-Control": "no-store" });
    } catch (error) {
      const unauthorized = /OIDC|인증/.test(String(error.message || error));
      sendJson(response, unauthorized ? 401 : 503, { error: unauthorized ? "unauthorized" : "reservation webhook unavailable" }, { "Cache-Control": "no-store" });
    }
    return;
  }

  if (instagramRoute?.access === "public") {
    if (instagramRoute.methodNotAllowed) {
      send(response, 405, "Method Not Allowed", { Allow: instagramRoute.allow.join(", ") });
      return;
    }
    proxyInstagramRequest(request, response, {
      target: instagramBridgeTarget,
      targetPath: instagramRoute.targetPath,
      search: url.search,
      timeoutMs: hermesProxyTimeoutMs,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/login") {
    send(response, 200, loginPageV2("", url.searchParams.get("next") || "/"), {
      "Content-Type": "text/html; charset=utf-8",
      "Clear-Site-Data": '"cache", "storage"',
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/login") {
    const form = new URLSearchParams(await collectBody(request));
    const next = safeNextPath(form.get("next") || url.searchParams.get("next") || "/");
    const officeUsername = form.get("user") || "";
    const officePassword = form.get("password") || "";
    const loginLimit = consumeLoginAttempt(request, officeUsername);
    if (!loginLimit.allowed) {
      send(response, 429, loginPageV2("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", next), {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": String(loginLimit.retryAfter),
      });
      return;
    }
    let officePasswordValid = false;
    if (officeUsername === authUser) {
      const verification = await verifyPasswordBounded(officePassword);
      if (verification.busy) {
        send(response, 429, loginPageV2("로그인 처리가 혼잡합니다. 잠시 후 다시 시도해 주세요.", next), {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "1",
        });
        return;
      }
      officePasswordValid = verification.valid;
    }
    if (officeUsername === authUser && officePasswordValid) {
      try {
        if (legacyHermesAuth) {
          await legacyHermesAuth.resolveAuthorization(request, { forceRefresh: true });
          resetLoginRateKey(request, officeUsername);
          const officeCookie = `hermes_office_sid=${encodeURIComponent(makeSession(authUser))}; HttpOnly; SameSite=Lax; ${secureCookie ? "Secure; " : ""}Path=/; Max-Age=43200`;
          send(response, 302, "", { Location: next, "Set-Cookie": officeCookie });
          return;
        }
        const hermesLogin = await loginHermesPassword({
          target: hermesTarget,
          publicOrigin,
          provider: hermesAuthProvider,
          username: form.get("hermes_user") || officeUsername,
          password: form.get("hermes_password") || officePassword,
          request,
          timeoutMs: hermesProxyTimeoutMs,
        });
        if (hermesLogin.status === 200 && hermesLogin.readbackStatus === 200 && hermesLogin.identity?.user_id) {
          resetLoginRateKey(request, officeUsername);
          const officeCookie = `hermes_office_sid=${encodeURIComponent(makeSession(authUser))}; HttpOnly; SameSite=Lax; ${secureCookie ? "Secure; " : ""}Path=/; Max-Age=43200`;
          send(response, 302, "", {
            Location: next,
            "Set-Cookie": [officeCookie, ...hermesLogin.cookies],
          });
          return;
        }
        const message = hermesLogin.status === 401
          ? "Hermes 아이디 또는 비밀번호가 올바르지 않습니다."
          : hermesLogin.status === 429
            ? "Hermes 로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."
            : "Hermes 인증 상태를 확인하지 못했습니다. 서버 설정을 점검해 주세요.";
        send(response, hermesLogin.status === 429 ? 429 : 401, loginPageV2(message, next), { "Content-Type": "text/html; charset=utf-8" });
        return;
      } catch (error) {
        console.error("Hermes password login failed:", error.message);
        send(response, 503, loginPageV2("Hermes 인증 서버에 연결할 수 없습니다.", next), { "Content-Type": "text/html; charset=utf-8" });
        return;
      }
    }
    send(response, 401, loginPageV2("아이디 또는 비밀번호가 올바르지 않습니다. 다시 확인해 주세요.", next), { "Content-Type": "text/html; charset=utf-8" });
    return;
  }
  if (url.pathname === "/logout") {
    // Hermes cookies are scoped to /hermes and are therefore not sent to
    // /logout. Bounce under the scoped path before revoking both sessions.
    send(response, 302, "", { Location: "/hermes/logout" });
    return;
  }
  if (url.pathname === "/hermes/logout") {
    try {
      if (legacyHermesAuth) {
        const binding = officeSessionBinding(request);
        legacyHermesAuth.invalidate();
        legacyHermesWsTickets.revoke("office", binding);
      }
      else await logoutHermes({ target: hermesTarget, publicOrigin, request, timeoutMs: hermesProxyTimeoutMs });
    } catch (error) {
      console.error("Hermes logout failed:", error.message);
    }
    send(response, 302, "", {
      Location: "/login",
      "Set-Cookie": [
        `hermes_office_sid=; HttpOnly; SameSite=Lax; ${secureCookie ? "Secure; " : ""}Path=/; Max-Age=0`,
        ...hermesLogoutCookieDeletions(),
      ],
      "Clear-Site-Data": '"cache", "storage"',
    });
    return;
  }
  if (request.method === "GET" && isPublicPwaAsset(url.pathname)) {
    await serveStatic(request, response, url);
    return;
  }

  if (!currentUser(request)) {
    if (request.headers.accept?.includes("application/json") || url.pathname.startsWith("/bridge/") || url.pathname.startsWith("/hermes/")) {
      sendJson(response, 401, { error: "login required" });
    } else {
      redirectLogin(response, `${url.pathname}${url.search}${url.hash}`);
    }
    return;
  }

  try {
    if (instagramRoute?.access === "admin") {
      if (instagramRoute.methodNotAllowed) {
        send(response, 405, "Method Not Allowed", { Allow: instagramRoute.allow.join(", ") });
      } else if (instagramRoute.notFound) {
        sendJson(response, 404, { error: "not found" });
      } else if (!instagramBridgeAdminToken) {
        sendJson(response, 503, { error: "Instagram bridge admin token is not configured" });
      } else {
        proxyInstagramRequest(request, response, {
          target: instagramBridgeTarget,
          targetPath: instagramRoute.targetPath,
          search: url.search,
          adminToken: instagramBridgeAdminToken,
          timeoutMs: hermesProxyTimeoutMs,
        });
      }
    } else if (request.method === "GET" && url.pathname === "/bridge/reservations/integrations") {
      const verify = url.searchParams.get("refresh") === "1";
      sendJson(response, 200, await getReservationIntegrationStatus({ verify }));
    } else if (request.method === "POST" && url.pathname === "/bridge/reservations/google/client") {
      if (request.headers["x-hermes-setup"] !== "reservation-google-oauth") {
        sendJson(response, 403, { error: "setup confirmation header required" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await collectBody(request, 16 * 1024));
      } catch {
        sendJson(response, 400, { error: "invalid JSON payload" });
        return;
      }
      const saved = await saveReservationGoogleClient({ credentials: payload });
      sendJson(response, 200, saved);
    } else if (request.method === "GET" && url.pathname === "/bridge/reservations/status") {
      sendJson(response, 200, reservationSync.status(), { "Cache-Control": "no-store" });
    } else if (request.method === "GET" && url.pathname === "/bridge/reservations/bookings") {
      sendJson(response, 200, {
        items: reservationSync.listBookings({
          limit: url.searchParams.get("limit") || 100,
          sourcePlatform: url.searchParams.get("source") || "",
          status: url.searchParams.get("status") || "",
        }),
      }, { "Cache-Control": "no-store" });
    } else if (request.method === "GET" && url.pathname.match(/^\/bridge\/reservations\/bookings\/\d+$/)) {
      const booking = reservationSync.getBooking(url.pathname.split("/").at(-1));
      if (!booking) sendJson(response, 404, { error: "reservation not found" }, { "Cache-Control": "no-store" });
      else sendJson(response, 200, booking, { "Cache-Control": "no-store" });
    } else if (request.method === "GET" && url.pathname === "/bridge/reservations/conflicts") {
      sendJson(response, 200, { items: reservationSync.listConflicts() }, { "Cache-Control": "no-store" });
    } else if (request.method === "POST" && url.pathname.match(/^\/bridge\/reservations\/conflicts\/\d+\/acknowledge$/)) {
      let payload;
      try {
        payload = JSON.parse(await collectBody(request, 16 * 1024) || "{}");
      } catch {
        sendJson(response, 400, { error: "invalid JSON payload" });
        return;
      }
      const conflictId = url.pathname.split("/").at(-2);
      sendJson(response, 200, { items: reservationSync.acknowledgeConflict(conflictId, payload.resolution, currentUser(request) || authUser) },
        { "Cache-Control": "no-store" });
    } else if (request.method === "POST" && url.pathname === "/bridge/reservations/sync") {
      const result = await reservationSync.runCycle("operator");
      sendJson(response, 200, result, { "Cache-Control": "no-store" });
    } else if (request.method === "GET" && url.pathname === "/bridge/reservations/google/start") {
      const state = makeReservationOAuthState(request);
      const authorizationUrl = await reservationGoogleAuthorizationUrl({ state });
      send(response, 302, "", { Location: authorizationUrl });
    } else if (request.method === "GET" && url.pathname === "/bridge/reservations/google/callback") {
      if (!validReservationOAuthState(request, url.searchParams.get("state"))) {
        send(response, 302, "", { Location: "/?view=system&system=integration&google=invalid-state" });
        return;
      }
      if (url.searchParams.get("error")) {
        send(response, 302, "", { Location: "/?view=system&system=integration&google=denied" });
        return;
      }
      try {
        await connectReservationGoogle({ code: url.searchParams.get("code") || "" });
        send(response, 302, "", { Location: "/?view=system&system=integration&google=connected" });
      } catch (error) {
        console.error("Reservation Google OAuth failed:", error.message);
        send(response, 302, "", { Location: "/?view=system&system=integration&google=failed" });
      }
    } else if (url.pathname === "/bridge/session") {
      sendJson(response, 404, { error: "not found" });
    } else if (url.pathname.startsWith("/bridge/session-archive")) {
      await handleSessionArchive(request, response, url);
    } else if (url.pathname.startsWith("/bridge/plugins/")) {
      await handlePluginBridge(request, response, url);
    } else if (url.pathname === "/bridge/organization") {
      await handleOrganizationBridge(request, response, url);
    } else if (url.pathname.startsWith("/bridge/files/")) {
      await handleFileBridge(request, response, url);
    } else if (url.pathname === "/bridge/live-screens") {
      await handleLiveScreenBridge(request, response, url);
    } else if (url.pathname.startsWith("/bridge/data-room/")) {
      await handleDataRoom(request, response, url);
    } else if (legacyHermesWsTickets && url.pathname === "/hermes/api/auth/ws-ticket") {
      if (request.method !== "POST") {
        send(response, 405, "Method Not Allowed", { Allow: "POST", "Cache-Control": "no-store" });
        return;
      }
      const binding = officeSessionBinding(request);
      const { token, expiresAt } = legacyHermesWsTickets.issue({ binding, profile: "office", sessionId: binding });
      sendJson(response, 200, { ticket: token, ttl_seconds: 30, expires_at: expiresAt }, { "Cache-Control": "no-store" });
    } else if (url.pathname.startsWith("/hermes/")) {
      const isHermesApi = url.pathname.startsWith("/hermes/api/");
      const isDashboardAssetRequest = request.method === "GET" || request.method === "HEAD";
      if (legacyHermesAuth && !isHermesApi && !isDashboardAssetRequest) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      let serverAuthorization = "";
      if (legacyHermesAuth) {
        try {
          serverAuthorization = await legacyHermesAuth.resolveAuthorization(request);
        } catch {
          sendJson(response, 502, { error: "Hermes upstream unavailable" });
          return;
        }
      }
      proxyHermesHttp(request, response, {
        target: hermesTarget,
        publicOrigin,
        timeoutMs: hermesProxyTimeoutMs,
        serverAuthorization,
        onUnauthorized: () => legacyHermesAuth?.invalidate(),
        blockHtmlResponses: Boolean(legacyHermesAuth && isHermesApi),
        allowSanitizedDashboardHtml: Boolean(legacyHermesAuth && !isHermesApi),
      });
    } else {
      await serveStatic(request, response, url);
    }
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.on("upgrade", async (request, socket, head) => {
  if (!canonicalHostMatches(request)) {
    socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n");
    socket.destroy();
    return;
  }
  let url;
  try {
    url = new URL(request.url, canonicalOrigin || `http://${request.headers.host}`);
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!currentUser(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (url.pathname === "/bridge/live-screens/socket") {
    if (!liveScreenOriginMatches(request, canonicalOrigin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const grant = liveScreenTickets.consume(url.searchParams.get("ticket") || "", officeSessionBinding(request));
    if (!grant) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    upgradeLiveScreenConnection({
      request,
      socket,
      head,
      webSocketServer: liveScreenWebSocketServer,
      grant,
      timeoutMs: hermesProxyTimeoutMs,
      maxConnectionMs: liveScreenConnectionMaxMs,
      onActivity: () => touchSessionLiveView(grant.endpoint, grant.sessionId),
    });
    return;
  }
  if (!url.pathname.startsWith("/hermes/")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  let targetPath = request.url.replace(/^\/hermes/, "") || "/";
  if (legacyHermesAuth && !targetPath.startsWith("/api/")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  let serverAuthorization = "";
  if (legacyHermesAuth) {
    const browserTicket = new URL(targetPath, "http://legacy-hermes.internal").searchParams.get("ticket") || "";
    const ticketGrant = legacyHermesWsTickets.consume(browserTicket, officeSessionBinding(request));
    if (!ticketGrant) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      serverAuthorization = await legacyHermesAuth.resolveAuthorization(request);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
      return;
    }
    targetPath = legacyHermesWebSocketPath(targetPath, serverAuthorization);
  }
  const upgradeTimer = setTimeout(() => {
    socket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
    upstream.destroy();
    socket.destroy();
  }, hermesProxyTimeoutMs);
  const upstream = net.connect(Number(hermesTarget.port || 80), hermesTarget.hostname, () => {
    clearTimeout(upgradeTimer);
    upstream.write(`${request.method} ${targetPath} HTTP/${request.httpVersion}\r\n`);
    upstream.write(rawHeaders({
      ...buildHermesWebSocketHeaders(request, { publicOrigin, serverAuthorization }),
      connection: "Upgrade",
      upgrade: request.headers.upgrade || "websocket",
    }));
    upstream.write("\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => {
    clearTimeout(upgradeTimer);
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => {
    clearTimeout(upgradeTimer);
    upstream.destroy();
  });
});

startGoogleDriveMirror();
reservationSync.start().catch((error) => {
  console.error("Reservation sync failed to start:", error.message);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Greeming Hermes Office listening on ${server.address().port}`);
});
