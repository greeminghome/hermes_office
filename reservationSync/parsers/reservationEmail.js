import { maskSensitiveText, temporaryBookingFingerprint } from "../normalization.js";

function header(headers, name) {
  return headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodePart(data = "") {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function collectTextParts(part, target = []) {
  if (!part) return target;
  if (part.body?.data && new Set(["text/plain", "text/html"]).has(part.mimeType)) {
    target.push(decodePart(part.body.data));
  }
  for (const child of part.parts || []) collectTextParts(child, target);
  return target;
}

function cleanHtml(value) {
  return String(value).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function platformFromMessage(from, subject, body) {
  const haystack = `${from} ${subject} ${body.slice(0, 600)}`.toLowerCase();
  if (/spacecloud|스페이스클라우드/.test(haystack)) return "spacecloud";
  if (/naver|네이버/.test(haystack)) return "naver";
  return "";
}

function statusFromText(text) {
  if (/예약\s*(취소|철회)|취소\s*(완료|확정)/i.test(text)) return "cancelled";
  if (/예약\s*(변경|수정)|일정\s*(변경|수정)/i.test(text)) return "changed";
  if (/예약\s*(확정|완료)|결제\s*(완료|승인)/i.test(text)) return "confirmed";
  if (/예약\s*(신청|접수)|결제\s*대기|신규\s*예약|새로운\s*예약|예약.{0,12}(들어왔|접수되)/i.test(text)) return "pending";
  return "unknown";
}

function extractExternalId(text) {
  const match = text.match(/(?:예약\s*(?:번호|ID)|booking\s*(?:number|id))\s*[:：#]?\s*([A-Z0-9][A-Z0-9_-]{3,})/i);
  return match?.[1] || "";
}

function extractInterval(text) {
  const datePattern = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/;
  const preferredAnchor = /(?:이용|사용)\s*(?:일시|일자|날짜|시간|일)\s*[:：]?/gi;
  let dateMatch = null;
  let dateIndex = -1;
  for (const anchor of text.matchAll(preferredAnchor)) {
    const anchorEnd = (anchor.index || 0) + anchor[0].length;
    const nearby = text.slice(anchorEnd, anchorEnd + 160);
    const candidate = nearby.match(datePattern);
    if (!candidate) continue;
    dateMatch = candidate;
    dateIndex = anchorEnd + (candidate.index || 0);
    break;
  }
  if (!dateMatch) {
    dateMatch = text.match(datePattern);
    dateIndex = dateMatch?.index ?? -1;
  }
  if (!dateMatch) return null;
  const [, year, month, day] = dateMatch;
  const tailStart = dateIndex + dateMatch[0].length;
  const tail = text.slice(tailStart, tailStart + 400);
  const tokens = [...tail.matchAll(/(?:(오전|오후|AM|PM)\s*)?([01]?\d|2[0-3])(?::|시)\s*([0-5]\d)?\s*(?:분)?/gi)].slice(0, 2);
  if (tokens.length < 2) return null;
  const hour24 = (token) => {
    const marker = String(token[1] || "").toUpperCase();
    let hour = Number(token[2]);
    if ((marker === "오후" || marker === "PM") && hour < 12) hour += 12;
    if ((marker === "오전" || marker === "AM") && hour === 12) hour = 0;
    return hour;
  };
  const startHour = hour24(tokens[0]);
  const endHour = hour24(tokens[1]);
  const startMinute = tokens[0][3] || "00";
  const endMinute = tokens[1][3] || "00";
  const local = (hour, minute, dayOffset = 0) => {
    const base = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+09:00`);
    base.setTime(base.getTime() + dayOffset * 86_400_000 + Number(hour) * 3_600_000 + Number(minute) * 60_000);
    return base.toISOString();
  };
  const crossesMidnight = Number(endHour) < Number(startHour)
    || (Number(endHour) === Number(startHour) && Number(endMinute) <= Number(startMinute));
  return { startAt: local(startHour, startMinute), endAt: local(endHour, endMinute, crossesMidnight ? 1 : 0) };
}

export function parseReservationEmail(message, { venueId, resourceId = "default-space", timeZone = "Asia/Seoul" } = {}) {
  const headers = message.payload?.headers || [];
  const from = header(headers, "From");
  const subject = header(headers, "Subject");
  const parts = collectTextParts(message.payload);
  const body = cleanHtml(parts.join(" "));
  const platform = platformFromMessage(from, subject, body);
  const text = `${subject} ${body}`;
  const interval = extractInterval(text);
  const status = statusFromText(text);
  let externalBookingId = extractExternalId(text);
  if (!externalBookingId && platform && interval) {
    externalBookingId = temporaryBookingFingerprint({ sourcePlatform: platform, ...interval, productCode: "", customerHint: "" });
  }
  if (!platform || !externalBookingId || !interval || status === "unknown") {
    return {
      state: "unknown",
      reason: [!platform && "플랫폼", !externalBookingId && "예약번호", !interval && "이용시간", status === "unknown" && "상태"]
        .filter(Boolean).join("·") + "을 안전하게 판독하지 못했습니다.",
      metadata: { fromDomain: from.split("@")[1]?.replace(/[>\s].*$/, "") || "", subject: maskSensitiveText(subject) },
    };
  }
  return {
    state: "parsed",
    booking: {
      sourcePlatform: platform,
      venueId,
      resourceId,
      externalBookingId,
      kind: "native_booking",
      status,
      ...interval,
      timeZone,
      summary: `${platform === "naver" ? "네이버" : "스페이스클라우드"} 예약`,
      rawRef: `gmail:${message.id}`,
      sourceUpdatedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : "",
    },
  };
}
