const PROFILE_ID_PATTERN = /^(?:default|[a-z0-9][a-z0-9-]{1,63})$/;
const PROFILE_COLORS = ["#6f91b3", "#8f7bb3", "#6f9c86", "#b48662", "#9a7182", "#7b8fbc", "#8b9270", "#a46f63"];

function profileId(value) {
  const id = String(value || "").trim();
  return PROFILE_ID_PATTERN.test(id) ? id : "";
}

export function orderedProfileNames(profiles = [], preferredOrder = []) {
  const discovered = new Set((Array.isArray(profiles) ? profiles : [])
    .map((profile) => profileId(typeof profile === "string" ? profile : profile?.name ?? profile?.id))
    .filter(Boolean));
  const preferred = [...new Set((Array.isArray(preferredOrder) ? preferredOrder : []).map(profileId).filter(Boolean))];
  if (!discovered.size) return preferred;
  return [
    ...preferred.filter((name) => discovered.has(name)),
    ...[...discovered].filter((name) => !preferred.includes(name)).sort((left, right) => left.localeCompare(right)),
  ];
}

function generatedColor(profileName) {
  let hash = 0;
  for (const character of profileName) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return PROFILE_COLORS[hash % PROFILE_COLORS.length];
}

function generatedName(profileName) {
  const tail = String(profileName || "agent").split("-").filter(Boolean).at(-1) || "agent";
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function generatedInitials(name) {
  const words = String(name || "AI").trim().split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : words[0]?.slice(0, 2);
  return String(initials || "AI").toUpperCase();
}

export function profileDisplayMeta(profileName, profiles = [], catalog = {}) {
  if (catalog?.[profileName]) return catalog[profileName];
  const profile = (Array.isArray(profiles) ? profiles : []).find((item) => profileId(item?.name ?? item?.id) === profileName) || {};
  const name = String(profile.display_name || profile.displayName || profile.label || generatedName(profileName)).trim();
  return {
    name,
    role: String(profile.role || profile.description || "AI 구성원").trim(),
    initials: String(profile.initials || generatedInitials(name)).slice(0, 3),
    color: String(profile.color || generatedColor(profileName)),
    avatar: String(profile.avatar || ""),
  };
}
