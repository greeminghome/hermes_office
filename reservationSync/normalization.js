import crypto from "node:crypto";

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function opaqueBookingKey({ venueId, sourcePlatform, externalBookingId }) {
  return `b_${sha256(`${venueId}|${sourcePlatform}|${externalBookingId}`).slice(0, 32)}`;
}

export function temporaryBookingFingerprint({ sourcePlatform, startAt, endAt, productCode = "", customerHint = "" }) {
  return `tmp_${sha256(`${sourcePlatform}|${startAt}|${endAt}|${productCode}|${customerHint}`).slice(0, 32)}`;
}

export function projectionUid({ targetPlatform, originPlatform, externalBookingId, venueId }) {
  return `greeming:block:${targetPlatform}:${originPlatform}:${sha256(externalBookingId).slice(0, 20)}:${venueId}`;
}

export function googleEventId(bookingKey) {
  return `grm${sha256(bookingKey).slice(0, 40)}`;
}

export function maskSensitiveText(value = "") {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "•••@•••")
    .replace(/(?:\+?82[- ]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}/g, "•••-••••-••••")
    .replace(/\b\d{6,}\b/g, (match) => `${"•".repeat(Math.max(0, match.length - 4))}${match.slice(-4)}`)
    .slice(0, 200);
}

export function normalizeBooking(input) {
  const sourcePlatform = String(input.sourcePlatform || "").trim().toLowerCase();
  const venueId = String(input.venueId || "").trim();
  const resourceId = String(input.resourceId || "default-space").trim();
  const externalBookingId = String(input.externalBookingId || "").trim();
  const startAt = new Date(input.startAt).toISOString();
  const endAt = new Date(input.endAt).toISOString();
  if (!venueId || !sourcePlatform || !externalBookingId) throw new Error("예약 식별 정보가 누락되었습니다.");
  if (startAt >= endAt) throw new Error("예약 종료 시각은 시작 시각보다 뒤여야 합니다.");
  const normalized = {
    venueId,
    resourceId,
    sourcePlatform,
    externalBookingId,
    kind: input.kind === "manual_block" ? "manual_block" : "native_booking",
    status: String(input.status || "unknown").toLowerCase(),
    startAt,
    endAt,
    timeZone: String(input.timeZone || "Asia/Seoul"),
    productCode: maskSensitiveText(input.productCode || ""),
    summary: maskSensitiveText(input.summary || `${sourcePlatform} 예약`),
    customerHint: maskSensitiveText(input.customerHint || ""),
    rawRef: maskSensitiveText(input.rawRef || ""),
  };
  normalized.bookingKey = opaqueBookingKey(normalized);
  normalized.payloadHash = sha256(stableJson(normalized));
  return normalized;
}

export function intervalsOverlap(left, right) {
  return new Date(left.startAt).getTime() < new Date(right.endAt).getTime()
    && new Date(left.endAt).getTime() > new Date(right.startAt).getTime();
}
