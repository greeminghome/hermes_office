export function normalizeLiveScreenCdpUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (!['http:', 'https:'].includes(url.protocol)) return "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function parseLiveScreenProfileMap(value = "") {
  const mapped = new Map();
  for (const item of String(value).split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean)) {
    const separator = item.includes("=") ? "=" : ":";
    const [profile, ...rest] = item.split(separator);
    const url = normalizeLiveScreenCdpUrl(rest.join(separator));
    if (profile?.trim() && url) mapped.set(profile.trim(), url);
  }
  return mapped;
}

export function liveScreenEndpointCandidates(profile, profileMap, defaults = []) {
  const exact = profileMap.get(profile);
  if (exact) return [exact];

  if (profile !== "default") return [];

  const candidates = [profileMap.get("default"), ...defaults].filter(Boolean);
  return [...new Set(candidates)];
}

export function liveScreenFallbackEndpoint(profile, profileMap, defaults = []) {
  const candidates = liveScreenEndpointCandidates(profile, profileMap, defaults);
  return candidates.length === 1 ? candidates[0] : "";
}

export function liveScreenRegistryLookupUrl(registryUrl, profile) {
  const base = normalizeLiveScreenCdpUrl(registryUrl);
  if (!base || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(profile || ""))) return "";
  const url = new URL(base);
  url.pathname = `/profiles/${encodeURIComponent(profile)}`;
  return url.toString();
}

export function liveScreenRegistryEndpoint(registryUrl, profile, payload = {}) {
  if (String(payload?.profile || "") !== String(profile || "")) return "";
  const port = Number(payload?.proxyPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "";
  const base = normalizeLiveScreenCdpUrl(registryUrl);
  if (!base) return "";
  const endpoint = new URL(base);
  endpoint.port = String(port);
  return normalizeLiveScreenCdpUrl(endpoint.toString());
}

function comparablePageUrl(value = "") {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function selectLiveScreenFallbackPage(pages = [], { hintUrl = "", focusedPageIds = [] } = {}) {
  const visiblePages = pages.filter((page) => page?.id && comparablePageUrl(page.url));
  const focused = new Set(focusedPageIds);
  const focusedPages = visiblePages.filter((page) => focused.has(page.id));
  if (focusedPages.length === 1) return focusedPages[0];

  const comparableHint = comparablePageUrl(hintUrl);
  if (comparableHint) {
    const hintedPages = visiblePages.filter((page) => comparablePageUrl(page.url) === comparableHint);
    if (hintedPages.length === 1) return hintedPages[0];
  }
  return visiblePages.length === 1 ? visiblePages[0] : null;
}
