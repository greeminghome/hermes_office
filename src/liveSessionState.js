export function liveSessionKey(profileName = "", sessionId = "") {
  const profile = String(profileName || "").trim();
  const session = String(sessionId || "").trim();
  return session ? `${profile}:${session}` : profile;
}

export function liveActivitySessionId(activity) {
  return String(
    activity?.view?.browserSessionId
      || activity?.view?.durableSessionId
      || activity?.view?.sessionId
      || "",
  ).trim();
}

function sessionTimestamp(session) {
  const raw = session?.last_active ?? session?.updated_at ?? session?.started_at ?? 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function liveSessionsForProfile(sessions = [], profileName = "") {
  return sessions
    .filter((session) => session?.profile === profileName && session?.id)
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
}

export function selectLiveSessionId({ profileName = "", selectedSessionIds = {}, sessions = [], activity = null } = {}) {
  const profileSessions = liveSessionsForProfile(sessions, profileName);
  const validIds = new Set(profileSessions.map((session) => String(session.id)));
  if (Object.prototype.hasOwnProperty.call(selectedSessionIds || {}, profileName)
    && !String(selectedSessionIds?.[profileName] || "").trim()) return "";
  const selected = String(selectedSessionIds?.[profileName] || "").trim();
  if (selected && (!validIds.size || validIds.has(selected))) return selected;

  const activitySessionId = liveActivitySessionId(activity);
  if (activitySessionId && (!validIds.size || validIds.has(activitySessionId))) return activitySessionId;
  return String(profileSessions[0]?.id || "");
}

export function activityForLiveSession({ profileName = "", sessionId = "", scopedActivities = {}, profileActivity = null } = {}) {
  const scoped = scopedActivities?.[liveSessionKey(profileName, sessionId)];
  if (scoped) return scoped;
  if (!profileActivity || !sessionId) return profileActivity;
  if (liveActivitySessionId(profileActivity) === sessionId) return profileActivity;
  const activityWithoutMismatchedView = { ...profileActivity };
  delete activityWithoutMismatchedView.view;
  return activityWithoutMismatchedView;
}
