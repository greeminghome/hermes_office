import assert from "node:assert/strict";
import test from "node:test";
import {
  MEETING_AUTO_ARCHIVE_DELAY_MS,
  hydrateActiveMeetings,
  isMeetingArchiveDue,
  markMeetingComplete,
  meetingArchiveCountdown,
} from "../src/meetingLifecycle.js";

test("completed meetings remain visible for exactly ten minutes", () => {
  const completed = markMeetingComplete({ id: "meeting-1", topic: "테스트" }, 1_000);
  assert.equal(MEETING_AUTO_ARCHIVE_DELAY_MS, 600_000);
  assert.equal(completed.archiveAt, 601_000);
  assert.equal(isMeetingArchiveDue(completed, 600_999), false);
  assert.equal(isMeetingArchiveDue(completed, 601_000), true);
});

test("reload hydration restores completion from the archive record and prunes expired tabs", () => {
  const active = [{ id: "complete", topic: "완료 회의" }, { id: "running", topic: "진행 회의" }];
  const records = [{ id: "complete", status: "complete", completedAt: new Date(10_000).toISOString() }];

  assert.deepEqual(hydrateActiveMeetings(active, records, 20_000).map((meeting) => meeting.id), ["complete", "running"]);
  assert.deepEqual(hydrateActiveMeetings(active, records, 610_000).map((meeting) => meeting.id), ["running"]);
});

test("countdown communicates automatic archival without showing zero minutes", () => {
  const completed = markMeetingComplete({ id: "meeting-1" }, 1_000);
  assert.equal(meetingArchiveCountdown(completed, 2_000), "완료 · 10분 후 보관");
  assert.equal(meetingArchiveCountdown(completed, 600_999), "완료 · 1분 후 보관");
  assert.equal(meetingArchiveCountdown({ status: "discussion" }, 2_000), "진행 중");
});
