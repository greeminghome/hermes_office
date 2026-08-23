import { ROOMS, STATUS_META } from "./officeData.js";

export default function OfficeMap({ selectedRoom, onSelectRoom }) {
  return (
    <section className="office-map-card" aria-labelledby="office-map-heading">
      <div className="office-map-heading">
        <div>
          <span>INTERACTIVE OFFICE</span>
          <h2 id="office-map-heading">Hermes AI 오피스</h2>
          <p>공간을 선택하면 담당 팀과 업무 도구가 열립니다.</p>
        </div>
        <div className="map-legend" aria-label="상태 범례">
          {Object.entries(STATUS_META).map(([id, status]) => (
            <span key={id}>
              <i style={{ "--status-color": status.color }} />
              {status.label}
            </span>
          ))}
        </div>
      </div>

      <div className="office-map-stage">
        <img src="/hermes-office-map-2d.webp" alt="Hermes AI 오피스 전체 평면도" />
        <div className="office-hotspots">
          {ROOMS.map((room) => {
            const status = STATUS_META[room.status];
            return (
              <button
                type="button"
                key={room.id}
                className={`room-hotspot ${selectedRoom === room.id ? "selected" : ""}`}
                style={{
                  "--x": `${room.x}%`,
                  "--y": `${room.y}%`,
                  "--w": `${room.w}%`,
                  "--h": `${room.h}%`,
                  "--status-color": status.color,
                }}
                onClick={() => onSelectRoom(room.id)}
                aria-label={`${room.label} 열기, ${status.label}`}
                aria-pressed={selectedRoom === room.id}
              >
                <span className="hotspot-label">
                  <i />
                  <strong>{room.label}</strong>
                  <small>{status.label}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
