export const MEETING_AUTO_ARCHIVE_DELAY_MS = 10 * 60 * 1000;

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function meetingCompletedAt(meeting = {}) {
  return timestamp(meeting.completedAt)
    || timestamp(meeting.outcome?.completedAt)
    || (meeting.status === "complete" ? timestamp(meeting.updatedAt) : 0);
}

export function markMeetingComplete(meeting, completedAt = Date.now()) {
  const completed = timestamp(completedAt) || Date.now();
  return {
    ...meeting,
    status: "complete",
    completedAt: completed,
    archiveAt: completed + MEETING_AUTO_ARCHIVE_DELAY_MS,
  };
}

export function meetingArchiveAt(meeting = {}) {
  const explicit = timestamp(meeting.archiveAt);
  if (explicit) return explicit;
  const completed = meetingCompletedAt(meeting);
  return completed ? completed + MEETING_AUTO_ARCHIVE_DELAY_MS : 0;
}

export function isMeetingArchiveDue(meeting, now = Date.now()) {
  const archiveAt = meetingArchiveAt(meeting);
  return meeting?.status === "complete" && archiveAt > 0 && archiveAt <= now;
}

export function hydrateActiveMeetings(stored, records = [], now = Date.now()) {
  const active = Array.isArray(stored) ? stored : stored?.id ? [stored] : [];
  const recordsById = new Map((Array.isArray(records) ? records : []).map((record) => [record.id, record]));
  return active.map((meeting) => {
    const record = recordsById.get(meeting.id);
    if (meeting.status === "complete" || record?.status === "complete") {
      const completedAt = meetingCompletedAt(meeting) || meetingCompletedAt(record) || now;
      return markMeetingComplete({ ...meeting, outcome: meeting.outcome ?? record?.outcome }, completedAt);
    }
    return meeting;
  }).filter((meeting) => !isMeetingArchiveDue(meeting, now));
}

export function meetingArchiveCountdown(meeting, now = Date.now()) {
  const remaining = meetingArchiveAt(meeting) - now;
  if (meeting?.status !== "complete" || remaining <= 0) return meeting?.status === "complete" ? "보관 중" : "진행 중";
  const minutes = Math.max(1, Math.ceil(remaining / 60000));
  return `완료 · ${minutes}분 후 보관`;
}
