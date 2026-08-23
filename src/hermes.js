import { normalizeUiProfiles, normalizeUiSession, toHermesProfileId, toUiProfileId } from "./profileIds.js";

const API_ROOT = "/hermes";
const WORKSPACE_CACHE_KEY = "hermes-office-workspace-snapshot";

const apiCache = new Map();
const inflightRequests = new Map();

export class HermesRequestError extends Error {
  constructor(message, { code = "HERMES_REQUEST_ERROR", transient = false, cause } = {}) {
    super(message, { cause });
    this.name = "HermesRequestError";
    this.code = code;
    this.transient = transient;
  }
}

export function isRequestCancellation(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export function isTransientRequestError(error) {
  return Boolean(error?.transient || error?.name === "TimeoutError" || error?.code === "HERMES_TIMEOUT" || error?.code === "HERMES_TRANSPORT_INTERRUPTED");
}

function timeoutReason(label) {
  return new DOMException(`${label} timed out`, "TimeoutError");
}

function classifyFetchFailure(error, { externalSignal, internalSignal, label }) {
  if (externalSignal?.aborted) return externalSignal.reason ?? error;
  if (internalSignal?.aborted || error?.name === "TimeoutError") {
    return new HermesRequestError(`${label} 응답이 지연되고 있습니다.`, {
      code: "HERMES_TIMEOUT",
      transient: true,
      cause: error,
    });
  }
  if (isRequestCancellation(error)) {
    return new HermesRequestError(`${label} 연결이 전환되어 다시 동기화합니다.`, {
      code: "HERMES_TRANSPORT_INTERRUPTED",
      transient: true,
      cause: error,
    });
  }
  return error;
}

function now() {
  return Date.now();
}

function requestMethod(options = {}) {
  return String(options.method ?? "GET").toUpperCase();
}

function cacheKey(path, options = {}) {
  return `${requestMethod(options)} ${path}`;
}

function clearApiCache() {
  apiCache.clear();
  inflightRequests.clear();
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("hermes-office-profile-sessions:") ||
        key.startsWith("hermes-office-session-messages:") ||
        key === WORKSPACE_CACHE_KEY)
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Cache invalidation should never block the user action.
  }
}

function clearSessionListCache() {
  apiCache.forEach((_value, key) => {
    if (key.includes("/api/profiles/sessions")) apiCache.delete(key);
  });
  inflightRequests.forEach((_value, key) => {
    if (key.includes("/api/profiles/sessions")) inflightRequests.delete(key);
  });
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("hermes-office-profile-sessions:") ||
        key === WORKSPACE_CACHE_KEY)
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Cache invalidation should never block the user action.
  }
}

function cacheSet(key, value, ttlMs) {
  if (!ttlMs) return;
  apiCache.set(key, { value, expiresAt: now() + ttlMs });
}

function cacheGet(key) {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < now()) {
    apiCache.delete(key);
    return null;
  }
  return entry.value;
}

function currentReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
}

function redirectToLogin() {
  const next = encodeURIComponent(currentReturnPath());
  window.location.assign(`/login?next=${next}`);
}

function isAuthError(response) {
  return response.status === 401 || response.status === 403;
}

async function hermesErrorMessage(response) {
  const fallback = `Hermes API 오류 (${response.status})`;
  try {
    const text = await response.text();
    if (!text) return fallback;
    try {
      const payload = JSON.parse(text);
      const detail = payload.detail ?? payload.error ?? payload.message;
      if (typeof detail === "string" && detail.trim()) return `${fallback}: ${detail}`;
      if (Array.isArray(detail) && detail.length) {
        return `${fallback}: ${detail.map((item) => item.msg ?? item.message ?? JSON.stringify(item)).join(", ")}`;
      }
    } catch {
      return `${fallback}: ${text.slice(0, 240)}`;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export async function loadHermesAuthState() {
  const response = await fetch(`${API_ROOT}/api/auth/me`, { cache: "no-store", credentials: "same-origin" });
  if (isAuthError(response)) return { authenticated: false, identity: null };
  if (!response.ok) throw new Error(await hermesErrorMessage(response));
  return { authenticated: true, identity: await response.json() };
}

export async function mintHermesWsTicket() {
  const response = await fetch(`${API_ROOT}/api/auth/ws-ticket`, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (isAuthError(response)) {
    redirectToLogin();
    throw new Error("Hermes 로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }
  if (!response.ok) throw new Error(await hermesErrorMessage(response));
  const payload = await response.json();
  if (!payload.ticket) throw new Error("Hermes가 WebSocket 티켓을 발급하지 않았습니다.");
  return payload.ticket;
}

async function hermesFetchNetwork(path, options = {}) {
  const { timeoutMs = 12000, ...fetchOptions } = options;
  const controller = new AbortController();
  const externalSignal = fetchOptions.signal;
  const timeout = externalSignal ? 0 : window.setTimeout(() => controller.abort(timeoutReason("Hermes API")), timeoutMs);
  const headers = {
    "Content-Type": "application/json",
    ...fetchOptions.headers,
  };
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...fetchOptions,
      credentials: "same-origin",
      signal: externalSignal ?? controller.signal,
      headers,
    });
  } catch (error) {
    throw classifyFetchFailure(error, { externalSignal, internalSignal: controller.signal, label: "Hermes API" });
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }

  if (isAuthError(response)) {
    redirectToLogin();
    throw new Error("Hermes 로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }
  if (!response.ok) throw new Error(await hermesErrorMessage(response));
  return response.json();
}

export async function hermesFetch(path, options = {}) {
  const method = requestMethod(options);
  const isRead = method === "GET";
  const {
    cacheTtlMs = isRead ? 5000 : 0,
    dedupe = isRead,
    ...networkOptions
  } = options;
  const key = cacheKey(path, { method });

  if (isRead && cacheTtlMs) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  if (isRead && dedupe && inflightRequests.has(key)) return inflightRequests.get(key);
  if (!isRead) clearApiCache();

  const fetchWithRecovery = async () => {
    try {
      return await hermesFetchNetwork(path, networkOptions);
    } catch (error) {
      if (!isRead || !isTransientRequestError(error) || networkOptions.signal?.aborted) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      return hermesFetchNetwork(path, networkOptions);
    }
  };
  const request = fetchWithRecovery().then((payload) => {
    if (isRead) cacheSet(key, payload, cacheTtlMs);
    return payload;
  });

  if (isRead && dedupe) {
    inflightRequests.set(key, request);
    request.finally(() => inflightRequests.delete(key)).catch(() => {});
  }

  return request;
}

function profileQuery(profile) {
  const hermesProfile = toHermesProfileId(profile);
  return hermesProfile ? `profile=${encodeURIComponent(hermesProfile)}` : "";
}

function profileSuffix(profile) {
  const query = profileQuery(profile);
  return query ? `?${query}` : "";
}

function sessionArchiveKey(profile, sessionId) {
  return `${profile || "default"}:${sessionId}`;
}

function readLocalCache(key, maxAgeMs) {
  try {
    const cached = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!cached || now() - Number(cached.savedAt ?? 0) > maxAgeMs) return null;
    return cached.value;
  } catch {
    return null;
  }
}

function writeLocalCache(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ value, savedAt: now() }));
  } catch {
    // Local cache is optional.
  }
}

async function fetchBridgeJson(path, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(timeoutReason("Hermes bridge")), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(path, {
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      throw classifyFetchFailure(error, { internalSignal: controller.signal, label: "Hermes 브리지" });
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Bridge request failed");
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function decodeHermesText(value) {
  if (typeof value !== "string" || !value) return value ?? "";
  const codes = [...value].map((character) => character.charCodeAt(0));
  if (codes.some((code) => code > 255)) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(codes));
  } catch {
    return value;
  }
}

export function isMeetingSession(session) {
  const text = decodeHermesText(`${session.title ?? ""}\n${session.preview ?? ""}`);
  return text.includes("[Hermes AI 팀 회의") ||
    text.includes("[회의 종합 및 종료]") ||
    text.includes("[미팅]");
}

export async function loadArchivedSessions(profile = "") {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const payload = await fetchBridgeJson(`/bridge/session-archive${query}`, { timeoutMs: 5000 });
  return payload.archivedSessions ?? {};
}

function archivedSessionRecord(session, archivedSessions, profile) {
  if (!session?.id) return false;
  const sourceProfile = profile || session.profile || "default";
  const candidates = new Set([
    sourceProfile,
    toUiProfileId(sourceProfile),
    toHermesProfileId(toUiProfileId(sourceProfile)),
  ]);
  return [...candidates]
    .map((candidate) => archivedSessions[sessionArchiveKey(candidate, session.id)])
    .find(Boolean) ?? null;
}

export function isArchivedSession(session, archivedSessions, profile) {
  return Boolean(archivedSessionRecord(session, archivedSessions, profile));
}

export async function archiveChatSession(profile, sessionId) {
  clearSessionListCache();
  const response = await fetch("/bridge/session-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, sessionId }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "세션을 보관하지 못했습니다.");
  clearSessionListCache();
  return payload.archived;
}

export async function loadPluginState() {
  const response = await fetch("/bridge/plugins/state", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Plugin 상태를 불러오지 못했습니다.");
  return payload;
}

async function postPluginAction(path, profile, item) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, item }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Plugin 작업을 완료하지 못했습니다.");
  return payload;
}

export function installPlugin(profile, item) {
  return postPluginAction("/bridge/plugins/install", profile, item);
}

export function testPlugin(profile, item) {
  return postPluginAction("/bridge/plugins/test", profile, item);
}

export async function loadHermesMcpCatalog(profile = "") {
  const suffix = profileSuffix(profile);
  const payload = await hermesFetch(`/api/mcp/catalog${suffix}`, {
    cacheTtlMs: 300000,
    timeoutMs: 12000,
  });
  return Array.isArray(payload) ? payload : payload.entries ?? payload.catalog ?? payload.items ?? payload.servers ?? [];
}

export async function loadHermesMcpServers(profile = "") {
  const suffix = profileSuffix(profile);
  const payload = await hermesFetch(`/api/mcp/servers${suffix}`, {
    cacheTtlMs: 30000,
    timeoutMs: 12000,
  });
  return Array.isArray(payload) ? payload : payload.servers ?? payload.items ?? payload.value ?? [];
}

export async function installHermesMcp(name, env = {}, enable = true, profile = "") {
  const hermesProfile = toHermesProfileId(profile);
  return hermesFetch("/api/mcp/catalog/install", {
    method: "POST",
    body: JSON.stringify({ name, env, enable, ...(hermesProfile ? { profile: hermesProfile } : {}) }),
    timeoutMs: 120000,
  });
}

export async function testHermesMcp(name, profile = "") {
  const suffix = profileSuffix(profile);
  return hermesFetch(`/api/mcp/servers/${encodeURIComponent(name)}/test${suffix}`, {
    method: "POST",
    body: JSON.stringify({}),
    timeoutMs: 60000,
  });
}

export async function loadHermesToolsets(profile = "") {
  const suffix = profileSuffix(profile);
  const payload = await hermesFetch(`/api/tools/toolsets${suffix}`, {
    cacheTtlMs: 30000,
    timeoutMs: 12000,
  });
  return Array.isArray(payload) ? payload : payload.toolsets ?? payload.items ?? payload.value ?? [];
}

export async function toggleHermesToolset(name, enabled, profile = "") {
  const suffix = profileSuffix(profile);
  return hermesFetch(`/api/tools/toolsets/${encodeURIComponent(name)}${suffix}`, {
    method: "PUT",
    body: JSON.stringify({ enabled: Boolean(enabled) }),
    timeoutMs: 30000,
  });
}

export async function loadOrganization() {
  return fetchBridgeJson("/bridge/organization", { timeoutMs: 8000 });
}

export async function saveOrganization(nodes, baseRevision) {
  const response = await fetch("/bridge/organization", {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, baseRevision }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "조직 구조를 저장하지 못했습니다.");
    error.status = response.status;
    error.current = payload.current;
    throw error;
  }
  return payload;
}

export async function loadComputerUseStatus(profile = "") {
  const suffix = profileSuffix(profile);
  return hermesFetch(`/api/tools/computer-use/status${suffix}`, {
    cacheTtlMs: 15000,
    timeoutMs: 15000,
  });
}

async function instagramAdminFetch(path, options = {}) {
  const response = await fetch(`/bridge/instagram${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (isAuthError(response)) {
    redirectToLogin();
    throw new Error("로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }
  const text = await response.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message ?? payload.error ?? payload.message ?? `Instagram 연동 오류 (${response.status})`);
  }
  return payload;
}

export function loadInstagramStatus(profileId = "") {
  const query = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
  return instagramAdminFetch(`/status${query}`);
}

export function connectInstagram(profileId) {
  return instagramAdminFetch("/connect", {
    method: "POST",
    body: JSON.stringify({ profile_id: profileId, redirect_path: "/?view=plugins" }),
  });
}

export function refreshInstagram(profileId, accountId) {
  return instagramAdminFetch("/refresh", {
    method: "POST",
    body: JSON.stringify({ profile_id: profileId, account_id: accountId }),
  });
}

export function disconnectInstagram(profileId, accountId) {
  const query = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
  return instagramAdminFetch(`/accounts/${encodeURIComponent(accountId)}${query}`, {
    method: "DELETE",
  });
}

export async function loadProfileSessions(profile, limit = 30, { includeMeetings = true, includeArchived = false, archivedSessions: archiveSnapshot = null } = {}) {
  const query = new URLSearchParams({
    limit: String(limit),
    offset: "0",
    min_messages: "1",
    order: "recent",
  });
  if (profile) query.set("profile", toHermesProfileId(profile));
  const [payload, archivedSessions] = await Promise.all([
    hermesFetch(`/api/profiles/sessions?${query}`, { cacheTtlMs: 20000 }),
    archiveSnapshot ? Promise.resolve(archiveSnapshot) : loadArchivedSessions(profile),
  ]);
  const sessions = (payload.sessions ?? []).map((session) => normalizeUiSession(session, profile));
  const visibleSessions = includeArchived
    ? sessions.map((session) => ({
      ...session,
      archived: isArchivedSession(session, archivedSessions, profile),
      archived_at: archivedSessionRecord(session, archivedSessions, profile)?.archivedAt,
    }))
    : sessions.filter((session) => !isArchivedSession(session, archivedSessions, profile));
  const result = includeMeetings ? visibleSessions : visibleSessions.filter((session) => !isMeetingSession(session));
  const localKey = `hermes-office-profile-sessions:${query.toString()}:${includeMeetings ? "all" : "direct"}:${includeArchived ? "with-archive" : "active"}`;
  writeLocalCache(localKey, result);
  return result;
}

export async function loadSessionMessages(sessionId, profile) {
  const suffix = profileQuery(profile);
  const localKey = `hermes-office-session-messages:${profile ?? "all"}:${sessionId}`;
  const cached = readLocalCache(localKey, 60 * 1000);
  if (cached) return cached;
  const payload = await hermesFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix ? `?${suffix}` : ""}`,
    { cacheTtlMs: 20000 },
  );
  const messages = payload.messages ?? [];
  writeLocalCache(localKey, messages);
  return messages;
}

export async function loadProfileCapabilities(profile) {
  const suffix = profileQuery(profile);
  const entries = await Promise.allSettled([
    hermesFetch(`/api/skills?${suffix}`, { cacheTtlMs: 300000 }),
    hermesFetch(`/api/tools/toolsets?${suffix}`, { cacheTtlMs: 300000 }),
    hermesFetch(`/api/dashboard/plugins?${suffix}`, { cacheTtlMs: 300000 }),
    hermesFetch(`/api/mcp/servers?${suffix}`, { cacheTtlMs: 300000 }),
    hermesFetch(`/api/cron/jobs?${suffix}`, { cacheTtlMs: 120000 }),
  ]);
  const value = (index, fallback) =>
    entries[index].status === "fulfilled" ? entries[index].value : fallback;
  const skills = value(0, []);
  const toolsets = value(1, []);
  const plugins = value(2, {});
  const mcp = value(3, {});
  const cron = value(4, []);
  return {
    skills: Array.isArray(skills) ? skills : skills.value ?? [],
    toolsets: Array.isArray(toolsets) ? toolsets : toolsets.value ?? [],
    plugins: plugins.plugins ?? plugins.value ?? [],
    mcp: mcp.servers ?? mcp.value ?? [],
    cron: Array.isArray(cron) ? cron : cron.jobs ?? cron.value ?? [],
  };
}

function normalizeModelList(payload) {
  if (Array.isArray(payload?.providers)) {
    return payload.providers.flatMap((provider) => {
      const providerId = provider.slug ?? provider.id ?? provider.name ?? provider.provider ?? "";
      const providerLabel = provider.label ?? provider.display_name ?? provider.name ?? providerId;
      const capabilities = provider.capabilities ?? {};
      const prices = provider.pricing ?? {};
      return (provider.models ?? []).map((model) => {
        const id = typeof model === "string" ? model : model.id ?? model.name ?? model.model ?? model.value;
        if (!id) return null;
        const capability = capabilities[id] ?? {};
        return {
          id,
          label: typeof model === "string" ? model : model.label ?? model.display_name ?? model.name ?? id,
          provider: providerId,
          providerLabel,
          contextLength: typeof model === "string" ? "" : model.context_length ?? model.contextLength ?? model.effective_context_length ?? "",
          authenticated: provider.authenticated,
          warning: provider.warning ?? "",
          pricing: prices[id] ?? null,
          fast: capability.fast,
          reasoning: capability.reasoning,
        };
      }).filter(Boolean);
    });
  }
  const candidates = payload?.models ?? payload?.data ?? payload?.items ?? payload?.value ?? payload;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((item) => {
      if (typeof item === "string") return { id: item, label: item, provider: "" };
      const id = item.id ?? item.name ?? item.model ?? item.value;
      if (!id) return null;
      return {
        id,
        label: item.label ?? item.display_name ?? item.name ?? id,
        provider: item.provider ?? item.owned_by ?? item.vendor ?? "",
        contextLength: item.context_length ?? item.contextLength ?? item.effective_context_length ?? "",
      };
    })
    .filter(Boolean);
}

export async function loadAvailableModels() {
  const payload = await hermesFetch("/api/model/options?include_unconfigured=1", {
    timeoutMs: 7000,
    cacheTtlMs: 600000,
  });
  return normalizeModelList(payload);
}

export async function uploadChatFiles(conversation, files) {
  clearApiCache();
  const body = new FormData();
  [...files].forEach((file) => body.append("files", file));
  const response = await fetch(`/bridge/files/upload?conversation=${encodeURIComponent(conversation)}`, {
    method: "POST",
    body,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "파일 업로드에 실패했습니다.");
  return payload;
}

export async function prepareChatFiles(conversation) {
  clearApiCache();
  const response = await fetch(`/bridge/files/prepare?conversation=${encodeURIComponent(conversation)}`, {
    method: "POST",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "채팅 파일 폴더를 준비하지 못했습니다.");
  return payload;
}

export async function loadChatFiles(conversation) {
  if (!conversation) return { files: [], outputDirectory: "" };
  const key = `FILES ${conversation}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const response = await fetch(`/bridge/files/list?conversation=${encodeURIComponent(conversation)}`, {
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "파일 목록을 불러오지 못했습니다.");
  cacheSet(key, payload, 10000);
  return payload;
}

export async function loadLiveScreen(profile, sessionId, targetId, url = "", browserSessionId = "", passive = false) {
  const query = new URLSearchParams();
  if (profile) query.set("profile", toHermesProfileId(profile));
  if (sessionId) query.set("sessionId", sessionId);
  if (targetId) query.set("targetId", targetId);
  if (browserSessionId) query.set("browserSessionId", browserSessionId);
  if (url) query.set("url", url);
  if (passive) query.set("passive", "1");
  const suffix = query.toString() ? `?${query}` : "";
  const payload = await fetchBridgeJson(`/bridge/live-screens${suffix}`, { timeoutMs: 7000 });
  return payload;
}

export async function releaseLiveScreen(profile, sessionId) {
  if (!profile || !sessionId) return;
  const query = new URLSearchParams({ profile: toHermesProfileId(profile), sessionId });
  await fetch(`/bridge/live-screens?${query}`, { method: "DELETE", cache: "no-store" });
}

export function chatFileUrl(conversation, file, inline = false) {
  const query = new URLSearchParams({
    conversation,
    scope: file.scope,
    name: file.name,
  });
  if (inline) query.set("inline", "1");
  return `/bridge/files/download?${query}`;
}

export async function deleteChatFile(conversation, file) {
  clearApiCache();
  const query = new URLSearchParams({
    conversation,
    scope: file.scope,
    name: file.name,
  });
  const response = await fetch(`/bridge/files/item?${query}`, { method: "DELETE" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "파일 삭제에 실패했습니다.");
  return payload;
}

export function createPtyUrl(ticket, channel, resumeSessionId) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ ticket, channel });
  if (resumeSessionId) params.set("resume", resumeSessionId);
  return `${protocol}//${window.location.host}/hermes/api/pty?${params}`;
}

export async function loadWorkspace() {
  const [statsResult, profilesResult, modelResult, sessionsResult, archiveResult] = await Promise.allSettled([
    hermesFetch("/api/sessions/stats", { cacheTtlMs: 15000 }),
    hermesFetch("/api/profiles", { cacheTtlMs: 60000 }),
    hermesFetch("/api/model/info", { cacheTtlMs: 60000 }),
    hermesFetch("/api/profiles/sessions?limit=12&offset=0&min_messages=1&order=recent", {
      timeoutMs: 7000,
      cacheTtlMs: 15000,
    }),
    loadArchivedSessions(),
  ]);

  const stats = statsResult.status === "fulfilled" ? statsResult.value : {};
  const profiles = profilesResult.status === "fulfilled" ? profilesResult.value : {};
  const model = modelResult.status === "fulfilled" ? modelResult.value : {};
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : {};
  const archivedSessions = archiveResult.status === "fulfilled" ? archiveResult.value : {};
  const visibleSessions = (sessions.sessions ?? [])
    .filter((session) => !isArchivedSession(session, archivedSessions, session.profile))
    .map((session) => normalizeUiSession(session));

  if (profilesResult.status === "rejected" && modelResult.status === "rejected") {
    throw new Error("Hermes 핵심 상태를 불러오지 못했습니다.");
  }

  const workspace = {
    stats,
    profiles: normalizeUiProfiles(profiles.profiles ?? []),
    sessions: visibleSessions,
    model,
  };
  try {
    window.localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify({ workspace, savedAt: now() }));
  } catch {
    // Local storage can be unavailable in private contexts.
  }
  return workspace;
}

export function loadCachedWorkspace(maxAgeMs = 15 * 60 * 1000) {
  try {
    const cached = JSON.parse(window.localStorage.getItem(WORKSPACE_CACHE_KEY) || "null");
    if (!cached?.workspace) return null;
    if (now() - Number(cached.savedAt ?? 0) > maxAgeMs) return null;
    return {
      ...cached.workspace,
      profiles: normalizeUiProfiles(cached.workspace.profiles ?? []),
      sessions: (Array.isArray(cached.workspace.sessions) ? cached.workspace.sessions : [])
        .map((session) => normalizeUiSession(session)),
    };
  } catch {
    return null;
  }
}
