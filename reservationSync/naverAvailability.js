import { blocksAvailability } from "./config.js";
import { sha256, stableJson } from "./normalization.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function kstParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function kstDateKey(value) {
  const parts = kstParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayStartMs(date) {
  return Date.parse(`${date}T00:00:00+09:00`);
}

export function splitBookingIntoNaverDays(booking, config) {
  const startMs = new Date(booking.start_at).getTime() - config.bufferBeforeMinutes * MINUTE_MS;
  const endMs = new Date(booking.end_at).getTime() + config.bufferAfterMinutes * MINUTE_MS;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const result = [];
  let cursor = dayStartMs(kstDateKey(startMs));
  while (cursor < endMs) {
    const next = cursor + DAY_MS;
    const overlapStart = Math.max(startMs, cursor);
    const overlapEnd = Math.min(endMs, next);
    if (overlapStart < overlapEnd) {
      result.push({
        date: kstDateKey(cursor),
        startMinute: Math.max(0, Math.floor((overlapStart - cursor) / MINUTE_MS)),
        endMinute: Math.min(1440, Math.ceil((overlapEnd - cursor) / MINUTE_MS)),
        bookingKey: booking.booking_key,
        sourcePlatform: booking.source_platform,
      });
    }
    cursor = next;
  }
  return result;
}

export function mergeBusyIntervals(intervals) {
  const sorted = intervals
    .map((item) => ({ startMinute: Math.max(0, item.startMinute), endMinute: Math.min(1440, item.endMinute) }))
    .filter((item) => item.startMinute < item.endMinute)
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  const merged = [];
  for (const item of sorted) {
    const previous = merged.at(-1);
    if (!previous || item.startMinute > previous.endMinute) merged.push({ ...item });
    else previous.endMinute = Math.max(previous.endMinute, item.endMinute);
  }
  return merged;
}

export function availableWindowsAfterBusy(baseline, busyIntervals, minimumDurationMinutes) {
  const busy = mergeBusyIntervals(busyIntervals);
  const windows = [];
  for (const source of baseline.intervals || []) {
    const slotMinutes = Number(source.slotMinutes || baseline.slotMinutes || 60);
    const sourceStart = Number(source.startMinute);
    const sourceEnd = Number(source.lastStartMinute) + slotMinutes;
    let remaining = [{ startMinute: sourceStart, endMinute: sourceEnd }];
    for (const blocked of busy) {
      const next = [];
      for (const range of remaining) {
        if (blocked.endMinute <= range.startMinute || blocked.startMinute >= range.endMinute) {
          next.push(range);
          continue;
        }
        if (blocked.startMinute > range.startMinute) {
          next.push({ startMinute: range.startMinute, endMinute: Math.min(range.endMinute, blocked.startMinute) });
        }
        if (blocked.endMinute < range.endMinute) {
          next.push({ startMinute: Math.max(range.startMinute, blocked.endMinute), endMinute: range.endMinute });
        }
      }
      remaining = next;
    }
    for (const range of remaining) {
      const alignedStart = Math.ceil(range.startMinute / slotMinutes) * slotMinutes;
      const alignedEnd = Math.floor(range.endMinute / slotMinutes) * slotMinutes;
      if (alignedEnd - alignedStart < minimumDurationMinutes) continue;
      windows.push({
        startMinute: alignedStart,
        lastStartMinute: alignedEnd - slotMinutes,
        slotMinutes,
        capacity: Number(source.capacity || baseline.capacity || 1),
        price: Number(source.price || 0),
      });
    }
  }
  return windows;
}

export function canonicalAvailability(value) {
  return {
    date: String(value.date || ""),
    source: String(value.source || ""),
    slotMinutes: Number(value.slotMinutes || 60),
    capacity: Number(value.capacity || 1),
    intervals: (value.intervals || []).map((interval) => ({
      startMinute: Number(interval.startMinute),
      lastStartMinute: Number(interval.lastStartMinute),
      slotMinutes: Number(interval.slotMinutes || value.slotMinutes || 60),
      capacity: Number(interval.capacity || value.capacity || 1),
      price: Number(interval.price || 0),
    })).sort((left, right) => left.startMinute - right.startMinute),
  };
}

export function availabilityFingerprint(value) {
  return sha256(stableJson(canonicalAvailability(value)));
}

export function desiredNaverDayPlans(bookings, config) {
  const byDate = new Map();
  for (const booking of bookings) {
    if (booking.source_platform === "naver") continue;
    if (!blocksAvailability(booking.status, config.pendingBlocks)) continue;
    if (new Date(booking.end_at).getTime() <= Date.now()) continue;
    for (const segment of splitBookingIntoNaverDays(booking, config)) {
      const entries = byDate.get(segment.date) || [];
      entries.push(segment);
      byDate.set(segment.date, entries);
    }
  }
  return [...byDate.entries()].map(([date, entries]) => {
    const busy = mergeBusyIntervals(entries);
    const bookingKeys = [...new Set(entries.map((item) => item.bookingKey))].sort();
    const sources = [...new Set(entries.map((item) => item.sourcePlatform))].sort();
    const desired = { date, busy, bookingKeys, sources };
    return { date, desired, desiredHash: sha256(stableJson(desired)) };
  }).sort((left, right) => left.date.localeCompare(right.date));
}

export const naverAvailabilityContracts = Object.freeze({ kstDateKey, dayStartMs });
