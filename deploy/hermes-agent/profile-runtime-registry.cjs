#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function profileList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,;]+/);
  return [...new Set(items.map((item) => String(item || "").trim()).filter((item) => item !== "default" && PROFILE_PATTERN.test(item)))];
}

function discoverProfileDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function normalizePrevious(previous, limit) {
  const entries = Array.isArray(previous?.profiles) ? previous.profiles : [];
  const accepted = new Map();
  const used = new Set();
  for (const entry of entries) {
    const profile = String(entry?.profile || "");
    const index = Number(entry?.index);
    if (profile === "default" || !PROFILE_PATTERN.test(profile) || !Number.isInteger(index) || index < 0 || index >= limit || used.has(index) || accepted.has(profile)) continue;
    accepted.set(profile, { profile, index });
    used.add(index);
  }
  return { accepted, used };
}

function reconcileRegistry({ configuredProfiles = [], discoveredProfiles = [], previous = {}, cdpBase = 9300, proxyBase = 9400, limit = 50 } = {}) {
  const configured = profileList(configuredProfiles);
  const discovered = profileList(discoveredProfiles);
  const activeNames = [...new Set([...configured, ...discovered])];
  if (activeNames.length > limit) throw new Error(`At most ${limit} managed profiles are supported`);
  const { accepted, used } = normalizePrevious(previous, limit);
  for (const profile of activeNames) {
    if (accepted.has(profile)) continue;
    let index = 0;
    while (used.has(index) && index < limit) index += 1;
    if (index >= limit) throw new Error("No browser profile slots remain");
    accepted.set(profile, { profile, index });
    used.add(index);
  }
  const active = new Set(activeNames);
  const profiles = [...accepted.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => ({
      ...entry,
      cdpPort: Number(cdpBase) + entry.index,
      proxyPort: Number(proxyBase) + entry.index,
      active: active.has(entry.profile),
    }));
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    cdpBase: Number(cdpBase),
    proxyBase: Number(proxyBase),
    limit,
    profiles,
  };
}

function readJson(file) {
  try { return readPreviousRegistry(file); } catch { return {}; }
}

function readPreviousRegistry(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Profile registry is unreadable; refusing to reassign browser slots", { cause: error });
  }
  const names = new Set();
  const indexes = new Set();
  if (!Array.isArray(state?.profiles) || state.profiles.some((entry) => {
    if (!entry || entry.profile === "default" || !PROFILE_PATTERN.test(entry.profile || "") ||
        !Number.isInteger(entry.index) || entry.index < 0 || names.has(entry.profile) || indexes.has(entry.index)) return true;
    names.add(entry.profile);
    indexes.add(entry.index);
    return false;
  })) throw new Error("Profile registry is invalid; refusing to reassign browser slots");
  return state;
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function syncRegistry(options = {}) {
  const stateFile = options.stateFile || process.env.HERMES_PROFILE_RUNTIME_REGISTRY || "/opt/data/browser-profile-runtime.json";
  const profilesRoot = options.profilesRoot || process.env.HERMES_PROFILE_DISCOVERY_ROOT || "/opt/data/profiles";
  const state = reconcileRegistry({
    configuredProfiles: options.configuredProfiles ?? process.env.HERMES_GATEWAY_PROFILES ?? "",
    discoveredProfiles: options.discoveredProfiles ?? discoverProfileDirectories(profilesRoot),
    previous: readPreviousRegistry(stateFile),
    cdpBase: Number(options.cdpBase ?? process.env.HERMES_PROFILE_CDP_BASE_PORT ?? 9300),
    proxyBase: Number(options.proxyBase ?? process.env.HERMES_PROFILE_CDP_PROXY_BASE_PORT ?? 9400),
    limit: Number(options.limit ?? process.env.HERMES_PROFILE_LIMIT ?? 50),
  });
  writeJsonAtomic(stateFile, state);
  return state;
}

function serveRegistry() {
  const stateFile = process.env.HERMES_PROFILE_RUNTIME_REGISTRY || "/opt/data/browser-profile-runtime.json";
  const host = process.env.HERMES_PROFILE_REGISTRY_HOST || "0.0.0.0";
  const port = Number(process.env.HERMES_PROFILE_REGISTRY_PORT || 9299);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const state = readJson(stateFile);
    const activeProfiles = (Array.isArray(state.profiles) ? state.profiles : []).filter((entry) => entry.active === true);
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, profileCount: activeProfiles.length }));
      return;
    }
    const match = request.method === "GET" ? url.pathname.match(/^\/profiles\/([^/]+)$/) : null;
    let requested = "";
    try { requested = match ? decodeURIComponent(match[1]) : ""; } catch { /* malformed paths fail closed */ }
    const entry = PROFILE_PATTERN.test(requested) ? activeProfiles.find((item) => item.profile === requested) : null;
    if (!entry) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "profile runtime is not active" }));
      return;
    }
    response.statusCode = 200;
    response.end(JSON.stringify({ profile: entry.profile, index: entry.index, cdpPort: entry.cdpPort, proxyPort: entry.proxyPort }));
  });
  server.listen(port, host, () => console.log(`Hermes profile runtime registry listening on ${host}:${port}`));
}

function main() {
  const command = process.argv[2] || "sync";
  if (command === "serve") return serveRegistry();
  if (command !== "sync") throw new Error(`Unknown command: ${command}`);
  const state = syncRegistry();
  for (const entry of state.profiles.filter((item) => item.active)) {
    process.stdout.write(`${entry.profile}\t${entry.index}\t${entry.cdpPort}\t${entry.proxyPort}\n`);
  }
}

if (require.main === module) main();

module.exports = { PROFILE_PATTERN, discoverProfileDirectories, profileList, reconcileRegistry, syncRegistry };
