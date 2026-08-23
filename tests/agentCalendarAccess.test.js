import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAgentCalendarRequest,
  parseAgentCalendarQuery,
  publicCalendarEvent,
} from "../agentCalendarAccess.js";

test("agent calendar authorization requires both a fixed token and an allowed profile", () => {
  const expectedToken = "test-calendar-token-with-at-least-32-bytes";
  const allowedProfiles = new Set(["greeming-seoyun"]);
  assert.equal(authorizeAgentCalendarRequest({
    authorization: `Bearer ${expectedToken}`,
    profile: "greeming-seoyun",
    expectedToken,
    allowedProfiles,
  }), "greeming-seoyun");
  assert.equal(authorizeAgentCalendarRequest({
    authorization: "Bearer wrong",
    profile: "greeming-seoyun",
    expectedToken,
    allowedProfiles,
  }), "");
  assert.equal(authorizeAgentCalendarRequest({
    authorization: `Bearer ${expectedToken}`,
    profile: "greeming-unknown",
    expectedToken,
    allowedProfiles,
  }), "");
});

test("agent calendar query is bounded and defaults to the integrated calendar", () => {
  const query = parseAgentCalendarQuery(new URLSearchParams("limit=25"), {
    now: new Date("2026-08-18T00:00:00.000Z"),
  });
  assert.deepEqual(query, {
    timeMin: "2026-08-18T00:00:00.000Z",
    timeMax: "2026-09-17T00:00:00.000Z",
    calendars: ["integrated"],
    query: "",
    limit: 25,
  });
  assert.throws(() => parseAgentCalendarQuery(new URLSearchParams("calendars=primary")), /캘린더/);
  assert.throws(() => parseAgentCalendarQuery(new URLSearchParams("time_min=2026-01-01&time_max=2026-12-31")), /최대 93일/);
  assert.throws(() => parseAgentCalendarQuery(new URLSearchParams("limit=251")), /1~250/);
});

test("agent calendar event output excludes Google descriptions, links, attendees, and raw ids", () => {
  const event = publicCalendarEvent({
    id: "raw-google-event-id",
    summary: "[예약] 스페이스클라우드 · 그리밍홈",
    description: "private notes",
    htmlLink: "https://calendar.google.com/private",
    attendees: [{ email: "guest@example.com" }],
    start: { dateTime: "2026-08-21T12:00:00+09:00" },
    end: { dateTime: "2026-08-21T16:00:00+09:00" },
    status: "confirmed",
    transparency: "opaque",
    updated: "2026-08-18T01:00:00.000Z",
    extendedProperties: { private: { origin: "spacecloud", bookingKey: "private-booking-key" } },
  }, { key: "integrated", name: "그리밍홈 전체 예약" });
  assert.equal(event.calendar, "integrated");
  assert.equal(event.origin, "spacecloud");
  assert.notEqual(event.id, "raw-google-event-id");
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("private notes"), false);
  assert.equal(serialized.includes("guest@example.com"), false);
  assert.equal(serialized.includes("calendar.google.com"), false);
  assert.equal(serialized.includes("private-booking-key"), false);
});
