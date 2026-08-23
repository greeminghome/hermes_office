export const LIVE_ACTIVITY_KEY = "greeming-hermes-live-activity";
export const LIVE_CHANNEL = "greeming-hermes-live-screen";

export function liveViewerUrl(profileName, sessionId = "") {
  const query = new URLSearchParams({ profile: profileName });
  if (sessionId) query.set("sessionId", sessionId);
  return `/agent-live?${query}`;
}

export function readLiveActivity(profileName, sessionId = "") {
  try {
    const stored = JSON.parse(window.localStorage.getItem(LIVE_ACTIVITY_KEY) || "{}");
    return stored[`${profileName}:${sessionId}`] ?? stored[profileName] ?? null;
  } catch {
    return null;
  }
}

export function publishLiveActivity(profileName, activity, sessionId = "") {
  if (!profileName || !activity?.view?.url) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(LIVE_ACTIVITY_KEY) || "{}");
    const key = sessionId ? `${profileName}:${sessionId}` : profileName;
    const next = { ...stored, [key]: activity };
    window.localStorage.setItem(LIVE_ACTIVITY_KEY, JSON.stringify(next));
    const channel = new BroadcastChannel(LIVE_CHANNEL);
    channel.postMessage({ profileName, sessionId, activity });
    channel.close();
  } catch {
    // localStorage or BroadcastChannel can be unavailable in hardened browsers.
  }
}
