import { useEffect, useMemo, useState } from "react";
import { decodeHermesText, hermesFetch, isMeetingSession, loadArchivedSessions, loadProfileSessions, loadSessionMessages } from "./hermes.js";
import { TEAM_META } from "./officeData.js";
import { sanitizeArchiveMessages, sanitizeArchiveText } from "./archiveContracts.js";

const MEETING_STORAGE_KEY = "hermes-office-meetings";
const ARCHIVE_CACHE_KEY = "hermes-office-archive-snapshot";
function cleanText(value) {
  return sanitizeArchiveText(decodeHermesText(value ?? ""));
}

function sessionLabel(session) {
  return cleanText(session.title || session.preview || "").slice(0, 74) || "제목 없는 대화";
}

function formatDate(value, milliseconds = false) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds ? value : value * 1000));
}

function loadMeetings() {
  try {
    return JSON.parse(window.localStorage.getItem(MEETING_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function loadArchiveSnapshot() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(ARCHIVE_CACHE_KEY) || "null");
    if (!cached || Date.now() - Number(cached.savedAt ?? 0) > 10 * 60 * 1000) return null;
    return cached;
  } catch {
    return null;
  }
}

function saveArchiveSnapshot(sessions, meetings) {
  try {
    window.localStorage.setItem(ARCHIVE_CACHE_KEY, JSON.stringify({ sessions, meetings, savedAt: Date.now() }));
  } catch {
    // Snapshot caching is a speed optimization only.
  }
}

function meetingTopic(session) {
  const text = cleanText(session.preview ?? session.title ?? "");
  return text.match(/주제:\s*([^\n]+)/)?.[1]?.trim() ||
    cleanText(session.title)?.replace(/^\[회의\]\s*/, "") ||
    "이전 팀 회의";
}

function groupLegacyMeetings(sessions, localMeetings) {
  const groups = new Map();
  sessions.filter(isMeetingSession).forEach((session) => {
    const topic = meetingTopic(session);
    const bucket = Math.floor((session.last_active ?? session.started_at ?? 0) / 3600);
    const key = `${topic}-${bucket}`;
    const current = groups.get(key) ?? {
      id: `legacy-${key}`,
      topic,
      participants: [],
      chair: "default",
      startedAt: (session.started_at ?? session.last_active) * 1000,
      updatedAt: session.last_active * 1000,
      status: "complete",
      round: 1,
      entries: [],
      legacySessions: [],
    };
    current.participants = [...new Set([...current.participants, session.profile])];
    current.updatedAt = Math.max(current.updatedAt, session.last_active * 1000);
    current.legacySessions.push(session);
    groups.set(key, current);
  });
  const legacy = [...groups.values()].filter((meeting) => !localMeetings.some((local) =>
    local.topic === meeting.topic && Math.abs(local.updatedAt - meeting.updatedAt) < 7200000,
  ));
  return [...localMeetings, ...legacy].sort((a, b) => b.updatedAt - a.updatedAt);
}

export default function SessionArchive({
  profiles,
  onContinue,
  onBranch,
  onTerminal,
  onFollowupMeeting,
}) {
  const [archiveSnapshot] = useState(() => loadArchiveSnapshot());
  const [sessions, setSessions] = useState(() => archiveSnapshot?.sessions ?? []);
  const [meetings, setMeetings] = useState(() => archiveSnapshot?.meetings ?? loadMeetings());
  const [selected, setSelected] = useState(() => archiveSnapshot?.sessions?.[0] ?? archiveSnapshot?.meetings?.[0] ?? null);
  const [messages, setMessages] = useState([]);
  const [type, setType] = useState("direct");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(() => !(archiveSnapshot?.sessions?.length || archiveSnapshot?.meetings?.length));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sessionLimit, setSessionLimit] = useState(80);
  const [messageLimit, setMessageLimit] = useState(80);
  const profileNames = useMemo(() => profiles.map((profile) => profile.name), [profiles]);

  useEffect(() => {
    if (!profileNames.length) return;
    loadArchivedSessions()
      .then((archivedSessions) => Promise.all(profileNames.map((profile) =>
        loadProfileSessions(profile, 60, { includeArchived: true, archivedSessions }),
      )))
      .then((sets) => {
        const items = sets.flat()
          .filter((session, index, all) => all.findIndex((item) => item.id === session.id && item.profile === session.profile) === index)
          .sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
        const direct = items.filter((session) => !isMeetingSession(session));
        const groupedMeetings = groupLegacyMeetings(items, loadMeetings());
        setSessions(direct);
        setMeetings(groupedMeetings);
        saveArchiveSnapshot(direct, groupedMeetings);
        setSelected((current) => current ?? direct[0] ?? null);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [profileNames]);

  useEffect(() => {
    if (type !== "meeting" || !selected?.legacySessions?.length || selected.entries.length) return;
    Promise.all(selected.legacySessions.map(async (session) => {
      const sessionMessages = await loadSessionMessages(session.id, session.profile);
      return sessionMessages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          id: `${session.profile}-${message.id}`,
          profile: session.profile,
          kind: cleanText(message.content).includes("회의 결론") ? "summary" : "statement",
          text: cleanText(message.content),
          pending: false,
          time: formatDate(message.timestamp),
          timestamp: message.timestamp,
        }));
    })).then((sets) => {
      const entries = sets.flat().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      setMeetings((current) => current.map((meeting) => meeting.id === selected.id ? { ...meeting, entries } : meeting));
      setSelected((current) => current?.id === selected.id ? { ...current, entries } : current);
    }).catch((loadError) => setError(loadError.message));
  }, [selected, type]);

  useEffect(() => {
    if (type !== "direct" || !selected) return;
    loadSessionMessages(selected.id, selected.profile)
      .then((items) => {
        setMessageLimit(80);
        setMessages(sanitizeArchiveMessages(items.map((message) => ({
          ...message,
          content: decodeHermesText(message.content ?? ""),
        }))));
      })
      .catch((loadError) => setError(loadError.message));
  }, [selected, type]);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => filter === "all" || session.profile === filter),
    [filter, sessions],
  );
  const pagedSessions = visibleSessions.slice(0, sessionLimit);
  const pagedMessages = messages.slice(Math.max(0, messages.length - messageLimit));
  const meta = TEAM_META[selected?.profile] ?? TEAM_META.default;
  const selectedMeeting = type === "meeting" ? selected : null;

  const switchType = (nextType) => {
    setType(nextType);
    if (nextType === "meeting") setSelected(meetings[0] ?? null);
    else setSelected(visibleSessions[0] ?? sessions[0] ?? null);
  };

  const exportSelectedSession = async () => {
    if (!selected?.id || type !== "direct") return;
    try {
      const payload = await hermesFetch(`/api/sessions/${encodeURIComponent(selected.id)}/export?profile=${encodeURIComponent(selected.profile ?? "")}`, {
        cacheTtlMs: 0,
        timeoutMs: 30000,
      });
      const blob = new Blob([typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `hermes-session-${selected.profile ?? "default"}-${selected.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("공식 Hermes session export를 생성했습니다.");
    } catch (exportError) {
      setError(exportError.message);
    }
  };

  const deleteSelectedSession = async () => {
    if (!selected?.id || type !== "direct") return;
    if (!window.confirm("이 대화 세션을 공식 Hermes session store에서 삭제할까요? 되돌릴 수 없습니다.")) return;
    try {
      await hermesFetch(`/api/sessions/${encodeURIComponent(selected.id)}?profile=${encodeURIComponent(selected.profile ?? "")}`, {
        method: "DELETE",
        body: JSON.stringify({}),
        timeoutMs: 30000,
      });
      const nextSessions = sessions.filter((session) => !(session.id === selected.id && session.profile === selected.profile));
      setSessions(nextSessions);
      setSelected(nextSessions[0] ?? null);
      setMessages([]);
      saveArchiveSnapshot(nextSessions, meetings);
      setNotice("공식 Hermes session store에서 삭제했습니다.");
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  return (
    <div className="archive-shell">
      <nav className="archive-type-tabs">
        <button type="button" className={type === "direct" ? "active" : ""} onClick={() => switchType("direct")}>
          1:1 대화 <b>{sessions.length}</b>
        </button>
        <button type="button" className={type === "meeting" ? "active" : ""} onClick={() => switchType("meeting")}>
          회의 <b>{meetings.length}</b>
        </button>
      </nav>
      <div className="archive-layout">
        <aside className="archive-list">
          {type === "direct" && (
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">전체 구성원</option>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name}>
                  {TEAM_META[profile.name]?.name ?? profile.name}
                </option>
              ))}
            </select>
          )}
          {loading && type === "direct" && <p>기록을 불러오는 중입니다.</p>}
          {type === "direct" && pagedSessions.map((session) => {
            const owner = TEAM_META[session.profile] ?? TEAM_META.default;
            return (
              <button type="button" key={`${session.profile}-${session.id}`} className={selected?.id === session.id ? "active" : ""} onClick={() => setSelected(session)}>
                <span style={{ "--avatar": owner.color }}>{owner.initials}</span>
                <div><strong>{sessionLabel(session)}</strong><small>{owner.name} · {session.message_count}개 · {formatDate(session.last_active)}{session.archived ? " · 보관됨" : ""}</small></div>
              </button>
            );
          })}
          {type === "direct" && pagedSessions.length < visibleSessions.length && (
            <button type="button" className="archive-load-more" onClick={() => setSessionLimit((value) => value + 80)}>
              기록 80개 더 보기
            </button>
          )}
          {type === "meeting" && meetings.map((meeting) => (
            <button type="button" key={meeting.id} className={selected?.id === meeting.id ? "active" : ""} onClick={() => setSelected(meeting)}>
              <span className="meeting-list-icon">MT</span>
              <div><strong>{meeting.topic}</strong><small>{meeting.participants.length}명 · {meeting.round}라운드 · {formatDate(meeting.updatedAt, true)}</small></div>
            </button>
          ))}
          {type === "meeting" && !meetings.length && <p>이 UI에서 진행한 회의 기록이 아직 없습니다.</p>}
        </aside>
        <section className="archive-reader">
          {!selected ? (
            <div className="archive-empty">읽을 기록을 선택하세요.</div>
          ) : type === "direct" ? (
            <>
              <header>
                <div><span>{meta.name} · {selected.source ?? "Hermes"}</span><h3>{sessionLabel(selected)}</h3></div>
                <div>
                  <button type="button" onClick={() => onBranch(selected)}>새 대화로 분기</button>
                  <button type="button" className="primary" onClick={() => onContinue(selected)}>이어가기</button>
                  <button type="button" onClick={() => onTerminal(selected.id)}>터미널</button>
                  <button type="button" onClick={exportSelectedSession}>export</button>
                  <button type="button" onClick={deleteSelectedSession}>삭제</button>
                </div>
              </header>
              <div className="archive-transcript">
                {pagedMessages.length < messages.length && (
                  <button type="button" className="archive-load-more" onClick={() => setMessageLimit((value) => value + 80)}>
                    이전 메시지 80개 더 보기
                  </button>
                )}
                {pagedMessages.map((message) => (
                  <article key={message.id} className={message.role}>
                    <span>{message.role === "user" ? "사용자" : meta.name}</span>
                    <p>{message.content}</p>
                    <small>{formatDate(message.timestamp)}</small>
                  </article>
                ))}
                {!messages.length && <p className="empty-state">메시지를 불러오는 중입니다.</p>}
              </div>
            </>
          ) : (
            <>
              <header className="meeting-archive-header">
                <div>
                  <span>TEAM MEETING · {selectedMeeting.status === "complete" ? "완료" : "진행 기록"}</span>
                  <h3>{selectedMeeting.topic}</h3>
                  <p>{selectedMeeting.participants.map((name) => TEAM_META[name]?.name).filter(Boolean).join(", ")}</p>
                </div>
                <div><button type="button" className="primary" onClick={() => onFollowupMeeting(selectedMeeting)}>후속 회의 시작</button></div>
              </header>
              {selectedMeeting.outcome && (
                <div className="meeting-archive-outcome">
                  <article>
                    <small>FINAL REPORTER</small>
                    <strong>{selectedMeeting.outcome.reporterName ?? TEAM_META[selectedMeeting.outcome.reporter]?.name}</strong>
                  </article>
                  <article>
                    <small>DECISIONS</small>
                    {(selectedMeeting.outcome.decisions ?? []).slice(0, 4).map((item) => <p key={item}>{item}</p>)}
                  </article>
                  <article>
                    <small>ACTIONS</small>
                    {(selectedMeeting.outcome.actions ?? []).map((action) => (
                      <p key={`${action.assignee}-${action.title}`}><b>{TEAM_META[action.assignee]?.name ?? action.assignee}</b> {action.title}</p>
                    ))}
                    {!selectedMeeting.outcome.actions?.length && <p>연결된 Kanban 액션이 없습니다.</p>}
                  </article>
                </div>
              )}
              <div className="archive-transcript meeting-archive-transcript">
                {selectedMeeting.entries.map((entry) => {
                  const speaker = TEAM_META[entry.profile] ?? TEAM_META.default;
                  return (
                    <article key={entry.id} className={entry.kind === "summary" ? "summary" : "assistant"}>
                      <span>{speaker.name} · {entry.kind === "summary" ? "최종 회의록" : speaker.role}</span>
                      <p>{entry.text}</p>
                      <small>{entry.time}</small>
                    </article>
                  );
                })}
              </div>
            </>
          )}
          {error && <p className="profile-chat-error">{error}</p>}
          {notice && <p className="task-ops-notice">{notice}</p>}
        </section>
      </div>
    </div>
  );
}
