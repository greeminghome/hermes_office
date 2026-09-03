import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

test("Hermes browser routing isolates every durable chat session", async () => {
  const [server, proxy, browserTool, browserCdpPatch, profileAudit, ownershipAudit, officeRouteAudit, entrypoint] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/overrides/cdp-http-proxy.js", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/overrides/browser_tool.py", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/patch-browser-cdp-route.py", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/audit-browser-profile-isolation.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/audit-browser-session-ownership.py", import.meta.url), "utf8"),
    readFile(new URL("../deploy/scripts/audit-live-screen-profile-routes.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/entrypoint.sh", import.meta.url), "utf8"),
  ]);

  assert.match(proxy, /Target\.createBrowserContext/);
  assert.match(proxy, /Target\.createTarget", \{ url: "about:blank", browserContextId \}/);
  assert.match(proxy, /Browser context belongs to another Hermes session/);
  assert.match(proxy, /isolation: "browser-context"/);
  assert.match(proxy, /url\.pathname === "\/__session_tabs"/);
  assert.match(proxy, /hardTabLimit/);
  assert.doesNotMatch(proxy, /const reusable = targets\.find/);
  assert.match(browserTool, /get_current_session_key\(default=""\)/);
  assert.match(browserTool, /effective_task_id = _effective_task_id\(task_id\)/);
  assert.match(browserTool, /_browser_routes_by_session\[key\]/);
  assert.match(browserTool, /_get_cdp_override\(task_id\)/);
  assert.match(browserTool, /_registered_browser_route\(task_id\)/);
  assert.match(browserTool, /def _profile_browser_route_for_session/);
  assert.match(browserTool, /SELECT 1 FROM sessions WHERE id = \? LIMIT 1/);
  assert.match(browserTool, /if len\(matches\) != 1/);
  assert.match(browserTool, /profile_override, _ = _profile_browser_route_for_session\(task_id\)/);
  assert.match(browserTool, /profile_router[\s\S]*?or registered_router/);
  assert.match(browserTool, /def register_browser_session_profile/);
  assert.match(browserTool, /def register_browser_session_workspace/);
  assert.match(browserTool, /def browser_workspace_id/);
  assert.doesNotMatch(browserTool, /if candidate:\s*\n\s*return candidate/);
  assert.match(browserTool, /def browser_session_endpoint/);
  assert.match(browserTool, /HERMES_BROWSER_SESSION_OWNER_DIR/);
  assert.match(browserTool, /os\.replace\(temporary, path\)/);
  assert.match(browserTool, /"profileIndex": profile_index/);
  assert.match(browserTool, /def _browser_route_for_profile_index/);
  assert.match(browserTool, /profiles\[profile_index\] != profile/);
  assert.match(entrypoint, /HERMES_GATEWAY_PROFILES="\$\{profiles\}"/);
  assert.match(entrypoint, /HERMES_PROFILE_CDP_BASE_PORT="\$\{profile_cdp_base\}"/);
  assert.match(browserTool, /persisted = _persisted_browser_session_route\(key\)/);
  assert.match(browserTool, /if persisted\[0\]:[\s\S]*?return persisted/);
  const activeBrowserCdpResolver = browserCdpPatch.match(/new_resolver = '''([\s\S]*?)'''\s*\n\s*if new_resolver/)?.[1] || "";
  assert.match(activeBrowserCdpResolver, /routed = \(browser_session_endpoint\(task_id\) or ""\)\.strip\(\)/);
  assert.doesNotMatch(activeBrowserCdpResolver, /if task_id:\s*\n\s*routed =/);
  assert.match(profileAudit, /configuredProfiles\.map\(\(profile, index\)/);
  assert.match(profileAudit, /Target\.attachToTarget", "Target\.activateTarget", "Target\.closeTarget/);
  assert.match(profileAudit, /crossProfilePassiveProbes/);
  assert.match(profileAudit, /await cleanup\(\)/);
  assert.match(ownershipAudit, /workspace-present-in-multiple-profiles/);
  assert.match(ownershipAudit, /database-owner-route-mismatch/);
  assert.match(ownershipAudit, /cross-profile-workspace-alias/);
  assert.match(officeRouteAudit, /foreign\.body\?\.activity \|\| null, null/);
  assert.match(officeRouteAudit, /sessionBindingMismatchRejected/);
  assert.match(officeRouteAudit, /Office route audit cleanup failed/);
  assert.match(server, /const sessionScoped = Boolean\(sessionId\)/);
  assert.match(server, /if \(!sessionScoped && !routed\.activity\)/);
});

test("browser targets propagate from chat into Office and retain the session identity", async () => {
  const [chat, gateway] = await Promise.all([
    source("ProfileChat.jsx"),
    readFile(new URL("../deploy/hermes-agent/overrides/tui_gateway_server.py", import.meta.url), "utf8"),
  ]);

  assert.match(chat, /sessionId:\s*event\.session_id/);
  assert.match(chat, /const liveBrowserScopeId = thread\.browserSessionId \|\| thread\.storedSessionId \|\| ""/);
  assert.match(chat, /current\.browserSessionId \|\| current\.storedSessionId \|\| event\.session_id/);
  assert.match(chat, /activeProfile,[\s\S]*?liveBrowserScopeId,[\s\S]*?liveBrowserScopeId,[\s\S]*?true,/);
  assert.match(chat, /onActivityChange\?\.\(profileName, targetActivity\)/);
  assert.match(chat, /if \(!activeSessionId \|\| !liveBrowserScopeId \|\| !thread\.browserRequested\) return undefined/);
  assert.match(chat, /liveSelection\.followAgent \? "" : liveSelection\.targetId/);
  assert.match(chat, /workspace=\{liveWorkspace\}/);
  assert.match(chat, /await loadLiveScreen\([\s\S]*?activeProfile[\s\S]*?activeSessionId[\s\S]*?true,/);
  assert.match(chat, /browserSessionId: payload\.browser_workspace_id \|\| current\.browserSessionId/);
  assert.match(chat, /browserSessionId: result\.info\?\.browser_workspace_id \|\| storedSessionId/);
  assert.match(chat, /browserRequested: false,[\s\S]*?browserSessionId: sessionId/);
  assert.match(chat, /payload\?\.activity\?\.view\?\.viewerSocketUrl[\s\S]*?payload\?\.workspace\?\.tabs\?\.length/);
  assert.match(gateway, /"browser_workspace_id": str\(/);
  assert.match(gateway, /resolve_browser_workspace_id\(key\) or key/);
  assert.match(gateway, /return _session_info\(agent, session\)/);
});

test("Office resolves the selected profile through the passive Live Screen bridge", async () => {
  const office = await source("HermesOffice.jsx");

  assert.match(office, /const observedLiveProfile = officeChatAgent \|\| fullscreenLiveAgent \|\| selectedAgent/);
  assert.match(office, /const observedLiveScopeId = observedViewBrowserSessionId[\s\S]*?\|\| observedDurableSessionId/);
  assert.match(office, /await loadLiveScreen\([\s\S]*?observedLiveProfile[\s\S]*?observedLiveScopeId[\s\S]*?true,/);
  assert.match(office, /payload\?\.activity\?\.view\?\.viewerSocketUrl \? payload\.activity : null/);
  assert.match(office, /observedLiveSelection\.followAgent \? "" : observedLiveSelection\.targetId/);
  assert.match(office, /setOfficeLiveWorkspaces/);
  assert.match(office, /workspace=\{officeLiveWorkspaces\[officeChatAgent\]\}/);
  assert.doesNotMatch(office, /\}, \[agentActivities, observedLiveProfile, observedLiveSessionId\]\);/);
  assert.match(office, /activity=\{resolvedAgentActivities\[officeChatAgent\]\}/);
});

test("Live Screen frame and input flow keeps explicit CDP evidence", async () => {
  const live = await source("LiveScreen.jsx");

  assert.match(live, /send\("Page\.startScreencast"/);
  assert.match(live, /send\("Page\.screencastFrameAck"/);
  assert.match(live, /drawImage\(bitmap, 0, 0\)/);
  assert.match(live, /transport: "binary"/);
  assert.match(live, /window\.createImageBitmap/);
  assert.match(live, /setHasFrame\(true\)/);
  assert.match(live, /sendControl\("Input\.dispatchMouseEvent"/);
  assert.match(live, /sendControl\("Input\.dispatchKeyEvent"/);
  assert.match(live, /sendControl\("Input\.insertText"/);
  assert.match(live, /const controlSocketRef = useRef/);
  assert.match(live, /void connectControl\(\)/);
});

test("mobile chat exposes the Live launcher for a restored workspace", async () => {
  const chat = await source("ProfileChat.jsx");

  assert.match(chat, /window\.matchMedia\("\(max-width: 900px\)"\)/);
  assert.match(chat, /\(compact \|\| narrowViewport\) && liveViewAvailable/);
});

test("browser lifecycle closes 24-hour idle pages, recreates them, and fully disposes ended sessions", async () => {
  const [server, proxy, browserTool, gateway, entrypoint] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/overrides/cdp-http-proxy.js", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/overrides/browser_tool.py", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/overrides/tui_gateway_server.py", import.meta.url), "utf8"),
    readFile(new URL("../deploy/hermes-agent/entrypoint.sh", import.meta.url), "utf8"),
  ]);

  assert.match(proxy, /CDP_PROXY_SESSION_TTL_MS \|\| 24 \* 60 \* 60 \* 1000/);
  assert.match(proxy, /Target\.closeTarget/);
  assert.match(proxy, /record\.targetId = ""/);
  assert.match(proxy, /if \(!workspace\?\.record\?\.targetId\) return null/);
  assert.match(proxy, /Target\.createTarget", \{ url: "about:blank", browserContextId: record\.browserContextId \}/);
  assert.match(proxy, /const passive = url\.searchParams\.get\("claim"\) === "0"/);
  assert.doesNotMatch(proxy, /if \(target\) touchSessionTarget\(sessionId, record\)/);
  assert.match(proxy, /request\.method === "POST"/);
  assert.match(entrypoint, /CDP_PROXY_SESSION_TTL_MS="\$\{CDP_PROXY_SESSION_TTL_MS:-86400000\}"/);
  assert.match(browserTool, /def release_browser_session\(task_id: str\)/);
  assert.match(browserTool, /requests\.delete\(/);
  assert.match(gateway, /release_browser_session\(key\)/);
  assert.match(gateway, /release_browser_session\(target\)/);
  assert.match(server, /const browserDisposed = await disposeSessionLiveView\(profile, sessionId\)/);
  assert.match(server, /onActivity: \(\) => touchSessionLiveView\(grant\.endpoint, grant\.sessionId\)/);
});
