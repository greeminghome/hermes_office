const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/i;

function cleanUrl(value) {
  if (!value) return "";
  const match = String(value).match(URL_PATTERN);
  if (!match) return "";
  try {
    const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function activityViewFromPayload(payload = {}) {
  const candidates = [
    payload.url,
    payload.current_url,
    payload.currentUrl,
    payload.page_url,
    payload.pageUrl,
    payload.href,
    payload.context,
    payload.summary,
    payload.text,
    payload.message,
  ];
  const url = candidates.map(cleanUrl).find(Boolean);
  if (!url) return null;

  const width = Number(
    payload.viewportWidth ??
    payload.viewport_width ??
    payload.width ??
    payload.screenWidth ??
    payload.screen_width
  );
  const height = Number(
    payload.viewportHeight ??
    payload.viewport_height ??
    payload.height ??
    payload.screenHeight ??
    payload.screen_height
  );
  const aspectRatio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : null;

  return {
    url,
    title: payload.title || payload.page_title || payload.name || new URL(url).hostname,
    tool: payload.name || "browser",
    aspectRatio,
    updatedAt: Date.now(),
  };
}

export function mergeActivityView(activity, payload) {
  const view = activityViewFromPayload(payload);
  return view ? { ...activity, view } : activity;
}
