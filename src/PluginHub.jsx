import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectInstagram,
  disconnectInstagram,
  installHermesMcp,
  loadComputerUseStatus,
  loadInstagramStatus,
  loadHermesMcpCatalog,
  loadHermesMcpServers,
  loadHermesToolsets,
  refreshInstagram,
  testHermesMcp,
  toggleHermesToolset,
} from "./hermes.js";
import { TEAM_META } from "./officeData.js";

const FILTERS = ["All", "Installed", "MCP", "Toolsets", "Needs config"];
const INSTAGRAM_OWNER_PROFILE = "default";

function normalizeCatalogItem(item = {}) {
  const id = item.name ?? item.id ?? item.slug ?? "";
  return {
    id,
    name: id,
    label: item.label ?? item.display_name ?? item.title ?? id,
    description: item.description ?? item.summary ?? item.readme ?? "Hermes 공식 MCP catalog 항목입니다.",
    category: item.category ?? item.kind ?? "MCP",
    provider: item.provider ?? item.author ?? item.source ?? "Hermes catalog",
    needsConfig: Boolean(item.needs_config ?? item.requires_config ?? item.required_env?.length ?? item.env?.length),
    requiredEnv: item.required_env ?? item.env ?? [],
    homepage: item.homepage ?? item.url ?? item.repo ?? item.source ?? "",
    command: item.command ?? "",
    args: Array.isArray(item.args) ? item.args : [],
    installUrl: item.install_url ?? "",
    installRef: item.install_ref ?? "",
    bootstrap: Array.isArray(item.bootstrap) ? item.bootstrap : [],
    installed: Boolean(item.installed ?? item.enabled),
    raw: item,
  };
}

function normalizeServer(item = {}) {
  const name = item.name ?? item.id ?? "";
  return {
    name,
    label: item.label ?? item.display_name ?? name,
    status: item.status ?? (item.enabled === false ? "disabled" : "enabled"),
    transport: item.transport ?? item.command ?? item.url ?? "",
    tools: item.tools ?? item.tool_names ?? [],
    enabled: item.enabled !== false,
    raw: item,
  };
}

function normalizeToolset(item = {}) {
  const name = item.name ?? item.id ?? item.key ?? "";
  return {
    name,
    label: item.label ?? item.display_name ?? name,
    description: item.description ?? "",
    enabled: Boolean(item.enabled),
    available: item.available !== false,
    configured: item.configured !== false,
    tools: item.tools ?? [],
  };
}

function statusLabel(value) {
  if (value === "installed") return "설치됨";
  if (value === "enabled") return "활성";
  if (value === "disabled") return "비활성";
  if (value === "needs-config") return "설정 필요";
  if (value === "testing") return "테스트 중";
  return "대기";
}

function envTemplate(requiredEnv) {
  if (!Array.isArray(requiredEnv)) return {};
  return Object.fromEntries(requiredEnv.map((item) => {
    const key = typeof item === "string" ? item : item.name ?? item.key ?? "";
    return [key, ""];
  }).filter(([key]) => key));
}

async function loadOfficialTools(profile) {
  const [catalogPayload, serverPayload, toolPayload, computerUse] = await Promise.all([
    loadHermesMcpCatalog(profile),
    loadHermesMcpServers(profile),
    loadHermesToolsets(profile),
    loadComputerUseStatus(profile).catch((error) => ({ ready: null, error: error.message })),
  ]);
  return {
    catalog: catalogPayload.map(normalizeCatalogItem).filter((item) => item.name),
    servers: serverPayload.map(normalizeServer).filter((item) => item.name),
    toolsets: toolPayload.map(normalizeToolset).filter((item) => item.name).map((item) => (
      item.name === "computer_use" ? { ...item, runtime: computerUse } : item
    )),
  };
}

function formatInstagramDate(value) {
  if (!value) return "확인되지 않음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function normalizeInstagramAccount(item = {}) {
  return {
    id: String(item.id ?? item.account_id ?? item.instagram_user_id ?? ""),
    username: item.username ?? item.name ?? item.display_name ?? "Instagram 비즈니스 계정",
    type: item.account_type ?? item.type ?? "BUSINESS",
    expiresAt: item.expires_at ?? item.token_expires_at ?? null,
  };
}

function InstagramIntegrationCard({ filter }) {
  const [snapshot, setSnapshot] = useState({ phase: "loading", payload: null, message: "" });
  const [action, setAction] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const payload = await loadInstagramStatus(INSTAGRAM_OWNER_PROFILE);
      const accountIds = (Array.isArray(payload.accounts) ? payload.accounts : payload.account ? [payload.account] : [])
        .map((account) => String(account.id ?? account.account_id ?? account.instagram_user_id ?? ""))
        .filter(Boolean);
      setSelectedAccountId((current) => current && accountIds.includes(current) ? current : "");
      setSnapshot({ phase: "ready", payload, message: "" });
    } catch (error) {
      setSnapshot({ phase: "error", payload: null, message: error.message });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadInstagramStatus(INSTAGRAM_OWNER_PROFILE)
      .then((payload) => {
        if (!cancelled) setSnapshot({ phase: "ready", payload, message: "" });
      })
      .catch((error) => {
        if (!cancelled) setSnapshot({ phase: "error", payload: null, message: error.message });
      });
    return () => { cancelled = true; };
  }, []);

  const runAction = async (name, operation) => {
    setAction(name);
    setSnapshot((current) => ({ ...current, message: "" }));
    try {
      const result = await operation();
      const authorizationUrl = result.authorization_url ?? result.authorizationUrl ?? result.url;
      if (authorizationUrl) {
        window.location.assign(authorizationUrl);
        return;
      }
      await loadStatus();
    } catch (error) {
      setSnapshot((current) => ({ ...current, phase: current.payload ? "ready" : "error", message: error.message }));
    } finally {
      setAction("");
    }
  };

  const payload = snapshot.payload ?? {};
  const accounts = (Array.isArray(payload.accounts) ? payload.accounts : payload.account ? [payload.account] : [])
    .map(normalizeInstagramAccount)
    .filter((account) => account.id || account.username);
  const connected = Boolean(payload.connected ?? accounts.length);
  const state = payload.state ?? (connected ? "connected" : "not_connected");
  const webhookState = payload.webhook?.status ?? payload.webhook_status ?? (connected ? "대기 중" : "연결 후 활성화");
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
  const payloadError = typeof payload.error === "string" ? payload.error : payload.error?.message;
  const disconnectSelected = () => {
    if (!selectedAccountId) return;
    if (!window.confirm(`${selectedAccount?.username ?? selectedAccountId} Instagram 연결을 해제할까요?`)) return;
    runAction("disconnect", () => disconnectInstagram(INSTAGRAM_OWNER_PROFILE, selectedAccountId));
  };

  const visible = filter === "All"
    || filter === "MCP"
    || (filter === "Installed" && connected)
    || (filter === "Needs config" && !connected);
  if (!visible) return null;

  return (
    <article className={`plugin-card instagram-plugin-card ${connected ? "installed" : ""}`} aria-labelledby="instagram-integration-title">
      <header>
        <span>MCP SERVER</span>
        <b className={connected ? "verified" : snapshot.phase === "error" ? "needs-config" : "idle"}>
          {snapshot.phase === "loading" ? "확인 중" : connected ? "연결됨" : "연결 필요"}
        </b>
      </header>
      <h3 id="instagram-integration-title">Instagram 비즈니스</h3>
      <p>브라우저 비밀번호 로그인 없이 Meta OAuth와 장기 토큰으로 연결하는 공유 Business integration입니다.</p>
      <div className="plugin-meta" aria-live="polite">
        <span>{state}</span>
        <span>공유 owner · {INSTAGRAM_OWNER_PROFILE}</span>
        <span>{accounts.length} accounts</span>
        <span>webhook · {webhookState}</span>
      </div>

      {(snapshot.message || payloadError) && (
        <p className="instagram-integration-notice" role="status">{snapshot.message || payloadError}</p>
      )}

      {connected && (
        <label className="instagram-account-picker">
          <span>관리할 연결 계정</span>
          <select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)}>
            <option value="">계정을 선택하세요</option>
            {accounts.filter((account) => account.id).map((account) => (
              <option key={account.id} value={account.id}>{account.username} · {account.type}</option>
            ))}
          </select>
        </label>
      )}

      <code>
        {selectedAccount
          ? `@${selectedAccount.username} · ${selectedAccount.type} · 만료 ${formatInstagramDate(selectedAccount.expiresAt)}`
          : `instagram_business · 마지막 확인 ${formatInstagramDate(payload.last_checked_at ?? payload.updated_at)}`}
      </code>

      <footer>
        <button type="button" className="secondary" onClick={loadStatus} disabled={Boolean(action)}>
          상태 확인
        </button>
        {connected ? (
          <>
            <button type="button" onClick={() => runAction("refresh", () => refreshInstagram(INSTAGRAM_OWNER_PROFILE, selectedAccountId))} disabled={Boolean(action) || !selectedAccountId}>
              {action === "refresh" ? "갱신 중" : "토큰 갱신"}
            </button>
            {accounts.length > 0 && (
              <button type="button" className="danger" onClick={disconnectSelected} disabled={Boolean(action) || !selectedAccountId}>
                {action === "disconnect" ? "해제 중" : "연결 해제"}
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={() => runAction("connect", () => connectInstagram(INSTAGRAM_OWNER_PROFILE))} disabled={Boolean(action) || snapshot.phase === "loading"}>
            {action === "connect" ? "Meta로 이동 중" : "Instagram 연결"}
          </button>
        )}
      </footer>
    </article>
  );
}

export default function PluginHub({ profiles = [] }) {
  const profileNames = useMemo(() => {
    const names = profiles.map((profile) => profile.name).filter((name) => TEAM_META[name]);
    return names.length ? names : Object.keys(TEAM_META).filter((name) => name !== "default");
  }, [profiles]);
  const [activeProfile, setActiveProfile] = useState(profileNames[0] ?? "default");
  const selectedProfile = profileNames.includes(activeProfile) ? activeProfile : profileNames[0] ?? "default";
  const [filter, setFilter] = useState("All");
  const [catalog, setCatalog] = useState([]);
  const [servers, setServers] = useState([]);
  const [toolsets, setToolsets] = useState([]);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("Hermes 공식 도구 상태를 불러오는 중입니다.");
  const [envDrafts, setEnvDrafts] = useState({});

  const reload = useCallback(async (profile) => {
    const result = await loadOfficialTools(profile);
    setCatalog(result.catalog);
    setServers(result.servers);
    setToolsets(result.toolsets);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadOfficialTools(selectedProfile)
      .then((result) => {
        if (cancelled) return;
        setCatalog(result.catalog);
        setServers(result.servers);
        setToolsets(result.toolsets);
        setNotice("");
      })
      .catch((error) => {
        if (!cancelled) setNotice(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProfile]);

  const installedNames = useMemo(() => new Set(servers.map((server) => server.name)), [servers]);
  const visibleCatalog = catalog.filter((item) => {
    if (filter === "Installed") return installedNames.has(item.name);
    if (filter === "Needs config") return item.needsConfig;
    if (filter === "MCP") return true;
    if (filter === "Toolsets") return false;
    return true;
  });
  const visibleToolsets = filter === "All" || filter === "Toolsets" ? toolsets : [];
  const visibleServers = ["All", "Installed", "MCP"].includes(filter) ? servers : [];

  const installCatalogItem = async (item) => {
    const source = item.installUrl || item.homepage || item.provider || item.name;
    if (!window.confirm(`${item.label} MCP를 설치할까요?\n원본: ${source}\n선택한 프로필(${selectedProfile})에서 실행될 수 있습니다.`)) return;
    const key = `install:${item.name}`;
    setBusyKey(key);
    setNotice("");
    try {
      const env = envDrafts[item.name] ?? envTemplate(item.requiredEnv);
      await installHermesMcp(item.name, env, true, selectedProfile);
      await reload(selectedProfile);
      setNotice(`${item.label} MCP를 Hermes 공식 catalog 경로로 설치했습니다.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyKey("");
    }
  };

  const testServer = async (server) => {
    const key = `test:${server.name}`;
    setBusyKey(key);
    setNotice("");
    try {
      const result = await testHermesMcp(server.name, selectedProfile);
      const tools = result.tools ?? result.tool_names ?? [];
      await reload(selectedProfile);
      setNotice(`${server.label} 연결 테스트 완료${tools.length ? ` · ${tools.length}개 tool 감지` : ""}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyKey("");
    }
  };

  const toggleTool = async (toolset) => {
    const key = `tool:${toolset.name}`;
    setBusyKey(key);
    setNotice("");
    try {
      await toggleHermesToolset(toolset.name, !toolset.enabled, selectedProfile);
      await reload(selectedProfile);
      setNotice(`${toolset.label} toolset을 ${toolset.enabled ? "비활성화" : "활성화"}했습니다.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyKey("");
    }
  };

  return (
    <div className="plugin-hub official-plugin-hub">
      <aside className="plugin-profile-rail" aria-label="프로필 선택">
        {profileNames.map((name) => {
          const meta = TEAM_META[name] ?? TEAM_META.default;
          const enabledCount = toolsets.filter((tool) => tool.enabled).length;
          return (
            <button
              type="button"
              key={name}
              className={selectedProfile === name ? "active" : ""}
              onClick={() => {
                setNotice("Hermes 공식 도구 상태를 불러오는 중입니다.");
                setActiveProfile(name);
              }}
            >
              <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
              <strong>{meta.name}</strong>
              <small>{selectedProfile === name ? `${enabledCount} tools` : "profile"}</small>
            </button>
          );
        })}
      </aside>

      <section className="plugin-catalog-panel">
        <header className="plugin-toolbar">
          <div>
            <span>OFFICIAL HERMES CONTROL</span>
            <strong>{TEAM_META[selectedProfile]?.name ?? selectedProfile}</strong>
            <p>Hermes Dashboard API와 직접 연결된 MCP catalog, 설치 서버, toolset 상태입니다.</p>
          </div>
          <nav aria-label="Plugin category">
            {FILTERS.map((item) => (
              <button type="button" key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
                {item}
              </button>
            ))}
          </nav>
        </header>

        <div className="plugin-grid official-toolset-grid">
          <InstagramIntegrationCard filter={filter} />

          {visibleToolsets.map((toolset) => (
            <article className={`plugin-card ${toolset.enabled ? "installed" : ""}`} key={toolset.name}>
              <header>
                <span>TOOLSET</span>
                <b className={toolset.runtime?.ready === true ? "verified" : toolset.runtime?.ready === false ? "needs-config" : toolset.enabled ? "verified" : "idle"}>
                  {toolset.runtime ? (toolset.runtime.ready === true ? "실행 준비됨" : toolset.runtime.ready === false ? "런타임 확인 필요" : "상태 미확인") : statusLabel(toolset.enabled ? "enabled" : "disabled")}
                </b>
              </header>
              <h3>{toolset.label}</h3>
              <p>{toolset.description || "Hermes 공식 built-in toolset입니다."}</p>
              <div className="plugin-meta">
                <span>{toolset.enabled ? "profile enabled" : "profile disabled"}</span>
                <span>{toolset.configured ? "configured" : "needs setup"}</span>
                {toolset.runtime && <span>{toolset.runtime.platform || "unknown OS"} · {toolset.runtime.platform_supported === false ? "unsupported" : toolset.runtime.installed ? "driver installed" : "driver missing"}</span>}
              </div>
              <code>{toolset.tools?.length ? toolset.tools.join(", ") : toolset.name}</code>
              <footer>
                <button type="button" onClick={() => toggleTool(toolset)} disabled={busyKey === `tool:${toolset.name}`}>
                  {toolset.enabled ? "끄기" : "켜기"}
                </button>
              </footer>
            </article>
          ))}

          {visibleServers.map((server) => (
            <article className="plugin-card installed" key={`server:${server.name}`}>
              <header>
                <span>MCP SERVER</span>
                <b className={server.enabled ? "verified" : "needs-config"}>{statusLabel(server.enabled ? "enabled" : "disabled")}</b>
              </header>
              <h3>{server.label}</h3>
              <p>{server.transport || "Hermes config.yaml에 등록된 MCP 서버입니다."}</p>
              <div className="plugin-meta">
                <span>{server.status}</span>
                <span>{server.tools?.length ?? 0} tools</span>
              </div>
              <code>{server.tools?.length ? server.tools.slice(0, 8).join(", ") : server.name}</code>
              <footer>
                <button type="button" onClick={() => testServer(server)} disabled={busyKey === `test:${server.name}`}>
                  연결 테스트
                </button>
              </footer>
            </article>
          ))}

          {visibleCatalog.map((item) => {
            const installed = installedNames.has(item.name);
            const env = envDrafts[item.name] ?? envTemplate(item.requiredEnv);
            return (
              <article className={`plugin-card ${installed ? "installed" : ""}`} key={`catalog:${item.name}`}>
                <header>
                  <span>MCP CATALOG</span>
                  <b className={installed ? "verified" : item.needsConfig ? "needs-config" : "idle"}>
                    {statusLabel(installed ? "installed" : item.needsConfig ? "needs-config" : "idle")}
                  </b>
                </header>
                <h3>{item.label}</h3>
                <p>{item.description}</p>
                <div className="plugin-meta">
                  <span>{item.provider}</span>
                  <span>{item.category}</span>
                </div>
                {Object.keys(env).length > 0 ? (
                  <div className="plugin-env-list">
                    {Object.entries(env).map(([key, value]) => (
                      <label key={key}>
                        <span>{key}</span>
                        <input
                          value={value}
                          type="password"
                          placeholder="서버에 저장할 값"
                          onChange={(event) => setEnvDrafts((current) => ({
                            ...current,
                            [item.name]: {
                              ...(current[item.name] ?? env),
                              [key]: event.target.value,
                            },
                          }))}
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <code>{item.homepage || item.name}</code>
                )}
                <details className="plugin-trust-details">
                  <summary>설치 원본과 실행 내용 확인</summary>
                  <dl>
                    <div><dt>원본</dt><dd>{item.installUrl || item.homepage || item.provider || "Hermes bundled catalog"}{item.installRef ? ` @ ${item.installRef}` : ""}</dd></div>
                    <div><dt>실행</dt><dd><code>{[item.command, ...item.args].filter(Boolean).join(" ") || "HTTP transport / catalog managed"}</code></dd></div>
                    {item.bootstrap.length > 0 && <div><dt>설치 단계</dt><dd><code>{item.bootstrap.join(" → ")}</code></dd></div>}
                  </dl>
                </details>
                <footer>
                  {item.homepage && <a href={item.homepage} target="_blank" rel="noreferrer">출처</a>}
                  <button type="button" onClick={() => installCatalogItem(item)} disabled={busyKey === `install:${item.name}`}>
                    {installed ? "재설치" : "설치"}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
        {notice && <div className="plugin-notice" role="status">{notice}</div>}
      </section>
    </div>
  );
}
