export function isProfileAvailable(profile, activity = {}, workspaceReady = false) {
  if (!profile) return false;
  if (profile.gateway_running || profile.status === "running") return true;
  if (profile.gateway_status === "running" || profile.runtime_status === "running") return true;
  if (profile.available || profile.connected || profile.ws_connected) return true;
  if (activity?.state && !["offline", "error"].includes(activity.state)) return true;
  return Boolean(workspaceReady && profile.name === "default");
}

export function withEffectiveProfileStatus(profile, activity = {}, workspaceReady = false) {
  const available = isProfileAvailable(profile, activity, workspaceReady);
  return {
    ...profile,
    gateway_running: available,
    effective_gateway_running: available,
    gateway_label: available ? "RUNNING" : "OFFLINE",
  };
}
