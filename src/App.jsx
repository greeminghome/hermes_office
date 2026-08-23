import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommandCenter from "./CommandCenter.jsx";
import DataRoom from "./DataRoom.jsx";
import HermesOffice from "./HermesOffice.jsx";
import HermesKanban from "./HermesKanban.jsx";
import MeetingConsole from "./MeetingConsole.jsx";
import ProfileChat from "./ProfileChat.jsx";
import SessionArchive from "./SessionArchive.jsx";
import TeamWorkspace from "./TeamWorkspace.jsx";
import PluginHub from "./PluginHub.jsx";
import AgentLivePage from "./LiveScreen.jsx";
import { publishLiveActivity } from "./liveScreenState.js";
import { profileLabel } from "./governance.js";
import { withEffectiveProfileStatus } from "./profileStatus.js";
import { resolveProfileMeta, TEAM_META } from "./officeData.js";
import { toUiProfileId } from "./profileIds.js";
import { hermesFetch, loadAvailableModels, loadCachedWorkspace, loadOrganization, loadProfileSessions, loadWorkspace, saveOrganization } from "./hermes.js";
import {
  officeMissionsFromBoard,
  officialKanbanMovePlan,
  patchOfficeTaskFromLatest,
} from "./kanbanContracts.js";
import {
  configUpdateRequest,
  modelSetRequest,
  profileCreateRequest,
  profileUpdateRequests,
} from "./officialContracts.js";
import { useModalFocus } from "./useModalFocus.js";
import { buildDefaultOrganizationNodes, organizationRoomAssignments, validateOrganizationNodes } from "../organizationHierarchy.js";
import {
  hydrateActiveMeetings,
  isMeetingArchiveDue,
  markMeetingComplete,
  meetingArchiveAt,
  meetingArchiveCountdown,
} from "./meetingLifecycle.js";

const HermesDashboard = lazy(() => import("./HermesDashboard.jsx"));

const NAV_GROUPS = [
  {
    label: "WORKSPACE",
    items: [
      ["office", "오피스", "OF"],
      ["chat", "대화", "CH"],
      ["meeting", "회의실", "MT"],
      ["kanban", "업무 보드", "KB"],
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      ["command", "지휘 센터", "CC"],
      ["data", "데이터룸", "DR"],
      ["sessions", "기록", "SE"],
      ["team", "AI 조직", "TM"],
      ["plugins", "Plugin", "PL"],
    ],
  },
  {
    label: "SYSTEM",
    items: [
      ["system", "운영 관리", "SY"],
      ["terminal", "Hermes 콘솔", "HC"],
    ],
  },
];

const VIEW_IDS = new Set(NAV_GROUPS.flatMap((group) => group.items.map(([id]) => id)));

function initialViewFromUrl() {
  const viewParam = new URLSearchParams(window.location.search).get("view");
  return VIEW_IDS.has(viewParam) ? viewParam : "office";
}

function syncViewUrl(view) {
  const url = new URL(window.location.href);
  if (view === "office") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

const MOBILE_TABS = [
  ["office", "오피스", "OF"],
  ["chat", "대화", "CH"],
  ["meeting", "회의", "MT"],
  ["kanban", "업무", "KB"],
  ["data", "자료", "DR"],
  ["command", "지휘", "CC"],
];

const SYSTEM_SECTIONS = [
  ["overview", "개요"],
  ["profiles", "구성원"],
  ["model", "모델 · 런타임"],
  ["integration", "연동 · 보안"],
  ["reservations", "예약 동기화"],
  ["notifications", "알림"],
];

const SYSTEM_SECTION_IDS = new Set(SYSTEM_SECTIONS.map(([id]) => id));

function initialSystemSectionFromUrl() {
  const section = new URLSearchParams(window.location.search).get("system");
  return SYSTEM_SECTION_IDS.has(section) ? section : "overview";
}

function syncSystemSectionUrl(section) {
  const url = new URL(window.location.href);
  if (section === "overview") url.searchParams.delete("system");
  else url.searchParams.set("system", section);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function googleOAuthNoticeFromUrl() {
  const status = new URLSearchParams(window.location.search).get("google");
  if (status === "connected") return "Google 예약 계정의 Gmail·Calendar 연결과 API 확인을 완료했습니다.";
  if (status === "denied") return "Google 계정 연결이 승인되지 않았습니다.";
  if (status === "invalid-state") return "Google 연결 요청이 만료되었거나 현재 로그인과 일치하지 않습니다. 다시 연결해주세요.";
  if (status === "failed") return "Google OAuth 토큰 저장 또는 API 확인에 실패했습니다. 상태를 다시 확인해주세요.";
  return "";
}

function reservationConnectorLabel(connector) {
  const state = connector?.metadata?.state;
  if (state === "auth-required") return "로그인 필요";
  if (state === "unreachable") return "브라우저 연결 불가";
  if (state === "degraded") return "화면 점검 필요";
  if (connector?.failureCount) return `오류 ${connector.failureCount}회`;
  return connector?.lastSuccessAt ? "정상" : "대기";
}

function reservationConnectorClass(connector) {
  const state = connector?.metadata?.state;
  return connector?.failureCount || new Set(["auth-required", "unreachable", "degraded"]).has(state) ? "error" : "ready";
}

function reservationWriterLabel(status, platform, activeMode, activeLabel) {
  const active = status?.platformWriters?.[platform] === activeMode;
  const state = status?.platformWriterHealth?.[platform]?.state || "unchecked";
  if (state === "auth-required") return active ? "안전 중지 · 로그인 필요" : "shadow · 로그인 필요";
  if (state === "unreachable") return active ? "안전 중지 · 브라우저 연결 불가" : "shadow · 브라우저 연결 불가";
  if (state === "degraded") return active ? "안전 중지 · 화면 점검 필요" : "shadow · 화면 점검 필요";
  if (state === "ready") return active ? `${activeLabel} · 로그인 정상` : "shadow · 로그인 준비";
  return active ? `${activeLabel} · 확인 전` : "shadow · 확인 전";
}

function reservationLiveViewerUrl(status, platform) {
  const sessionId = status?.platformWriterHealth?.[platform]?.liveSessionId;
  if (!sessionId) return "";
  const query = new URLSearchParams({ profile: "greeming-seoyun", sessionId });
  return `/agent-live?${query}`;
}

const SYSTEM_SECTION_COPY = {
  overview: ["SYSTEM HEALTH", "운영 현황", "Hermes 연결, Gateway, 모델과 누적 사용 상태를 한 화면에서 확인합니다."],
  profiles: ["TEAM RUNTIME", "구성원 관리", "프로필별 역할과 기본 모델을 편집하고 저장 결과를 Hermes에서 다시 확인합니다."],
  model: ["MODEL RUNTIME", "모델 · 런타임", "공용 Provider, 모델과 컨텍스트 길이를 실제 런타임 설정에 반영합니다."],
  integration: ["SECURITY BOUNDARY", "연동 · 보안", "서버 연결 상태와 자격 증명 보관 경계를 노출 없이 점검합니다."],
  reservations: ["RESERVATION LEDGER", "예약 동기화", "세 판매 채널과 수동 일정을 원장·충돌·연동 상태로 확인합니다."],
  notifications: ["LOCAL SIGNALS", "알림", "완료 보고와 회의 결과를 이 PC에서 어떤 방식으로 받을지 설정합니다."],
};

function profileSaveStepLabel(request) {
  if (request.path.endsWith("/description")) return "역할 저장";
  if (request.path.endsWith("/model")) return "기본 모델 저장";
  if (request.method === "PATCH") return "프로필 ID 변경";
  return "프로필 설정 저장";
}

function profileListFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.profiles)) return payload.profiles;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: true,
  sound: true,
  preview: true,
  browser: false,
  autoOpenChat: false,
};

const LOCAL_REPORTS_KEY = "greeming-hermes-local-reports";
const NOTIFICATION_SETTINGS_KEY = "greeming-hermes-notification-settings";
const ACTIVE_MEETING_KEY = "greeming-hermes-active-meeting";
const MEETING_STORAGE_KEY = "greeming-hermes-meetings";

function loadLocalState(key, fallback) {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function loadActiveMeetings() {
  const stored = loadLocalState(ACTIVE_MEETING_KEY, []);
  const records = loadLocalState(MEETING_STORAGE_KEY, []);
  return hydrateActiveMeetings(stored, records);
}

function cleanMeetingTopic(topic = "") {
  return String(topic).replace(/\[OFFICE_(?:ASSIGN|MEETING)\s+[^\]]+\]\s*/gi, "").trim();
}

function PageIntro({ eyebrow, title, description, children }) {
  return (
    <div className="page-intro">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}

function MeetingLobby({ profiles, activeMeetings = [], onOpenMeeting, onStartMeeting, onOpenOffice }) {
  const meetingProfiles = useMemo(() => {
    return profiles.length
      ? profiles
      : Object.keys(TEAM_META).map((name) => ({ name, gateway_running: false }));
  }, [profiles]);
  const [topic, setTopic] = useState("이번 주 핵심 업무와 병목 점검");
  const [selected, setSelected] = useState(() => new Set(["default", "greeming-seoyun"]));
  const [selectedArchiveId, setSelectedArchiveId] = useState("");
  const archivedMeetings = useMemo(
    () => loadLocalState("greeming-hermes-meetings", []).filter((meeting) => meeting.status === "complete"),
    [],
  );
  const selectedArchive = archivedMeetings.find((meeting) => meeting.id === selectedArchiveId);
  const selectedProfiles = meetingProfiles.filter((profile) => selected.has(profile.name));

  const toggleParticipant = (name) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const start = () => {
    const participants = selectedProfiles.map((profile) => profile.name);
    if (!topic.trim() || !participants.length) return;
    onStartMeeting({
      id: crypto.randomUUID(),
      source: "meeting-tab",
      topic: topic.trim(),
      subtitle: `${participants.length}명 참여 · 회의실 탭에서 시작`,
      participants,
      requestedBy: participants.includes("default") ? "default" : participants[0],
      startedAt: Date.now(),
    });
  };

  return (
    <section className="page-card meeting-lobby-page">
      <PageIntro
        eyebrow="AI TEAM MEETING"
        title="회의실"
        description="안건과 참여자를 정하면 각 구성원이 순서대로 의견을 내고, 마지막에 회의록과 후속 액션을 정리합니다."
      >
        <button className="secondary-button" type="button" onClick={onOpenOffice}>오피스 맵에서 보기</button>
      </PageIntro>
      <div className="meeting-lobby">
        {activeMeetings.length > 0 && (
          <section className="meeting-active-list">
            <div className="panel-heading"><div><span>IN PROGRESS</span><h3>진행 중 회의</h3></div><b>{activeMeetings.length}</b></div>
            {activeMeetings.map((meeting) => (
              <button type="button" key={meeting.id} onClick={() => onOpenMeeting(meeting.id)}>
                <span><i />진행 중</span>
                <strong>{cleanMeetingTopic(meeting.topic)}</strong>
                <small>{meeting.participants.map((name) => resolveProfileMeta(profiles.find((profile) => profile.name === name) ?? name).name).join(", ")}</small>
              </button>
            ))}
          </section>
        )}
        <section className="meeting-lobby-topic">
          <span>MEETING TOPIC</span>
          <label>
            <strong>회의 안건</strong>
            <textarea value={topic} onChange={(event) => setTopic(event.target.value)} />
          </label>
          <div className="meeting-lobby-summary">
            <article><small>참여자</small><strong>{selectedProfiles.length}명</strong></article>
            <article><small>진행 방식</small><strong>순차 발언</strong></article>
            <article><small>결과물</small><strong>회의록 + 업무</strong></article>
          </div>
          <button className="primary-button meeting-lobby-start" type="button" disabled={!topic.trim() || !selectedProfiles.length} onClick={start}>
            회의 시작
          </button>
        </section>
        <section className="meeting-lobby-participants">
          <div className="panel-heading">
            <div>
              <span>PARTICIPANTS</span>
              <h3>참여 구성원</h3>
            </div>
            <b>{selectedProfiles.length}</b>
          </div>
          <div className="meeting-lobby-grid">
            {meetingProfiles.map((profile) => {
              const meta = resolveProfileMeta(profile);
              const active = selected.has(profile.name);
              return (
                <button
                  type="button"
                  key={profile.name}
                  className={active ? "selected" : ""}
                  aria-pressed={active}
                  onClick={() => toggleParticipant(profile.name)}
                >
                  <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
                  <div>
                    <strong>{meta.name}</strong>
                    <small>{meta.role}</small>
                  </div>
                  <i className={profile.gateway_running ? "online" : ""} />
                </button>
              );
            })}
          </div>
        </section>
        <section className="meeting-archive-list">
          <div className="panel-heading"><div><span>ARCHIVE</span><h3>완료된 회의</h3></div><b>{archivedMeetings.length}</b></div>
          {!archivedMeetings.length && <p className="empty-state">완료된 회의가 없습니다.</p>}
          {archivedMeetings.map((meeting) => (
            <button
              type="button"
              key={meeting.id}
              className={selectedArchiveId === meeting.id ? "selected" : ""}
              aria-pressed={selectedArchiveId === meeting.id}
              onClick={() => setSelectedArchiveId(meeting.id)}
            >
              <strong>{cleanMeetingTopic(meeting.topic)}</strong>
              <small>{meeting.participants.map((name) => TEAM_META[name]?.name).filter(Boolean).join(", ")} · {new Date(meeting.updatedAt).toLocaleString("ko")}</small>
            </button>
          ))}
          {selectedArchive && (
            <article className="meeting-archive-detail">
              <header><strong>{cleanMeetingTopic(selectedArchive.topic)}</strong><small>{selectedArchive.round} 라운드</small></header>
              {(selectedArchive.entries ?? []).map((entry) => (
                <p key={entry.id}><b>{TEAM_META[entry.profile]?.name ?? entry.profile}</b>{entry.text}</p>
              ))}
            </article>
          )}
        </section>
      </div>
    </section>
  );
}

function SystemPage({ workspace, connection, notificationSettings, onNotificationSettingsChange, onTestNotification }) {
  const profiles = useMemo(() => workspace?.profiles ?? [], [workspace?.profiles]);
  const managedProfiles = profiles;
  const firstProfile = managedProfiles[0];
  const displayMeta = useCallback((profile) => {
    const known = TEAM_META[profile?.name];
    if (known) return known;
    const name = profile?.display_name || profile?.name || "새 구성원";
    const initials = name.split(/[-_\s]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "AI";
    return { name, initials, color: "#748f83", role: profile?.description || profile?.role || "Hermes 구성원" };
  }, []);
  const firstMeta = displayMeta(firstProfile);
  const [selectedProfile, setSelectedProfile] = useState(firstProfile?.name ?? "default");
  const [profileDraft, setProfileDraft] = useState({
    name: firstProfile?.name ?? "",
    role: firstProfile?.description ?? firstProfile?.role ?? firstMeta.role ?? "",
    model: firstProfile?.model ?? workspace?.model?.model ?? "",
  });
  const [modelDraft, setModelDraft] = useState({
    provider: workspace?.model?.provider ?? "",
    model: workspace?.model?.model ?? "",
    contextLength: workspace?.model?.effective_context_length ?? "",
  });
  const [availableModels, setAvailableModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelSelectMode, setModelSelectMode] = useState("select");
  const [settingsNotice, setSettingsNotice] = useState(googleOAuthNoticeFromUrl);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [activeSection, setActiveSection] = useState(initialSystemSectionFromUrl);
  const [reservationIntegrations, setReservationIntegrations] = useState(null);
  const [reservationIntegrationsLoading, setReservationIntegrationsLoading] = useState(false);
  const [reservationIntegrationsError, setReservationIntegrationsError] = useState("");
  const [googleClientDraft, setGoogleClientDraft] = useState({ clientId: "", clientSecret: "" });
  const [reservationOperations, setReservationOperations] = useState({ status: null, bookings: [], conflicts: [] });
  const [reservationOperationsLoading, setReservationOperationsLoading] = useState(false);
  const [reservationOperationsError, setReservationOperationsError] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [profileMode, setProfileMode] = useState("edit");
  const [profileSaveReport, setProfileSaveReport] = useState(null);
  const [modelSaveReport, setModelSaveReport] = useState(null);
  const running = profiles.filter((profile) => profile.gateway_running).length;
  const connectionCopy = connection === "online"
    ? { label: "정상 연결", metric: "정상", className: "online" }
    : connection === "offline" || connection === "error"
      ? { label: "연결 끊김", metric: "오프라인", className: "offline" }
      : { label: "연결 확인 중", metric: "확인 중", className: "checking" };
  const metrics = [
    ["Hermes 연결", connectionCopy.metric],
    ["Gateway", `${running} / ${profiles.length}`],
    ["현재 모델", workspace?.model?.model ?? "-"],
    ["기본 프로필 세션", workspace?.stats?.total ?? "-"],
    ["누적 메시지", workspace?.stats?.messages ?? "-"],
    ["컨텍스트", workspace?.model?.effective_context_length?.toLocaleString() ?? "-"],
  ];

  const modelOptions = useMemo(() => {
    const byId = new Map();
    const push = (model) => {
      if (!model?.id) return;
      byId.set(model.id, {
        id: model.id,
        label: model.label ?? model.id,
        provider: model.provider ?? "",
        contextLength: model.contextLength ?? "",
      });
    };
    availableModels.forEach(push);
    if (workspace?.model?.model) {
      push({
        id: workspace.model.model,
        label: workspace.model.model,
        provider: workspace.model.provider ?? "",
        contextLength: workspace.model.effective_context_length ?? "",
      });
    }
    profiles.forEach((profile) => {
      if (profile.model) push({ id: profile.model, label: profile.model, provider: workspace?.model?.provider ?? "" });
    });
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [availableModels, profiles, workspace]);

  const providerOptions = useMemo(() => {
    const providers = modelOptions.map((model) => model.provider).filter(Boolean);
    return [...new Set(providers)].sort();
  }, [modelOptions]);

  const filteredModels = useMemo(() => (
    modelDraft.provider
      ? modelOptions.filter((model) => !model.provider || model.provider === modelDraft.provider)
      : modelOptions
  ), [modelOptions, modelDraft.provider]);
  const selectedModelValue = modelDraft.model || filteredModels[0]?.id || "";
  const selectedProfileModelValue = profileDraft.model || modelOptions[0]?.id || "";

  const loadReservationIntegrations = useCallback(async (verify = false) => {
    setReservationIntegrationsLoading(true);
    setReservationIntegrationsError("");
    try {
      const response = await fetch(`/bridge/reservations/integrations${verify ? "?refresh=1" : ""}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        window.location.assign(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
        throw new Error("Hermes 로그인이 만료되었습니다.");
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `예약 연동 상태 오류 (${response.status})`);
      setReservationIntegrations(payload);
      if (payload.error) setReservationIntegrationsError(payload.error);
    } catch (error) {
      setReservationIntegrationsError(error.message || "예약 연동 상태를 불러오지 못했습니다.");
    } finally {
      setReservationIntegrationsLoading(false);
    }
  }, []);

  const saveReservationGoogleClient = async () => {
    if (!googleClientDraft.clientId.trim() || !googleClientDraft.clientSecret.trim()) {
      setReservationIntegrationsError("Google OAuth 클라이언트 ID와 보안 비밀번호를 모두 입력해주세요.");
      return;
    }
    setReservationIntegrationsLoading(true);
    setReservationIntegrationsError("");
    try {
      const response = await fetch("/bridge/reservations/google/client", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Hermes-Setup": "reservation-google-oauth",
        },
        body: JSON.stringify({
          client_id: googleClientDraft.clientId.trim(),
          client_secret: googleClientDraft.clientSecret.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `OAuth 클라이언트 저장 오류 (${response.status})`);
      setGoogleClientDraft({ clientId: "", clientSecret: "" });
      setSettingsNotice("Google 예약 OAuth 클라이언트를 서버 비밀 저장소에 안전하게 등록했습니다.");
      await loadReservationIntegrations(false);
    } catch (error) {
      setReservationIntegrationsError(error.message || "OAuth 클라이언트를 저장하지 못했습니다.");
    } finally {
      setReservationIntegrationsLoading(false);
    }
  };

  const loadReservationOperations = useCallback(async () => {
    setReservationOperationsLoading(true);
    setReservationOperationsError("");
    try {
      const responses = await Promise.all([
        fetch("/bridge/reservations/status", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } }),
        fetch("/bridge/reservations/bookings?limit=50", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } }),
        fetch("/bridge/reservations/conflicts", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } }),
      ]);
      if (responses.some((response) => response.status === 401 || response.status === 403)) {
        window.location.assign(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
        throw new Error("Hermes 로그인이 만료되었습니다.");
      }
      const payloads = await Promise.all(responses.map((response) => response.json().catch(() => ({}))));
      const failedIndex = responses.findIndex((response) => !response.ok);
      if (failedIndex >= 0) throw new Error(payloads[failedIndex].error || `예약 운영 상태 오류 (${responses[failedIndex].status})`);
      setReservationOperations({ status: payloads[0], bookings: payloads[1].items || [], conflicts: payloads[2].items || [] });
    } catch (error) {
      setReservationOperationsError(error.message || "예약 운영 상태를 불러오지 못했습니다.");
    } finally {
      setReservationOperationsLoading(false);
    }
  }, []);

  const triggerReservationSync = async () => {
    setReservationOperationsLoading(true);
    setReservationOperationsError("");
    try {
      const response = await fetch("/bridge/reservations/sync", { method: "POST", credentials: "same-origin",
        headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `예약 대조 오류 (${response.status})`);
      setSettingsNotice("읽기 전용 예약 대조와 원장 갱신을 완료했습니다.");
      await loadReservationOperations();
    } catch (error) {
      setReservationOperationsError(error.message || "예약 대조를 완료하지 못했습니다.");
      setReservationOperationsLoading(false);
    }
  };

  useEffect(() => {
    if (activeSection !== "integration") return undefined;
    const timer = window.setTimeout(() => loadReservationIntegrations(false), 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, loadReservationIntegrations]);

  useEffect(() => {
    if (activeSection !== "reservations") return undefined;
    const timer = window.setTimeout(() => loadReservationOperations(), 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, loadReservationOperations]);

  useEffect(() => {
    if (profileMode === "create" || !profiles.length || profileDraft.name) return;
    const profile = profiles.find((item) => item.name === selectedProfile) ?? profiles[0];
    const meta = displayMeta(profile);
    const timer = window.setTimeout(() => {
      setSelectedProfile(profile.name);
      setProfileDraft({
        name: profile.name,
        role: profile.description ?? profile.role ?? meta.role ?? "",
        model: profile.model ?? workspace?.model?.model ?? "",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [displayMeta, profileDraft.name, profileMode, profiles, selectedProfile, workspace?.model?.model]);

  useEffect(() => {
    if (modelDraft.provider || modelDraft.model || modelDraft.contextLength !== "") return;
    const timer = window.setTimeout(() => setModelDraft({
      provider: workspace?.model?.provider ?? "",
      model: workspace?.model?.model ?? "",
      contextLength: workspace?.model?.effective_context_length ?? "",
    }), 0);
    return () => window.clearTimeout(timer);
  }, [modelDraft.contextLength, modelDraft.model, modelDraft.provider, workspace?.model]);

  const refreshModels = useCallback(() => {
    let ignore = false;
    setModelsLoading(true);
    setModelsError("");
    loadAvailableModels()
      .then((models) => {
        if (ignore) return;
        setAvailableModels(models);
        if (!models.length) {
          setModelSelectMode("manual");
          return;
        }
        setModelSelectMode("select");
        setModelDraft((current) => {
          const existing = models.find((model) => model.id === current.model);
          const selected = existing ?? models[0];
          return {
            ...current,
            provider: current.provider || selected?.provider || "",
            model: existing ? current.model : selected?.id ?? current.model,
            contextLength: current.contextLength || selected?.contextLength || "",
          };
        });
      })
      .catch((error) => {
        if (!ignore) {
          setModelSelectMode("manual");
          setModelsError(error.message || "모델 목록을 불러오지 못했습니다.");
        }
      })
      .finally(() => {
        if (!ignore) setModelsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let cleanup = () => {};
    const timer = window.setTimeout(() => { cleanup = refreshModels(); }, 0);
    return () => {
      window.clearTimeout(timer);
      cleanup();
    };
  }, [refreshModels]);

  const sendOfficialRequest = (request, timeoutMs = 15000) => hermesFetch(request.path, {
    method: request.method,
    body: JSON.stringify(request.body),
    timeoutMs,
  });

  const runSettingsWrite = async (operation, onError) => {
    setSettingsBusy(true);
    setSettingsNotice("Hermes에 저장 중입니다...");
    try {
      const message = await operation();
      setSettingsNotice(message);
      refreshWorkspaceSoon();
    } catch (error) {
      onError?.(error);
      setSettingsNotice(`저장을 완료하지 못했습니다. ${error.message || "Hermes 응답을 확인해주세요."}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const verifySavedProfile = async (targetName, steps, expectedProfile) => {
    try {
      const payload = await hermesFetch("/api/profiles", { timeoutMs: 15000 });
      const savedProfile = profileListFromPayload(payload).find((profile) => profile?.name === targetName);
      if (!savedProfile) throw new Error(`${targetName} 프로필을 다시 읽은 목록에서 찾지 못했습니다.`);
      const savedRole = String(savedProfile.description ?? savedProfile.role ?? "").trim();
      const savedModel = String(savedProfile.model ?? savedProfile.model_name ?? "").trim();
      if (expectedProfile?.role != null && savedRole !== String(expectedProfile.role).trim()) {
        throw new Error("저장된 역할이 입력값과 일치하지 않습니다.");
      }
      if (expectedProfile?.model && savedModel !== expectedProfile.model) {
        throw new Error("저장된 기본 모델이 입력값과 일치하지 않습니다.");
      }
      setProfileSaveReport({ targetName, expectedProfile, steps, pendingRequests: [], verificationPending: false, status: "complete", error: "" });
      return savedProfile;
    } catch (error) {
      setProfileSaveReport({ targetName, expectedProfile, steps, pendingRequests: [], verificationPending: true, status: "verification-failed", error: error.message });
      throw new Error(`쓰기 단계는 끝났지만 적용 확인에 실패했습니다. (${error.message})`, { cause: error });
    }
  };

  const executeProfileSave = async (targetName, requests, completedSteps = [], expectedProfile = null) => {
    const steps = [...completedSteps];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const label = profileSaveStepLabel(request);
      setProfileSaveReport({
        targetName,
        expectedProfile,
        steps: [...steps, { label, status: "running" }],
        pendingRequests: requests.slice(index),
        verificationPending: false,
        status: "saving",
        error: "",
      });
      try {
        await sendOfficialRequest(request);
        steps.push({ label, status: "complete" });
      } catch (error) {
        const failedSteps = [...steps, { label, status: "failed", message: error.message }];
        setProfileSaveReport({
          targetName,
          expectedProfile,
          steps: failedSteps,
          pendingRequests: requests.slice(index),
          verificationPending: false,
          status: "failed",
          error: error.message,
        });
        throw new Error(`${label} 단계에서 중단되었습니다. 아래에서 실패 단계부터 다시 시도할 수 있습니다. (${error.message})`, { cause: error });
      }
    }
    setProfileSaveReport({ targetName, expectedProfile, steps, pendingRequests: [], verificationPending: false, status: "verifying", error: "" });
    await verifySavedProfile(targetName, steps, expectedProfile);
    const uiTargetName = toUiProfileId(targetName);
    setSelectedProfile(uiTargetName);
    setProfileDraft((current) => ({ ...current, name: uiTargetName }));
  };

  const saveProfile = () => runSettingsWrite(async () => {
    if (profileMode !== "edit" || !selectedProfile) throw new Error("저장할 프로필을 먼저 선택해주세요.");
    const { targetName, requests } = profileUpdateRequests(
      selectedProfile,
      { ...profileDraft, model: selectedProfileModelValue },
      modelOptions,
      workspace?.model?.provider,
    );
    setProfileSaveReport(null);
    await executeProfileSave(targetName, requests, [], { role: profileDraft.role, model: selectedProfileModelValue });
    return "프로필 이름·역할·모델을 저장하고 Hermes에서 적용 결과를 다시 확인했습니다.";
  });

  const retryProfileSave = () => {
    const report = profileSaveReport;
    if (!report?.pendingRequests?.length) return;
    const completedSteps = report.steps.filter((step) => step.status === "complete");
    runSettingsWrite(async () => {
      await executeProfileSave(report.targetName, report.pendingRequests, completedSteps, report.expectedProfile);
      return "중단된 단계부터 다시 저장하고 적용 결과를 확인했습니다.";
    });
  };

  const retryProfileVerification = () => {
    const report = profileSaveReport;
    if (!report?.verificationPending) return;
    runSettingsWrite(async () => {
      await verifySavedProfile(report.targetName, report.steps.filter((step) => step.status === "complete"), report.expectedProfile);
      setSelectedProfile(toUiProfileId(report.targetName));
      if (report.expectedProfile?.operation === "create") setProfileMode("edit");
      setProfileDraft((current) => ({ ...current, name: toUiProfileId(report.targetName) }));
      return "Hermes에서 프로필 적용 결과를 다시 확인했습니다.";
    });
  };

  const verifySavedModel = async (model, contextLength) => {
    try {
      const readback = await hermesFetch("/api/model/info", { timeoutMs: 15000 });
      const savedModel = String(readback?.model ?? "");
      const configuredContext = readback?.config_context_length;
      const savedContext = configuredContext == null || configuredContext === "" ? 0 : Number(configuredContext);
      if (!savedModel || savedModel !== model) throw new Error(`적용 확인 모델이 다릅니다. (${savedModel || "응답 없음"})`);
      if (!Number.isFinite(savedContext) || savedContext !== contextLength) throw new Error(`적용 확인 컨텍스트가 다릅니다. (${Number.isFinite(savedContext) ? savedContext : "응답 없음"})`);
      setModelSaveReport({ status: "complete", model, contextLength, error: "" });
      return readback;
    } catch (error) {
      setModelSaveReport({ status: "verification-failed", model, contextLength, error: error.message });
      throw new Error(`쓰기 단계는 끝났지만 적용 확인에 실패했습니다. (${error.message})`, { cause: error });
    }
  };

  const saveModel = () => runSettingsWrite(async () => {
    const draft = { ...modelDraft, model: selectedModelValue };
    const contextLength = Number.parseInt(String(modelDraft.contextLength || "0"), 10);
    if (!Number.isFinite(contextLength) || contextLength < 0) throw new Error("Context length는 0 이상의 정수여야 합니다.");
    setModelSaveReport({ status: "saving-model", model: selectedModelValue, contextLength, error: "" });
    let request = modelSetRequest(draft, modelOptions, workspace?.model?.provider);
    let result = await sendOfficialRequest(request, 30000);
    if (result?.confirm_required) {
      const confirmed = window.confirm(result.confirm_message || "비용이 높은 모델일 수 있습니다. 계속 저장할까요?");
      if (!confirmed) throw new Error("사용자가 모델 변경을 취소했습니다.");
      request = modelSetRequest(draft, modelOptions, workspace?.model?.provider, true);
      result = await sendOfficialRequest(request, 30000);
    }
    setModelSaveReport({ status: "saving-context", model: result?.model || selectedModelValue, contextLength, error: "" });
    try {
      await sendOfficialRequest(configUpdateRequest({ model_context_length: contextLength }));
    } catch (error) {
      setModelSaveReport({ status: "partial", model: result?.model || selectedModelValue, contextLength, error: error.message });
      throw new Error(`모델은 변경됐지만 컨텍스트 저장에 실패했습니다. 컨텍스트 설정만 다시 저장해주세요. (${error.message})`, { cause: error });
    }
    setModelSaveReport({ status: "verifying", model: result?.model || selectedModelValue, contextLength, error: "" });
    const appliedModel = result?.model || selectedModelValue;
    await verifySavedModel(appliedModel, contextLength);
    return `${appliedModel} 모델과 컨텍스트 설정을 저장하고 다시 확인했습니다.`;
  }, (error) => setModelSaveReport((current) => {
    if (current && ["partial", "verification-failed"].includes(current.status)) return current;
    return {
      ...(current ?? { model: selectedModelValue, contextLength: Number.parseInt(String(modelDraft.contextLength || "0"), 10) || 0 }),
      status: "failed",
      error: error.message,
    };
  }));

  const retryModelContext = () => {
    const report = modelSaveReport;
    if (!report || report.status !== "partial") return;
    runSettingsWrite(async () => {
      setModelSaveReport({ ...report, status: "saving-context", error: "" });
      await sendOfficialRequest(configUpdateRequest({ model_context_length: report.contextLength }));
      setModelSaveReport({ ...report, status: "verifying", error: "" });
      await verifySavedModel(report.model, report.contextLength);
      return "컨텍스트 설정만 다시 저장하고 Hermes에서 적용 결과를 확인했습니다.";
    }, (error) => setModelSaveReport((current) => current?.status === "verification-failed"
      ? current
      : { ...report, status: "partial", error: error.message }));
  };

  const retryModelVerification = () => {
    const report = modelSaveReport;
    if (!report || report.status !== "verification-failed") return;
    runSettingsWrite(async () => {
      setModelSaveReport({ ...report, status: "verifying", error: "" });
      await verifySavedModel(report.model, report.contextLength);
      return "Hermes에서 모델 설정 적용 결과를 다시 확인했습니다.";
    });
  };

  const beginCreateProfile = () => {
    setProfileMode("create");
    setSelectedProfile("");
    setProfileSaveReport(null);
    setProfileDraft({ name: "", role: "", model: workspace?.model?.model ?? "" });
    setSettingsNotice("새 구성원의 프로필 ID와 역할을 입력해주세요.");
  };

  const cancelCreateProfile = () => {
    const profile = profiles[0];
    const meta = displayMeta(profile);
    setProfileMode("edit");
    setSelectedProfile(profile?.name ?? "");
    setProfileDraft({
      name: profile?.name ?? "",
      role: profile?.description ?? profile?.role ?? meta.role ?? "",
      model: profile?.model ?? workspace?.model?.model ?? "",
    });
    setSettingsNotice("");
  };

  const createProfile = () => {
    const requestedName = profileDraft.name.trim();
    if (!requestedName) {
      setSettingsNotice("새 프로필 ID를 입력해주세요.");
      return;
    }
    const duplicate = profiles.some((profile) => (
      toUiProfileId(profile.name)?.toLocaleLowerCase() === toUiProfileId(requestedName)?.toLocaleLowerCase()
    ));
    if (duplicate) {
      setSettingsNotice(`이미 존재하는 프로필 ID입니다: ${requestedName}`);
      return;
    }
    runSettingsWrite(async () => {
    const request = profileCreateRequest(
      { ...profileDraft, name: requestedName, model: selectedProfileModelValue },
      modelOptions,
      workspace?.model?.provider,
    );
    const result = await sendOfficialRequest(request, 30000);
    const createdName = result?.name || request.body.name;
    const expectedProfile = { role: profileDraft.role, model: selectedProfileModelValue, operation: "create" };
    await verifySavedProfile(createdName, [{ label: "프로필 생성", status: "complete" }], expectedProfile);
    setProfileMode("edit");
    setSelectedProfile(createdName);
    setProfileDraft((current) => ({ ...current, name: createdName }));
    return `${createdName} 프로필을 Hermes에 추가했습니다.`;
    });
  };

  const refreshWorkspaceSoon = () => window.setTimeout(() => window.dispatchEvent(new Event("hermes:refresh-workspace")), 300);

  const toggleBrowserNotification = async (enabled) => {
    if (!enabled) {
      onNotificationSettingsChange({ browser: false });
      return;
    }
    if (!("Notification" in window)) {
      setSettingsNotice("이 브라우저는 Windows 시스템 알림을 지원하지 않습니다.");
      return;
    }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      setSettingsNotice("브라우저 알림 권한이 허용되지 않았습니다. 브라우저 사이트 설정에서 권한을 변경해주세요.");
      onNotificationSettingsChange({ browser: false });
      return;
    }
    onNotificationSettingsChange({ browser: true });
    setSettingsNotice("브라우저 시스템 알림 권한을 확인했습니다.");
  };

  const handleSystemTabKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SYSTEM_SECTIONS.findIndex(([id]) => id === activeSection);
    const lastIndex = SYSTEM_SECTIONS.length - 1;
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = lastIndex;
    if (event.key === "ArrowLeft") nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
    if (event.key === "ArrowRight") nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
    const [nextSection] = SYSTEM_SECTIONS[nextIndex];
    setActiveSection(nextSection);
    syncSystemSectionUrl(nextSection);
    event.currentTarget.querySelectorAll('[role="tab"]')[nextIndex]?.focus();
  };
  const activeSectionCopy = SYSTEM_SECTION_COPY[activeSection] ?? SYSTEM_SECTION_COPY.overview;

  return (
    <section className="page-card system-page professional-system">
      <PageIntro
        eyebrow="CONTROL CENTER"
        title="Hermes 운영 관리"
        description="시스템 상태, 구성원, 모델, 연동과 알림을 실제 Hermes 설정과 함께 관리합니다."
      />
      <div className="system-status-strip">
        <div><i className={connectionCopy.className} /><span>Hermes {connectionCopy.label}</span></div>
        <span>Gateway {running}/{profiles.length}</span>
        <span>Model {workspace?.model?.model || "설정 필요"}</span>
        <button type="button" onClick={() => window.dispatchEvent(new Event("hermes:refresh-workspace"))}>상태 다시 확인</button>
      </div>
      <nav className="system-section-tabs" aria-label="운영 관리 구역" role="tablist" onKeyDown={handleSystemTabKeyDown}>
        {SYSTEM_SECTIONS.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            id={`system-tab-${id}`}
            aria-controls={`system-panel-${id}`}
            aria-selected={activeSection === id}
            tabIndex={activeSection === id ? 0 : -1}
            key={id}
            className={activeSection === id ? "active" : ""}
            onClick={() => { setActiveSection(id); syncSystemSectionUrl(id); }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-notice-slot">
        {settingsNotice && <p className={`settings-notice ${settingsNotice.includes("못했습니다") || settingsNotice.includes("실패") ? "error" : ""}`} role={settingsNotice.includes("못했습니다") || settingsNotice.includes("실패") ? "alert" : "status"} aria-live="polite" aria-atomic="true">{settingsNotice}</p>}
      </div>
      <header className="system-panel-intro">
        <div><span>{activeSectionCopy[0]}</span><h2>{activeSectionCopy[1]}</h2><p>{activeSectionCopy[2]}</p></div>
        <aside>
          <small>HERMES</small>
          <strong className={connectionCopy.className}>{connectionCopy.label}</strong>
        </aside>
      </header>

      {activeSection === "overview" && <div className="system-overview-section" role="tabpanel" id="system-panel-overview" aria-labelledby="system-tab-overview" tabIndex={0}>
      <div className="system-grid">
        {metrics.map(([label, value], index) => (
          <article key={label}>
            <span>0{index + 1}</span>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <div className="gateway-list">
        <div className="section-title">
          <span>GATEWAYS</span>
          <h3>프로필 연결 상태</h3>
        </div>
        {profiles.map((profile) => {
          const meta = displayMeta(profile);
          return (
            <div key={profile.name}>
              <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
              <strong>{meta.name}</strong>
              <small>{profile.name}</small>
              <b className={profile.gateway_running ? "online" : ""}>
                {profile.gateway_running ? "RUNNING" : "OFFLINE"}
              </b>
            </div>
          );
        })}
      </div>
      </div>}
      {activeSection !== "overview" && <div className="system-settings-grid">
        {activeSection === "profiles" && <section className="settings-card profile-settings" role="tabpanel" id="system-panel-profiles" aria-labelledby="system-tab-profiles" tabIndex={0}>
          <div className="section-title">
            <span>PROFILE</span>
            <h3>구성원 추가 · 편집</h3>
          </div>
          <div className="profile-mode-bar">
            <strong>{profileMode === "create" ? "새 구성원 생성" : "기존 구성원 편집"}</strong>
            {profileMode === "edit" && <button type="button" onClick={beginCreateProfile} disabled={settingsBusy}>새 구성원 만들기</button>}
          </div>
          {!managedProfiles.length && profileMode !== "create" && (
            <div className="settings-empty-state">
              <strong>등록된 Hermes 구성원이 없습니다.</strong>
              <p>첫 구성원을 생성하면 Gateway와 조직도에서 함께 사용할 수 있습니다.</p>
              <button type="button" onClick={beginCreateProfile} disabled={settingsBusy}>첫 구성원 만들기</button>
            </div>
          )}
          <fieldset className="settings-fieldset" disabled={settingsBusy}>
          <div className="profile-picker">
            {managedProfiles.map((profile) => {
              const meta = displayMeta(profile);
              return (
                <button
                  type="button"
                  key={profile.name}
                  className={profileMode === "edit" && selectedProfile === profile.name ? "active" : ""}
                  onClick={() => {
                    const meta = displayMeta(profile);
                    setProfileMode("edit");
                    setSelectedProfile(profile.name);
                    setProfileSaveReport(null);
                    setProfileDraft({
                      name: profile.name,
                      role: profile.description ?? profile.role ?? meta.role ?? "",
                      model: profile.model ?? workspace?.model?.model ?? "",
                    });
                  }}
                >
                  <b style={{ "--avatar": meta.color }}>{meta.initials}</b>
                  <span>{meta.name}</span>
                </button>
              );
            })}
          </div>
          <label>프로필 ID<input value={profileDraft.name} readOnly={profileMode === "edit"} onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))} placeholder="greeming-new" /></label>
          <p className="settings-hint">기존 ID는 조직도·세션 참조를 보호하기 위해 잠깁니다. 표시 이름은 Office 조직 메타데이터이며 Hermes 프로필 API에는 저장하지 않습니다.</p>
          <label>역할<textarea value={profileDraft.role} onChange={(event) => setProfileDraft((current) => ({ ...current, role: event.target.value }))} placeholder="담당 역할과 책임" /></label>
          <label>기본 모델
            {modelOptions.length && modelSelectMode === "select" ? (
              <select value={selectedProfileModelValue} onChange={(event) => setProfileDraft((current) => ({ ...current, model: event.target.value }))}>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}{model.provider ? ` · ${model.provider}` : ""}</option>
                ))}
              </select>
            ) : (
              <input value={profileDraft.model} onChange={(event) => setProfileDraft((current) => ({ ...current, model: event.target.value }))} placeholder={workspace?.model?.model ?? "gpt-5"} />
            )}
          </label>
          <div className="settings-actions">
            {profileMode === "create" ? (
              <>
                <button type="button" onClick={createProfile} disabled={settingsBusy}>프로필 생성</button>
                <button type="button" className="secondary-button" onClick={cancelCreateProfile} disabled={settingsBusy}>취소</button>
              </>
            ) : (
              <button type="button" onClick={saveProfile} disabled={settingsBusy}>선택 프로필 저장</button>
            )}
          </div>
          </fieldset>
          {profileSaveReport && (
            <div className={`profile-save-progress ${profileSaveReport.status}`} role="status" aria-live="polite" aria-atomic="true">
              <strong>저장 단계 · {profileSaveReport.targetName}</strong>
              <ol>
                {profileSaveReport.steps.map((step, index) => (
                  <li key={`${step.label}-${index}`} className={step.status}>
                    <span aria-hidden="true">{step.status === "complete" ? "✓" : step.status === "failed" ? "!" : "…"}</span>
                    <b>{step.label}</b>
                    <small>{step.status === "complete" ? "완료" : step.status === "failed" ? `실패 · ${step.message}` : "진행 중"}</small>
                  </li>
                ))}
                {profileSaveReport.status === "verifying" && <li className="running"><span aria-hidden="true">…</span><b>적용 결과 다시 읽기</b><small>확인 중</small></li>}
                {profileSaveReport.status === "complete" && <li className="complete"><span aria-hidden="true">✓</span><b>적용 결과 다시 읽기</b><small>확인 완료</small></li>}
                {profileSaveReport.status === "verification-failed" && <li className="failed"><span aria-hidden="true">!</span><b>적용 결과 다시 읽기</b><small>실패 · {profileSaveReport.error}</small></li>}
              </ol>
              {profileSaveReport.pendingRequests.length > 0 && (
                <button type="button" onClick={retryProfileSave} disabled={settingsBusy}>실패 단계부터 다시 시도</button>
              )}
              {profileSaveReport.verificationPending && (
                <button type="button" onClick={retryProfileVerification} disabled={settingsBusy}>저장 결과 다시 확인</button>
              )}
            </div>
          )}
        </section>}

        {activeSection === "model" && <section className="settings-card model-settings-card" role="tabpanel" id="system-panel-model" aria-labelledby="system-tab-model" tabIndex={0}>
          <div className="section-title">
            <span>MODEL</span>
            <h3>모델 설정</h3>
          </div>
          <div className="model-source-row">
            <span role="status" aria-live="polite" aria-atomic="true">{modelsLoading ? "모델 목록을 불러오는 중" : modelsError ? `불러오기 실패 · ${modelsError}` : availableModels.length ? `${availableModels.length}개 모델 감지` : "등록된 모델 없음"}</span>
            {modelsError && <button type="button" onClick={refreshModels} disabled={settingsBusy}>다시 시도</button>}
            <button type="button" disabled={settingsBusy} onClick={() => setModelSelectMode((current) => current === "select" ? "manual" : "select")}>
              {modelSelectMode === "select" ? "직접 입력" : "목록 선택"}
            </button>
          </div>
          <div className="settings-summary-grid" aria-label="현재 모델 설정">
            <article><small>PROVIDER</small><strong>{workspace?.model?.provider || "설정 필요"}</strong></article>
            <article><small>ACTIVE MODEL</small><strong>{workspace?.model?.model || "설정 필요"}</strong></article>
            <article><small>CONTEXT</small><strong>{workspace?.model?.effective_context_length?.toLocaleString() || "기본값"}</strong></article>
          </div>
          <fieldset className="settings-fieldset" disabled={settingsBusy}>
          <label>Provider
            {modelOptions.length && modelSelectMode === "select" ? (
              <select value={modelDraft.provider} onChange={(event) => setModelDraft((current) => ({ ...current, provider: event.target.value, model: "" }))}>
                <option value="">전체 Provider</option>
                {providerOptions.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
              </select>
            ) : (
              <input value={modelDraft.provider} onChange={(event) => setModelDraft((current) => ({ ...current, provider: event.target.value }))} placeholder="openai" />
            )}
          </label>
          <label>Model
            {modelOptions.length && modelSelectMode === "select" ? (
              <select
                value={selectedModelValue}
                onChange={(event) => {
                  const selected = modelOptions.find((model) => model.id === event.target.value);
                  setModelDraft((current) => ({
                    ...current,
                    provider: current.provider || selected?.provider || "",
                    model: event.target.value,
                    contextLength: selected?.contextLength || current.contextLength,
                  }));
                }}
              >
                <option value="">모델 선택</option>
                {filteredModels.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}{model.provider ? ` · ${model.provider}` : ""}</option>
                ))}
              </select>
            ) : (
              <input value={modelDraft.model} onChange={(event) => setModelDraft((current) => ({ ...current, model: event.target.value }))} placeholder="gpt-5" />
            )}
          </label>
          <label>Context length<input value={modelDraft.contextLength} onChange={(event) => setModelDraft((current) => ({ ...current, contextLength: event.target.value }))} inputMode="numeric" /></label>
          <div className="settings-actions">
            <button type="button" onClick={saveModel} disabled={settingsBusy}>모델 설정 저장</button>
          </div>
          </fieldset>
          {modelSaveReport && (
            <div className={`model-save-progress ${modelSaveReport.status}`} role={["partial", "verification-failed"].includes(modelSaveReport.status) ? "alert" : "status"} aria-live="polite">
              <strong>{modelSaveReport.status === "complete" ? "적용 확인 완료" : modelSaveReport.status === "partial" ? "부분 저장됨" : modelSaveReport.status === "verification-failed" ? "적용 확인 실패" : modelSaveReport.status === "failed" ? "저장 실패" : "Hermes 설정 처리 중"}</strong>
              <span>모델 {modelSaveReport.model || "-"} · 컨텍스트 {modelSaveReport.contextLength.toLocaleString()}</span>
              {modelSaveReport.error && <small>{modelSaveReport.error}</small>}
              {modelSaveReport.status === "partial" && <button type="button" onClick={retryModelContext} disabled={settingsBusy}>컨텍스트만 다시 저장</button>}
              {modelSaveReport.status === "verification-failed" && <button type="button" onClick={retryModelVerification} disabled={settingsBusy}>적용 결과 다시 확인</button>}
            </div>
          )}
        </section>}

        {activeSection === "integration" && <section className="settings-card integration-settings-card" role="tabpanel" id="system-panel-integration" aria-labelledby="system-tab-integration" tabIndex={0}>
          <div className="section-title">
            <span>API</span>
            <h3>API · 연동 설정</h3>
          </div>
          <p className="settings-hint">API 키는 Hermes 서버의 비밀 저장소와 환경변수에서만 관리합니다. 이 화면은 키 이름을 로컬에 저장하거나 실제 연결처럼 표시하지 않습니다.</p>
          <div className="settings-readonly-list">
            <span><strong>모델 Provider</strong><small>{workspace?.model?.provider || "설정 필요"}</small></span>
            <span><strong>비밀 입력</strong><small>필요할 때 채팅의 보안 입력 창으로 한 번만 전달</small></span>
          </div>
          <div className="settings-readonly-list integration-health-list">
            <span><strong>Hermes API</strong><small>{connection === "online" ? "연결 확인됨" : "응답 대기"}</small></span>
            <span><strong>Gateway</strong><small>{running === profiles.length && profiles.length ? "전체 정상" : `${running}/${profiles.length} 실행 중`}</small></span>
            <span><strong>자격 증명 보관</strong><small>서버 환경변수 · 브라우저 비저장</small></span>
          </div>
          <div className="reservation-integration-heading">
            <div>
              <span>RESERVATION SYNC</span>
              <h4>예약 채널 · Google 계정</h4>
              <p>예약용 OAuth와 iCal 피드는 모델·Drive 자격 증명과 분리해 관리합니다.</p>
            </div>
            <button type="button" onClick={() => loadReservationIntegrations(true)} disabled={reservationIntegrationsLoading}>
              {reservationIntegrationsLoading ? "확인 중" : "실제 연결 확인"}
            </button>
          </div>
          {reservationIntegrationsError && <p className="reservation-integration-error" role="alert">{reservationIntegrationsError}</p>}
          <div className="reservation-integration-grid" aria-live="polite" aria-busy={reservationIntegrationsLoading}>
            <article>
              <header>
                <div><small>GOOGLE WORKSPACE</small><strong>Gmail · Calendar</strong></div>
                <b className={reservationIntegrations?.google?.connected ? "ready" : "attention"}>
                  {reservationIntegrations?.google?.connected ? "연결됨" : reservationIntegrations?.google?.configured ? "승인 필요" : "설정 필요"}
                </b>
              </header>
              <p>{reservationIntegrations?.google?.account || "예약 계정을 연결하면 이메일과 캘린더 API 상태가 표시됩니다."}</p>
              <dl>
                <div><dt>Gmail</dt><dd>{reservationIntegrations?.google?.gmail?.state === "ready" ? "정상" : reservationIntegrations?.google?.gmail?.state === "error" ? "오류" : "확인 대기"}</dd></div>
                <div><dt>Calendar</dt><dd>{reservationIntegrations?.google?.calendar?.state === "ready" ? "정상" : reservationIntegrations?.google?.calendar?.state === "error" ? "오류" : "확인 대기"}</dd></div>
              </dl>
              {reservationIntegrations?.google?.configured ? (
                <a className="reservation-oauth-button" href="/bridge/reservations/google/start">
                  {reservationIntegrations?.google?.connected ? "Google 계정 다시 연결" : "Google 예약 계정 연결"}
                </a>
              ) : reservationIntegrations && (
                <div className="reservation-client-setup">
                  <label>OAuth 클라이언트 ID<input autoComplete="off" value={googleClientDraft.clientId} onChange={(event) => setGoogleClientDraft((current) => ({ ...current, clientId: event.target.value }))} /></label>
                  <label>클라이언트 보안 비밀번호<input type="password" autoComplete="new-password" value={googleClientDraft.clientSecret} onChange={(event) => setGoogleClientDraft((current) => ({ ...current, clientSecret: event.target.value }))} /></label>
                  <button type="button" onClick={saveReservationGoogleClient} disabled={reservationIntegrationsLoading}>OAuth 클라이언트 저장</button>
                </div>
              )}
            </article>
            {[["hourplace", "아워플레이스"], ["spacecloud", "스페이스클라우드"]].map(([key, label]) => {
              const source = reservationIntegrations?.sources?.[key];
              const ready = source?.healthy === true;
              return (
                <article key={key}>
                  <header>
                    <div><small>ICAL SOURCE</small><strong>{label}</strong></div>
                    <b className={ready ? "ready" : source?.configured ? "checking" : "attention"}>
                      {ready ? "정상" : source?.configured ? source.state === "error" || source.state === "timeout" ? "확인 실패" : "구성됨" : "설정 필요"}
                    </b>
                  </header>
                  <p>{source?.configured ? `${source.host} 비공개 피드를 서버에서 관리합니다.` : "iCal 피드가 아직 서버에 등록되지 않았습니다."}</p>
                  <dl>
                    <div><dt>예약 항목</dt><dd>{Number.isInteger(source?.events) ? `${source.events}건` : "확인 대기"}</dd></div>
                    <div><dt>주소 노출</dt><dd>마스킹</dd></div>
                  </dl>
                  {source?.error && <small className="source-error">{source.error}</small>}
                </article>
              );
            })}
          </div>
        </section>}

        {activeSection === "reservations" && <section className="settings-card reservation-operations-card" role="tabpanel" id="system-panel-reservations" aria-labelledby="system-tab-reservations" tabIndex={0}>
          <div className="reservation-operations-header">
            <div className="section-title">
              <span>GUARDED CONTROL</span>
              <h3>통합 예약 원장</h3>
            </div>
            <button type="button" onClick={triggerReservationSync} disabled={reservationOperationsLoading || !reservationOperations.status?.enabled}>
              {reservationOperationsLoading ? "대조 중" : "지금 대조"}
            </button>
          </div>
          <p className="settings-hint">원본 예약은 각 판매 채널에 그대로 두고, 다른 채널에는 예약 불가 시간만 투영합니다. 네이버는 고객 예약을 만들지 않고 날짜별 운영시간만 조정하며 모든 변경을 재조회해 검증합니다.</p>
          {reservationOperationsError && <p className="reservation-integration-error" role="alert">{reservationOperationsError}</p>}
          <div className="reservation-ops-metrics" aria-live="polite" aria-busy={reservationOperationsLoading}>
            <span><small>동작 모드</small><strong>{reservationOperations.status?.mode || "-"}</strong></span>
            <span><small>원장 예약</small><strong>{Object.values(reservationOperations.status?.operational?.bookings || {}).reduce((sum, value) => sum + Number(value || 0), 0)}건</strong></span>
            <span><small>미해결 충돌</small><strong className={reservationOperations.conflicts.length ? "warning" : "ready"}>{reservationOperations.conflicts.length}건</strong></span>
            <span><small>대기 작업</small><strong>{Number(reservationOperations.status?.operational?.jobs?.pending || 0) + Number(reservationOperations.status?.operational?.jobs?.retrying || 0)}건</strong></span>
          </div>
          <div className="reservation-ops-grid">
            <article>
              <header><div><small>CONNECTORS</small><strong>수집기 상태</strong></div></header>
              <div className="reservation-connector-list">
                {(reservationOperations.status?.operational?.connectors || []).map((connector) => (
                  <span key={connector.connector}>
                    <b>{connector.connector}</b>
                    <small className={reservationConnectorClass(connector)}>{reservationConnectorLabel(connector)}</small>
                  </span>
                ))}
                {!reservationOperations.status?.operational?.connectors?.length && <p>첫 수집 주기를 기다리고 있습니다.</p>}
              </div>
            </article>
            <article>
              <header><div><small>SAFETY GATES</small><strong>단계별 활성화</strong></div></header>
              <dl className="reservation-safety-list">
                <div><dt>Google 통합 캘린더</dt><dd>{reservationOperations.status?.googleProjection === "enabled" ? "활성" : "대기"}</dd></div>
                <div><dt>Gmail 수집</dt><dd>{reservationOperations.status?.gmailPush === "enabled" ? "Push 활성" : reservationOperations.status?.gmailPush === "polling" ? "2분 폴링" : "샘플·Pub/Sub 필요"}</dd></div>
                <div><dt>Telegram</dt><dd>{reservationOperations.status?.telegram === "enabled" ? "활성" : "설정 필요"}</dd></div>
                <div><dt>네이버</dt><dd>{reservationWriterLabel(reservationOperations.status, "naver", "availability-schedule", "일정 차단")}</dd></div>
                <div><dt>아워플레이스</dt><dd>{reservationOperations.status?.platformWriters?.hourplace === "google-ical" ? "iCal 전송" : "shadow"}</dd></div>
                <div><dt>스페이스클라우드</dt><dd>{reservationWriterLabel(reservationOperations.status, "spacecloud", "browser-write", "캘린더 차단")}</dd></div>
                <div><dt>네이버 날짜 계획</dt><dd>{Object.entries(reservationOperations.status?.operational?.availabilityDays || {}).map(([state, count]) => `${state} ${count}`).join(" · ") || "대기"}</dd></div>
              </dl>
              <div className="reservation-browser-actions">
                {["naver", "spacecloud"].map((platform) => {
                  const href = reservationLiveViewerUrl(reservationOperations.status, platform);
                  if (!href) return null;
                  return <a key={platform} href={href} target="_blank" rel="noreferrer">{platform === "naver" ? "네이버" : "스페이스클라우드"} 로그인 화면</a>;
                })}
              </div>
            </article>
          </div>
          <div className="reservation-ledger-table-wrap">
            <div className="reservation-subheading"><span>LEDGER</span><h4>최근 예약</h4></div>
            <table className="reservation-ledger-table">
              <thead><tr><th>채널</th><th>상태</th><th>일시</th><th>예약번호</th></tr></thead>
              <tbody>
                {reservationOperations.bookings.map((booking) => (
                  <tr key={booking.bookingKey}>
                    <td>{({ naver: "네이버", hourplace: "아워플레이스", spacecloud: "스페이스클라우드", manual: "수동" })[booking.sourcePlatform] || booking.sourcePlatform}</td>
                    <td><b className={`reservation-status ${booking.status}`}>{booking.status}</b></td>
                    <td>{new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date(booking.startAt))}</td>
                    <td>{booking.externalBookingIdMasked}</td>
                  </tr>
                ))}
                {!reservationOperations.bookings.length && <tr><td colSpan="4">원장에 수집된 예약이 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
          {reservationOperations.conflicts.length > 0 && <div className="reservation-conflict-list" role="alert">
            <div className="reservation-subheading"><span>CONFLICTS</span><h4>조치가 필요한 충돌</h4></div>
            {reservationOperations.conflicts.map((conflict) => (
              <article key={conflict.conflictKey}><strong>{conflict.left.sourcePlatform} ↔ {conflict.right.sourcePlatform}</strong><span>{new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date(conflict.overlapStartAt))}</span></article>
            ))}
          </div>}
        </section>}

        {activeSection === "notifications" && <section className="settings-card notification-settings-card" role="tabpanel" id="system-panel-notifications" aria-labelledby="system-tab-notifications" tabIndex={0}>
          <div className="section-title">
            <span>NOTIFICATIONS</span>
            <h3>알림 설정</h3>
          </div>
          <p className="settings-hint">회의가 끝나거나 구성원이 최종 보고를 남기면 이 PC에서 알림을 받을 수 있습니다.</p>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={notificationSettings.enabled}
              onChange={(event) => onNotificationSettingsChange({ enabled: event.target.checked })}
            />
            <span><strong>로컬 알림 사용</strong><small>사이트 안쪽 토스트 알림을 표시합니다.</small></span>
          </label>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={notificationSettings.sound}
              disabled={!notificationSettings.enabled}
              onChange={(event) => onNotificationSettingsChange({ sound: event.target.checked })}
            />
            <span><strong>알림 소리</strong><small>보고가 도착하면 짧은 알림음을 재생합니다.</small></span>
          </label>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={notificationSettings.preview}
              disabled={!notificationSettings.enabled}
              onChange={(event) => onNotificationSettingsChange({ preview: event.target.checked })}
            />
            <span><strong>메시지 미리보기 표시</strong><small>끄면 알림에는 간단한 문구만 표시합니다.</small></span>
          </label>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={notificationSettings.browser}
              disabled={!notificationSettings.enabled}
              onChange={(event) => { toggleBrowserNotification(event.target.checked).catch((error) => setSettingsNotice(error.message)); }}
            />
            <span><strong>브라우저 시스템 알림</strong><small>권한을 허용하면 Windows 알림으로도 표시합니다.</small></span>
          </label>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={notificationSettings.autoOpenChat}
              disabled={!notificationSettings.enabled}
              onChange={(event) => onNotificationSettingsChange({ autoOpenChat: event.target.checked })}
            />
            <span><strong>보고 도착 시 대화창으로 이동</strong><small>집중 흐름을 방해할 수 있어 기본값은 꺼짐입니다.</small></span>
          </label>
          <div className="settings-actions">
            <button type="button" onClick={onTestNotification}>테스트 알림 보내기</button>
          </div>
        </section>}
      </div>}
    </section>
  );
}

function OfficeApp() {
  const [view, setView] = useState(initialViewFromUrl);
  const [workspace, setWorkspace] = useState(() => loadCachedWorkspace());
  const [organization, setOrganization] = useState({ version: 1, revision: 0, nodes: [], audit: [] });
  const [organizationStatus, setOrganizationStatus] = useState("loading");
  const [organizationError, setOrganizationError] = useState("");
  const organizationSeedStartedRef = useRef(false);
  const [error, setError] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("");
  const [selectedRoomContext, setSelectedRoomContext] = useState(null);
  const [selectedSession, setSelectedSession] = useState("");
  const [chatContext, setChatContext] = useState(null);
  const [chatProfile, setChatProfile] = useState("default");
  const [chatSessionId, setChatSessionId] = useState("");
  const [chatInitialDraft, setChatInitialDraft] = useState("");
  const [branchFrom, setBranchFrom] = useState(null);
  const [activeMeetings, setActiveMeetings] = useState(loadActiveMeetings);
  const [selectedMeetingId, setSelectedMeetingId] = useState(() => loadActiveMeetings()[0]?.id ?? "");
  const [meetingCloseRequests, setMeetingCloseRequests] = useState({});
  const [meetingClock, setMeetingClock] = useState(Date.now);
  const activeMeeting = activeMeetings.find((meeting) => meeting.id === selectedMeetingId) ?? null;
  const [agentActivities, setAgentActivities] = useState({});
  const [connection, setConnection] = useState("connecting");
  const [mobileNav, setMobileNav] = useState(false);
  const mobileNavRef = useModalFocus(mobileNav, () => setMobileNav(false));
  const [missions, setMissions] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [notificationSettings, setNotificationSettings] = useState(() => ({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...loadLocalState(NOTIFICATION_SETTINGS_KEY, {}),
  }));
  const [localNotification, setLocalNotification] = useState(null);
  const notificationTimerRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setError("");
      const nextWorkspace = await loadWorkspace();
      setWorkspace(nextWorkspace);
      setConnection("online");
      try {
        const board = await hermesFetch("/api/plugins/kanban/board", { cacheTtlMs: 10000 });
        setMissions(officeMissionsFromBoard(board));
      } catch (boardError) {
        setMissions([]);
        setError(`Hermes 업무 보드를 불러오지 못했습니다. (${boardError.message})`);
      }
    } catch (loadError) {
      setError(loadError.message);
      setConnection("offline");
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("hermes:refresh-workspace", refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
      window.removeEventListener("hermes:refresh-workspace", refresh);
    };
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedRoom("");
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const officeNotice = view === "office" && /승인|보류|검토|요청/.test(error);

  useEffect(() => {
    if (!officeNotice) return undefined;
    const timer = window.setTimeout(() => setError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [officeNotice, error]);

  useEffect(() => {
    window.localStorage.removeItem("greeming-hermes-missions");
    window.localStorage.removeItem("greeming-hermes-approvals");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(notificationSettings));
  }, [notificationSettings]);

  useEffect(() => {
    if (activeMeetings.length) {
      window.localStorage.setItem(ACTIVE_MEETING_KEY, JSON.stringify(activeMeetings));
    } else {
      window.localStorage.removeItem(ACTIVE_MEETING_KEY);
    }
  }, [activeMeetings]);

  useEffect(() => {
    const completedMeetings = activeMeetings.filter((meeting) => meeting.status === "complete");
    if (!completedMeetings.length) return undefined;
    const removeArchived = () => {
      const now = Date.now();
      setMeetingClock(now);
      setActiveMeetings((current) => {
        const next = current.filter((meeting) => !isMeetingArchiveDue(meeting, now));
        return next.length === current.length ? current : next;
      });
      setSelectedMeetingId((current) => {
        const selected = activeMeetings.find((meeting) => meeting.id === current);
        return selected && isMeetingArchiveDue(selected, now) ? "" : current;
      });
    };
    removeArchived();
    const nextArchiveAt = Math.min(...completedMeetings.map(meetingArchiveAt).filter(Boolean));
    const archiveTimer = window.setTimeout(removeArchived, Math.max(0, nextArchiveAt - Date.now()) + 50);
    const clockTimer = window.setInterval(removeArchived, 30000);
    return () => {
      window.clearTimeout(archiveTimer);
      window.clearInterval(clockTimer);
    };
  }, [activeMeetings]);

  const profiles = useMemo(
    () => (workspace?.profiles ?? [])
      .filter((profile) => profile?.name)
      .map((profile) => withEffectiveProfileStatus(profile, agentActivities[profile.name], Boolean(workspace))),
    [agentActivities, workspace],
  );
  const roomAssignments = useMemo(
    () => organizationRoomAssignments(organization.nodes),
    [organization.nodes],
  );

  useEffect(() => {
    let stopped = false;
    loadOrganization()
      .then(async (state) => {
        const normalizedNodes = validateOrganizationNodes(state?.nodes ?? []);
        const requiresMigration = JSON.stringify(normalizedNodes) !== JSON.stringify(state?.nodes ?? []);
        let normalizedState = { ...state, nodes: normalizedNodes };
        if (requiresMigration) {
          try {
            normalizedState = await saveOrganization(normalizedNodes, state.revision);
          } catch (migrationError) {
            if (migrationError.status !== 409 || !migrationError.current) throw migrationError;
            normalizedState = {
              ...migrationError.current,
              nodes: validateOrganizationNodes(migrationError.current.nodes ?? []),
            };
          }
        }
        if (stopped) return;
        setOrganization(normalizedState);
        setOrganizationStatus("ready");
        setOrganizationError("");
      })
      .catch((loadError) => {
        if (stopped) return;
        setOrganizationStatus("error");
        setOrganizationError(loadError.message);
      });
    return () => { stopped = true; };
  }, []);

  useEffect(() => {
    if (organizationStatus !== "ready" || organization.revision !== 0 || organization.nodes.length || !profiles.length || organizationSeedStartedRef.current) return;
    organizationSeedStartedRef.current = true;
    const defaults = buildDefaultOrganizationNodes(profiles);
    saveOrganization(defaults, 0)
      .then((state) => {
        setOrganization(state);
        setOrganizationStatus("ready");
      })
      .catch((saveError) => {
        if (saveError.status === 409 && saveError.current) setOrganization(saveError.current);
        setOrganizationStatus(saveError.status === 409 ? "ready" : "error");
        setOrganizationError(saveError.message);
        if (saveError.status !== 409) organizationSeedStartedRef.current = false;
      });
  }, [organization.nodes.length, organization.revision, organizationStatus, profiles]);

  const saveOrganizationStructure = useCallback(async (nodes) => {
    setOrganizationStatus("saving");
    setOrganizationError("");
    try {
      const state = await saveOrganization(nodes, organization.revision);
      setOrganization(state);
      setOrganizationStatus("ready");
      return state;
    } catch (saveError) {
      if (saveError.status === 409 && saveError.current) {
        setOrganization(saveError.current);
        setOrganizationStatus("ready");
      } else {
        setOrganizationStatus("error");
      }
      setOrganizationError(saveError.message);
      throw saveError;
    }
  }, [organization.revision]);
  const workspaceForViews = useMemo(() => {
    if (!workspace) return workspace;
    const managed = new Map(profiles.map((profile) => [profile.name, profile]));
    return {
      ...workspace,
      profiles: (workspace.profiles ?? []).map((profile) => managed.get(profile.name) ?? profile),
    };
  }, [profiles, workspace]);
  const systemHealthy = connection === "online" || Boolean(workspace);

  const updateNotificationSettings = useCallback((patch) => {
    setNotificationSettings((current) => ({ ...current, ...patch }));
  }, []);

  const playNotificationSound = useCallback(() => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(740, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(520, context.currentTime + 0.14);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
      window.setTimeout(() => context.close().catch(() => {}), 400);
    } catch {
      // Audio can be blocked until the first user gesture. The visual alert still works.
    }
  }, []);

  const showLocalNotification = useCallback((notification) => {
    if (!notificationSettings.enabled) return;
    const payload = {
      id: notification.id ?? crypto.randomUUID(),
      title: notification.title,
      body: notificationSettings.preview ? notification.body : "새 보고가 도착했습니다. 내용을 보려면 대화창을 열어주세요.",
      profile: notification.profile,
      meetingId: notification.meetingId,
      createdAt: Date.now(),
    };
    setLocalNotification(payload);
    window.clearTimeout(notificationTimerRef.current);
    notificationTimerRef.current = window.setTimeout(() => setLocalNotification(null), 7000);
    if (notificationSettings.sound) playNotificationSound();
    if (notificationSettings.browser && "Notification" in window) {
      const notify = () => new Notification(payload.title, { body: payload.body, tag: payload.id });
      if (Notification.permission === "granted") notify();
      else if (Notification.permission !== "denied") Notification.requestPermission().then((permission) => {
        if (permission === "granted") notify();
      });
    }
  }, [notificationSettings, playNotificationSound]);

  const saveLocalReport = useCallback((report) => {
    const reports = loadLocalState(LOCAL_REPORTS_KEY, []);
    const nextReports = [report, ...reports.filter((item) => item.id !== report.id)].slice(0, 100);
    window.localStorage.setItem(LOCAL_REPORTS_KEY, JSON.stringify(nextReports));
    window.dispatchEvent(new CustomEvent("hermes:local-report", { detail: report }));
  }, []);

  const testNotification = useCallback(() => {
    showLocalNotification({
      title: "Hermes 알림 테스트",
      body: "알림 설정이 정상적으로 적용되었습니다.",
      profile: "default",
    });
  }, [showLocalNotification]);

  useEffect(() => {
    syncViewUrl(view);
  }, [view]);

  const navigate = useCallback((nextView) => {
    setView(nextView);
    setMobileNav(false);
    if (nextView !== "office") {
      setSelectedRoom("");
      setSelectedRoomContext(null);
    }
  }, []);

  const openRoom = (roomId, context = null) => {
    setView("office");
    setSelectedRoom(roomId);
    setSelectedRoomContext(context);
    setMobileNav(false);
  };

  const startChat = (target) => {
    setSelectedSession("");
    setChatSessionId("");
    setBranchFrom(null);
    setChatInitialDraft(typeof target === "string" ? "" : target?.prompt ?? "");
    const profileName = typeof target === "string"
      ? target
      : target?.profile ?? target?.profiles?.[0] ?? "default";
    setChatProfile(profileName);
    setChatContext(typeof target === "string" ? null : target);
    if (target?.participants?.length) {
      setAgentActivities((current) => {
        const next = { ...current };
        target.participants.forEach((participant) => {
          next[participant] = {
            state: "meeting",
            text: target.topic || target.subtitle || "팀 회의 중",
            collaborator: target.participants
              .filter((name) => name !== participant)
              .map((name) => TEAM_META[name]?.name)
              .filter(Boolean)
              .join(", "),
          };
        });
        return next;
      });
    }
    navigate("chat");
  };

  const continueMission = async (mission, session = null) => {
    const owner = mission?.owner ?? "default";
    let targetSession = session;
    if (!targetSession?.id) {
      try {
        const sessions = await loadProfileSessions(owner, 1, { includeMeetings: false });
        targetSession = sessions[0] ?? null;
      } catch {
        targetSession = null;
      }
    }
    setSelectedSession("");
    setBranchFrom(null);
    setChatInitialDraft("");
    setChatProfile(owner);
    setChatContext({
      id: mission?.room ?? "mission",
      label: mission?.title ?? "Active mission",
      profile: owner,
      missionId: mission?.id,
    });
    setChatSessionId(targetSession?.id ?? "");
    if (!targetSession?.id) {
      setError("기존 대화 세션을 찾지 못해 해당 구성원과 새 대화로 이동합니다.");
    }
    navigate("chat");
  };

  const updateAgentActivity = useCallback((profileName, activity) => {
    setAgentActivities((current) => {
      const nextActivity = {
        ...(current[profileName] ?? {}),
        ...activity,
        view: activity.view ?? current[profileName]?.view,
      };
      publishLiveActivity(profileName, nextActivity);
      return {
        ...current,
        [profileName]: nextActivity,
      };
    });
  }, []);

  const handleMeetingComplete = useCallback((report) => {
    saveLocalReport(report);
    const reporterName = TEAM_META[report.profile]?.name ?? "구성원";
    showLocalNotification({
      id: report.id,
      title: `${reporterName}의 회의 완료 보고`,
      body: report.summary,
      profile: report.profile,
      meetingId: report.meetingId,
    });
    updateAgentActivity(report.profile, {
      state: "online",
      text: "회의 완료 보고 전송",
      collaborator: "사용자",
      completedAt: Date.now(),
    });
    setActiveMeetings((current) => current.map((meeting) => (
      meeting.id === report.meetingId
        ? markMeetingComplete({ ...meeting, outcome: report.outcome }, report.createdAt)
        : meeting
    )));
    if (notificationSettings.autoOpenChat) {
      setChatProfile(report.profile);
      setChatSessionId("");
      setBranchFrom(null);
      setChatContext({ id: "meeting-report", label: report.topic, profile: report.profile });
      navigate("chat");
    }
  }, [navigate, notificationSettings.autoOpenChat, saveLocalReport, showLocalNotification, updateAgentActivity]);

  const requestMeetingClose = useCallback((meeting) => {
    if (meeting.status !== "complete" && !window.confirm("진행 중인 회의를 종료하고 현재 기록을 아카이브로 이동할까요?")) return;
    setMeetingCloseRequests((current) => ({ ...current, [meeting.id]: Date.now() }));
  }, []);

  const handleMeetingClosed = useCallback(({ meetingId }) => {
    setActiveMeetings((current) => current.filter((meeting) => meeting.id !== meetingId));
    setSelectedMeetingId((current) => current === meetingId ? "" : current);
    setMeetingCloseRequests((current) => {
      const next = { ...current };
      delete next[meetingId];
      return next;
    });
  }, []);

  const handleMeetingReopened = useCallback(({ meetingId }) => {
    setActiveMeetings((current) => current.map((meeting) => {
      if (meeting.id !== meetingId) return meeting;
      const reopened = { ...meeting, status: "discussion" };
      delete reopened.completedAt;
      delete reopened.archiveAt;
      return reopened;
    }));
  }, []);

  const startMeeting = useCallback((meeting) => {
    const preparedMeeting = {
      ...meeting,
      id: meeting.id ?? crypto.randomUUID(),
      startedAt: meeting.startedAt ?? Date.now(),
    };
    setActiveMeetings((current) => [preparedMeeting, ...current.filter((item) => item.id !== preparedMeeting.id)]);
    setSelectedMeetingId(preparedMeeting.id);
    setAgentActivities((current) => {
      const next = { ...current };
      preparedMeeting.participants.forEach((participant) => {
        next[participant] = {
          state: "meeting",
          text: preparedMeeting.topic,
          collaborator: preparedMeeting.participants
            .filter((name) => name !== participant)
            .map((name) => TEAM_META[name]?.name)
            .filter(Boolean)
            .join(", "),
        };
      });
      return next;
    });
    navigate("meeting");
  }, [navigate]);

  const toggleMissionStep = async (missionId, stepId) => {
    const mission = missions.find((item) => item.id === missionId);
    if (!mission) return;
    try {
      await patchOfficeTaskFromLatest(hermesFetch, missionId, {}, (latestTask) => ({
        ...(latestTask.metadata ?? {}),
        checklist: (latestTask.metadata?.checklist ?? []).map((step, index) => {
          const id = step.id ?? `${missionId}-step-${index}`;
          return id === stepId ? { ...step, done: !step.done } : step;
        }),
      }));
      await refresh();
    } catch (taskError) {
      setError(taskError.message);
    }
  };

  const moveMission = async (missionId, status) => {
    const mission = missions.find((item) => item.id === missionId);
    if (!mission) return;
    try {
      const targetStatus = { queued: "todo", working: "running", approval: "review", done: "done" }[status] ?? status;
      const plan = officialKanbanMovePlan(targetStatus);
      await patchOfficeTaskFromLatest(hermesFetch, missionId, { status: plan.status }, (latestTask) => ({
        ...(latestTask.metadata ?? {}),
        status_note: `Office에서 ${status} 상태로 이동`,
      }));
      if (plan.dispatch) {
        await hermesFetch("/api/plugins/kanban/dispatch", {
          method: "POST",
          body: JSON.stringify({}),
          timeoutMs: 60000,
        });
      }
      await refresh();
    } catch (taskError) {
      setError(taskError.message);
    }
  };

  const deleteMission = async (mission, reason) => {
    if (!mission?.id || !String(reason || "").trim()) return;
    try {
      await patchOfficeTaskFromLatest(hermesFetch, mission.id, { status: "archived" }, (latestTask) => ({
        ...(latestTask.metadata ?? {}),
        deleted_at: new Date().toISOString(),
        deleted_by: "user",
        delete_reason: String(reason).trim(),
        status_note: `지휘 센터에서 삭제: ${String(reason).trim()}`,
      }));
      await refresh();
      setError(`“${mission.title}” Task를 삭제하고 기록 보관함으로 이동했습니다.`);
    } catch (taskError) {
      setError(taskError.message);
      throw taskError;
    }
  };

  const decideApproval = (approvalId, decision) => {
    const approval = approvals.find((item) => item.id === approvalId);
    if (decision === "escalated" && approval) {
      const escalated = {
        ...approval,
        id: `${approval.id}-exec-${Date.now()}`,
        approver: "default",
        approvers: ["default"],
        risk: "상위 검토",
        title: `상위 검토: ${approval.title}`,
        description: `${approval.description} 담당자가 상위 검토가 필요하다고 판단했습니다.`,
        escalated: true,
      };
      setApprovals((current) => [escalated, ...current.filter((item) => item.id !== approvalId)]);
      setError(`${approval.title ?? "요청"}을 상위 검토로 올렸습니다.`);
      return;
    }
    setApprovals((current) => current.filter((item) => item.id !== approvalId));
    setError(
      decision === "approved"
        ? `${approval?.title ?? "요청"}을 승인했습니다. ${approval?.requester ? profileLabel(approval.requester) : "요청자"}가 후속 작업을 진행할 수 있습니다.`
        : `${approval?.title ?? "요청"}을 보류 처리했습니다. 기준이나 설명을 보강해야 합니다.`,
    );
  };

  const addGovernanceApproval = useCallback((approval) => {
    setApprovals((current) => [approval, ...current.filter((item) => item.id !== approval.id)]);
    setError(`${approval.title}을 ${approval.risk} 요청으로 올렸습니다.`);
  }, []);

  const continueSession = (session) => {
    setChatProfile(session.profile ?? "default");
    setChatSessionId(session.id);
    setBranchFrom(null);
    setChatInitialDraft("");
    navigate("chat");
  };

  const branchSession = (session) => {
    setChatProfile(session.profile ?? "default");
    setChatSessionId("");
    setBranchFrom(session);
    setChatInitialDraft("");
    navigate("chat");
  };
  const handleBranchHandled = useCallback(() => setBranchFrom(null), []);

  const openSessionTerminal = (sessionId) => {
    setSelectedSession(sessionId);
    navigate("terminal");
  };

  const title = {
    command: "지휘 센터",
    office: "AI 오피스",
    meeting: "실시간 AI 회의",
    desk: "미션 보드",
    kanban: "Hermes 칸반",
    data: "데이터룸",
    chat: "Hermes 대화",
    sessions: "대화 기록",
    team: "AI 팀",
    plugins: "Plugin",
    system: "시스템",
    terminal: "Hermes 운영 콘솔",
  }[view];
  const activeChatProfiles = profiles.filter((profile) => ["working", "meeting", "approval"].includes(agentActivities[profile.name]?.state));
  const activeChatCount = activeChatProfiles.length;
  const primaryActiveChat = activeChatProfiles[0];
  const primaryActiveChatName = primaryActiveChat ? TEAM_META[primaryActiveChat.name]?.name ?? primaryActiveChat.name : "";
  const primaryActiveChatText = primaryActiveChat ? agentActivities[primaryActiveChat.name]?.text || "작업 중" : "";
  const activeChatSummary = activeChatCount
    ? `${activeChatProfiles.map((profile) => TEAM_META[profile.name]?.name ?? profile.name).join(", ")} 작업 중`
    : "";
  const activeChatDetail = activeChatCount > 1
    ? `${primaryActiveChatName} · ${primaryActiveChatText} 외 ${activeChatCount - 1}명`
    : `${primaryActiveChatName} · ${primaryActiveChatText}`;

  return (
    <div className="app-shell">
      <aside
        ref={mobileNavRef}
        id="primary-navigation"
        className={`sidebar ${mobileNav ? "open" : ""}`}
        role={mobileNav ? "dialog" : undefined}
        aria-modal={mobileNav ? "true" : undefined}
        aria-label={mobileNav ? "주요 메뉴" : undefined}
        tabIndex={mobileNav ? -1 : undefined}
      >
        <button type="button" className="sidebar-close" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)}>×</button>
        <div className="brand-lockup">
          <img src="/hermes-mark.svg" alt="" />
          <div>
            <strong>GREEMING</strong>
            <span>AI OFFICE</span>
          </div>
        </div>
        <nav aria-label="주요 메뉴">
          {NAV_GROUPS.map((group) => (
            <section key={group.label} className="nav-group">
              <span>{group.label}</span>
              {group.items.map(([id, label, short]) => (
                <button
                  type="button"
                  key={id}
                  className={view === id ? "active" : ""}
                  aria-current={view === id ? "page" : undefined}
                  onClick={() => {
                    if (id === "chat") setChatContext(null);
                    navigate(id);
                  }}
                >
                  <b>{short}</b>
                  <strong>{label}</strong>
                  {id === "meeting" && activeMeetings.length > 0 && <i />}
                  {id === "chat" && activeChatCount > 0 && (
                    <span className="nav-activity-count" title={activeChatSummary} aria-label={activeChatSummary}>{activeChatCount}</span>
                  )}
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className={systemHealthy ? "online" : connection} />
          <div>
            <strong>{systemHealthy ? "시스템 정상" : "연결 확인 중"}</strong>
            <small>{workspace?.model?.model ?? "Hermes"}</small>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <button
            className="menu-button"
            type="button"
            aria-controls="primary-navigation"
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(true)}
          >
            메뉴
          </button>
          <div>
            <span>GREEMING WORKSPACE / {view.toUpperCase()}</span>
            <h1>{title}</h1>
          </div>
          <div className="topbar-meta">
            {view !== "chat" && activeChatCount > 0 && (
              <button
                className="background-chat-activity"
                type="button"
                title={activeChatSummary}
                aria-live="polite"
                onClick={() => navigate("chat")}
              >
                <i />
                <span>{activeChatDetail}</span>
              </button>
            )}
            <span className="topbar-signal"><i />{profiles.filter((profile) => profile.gateway_running).length}명 온라인</span>
            {activeMeetings.length > 0 && <button className="meeting-jump" type="button" onClick={() => navigate("meeting")}>진행 중 회의 {activeMeetings.length}</button>}
            <span>
              {new Intl.DateTimeFormat("ko", {
                month: "long",
                day: "numeric",
                weekday: "short",
              }).format(new Date())}
            </span>
            <button type="button" onClick={refresh}>새로고침</button>
          </div>
        </header>

        {error && !officeNotice && (
          <div className={`error-banner ${error.includes("승인") || error.includes("보류") ? "notice" : ""}`}>
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>닫기</button>
          </div>
        )}

        {officeNotice && (
          <div className="office-floating-notice" role="status">
            <span>완료</span>
            <strong>{error}</strong>
            <button type="button" onClick={() => setError("")}>닫기</button>
          </div>
        )}

        {view === "command" && (
          <CommandCenter
            workspace={workspaceForViews}
            missions={missions}
            approvals={approvals}
            onToggleStep={toggleMissionStep}
            onApprovalDecision={decideApproval}
            onOpenOffice={() => navigate("office")}
            onOpenRoom={openRoom}
            onStartChat={startChat}
            onContinueMission={continueMission}
            onDeleteMission={deleteMission}
          />
        )}

        {view === "office" && (
          <HermesOffice
            workspace={workspaceForViews}
            missions={missions}
            approvals={approvals}
            focusedRoom={selectedRoom}
            focusedRoomContext={selectedRoomContext}
            onOpenCommand={() => navigate("command")}
            onStartChat={startChat}
            onMoveMission={moveMission}
            onApprovalDecision={decideApproval}
            agentActivities={agentActivities}
            onActivityChange={updateAgentActivity}
            onStartMeeting={startMeeting}
            onOpenKanban={() => navigate("kanban")}
            onOpenData={() => navigate("data")}
            onGovernanceApprovalRequest={addGovernanceApproval}
            hasActiveMeeting={activeMeetings.length > 0}
            onOpenActiveMeeting={() => navigate("meeting")}
            roomAssignments={roomAssignments}
          />
        )}

        {view === "meeting" && activeMeetings.length > 0 && (
          <nav className="meeting-runtime-tabs" aria-label="열린 회의" role="tablist">
            {activeMeetings.map((meeting) => (
              <div key={meeting.id} className={`meeting-runtime-tab ${selectedMeetingId === meeting.id ? "active" : ""}`}>
                <button
                  type="button"
                  className="meeting-runtime-tab-select"
                  role="tab"
                  aria-selected={selectedMeetingId === meeting.id}
                  onClick={() => setSelectedMeetingId(meeting.id)}
                >
                  <i className={meeting.status === "complete" ? "complete" : "running"} />
                  <span><b>{cleanMeetingTopic(meeting.topic)}</b><small>{meetingArchiveCountdown(meeting, meetingClock)}</small></span>
                </button>
                <button
                  type="button"
                  className="meeting-runtime-tab-close"
                  aria-label={`${cleanMeetingTopic(meeting.topic)} 회의 종료`}
                  title={meeting.status === "complete" ? "지금 아카이브로 이동" : "회의 종료"}
                  onClick={() => requestMeetingClose(meeting)}
                >×</button>
              </div>
            ))}
            <button type="button" className={`meeting-runtime-new ${!selectedMeetingId ? "active" : ""}`} onClick={() => setSelectedMeetingId("")}>+ 새 회의</button>
          </nav>
        )}

        {activeMeetings.map((meeting) => (
          <div key={meeting.id} className="meeting-console-host" hidden={view !== "meeting" || selectedMeetingId !== meeting.id}>
            <MeetingConsole
              meeting={meeting}
              onActivityChange={updateAgentActivity}
              onMeetingComplete={handleMeetingComplete}
              closeRequest={meetingCloseRequests[meeting.id]}
              onMeetingClosed={handleMeetingClosed}
              onMeetingReopened={handleMeetingReopened}
              onExit={() => navigate("office")}
            />
          </div>
        ))}

        {view === "meeting" && !activeMeeting && (
          <MeetingLobby
            profiles={profiles}
            activeMeetings={activeMeetings}
            onOpenMeeting={setSelectedMeetingId}
            onStartMeeting={startMeeting}
            onOpenOffice={() => openRoom("meeting")}
          />
        )}

        {view === "kanban" && (
          <HermesKanban onOpenAgent={startChat} onStartMeeting={startMeeting} />
        )}

        {view === "data" && (
          <DataRoom onStartChat={startChat} onStartMeeting={startMeeting} />
        )}

        <section
          className={`page-card chat-page persistent-chat-runtime ${view === "chat" ? "" : "is-background"}`}
          aria-hidden={view !== "chat"}
        >
            <PageIntro
              eyebrow="DIRECT LINE"
              title={chatContext?.id === "meeting" ? "AI 팀 회의 채널" : "구성원별 직접 대화"}
              description="선택한 구성원의 Hermes 프로필에 직접 연결하며, 다른 구성원의 대화와 섞이지 않습니다."
            />
            <ProfileChat
              initialProfile={chatProfile}
              initialSessionId={chatSessionId}
              initialDraft={chatInitialDraft}
              branchFrom={branchFrom}
              onBranchHandled={handleBranchHandled}
              profiles={profiles}
              activities={agentActivities}
              onActivityChange={updateAgentActivity}
              onStartMeeting={startMeeting}
              onGovernanceApprovalRequest={addGovernanceApproval}
            />
        </section>

        {view === "sessions" && (
          <section className="page-card sessions-page">
            <PageIntro
              eyebrow="CONVERSATION ARCHIVE"
              title="업무와 대화를 이어가세요"
              description="최근 대화를 선택하면 Hermes 콘솔에서 바로 이어집니다."
            />
            <SessionArchive
              profiles={profiles}
              onContinue={continueSession}
              onBranch={branchSession}
              onTerminal={openSessionTerminal}
              onFollowupMeeting={(meeting) => startMeeting({
                topic: `후속 회의: ${meeting.topic}`,
                participants: meeting.participants,
                subtitle: `${meeting.topic} 후속 회의`,
              })}
            />
          </section>
        )}

        {view === "team" && (
          <section className="team-page">
            <TeamWorkspace
              profiles={profiles}
              activities={agentActivities}
              missions={missions}
              organization={organization}
              organizationStatus={organizationStatus}
              organizationError={organizationError}
              onSaveOrganization={saveOrganizationStructure}
              onChat={startChat}
              onOpenOffice={() => navigate("office")}
            />
          </section>
        )}

        {view === "plugins" && (
          <section className="page-card plugins-page">
            <PageIntro
              eyebrow="PLUGIN REGISTRY"
              title="프로필별 도구 설치와 검증"
              description="검증된 MCP, plugin, skill을 프로필별로 선택하고 실제 연결 상태를 확인합니다."
            />
            <PluginHub profiles={profiles} />
          </section>
        )}

        {view === "system" && (
          <SystemPage
            workspace={workspaceForViews}
            connection={connection}
            notificationSettings={notificationSettings}
            onNotificationSettingsChange={updateNotificationSettings}
            onTestNotification={testNotification}
          />
        )}

        {view === "terminal" && (
          <section className="hermes-dashboard-page">
            <Suspense fallback={<div className="module-loading"><i /><span>Hermes 터미널을 불러오는 중입니다.</span></div>}>
              <HermesDashboard resumeSessionId={selectedSession} onStatusChange={setConnection} />
            </Suspense>
          </section>
        )}
      </main>

      <nav className="mobile-dock" aria-label="모바일 빠른 이동">
        {MOBILE_TABS.map(([id, label, short]) => (
          <button
            type="button"
            key={id}
            className={view === id ? "active" : ""}
            aria-current={view === id ? "page" : undefined}
            onClick={() => {
              if (id === "chat") setChatContext(null);
              navigate(id);
            }}
          >
            <b>{short}</b>
            <span>{label}</span>
            {id === "meeting" && activeMeetings.length > 0 && <i />}
            {id === "chat" && activeChatCount > 0 && (
              <em className="mobile-activity-count" aria-label={activeChatSummary}>{activeChatCount}</em>
            )}
          </button>
        ))}
      </nav>

      {mobileNav && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="메뉴 닫기"
          onClick={() => setMobileNav(false)}
        />
      )}

      {localNotification && (
        <aside className="local-notification-toast" role="status">
          <span>{TEAM_META[localNotification.profile]?.initials ?? "AI"}</span>
          <div>
            <strong>{localNotification.title}</strong>
            <p>{localNotification.body}</p>
          </div>
          <button type="button" onClick={() => {
            setChatProfile(localNotification.profile ?? "default");
            setChatSessionId("");
            setBranchFrom(null);
            navigate("chat");
            setLocalNotification(null);
          }}>보기</button>
          <button type="button" aria-label="알림 닫기" onClick={() => setLocalNotification(null)}>×</button>
        </aside>
      )}
    </div>
  );
}

export default function App() {
  return window.location.pathname === "/agent-live" ? <AgentLivePage /> : <OfficeApp />;
}
