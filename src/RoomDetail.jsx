import { ROOMS, STATUS_META, TEAM_META } from "./officeData.js";

function ProfileChip({ profile }) {
  const meta = TEAM_META[profile.name] ?? {
    name: profile.name,
    role: "Hermes profile",
    initials: profile.name.slice(0, 2).toUpperCase(),
    color: "#829b91",
  };
  return (
    <div className="room-profile">
      <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
      <div>
        <strong>{meta.name}</strong>
        <small>{meta.role}</small>
      </div>
      <i className={profile.gateway_running ? "online" : ""} />
    </div>
  );
}

function getRelatedSessions(room, sessions) {
  const profileNames = room.profiles.map((id) => TEAM_META[id]?.name).filter(Boolean);
  return sessions
    .filter((session) => {
      const text = `${session.title ?? ""} ${session.preview ?? ""}`;
      return profileNames.some((name) => text.includes(name)) || room.id === "desk";
    })
    .slice(0, 3);
}

export default function RoomDetail({
  roomId,
  workspace,
  onClose,
  onAction,
}) {
  const room = ROOMS.find((item) => item.id === roomId);
  if (!room) return null;

  const status = STATUS_META[room.status];
  const profiles = (workspace?.profiles ?? []).filter((profile) =>
    room.profiles.includes(profile.name),
  );
  const sessions = getRelatedSessions(room, workspace?.sessions ?? []);

  return (
    <aside className="room-detail" aria-labelledby="room-detail-title">
      <div className="room-detail-accent" style={{ "--status-color": status.color }} />
      <div className="room-detail-header">
        <div>
          <span>{room.subtitle}</span>
          <h2 id="room-detail-title">{room.label}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label={`${room.label} 상세 닫기`}>
          닫기
        </button>
      </div>

      <div className="room-status">
        <span style={{ "--status-color": status.color }} />
        <strong>{status.label}</strong>
        <small>{profiles.filter((profile) => profile.gateway_running).length}명 연결됨</small>
      </div>

      <p className="room-description">{room.description}</p>

      {profiles.length > 0 && (
        <section className="room-section">
          <div className="room-section-heading">
            <span>PEOPLE</span>
            <h3>이 공간의 담당자</h3>
          </div>
          <div className="room-profile-list">
            {profiles.map((profile) => <ProfileChip key={profile.name} profile={profile} />)}
          </div>
        </section>
      )}

      <section className="room-section">
        <div className="room-section-heading">
          <span>QUICK ACTIONS</span>
          <h3>무엇을 할까요?</h3>
        </div>
        <div className="room-actions">
          {room.actions.map(([type, label, description], index) => (
            <button type="button" key={`${type}-${label}`} onClick={() => onAction(type, room)}>
              <span>0{index + 1}</span>
              <div>
                <strong>{label}</strong>
                <small>{description}</small>
              </div>
              <b aria-hidden="true">→</b>
            </button>
          ))}
        </div>
      </section>

      <section className="room-section">
        <div className="room-section-heading">
          <span>RECENT</span>
          <h3>관련 최근 기록</h3>
        </div>
        {sessions.length ? (
          <div className="room-recent">
            {sessions.map((session) => (
              <button type="button" key={session.id} onClick={() => onAction("resume", room, session.id)}>
                <span>{session.source ?? "local"}</span>
                <strong>{session.title || "제목 없는 대화"}</strong>
                <small>{session.message_count}개 메시지</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="room-empty">아직 이 공간과 연결된 최근 기록이 없습니다.</p>
        )}
      </section>
    </aside>
  );
}
