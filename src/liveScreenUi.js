export const MAX_RELAY_TEXT_LENGTH = 4096;
export const DEFAULT_LIVE_SCREEN_ASPECT_RATIO = 16 / 9;
export const LIVE_SCREEN_CANONICAL_VIEWPORT = Object.freeze({
  width: 1600,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

export function liveScreenAspectRatio(value, fallback = DEFAULT_LIVE_SCREEN_ASPECT_RATIO) {
  const ratio = Number(value);
  const safeFallback = Number(fallback);
  const normalizedFallback = Number.isFinite(safeFallback) && safeFallback >= 0.4 && safeFallback <= 3
    ? safeFallback
    : DEFAULT_LIVE_SCREEN_ASPECT_RATIO;
  return Number.isFinite(ratio) && ratio >= 0.4 && ratio <= 3 ? ratio : normalizedFallback;
}

export function liveScreenConnectionIdentity(view = {}, profileName = "", sessionId = "") {
  const pageId = String(view?.pageId || "");
  if (!pageId) return "";
  return `${String(profileName)}\u0000${String(sessionId)}\u0000${pageId}`;
}

export function liveScreenBlocksFrame(status, hasFrame) {
  return !hasFrame || status === "error" || status === "expired";
}

export function clampRelayText(value = "") {
  return String(value).slice(0, MAX_RELAY_TEXT_LENGTH);
}

export function relayPoint(bounds, frame, clientX, clientY) {
  const width = Number(bounds?.width) || 0;
  const height = Number(bounds?.height) || 0;
  const frameWidth = Number(frame?.width) || 0;
  const frameHeight = Number(frame?.height) || 0;
  if (width <= 0 || height <= 0 || frameWidth <= 0 || frameHeight <= 0) return null;
  const x = Math.max(0, Math.min(frameWidth, (Number(clientX) - Number(bounds.left || 0)) * frameWidth / width));
  const y = Math.max(0, Math.min(frameHeight, (Number(clientY) - Number(bounds.top || 0)) * frameHeight / height));
  return { x, y, scaleX: frameWidth / width, scaleY: frameHeight / height };
}

export function relayViewport(bounds, devicePixelRatio = 1) {
  const width = Math.max(320, Math.min(1600, Math.round(Number(bounds?.width) || 1600)));
  const height = Math.max(240, Math.min(1080, Math.round(Number(bounds?.height) || width * 9 / 16)));
  const deviceScaleFactor = Math.max(1, Math.min(1.5, Number(devicePixelRatio) || 1));
  return { width, height, deviceScaleFactor, mobile: width < 640 };
}

export function liveTicketExpired(expiresAt, now = Date.now()) {
  let raw = Number(expiresAt);
  if (!Number.isFinite(raw) && typeof expiresAt === "string") raw = Date.parse(expiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return false;
  const timestamp = raw < 10_000_000_000 ? raw * 1000 : raw;
  return timestamp <= now;
}

export function relayReconnectDelay(attempt) {
  return Math.min(15_000, 500 * (2 ** Math.max(0, Number(attempt) - 1)));
}
