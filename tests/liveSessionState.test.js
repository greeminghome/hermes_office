import assert from "node:assert/strict";
import test from "node:test";
import {
  activityForLiveSession,
  liveActivitySessionId,
  liveSessionKey,
  liveSessionsForProfile,
  selectLiveSessionId,
} from "../src/liveSessionState.js";

const sessions = [
  { id: "a-old", profile: "agent-a", last_active: 10 },
  { id: "b-only", profile: "agent-b", last_active: 30 },
  { id: "a-new", profile: "agent-a", last_active: 20 },
];

test("live session keys isolate profiles and durable sessions", () => {
  assert.equal(liveSessionKey("agent-a", "session-1"), "agent-a:session-1");
  assert.notEqual(liveSessionKey("agent-a", "session-1"), liveSessionKey("agent-a", "session-2"));
  assert.notEqual(liveSessionKey("agent-a", "session-1"), liveSessionKey("agent-b", "session-1"));
});

test("profile session lists are filtered and newest-first", () => {
  assert.deepEqual(liveSessionsForProfile(sessions, "agent-a").map((session) => session.id), ["a-new", "a-old"]);
});

test("explicit session selection wins and stale selections fall back safely", () => {
  assert.equal(selectLiveSessionId({ profileName: "agent-a", selectedSessionIds: { "agent-a": "a-old" }, sessions }), "a-old");
  assert.equal(selectLiveSessionId({ profileName: "agent-a", selectedSessionIds: { "agent-a": "" }, sessions }), "");
  assert.equal(selectLiveSessionId({ profileName: "agent-a", selectedSessionIds: { "agent-a": "missing" }, sessions }), "a-new");
  assert.equal(selectLiveSessionId({
    profileName: "agent-a",
    sessions,
    activity: { view: { browserSessionId: "a-old", sessionId: "transport" } },
  }), "a-old");
});

test("session-scoped activity never falls through to another session view", () => {
  const profileActivity = { state: "working", text: "latest", view: { browserSessionId: "a-new", url: "https://new.example" } };
  const scopedActivities = {
    "agent-a:a-old": { state: "idle", text: "older", view: { browserSessionId: "a-old", url: "https://old.example" } },
  };
  assert.equal(liveActivitySessionId(profileActivity), "a-new");
  assert.equal(activityForLiveSession({ profileName: "agent-a", sessionId: "a-old", scopedActivities, profileActivity }).view.url, "https://old.example");

  const missing = activityForLiveSession({ profileName: "agent-a", sessionId: "unknown", scopedActivities, profileActivity });
  assert.equal(missing.text, "latest");
  assert.equal(missing.view, undefined);
});
