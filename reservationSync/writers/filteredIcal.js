import crypto from "node:crypto";
import { blocksAvailability } from "../config.js";
import { projectionUid } from "../normalization.js";

function escapeIcal(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function utcIcal(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function seoulIcal(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}T${map.hour}${map.minute}${map.second}`;
}

export function secureTokenMatches(expected, provided) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(provided || ""));
  return left.length >= 32 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function filteredIcalForTarget({ ledger, config, targetPlatform }) {
  const events = ledger.activeBookingRows()
    .filter((booking) => booking.source_platform !== targetPlatform)
    .filter((booking) => blocksAvailability(booking.status, config.pendingBlocks))
    .filter((booking) => new Date(booking.end_at).getTime() > Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeIcal(config.venueName)}//Hermes Reservation Sync//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcal(`${config.venueName} ${targetPlatform} blocks`)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT5M",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Seoul",
    "BEGIN:STANDARD",
    "DTSTART:19881009T020000",
    "TZOFFSETFROM:+1000",
    "TZOFFSETTO:+0900",
    "TZNAME:KST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  for (const booking of events) {
    const uid = projectionUid({
      targetPlatform,
      originPlatform: booking.source_platform,
      externalBookingId: booking.external_booking_id,
      venueId: booking.venue_id,
    });
    lines.push(
      "BEGIN:VEVENT",
      `UID:${crypto.createHash("sha256").update(uid).digest("hex").slice(0, 40)}@hermes.office`,
      `DTSTAMP:${utcIcal(booking.updated_at)}`,
      `DTSTART:${seoulIcal(booking.start_at)}`,
      `DTEND:${seoulIcal(booking.end_at)}`,
      "SUMMARY:Reserved",
      "TRANSP:OPAQUE",
      "STATUS:CONFIRMED",
      `SEQUENCE:${Math.max(0, booking.revision - 1)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}
