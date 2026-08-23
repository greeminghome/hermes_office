export const MINJUN_UI_PROFILE_ID = "default";
export const MINJUN_HERMES_PROFILE_ID = "greeming-minjun";

export function toUiProfileId(profile) {
  return profile === MINJUN_HERMES_PROFILE_ID ? MINJUN_UI_PROFILE_ID : profile;
}

export function toHermesProfileId(profile) {
  return profile === MINJUN_UI_PROFILE_ID ? MINJUN_HERMES_PROFILE_ID : profile;
}

export function normalizeUiProfiles(profiles = []) {
  if (!Array.isArray(profiles)) return [];
  const normalized = new Map();

  for (const item of profiles) {
    if (!item || typeof item !== "object") continue;
    const sourceId = String(item.name ?? item.id ?? "").trim();
    if (!sourceId) continue;
    const uiId = toUiProfileId(sourceId);
    const profile = { ...item, name: uiId };
    const existing = normalized.get(uiId);
    if (!existing) {
      normalized.set(uiId, { profile, sourceId });
      continue;
    }

    const sourceIsHermesCanonical = sourceId === toHermesProfileId(uiId);
    const existingIsHermesCanonical = existing.sourceId === toHermesProfileId(uiId);
    const preferred = sourceIsHermesCanonical && !existingIsHermesCanonical
      ? { ...existing.profile, ...profile }
      : { ...profile, ...existing.profile };
    normalized.set(uiId, {
      profile: {
        ...preferred,
        name: uiId,
        gateway_running: Boolean(existing.profile.gateway_running || profile.gateway_running),
      },
      sourceId: sourceIsHermesCanonical ? sourceId : existing.sourceId,
    });
  }

  return [...normalized.values()].map(({ profile }) => profile);
}

export function normalizeUiSession(session, fallbackProfile = "") {
  if (!session || typeof session !== "object") return session;
  const sourceProfile = String(session.profile ?? fallbackProfile ?? "").trim();
  return sourceProfile ? { ...session, profile: toUiProfileId(sourceProfile) } : session;
}

export function withHermesProfile(params = {}) {
  if (!Object.prototype.hasOwnProperty.call(params, "profile")) return params;
  const profile = toHermesProfileId(params.profile);
  return profile === params.profile ? params : { ...params, profile };
}
