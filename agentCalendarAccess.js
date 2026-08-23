import crypto from "node:crypto";

export const AGENT_CALENDAR_KEYS = Object.freeze(["integrated", "manual", "hourplace"]);
export const DEFAULT_AGENT_CALENDARS = Object.freeze(["integrated"]);
export const MAX_AGENT_CALENDAR_RANGE_DAYS = 93;
export const MAX_AGENT_CALENDAR_RESULTS = 250;

const PROFILE_PATTERN = /^(?:default|[a-z][a-z0-9._-]{1,119})$/;

function constantTimeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function bearerToken(header = "") {
  const match = String(header).match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || "";
}

export function authorizeAgentCalendarRequest({
  authorization = "",
  profile = "",
  expectedToken = "",
  allowedProfiles = [],
} = {}) {
  const normalizedProfile = String(profile || "").trim().toLowerCase();
  const allowed = allowedProfiles instanceof Set ? allowedProfiles : new Set(allowedProfiles);
  if (!PROFILE_PATTERN.test(normalizedProfile) || !allowed.has(normalizedProfile)) return "";
  if (!constantTimeEqual(bearerToken(authorization), expectedToken)) return "";
  return normalizedProfile;
}

function parseInstant(value, fallback, label) {
  const source = String(value || "").trim();
  if (!source) return new Date(fallback);
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} 시각은 RFC 3339 형식이어야 합니다.`);
  return parsed;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 값은 ${minimum}~${maximum} 범위여야 합니다.`);
  }
  return parsed;
}

export function parseAgentCalendarQuery(searchParams, { now = new Date() } = {}) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || "");
  const timeMin = parseInstant(params.get("time_min"), now, "시작");
  const timeMax = parseInstant(params.get("time_max"), new Date(now.getTime() + 30 * 86_400_000), "종료");
  if (timeMax <= timeMin) throw new Error("종료 시각은 시작 시각보다 뒤여야 합니다.");
  if (timeMax.getTime() - timeMin.getTime() > MAX_AGENT_CALENDAR_RANGE_DAYS * 86_400_000) {
    throw new Error(`한 번에 조회할 수 있는 기간은 최대 ${MAX_AGENT_CALENDAR_RANGE_DAYS}일입니다.`);
  }

  const requestedCalendars = String(params.get("calendars") || DEFAULT_AGENT_CALENDARS.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const calendars = [...new Set(requestedCalendars)];
  if (!calendars.length || calendars.some((value) => !AGENT_CALENDAR_KEYS.includes(value))) {
    throw new Error(`캘린더는 ${AGENT_CALENDAR_KEYS.join(", ")} 중에서 선택해야 합니다.`);
  }

  const query = String(params.get("query") || "").trim();
  if (query.length > 120) throw new Error("검색어는 120자를 넘을 수 없습니다.");

  return {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    calendars,
    query,
    limit: boundedInteger(params.get("limit"), 100, 1, MAX_AGENT_CALENDAR_RESULTS, "조회 개수"),
  };
}

function eventInstant(endpoint = {}) {
  return endpoint.dateTime || endpoint.date || "";
}

export function publicCalendarEvent(event, calendar) {
  const privateProperties = event?.extendedProperties?.private || {};
  const allDay = Boolean(event?.start?.date && !event?.start?.dateTime);
  return {
    id: crypto.createHash("sha256").update(`${calendar.key}:${event?.id || ""}`).digest("hex").slice(0, 24),
    calendar: calendar.key,
    calendarName: calendar.name,
    title: String(event?.summary || (calendar.key === "hourplace" ? "예약 차단" : "제목 없는 일정")).slice(0, 160),
    startAt: eventInstant(event?.start),
    endAt: eventInstant(event?.end),
    allDay,
    status: event?.status === "tentative" ? "tentative" : "confirmed",
    busy: event?.transparency !== "transparent",
    origin: String(privateProperties.origin || (calendar.key === "manual" ? "manual" : "")).slice(0, 32),
    updatedAt: String(event?.updated || ""),
  };
}
