import { toUiProfileId } from "./profileIds.js";

export const TEAM_META = {
  default: { name: "민준", role: "CEO · 총괄 오케스트레이터", initials: "MJ", color: "#e8774f", avatar: "/agents/minjun.png" },
  "greeming-seoyun": { name: "서윤", role: "COO · 운영 총괄", initials: "SY", color: "#7a9f8e", avatar: "/agents/seoyun.png" },
  "greeming-jian": { name: "지안", role: "브랜드 전략", initials: "JA", color: "#d39a6a", avatar: "/agents/jian.png" },
  "greeming-taeo": { name: "태오", role: "마케팅 · 성장 전략", initials: "TO", color: "#7699ad", avatar: "/agents/taeo.png" },
  "greeming-harin": { name: "하린", role: "콘텐츠 · SNS", initials: "HR", color: "#b18ca4", avatar: "/agents/harin.png" },
  "greeming-doyun": { name: "도윤", role: "크리에이티브 · 제작 QA", initials: "DY", color: "#8c9c72", avatar: "/agents/doyun.png" },
  "greeming-yuna": { name: "유나", role: "고객 상담 · 세일즈", initials: "YN", color: "#c18872", avatar: "/agents/yuna.png" },
  "greeming-junseo": { name: "준서", role: "재무 · KPI", initials: "JS", color: "#7f8fbc", avatar: "/agents/junseo.png" },
  "greeming-jaehyun": { name: "재현", role: "CTO · 기술 총괄", initials: "JH", color: "#728f92", avatar: "/agents/jaehyun.png" },
};

export const OFFICE_FLOOR_ZONES = [
  // Calibrated to agent-office-open-topdown-v1.png. Names stay in accessible
  // controls and detail panels; the map itself remains visually unlabeled.
  { id: "executive", label: "대표실", x: 1.9, y: 2.0, w: 12.2, h: 22.2, marker: [7.0, 22.0], tone: "executive", furniture: "desk", agentSlots: [[3.6, 21.5], [7.0, 22.0], [11.7, 21.5]] },
  { id: "meeting", label: "회의실", x: 19.0, y: 29.0, w: 61.8, h: 38.0, marker: [49.5, 48.0], tone: "meeting", furniture: "meeting" },
  { id: "operations", label: "운영실", x: 14.3, y: 2.0, w: 25.4, h: 22.2, marker: [27.0, 22.0], tone: "operations", furniture: "desk", agentSlots: [[17.0, 22.0], [27.0, 22.0], [37.0, 22.0]] },
  { id: "control", label: "관제센터", x: 60.3, y: 2.0, w: 25.2, h: 22.2, marker: [72.8, 22.0], tone: "control", furniture: "monitors" },
  { id: "brand", label: "브랜드룸", x: 1.8, y: 25.0, w: 8.0, h: 17.0, marker: [8.8, 34.0], tone: "brand", furniture: "table", agentSlots: [[8.8, 29.0], [8.8, 34.0], [8.8, 39.0]] },
  { id: "content", label: "콘텐츠룸", x: 1.8, y: 43.0, w: 8.0, h: 27.0, marker: [8.8, 55.0], tone: "content", furniture: "workbench", agentSlots: [[8.8, 47.0], [8.8, 55.0], [8.8, 63.0]] },
  { id: "creative", label: "크리에이티브룸", x: 1.8, y: 70.0, w: 38.3, h: 28.0, marker: [22.0, 72.0], tone: "creative", furniture: "desk", agentSlots: [[5.0, 72.0], [14.0, 72.0], [23.0, 72.0], [36.0, 72.0]] },
  { id: "desk", label: "내 책상", x: 39.5, y: 2.0, w: 20.8, h: 22.2, marker: [50.0, 22.0], tone: "executive", furniture: "desk" },
  { id: "library", label: "자료실", x: 39.5, y: 70.0, w: 23.2, h: 28.0, marker: [51.0, 72.0], tone: "library", furniture: "shelves" },
  { id: "customer", label: "고객 데스크", x: 89.5, y: 25.0, w: 8.7, h: 45.0, marker: [90.5, 48.0], tone: "customer", furniture: "round", agentSlots: [[90.5, 30.0], [90.5, 41.0], [90.5, 52.0], [90.5, 63.0]] },
  { id: "tech", label: "기술실", x: 64.0, y: 70.0, w: 34.2, h: 28.0, marker: [80.0, 72.0], tone: "control", furniture: "monitors", agentSlots: [[67.0, 72.0], [79.0, 72.0], [91.0, 72.0]] },
  { id: "finance", label: "재무실", x: 85.5, y: 2.0, w: 12.7, h: 22.2, marker: [92.0, 22.0], tone: "finance", furniture: "desk", agentSlots: [[87.0, 22.0], [92.0, 22.0], [96.0, 22.0]] },
];

export const ROOMS = [
  {
    id: "executive",
    label: "대표실",
    subtitle: "결정과 우선순위",
    profiles: ["default"],
    x: 20,
    y: 18,
    w: 20,
    h: 25,
    status: "working",
    description: "중요한 판단을 정리하고 실행 방향을 확정하는 대표님의 의사결정 공간입니다.",
    actions: [
      ["chat", "민준과 대화", "전략 판단이나 업무 지시를 바로 시작합니다."],
      ["brief", "오늘의 브리핑", "핵심 현황과 승인 대기를 빠르게 확인합니다."],
      ["sessions", "최근 보고", "민준이 참여한 최근 대화를 살펴봅니다."],
    ],
  },
  {
    id: "meeting",
    label: "회의실",
    subtitle: "AI 팀 회의",
    profiles: [
      "default",
      "greeming-seoyun",
      "greeming-jian",
      "greeming-taeo",
      "greeming-harin",
      "greeming-doyun",
      "greeming-yuna",
      "greeming-junseo",
      "greeming-jaehyun",
    ],
    x: 39,
    y: 17,
    w: 25,
    h: 26,
    status: "meeting",
    description: "여러 전문 에이전트를 한자리에 모아 안건을 논의하고 결론과 액션을 만드는 공간입니다.",
    actions: [
      ["meeting", "새 회의 만들기", "참여자와 안건, 기대 산출물을 지정합니다."],
      ["sessions", "회의 기록", "최근 회의와 결정사항을 이어서 확인합니다."],
      ["tasks", "액션 아이템", "회의에서 나온 후속 업무를 점검합니다."],
    ],
  },
  {
    id: "operations",
    label: "운영실",
    subtitle: "일정과 실행",
    profiles: ["greeming-seoyun"],
    x: 64,
    y: 18,
    w: 16,
    h: 23,
    status: "working",
    description: "업무 분장, 일정, SOP와 운영 병목을 관리하는 실행 중심 공간입니다.",
    actions: [
      ["chat", "서윤에게 요청", "운영 계획과 실행 순서를 논의합니다."],
      ["tasks", "업무 보드", "요청부터 완료까지 진행 상태를 확인합니다."],
      ["brief", "운영 브리핑", "오늘의 운영 이슈와 마감 업무를 봅니다."],
    ],
  },
  {
    id: "control",
    label: "관제센터",
    subtitle: "시스템 상태",
    profiles: [],
    x: 80,
    y: 17,
    w: 18,
    h: 24,
    status: "online",
    description: "Hermes Gateway, 모델, 연결 상태와 장애 신호를 실시간으로 확인합니다.",
    actions: [
      ["system", "시스템 현황", "Gateway와 프로필 연결 상태를 확인합니다."],
      ["chat", "재현에게 문의", "기술 문제와 자동화 개선을 논의합니다."],
      ["sessions", "장애 기록", "기술 관련 최근 세션을 살펴봅니다."],
    ],
  },
  {
    id: "brand",
    label: "브랜드룸",
    subtitle: "정체성과 메시지",
    profiles: ["greeming-jian"],
    x: 8,
    y: 38,
    w: 22,
    h: 20,
    status: "online",
    description: "브랜드의 기준, 포지셔닝, 메시지와 고객에게 보이는 인상을 다듬습니다.",
    actions: [
      ["chat", "지안과 대화", "브랜드 관점의 검토를 요청합니다."],
      ["files", "브랜드 문서", "정체성 문서와 핵심 가이드를 엽니다."],
      ["sessions", "최근 검토", "브랜드 관련 대화 기록을 확인합니다."],
    ],
  },
  {
    id: "content",
    label: "콘텐츠룸",
    subtitle: "캠페인과 발행",
    profiles: ["greeming-taeo", "greeming-harin"],
    x: 5,
    y: 58,
    w: 24,
    h: 25,
    status: "working",
    description: "마케팅 실험과 콘텐츠 기획, 채널별 발행 흐름을 함께 설계합니다.",
    actions: [
      ["chat", "콘텐츠 논의", "태오 또는 하린과 바로 대화합니다."],
      ["tasks", "콘텐츠 캘린더", "기획·제작·발행 상태를 확인합니다."],
      ["files", "콘텐츠 자산", "카피와 제작물을 모아 봅니다."],
    ],
  },
  {
    id: "creative",
    label: "크리에이티브룸",
    subtitle: "제작과 품질",
    profiles: ["greeming-doyun"],
    x: 27,
    y: 60,
    w: 20,
    h: 24,
    status: "approval",
    description: "디자인과 제작 결과물을 검토하고 고객에게 전달할 품질을 완성합니다.",
    actions: [
      ["chat", "도윤에게 검토 요청", "산출물 QA와 제작 방향을 논의합니다."],
      ["files", "검토 대기", "승인이나 수정이 필요한 산출물을 봅니다."],
      ["tasks", "제작 현황", "진행 중인 크리에이티브 업무를 확인합니다."],
    ],
  },
  {
    id: "library",
    label: "자료실",
    subtitle: "문서와 산출물",
    profiles: [],
    x: 61,
    y: 42,
    w: 19,
    h: 22,
    status: "online",
    description: "GitHub 문서, Drive 자료와 Hermes가 만든 결과물을 검색하고 다시 활용합니다.",
    actions: [
      ["files", "통합 문서 검색", "저장소와 산출물을 한 번에 찾습니다."],
      ["files", "최근 수정 문서", "최근 변경된 업무 문서를 확인합니다."],
      ["files", "산출물 보관함", "완료된 PDF, 이미지와 보고서를 봅니다."],
    ],
  },
  {
    id: "tech",
    label: "기술실",
    subtitle: "자동화와 개발",
    profiles: ["greeming-jaehyun"],
    x: 80,
    y: 42,
    w: 18,
    h: 19,
    status: "working",
    description: "코드, 자동화, 데이터 구조와 보안 관련 작업을 설계하고 검증합니다.",
    actions: [
      ["chat", "재현과 개발 논의", "구현과 보안 검토를 요청합니다."],
      ["system", "자동화 상태", "연결된 서비스와 작업 상태를 봅니다."],
      ["sessions", "개발 세션", "기술 관련 최근 대화를 확인합니다."],
    ],
  },
  {
    id: "finance",
    label: "재무실",
    subtitle: "매출과 KPI",
    profiles: ["greeming-junseo"],
    x: 81,
    y: 62,
    w: 17,
    h: 20,
    status: "online",
    description: "매출, 수익성, 전환율과 사업 의사결정에 필요한 숫자를 정리합니다.",
    actions: [
      ["chat", "준서와 숫자 검토", "재무와 KPI 분석을 요청합니다."],
      ["brief", "KPI 요약", "핵심 숫자와 변화 신호를 확인합니다."],
      ["files", "재무 자료", "관련 보고서와 기준 문서를 봅니다."],
    ],
  },
  {
    id: "desk",
    label: "내 책상",
    subtitle: "브리핑과 승인",
    profiles: [],
    x: 43,
    y: 68,
    w: 20,
    h: 23,
    status: "approval",
    description: "오늘의 우선순위, 승인 요청과 완료 보고를 대표님 기준으로 모아 보는 개인 공간입니다.",
    actions: [
      ["brief", "오늘의 브리핑", "오늘 확인해야 할 내용을 한 화면에 봅니다."],
      ["tasks", "승인 대기", "대표님의 판단이 필요한 업무를 확인합니다."],
      ["sessions", "내 최근 대화", "최근 작업 흐름을 이어갑니다."],
    ],
  },
  {
    id: "customer",
    label: "고객 데스크",
    subtitle: "상담과 경험",
    profiles: ["greeming-yuna"],
    x: 63,
    y: 66,
    w: 18,
    h: 21,
    status: "online",
    description: "고객 문의, 상담, 세일즈와 후기까지 고객 경험의 흐름을 관리합니다.",
    actions: [
      ["chat", "유나와 상담 검토", "고객 응대와 세일즈 방향을 논의합니다."],
      ["tasks", "문의 현황", "응답과 후속 조치가 필요한 항목을 봅니다."],
      ["sessions", "고객 대화 기록", "고객 관련 최근 업무를 확인합니다."],
    ],
  },
];

const OFFICE_ASSIGNABLE_ROOM_IDS = [
  "executive",
  "operations",
  "brand",
  "content",
  "creative",
  "customer",
  "tech",
  "finance",
];

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function profileId(profile) {
  const id = typeof profile === "string" ? profile.trim() : String(profile?.name ?? profile?.id ?? "").trim();
  return toUiProfileId(id);
}

function profileDisplayName(profile, id) {
  if (typeof profile === "object" && profile) {
    const explicit = profile.display_name ?? profile.displayName ?? profile.label ?? profile.full_name ?? profile.fullName;
    if (String(explicit ?? "").trim()) return String(explicit).trim();
  }
  const withoutNamespace = id.replace(/^greeming[-_.]?/i, "");
  const words = withoutNamespace.split(/[-_.\s]+/).filter(Boolean);
  if (!words.length) return id || "Hermes Agent";
  return words
    .map((word) => /^[a-z]/i.test(word) ? `${word[0].toUpperCase()}${word.slice(1)}` : word)
    .join(" ");
}

function initialsFor(name, id) {
  const words = String(name || id || "AI").split(/[-_.\s]+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => [...word][0]).join("").toUpperCase();
  return [...(words[0] || "AI")].slice(0, 2).join("").toUpperCase();
}

export function resolveProfileMeta(profile) {
  const id = toUiProfileId(profileId(profile) || "default");
  const registered = TEAM_META[id];
  if (registered) return { ...registered, id };

  const name = profileDisplayName(profile, id);
  const role = typeof profile === "object" && profile
    ? String(profile.description ?? profile.role ?? "Hermes AI Agent").trim() || "Hermes AI Agent"
    : "Hermes AI Agent";
  const avatar = typeof profile === "object" && profile
    ? String(profile.avatar ?? profile.avatar_url ?? profile.avatarUrl ?? "").trim()
    : "";
  const explicitColor = typeof profile === "object" && profile ? String(profile.color ?? "").trim() : "";
  const hue = stableHash(id) % 360;
  return {
    id,
    name,
    role,
    initials: initialsFor(name, id),
    color: explicitColor || `hsl(${hue} 30% 48%)`,
    avatar,
  };
}

function uniqueProfiles(profiles = []) {
  const byName = new Map();
  for (const profile of profiles) {
    const name = profileId(profile);
    if (name && !byName.has(name)) byName.set(name, typeof profile === "string" ? { name } : profile);
  }
  return [...byName.values()].sort((left, right) => profileId(left).localeCompare(profileId(right)));
}

function roomSeatSlots(zone) {
  if (Array.isArray(zone.agentSlots) && zone.agentSlots.length) {
    return zone.agentSlots.map(([x, y]) => ({ roomId: zone.id, x, y }));
  }
  const horizontalPadding = Math.min(4.2, Math.max(2.6, zone.w * 0.2));
  const verticalPadding = Math.min(6.4, Math.max(3.4, zone.h * 0.2));
  const usableWidth = Math.max(1, zone.w - horizontalPadding * 2);
  const usableHeight = Math.max(1, zone.h - verticalPadding * 2);
  const columns = Math.max(1, Math.floor(usableWidth / 5.4) + 1);
  const rows = Math.max(1, Math.floor(usableHeight / 6.4) + 1);
  const slots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      slots.push({
        roomId: zone.id,
        x: zone.x + horizontalPadding + (usableWidth * (column + 0.5)) / columns,
        y: zone.y + verticalPadding + (usableHeight * (row + 0.5)) / rows,
      });
    }
  }
  return slots;
}

function rotateSlots(slots, offset) {
  if (!slots.length) return slots;
  const start = offset % slots.length;
  return [...slots.slice(start), ...slots.slice(0, start)];
}

export function buildOfficeAgentPlacements(
  profiles = [],
  floorZones = OFFICE_FLOOR_ZONES,
  rooms = ROOMS,
  roomAssignments = {},
) {
  const roster = uniqueProfiles(profiles);
  if (!roster.length) return {};

  const zones = floorZones.filter((zone) => OFFICE_ASSIGNABLE_ROOM_IDS.includes(zone.id));
  const slots = zones.flatMap(roomSeatSlots);
  if (slots.length < roster.length) {
    throw new Error(`Office seat capacity (${slots.length}) is smaller than the profile roster (${roster.length}).`);
  }

  const slotsByRoom = new Map(zones.map((zone) => [zone.id, slots.filter((slot) => slot.roomId === zone.id)]));
  const used = new Set();
  const placements = {};

  for (const profile of roster) {
    const name = profileId(profile);
    const assignedRoom = String(roomAssignments?.[name] ?? "").trim();
    const configuredRoom = rooms.find((room) => room.id !== "meeting" && room.profiles?.includes(name))?.id;
    const fallbackRoom = zones[stableHash(name) % zones.length]?.id;
    const preferredRoom = assignedRoom && slotsByRoom.has(assignedRoom)
      ? assignedRoom
      : configuredRoom && slotsByRoom.has(configuredRoom)
        ? configuredRoom
        : fallbackRoom;
    const preferred = rotateSlots(slotsByRoom.get(preferredRoom) ?? [], stableHash(`${name}:preferred`));
    const fallback = rotateSlots(slots, stableHash(`${name}:fallback`));
    const slot = [...preferred, ...fallback].find((candidate) => !used.has(`${candidate.x}:${candidate.y}`));
    if (!slot) throw new Error(`No collision-free Office seat is available for ${name}.`);
    used.add(`${slot.x}:${slot.y}`);
    placements[name] = { roomId: slot.roomId, x: slot.x, y: slot.y };
  }
  return placements;
}

function ringSeats(names, { centerX, centerY, radiusX, radiusY, angleOffset = -Math.PI / 2 }) {
  if (names.length === 1) return [[names[0], [centerX, centerY]]];
  return names.map((name, index) => {
    const angle = angleOffset + (Math.PI * 2 * index) / names.length;
    return [name, [
      Number((centerX + Math.cos(angle) * radiusX).toFixed(3)),
      Number((centerY + Math.sin(angle) * radiusY).toFixed(3)),
    ]];
  });
}

export function buildMeetingSeatPlacements(profiles = [], options = {}) {
  const names = uniqueProfiles(profiles).map(profileId);
  if (!names.length) return {};
  const centerX = Number(options.centerX ?? 49.5);
  const centerY = Number(options.centerY ?? 48.0);
  const sceneSeats = [
    [centerX, centerY + 15.5],
    [centerX - 28.0, centerY],
    [centerX, centerY - 15.5],
    [centerX + 31.0, centerY],
    [centerX - 17.0, centerY + 15.5],
    [centerX + 17.0, centerY + 15.5],
    [centerX - 17.0, centerY - 15.5],
    [centerX + 17.0, centerY - 15.5],
  ];
  if (names.length <= sceneSeats.length) {
    return Object.fromEntries(names.map((name, index) => [name, sceneSeats[index]]));
  }
  if (names.length <= 12) {
    return Object.fromEntries(ringSeats(names, {
      centerX,
      centerY,
      radiusX: 26.0,
      radiusY: 15.5,
    }));
  }

  const innerCount = Math.min(8, Math.floor(names.length * 0.4));
  const inner = names.slice(0, innerCount);
  const outer = names.slice(innerCount);
  return Object.fromEntries([
    ...ringSeats(inner, { centerX, centerY, radiusX: 8.2, radiusY: 9.2 }),
    ...ringSeats(outer, { centerX, centerY, radiusX: 24.0, radiusY: 16.4, angleOffset: -Math.PI / 2 + Math.PI / Math.max(1, outer.length) }),
  ]);
}

export const STATUS_META = {
  online: { label: "온라인", color: "#86ad69" },
  working: { label: "작업 중", color: "#e2a63f" },
  approval: { label: "승인 대기", color: "#6197cf" },
  meeting: { label: "회의 중", color: "#e3685c" },
};
