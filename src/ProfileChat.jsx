import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HermesGateway } from "./gateway.js";
import { LiveScreenModal, LiveScreenPanel } from "./LiveScreen.jsx";
import {
  archiveChatSession,
  chatFileUrl,
  deleteChatFile,
  decodeHermesText,
  loadChatFiles,
  loadLiveScreen,
  loadProfileSessions,
  loadSessionMessages,
  isRequestCancellation,
  isTransientRequestError,
  prepareChatFiles,
  releaseLiveScreen,
  uploadChatFiles,
} from "./hermes.js";
import { mergeActivityView } from "./activityView.js";
import HermesPrompt from "./HermesPrompt.jsx";
import { publishLiveActivity, readLiveActivity } from "./liveScreenState.js";
import { TEAM_META } from "./officeData.js";
import { extractClipboardImageFiles, readClipboardImageFiles } from "./composerClipboard.js";
import { hitlResponseRequest, isHitlRequestExpired, normalizeHitlRequest, sessionBranchRequest } from "./officialContracts.js";
import { useModalFocus } from "./useModalFocus.js";

const PROFILE_ORDER = Object.keys(TEAM_META);
const STORAGE_KEY = "greeming-hermes-chat-selection";
const READ_STATE_KEY = "greeming-hermes-chat-read-state";
const HIDDEN_SESSIONS_KEY = "greeming-hermes-hidden-chat-sessions";
const HIDDEN_SESSIONS_MIGRATED_KEY = "greeming-hermes-hidden-chat-sessions-migrated";
const LOCAL_REPORTS_KEY = "greeming-hermes-local-reports";

function emptyThread() {
  return {
    liveSessionId: "",
    storedSessionId: "",
    messages: [],
    tools: [],
    status: "대기 중",
    running: false,
    error: "",
    conversationKey: "",
    files: [],
    progress: [],
    startedAt: 0,
    finishedAt: 0,
    heartbeat: 0,
    outputDirectory: "",
    uploading: false,
    activeMeetingId: "",
    browserRequested: false,
    browserSessionId: "",
    pendingRequest: null,
  };
}

function readSelection() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function readReadState() {
  try {
    return JSON.parse(window.localStorage.getItem(READ_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeReadState(nextState) {
  window.localStorage.setItem(READ_STATE_KEY, JSON.stringify(nextState));
}

function readHiddenSessions() {
  try {
    return JSON.parse(window.localStorage.getItem(HIDDEN_SESSIONS_KEY) || "{}");
  } catch {
    return {};
  }
}

function readLocalReports() {
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_REPORTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeHiddenSessions(nextState) {
  window.localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify(nextState));
}

function userFacingThreadError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/<!doctype|unexpected token|not valid json|failed to fetch|networkerror|load failed/i.test(message)) {
    return "Hermes 연결에 실패했습니다. 잠시 후 새로고침해 주세요.";
  }
  return message || "Hermes 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function requestFailureThread(current, error) {
  if (isRequestCancellation(error)) return current;
  if (isTransientRequestError(error)) {
    return { ...current, error: "", status: "연결 복구 중" };
  }
  return { ...current, error: userFacingThreadError(error) };
}

function sessionStorageKey(profileName, sessionId) {
  return `${profileName}:${sessionId}`;
}

function sessionLastActive(session) {
  return Number(session?.last_active ?? session?.updated_at ?? session?.started_at ?? 0);
}

function sessionReadAt(readState, profileName, sessionId) {
  return Number(readState?.[profileName]?.sessions?.[sessionId] ?? 0);
}

function isUnreadSession(session, readState, profileName) {
  if (!session?.id) return false;
  return sessionLastActive(session) > sessionReadAt(readState, profileName, session.id);
}

function isHiddenSession(session, hiddenSessions, profileName) {
  if (!session?.id) return false;
  return Boolean(hiddenSessions[sessionStorageKey(profileName, session.id)]);
}

function hiddenSessionEntries(hiddenSessions) {
  return Object.keys(hiddenSessions)
    .filter((key) => hiddenSessions[key])
    .map((key) => {
      const [profileName, ...sessionParts] = key.split(":");
      return { profileName, sessionId: sessionParts.join(":") };
    })
    .filter((item) => item.profileName && item.sessionId);
}

function formatTime(timestamp) {
  if (!timestamp) return "방금";
  return new Intl.DateTimeFormat("ko", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function sessionTitle(session) {
  const decoded = decodeHermesText(session.title || session.preview || "");
  const { visibleText } = splitVisibleConversationText(decoded);
  return (visibleText || decoded).slice(0, 54) || "제목 없는 대화";
}

const CONTEXT_MARKERS = [
  "[internal:agent-office-runtime-context]",
  "[workspace 영역 권한 규칙]",
  "[workspace",
  "[채팅 파일 작업 규칙]",
  "[chat file",
];

function splitVisibleConversationText(text = "") {
  const value = String(text ?? "").trim();
  if (!value) return { visibleText: "", contextText: "" };
  const markerIndex = CONTEXT_MARKERS
    .map((marker) => value.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (markerIndex === undefined) return { visibleText: value, contextText: "" };
  return {
    visibleText: value.slice(0, markerIndex).trim(),
    contextText: value.slice(markerIndex).trim(),
  };
}

function isRenderableMessage(message) {
  if (message.meeting || message.report || message.files?.length) return true;
  const { visibleText } = splitVisibleConversationText(message.text);
  return Boolean(visibleText);
}

function buildAgentRuntimePrompt({ text, profileName, inputFiles, outputDirectory }) {
  const dynamicContext = [
    profileName ? `현재 Hermes 프로필: ${profileName}` : "",
    profileName === "default"
      ? [
        "[Agent Office 실행 계약]",
        "사용자가 다른 구성원에게 업무를 배정·지시·위임하라고 요청하면, 대신 답하거나 전달용 문안만 작성하지 마세요.",
        "Hermes 공식 delegate_task를 실제 호출해 각 업무를 실행하세요. 여러 담당자는 tasks 배열로 병렬 위임하고 각 goal 첫 줄에 [OFFICE_ASSIGN profile=<프로필ID>]를 넣으세요.",
        "공동 의사결정, 상충 조정, 다수의 합의가 실제로 필요할 때만 delegate_task의 context 첫 줄에 [OFFICE_MEETING participants=<쉼표로 구분한 프로필ID>]를 넣으세요.",
        "사용자가 회의·미팅·회의실 소집을 명시하면 위 OFFICE_MEETING 마커를 반드시 사용하세요.",
        "단순 전달·독립 실행은 회의를 열지 마세요. 도구 결과가 오기 전에는 배정이나 완료를 주장하지 말고 실제 결과를 취합해 보고하세요.",
      ].join("\n")
      : "",
    inputFiles.length
      ? `사용자 첨부 파일:\n${inputFiles.map((file) => `- ${file.path}`).join("\n")}`
      : "",
    outputDirectory
      ? `산출물을 만들어야 하는 경우 이 대화의 출력 폴더를 사용하세요:\n${outputDirectory}`
      : "",
  ].filter(Boolean);
  if (!dynamicContext.length) return text;
  return [
    text,
    "",
    "[internal:agent-office-runtime-context]",
    "아래 내용은 이 사이트가 전달하는 동적 파일/프로필 메타데이터입니다. 정책 판단은 Hermes 프로필 문서와 스킬을 따르세요.",
    ...dynamicContext,
  ].join("\n");
}

function renderInlineMarkdown(text, keyPrefix) {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("**")) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/) || [];
      const safeHref = href && /^(https?:\/\/|mailto:|#|\/)/i.test(href) ? href : undefined;
      parts.push(safeHref ? (
        <a key={key} href={safeHref} target="_blank" rel="noreferrer">{label}</a>
      ) : (
        <span key={key}>{label || token}</span>
      ));
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function ChatMarkdown({ text = "" }) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let listItems = [];
  let inCode = false;
  let codeLines = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(
      <ul key={`list-${blocks.length}`}>
        {listItems.map((item, index) => <li key={`${item}-${index}`}>{renderInlineMarkdown(item, `li-${blocks.length}-${index}`)}</li>)}
      </ul>,
    );
    listItems = [];
  };

  const flushCode = () => {
    blocks.push(<pre key={`code-${blocks.length}`}><code>{codeLines.join("\n")}</code></pre>);
    codeLines = [];
  };

  lines.forEach((line, index) => {
    if (/^```/.test(line.trim())) {
      flushList();
      if (inCode) flushCode();
      inCode = !inCode;
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const HeadingTag = `h${Math.min(4, heading[1].length)}`;
      blocks.push(<HeadingTag key={`h-${index}`}>{renderInlineMarkdown(heading[2], `h-${index}`)}</HeadingTag>);
      return;
    }
    const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      listItems.push(list[1]);
      return;
    }
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) {
      flushList();
      blocks.push(<blockquote key={`q-${index}`}>{renderInlineMarkdown(quote[1], `q-${index}`)}</blockquote>);
      return;
    }
    if (!line.trim()) {
      flushList();
      return;
    }
    flushList();
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(line, `p-${index}`)}</p>);
  });

  flushList();
  if (inCode || codeLines.length) flushCode();
  return <div className="chat-markdown">{blocks.length ? blocks : null}</div>;
}

function normalizeMessages(messages) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content ?? "",
      files: [],
      timestamp: message.timestamp ?? 0,
      time: formatTime(message.timestamp),
    }))
    .filter(isRenderableMessage);
}

function reportToMessage(report) {
  return {
    id: report.id,
    role: "assistant",
    text: report.summary,
    files: [],
    time: "방금",
    timestamp: Math.floor((report.createdAt ?? Date.now()) / 1000),
    report,
  };
}

function fileKey(file) {
  return `${file.scope}:${file.name}`;
}

function attachedFileKeys(messages) {
  return new Set(messages.flatMap((message) => (message.files ?? []).map(fileKey)));
}

function unattachedInputFiles(thread) {
  const attached = attachedFileKeys(thread.messages);
  return thread.files.filter((file) => file.scope === "inputs" && !attached.has(fileKey(file)));
}

function attachFilesToLastRole(messages, files, role) {
  if (!files.length) return messages;
  const index = messages.findLastIndex((message) => message.role === role);
  if (index < 0) return messages;
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index) return message;
    const existing = new Set((message.files ?? []).map(fileKey));
    const nextFiles = files.filter((file) => !existing.has(fileKey(file)));
    return nextFiles.length ? { ...message, files: [...(message.files ?? []), ...nextFiles] } : message;
  });
}

function attachHistoricalFiles(messages, files) {
  const attached = attachedFileKeys(messages);
  const inputs = files.filter((file) => file.scope === "inputs" && !attached.has(fileKey(file)));
  const outputs = files.filter((file) => file.scope === "outputs" && !attached.has(fileKey(file)));
  return attachFilesToLastRole(attachFilesToLastRole(messages, inputs, "user"), outputs, "assistant");
}

function inferCollaborationProfiles(text = "", owner = "default") {
  const normalized = String(text).toLowerCase();
  const matches = Object.entries(TEAM_META)
    .filter(([profileName]) => profileName !== owner && profileName !== "default")
    .filter(([profileName, member]) => {
      const labels = [profileName, member.name, member.role, member.initials].filter(Boolean);
      return labels.some((label) => normalized.includes(String(label).toLowerCase()));
    })
    .map(([profileName]) => profileName);
  if (matches.length) return [...new Set(matches)];

  const roleHints = [
    [/design|ui|ux|screen|brand|copy|content|image|proposal|landing|디자인|화면|브랜드|문구|카피|콘텐츠|이미지|제안/i, ["greeming-seoyun", "greeming-jian"]],
    [/dev|code|deploy|bug|server|api|automation|개발|구현|코드|배포|버그|서버|자동화/i, ["greeming-jaehyun"]],
    [/data|kpi|analysis|sales|settlement|cost|budget|finance|데이터|분석|매출|정산|비용|예산|재무/i, ["greeming-junseo"]],
    [/customer|cs|voc|review|support|고객|문의|응대|리뷰/i, ["greeming-yuna"]],
    [/sns|campaign|shooting|video|marketing|콘텐츠|캠페인|촬영|영상|마케팅/i, ["greeming-taeo", "greeming-harin"]],
  ];
  const hinted = roleHints.find(([pattern]) => pattern.test(text))?.[1] ?? ["greeming-seoyun"];
  return hinted.filter((profileName) => profileName !== owner && TEAM_META[profileName]);
}

function buildCollaborationMeeting(owner, payload, sourceText) {
  const context = [payload.context, payload.args_text, payload.preview, payload.summary, payload.text]
    .filter(Boolean)
    .join("\n") || sourceText || "협업이 필요한 업무";
  const marker = /\[OFFICE_MEETING\s+participants=([^\]]+)\]/i.exec(context);
  const coordinatedParticipants = payload.office_coordination?.meeting_participants ?? [];
  const explicitlyRequested = /회의실|회의|미팅|meeting/i.test(sourceText);
  if (!payload.office_coordination?.meeting && !marker && !explicitlyRequested) return null;
  const declared = (coordinatedParticipants.length ? coordinatedParticipants : marker?.[1]?.split(",") ?? [])
    .map((profileName) => profileName.trim())
    .filter((profileName) => TEAM_META[profileName]);
  const participants = [owner, ...declared, ...inferCollaborationProfiles(context, owner)]
    .filter((profileName) => TEAM_META[profileName]);
  if (!participants.includes("default")) participants.unshift("default");
  const displayContext = context
    .replace(/\[OFFICE_(?:ASSIGN|MEETING)\s+[^\]]+\]\s*/gi, "")
    .trim();
  return {
    id: crypto.randomUUID(),
    source: "chat-collaboration",
    topic: `협업 논의: ${String(displayContext || sourceText || "협업 업무").slice(0, 80)}`,
    subtitle: `${TEAM_META[owner]?.name ?? owner} 판단으로 자동 개설`,
    participants: [...new Set(participants)].slice(0, 5),
    requestedBy: owner,
    startedAt: Date.now(),
  };
}

function appendProgressStep(thread, label, detail = "") {
  const step = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    detail,
    time: new Intl.DateTimeFormat("ko", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()),
  };
  return {
    ...thread,
    progress: [...(thread.progress ?? []), step].slice(-8),
    heartbeat: Date.now(),
  };
}

function formatWorkDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}초`;
  return `${minutes}분 ${String(seconds).padStart(2, "0")}초`;
}

function threadElapsedMs(thread, now = Date.now()) {
  const startedAt = Number(thread.startedAt || 0);
  if (!startedAt) return 0;
  const endedAt = thread.running ? now : Number(thread.finishedAt || thread.heartbeat || now);
  return Math.max(0, endedAt - startedAt);
}

async function assertHermesSetupReady(gateway) {
  const setup = await gateway.request("setup.status", {}, 15000).catch(() => null);
  if (setup?.provider_configured === false) {
    throw new Error("Hermes provider 설정이 필요합니다. 운영 관리에서 모델/API 설정을 먼저 확인해주세요.");
  }
}

function ThinkingPanel({ thread, meta }) {
  const [now, setNow] = useState(thread.heartbeat || thread.startedAt || 0);
  useEffect(() => {
    if (!thread.running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [thread.running, thread.startedAt]);
  if (!thread.running && !(thread.progress?.length || thread.tools?.length)) return null;
  const steps = thread.progress?.length
    ? thread.progress
    : [{ id: "waiting", label: "요청을 전달했습니다", detail: `${meta.name}이 작업을 준비 중입니다.`, time: "방금" }];
  const tools = thread.tools ?? [];
  const duration = formatWorkDuration(threadElapsedMs(thread, now));
  const summaryLabel = thread.running ? `생각 중 · ${duration}` : `작업 시간 ${duration}`;
  return (
    <details className={`chat-thinking-panel ${thread.running ? "running" : "completed"}`}>
      <summary>
        <span><i /> {summaryLabel}</span>
        <small>{thread.running ? "작업 내역 보기" : "작업 내역"}</small>
      </summary>
      <div>
        <section>
          {steps.map((step, index) => (
            <article key={step.id} className={index === steps.length - 1 && thread.running ? "active" : ""}>
              <i />
              <div>
                <strong>{step.label}</strong>
                {step.detail && <small>{step.detail}</small>}
              </div>
              <time>{step.time}</time>
            </article>
          ))}
        </section>
        {tools.length > 0 && (
          <section className="chat-thinking-tools">
            {tools.map((tool) => (
              <article key={tool.id} className={tool.running ? "active" : ""}>
                <i />
                <div>
                  <strong>{tool.name}</strong>
                  <small>{tool.summary || tool.context || "작업 처리 중"}</small>
                </div>
                <time>{tool.running ? "RUNNING" : "DONE"}</time>
              </article>
            ))}
          </section>
        )}
      </div>
    </details>
  );
}

function ChatMessage({ message, meta, conversation, onStartMeeting }) {
  const isUser = message.role === "user";
  const senderLabel = isUser ? "사용자" : meta.name;
  const statusLabel = message.pending ? "작성 중" : message.time;
  const { visibleText } = splitVisibleConversationText(message.text);
  const bubbleText = visibleText || (message.pending ? "아직 최종 응답을 작성 중입니다. 진행 상황을 아래에서 확인하고 있어요." : "");
  return (
    <article className={`office-chat-message ${message.role}`}>
      <span className="office-chat-avatar" style={{ "--avatar": isUser ? "#223a34" : meta.color }}>
        {isUser ? "YOU" : meta.initials}
      </span>
      <div>
        <header>
          <strong>{senderLabel}</strong>
          <small>{statusLabel}</small>
        </header>
        {bubbleText && (
          <div className={`office-chat-bubble ${message.pending && !visibleText ? "pending-copy" : ""}`.trim()}>
            <ChatMarkdown text={bubbleText} />
          </div>
        )}
        {message.meeting && (
          <section className="chat-meeting-card">
            <span>AUTO MEETING</span>
            <strong>{message.meeting.topic}</strong>
            <small>{message.meeting.participants.map((name) => TEAM_META[name]?.name).filter(Boolean).join(", ")}</small>
            <button type="button" onClick={() => onStartMeeting?.(message.meeting)}>미팅 열기</button>
          </section>
        )}
        {message.report && (
          <section className="chat-report-card">
            <span>MEETING REPORT</span>
            <strong>{message.report.topic}</strong>
            <small>{message.report.participants?.map((name) => TEAM_META[name]?.name).filter(Boolean).join(", ")}</small>
          </section>
        )}
        {message.files?.length > 0 && (
          <section className="chat-files inline">
            <header>
              <span>{message.role === "assistant" ? "OUTPUTS" : "ATTACHED"}</span>
              <strong>{message.role === "assistant" ? "생성 파일" : "첨부 파일"}</strong>
            </header>
            <div>{message.files.map((file) => <FileCard key={`${file.scope}-${file.name}`} file={file} conversation={conversation} />)}</div>
          </section>
        )}
      </div>
    </article>
  );
}

function displayFileName(file) {
  if (file.originalName) return file.originalName;
  return file.scope === "inputs"
    ? file.name.replace(/^[0-9a-f-]{36}-/, "")
    : file.name;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isPreviewImage(file) {
  return file.mime?.startsWith("image/");
}

function FileCard({ file, conversation }) {
  const url = chatFileUrl(conversation, file);
  return (
    <article className={`chat-file-card ${file.scope}`}>
      {isPreviewImage(file) ? (
        <img src={chatFileUrl(conversation, file, true)} alt="" />
      ) : (
        <span>{file.name.split(".").pop()?.slice(0, 5).toUpperCase() || "FILE"}</span>
      )}
      <div>
        <strong>{displayFileName(file)}</strong>
        <small>{file.scope === "outputs" ? "구성원 산출물" : "사용자 첨부"} · {formatBytes(file.size)}</small>
      </div>
      <a href={url} download={displayFileName(file)}>다운로드</a>
    </article>
  );
}

export default function ProfileChat({
  initialProfile = "default",
  initialSessionId = "",
  initialDraft = "",
  branchFrom = null,
  onBranchHandled,
  profiles = [],
  activities = {},
  compact = false,
  onActivityChange,
  onStartMeeting,
}) {
  const [activeProfile, setActiveProfile] = useState(initialProfile);
  const [threads, setThreads] = useState({});
  const [sessionLists, setSessionLists] = useState({});
  const [draft, setDraft] = useState("");
  const [connection, setConnection] = useState("connecting");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [mobileStage, setMobileStage] = useState("people");
  const [readState, setReadState] = useState(readReadState);
  const [hiddenSessions, setHiddenSessions] = useState(readHiddenSessions);
  const [liveActivities, setLiveActivities] = useState({});
  const [liveConnectionStates, setLiveConnectionStates] = useState({});
  const [dismissedLiveSessions, setDismissedLiveSessions] = useState({});
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [composerDragging, setComposerDragging] = useState(false);
  const gatewayRef = useRef(null);
  const sessionsRef = useRef(new Map());
  const threadsRef = useRef({});
  const sessionListsRef = useRef({});
  const sessionRefreshSeqRef = useRef({});
  const activePromptControllersRef = useRef({});
  const resumeRequestsRef = useRef(new Map());
  const interruptedSessionIdsRef = useRef(new Set());
  const branchAttemptRef = useRef(null);
  const activeProfileRef = useRef(activeProfile);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const urlDialogRef = useModalFocus(urlOpen, () => setUrlOpen(false));
  const snippetsDialogRef = useModalFocus(snippetsOpen, () => setSnippetsOpen(false));

  const availableProfiles = useMemo(() => {
    const names = new Set(profiles.map((profile) => profile.name));
    return PROFILE_ORDER.filter((name) => names.size === 0 || names.has(name));
  }, [profiles]);
  const thread = threads[activeProfile] ?? emptyThread();
  const meta = TEAM_META[activeProfile] ?? TEAM_META.default;
  const activeSessionId = thread.liveSessionId || thread.storedSessionId || "";
  // The browser router is keyed by the durable Hermes session. During a tool
  // run the gateway also emits a short-lived transport session id; preferring
  // that id leaves Live Browser polling a target that can never exist.
  const liveBrowserScopeId = thread.storedSessionId || thread.browserSessionId || "";
  const activeLiveKey = `${activeProfile}:${activeSessionId}`;
  const activeActivity = liveActivities[activeLiveKey] ?? activities[activeProfile] ?? {};
  const livePanelRequested = !compact && Boolean(activeSessionId && thread.browserRequested && !dismissedLiveSessions[activeLiveKey]);
  const liveViewAvailable = Boolean(livePanelRequested && activeActivity.view?.viewerSocketUrl);
  const liveConnectionState = liveConnectionStates[activeLiveKey] ?? "searching";
  const profileSessions = useMemo(
    () => (sessionLists[activeProfile] ?? []).filter((session) => !isHiddenSession(session, hiddenSessions, activeProfile)),
    [activeProfile, hiddenSessions, sessionLists],
  );
  const [fullscreenLive, setFullscreenLive] = useState(false);

  const updateThread = useCallback((profileName, updater) => {
    setThreads((current) => {
      const next = { ...current, [profileName]: updater(current[profileName] ?? emptyThread()) };
      threadsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const pending = thread.pendingRequest;
    if (!pending?.expiresAt) return undefined;
    const expire = () => {
      updateThread(activeProfile, (current) => {
        if (current.pendingRequest?.id !== pending.id || !isHitlRequestExpired(current.pendingRequest)) return current;
        return appendProgressStep(
          { ...current, pendingRequest: null, status: "사용자 입력 요청 만료", heartbeat: Date.now() },
          "사용자 입력 요청 만료",
          "Hermes의 응답 대기 시간이 끝났습니다. 필요한 경우 작업에서 다시 요청해 주세요.",
        );
      });
      onActivityChange?.(activeProfile, { state: "idle", text: "사용자 입력 요청 만료", collaborator: "" });
    };
    const delay = Math.max(0, Number(pending.expiresAt) - Date.now());
    if (delay === 0) expire();
    const timer = delay > 0 ? window.setTimeout(expire, delay) : 0;
    return () => { if (timer) window.clearTimeout(timer); };
  }, [activeProfile, onActivityChange, thread.pendingRequest, updateThread]);

  const markSessionRead = useCallback((profileName, sessionId, timestamp = Math.floor(Date.now() / 1000)) => {
    if (!profileName || !sessionId) return;
    setReadState((current) => {
      const profileState = current[profileName] ?? {};
      const sessions = profileState.sessions ?? {};
      const previous = Number(sessions[sessionId] ?? 0);
      const nextTimestamp = Math.max(previous, Number(timestamp) || Math.floor(Date.now() / 1000));
      const next = {
        ...current,
        [profileName]: {
          ...profileState,
          lastSeenAt: Math.max(Number(profileState.lastSeenAt ?? 0), nextTimestamp),
          sessions: { ...sessions, [sessionId]: nextTimestamp },
        },
      };
      writeReadState(next);
      return next;
    });
  }, []);

  const unreadCountForProfile = useCallback((profileName) => {
    return (sessionLists[profileName] ?? [])
      .filter((session) => !isHiddenSession(session, hiddenSessions, profileName))
      .filter((session) => isUnreadSession(session, readState, profileName)).length;
  }, [hiddenSessions, readState, sessionLists]);

  useEffect(() => {
    activeProfileRef.current = activeProfile;
  }, [activeProfile]);

  useEffect(() => {
    if (compact || !activeSessionId || !liveBrowserScopeId || !thread.browserRequested) return undefined;
    let stopped = false;
    let timer = 0;
    const syncLiveBrowser = async () => {
      try {
        setLiveConnectionStates((current) => ({ ...current, [activeLiveKey]: current[activeLiveKey] || "searching" }));
        const hint = activeActivity.view?.url || "";
        const targetId = activeActivity.view?.pageId || activeActivity.view?.targetId || "";
        const payload = await loadLiveScreen(
          activeProfile,
          liveBrowserScopeId,
          targetId,
          hint,
          liveBrowserScopeId,
          true,
        );
        if (!stopped && payload?.activity?.view?.viewerSocketUrl) {
          setLiveActivities((current) => ({ ...current, [activeLiveKey]: payload.activity }));
          setLiveConnectionStates((current) => ({ ...current, [activeLiveKey]: "live" }));
          publishLiveActivity(activeProfile, payload.activity, activeSessionId);
          if (thread.storedSessionId && thread.storedSessionId !== activeSessionId) {
            publishLiveActivity(activeProfile, payload.activity, thread.storedSessionId);
          }
        } else if (!stopped) {
          setLiveConnectionStates((current) => ({ ...current, [activeLiveKey]: "searching" }));
        }
      } catch {
        if (!stopped) setLiveConnectionStates((current) => ({ ...current, [activeLiveKey]: "reconnecting" }));
        // Browser relay is supplementary; chat remains usable while it reconnects.
      } finally {
        if (!stopped) timer = window.setTimeout(syncLiveBrowser, 1800);
      }
    };
    syncLiveBrowser();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [activeActivity.view?.pageId, activeActivity.view?.targetId, activeActivity.view?.url, activeLiveKey, activeProfile, activeSessionId, compact, liveBrowserScopeId, thread.browserRequested, thread.storedSessionId]);

  useEffect(() => {
    if (compact || !activeSessionId || !liveBrowserScopeId || !thread.browserRequested) return undefined;
    const profileName = activeProfile;
    const sessionId = liveBrowserScopeId;
    return () => {
      releaseLiveScreen(profileName, sessionId).catch(() => {});
    };
  }, [activeLiveKey, activeProfile, activeSessionId, compact, liveBrowserScopeId, thread.browserRequested]);

  useEffect(() => {
    sessionListsRef.current = sessionLists;
  }, [sessionLists]);

  const appendLocalReports = useCallback((reports) => {
    reports
      .filter((report) => report?.id && TEAM_META[report.profile])
      .forEach((report) => {
        updateThread(report.profile, (current) => {
          if (current.messages.some((message) => message.id === report.id)) return current;
          return {
            ...current,
            status: "회의 완료 보고 도착",
            heartbeat: Date.now(),
            messages: [...current.messages, reportToMessage(report)],
            progress: [
              ...(current.progress ?? []),
              {
                id: `${report.id}-progress`,
                label: "회의 완료 보고",
                detail: report.topic,
                time: "방금",
              },
            ].slice(-8),
          };
        });
      });
  }, [updateThread]);

  useEffect(() => {
    appendLocalReports(readLocalReports());
    const onLocalReport = (event) => appendLocalReports([event.detail]);
    window.addEventListener("hermes:local-report", onLocalReport);
    return () => window.removeEventListener("hermes:local-report", onLocalReport);
  }, [appendLocalReports]);

  const refreshSessions = useCallback(async (profileName) => {
    const sequence = (sessionRefreshSeqRef.current[profileName] ?? 0) + 1;
    sessionRefreshSeqRef.current[profileName] = sequence;
    const sessions = await loadProfileSessions(profileName, 24, { includeMeetings: false });
    if (sessionRefreshSeqRef.current[profileName] !== sequence) {
      return sessionListsRef.current[profileName] ?? [];
    }
    setSessionLists((current) => ({ ...current, [profileName]: sessions }));
    return sessions;
  }, []);

  useEffect(() => {
    if (compact || !activeSessionId || thread.browserRequested) return;
    const restored = readLiveActivity(activeProfile, activeSessionId)
      ?? (thread.storedSessionId ? readLiveActivity(activeProfile, thread.storedSessionId) : null);
    if (!restored?.view?.pageId && !restored?.view?.targetId) return;
    setLiveActivities((current) => ({ ...current, [activeLiveKey]: restored }));
    updateThread(activeProfile, (current) => ({
      ...current,
      browserRequested: true,
      browserSessionId: current.storedSessionId || restored.view.browserSessionId || current.browserSessionId || activeSessionId,
    }));
  }, [activeLiveKey, activeProfile, activeSessionId, compact, thread.browserRequested, thread.storedSessionId, updateThread]);

  const resumeStoredSession = useCallback((profileName, storedSessionId) => {
    if (!storedSessionId || gatewayRef.current?.state !== "open") return Promise.resolve(null);
    const key = `${profileName}:${storedSessionId}`;
    const existing = resumeRequestsRef.current.get(key);
    if (existing) return existing;
    const request = gatewayRef.current.request("session.resume", {
      session_id: storedSessionId,
      cols: 96,
      source: "web",
      profile: profileName,
    }, 120000).then((result) => {
      if (!result?.session_id) return null;
      sessionsRef.current.set(result.session_id, profileName);
      updateThread(profileName, (current) => {
        if (current.storedSessionId !== storedSessionId) return current;
        const resumedMessages = Array.isArray(result.messages) ? normalizeMessages(result.messages) : [];
        const running = Boolean(result.running);
        return {
          ...current,
          liveSessionId: result.session_id,
          messages: current.messages.length || !resumedMessages.length ? current.messages : resumedMessages,
          running,
          status: running ? "작업 재연결됨" : "이전 대화 연결됨",
          error: "",
          startedAt: running ? (current.startedAt || Date.now()) : current.startedAt,
          heartbeat: Date.now(),
        };
      });
      return result;
    }).catch((error) => {
      updateThread(profileName, (current) => requestFailureThread(current, error));
      return null;
    }).finally(() => {
      if (resumeRequestsRef.current.get(key) === request) resumeRequestsRef.current.delete(key);
    });
    resumeRequestsRef.current.set(key, request);
    return request;
  }, [updateThread]);

  const ensureConversationKey = useCallback((profileName) => {
    const current = threadsRef.current[profileName] ?? emptyThread();
    if (current.conversationKey) return current.conversationKey;
    const key = `${profileName}-${crypto.randomUUID()}`;
    updateThread(profileName, (item) => ({ ...item, conversationKey: key }));
    return key;
  }, [updateThread]);

  const refreshFiles = useCallback(async (profileName, conversationKey, options = {}) => {
    if (!conversationKey) return;
    const payload = await loadChatFiles(conversationKey);
    updateThread(profileName, (current) => {
      const previous = new Set(current.files.map(fileKey));
      let messages = current.messages;
      if (options.attachAll) {
        messages = attachHistoricalFiles(messages, payload.files);
      } else if (options.attachNewOutputs) {
        const newOutputs = payload.files.filter((file) => file.scope === "outputs" && !previous.has(fileKey(file)));
        messages = attachFilesToLastRole(messages, newOutputs, "assistant");
      }
      return {
        ...current,
        messages,
        files: payload.files,
        outputDirectory: payload.outputDirectory,
      };
    });
  }, [updateThread]);

  const openStoredSession = useCallback(async (profileName, sessionId) => {
    if (!sessionId) return;
    setLoadingHistory(true);
    updateThread(profileName, (current) => ({
      ...current,
      storedSessionId: sessionId,
      liveSessionId: "",
      conversationKey: `${profileName}-${sessionId}`,
      status: "이전 대화 연결 중",
      error: "",
    }));
    try {
      const messages = await loadSessionMessages(sessionId, profileName);
      updateThread(profileName, (current) => ({
        ...current,
        storedSessionId: sessionId,
        liveSessionId: "",
        conversationKey: `${profileName}-${sessionId}`,
        messages: normalizeMessages(messages),
        tools: [],
        status: "이전 대화 불러옴",
        error: "",
      }));
      refreshFiles(profileName, `${profileName}-${sessionId}`, { attachAll: true }).catch(() => {});
      const selection = readSelection();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...selection, [profileName]: sessionId }));
      const openedSession = (sessionListsRef.current[profileName] ?? []).find((session) => session.id === sessionId);
      const latestMessageAt = Math.max(...messages.map((message) => Number(message.timestamp ?? 0)), 0);
      markSessionRead(profileName, sessionId, Math.max(sessionLastActive(openedSession), latestMessageAt, Math.floor(Date.now() / 1000)));
    } catch (error) {
      updateThread(profileName, (current) => current.liveSessionId ? current : requestFailureThread(current, error));
    } finally {
      setLoadingHistory(false);
    }
  }, [markSessionRead, refreshFiles, updateThread]);

  const openStoredSessionForMobile = useCallback(async (profileName, sessionId) => {
    setActiveProfile(profileName);
    await openStoredSession(profileName, sessionId);
    setMobileStage("chat");
  }, [openStoredSession]);

  const newConversation = useCallback((profileName = activeProfile) => {
    updateThread(profileName, () => emptyThread());
    const selection = readSelection();
    delete selection[profileName];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  }, [activeProfile, updateThread]);

  const resetConversation = useCallback((profileName = activeProfile) => {
    newConversation(profileName);
    setDraft("");
    refreshSessions(profileName).catch(() => {});
  }, [activeProfile, newConversation, refreshSessions]);

  const hideSession = useCallback(async (profileName, sessionId) => {
    const key = sessionStorageKey(profileName, sessionId);
    setHiddenSessions((current) => {
      const next = { ...current, [key]: true };
      writeHiddenSessions(next);
      return next;
    });
    setSessionLists((current) => ({
      ...current,
      [profileName]: (current[profileName] ?? []).filter((session) => session.id !== sessionId),
    }));
    const selection = readSelection();
    if (selection[profileName] === sessionId) {
      delete selection[profileName];
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
    }
    const currentThread = threadsRef.current[profileName];
    if (currentThread?.storedSessionId === sessionId) {
      updateThread(profileName, () => emptyThread());
      if (profileName === activeProfile) setDraft("");
    }
    try {
      await archiveChatSession(profileName, sessionId);
      refreshSessions(profileName).catch(() => {});
    } catch (error) {
      updateThread(profileName, (current) => requestFailureThread(current, error));
    }
  }, [activeProfile, refreshSessions, updateThread]);

  const markProfileRead = useCallback((profileName = activeProfile) => {
    const sessions = (sessionListsRef.current[profileName] ?? [])
      .filter((session) => !isHiddenSession(session, hiddenSessions, profileName));
    if (!sessions.length) return;
    setReadState((current) => {
      const profileState = current[profileName] ?? {};
      const currentSessions = profileState.sessions ?? {};
      const nextSessions = { ...currentSessions };
      let latest = Number(profileState.lastSeenAt ?? 0);
      sessions.forEach((session) => {
        const readAt = Math.max(sessionLastActive(session), Math.floor(Date.now() / 1000));
        nextSessions[session.id] = Math.max(Number(nextSessions[session.id] ?? 0), readAt);
        latest = Math.max(latest, readAt);
      });
      const next = {
        ...current,
        [profileName]: {
          ...profileState,
          lastSeenAt: latest,
          sessions: nextSessions,
        },
      };
      writeReadState(next);
      return next;
    });
  }, [activeProfile, hiddenSessions]);

  const markActiveSessionRead = useCallback(() => {
    const sessionId = thread.storedSessionId;
    if (!sessionId) {
      markProfileRead(activeProfile);
      return;
    }
    const session = (sessionListsRef.current[activeProfile] ?? []).find((item) => item.id === sessionId);
    const latestMessageAt = Math.max(...(thread.messages ?? []).map((message) => Number(message.timestamp ?? 0)), 0);
    markSessionRead(activeProfile, sessionId, Math.max(sessionLastActive(session), latestMessageAt, Math.floor(Date.now() / 1000)));
  }, [activeProfile, markProfileRead, markSessionRead, thread.messages, thread.storedSessionId]);

  const startMobileConversation = useCallback((profileName = activeProfile) => {
    setActiveProfile(profileName);
    newConversation(profileName);
    setMobileStage("chat");
  }, [activeProfile, newConversation]);

  useEffect(() => {
    if (TEAM_META[initialProfile]) setActiveProfile(initialProfile);
  }, [initialProfile]);

  useEffect(() => {
    if (window.localStorage.getItem(HIDDEN_SESSIONS_MIGRATED_KEY) === "1") return;
    const entries = hiddenSessionEntries(readHiddenSessions());
    if (!entries.length) {
      window.localStorage.setItem(HIDDEN_SESSIONS_MIGRATED_KEY, "1");
      return;
    }
    let cancelled = false;
    (async () => {
      const completed = [];
      for (const item of entries) {
        try {
          await archiveChatSession(item.profileName, item.sessionId);
          completed.push(item);
        } catch {
          // Keep the local tombstone when server archival fails, so stale fetches cannot reinsert it.
        }
      }
      if (!cancelled) {
        const currentHidden = readHiddenSessions();
        const nextHidden = { ...currentHidden };
        completed.forEach((item) => {
          nextHidden[sessionStorageKey(item.profileName, item.sessionId)] = true;
        });
        writeHiddenSessions(nextHidden);
        setHiddenSessions(nextHidden);
        if (cancelled) return;
        window.localStorage.setItem(HIDDEN_SESSIONS_MIGRATED_KEY, "1");
        [...new Set(entries.map((item) => item.profileName))].forEach((profileName) => {
          refreshSessions(profileName).catch(() => {});
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!initialDraft) return;
    setDraft(initialDraft);
    setMobileStage("chat");
  }, [initialDraft]);

  useEffect(() => {
    const profileName = TEAM_META[initialProfile] ? initialProfile : "default";
    refreshSessions(profileName).then((sessions) => {
      const requested = initialSessionId || readSelection()[profileName];
      const existing = sessions.some((session) => session.id === requested) ? requested : "";
      if (existing) {
        openStoredSession(profileName, existing);
        if (initialSessionId) setMobileStage("chat");
      }
    }).catch((error) => updateThread(profileName, (current) => requestFailureThread(current, error)));
  }, [initialProfile, initialSessionId, openStoredSession, refreshSessions, updateThread]);

  useEffect(() => {
    if (!branchFrom) {
      branchAttemptRef.current = null;
      return;
    }
    if (connection !== "open" || branchAttemptRef.current === branchFrom) return;
    branchAttemptRef.current = branchFrom;
    const profileName = TEAM_META[branchFrom.profile] ? branchFrom.profile : "default";
    let cancelled = false;
    (async () => {
      setActiveProfile(profileName);
      setMobileStage("chat");
      setLoadingHistory(true);
      try {
        await openStoredSession(profileName, branchFrom.id);
        const resumed = await resumeStoredSession(profileName, branchFrom.id);
        if (!resumed?.session_id) throw new Error("원본 Hermes 세션을 실시간으로 연결하지 못했습니다.");
        const rpc = sessionBranchRequest(resumed.session_id, `${sessionTitle(branchFrom)} (분기)`);
        const branched = await gatewayRef.current.request(rpc.method, rpc.params, 120000);
        if (!branched?.session_id) throw new Error("Hermes가 분기 세션 ID를 반환하지 않았습니다.");
        if (cancelled) return;
        sessionsRef.current.set(branched.session_id, profileName);
        updateThread(profileName, (current) => ({
          ...current,
          liveSessionId: branched.session_id,
          storedSessionId: "",
          conversationKey: `${profileName}-${crypto.randomUUID()}`,
          status: "대화 분기 완료",
          running: false,
          error: "",
          pendingRequest: null,
          heartbeat: Date.now(),
        }));
        const selection = readSelection();
        delete selection[profileName];
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
        setDraft("");
        refreshSessions(profileName).catch(() => {});
      } catch (error) {
        if (!cancelled) updateThread(profileName, (current) => requestFailureThread(current, error));
      } finally {
        if (!cancelled) {
          setLoadingHistory(false);
          onBranchHandled?.();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchFrom, connection, onBranchHandled, openStoredSession, refreshSessions, resumeStoredSession, updateThread]);

  useEffect(() => {
    if (sessionLists[activeProfile]) return;
    refreshSessions(activeProfile).then(() => {
      const stored = readSelection()[activeProfile];
      if (stored) openStoredSession(activeProfile, stored);
    }).catch((error) => updateThread(activeProfile, (current) => requestFailureThread(current, error)));
  }, [activeProfile, openStoredSession, refreshSessions, sessionLists, updateThread]);

  useEffect(() => {
    if (connection !== "open" || !thread.storedSessionId || thread.liveSessionId) return;
    resumeStoredSession(activeProfile, thread.storedSessionId);
  }, [activeProfile, connection, resumeStoredSession, thread.liveSessionId, thread.storedSessionId]);

  useEffect(() => {
    if (compact || !availableProfiles.length) return;
    availableProfiles.forEach((profileName) => {
      if (sessionListsRef.current[profileName]) return;
      refreshSessions(profileName).catch(() => {});
    });
  }, [availableProfiles, compact, refreshSessions]);

  useEffect(() => {
    const gateway = new HermesGateway();
    gatewayRef.current = gateway;
    let stopped = false;
    let reconnectTimer = 0;
    let reconnectAttempts = 0;
    const scheduleReconnect = () => {
      if (stopped) return;
      window.clearTimeout(reconnectTimer);
      const delay = Math.min(12000, 1200 * (reconnectAttempts + 1));
      reconnectTimer = window.setTimeout(() => {
        if (stopped) return;
        reconnectAttempts += 1;
        gateway.connect()
          .then(() => {
            reconnectAttempts = 0;
            setConnection("open");
          })
          .catch(() => scheduleReconnect());
      }, delay);
    };
    const removeState = gateway.onState(setConnection);
    const removeReconnectState = gateway.onState((state) => {
      if (state === "open") {
        reconnectAttempts = 0;
        window.clearTimeout(reconnectTimer);
        return;
      }
      if (state === "closed" || state === "error") scheduleReconnect();
    });
    const removeEvent = gateway.onEvent((event) => {
      if (event.type === "gateway.ready" || event.type === "skin.changed" || event.type === "notification.clear") return;
      const profileName = sessionsRef.current.get(event.session_id);
      if (!profileName) return;
      const isInterruptedSession = event.session_id && interruptedSessionIdsRef.current.has(event.session_id);
      if (isInterruptedSession && [
        "message.start",
        "message.delta",
        "thinking.delta",
        "reasoning.delta",
        "reasoning.available",
        "tool.start",
        "tool.generating",
        "tool.progress",
        "status.update",
        "error",
      ].includes(event.type)) return;
      const payload = event.payload ?? {};
      if (event.type === "message.start") {
        updateThread(profileName, (current) => {
          const hasPending = current.messages.some((message) => message.role === "assistant" && message.pending);
          return {
            ...appendProgressStep(
              current,
              "응답 작성 시작",
              "구성원이 최종 응답을 작성하고 있습니다.",
            ),
            messages: hasPending ? current.messages : [
              ...current.messages,
              { id: crypto.randomUUID(), role: "assistant", text: "", time: "", pending: true },
            ],
            running: true,
            status: "응답 작성 중",
            startedAt: current.startedAt || Date.now(),
            finishedAt: 0,
            heartbeat: Date.now(),
          };
        });
        onActivityChange?.(profileName, { state: "working", text: "응답 작성 중", collaborator: "" });
      } else if (event.type === "message.delta") {
        updateThread(profileName, (current) => {
          const messages = [...current.messages];
          const index = messages.findLastIndex((message) => message.role === "assistant" && message.pending);
          if (index >= 0) messages[index] = { ...messages[index], text: `${messages[index].text}${payload.text ?? ""}` };
          const hadText = Boolean(messages[index]?.text);
          const next = { ...current, messages, running: true, status: "응답 작성 중", startedAt: current.startedAt || Date.now(), finishedAt: 0, heartbeat: Date.now() };
          return hadText && !(current.progress ?? []).some((step) => step.label === "응답 작성 시작")
            ? appendProgressStep(next, "응답 작성 시작", "구성원이 최종 응답을 작성하고 있습니다.")
            : next;
        });
      } else if (event.type === "message.complete") {
        if (isInterruptedSession) {
          interruptedSessionIdsRef.current.delete(event.session_id);
          return;
        }
        updateThread(profileName, (current) => {
          const messages = [...current.messages];
          const index = messages.findLastIndex((message) => message.role === "assistant" && message.pending);
          if (index >= 0) messages[index] = { ...messages[index], text: payload.text ?? messages[index].text, pending: false, time: "방금" };
          const finishedAt = Date.now();
          return appendProgressStep({ ...current, messages, pendingRequest: null, running: false, status: "응답 완료", finishedAt, heartbeat: finishedAt }, "응답 완료", "답변이 도착했습니다.");
        });
        refreshSessions(profileName).catch(() => {});
        const conversationKey = threadsRef.current[profileName]?.conversationKey;
        [800, 2500, 6000].forEach((delay) => {
          window.setTimeout(() => refreshFiles(profileName, conversationKey, { attachNewOutputs: true }).catch(() => {}), delay);
        });
        onActivityChange?.(profileName, { state: "online", text: "응답 완료", collaborator: "", completedAt: Date.now() });
      } else if (event.type === "thinking.delta" || event.type === "reasoning.delta" || event.type === "reasoning.available") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, status: "추론 중", heartbeat: Date.now() },
          event.type === "reasoning.available" ? "추론 요약" : "추론 진행",
          payload.text ?? "구성원이 판단 근거를 정리하고 있습니다.",
        ));
        onActivityChange?.(profileName, { state: "working", text: "생각 중", collaborator: "" });
      } else if (event.type === "tool.start") {
        const isBrowserTool = String(payload.name || "").startsWith("browser_");
        if (isBrowserTool) {
          const liveKey = `${profileName}:${event.session_id}`;
          setDismissedLiveSessions((current) => ({ ...current, [liveKey]: false }));
        }
        const delegatedProfiles = payload.office_coordination?.assignments ?? [];
        const collaborator = payload.name === "delegate_task"
          ? delegatedProfiles.map((name) => TEAM_META[name]?.name ?? name).join(", ") || payload.context || "다른 구성원"
          : "";
        let autoMeeting = null;
        if (payload.name === "delegate_task" && !threadsRef.current[profileName]?.activeMeetingId) {
          const sourceText = threadsRef.current[profileName]?.messages.findLast((message) => message.role === "user")?.text ?? "";
          autoMeeting = buildCollaborationMeeting(profileName, payload, sourceText);
        }
        updateThread(profileName, (current) => ({
          ...appendProgressStep(current, payload.name === "delegate_task" ? "작업 요청 감지" : "도구 실행 시작", payload.context || payload.name || "작업 도구를 실행합니다."),
          activeMeetingId: autoMeeting?.id ?? current.activeMeetingId,
          browserRequested: isBrowserTool ? true : current.browserRequested,
          browserSessionId: isBrowserTool
            ? (current.storedSessionId || current.browserSessionId || event.session_id || "")
            : current.browserSessionId,
          status: payload.context ? `${payload.name}: ${payload.context}` : `${payload.name} 실행 중`,
          messages: autoMeeting ? [
            ...current.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: `${TEAM_META[profileName]?.name ?? "구성원"}이 협업이 필요하다고 판단해 미팅을 열었습니다.`,
              files: [],
              time: "방금",
              meeting: autoMeeting,
            },
          ] : current.messages,
          tools: [...current.tools.filter((tool) => tool.id !== payload.tool_id), {
            id: payload.tool_id, name: payload.name ?? "tool", context: payload.context ?? "", running: true,
          }].slice(-6),
        }));
        if (autoMeeting) onStartMeeting?.(autoMeeting);
        onActivityChange?.(profileName, mergeActivityView({
          state: collaborator ? "meeting" : "working",
          text: payload.context || `${payload.name ?? "도구"} 실행 중`,
          collaborator,
        }, payload));
      } else if (event.type === "tool.generating" || event.type === "tool.progress") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, status: payload.name ? `${payload.name} 진행 중` : "도구 실행 중", heartbeat: Date.now() },
          event.type === "tool.generating" ? "도구 입력 구성" : "도구 진행",
          payload.preview || payload.context || payload.name || "도구 실행 내용을 업데이트했습니다.",
        ));
        onActivityChange?.(profileName, mergeActivityView({
          state: "working",
          text: payload.preview || payload.context || `${payload.name ?? "도구"} 진행 중`,
          collaborator: "",
        }, payload));
      } else if (event.type === "tool.complete") {
        updateThread(profileName, (current) => ({
          ...appendProgressStep(current, "도구 실행 완료", payload.summary || payload.context || payload.name || "작업 도구가 완료되었습니다."),
          tools: current.tools.map((tool) => tool.id === payload.tool_id ? { ...tool, running: false, summary: payload.summary } : tool),
        }));
        onActivityChange?.(profileName, mergeActivityView({
          state: "working",
          text: payload.summary || payload.context || `${payload.name ?? "도구"} 완료`,
          collaborator: "",
        }, payload));
      } else if (event.type === "clarify.request" || event.type === "approval.request" || event.type === "sudo.request" || event.type === "secret.request") {
        const label = event.type === "clarify.request" ? "추가 확인 필요" : "승인 또는 입력 필요";
        try {
          const pendingRequest = normalizeHitlRequest(event);
          updateThread(profileName, (current) => appendProgressStep(
            { ...current, pendingRequest, status: label, running: false, finishedAt: Date.now(), heartbeat: Date.now() },
            label,
            pendingRequest.prompt,
          ));
        } catch (requestError) {
          updateThread(profileName, (current) => ({ ...current, running: false, error: requestError.message }));
        }
        onActivityChange?.(profileName, { state: "approval", text: label, collaborator: "사용자" });
      } else if (["clarify.expire", "approval.expire", "secret.expire", "sudo.expire"].includes(event.type)) {
        const expiredRequestId = String(payload.request_id ?? "");
        updateThread(profileName, (current) => {
          if (!current.pendingRequest || (expiredRequestId && current.pendingRequest.requestId !== expiredRequestId)) return current;
          return appendProgressStep(
            { ...current, pendingRequest: null, status: "보안 입력 요청 만료", heartbeat: Date.now() },
            "보안 입력 요청 만료",
            "Hermes의 일회성 입력 요청이 만료되었습니다. 필요한 경우 작업을 다시 요청해주세요.",
          );
        });
        onActivityChange?.(profileName, { state: "idle", text: "보안 입력 요청 만료", collaborator: "" });
      } else if (event.type === "background.complete") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, heartbeat: Date.now() },
          "백그라운드 작업 완료",
          payload.text ?? "백그라운드 작업이 완료되었습니다.",
        ));
      } else if (event.type === "browser.target") {
        const liveKey = `${profileName}:${event.session_id}`;
        const targetActivity = {
          state: "working",
          text: "브라우저 작업 중",
          view: {
            url: payload.url || "about:blank",
            title: payload.title || "Agent Chrome",
            tool: "Hermes browser",
            source: "session-target",
            pageId: payload.target_id,
            targetId: payload.target_id,
            browserSessionId: payload.browser_session_id,
            sessionId: event.session_id,
            updatedAt: Date.now(),
          },
        };
        const durableSessionId = threadsRef.current[profileName]?.storedSessionId || "";
        publishLiveActivity(profileName, targetActivity, event.session_id);
        if (durableSessionId && durableSessionId !== event.session_id) {
          publishLiveActivity(profileName, targetActivity, durableSessionId);
        }
        setDismissedLiveSessions((current) => ({ ...current, [liveKey]: false }));
        setLiveActivities((current) => {
          const previous = current[liveKey];
          const sameTarget = previous?.view?.targetId === payload.target_id || previous?.view?.pageId === payload.target_id;
          return {
            ...current,
            [liveKey]: {
              ...targetActivity,
              view: {
                ...(sameTarget ? previous?.view : {}),
                ...targetActivity.view,
              },
            },
          };
        });
        updateThread(profileName, (current) => ({
          ...current,
          browserRequested: true,
          browserSessionId: payload.browser_session_id || current.browserSessionId || event.session_id || "",
          heartbeat: Date.now(),
        }));
        onActivityChange?.(profileName, targetActivity);
      } else if (event.type === "browser.progress") {
        const liveKey = `${profileName}:${event.session_id}`;
        setDismissedLiveSessions((current) => ({ ...current, [liveKey]: false }));
        updateThread(profileName, (current) => appendProgressStep(
          {
            ...current,
            browserRequested: true,
            browserSessionId: current.storedSessionId || current.browserSessionId || event.session_id || "",
            status: "브라우저 작업 중",
            heartbeat: Date.now(),
          },
          "브라우저 진행",
          payload.message || payload.text || "브라우저 기반 작업을 진행하고 있습니다.",
        ));
        onActivityChange?.(profileName, mergeActivityView({
          state: "working",
          text: payload.message || payload.text || "브라우저 작업 중",
          collaborator: "",
        }, payload));
      } else if (event.type === "review.summary") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, heartbeat: Date.now() },
          "리뷰 요약",
          payload.text ?? "검토 요약이 도착했습니다.",
        ));
      } else if (event.type === "session.info") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, heartbeat: Date.now() },
          "세션 정보 업데이트",
          payload.version || payload.model || payload.provider || "Hermes 세션 정보가 업데이트되었습니다.",
        ));
      } else if (event.type === "notification.show") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, heartbeat: Date.now() },
          payload.level === "error" ? "알림 오류" : "알림",
          payload.text ?? payload.message ?? "Hermes 알림이 도착했습니다.",
        ));
      } else if (event.type === "billing.step_up.verification") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, status: "계정 확인 필요", running: false, finishedAt: Date.now(), heartbeat: Date.now() },
          "계정 확인 필요",
          payload.user_code
            ? `인증 코드 ${payload.user_code}를 확인 페이지에서 입력해야 합니다.`
            : payload.verification_url || "계정 확인이 필요합니다.",
        ));
        onActivityChange?.(profileName, { state: "approval", text: "계정 확인 필요", collaborator: "사용자" });
      } else if (event.type === "voice.status" || event.type === "voice.transcript") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, heartbeat: Date.now() },
          event.type === "voice.status" ? "음성 상태" : "음성 전사",
          payload.text || payload.state || "음성 이벤트가 업데이트되었습니다.",
        ));
      } else if (event.type?.startsWith("subagent.")) {
        const labelMap = {
          "subagent.spawn_requested": "협업 구성원 요청",
          "subagent.start": "협업 구성원 시작",
          "subagent.thinking": "협업 구성원 검토",
          "subagent.tool": "협업 도구 사용",
          "subagent.progress": "협업 진행",
          "subagent.complete": "협업 완료",
        };
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, status: labelMap[event.type] ?? "협업 진행", heartbeat: Date.now() },
          labelMap[event.type] ?? "협업 진행",
          payload.summary || payload.text || payload.goal || payload.tool_preview || payload.tool_name || "협업 이벤트가 업데이트되었습니다.",
        ));
        onActivityChange?.(profileName, mergeActivityView({
          state: event.type === "subagent.complete" ? "working" : "meeting",
          text: payload.summary || payload.text || payload.goal || "협업 진행 중",
          collaborator: payload.subagent_id || "subagent",
        }, payload));
      } else if (event.type === "gateway.stderr" || event.type === "gateway.protocol_error" || event.type === "gateway.start_timeout") {
        updateThread(profileName, (current) => ({
          ...appendProgressStep(
            current,
            "Gateway 확인 필요",
            payload.message || payload.stderr_tail || "Gateway 런타임 이벤트를 확인해야 합니다.",
          ),
          error: payload.message || payload.stderr_tail || current.error,
          running: false,
          finishedAt: Date.now(),
        }));
      } else if (event.type === "status.update") {
        updateThread(profileName, (current) => appendProgressStep(
          { ...current, status: payload.text ?? current.status },
          "진행 상태 업데이트",
          payload.text ?? current.status,
        ));
        onActivityChange?.(profileName, mergeActivityView({
          state: "working",
          text: payload.text ?? threadsRef.current[profileName]?.status ?? "작업 중",
          collaborator: "",
        }, payload));
      } else if (event.type === "error") {
        updateThread(profileName, (current) => ({ ...current, pendingRequest: null, error: payload.message ?? "Hermes 처리 중 오류가 발생했습니다.", running: false, finishedAt: Date.now() }));
      }
    });
    gateway.connect().catch((error) => {
      setConnection("error");
      updateThread("default", (current) => requestFailureThread(current, error));
      scheduleReconnect();
    });
    const reconnectNow = () => scheduleReconnect();
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", reconnectNow);
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", reconnectNow);
      removeState();
      removeReconnectState();
      removeEvent();
      gateway.close();
    };
  }, [onActivityChange, onStartMeeting, refreshFiles, refreshSessions, updateThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.messages, thread.tools, thread.files]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setThreads((current) => {
        let changed = false;
        const next = Object.fromEntries(Object.entries(current).map(([profileName, item]) => {
          if (!item.running) return [profileName, item];
          changed = true;
          return [profileName, { ...item, heartbeat: Date.now() }];
        }));
        if (changed) threadsRef.current = next;
        return changed ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ensureSession = async (profileName, signal) => {
    const current = threadsRef.current[profileName] ?? emptyThread();
    if (current.liveSessionId) return current.liveSessionId;
    const gateway = gatewayRef.current;
    await gateway.connect();
    await assertHermesSetupReady(gateway);
    updateThread(profileName, (item) => appendProgressStep(item, "세션 준비 중", "구성원 전용 작업 세션에 연결합니다."));
    const result = current.storedSessionId
      ? await gateway.request("session.resume", { session_id: current.storedSessionId, cols: 96, profile: profileName }, 120000, signal)
      : await gateway.request("session.create", { cols: 96, profile: profileName }, 120000, signal);
    const storedSessionId = result.stored_session_id || current.storedSessionId || "";
    sessionsRef.current.set(result.session_id, profileName);
    updateThread(profileName, (item) => appendProgressStep({
      ...item,
      liveSessionId: result.session_id,
      storedSessionId,
      conversationKey: storedSessionId ? `${profileName}-${storedSessionId}` : item.conversationKey,
    }, "세션 연결 완료", "이제 요청을 전달합니다."));
    if (storedSessionId) {
      const selection = readSelection();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...selection, [profileName]: storedSessionId }));
    }
    return result.session_id;
  };

  const sendMessage = async () => {
    const pendingInputFiles = unattachedInputFiles(thread);
    const text = draft.trim() || (pendingInputFiles.length ? "첨부 파일을 확인하고 요청에 맞게 처리해주세요." : "");
    if (!text || thread.running || thread.uploading) return;
    const conversationKey = ensureConversationKey(activeProfile);
    const currentThread = threadsRef.current[activeProfile] ?? thread;
    const inputFiles = unattachedInputFiles(currentThread);
    const outputDirectory = currentThread.outputDirectory || `/opt/data/home/hermes-chat-files/${conversationKey}/outputs`;
    let agentText = buildAgentRuntimePrompt({
      text,
      profileName: activeProfile,
      inputFiles,
      outputDirectory,
    });
    setDraft("");
    updateThread(activeProfile, (current) => ({
      ...current,
      error: "",
      running: true,
      status: "요청 전달 중",
      startedAt: Date.now(),
      finishedAt: 0,
      heartbeat: Date.now(),
      progress: [
        {
          id: crypto.randomUUID(),
          label: "요청 접수",
          detail: "사용자 메시지를 구성원 작업 지시로 변환했습니다.",
          time: "방금",
        },
      ],
      messages: [
        ...current.messages,
        { id: crypto.randomUUID(), role: "user", text, files: inputFiles, time: "방금" },
        { id: crypto.randomUUID(), role: "assistant", text: "", time: "", pending: true },
      ],
    }));
    onActivityChange?.(activeProfile, { state: "working", text, collaborator: "사용자" });
    const controller = new AbortController();
    activePromptControllersRef.current[activeProfile]?.abort();
    activePromptControllersRef.current[activeProfile] = controller;
    try {
      updateThread(activeProfile, (current) => appendProgressStep({ ...current, status: "파일 작업 공간 준비 중" }, "파일 작업 공간 준비", "첨부와 산출물 폴더를 확인합니다."));
      await prepareChatFiles(conversationKey);
      updateThread(activeProfile, (current) => appendProgressStep({ ...current, status: "구성원에게 요청 전달 중" }, "요청 전송", "Hermes Gateway로 작업을 넘깁니다."));
      const sessionId = await ensureSession(activeProfile, controller.signal);
      interruptedSessionIdsRef.current.delete(sessionId);
      const drop = await gatewayRef.current.request("input.detect_drop", { session_id: sessionId, text }, 15000, controller.signal).catch(() => null);
      if (drop?.matched) {
        const runtimeText = drop.text || text;
        agentText = buildAgentRuntimePrompt({
          text: runtimeText,
          profileName: activeProfile,
          inputFiles,
          outputDirectory,
        });
        updateThread(activeProfile, (current) => appendProgressStep(
          { ...current, status: "첨부 경로 감지" },
          drop.is_image ? "이미지 경로 감지" : "파일 경로 감지",
          drop.name ? `${drop.name} 경로를 Hermes 입력으로 정리했습니다.` : "붙여넣은 파일 경로를 Hermes 입력으로 정리했습니다.",
        ));
      }
      await gatewayRef.current.request("prompt.submit", { session_id: sessionId, text: agentText }, 120000, controller.signal);
      updateThread(activeProfile, (current) => appendProgressStep({ ...current, status: "구성원이 검토 중" }, "구성원 검토 시작", "응답이나 도구 실행 이벤트를 기다리고 있습니다."));
    } catch (error) {
      if (error?.name === "AbortError") return;
      updateThread(activeProfile, (current) => ({
        ...current,
        running: false,
        error: userFacingThreadError(error),
        finishedAt: Date.now(),
        messages: current.messages.filter((message) => !message.pending),
      }));
      onActivityChange?.(activeProfile, { state: "online", text: "대기 중", collaborator: "" });
    } finally {
      if (activePromptControllersRef.current[activeProfile] === controller) {
        delete activePromptControllersRef.current[activeProfile];
      }
    }
  };

  const uploadSelectedFiles = async (selectedFiles) => {
    if (!selectedFiles?.length) return;
    if (selectedFiles.length > 20) {
      updateThread(activeProfile, (current) => ({ ...current, error: "한 번에 최대 20개 파일을 첨부할 수 있습니다." }));
      return;
    }
    const conversationKey = ensureConversationKey(activeProfile);
    updateThread(activeProfile, (current) => ({ ...current, uploading: true, error: "" }));
    try {
      const payload = await uploadChatFiles(conversationKey, selectedFiles);
      updateThread(activeProfile, (current) => ({
        ...current,
        uploading: false,
        files: [...current.files, ...payload.files],
        outputDirectory: payload.outputDirectory,
      }));
    } catch (error) {
      updateThread(activeProfile, (current) => ({ ...current, uploading: false, error: userFacingThreadError(error) }));
    }
  };

  const uploadFiles = async (event) => {
    await uploadSelectedFiles([...event.target.files]);
    event.target.value = "";
  };

  const handleComposerPaste = async (event) => {
    const images = extractClipboardImageFiles(event.clipboardData);
    if (!images.length) return;
    event.preventDefault();
    await uploadSelectedFiles(images);
  };

  const pasteClipboardImages = async () => {
    setComposerMenuOpen(false);
    try {
      const images = await readClipboardImageFiles();
      if (!images.length) throw new Error("클립보드에서 이미지를 찾지 못했습니다.");
      await uploadSelectedFiles(images);
    } catch (error) {
      updateThread(activeProfile, (current) => ({ ...current, error: userFacingThreadError(error) }));
    }
  };

  const insertDraftText = (text) => {
    setDraft((current) => [current.trimEnd(), text].filter(Boolean).join(current.trim() ? "\n" : ""));
  };

  const submitUrl = () => {
    const value = urlDraft.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) {
      updateThread(activeProfile, (current) => ({ ...current, error: "http:// 또는 https://로 시작하는 올바른 URL을 입력해 주세요." }));
      return;
    }
    insertDraftText(value);
    setUrlDraft("");
    setUrlOpen(false);
  };

  const removeFile = async (file) => {
    try {
      await deleteChatFile(thread.conversationKey, file);
      updateThread(activeProfile, (current) => ({
        ...current,
        files: current.files.filter((item) => !(item.scope === file.scope && item.name === file.name)),
        messages: current.messages.map((message) => ({
          ...message,
          files: (message.files ?? []).filter((item) => !(item.scope === file.scope && item.name === file.name)),
        })),
      }));
    } catch (error) {
      updateThread(activeProfile, (current) => ({ ...current, error: userFacingThreadError(error) }));
    }
  };

  const interruptActiveSession = async () => {
    const currentThread = threadsRef.current[activeProfile] ?? thread;
    const sessionId = currentThread.liveSessionId;
    if (!currentThread.running) return;
    activePromptControllersRef.current[activeProfile]?.abort();
    if (sessionId) interruptedSessionIdsRef.current.add(sessionId);
    updateThread(activeProfile, (current) => {
      const messages = current.messages.map((message) =>
        message.pending
          ? { ...message, pending: false, text: message.text ? `${message.text}\n\n[중단됨]` : "[중단됨]", time: "방금" }
          : message,
      );
      return appendProgressStep({
        ...current,
        messages,
        running: false,
        status: "중단됨",
        finishedAt: Date.now(),
        heartbeat: Date.now(),
      }, "작업 중단", "사용자가 현재 응답 생성을 중단했습니다.");
    });
    onActivityChange?.(activeProfile, { state: "online", text: "대기 중", collaborator: "" });
    if (sessionId) {
      try {
        await gatewayRef.current?.request("session.interrupt", { session_id: sessionId }, 5000);
      } catch {
        // The local UI already released the busy state. Backend interrupt is best-effort.
      }
    }
  };

  const respondToPendingRequest = async (value) => {
    const pendingRequest = threadsRef.current[activeProfile]?.pendingRequest;
    if (!pendingRequest || pendingRequest.responding) return;
    if (isHitlRequestExpired(pendingRequest)) {
      updateThread(activeProfile, (current) => ({ ...current, pendingRequest: null, status: "사용자 입력 요청 만료" }));
      return;
    }
    updateThread(activeProfile, (current) => ({
      ...current,
      pendingRequest: { ...current.pendingRequest, responding: true, error: "" },
    }));
    try {
      const rpc = hitlResponseRequest(pendingRequest, value);
      await gatewayRef.current.request(rpc.method, rpc.params, 30000);
      updateThread(activeProfile, (current) => appendProgressStep({
        ...current,
        pendingRequest: null,
        running: true,
        status: "사용자 응답 전달됨",
        finishedAt: 0,
        heartbeat: Date.now(),
      }, "사용자 응답 전달", "Hermes가 작업을 계속 진행합니다."));
      onActivityChange?.(activeProfile, { state: "working", text: "사용자 응답 반영 중", collaborator: "사용자" });
    } catch (responseError) {
      updateThread(activeProfile, (current) => ({
        ...current,
        pendingRequest: current.pendingRequest ? { ...current.pendingRequest, responding: false, error: responseError.message } : null,
      }));
    }
  };

  return (
    <div className={`profile-chat-layout ${compact ? "compact-profile-chat" : ""} ${livePanelRequested ? "has-live-view" : ""} mobile-stage-${mobileStage}`}>
      {!compact && (
        <section className="mobile-chat-start">
          {mobileStage === "people" && (
            <>
              <header>
                <span>DIRECT MESSAGES</span>
                <strong>누구와 대화할까요?</strong>
                <small>구성원을 먼저 고르면 기존 세션을 이어가거나 새 대화를 시작할 수 있습니다.</small>
              </header>
              <div className="mobile-chat-people">
                {availableProfiles.map((profileName) => {
                  const member = TEAM_META[profileName];
                  const profile = profiles.find((item) => item.name === profileName);
                  const memberThread = threads[profileName];
                  const unreadCount = unreadCountForProfile(profileName);
                  return (
                    <button
                      type="button"
                      key={profileName}
                      className={unreadCount ? "unread" : ""}
                      onClick={() => {
                        setActiveProfile(profileName);
                        setMobileStage("sessions");
                      }}
                    >
                      <span style={{ "--avatar": member.color }}>{member.initials}</span>
                      <div><strong>{member.name}</strong><small>{memberThread?.running ? memberThread.status : member.role}</small></div>
                      {unreadCount > 0 && <b className="chat-unread-badge">{unreadCount}</b>}
                      <i className={profile?.gateway_running ? "online" : ""} />
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {mobileStage === "sessions" && (
            <>
              <header>
                <button type="button" onClick={() => setMobileStage("people")}>← 구성원</button>
                <span>{meta.name}</span>
                <strong>대화 선택</strong>
                <small>이전 대화를 이어가거나 새 대화를 시작하세요.</small>
                <button type="button" className="mark-read-button" onClick={() => markProfileRead(activeProfile)}>모두 읽음</button>
              </header>
              <div className="mobile-session-list">
                <button type="button" className="new-mobile-session" onClick={() => startMobileConversation(activeProfile)}>
                  <strong>새 대화 시작</strong>
                  <small>{meta.name}에게 새 업무를 요청합니다.</small>
                </button>
                {profileSessions.map((session) => (
                  <article key={session.id} className={`chat-session-item ${isUnreadSession(session, readState, activeProfile) ? "unread" : ""}`}>
                    <button type="button" className="chat-session-open" onClick={() => openStoredSessionForMobile(activeProfile, session.id)}>
                    <strong>{sessionTitle(session)}</strong>
                    <small>{session.message_count} messages · {formatTime(session.last_active)}</small>
                    {isUnreadSession(session, readState, activeProfile) && <span className="session-new-label">NEW</span>}
                    </button>
                    <button type="button" className="chat-session-remove" aria-label="대화 목록에서 숨기기" onClick={() => hideSession(activeProfile, session.id)}>×</button>
                  </article>
                ))}
                {!profileSessions.length && <p>저장된 대화가 없습니다. 새 대화를 시작해보세요.</p>}
              </div>
            </>
          )}
        </section>
      )}
      {!compact && <aside className="profile-chat-roster">
        <header><span>DIRECT MESSAGES</span><strong>AI 구성원</strong></header>
        {availableProfiles.map((profileName) => {
          const member = TEAM_META[profileName];
          const profile = profiles.find((item) => item.name === profileName);
          const memberThread = threads[profileName];
          const unreadCount = unreadCountForProfile(profileName);
          return (
            <button type="button" key={profileName} className={`${activeProfile === profileName ? "active" : ""} ${unreadCount ? "unread" : ""}`.trim()} onClick={() => setActiveProfile(profileName)}>
              <span style={{ "--avatar": member.color }}>{member.initials}</span>
              <div><strong>{member.name}</strong><small>{memberThread?.running ? memberThread.status : member.role}</small></div>
              {unreadCount > 0 && <b className="chat-unread-badge">{unreadCount}</b>}
              <i className={profile?.gateway_running ? "online" : ""} />
            </button>
          );
        })}
      </aside>}

      {!compact && <aside className="chat-session-rail">
        <header><span>CONVERSATIONS</span><div><button type="button" onClick={() => markProfileRead(activeProfile)}>모두 읽음</button><button type="button" onClick={() => resetConversation()}>초기화</button><button type="button" onClick={() => newConversation()}>+ 새 대화</button></div></header>
        {profileSessions.map((session) => (
          <article key={session.id} className={`chat-session-item ${thread.storedSessionId === session.id ? "active" : ""} ${isUnreadSession(session, readState, activeProfile) ? "unread" : ""}`.trim()}>
            <button type="button" className="chat-session-open" onClick={() => openStoredSession(activeProfile, session.id)}>
            <strong>{sessionTitle(session)}</strong><small>{session.message_count}개 · {formatTime(session.last_active)}</small>
            {isUnreadSession(session, readState, activeProfile) && <span className="session-new-label">NEW</span>}
            </button>
            <button type="button" className="chat-session-remove" aria-label="대화 목록에서 숨기기" onClick={() => hideSession(activeProfile, session.id)}>×</button>
          </article>
        ))}
        {!profileSessions.length && <p>저장된 대화가 없습니다.</p>}
      </aside>}

      <section className="profile-chat-panel">
        <header className="profile-chat-header">
          {!compact && <button type="button" className="mobile-chat-back" onClick={() => setMobileStage("sessions")}>← 대화 선택</button>}
          <span className="profile-chat-hero" style={{ "--avatar": meta.color }}>{meta.initials}</span>
          <div><small>{meta.role}</small><h3>{meta.name}과 대화</h3></div>
          <span className={`chat-connection ${connection}`}><i /> {connection === "open" ? "실시간 연결" : "연결 확인 중"}</span>
          {!compact && <button type="button" className="chat-mark-read-button" onClick={markActiveSessionRead}>읽음 처리</button>}
          {!compact && <button type="button" className="chat-reset-button" onClick={() => resetConversation(activeProfile)}>초기화</button>}
        </header>
        <div className="profile-chat-feed">
          {loadingHistory && <p className="empty-state">이전 대화를 불러오는 중입니다.</p>}
          {!loadingHistory && !thread.messages.length && (
            <div className="profile-chat-empty">
              <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
              <h4>{meta.name}에게 새 업무를 요청하세요</h4>
              <p>이 대화는 <b>{activeProfile}</b> 프로필에만 연결됩니다.</p>
            </div>
          )}
          {thread.messages.filter(isRenderableMessage).map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              meta={meta}
              conversation={thread.conversationKey}
              onStartMeeting={onStartMeeting}
            />
          ))}
          <ThinkingPanel thread={thread} meta={meta} />
          <HermesPrompt key={thread.pendingRequest?.id || "no-prompt"} request={thread.pendingRequest} busy={Boolean(thread.pendingRequest?.responding)} onRespond={respondToPendingRequest} />
          {thread.error && <p className="profile-chat-error">{thread.error}</p>}
          <div ref={bottomRef} />
        </div>
        <footer
          className={`profile-chat-composer${composerDragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); setComposerDragging(true); } }}
          onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) event.preventDefault(); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setComposerDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setComposerDragging(false); uploadSelectedFiles([...event.dataTransfer.files]); }}
        >
          <div className="chat-status-line"><span>{thread.running ? `${meta.name}이 답변을 준비 중` : `${meta.name} 준비됨`}</span><small>{thread.storedSessionId ? "기존 대화 이어가기" : "새 대화"} · {activeProfile}</small></div>
          <input ref={fileInputRef} className="chat-file-input" name="chat-files" aria-label="파일 첨부" type="file" multiple onChange={uploadFiles} />
          <input ref={imageInputRef} className="chat-file-input" name="chat-images" aria-label="이미지 첨부" type="file" accept="image/*" multiple onChange={uploadFiles} />
          <input ref={folderInputRef} className="chat-file-input" name="chat-folder" aria-label="폴더 첨부" type="file" multiple webkitdirectory="" directory="" onChange={uploadFiles} />
          {unattachedInputFiles(thread).length > 0 && (
            <div className="composer-attachments">
              {unattachedInputFiles(thread).map((file) => (
                <article key={file.name} className={file.mime?.startsWith("image/") ? "is-image" : ""}>
                  {file.mime?.startsWith("image/") ? <img src={chatFileUrl(thread.conversationKey, file, true)} alt="" /> : <i aria-hidden="true">DOC</i>}
                  <span><strong>{displayFileName(file)}</strong><small>{file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : "첨부 파일"}</small></span>
                  <button type="button" aria-label={`${displayFileName(file)} 제거`} title="첨부 제거" onClick={() => removeFile(file)}>×</button>
                </article>
              ))}
            </div>
          )}
          <div className="chat-composer-row">
            <div className="composer-add-wrap">
              <button type="button" className="attach-button" aria-label="첨부 및 도구" title="첨부 및 도구" aria-expanded={composerMenuOpen} onClick={() => setComposerMenuOpen((open) => !open)} disabled={thread.uploading}>+</button>
              {composerMenuOpen && <div className="composer-add-menu">
                <small>첨부</small>
                <button type="button" onClick={() => { setComposerMenuOpen(false); fileInputRef.current?.click(); }}><span>F</span>파일</button>
                <button type="button" onClick={() => { setComposerMenuOpen(false); folderInputRef.current?.click(); }}><span>D</span>폴더</button>
                <button type="button" onClick={() => { setComposerMenuOpen(false); imageInputRef.current?.click(); }}><span>I</span>이미지</button>
                <button type="button" onClick={pasteClipboardImages}><span>P</span>이미지 붙여넣기</button>
                <button type="button" onClick={() => { setComposerMenuOpen(false); setUrlOpen(true); }}><span>L</span>URL</button>
                <hr />
                <button type="button" onClick={() => { setComposerMenuOpen(false); setSnippetsOpen(true); }}><span>S</span>프롬프트 스니펫</button>
                <p><kbd>@</kbd>로 작업공간의 파일을 참조할 수 있습니다.</p>
              </div>}
            </div>
            <textarea name="chat-message" aria-label={`${meta.name}에게 메시지 보내기`} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={handleComposerPaste} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); }
            }} placeholder={thread.pendingRequest ? "위 확인 요청에 먼저 응답해주세요" : `${meta.name}에게 메시지 보내기`} disabled={connection !== "open" || Boolean(thread.pendingRequest)} />
            <div className="chat-composer-actions">
              {thread.running && <button type="button" className="interrupt-button" onClick={interruptActiveSession}>중단</button>}
              <button type="button" onClick={sendMessage} disabled={(!draft.trim() && !unattachedInputFiles(thread).length) || thread.running || thread.uploading || Boolean(thread.pendingRequest) || connection !== "open"}>전송</button>
            </div>
          </div>
          {thread.uploading && <div className="composer-uploading" role="status">첨부 파일을 안전하게 업로드하는 중입니다.</div>}
          {urlOpen && <div className="composer-dialog-backdrop" onMouseDown={() => setUrlOpen(false)}><div ref={urlDialogRef} className="composer-dialog" role="dialog" aria-modal="true" aria-labelledby="composer-url-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}><strong id="composer-url-title">URL 추가</strong><p>에이전트가 확인할 웹 주소를 메시지에 추가합니다.</p><input autoFocus aria-label="추가할 URL" value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitUrl(); }} placeholder="https://example.com" /><div><button type="button" className="secondary" onClick={() => setUrlOpen(false)}>취소</button><button type="button" onClick={submitUrl}>추가</button></div></div></div>}
          {snippetsOpen && <div className="composer-dialog-backdrop" onMouseDown={() => setSnippetsOpen(false)}><div ref={snippetsDialogRef} className="composer-dialog composer-snippets" role="dialog" aria-modal="true" aria-labelledby="composer-snippets-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}><strong id="composer-snippets-title">프롬프트 스니펫</strong><p>자주 쓰는 요청을 초안에 추가합니다.</p>{[
            ["코드 검토", "이 변경사항을 검토하고, 버그·회귀 위험·누락된 테스트를 심각도 순으로 정리해줘."],
            ["구현 계획", "이 작업의 요구사항을 분석하고, 구현 단계와 검증 기준을 포함한 실행 계획을 작성해줘."],
            ["내용 설명", "선택한 내용이 어떻게 동작하는지 핵심 흐름과 중요한 세부사항을 명확하게 설명해줘."],
          ].map(([label, text]) => <button key={label} type="button" className="snippet-choice" onClick={() => { insertDraftText(text); setSnippetsOpen(false); }}><strong>{label}</strong><span>{text}</span></button>)}<button type="button" className="secondary dialog-close" onClick={() => setSnippetsOpen(false)}>닫기</button></div></div>}
        </footer>
      </section>
      {livePanelRequested && !fullscreenLive && (
        <aside className="chat-live-panel">
          {liveViewAvailable ? (
            <LiveScreenPanel
              activity={activeActivity}
              profileName={activeProfile}
              sessionId={liveBrowserScopeId}
              variant="chat"
              onFullscreen={() => setFullscreenLive(true)}
              onClose={() => setDismissedLiveSessions((current) => ({ ...current, [activeLiveKey]: true }))}
            />
          ) : (
            <section className="live-screen-pending" aria-live="polite">
              <header>
                <span>LIVE BROWSER</span>
                <button type="button" aria-label="Live Screen 닫기" onClick={() => setDismissedLiveSessions((current) => ({ ...current, [activeLiveKey]: true }))}>닫기</button>
              </header>
              <div><i /><strong>{liveConnectionState === "reconnecting" ? "브라우저에 다시 연결하는 중" : "브라우저 세션을 여는 중"}</strong><small>{meta.name}의 실제 Chrome 탭을 연결하고 있습니다.</small></div>
            </section>
          )}
        </aside>
      )}
      {fullscreenLive && liveViewAvailable && (
        <LiveScreenModal
          activity={activeActivity}
          profileName={activeProfile}
          sessionId={liveBrowserScopeId}
          onClose={() => setFullscreenLive(false)}
        />
      )}
    </div>
  );
}
