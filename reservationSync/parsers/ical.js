import { maskSensitiveText, temporaryBookingFingerprint } from "../normalization.js";

function unfoldLines(text) {
  return String(text || "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseProperty(line) {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const rawKey = line.slice(0, colon);
  const [name, ...parameterParts] = rawKey.split(";");
  const parameters = Object.fromEntries(parameterParts.map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.toUpperCase(), ""] : [part.slice(0, index).toUpperCase(), part.slice(index + 1)];
  }));
  return { name: name.toUpperCase(), parameters, value: line.slice(colon + 1) };
}

function calendarDate(value, parameters = {}, defaultTimeZone = "Asia/Seoul") {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) throw new Error(`지원하지 않는 iCal 날짜 형식: ${String(value).slice(0, 24)}`);
  const [, year, month, day, hour = "00", minute = "00", second = "00", utcMark] = match;
  const isDateOnly = !String(value).includes("T");
  const timeZone = String(parameters.TZID || defaultTimeZone).replace(/^"|"$/g, "");
  if (!utcMark && !new Set(["Asia/Seoul", "ROK", "GMT+09:00"]).has(timeZone)) {
    throw new Error(`지원하지 않는 iCal 시간대: ${timeZone}`);
  }
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const instant = new Date(utcMark ? utc : utc - (9 * 60 * 60 * 1000));
  return { iso: instant.toISOString(), dateOnly: isDateOnly };
}

export function parseIcal(text, { sourcePlatform, venueId, resourceId = "default-space", timeZone = "Asia/Seoul" } = {}) {
  if (!/^BEGIN:VCALENDAR\r?$/m.test(String(text)) || !/^END:VCALENDAR\r?$/m.test(String(text))) {
    throw new Error("응답이 올바른 iCal 캘린더가 아닙니다.");
  }
  const events = [];
  let current = null;
  for (const line of unfoldLines(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const property = parseProperty(line);
    if (!property) continue;
    if (current[property.name] === undefined) current[property.name] = property;
  }
  const parsed = [];
  const unknown = [];
  for (const event of events) {
    try {
      if (!event.UID?.value || !event.DTSTART?.value) throw new Error("UID 또는 DTSTART가 없습니다.");
      if (event.RRULE) throw new Error("반복 일정은 안전 검토가 필요합니다.");
      const start = calendarDate(event.DTSTART.value, event.DTSTART.parameters, timeZone);
      let end;
      if (event.DTEND?.value) end = calendarDate(event.DTEND.value, event.DTEND.parameters, timeZone);
      else if (start.dateOnly) end = { iso: new Date(new Date(start.iso).getTime() + 86_400_000).toISOString() };
      else throw new Error("DTEND가 없습니다.");
      const cancelled = event.STATUS?.value?.toUpperCase() === "CANCELLED";
      const externalBookingId = temporaryBookingFingerprint({
        sourcePlatform,
        startAt: start.iso,
        endAt: end.iso,
        productCode: "",
        customerHint: "",
      });
      parsed.push({
        sourcePlatform,
        venueId,
        resourceId,
        externalBookingId,
        sourceMessageId: event.UID.value,
        identityConfidence: "temporary",
        status: cancelled ? "cancelled" : "confirmed",
        startAt: start.iso,
        endAt: end.iso,
        timeZone,
        productCode: "",
        summary: `${sourcePlatform === "hourplace" ? "아워플레이스" : sourcePlatform === "spacecloud" ? "스페이스클라우드" : sourcePlatform} 예약`,
        customerHint: "",
        rawRef: `ical:${externalBookingId}`,
        sourceUpdatedAt: event["LAST-MODIFIED"]?.value || "",
        sequence: Number(event.SEQUENCE?.value || 0),
      });
    } catch (error) {
      unknown.push({
        sourcePlatform,
        externalBookingId: maskSensitiveText(event.UID?.value || "unknown"),
        reason: String(error.message || error).slice(0, 160),
      });
    }
  }
  return { events: parsed, unknown, total: events.length };
}
