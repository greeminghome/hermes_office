import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveScreenModal, LiveScreenPanel } from "./LiveScreen.jsx";
import ProfileChat from "./ProfileChat.jsx";
import { loadLiveScreen, loadProfileSessions } from "./hermes.js";
import {
  buildMeetingSeatPlacements,
  buildOfficeAgentPlacements,
  OFFICE_FLOOR_ZONES,
  resolveProfileMeta,
  ROOMS,
} from "./officeData.js";
import { MISSION_STATUS } from "./operationsData.js";
import {
  advanceOfficePoint,
  findOfficePath,
  isOfficePointWalkable,
  moveOfficePoint,
  nearestOfficeWalkablePoint,
  OFFICE_USER_HOME,
} from "./officeNavigation.js";
import { useModalFocus } from "./useModalFocus.js";
import { OFFICE_BRAND_NAME } from "./branding.js";

const AGENT_ACTIVITY = {
  default: "전체 미션 우선순위 조정",
  "hermes-operations": "운영 일정 점검",
  "hermes-brand": "브랜드 문구 검토",
  "hermes-growth": "캠페인 전략 설계",
  "hermes-content": "콘텐츠 카피 작성",
  "hermes-creative": "산출물 품질 확인",
  "hermes-customer": "고객 문의 분류",
  "hermes-finance": "KPI 업데이트",
  "hermes-technology": "Hermes 연결 감시",
};

function MobileOfficeHome({
  profiles,
  missions,
  approvals,
  agentActivities,
  online,
  activeMissions,
  onOpenCommand,
  onOpenKanban,
  onOpenMeeting,
  onSelectAgent,
  onOpenChatDock,
  onOpenRoom,
}) {
  const teamProfiles = profiles;
  const liveProfiles = teamProfiles.filter((profile) => agentActivities[profile.name]?.state === "meeting" || agentActivities[profile.name]?.view?.url);
  const primaryMissions = missions.filter((mission) => mission.status !== "done").slice(0, 3);
  const mobileRooms = ROOMS.filter((room) =>
    ["meeting", "content", "library", "desk", "control"].includes(room.id),
  );

  return (
    <section className="mobile-office-home">
      <div className="mobile-office-hero">
        <span>HERMES MOBILE OFFICE</span>
        <h2>지금 필요한 일을 바로 시작하세요</h2>
        <p>모바일에서는 맵을 보는 것보다 대화, 회의, 승인, 업무 확인이 먼저입니다.</p>
        <div>
          <button type="button" onClick={() => onOpenChatDock("default")}>총괄 에이전트 화면 보며 채팅</button>
          <button type="button" onClick={onOpenMeeting}>회의 시작</button>
        </div>
      </div>

      <div className="mobile-office-stats">
        <article><small>온라인</small><strong>{online}</strong><span>agents</span></article>
        <article><small>진행 업무</small><strong>{activeMissions}</strong><span>missions</span></article>
        <article className={approvals.length ? "attention" : ""}><small>승인</small><strong>{approvals.length}</strong><span>waiting</span></article>
      </div>

      <div className="mobile-quick-actions">
        <button type="button" onClick={onOpenCommand}><span>승인/지휘</span><strong>결정할 일 보기</strong></button>
        <button type="button" onClick={onOpenKanban}><span>업무 보드</span><strong>진행 상황 확인</strong></button>
        <button type="button" onClick={onOpenMeeting}><span>AI 회의</span><strong>팀원 불러 논의</strong></button>
      </div>

      <div className="mobile-section-heading">
        <span>TEAM</span>
        <strong>구성원 바로 대화</strong>
      </div>
      <div className="mobile-agent-strip">
        {teamProfiles.map((profile) => {
          const meta = resolveProfileMeta(profile);
          const activity = agentActivities[profile.name];
          return (
            <button type="button" key={profile.name} onClick={() => onOpenChatDock(profile.name)}>
              <b style={{ "--avatar": meta.color }}>{meta.initials}</b>
              <strong>{meta.name}</strong>
              <small>{activity?.text || meta.role}</small>
              <i className={profile.gateway_running ? "online" : ""} />
            </button>
          );
        })}
      </div>

      {liveProfiles.length > 0 && (
        <>
          <div className="mobile-section-heading">
            <span>LIVE</span>
            <strong>지금 움직이는 팀원</strong>
          </div>
          <div className="mobile-live-list">
            {liveProfiles.map((profile) => {
              const meta = resolveProfileMeta(profile);
              const activity = agentActivities[profile.name];
              return (
                <button type="button" key={profile.name} onClick={() => onOpenChatDock(profile.name)}>
                  <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
                  <div><strong>{meta.name}</strong><small>{activity?.text}</small></div>
                  <b>{activity?.state === "meeting" ? "회의" : "화면"}</b>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mobile-section-heading">
        <span>WORK</span>
        <strong>오늘 볼 업무</strong>
      </div>
      <div className="mobile-mission-list">
        {primaryMissions.map((mission) => {
          const owner = resolveProfileMeta(profiles.find((profile) => profile.name === mission.owner) ?? mission.owner);
          return (
            <button type="button" key={mission.id} onClick={() => onSelectAgent(mission.owner)}>
              <div><strong>{mission.title}</strong><small>{owner.name} · {mission.progress}%</small></div>
              <span><i style={{ width: `${mission.progress}%` }} /></span>
            </button>
          );
        })}
        {!primaryMissions.length && <p>진행 중인 업무가 없습니다.</p>}
      </div>

      <div className="mobile-section-heading">
        <span>ROOMS</span>
        <strong>방별로 들어가기</strong>
      </div>
      <div className="mobile-room-grid">
        {mobileRooms.map((room) => (
          <button type="button" key={room.id} onClick={() => onOpenRoom(room)}>
            <small>{room.subtitle}</small>
            <strong>{room.label}</strong>
            <span>{room.profiles.map((name) => resolveProfileMeta(profiles.find((profile) => profile.name === name) ?? name).name).join(", ") || "공용"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function AgentConsole({ profileName, profiles, missions, sessions, activity, liveWorkspace, liveSelection, onSelectLiveTarget, onFollowLiveTarget, liveSessionId, roomAssignments, onClose, onStartChat, onOpenLive, onOpenChatDock }) {
  const profile = profiles.find((item) => item.name === profileName);
  const meta = resolveProfileMeta(profile ?? profileName);
  const assigned = missions.filter((mission) => mission.owner === profileName);
  const [tab, setTab] = useState("brief");
  const room = ROOMS.find((item) => item.id === roomAssignments?.[profileName])
    ?? ROOMS.find((item) => item.profiles.includes(profileName))
    ?? ROOMS[0];

  return (
    <aside className="agent-console">
      <header>
        <span className="console-avatar" style={{ "--avatar": meta.color }}>{meta.initials}</span>
        <div>
          <small>{profile?.gateway_running ? "ONLINE · 작업 가능" : "OFFLINE"}</small>
          <h3>{meta.name}</h3>
          <p>{meta.role}</p>
        </div>
        <button type="button" onClick={onClose}>ESC</button>
      </header>
      <nav>
        <button type="button" className={tab === "brief" ? "active" : ""} onClick={() => setTab("brief")}>브리핑</button>
        <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
          화면 {activity?.view?.url && <b>LIVE</b>}
        </button>
        <button type="button" className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
          업무 <b>{assigned.length}</b>
        </button>
        <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>기록</button>
      </nav>
      <div className="agent-console-body">
        {tab === "brief" && (
          <div className="agent-brief">
            <span>CURRENT ACTIVITY</span>
            <strong>{activity?.text || AGENT_ACTIVITY[profileName]}</strong>
            <p>
              {assigned[0]?.objective ??
                `${meta.role} 담당 영역에서 새로운 요청을 기다리고 있습니다.`}
            </p>
            <div className="agent-signal">
              <i className={profile?.gateway_running ? "online" : ""} />
              <span>Gateway</span>
              <b>{profile?.gateway_running ? "RUNNING" : "OFFLINE"}</b>
            </div>
            {activity?.view?.url && (
              <button type="button" className="agent-live-jump" onClick={() => setTab("live")}>
                <span>LIVE SCREEN</span>
                <strong>{activity.view.title || new URL(activity.view.url).hostname}</strong>
              </button>
            )}
          </div>
        )}
        {tab === "live" && <LiveScreenPanel activity={activity} workspace={liveWorkspace} selectedTargetId={liveSelection?.targetId || liveWorkspace?.activeTargetId || ""} followAgent={liveSelection?.followAgent !== false} onSelectTarget={onSelectLiveTarget} onFollowAgent={onFollowLiveTarget} profileName={profileName} sessionId={liveSessionId} onFullscreen={onOpenLive} />}
        {tab === "tasks" && (
          <div className="agent-task-list">
            {assigned.length ? assigned.map((mission) => (
              <article key={mission.id}>
                <span className={`status-pill ${MISSION_STATUS[mission.status].tone}`}>
                  {MISSION_STATUS[mission.status].label}
                </span>
                <strong>{mission.title}</strong>
                <div><i style={{ width: `${mission.progress}%` }} /></div>
                <small>{mission.progress}% · {mission.due}</small>
              </article>
            )) : <p className="office-empty">배정된 미션이 없습니다.</p>}
          </div>
        )}
        {tab === "history" && (
          <div className="agent-history">
            {sessions.slice(0, 4).map((session) => (
              <article key={session.id}>
                <small>{session.source ?? "local"}</small>
                <strong>{session.title || "제목 없는 대화"}</strong>
                <span>{session.message_count} messages</span>
              </article>
            ))}
          </div>
        )}
      </div>
      <footer>
        <button type="button" onClick={() => onOpenChatDock(profileName)}>화면 보며 채팅</button>
        <button type="button" onClick={() => onStartChat({ ...room, profile: profileName })}>Hermes 대화 시작</button>
        <small>{profile?.model ?? "Hermes profile"}</small>
      </footer>
    </aside>
  );
}

function MissionBoard({ missions, onClose, onMoveMission, onSelectAgent }) {
  const columns = [
    ["queued", "대기", "BACKLOG"],
    ["working", "진행 중", "IN PROGRESS"],
    ["approval", "승인 대기", "REVIEW"],
    ["done", "완료", "DONE"],
  ];
  const [draggedId, setDraggedId] = useState("");
  const dialogRef = useModalFocus(true, onClose);

  return (
    <div className="rpg-modal-backdrop" onMouseDown={onClose}>
      <section ref={dialogRef} className="mission-board-modal" role="dialog" aria-modal="true" aria-labelledby="mission-board-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>HERMES MISSION BOARD</span>
            <h2 id="mission-board-title">팀 업무 현황</h2>
          </div>
          <button type="button" onClick={onClose}>닫기 ESC</button>
        </header>
        <div className="kanban-grid">
          {columns.map(([status, label, english]) => {
            const items = missions.filter((mission) => mission.status === status);
            return (
              <section
                key={status}
                className={`kanban-column ${status}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (draggedId) onMoveMission(draggedId, status);
                  setDraggedId("");
                }}
              >
                <div className="kanban-heading">
                  <div><small>{english}</small><strong>{label}</strong></div>
                  <b>{items.length}</b>
                </div>
                <div className="kanban-cards">
                  {items.map((mission) => {
                    const owner = resolveProfileMeta(mission.owner);
                    return (
                      <article
                        key={mission.id}
                        draggable
                        onDragStart={() => setDraggedId(mission.id)}
                        onDragEnd={() => setDraggedId("")}
                      >
                        <span>{mission.priority === "high" ? "HIGH PRIORITY" : mission.due}</span>
                        <strong>{mission.title}</strong>
                        <p>{mission.objective}</p>
                        <div className="kanban-progress"><i style={{ width: `${mission.progress}%` }} /></div>
                        <button type="button" onClick={() => onSelectAgent(mission.owner)}>
                          <span style={{ "--avatar": owner.color }}>{owner.initials}</span>
                          {owner.name}
                        </button>
                      </article>
                    );
                  })}
                  {!items.length && <div className="kanban-empty">여기로 카드를 이동하세요</div>}
                </div>
              </section>
            );
          })}
        </div>
        <footer>카드를 드래그해 상태를 변경할 수 있습니다.</footer>
      </section>
    </div>
  );
}

function MeetingRoom({ profiles, onClose, onStartMeeting }) {
  const participants = profiles;
  const usesExpandedLayout = participants.length > 9;
  const [selected, setSelected] = useState(() => new Set(
    participants
      .map((profile) => profile.name)
      .filter((name) => name === "default" || name === "hermes-operations"),
  ));
  const [topic, setTopic] = useState("이번 주 핵심 업무와 병목 점검");
  const dialogRef = useModalFocus(true, onClose);

  const toggle = (name) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="rpg-modal-backdrop meeting-backdrop" onMouseDown={onClose}>
      <section ref={dialogRef} className="rpg-meeting-modal" role="dialog" aria-modal="true" aria-labelledby="meeting-room-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>AI TEAM MEETING</span><h2 id="meeting-room-title">새 회의 만들기</h2></div>
          <button type="button" onClick={onClose}>나가기</button>
        </header>
        <div className="meeting-setup-guide">
          <span><b>1</b> 안건 입력</span>
          <span><b>2</b> 참가자 선택</span>
          <span><b>3</b> 실시간 발언 관전</span>
          <span><b>4</b> 회의록 자동 정리</span>
        </div>
        <div className="meeting-stage">
          <div className="meeting-topic">
            <small>MEETING TOPIC</small>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} />
          </div>
          <div className={`meeting-desk ${usesExpandedLayout ? "expanded" : ""}`}>
            <strong>{OFFICE_BRAND_NAME}</strong>
            {participants.map((profile, index) => {
              const meta = resolveProfileMeta(profile);
              return (
                <button
                  type="button"
                  key={profile.name}
                  className={`meeting-seat ${usesExpandedLayout ? "dynamic" : `seat-${index + 1}`} ${selected.has(profile.name) ? "selected" : ""}`}
                  onClick={() => toggle(profile.name)}
                >
                  <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
                  <b>{meta.name}</b>
                </button>
              );
            })}
          </div>
        </div>
        <footer>
          <span><b>{selected.size}명</b> 참여 · 순차 발언 후 주담당자 종합</span>
          <button
            type="button"
            disabled={!topic.trim() || selected.size === 0}
            onClick={() => onStartMeeting(topic, [...selected])}
          >
            Hermes 회의 시작
          </button>
        </footer>
      </section>
    </div>
  );
}

const OFFICE_SCENE_IMAGE = "/agent-office-open-topdown-v1.png";
const OFFICE_AGENT_ATLAS = "/agents/pixel-agent-atlas-v1.png";
const OFFICE_AGENT_ATLAS_CELL = { width: 128, height: 160 };
const OFFICE_RENDER_INTERVAL_MS = 1000 / 65;
const OFFICE_MAX_DELTA_SECONDS = 0.05;
const OFFICE_AGENT_SPEED = 9.8;
const OFFICE_MEETING_SPEED = 12.4;
const OFFICE_USER_SPEED = 16.5;
const OFFICE_AGENT_SPRITE_ROWS = {
  default: 0,
  "hermes-operations": 1,
  "hermes-brand": 2,
  "hermes-growth": 3,
  "hermes-content": 4,
  "hermes-creative": 5,
  "hermes-customer": 6,
  "hermes-finance": 7,
  "hermes-technology": 8,
};

// Foreground furniture is redrawn after the people layer so characters pass
// behind desks, sofas, and planters instead of floating above the floor plan.
const OFFICE_SCENE_OCCLUDERS = [
  { x: 41.6, y: 52.0, w: 12.0, h: 8.5 },
  { x: 42.0, y: 56.4, w: 15.2, h: 6.0 },
  { x: 65.7, y: 53.4, w: 13.3, h: 6.3 },
  { x: 90.6, y: 31.8, w: 7.2, h: 8.2 },
  { x: 90.6, y: 43.5, w: 7.2, h: 8.0 },
  { x: 90.6, y: 55.0, w: 7.2, h: 8.1 },
  { x: 3.2, y: 88.4, w: 35.1, h: 8.5 },
];

const clampSceneValue = (value, min, max) => Math.min(max, Math.max(min, value));

function stableSceneNumber(value) {
  let hash = 0;
  for (const character of String(value)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function roundedSceneRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

function drawScenePerson(context, person, sceneWidth, timestamp, emphasized = false, atlasImage = null) {
  const baseSize = clampSceneValue(sceneWidth * 0.016, 15, 25);
  const size = person.isUser ? baseSize * 1.03 : baseSize;
  const bob = person.moving
    ? Math.sin(timestamp / 82 + person.phase) * size * 0.075
    : Math.sin(timestamp / 620 + person.phase) * size * 0.022;
  const x = person.x;
  const y = person.y + bob;

  context.save();
  context.translate(x, y);
  context.globalAlpha = 0.25;
  context.filter = `blur(${Math.max(1.1, size * 0.08)}px)`;
  context.fillStyle = "#26352f";
  context.beginPath();
  context.ellipse(0, size * 0.43, size * 0.58, size * 0.23, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  if (emphasized || person.isUser) {
    const pulse = 1 + Math.sin(timestamp / 260) * 0.05;
    context.save();
    context.translate(x, y);
    context.strokeStyle = person.isUser ? "rgba(230, 103, 70, .9)" : "rgba(35, 98, 73, .88)";
    context.lineWidth = Math.max(1.5, size * 0.1);
    context.beginPath();
    context.ellipse(0, size * 0.36, size * 0.78 * pulse, size * 0.42 * pulse, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  if (atlasImage) {
    const frame = person.moving ? Math.floor(timestamp / 145 + person.phase) % 2 : 0;
    const column = (person.facing ?? 0) * 2 + frame;
    const spriteHeight = clampSceneValue(sceneWidth * 0.043, 42, 66);
    const spriteWidth = spriteHeight * (OFFICE_AGENT_ATLAS_CELL.width / OFFICE_AGENT_ATLAS_CELL.height);
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(
      atlasImage,
      column * OFFICE_AGENT_ATLAS_CELL.width,
      person.spriteRow * OFFICE_AGENT_ATLAS_CELL.height,
      OFFICE_AGENT_ATLAS_CELL.width,
      OFFICE_AGENT_ATLAS_CELL.height,
      x - spriteWidth / 2,
      y - spriteHeight * 0.78,
      spriteWidth,
      spriteHeight,
    );
    context.restore();
    return;
  }

  context.save();
  context.translate(x, y);
  context.rotate(person.angle);

  const stride = person.moving ? Math.sin(timestamp / 82 + person.phase) * size * 0.18 : 0;
  context.lineCap = "round";
  context.lineWidth = size * 0.2;
  context.strokeStyle = "#29332f";
  context.beginPath();
  context.moveTo(-size * 0.17, size * 0.26);
  context.lineTo(-size * 0.2 + stride, size * 0.67);
  context.moveTo(size * 0.17, size * 0.26);
  context.lineTo(size * 0.2 - stride, size * 0.67);
  context.stroke();

  context.lineWidth = size * 0.12;
  context.strokeStyle = "#141a18";
  context.beginPath();
  context.moveTo(-size * 0.2 + stride, size * 0.67);
  context.lineTo(-size * 0.17 + stride, size * 0.76);
  context.moveTo(size * 0.2 - stride, size * 0.67);
  context.lineTo(size * 0.17 - stride, size * 0.76);
  context.stroke();

  const torsoGradient = context.createLinearGradient(-size * 0.45, -size * 0.2, size * 0.45, size * 0.46);
  torsoGradient.addColorStop(0, "rgba(255,255,255,.28)");
  torsoGradient.addColorStop(0.35, person.color);
  torsoGradient.addColorStop(1, person.color);
  context.fillStyle = torsoGradient;
  roundedSceneRect(context, -size * 0.42, -size * 0.19, size * 0.84, size * 0.72, size * 0.27);
  context.fill();

  context.lineWidth = size * 0.16;
  context.strokeStyle = person.skin;
  context.beginPath();
  context.moveTo(-size * 0.36, -size * 0.02);
  context.lineTo(-size * 0.56, size * 0.27 - stride * 0.28);
  context.moveTo(size * 0.36, -size * 0.02);
  context.lineTo(size * 0.56, size * 0.27 + stride * 0.28);
  context.stroke();

  const headGradient = context.createRadialGradient(-size * 0.12, -size * 0.48, size * 0.05, 0, -size * 0.38, size * 0.42);
  headGradient.addColorStop(0, "#ffe0c3");
  headGradient.addColorStop(1, person.skin);
  context.fillStyle = headGradient;
  context.beginPath();
  context.ellipse(0, -size * 0.38, size * 0.34, size * 0.38, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = person.hair;
  context.beginPath();
  context.arc(0, -size * 0.43, size * 0.35, Math.PI * 1.03, Math.PI * 1.97);
  context.quadraticCurveTo(size * 0.18, -size * 0.83, 0, -size * 0.77);
  context.quadraticCurveTo(-size * 0.2, -size * 0.82, -size * 0.34, -size * 0.5);
  context.fill();
  context.restore();
}

function drawSceneLabel(context, person, sceneWidth, selected = false) {
  const fontSize = clampSceneValue(sceneWidth * 0.0073, 8, 11);
  const label = person.isUser ? "내 위치" : person.name;
  context.save();
  context.font = `${selected || person.isUser ? 800 : 700} ${fontSize}px Pretendard, Inter, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const width = context.measureText(label).width + fontSize * 1.45;
  const height = fontSize * 1.65;
  const x = person.x - width / 2;
  const y = person.y + clampSceneValue(sceneWidth * 0.021, 22, 34);
  context.shadowColor = "rgba(29, 44, 37, .18)";
  context.shadowBlur = 4;
  context.shadowOffsetY = 2;
  context.fillStyle = selected || person.isUser ? "rgba(34, 57, 47, .94)" : "rgba(255, 255, 255, .92)";
  roundedSceneRect(context, x, y, width, height, height / 2);
  context.fill();
  context.shadowColor = "transparent";
  context.fillStyle = selected || person.isUser ? "#fff" : "#2a3c34";
  context.fillText(label, person.x, y + height / 2 + 0.3);

  if (!person.isUser) {
    context.fillStyle = person.online ? "#36a66b" : "#8a948f";
    context.strokeStyle = "#fff";
    context.lineWidth = 1.3;
    context.beginPath();
    context.arc(x + width - fontSize * 0.35, y + height * 0.18, Math.max(2.5, fontSize * 0.28), 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function OfficeSceneCanvas({
  profiles,
  placements,
  agentActivities,
  meetingSeats,
  userMarker,
  selectedAgent,
  hoveredAgent,
}) {
  const mapCanvasRef = useRef(null);
  const canvasRef = useRef(null);
  const sceneRef = useRef({});
  const spriteRef = useRef(new Map());

  useEffect(() => {
    sceneRef.current = {
      profiles,
      placements,
      agentActivities,
      meetingSeats,
      userMarker,
      selectedAgent,
      hoveredAgent,
    };
  }, [
    agentActivities,
    hoveredAgent,
    meetingSeats,
    placements,
    profiles,
    selectedAgent,
    userMarker,
  ]);

  useEffect(() => {
    const mapCanvas = mapCanvasRef.current;
    const canvas = canvasRef.current;
    if (!mapCanvas || !canvas) return undefined;
    const mapContext = mapCanvas.getContext("2d", { alpha: false });
    const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    const mapImage = new Image();
    const atlasImage = new Image();
    mapImage.decoding = "async";
    atlasImage.decoding = "async";
    let imageReady = false;
    let atlasReady = false;
    let frame = 0;
    let lastFrame = 0;
    let lastTimestamp = performance.now();
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let renderedFrames = 0;
    let fpsWindowStartedAt = lastTimestamp;

    const renderStaticMap = () => {
      if (!width || !height) return;
      mapContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      mapContext.imageSmoothingEnabled = true;
      mapContext.imageSmoothingQuality = "high";
      mapContext.fillStyle = "#e9e7e1";
      mapContext.fillRect(0, 0, width, height);
      if (imageReady) mapContext.drawImage(mapImage, 0, 0, width, height);
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, bounds.width);
      const nextHeight = Math.max(1, bounds.height);
      const nextRatio = Math.min(2, window.devicePixelRatio || 1);
      if (nextWidth === width && nextHeight === height && nextRatio === pixelRatio) return;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextRatio;
      mapCanvas.width = Math.round(width * pixelRatio);
      mapCanvas.height = Math.round(height * pixelRatio);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      renderStaticMap();
    };

    const syncPerson = (id, targetMarker, speed, timestamp, deltaSeconds, allowPatrol = false) => {
      const safeTarget = nearestOfficeWalkablePoint(targetMarker);
      const targetKey = safeTarget.join(":");
      const current = spriteRef.current.get(id) ?? {
        xPercent: safeTarget[0],
        yPercent: safeTarget[1],
        angle: 0,
        facing: 0,
        path: [],
        targetKey,
        home: safeTarget,
        nextPatrolAt: timestamp + 3200 + stableSceneNumber(id) % 4200,
        phase: (stableSceneNumber(id) % 628) / 100,
      };
      if (current.targetKey !== targetKey) {
        current.home = safeTarget;
        current.targetKey = targetKey;
        current.patrolAway = false;
        current.path = findOfficePath([current.xPercent, current.yPercent], safeTarget).slice(1);
        current.nextPatrolAt = timestamp + 5000 + stableSceneNumber(id) % 4000;
      }

      if (!current.path.length && current.patrolAway && timestamp >= current.returnAt) {
        current.path = findOfficePath([current.xPercent, current.yPercent], current.home).slice(1);
        current.patrolAway = false;
        current.nextPatrolAt = timestamp + 9000 + stableSceneNumber(`${id}:return`) % 6000;
      }

      if (!current.path.length && !current.patrolAway && allowPatrol && timestamp >= current.nextPatrolAt) {
        const patrolOffsets = [
          [-1.5, 0],
          [1.5, 0],
          [0, -1.45],
          [0, 1.45],
          [-1.1, 1.1],
          [1.1, -1.1],
        ];
        const cycle = Math.floor(timestamp / 5000);
        const offset = patrolOffsets[(stableSceneNumber(id) + cycle) % patrolOffsets.length];
        const patrolTarget = nearestOfficeWalkablePoint([
          current.home[0] + offset[0],
          current.home[1] + offset[1],
        ]);
        const patrolPath = findOfficePath([current.xPercent, current.yPercent], patrolTarget);
        if (patrolPath.length > 1 && Math.hypot(
          patrolTarget[0] - current.xPercent,
          patrolTarget[1] - current.yPercent,
        ) > 0.45) {
          current.path = patrolPath.slice(1);
          current.patrolAway = true;
          current.returnAt = timestamp + 2100;
        } else {
          current.nextPatrolAt = timestamp + 5000;
        }
      }

      const waypoint = current.path[0];
      if (waypoint) {
        const dx = waypoint[0] - current.xPercent;
        const dy = waypoint[1] - current.yPercent;
        const screenDx = dx / 100 * width;
        const screenDy = dy / 100 * height;
        if (Math.hypot(screenDx, screenDy) > 0.001) {
          const next = advanceOfficePoint(
            [current.xPercent, current.yPercent],
            waypoint,
            speed,
            deltaSeconds,
            { width, height },
          );
          current.xPercent = next[0];
          current.yPercent = next[1];
          current.angle = Math.atan2(screenDy, screenDx) + Math.PI / 2;
          current.facing = Math.abs(screenDx) > Math.abs(screenDy)
            ? (dx > 0 ? 3 : 1)
            : (dy > 0 ? 0 : 2);
        }
        const remainingPixels = Math.hypot(
          (waypoint[0] - current.xPercent) / 100 * width,
          (waypoint[1] - current.yPercent) / 100 * height,
        );
        if (remainingPixels <= 0.1) {
          current.xPercent = waypoint[0];
          current.yPercent = waypoint[1];
          current.path.shift();
        }
      }
      current.moving = Boolean(current.path.length || waypoint);
      current.x = current.xPercent / 100 * width;
      current.y = current.yPercent / 100 * height;
      spriteRef.current.set(id, current);
      return current;
    };

    const drawFrame = (timestamp) => {
      frame = window.requestAnimationFrame(drawFrame);
      const frameElapsed = timestamp - lastFrame;
      if (frameElapsed < OFFICE_RENDER_INTERVAL_MS) return;
      lastFrame = timestamp - (frameElapsed % OFFICE_RENDER_INTERVAL_MS);
      const deltaSeconds = Math.min(
        OFFICE_MAX_DELTA_SECONDS,
        Math.max(0.001, (timestamp - lastTimestamp) / 1000),
      );
      resize();
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const scene = sceneRef.current;
      const people = (scene.profiles ?? []).map((profile) => {
        const meta = resolveProfileMeta(profile);
        const activity = scene.agentActivities?.[profile.name];
        const meetingSeat = activity?.state === "meeting" ? scene.meetingSeats?.[profile.name] : null;
        const placement = scene.placements?.[profile.name];
        const targetMarker = [
          meetingSeat?.[0] ?? placement?.x ?? 50,
          meetingSeat?.[1] ?? placement?.y ?? 50,
        ];
        const position = syncPerson(
          profile.name,
          targetMarker,
          activity?.state === "meeting" ? OFFICE_MEETING_SPEED : OFFICE_AGENT_SPEED,
          timestamp,
          deltaSeconds,
          Boolean(profile.gateway_running) && activity?.state !== "meeting",
        );
        const skinTones = ["#d5a176", "#e2b48c", "#c88f68", "#edc39d"];
        return {
          ...position,
          id: profile.name,
          name: meta.name,
          spriteRow: OFFICE_AGENT_SPRITE_ROWS[profile.name] ?? stableSceneNumber(profile.name) % 9,
          color: meta.color,
          hair: ["#1c201f", "#34251e", "#26201e"][stableSceneNumber(profile.name) % 3],
          skin: skinTones[stableSceneNumber(profile.name) % skinTones.length],
          online: Boolean(profile.gateway_running),
        };
      });

      if (scene.userMarker) {
        const userPosition = syncPerson(
          "__office-user__",
          scene.userMarker,
          OFFICE_USER_SPEED,
          timestamp,
          deltaSeconds,
        );
        people.push({
          ...userPosition,
          id: "__office-user__",
          name: "내 위치",
          color: "#e56f4c",
          hair: "#24201e",
          skin: "#e0aa80",
          online: true,
          isUser: true,
          spriteRow: 5,
        });
      }

      people.sort((left, right) => left.y - right.y);
      canvas.dataset.mapReady = String(imageReady);
      canvas.dataset.atlasReady = String(atlasReady);
      canvas.dataset.walkingAgents = String(people.filter((person) => person.moving).length);
      canvas.dataset.collisionSafe = String(people.every((person) => (
        isOfficePointWalkable([person.xPercent, person.yPercent])
      )));
      renderedFrames += 1;
      if (timestamp - fpsWindowStartedAt >= 1000) {
        canvas.dataset.motionFps = String(Math.round(
          renderedFrames * 1000 / (timestamp - fpsWindowStartedAt),
        ));
        renderedFrames = 0;
        fpsWindowStartedAt = timestamp;
      }
      canvas.dataset.motionModel = "frame-independent";
      people.forEach((person) => {
        const emphasized = person.id === scene.selectedAgent || person.id === scene.hoveredAgent;
        drawScenePerson(context, person, width, timestamp, emphasized, atlasReady ? atlasImage : null);
      });

      if (imageReady) {
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        OFFICE_SCENE_OCCLUDERS.forEach((occluder) => {
          context.drawImage(
            mapImage,
            occluder.x / 100 * mapImage.naturalWidth,
            occluder.y / 100 * mapImage.naturalHeight,
            occluder.w / 100 * mapImage.naturalWidth,
            occluder.h / 100 * mapImage.naturalHeight,
            occluder.x / 100 * width,
            occluder.y / 100 * height,
            occluder.w / 100 * width,
            occluder.h / 100 * height,
          );
        });
      }

      people.forEach((person) => {
        drawSceneLabel(
          context,
          person,
          width,
          person.id === scene.selectedAgent || person.id === scene.hoveredAgent,
        );
      });
      lastTimestamp = timestamp;
    };

    mapImage.addEventListener("load", () => {
      imageReady = true;
      renderStaticMap();
    }, { once: true });
    atlasImage.addEventListener("load", () => {
      atlasReady = true;
    }, { once: true });
    mapImage.src = OFFICE_SCENE_IMAGE;
    atlasImage.src = OFFICE_AGENT_ATLAS;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = window.requestAnimationFrame(drawFrame);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      mapImage.src = "";
      atlasImage.src = "";
    };
  }, []);

  return (
    <>
      <canvas
        ref={mapCanvasRef}
        className="office-scene-map-canvas"
        aria-hidden="true"
      />
      <canvas
        ref={canvasRef}
        className="office-scene-canvas"
        data-user-x={userMarker?.[0] ?? ""}
        data-user-y={userMarker?.[1] ?? ""}
        aria-hidden="true"
      />
    </>
  );
}

function LiveOfficeMap({
  profiles,
  missions,
  agentActivities,
  roomAssignments,
  roomFocus,
  selectedAgent,
  onFocusRoom,
  onOpenRoom,
  onSelectAgent,
}) {
  const mapRef = useRef(null);
  const [localRoom, setLocalRoom] = useState("");
  const [userOverride, setUserOverride] = useState(null);
  const [travelPath, setTravelPath] = useState([]);
  const [hoveredAgent, setHoveredAgent] = useState("");
  const teamProfiles = profiles;
  const placements = useMemo(
    () => buildOfficeAgentPlacements(teamProfiles, OFFICE_FLOOR_ZONES, ROOMS, roomAssignments),
    [roomAssignments, teamProfiles],
  );
  const meetingProfiles = useMemo(
    () => teamProfiles.filter((profile) => agentActivities[profile.name]?.state === "meeting"),
    [agentActivities, teamProfiles],
  );
  const meetingHasOverflow = meetingProfiles.length > 5;
  const visibleMeetingProfiles = useMemo(() => meetingProfiles.slice(0, meetingProfiles.length > 5 ? 4 : 5), [meetingProfiles]);
  const visibleProfileIds = useMemo(() => new Set(visibleMeetingProfiles.map((profile) => profile.name)), [visibleMeetingProfiles]);
  const meetingLayoutProfiles = useMemo(
    () => meetingHasOverflow ? [...visibleMeetingProfiles, { name: "__meeting-overflow__" }] : visibleMeetingProfiles,
    [meetingHasOverflow, visibleMeetingProfiles],
  );
  const meetingSeats = useMemo(() => buildMeetingSeatPlacements(meetingLayoutProfiles), [meetingLayoutProfiles]);
  const meetingOverflowSeat = meetingSeats["__meeting-overflow__"];
  const mapProfiles = useMemo(
    () => teamProfiles.filter((profile) => agentActivities[profile.name]?.state !== "meeting" || visibleProfileIds.has(profile.name)),
    [agentActivities, teamProfiles, visibleProfileIds],
  );

  const activeRoomId = roomFocus || localRoom;
  const focusedRoom = OFFICE_FLOOR_ZONES.find((zone) => zone.id === activeRoomId) ?? null;
  const userTarget = focusedRoom ?? OFFICE_USER_HOME;
  const activeUserOverride = userOverride?.roomId === activeRoomId ? userOverride : null;
  const userMarker = activeUserOverride?.marker ?? userTarget.marker;
  const userLabel = activeUserOverride?.label ?? userTarget.label;

  useEffect(() => {
    if (!travelPath.length) return undefined;
    const timer = window.setTimeout(() => {
      const [next, ...remaining] = travelPath;
      setUserOverride({
        roomId: activeRoomId,
        marker: next,
        label: remaining.length ? "이동 중" : "현재 위치",
      });
      setTravelPath(remaining);
    }, 55);
    return () => window.clearTimeout(timer);
  }, [activeRoomId, travelPath]);

  const onMapKeyDown = (event) => {
      if (event.target !== mapRef.current) return;
      const step = event.shiftKey ? 4.2 : 1.9;
      const deltas = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      setTravelPath([]);
      setUserOverride((previous) => {
        const currentMarker = previous?.roomId === activeRoomId ? previous.marker : userTarget.marker;
        return {
          roomId: activeRoomId,
          marker: moveOfficePoint(currentMarker, delta),
          label: "직접 이동",
        };
      });
  };

  const enterRoom = (zone) => {
    setLocalRoom(zone.id);
    setUserOverride(null);
    setTravelPath([]);
    onFocusRoom(zone.id);
    const room = ROOMS.find((item) => item.id === zone.id) ?? zone;
    onOpenRoom?.(room);
  };

  const pointFromMapEvent = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) / bounds.width) * 100,
      ((event.clientY - bounds.top) / bounds.height) * 100,
    ];
  };

  const moveToPoint = (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.(".floor-room, .floor-agent, .floor-user-marker, .floor-meeting-roster")) return;
    mapRef.current?.focus({ preventScroll: true });
    const marker = nearestOfficeWalkablePoint(pointFromMapEvent(event));
    const path = findOfficePath(userMarker, marker);
    if (path.length < 2) return;
    setUserOverride({ roomId: activeRoomId, marker: path[0], label: "이동 중" });
    setTravelPath(path.slice(1));
  };

  const openRoomAtPoint = (event) => {
    if (event.button !== 0) return;
    const [x, y] = pointFromMapEvent(event);
    const zone = OFFICE_FLOOR_ZONES.find((candidate) => (
      x >= candidate.x
      && x <= candidate.x + candidate.w
      && y >= candidate.y
      && y <= candidate.y + candidate.h
    ));
    if (zone) enterRoom(zone);
  };

  return (
    <section className="floorplan-card">
      <div className="floorplan-stage" role="group" aria-label="Hermes 팀의 평면도형 오피스 지도">
        <div
          ref={mapRef}
          className="floorplan-building isometric-office"
          onPointerDown={moveToPoint}
          onDoubleClick={openRoomAtPoint}
          onKeyDown={onMapKeyDown}
          tabIndex={0}
          role="application"
          aria-label="오피스맵. 한 번 클릭하거나 방향키로 이동하고, 공간을 두 번 클릭하거나 구성원을 선택해 상세 기능을 엽니다."
        >
          <OfficeSceneCanvas
            profiles={mapProfiles}
            placements={placements}
            agentActivities={agentActivities}
            meetingSeats={meetingSeats}
            userMarker={userMarker}
            selectedAgent={selectedAgent}
            hoveredAgent={hoveredAgent}
          />

          {OFFICE_FLOOR_ZONES.map((zone) => {
          const isFocused = focusedRoom?.id === zone.id;
          const roomProfiles = mapProfiles.filter((profile) => {
            const activity = agentActivities[profile.name];
            const placement = placements[profile.name];
            return (activity?.state === "meeting" ? "meeting" : placement?.roomId) === zone.id;
          });
          const hasLiveWork = roomProfiles.some((profile) => {
            const activity = agentActivities[profile.name];
            return activity?.state === "working" || activity?.state === "meeting" || Boolean(activity?.view?.url);
          });
          return (
            <button
              type="button"
              key={zone.id}
              className={`floor-room map-zone ${zone.tone} ${roomProfiles.length ? "occupied" : ""} ${hasLiveWork ? "active-work" : ""} ${isFocused ? "focused" : ""}`}
              style={{
                "--zone-x": `${zone.x}%`,
                "--zone-y": `${zone.y}%`,
                "--zone-w": `${zone.w}%`,
                "--zone-h": `${zone.h}%`,
              }}
              onClick={() => enterRoom(zone)}
              aria-label={`${zone.label} 영역 열기`}
            >
              <span className="sr-only">{zone.label}</span>
            </button>
          );
        })}

        {mapProfiles.map((profile) => {
          const meta = resolveProfileMeta(profile);
          const placement = placements[profile.name];
          const activity = agentActivities[profile.name];
          const meetingSeat = activity?.state === "meeting" ? meetingSeats[profile.name] : null;
          const displayX = meetingSeat?.[0] ?? placement?.x ?? 50;
          const displayY = meetingSeat?.[1] ?? placement?.y ?? 50;
          const roomLabel = OFFICE_FLOOR_ZONES.find((zone) => zone.id === (meetingSeat ? "meeting" : placement?.roomId))?.label ?? "오피스";
          const status = activity?.state === "meeting"
            ? "회의 중"
            : activity?.view?.url
              ? "화면 공유"
              : missions.some((mission) => mission.owner === profile.name && mission.status === "working")
                ? "작업 중"
                : profile.gateway_running
                  ? "대기"
                  : "오프라인";
          return (
            <button
              type="button"
              key={profile.name}
              className={`floor-agent scene-hit-target ${selectedAgent === profile.name ? "selected" : ""} ${activity?.state === "meeting" ? "meeting" : ""}`}
              style={{
                "--agent-x": `${displayX}%`,
                "--agent-y": `${displayY}%`,
                "--avatar": meta.color,
              }}
              onClick={() => onSelectAgent(profile.name)}
              onMouseEnter={() => setHoveredAgent(profile.name)}
              onMouseLeave={() => setHoveredAgent("")}
              onFocus={() => setHoveredAgent(profile.name)}
              onBlur={() => setHoveredAgent("")}
              aria-label={`${meta.name} · ${roomLabel} · 콘솔 열기`}
            >
              <span className="sr-only">{meta.name} · {status}</span>
            </button>
          );
        })}

        {meetingHasOverflow && meetingOverflowSeat && (
          <details
            className="floor-meeting-roster"
            style={{ "--agent-x": `${meetingOverflowSeat[0]}%`, "--agent-y": `${meetingOverflowSeat[1]}%` }}
          >
            <summary aria-label={`회의 참가자 ${meetingProfiles.length}명 전체 목록`}>
              +{meetingProfiles.length - visibleMeetingProfiles.length}
            </summary>
            <div>
              <strong>회의 참가자 · {meetingProfiles.length}명</strong>
              <ul aria-label="전체 회의 참가자">
                {meetingProfiles.map((profile) => <li key={profile.name}><button type="button" onClick={() => onSelectAgent(profile.name)}>{resolveProfileMeta(profile).name}</button></li>)}
              </ul>
            </div>
          </details>
        )}

        {userMarker && <span className="sr-only" aria-live="polite">내 위치 · {userLabel}</span>}

        </div>
      </div>
    </section>
  );
}

function InterventionPanel({ missions, approvals, onOpenOfficePanel }) {
  const workingMissions = missions.filter((mission) => mission.status !== "done").slice(0, 4);
  const todayItems = [
    ...approvals.slice(0, 2).map((approval) => ({
      id: approval.id,
      title: approval.title,
      meta: approval.requester ? resolveProfileMeta(approval.requester).name : "검토",
      type: "approvals",
    })),
    ...workingMissions.slice(0, 3).map((mission) => ({
      id: mission.id,
      title: mission.title,
      meta: resolveProfileMeta(mission.owner).name,
      type: "today",
    })),
  ].slice(0, 3);

  return (
    <aside className="command-intervention-panel">
      <section>
        <div className="command-panel-heading">
          <strong>오늘 확인할 일</strong>
          <b>{todayItems.length}</b>
        </div>
        <div className="command-action-list">
          {todayItems.map((item) => (
            <button type="button" key={item.id} onClick={() => onOpenOfficePanel({ type: item.type, focusId: item.id })}>
              <i />
              <strong>{item.title}</strong>
              <span>{item.meta}</span>
            </button>
          ))}
          {!todayItems.length && (
            <button type="button" onClick={() => onOpenOfficePanel({ type: "work" })}>
              <i />
              <strong>진행 업무를 확인하세요</strong>
              <span>업무 보드</span>
            </button>
          )}
        </div>
      </section>
      <section>
        <div className="command-panel-heading">
          <strong>진행 중 업무</strong>
          <b>{workingMissions.length}</b>
        </div>
        <div className="command-work-summary">
          {["브랜드/기획", "콘텐츠 제작", "운영/관리", "고객/지원", "재무/회계"].map((label, index) => (
            <button type="button" key={label} onClick={() => onOpenOfficePanel({ type: "work", filter: label })}>
              <i />
              <span>{label}</span>
              <b>{Math.max(1, workingMissions.filter((_, itemIndex) => itemIndex % 5 === index).length)}</b>
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className="command-panel-heading">
          <strong>승인 대기</strong>
          <b>{approvals.length}</b>
        </div>
        <div className="command-approval-list">
          {(approvals.length ? approvals : workingMissions.slice(0, 3)).map((item) => {
            const ownerName = resolveProfileMeta(item.requester ?? item.owner).name;
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => onOpenOfficePanel({ type: approvals.length ? "approvals" : "work", focusId: item.id })}
              >
                <i />
                <span><strong>{item.title}</strong><small>{ownerName}</small></span>
                <em>{item.risk ?? (item.priority === "high" ? "긴급" : "보통")}</em>
              </button>
            );
          })}
        </div>
      </section>
    </aside>
  );
}

function OfficeInsightModal({ panel, missions, approvals, onClose, onSelectAgent, onApprovalDecision }) {
  const dialogRef = useModalFocus(true, onClose);
  const workingMissions = missions.filter((mission) => mission.status !== "done");
  const focusMission = workingMissions.find((mission) => mission.id === panel?.focusId);
  const focusApproval = approvals.find((approval) => approval.id === panel?.focusId);
  const visibleMissions = focusMission ? [focusMission] : workingMissions.slice(0, 8);
  const visibleApprovals = focusApproval ? [focusApproval] : approvals.slice(0, 8);
  const heading = panel?.type === "approvals"
    ? ["승인 대기", "오피스 화면을 벗어나지 않고 검토와 결정을 처리합니다."]
    : panel?.type === "work"
      ? ["진행 중 업무", "업무별 담당자, 진행률, 다음 액션을 한 자리에서 확인합니다."]
      : ["오늘 확인할 일", "오늘 놓치면 안 되는 승인과 진행 업무를 모았습니다."];

  return (
    <div className="office-insight-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="office-insight-modal" role="dialog" aria-modal="true" aria-label={heading[0]} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>OFFICE INSPECTOR</span>
            <h3>{heading[0]}</h3>
            <p>{heading[1]}</p>
          </div>
          <button type="button" onClick={onClose}>닫기</button>
        </header>
        <div className="office-insight-body">
          {(panel?.type === "today" || panel?.type === "approvals") && (
            <section>
              <strong>승인 항목</strong>
              {visibleApprovals.length ? visibleApprovals.map((approval) => {
                const requester = resolveProfileMeta(approval.requester ?? "default");
                return (
                  <article className="office-insight-card approval" key={approval.id}>
                    <small>{requester.name}</small>
                    <h4>{approval.title}</h4>
                    <p>{approval.description ?? approval.reason ?? "검토가 필요한 승인 요청입니다."}</p>
                    <div>
                      <button type="button" onClick={() => onApprovalDecision?.(approval.id, "approved")}>승인</button>
                      <button type="button" onClick={() => onApprovalDecision?.(approval.id, "rejected")}>보류</button>
                    </div>
                  </article>
                );
              }) : <p className="office-insight-empty">현재 승인 대기 항목이 없습니다.</p>}
            </section>
          )}

          {(panel?.type === "today" || panel?.type === "work") && (
            <section>
              <strong>진행 업무</strong>
              {visibleMissions.length ? visibleMissions.map((mission) => {
                const owner = resolveProfileMeta(mission.owner);
                return (
                  <article className="office-insight-card mission" key={mission.id}>
                    <small>{owner.name} · {mission.status}</small>
                    <h4>{mission.title}</h4>
                    <p>{mission.description ?? "담당자의 작업 상태를 확인하고 바로 대화를 이어갈 수 있습니다."}</p>
                    <div className="office-insight-progress"><i style={{ width: `${Math.min(100, Math.max(0, mission.progress ?? 0))}%` }} /></div>
                    <footer>
                      <span>{mission.progress ?? 0}%</span>
                      <button type="button" onClick={() => onSelectAgent(mission.owner)}>담당자 보기</button>
                    </footer>
                  </article>
                );
              }) : <p className="office-insight-empty">진행 중인 업무가 없습니다.</p>}
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

export default function HermesOffice({
  workspace,
  missions,
  approvals,
  focusedRoom,
  focusedRoomContext,
  onOpenCommand,
  onStartChat,
  onMoveMission,
  onApprovalDecision,
  agentActivities = {},
  onActivityChange,
  onStartMeeting,
  onOpenKanban,
  onOpenData,
  onGovernanceApprovalRequest,
  hasActiveMeeting = false,
  onOpenActiveMeeting,
  roomAssignments = {},
}) {
  const profiles = useMemo(() => workspace?.profiles ?? [], [workspace?.profiles]);
  const officePlacements = useMemo(
    () => buildOfficeAgentPlacements(profiles, OFFICE_FLOOR_ZONES, ROOMS, roomAssignments),
    [profiles, roomAssignments],
  );
  const [selectedAgent, setSelectedAgent] = useState("");
  const [showMissionBoard, setShowMissionBoard] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);
  const [fullscreenLiveAgent, setFullscreenLiveAgent] = useState("");
  const [officeChatAgent, setOfficeChatAgent] = useState("");
  const [officePanel, setOfficePanel] = useState(null);
  const [officeLiveActivities, setOfficeLiveActivities] = useState({});
  const [officeLiveSessionIds, setOfficeLiveSessionIds] = useState({});
  const [officeLiveWorkspaces, setOfficeLiveWorkspaces] = useState({});
  const [officeLiveSelections, setOfficeLiveSelections] = useState({});
  const [roomFocus, setRoomFocus] = useState(focusedRoom ?? "");
  const activeMissions = missions.filter((mission) => mission.status === "working").length;
  const online = profiles.filter((profile) => profile.gateway_running).length;
  const sessions = useMemo(() => workspace?.sessions ?? [], [workspace?.sessions]);
  const observedLiveProfile = officeChatAgent || fullscreenLiveAgent || selectedAgent;
  const observedBaseActivity = observedLiveProfile ? agentActivities[observedLiveProfile] : null;
  const observedViewUrl = observedBaseActivity?.view?.url || "";
  const observedViewBrowserSessionId = observedBaseActivity?.view?.browserSessionId || "";
  const observedDurableSessionId = sessions.find((session) => session.profile === observedLiveProfile)?.id
    || officeLiveSessionIds[observedLiveProfile]
    || "";
  const observedLiveSessionId = observedDurableSessionId
    || observedBaseActivity?.view?.sessionId
    || "";
  // Prefer the persisted conversation id. Browser tools use it as their
  // isolation key, while view.sessionId can be only the current WS transport.
  const observedLiveScopeId = observedViewBrowserSessionId
    || observedDurableSessionId
    || observedBaseActivity?.view?.sessionId
    || "";
  const observedLiveSelection = officeLiveSelections[observedLiveProfile] ?? { followAgent: true, targetId: "" };

  useEffect(() => {
    if (!observedLiveProfile || observedLiveSessionId) return undefined;
    let stopped = false;
    loadProfileSessions(observedLiveProfile, 1, { includeMeetings: false })
      .then((profileSessions) => {
        const latestSessionId = profileSessions[0]?.id || "";
        if (!stopped && latestSessionId) {
          setOfficeLiveSessionIds((current) => ({ ...current, [observedLiveProfile]: latestSessionId }));
        }
      })
      .catch(() => {});
    return () => { stopped = true; };
  }, [observedLiveProfile, observedLiveSessionId]);

  useEffect(() => {
    if (!observedLiveProfile || !observedLiveScopeId) return undefined;
    let stopped = false;
    let timer = 0;
    const syncOfficeLiveScreen = async () => {
      try {
        const payload = await loadLiveScreen(
          observedLiveProfile,
          observedLiveScopeId,
          observedLiveSelection.followAgent ? "" : observedLiveSelection.targetId,
          observedViewUrl,
          observedLiveScopeId,
          true,
        );
        if (!stopped) {
          if (payload?.workspace) {
            setOfficeLiveWorkspaces((current) => ({ ...current, [observedLiveProfile]: payload.workspace }));
            setOfficeLiveSelections((current) => {
              const selection = current[observedLiveProfile];
              if (!selection || selection.followAgent || payload.workspace.tabs?.some((tab) => tab.targetId === selection.targetId)) return current;
              return { ...current, [observedLiveProfile]: { followAgent: true, targetId: "" } };
            });
          }
          setOfficeLiveActivities((current) => ({
            ...current,
            [observedLiveProfile]: payload?.activity?.view?.viewerSocketUrl ? payload.activity : null,
          }));
        }
      } catch {
        if (!stopped) {
          setOfficeLiveActivities((current) => ({ ...current, [observedLiveProfile]: null }));
        }
      } finally {
        if (!stopped) timer = window.setTimeout(syncOfficeLiveScreen, 1800);
      }
    };
    syncOfficeLiveScreen();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [observedLiveProfile, observedLiveScopeId, observedLiveSelection.followAgent, observedLiveSelection.targetId, observedViewUrl]);

  const selectOfficeLiveTarget = useCallback((profileName, targetId) => {
    if (!profileName || !targetId) return;
    setOfficeLiveSelections((current) => ({ ...current, [profileName]: { followAgent: false, targetId } }));
  }, []);
  const followOfficeLiveTarget = useCallback((profileName) => {
    if (!profileName) return;
    setOfficeLiveSelections((current) => ({ ...current, [profileName]: { followAgent: true, targetId: "" } }));
  }, []);

  const resolvedAgentActivities = useMemo(() => {
    const next = { ...agentActivities };
    for (const [profileName, activity] of Object.entries(officeLiveActivities)) {
      if (activity) next[profileName] = activity;
    }
    return next;
  }, [agentActivities, officeLiveActivities]);

  const liveSessionForProfile = useCallback((profileName) => (
    resolvedAgentActivities[profileName]?.view?.sessionId
    || sessions.find((session) => session.profile === profileName)?.id
    || officeLiveSessionIds[profileName]
    || ""
  ), [officeLiveSessionIds, resolvedAgentActivities, sessions]);

  const openMeetingFlow = useCallback(() => {
    if (hasActiveMeeting) {
      onOpenActiveMeeting?.();
      return;
    }
    setShowMeeting(true);
  }, [hasActiveMeeting, onOpenActiveMeeting]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedAgent("");
        setShowMissionBoard(false);
        setShowMeeting(false);
        setOfficeChatAgent("");
        setOfficePanel(null);
        setFullscreenLiveAgent("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectAgent = (profileName, options = {}) => {
    const placement = officePlacements[profileName];
    if (!options.preserveRoomFocus && placement?.roomId) {
      setRoomFocus(placement.roomId);
    }
    setSelectedAgent(profileName);
    setShowMissionBoard(false);
  };

  const openOfficeRoom = (room) => {
    setRoomFocus(room.id);
    if (room.id === "meeting") {
      openMeetingFlow();
      return;
    }
    if (room.id === "library") {
      onOpenData?.();
      return;
    }
    if (room.id === "control" || room.id === "desk") {
      setSelectedAgent("");
      setShowMissionBoard(false);
      return;
    }
    const profileName = room.profiles?.find((name) => profiles.some((profile) => profile.name === name))
      ?? profiles.find((profile) => officePlacements[profile.name]?.roomId === room.id)?.name;
    if (profileName) {
      selectAgent(profileName, { preserveRoomFocus: true });
      return;
    }
    onStartChat(room);
  };

  useEffect(() => {
    if (!focusedRoom) return;
    const timer = window.setTimeout(() => {
      const room = ROOMS.find((item) => item.id === focusedRoom);
      setRoomFocus(focusedRoom);
      if (focusedRoom === "meeting") {
        openMeetingFlow();
        return;
      }
      const profileName = focusedRoomContext?.owner ?? room?.profiles?.[0];
      if (profileName && profiles.some((profile) => profile.name === profileName)) {
        setSelectedAgent(profileName);
        setShowMissionBoard(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusedRoom, focusedRoomContext, openMeetingFlow, profiles]);

  const meetingRoom = ROOMS.find((room) => room.id === "meeting");

  return (
    <div className="rpg-office-shell command-office-shell">
      <div className="rpg-hud">
        <div className="rpg-office-title">
          <img src="/hermes-mark.svg" alt="" />
          <div><span>{OFFICE_BRAND_NAME.toUpperCase()}</span><strong>Hermes AI Office</strong></div>
        </div>
        <div className="hud-signals">
          <span className="connected"><i /> Hermes Connected</span>
          <span><b>{online}</b> agents online</span>
          <span><b>{activeMissions}</b> missions active</span>
        </div>
        <div className="hud-actions">
          <button type="button" onClick={openMeetingFlow}>회의실</button>
          <button type="button" className={approvals.length ? "attention" : ""} onClick={onOpenCommand}>
            승인 {approvals.length}
          </button>
          <button type="button" onClick={onOpenKanban}>업무 보드</button>
        </div>
      </div>

      <MobileOfficeHome
        profiles={profiles}
        missions={missions}
        approvals={approvals}
        agentActivities={resolvedAgentActivities}
        online={online}
        activeMissions={activeMissions}
        onOpenCommand={onOpenCommand}
        onOpenKanban={onOpenKanban}
        onOpenMeeting={openMeetingFlow}
        onSelectAgent={selectAgent}
        onOpenChatDock={setOfficeChatAgent}
        onOpenRoom={openOfficeRoom}
      />

      <main className="command-office-workbench">
        <div className="command-office-main">
          <LiveOfficeMap
            profiles={profiles}
            missions={missions}
            agentActivities={resolvedAgentActivities}
            roomAssignments={roomAssignments}
            roomFocus={roomFocus}
            selectedAgent={selectedAgent}
            onFocusRoom={setRoomFocus}
            onOpenRoom={openOfficeRoom}
            onSelectAgent={selectAgent}
          />
        </div>
        <InterventionPanel
          missions={missions}
          approvals={approvals}
          onOpenOfficePanel={setOfficePanel}
        />
      </main>

      {officePanel && (
        <OfficeInsightModal
          panel={officePanel}
          missions={missions}
          approvals={approvals}
          onClose={() => setOfficePanel(null)}
          onSelectAgent={(profileName) => {
            setOfficePanel(null);
            selectAgent(profileName);
          }}
          onApprovalDecision={onApprovalDecision}
        />
      )}

      {selectedAgent && (
        <AgentConsole
          profileName={selectedAgent}
          profiles={profiles}
          missions={missions}
          sessions={workspace?.sessions ?? []}
          activity={resolvedAgentActivities[selectedAgent]}
          liveWorkspace={officeLiveWorkspaces[selectedAgent]}
          liveSelection={officeLiveSelections[selectedAgent]}
          onSelectLiveTarget={(targetId) => selectOfficeLiveTarget(selectedAgent, targetId)}
          onFollowLiveTarget={() => followOfficeLiveTarget(selectedAgent)}
          liveSessionId={liveSessionForProfile(selectedAgent)}
          roomAssignments={roomAssignments}
          onClose={() => setSelectedAgent("")}
          onStartChat={onStartChat}
          onOpenLive={() => setFullscreenLiveAgent(selectedAgent)}
          onOpenChatDock={setOfficeChatAgent}
        />
      )}
      {fullscreenLiveAgent && (
        <LiveScreenModal
          profileName={fullscreenLiveAgent}
          activity={resolvedAgentActivities[fullscreenLiveAgent]}
          workspace={officeLiveWorkspaces[fullscreenLiveAgent]}
          selectedTargetId={officeLiveSelections[fullscreenLiveAgent]?.targetId || officeLiveWorkspaces[fullscreenLiveAgent]?.activeTargetId || ""}
          followAgent={officeLiveSelections[fullscreenLiveAgent]?.followAgent !== false}
          onSelectTarget={(targetId) => selectOfficeLiveTarget(fullscreenLiveAgent, targetId)}
          onFollowAgent={() => followOfficeLiveTarget(fullscreenLiveAgent)}
          sessionId={liveSessionForProfile(fullscreenLiveAgent)}
          onClose={() => setFullscreenLiveAgent("")}
        />
      )}
      {showMissionBoard && (
        <MissionBoard
          missions={missions}
          onClose={() => setShowMissionBoard(false)}
          onMoveMission={onMoveMission}
          onSelectAgent={selectAgent}
        />
      )}
      {showMeeting && (
        <MeetingRoom
          profiles={profiles}
          onClose={() => setShowMeeting(false)}
          onStartMeeting={(topic, participants) => {
            setShowMeeting(false);
            onStartMeeting({
              ...meetingRoom,
              topic,
              participants,
              subtitle: `${topic} · ${participants.map((name) => resolveProfileMeta(profiles.find((profile) => profile.name === name) ?? name).name).join(", ")}`,
            });
          }}
        />
      )}

      {officeChatAgent && (
        <section className="office-chat-dock">
          <header>
            <div>
              <span>LIVE CHAT</span>
              <strong>{resolveProfileMeta(profiles.find((profile) => profile.name === officeChatAgent) ?? officeChatAgent).name} 화면 보며 채팅</strong>
            </div>
            <button type="button" onClick={() => setFullscreenLiveAgent(officeChatAgent)}>풀화면</button>
            <button type="button" onClick={() => setOfficeChatAgent("")}>닫기</button>
          </header>
          <div className="office-chat-dock-body">
            <div className="office-chat-live">
              <LiveScreenPanel
                activity={resolvedAgentActivities[officeChatAgent]}
                workspace={officeLiveWorkspaces[officeChatAgent]}
                selectedTargetId={officeLiveSelections[officeChatAgent]?.targetId || officeLiveWorkspaces[officeChatAgent]?.activeTargetId || ""}
                followAgent={officeLiveSelections[officeChatAgent]?.followAgent !== false}
                onSelectTarget={(targetId) => selectOfficeLiveTarget(officeChatAgent, targetId)}
                onFollowAgent={() => followOfficeLiveTarget(officeChatAgent)}
                profileName={officeChatAgent}
                sessionId={liveSessionForProfile(officeChatAgent)}
                variant="dock"
                onFullscreen={() => setFullscreenLiveAgent(officeChatAgent)}
              />
            </div>
            <ProfileChat
              compact
              initialProfile={officeChatAgent}
              profiles={profiles}
              activities={resolvedAgentActivities}
              onActivityChange={onActivityChange}
              onStartMeeting={onStartMeeting}
              onGovernanceApprovalRequest={onGovernanceApprovalRequest}
            />
          </div>
        </section>
      )}

    </div>
  );
}
