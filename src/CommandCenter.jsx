import { useMemo, useState } from "react";
import { profileLabel } from "./governance.js";
import { ROOMS, TEAM_META } from "./officeData.js";
import { MISSION_STATUS } from "./operationsData.js";

function AgentAvatar({ profileName, online = false }) {
  const meta = TEAM_META[profileName] ?? {
    name: profileName,
    initials: profileName.slice(0, 2).toUpperCase(),
    color: "#829b91",
  };
  return (
    <span className="agent-avatar" style={{ "--avatar": meta.color }} title={meta.name}>
      {meta.initials}
      <i className={online ? "online" : ""} />
    </span>
  );
}

function MissionCard({ mission, selected, onSelect }) {
  const owner = TEAM_META[mission.owner];
  const status = MISSION_STATUS[mission.status];
  return (
    <button
      type="button"
      className={`mission-card ${selected ? "selected" : ""}`}
      onClick={() => onSelect(mission.id)}
    >
      <div className="mission-card-top">
        <span className={`status-pill ${status.tone}`}>{status.label}</span>
        <small>{mission.due}</small>
      </div>
      <strong>{mission.title}</strong>
      <p>{mission.objective}</p>
      <div className="mission-progress">
        <span style={{ width: `${mission.progress}%` }} />
      </div>
      <div className="mission-card-bottom">
        <span>{owner?.name ?? mission.owner}</span>
        <b>{mission.progress}%</b>
      </div>
    </button>
  );
}

function latestMissionSession(mission, sessions) {
  if (mission.sessionId) {
    const exact = sessions.find((session) => session.id === mission.sessionId);
    if (exact) return exact;
  }
  return sessions.find((session) => session.profile === mission.owner) ?? null;
}

function MissionDetail({ mission, sessions, onToggleStep, onOpenRoom, onContinueMission, onDeleteMission }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  const owner = TEAM_META[mission.owner];
  const room = ROOMS.find((item) => item.id === mission.room);
  const status = MISSION_STATUS[mission.status];
  const session = latestMissionSession(mission, sessions);
  return (
    <section className="mission-detail">
      <div className="panel-heading">
        <div>
          <span>ACTIVE MISSION</span>
          <h3>{mission.title}</h3>
        </div>
        <span className={`status-pill ${status.tone}`}>{status.label}</span>
      </div>
      <p>{mission.objective}</p>
      <div className="mission-owner-row">
        <AgentAvatar profileName={mission.owner} online />
        <div>
          <small>담당 에이전트</small>
          <strong>{owner?.name ?? mission.owner}</strong>
        </div>
        <div>
          <small>업무 공간</small>
          <strong>{room?.label ?? "오피스"}</strong>
        </div>
        <div>
          <small>기한</small>
          <strong>{mission.due}</strong>
        </div>
      </div>
      <div className="mission-checklist">
        {mission.steps.map((step) => (
          <label key={step.id} className={step.done ? "done" : ""}>
            <input
              type="checkbox"
              checked={step.done}
              onChange={() => onToggleStep(mission.id, step.id)}
            />
            <span>{step.label}</span>
          </label>
        ))}
      </div>
      <div className="mission-actions">
        <button type="button" className="primary-button" onClick={() => onContinueMission(mission, session)}>
          Hermes에 이어서 지시
        </button>
        <button type="button" className="secondary-button" onClick={() => onOpenRoom(mission.room, mission)}>
          {room?.label ?? "오피스"} 열기
        </button>
        <button type="button" className="danger-button" onClick={() => setDeleteOpen((current) => !current)}>
          Task 삭제
        </button>
      </div>
      {deleteOpen && (
        <div className="mission-delete-confirm" role="group" aria-label="Task 삭제 확인">
          <strong>이 Task를 업무 화면에서 삭제할까요?</strong>
          <p>실행 기록을 보존하기 위해 Hermes 보관 상태로 이동하며, 업무 보드와 지휘 센터에서는 숨겨집니다.</p>
          <label>
            삭제 사유
            <input value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="예: 중복 생성된 Task" />
          </label>
          <div>
            <button type="button" className="secondary-button" onClick={() => { setDeleteOpen(false); setDeleteReason(""); }}>취소</button>
            <button
              type="button"
              className="danger-button"
              disabled={deleting || !deleteReason.trim()}
              onClick={async () => {
                setDeleting(true);
                try {
                  await onDeleteMission?.(mission, deleteReason.trim());
                  setDeleteOpen(false);
                  setDeleteReason("");
                } catch {
                  // The parent surface reports the official Hermes API error.
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? "삭제 중" : "삭제 확정"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ApprovalQueue({ approvals, onDecision }) {
  return (
    <section className="approval-panel">
      <div className="panel-heading">
        <div>
          <span>HUMAN IN THE LOOP</span>
          <h3>내 승인을 기다리는 일</h3>
        </div>
        <b>{approvals.length}</b>
      </div>
      <div className="approval-list">
        {approvals.length ? approvals.map((approval) => {
          const requester = TEAM_META[approval.requester];
          const approverText = approval.approvers?.length
            ? approval.approvers.map(profileLabel).join(", ")
            : approval.approver ? profileLabel(approval.approver) : "";
          return (
            <article key={approval.id} className={approval.type === "area-change" ? "area-approval" : ""}>
              <AgentAvatar profileName={approval.requester} online />
              <div>
                <span>{approval.risk} · {requester?.name}{approverText ? ` → ${approverText}` : ""}</span>
                <strong>{approval.title}</strong>
                <p>{approval.description}</p>
                {approval.type === "area-change" && (
                  <small className="approval-reason">
                    대상: {approval.areaLabel ?? approval.areaId} · 명분: {approval.reason}
                  </small>
                )}
              </div>
              <div className="approval-actions">
                <button type="button" onClick={() => onDecision(approval.id, "approved")}>동의</button>
                <button type="button" onClick={() => onDecision(approval.id, "rejected")}>미동의</button>
                {approval.type === "area-change" && !approval.escalated && (
                  <button type="button" onClick={() => onDecision(approval.id, "escalated")}>상부 검토</button>
                )}
              </div>
            </article>
          );
        }) : (
          <div className="all-clear">
            <strong>승인함이 비어 있습니다</strong>
            <span>새 요청이 도착하면 이곳에 표시됩니다.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ActivityFeed({ sessions }) {
  const events = sessions.slice(0, 5);
  return (
    <section className="activity-panel">
      <div className="panel-heading">
        <div>
          <span>LIVE ACTIVITY</span>
          <h3>Hermes 최근 활동</h3>
        </div>
        <i className="live-indicator">LIVE</i>
      </div>
      <div className="activity-list">
        {events.length ? events.map((session, index) => (
          <article key={session.id}>
            <span className="activity-line"><i /></span>
            <div>
              <small>{session.source ?? "local"} · {index === 0 ? "최근" : `${index + 1}번째`}</small>
              <strong>{session.title || "제목 없는 대화"}</strong>
              <p>{session.message_count}개 메시지가 기록된 세션</p>
            </div>
          </article>
        )) : (
          <div className="all-clear">
            <strong>아직 불러온 활동이 없습니다</strong>
            <span>Hermes 연결 후 최근 세션이 표시됩니다.</span>
          </div>
        )}
      </div>
    </section>
  );
}

export default function CommandCenter({
  workspace,
  missions,
  approvals,
  onToggleStep,
  onApprovalDecision,
  onOpenOffice,
  onOpenRoom,
  onStartChat,
  onContinueMission,
  onDeleteMission,
}) {
  const [selectedMissionId, setSelectedMissionId] = useState(missions[0]?.id ?? "");
  const selectedMission = missions.find((mission) => mission.id === selectedMissionId) ?? missions[0];
  const profiles = useMemo(
    () => (workspace?.profiles ?? []).filter((profile) => TEAM_META[profile.name]),
    [workspace?.profiles],
  );
  const onlineCount = profiles.filter((profile) => profile.gateway_running).length;
  const workingCount = missions.filter((mission) => mission.status === "working").length;
  const completion = missions.length
    ? Math.round(missions.reduce((sum, mission) => sum + mission.progress, 0) / missions.length)
    : 0;
  const visibleAgents = useMemo(
    () => profiles.slice(0, 7),
    [profiles],
  );

  return (
    <div className="command-center">
      <section className="command-hero">
        <div>
          <span>HERMES COMMAND CENTER</span>
          <h2>오늘의 운영을 한눈에 지휘하세요</h2>
          <p>미션, 에이전트, 승인 요청과 실제 Hermes 활동을 하나의 흐름으로 연결합니다.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => onStartChat(null)}>
          새 지시 시작
        </button>
      </section>

      <section className="command-metrics" aria-label="운영 요약">
        <article>
          <span>ACTIVE MISSIONS</span>
          <strong>{workingCount}</strong>
          <small>현재 실행 중인 미션</small>
        </article>
        <article>
          <span>APPROVALS</span>
          <strong>{approvals.length}</strong>
          <small>대표 확인이 필요한 요청</small>
        </article>
        <article>
          <span>AGENTS ONLINE</span>
          <strong>{onlineCount}<em>/{profiles.length || 0}</em></strong>
          <small>Gateway 연결 기준</small>
        </article>
        <article>
          <span>MISSION HEALTH</span>
          <strong>{completion}<em>%</em></strong>
          <small>전체 미션 평균 진행률</small>
        </article>
      </section>

      <div className="command-layout">
        <section className="mission-board">
          <div className="panel-heading">
            <div>
              <span>MISSION CONTROL</span>
              <h3>진행 중인 핵심 미션</h3>
            </div>
            <button type="button" onClick={onOpenOffice}>오피스 보기</button>
          </div>
          <div className="mission-grid">
            {missions.map((mission) => (
              <MissionCard
                key={mission.id}
                mission={mission}
                selected={mission.id === selectedMission?.id}
                onSelect={setSelectedMissionId}
              />
            ))}
          </div>
        </section>

        <section className="agent-panel">
          <div className="panel-heading">
            <div>
              <span>AI TEAM</span>
              <h3>현재 팀 상태</h3>
            </div>
            <b>{onlineCount} ONLINE</b>
          </div>
          <div className="agent-stack">
            {visibleAgents.length ? visibleAgents.map((profile) => {
              const meta = TEAM_META[profile.name];
              const relatedMission = missions.find((mission) => mission.owner === profile.name);
              return (
                <article key={profile.name}>
                  <AgentAvatar profileName={profile.name} online={profile.gateway_running} />
                  <div>
                    <strong>{meta.name}</strong>
                    <small>{relatedMission?.title ?? meta.role}</small>
                  </div>
                  <span>{profile.gateway_running ? "작업 가능" : "오프라인"}</span>
                </article>
              );
            }) : (
              <div className="all-clear">
                <strong>팀 정보를 불러오는 중입니다</strong>
                <span>Gateway 연결 상태를 확인하고 있습니다.</span>
              </div>
            )}
          </div>
        </section>

        {selectedMission && (
          <MissionDetail
            mission={selectedMission}
            sessions={workspace?.sessions ?? []}
            onToggleStep={onToggleStep}
            onOpenRoom={onOpenRoom}
            onContinueMission={onContinueMission}
            onDeleteMission={onDeleteMission}
          />
        )}
        <ApprovalQueue approvals={approvals} onDecision={onApprovalDecision} />
        <ActivityFeed sessions={workspace?.sessions ?? []} />
      </div>
    </div>
  );
}
