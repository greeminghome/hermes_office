import { sha256 } from "./normalization.js";

export function detectBookingConflicts(rows, { bufferBeforeMinutes = 0, bufferAfterMinutes = 0 } = {}) {
  const before = bufferBeforeMinutes * 60_000;
  const after = bufferAfterMinutes * 60_000;
  const active = rows
    .filter((row) => new Set(["pending", "confirmed", "changed"]).has(row.status))
    .map((row) => ({
      ...row,
      bufferedStart: new Date(row.start_at).getTime() - before,
      bufferedEnd: new Date(row.end_at).getTime() + after,
    }))
    .sort((left, right) => left.bufferedStart - right.bufferedStart);
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const left = active[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const right = active[rightIndex];
      if (right.bufferedStart >= left.bufferedEnd) break;
      if (left.resource_id !== right.resource_id || left.booking_key === right.booking_key) continue;
      if (left.source_platform === right.source_platform && left.external_booking_id === right.external_booking_id) continue;
      const pair = [left.id, right.id].sort((a, b) => a - b);
      conflicts.push({
        conflictKey: `c_${sha256(`${pair[0]}|${pair[1]}|${left.resource_id}`).slice(0, 32)}`,
        leftBookingId: pair[0],
        rightBookingId: pair[1],
        resourceId: left.resource_id,
        overlapStartAt: new Date(Math.max(left.bufferedStart, right.bufferedStart)).toISOString(),
        overlapEndAt: new Date(Math.min(left.bufferedEnd, right.bufferedEnd)).toISOString(),
      });
    }
  }
  return conflicts;
}
