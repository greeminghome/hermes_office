import crypto from "node:crypto";

export const LIVE_SCREEN_MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
export const LIVE_SCREEN_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const LIVE_SCREEN_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const LIVE_SCREEN_MAX_FRAME_BUFFERED_BYTES = 128 * 1024;
export const LIVE_SCREEN_MAX_TEXT_CHARS = 4096;
export const LIVE_SCREEN_MAX_INPUTS_PER_SECOND = 120;
export const LIVE_SCREEN_MAX_FPS = 18;
export const LIVE_SCREEN_IDLE_FPS = 6;
export const LIVE_SCREEN_INTERACTION_WINDOW_MS = 1500;
export const LIVE_SCREEN_JPEG_QUALITY = 45;

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{1,256}$/;
const MOUSE_TYPES = new Set(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
const MOUSE_BUTTONS = new Set(["none", "left", "middle", "right"]);
const KEY_TYPES = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
const TOUCH_TYPES = new Set(["touchStart", "touchMove", "touchEnd", "touchCancel"]);

function boundedInteger(value, min, max, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boundedNumber(value, min, max, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function shortString(value, max = 64) {
  const text = String(value ?? "");
  return text.length <= max ? text : "";
}

export function liveScreenOriginMatches(request, canonicalOrigin = null) {
  const origin = String(request.headers?.origin || "").trim();
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (canonicalOrigin) return parsed.origin === canonicalOrigin.origin;
    return parsed.host.toLowerCase() === String(request.headers?.host || "").trim().toLowerCase();
  } catch {
    return false;
  }
}

export function validateLiveScreenScope({ profile, sessionId, targetId = "", browserSessionId = "", allowedProfiles, allowDynamicProfiles = false }) {
  if (!PROFILE_PATTERN.test(profile) || (!allowedProfiles.has(profile) && !allowDynamicProfiles)) throw new Error("profile is not allowed");
  if (!IDENTIFIER_PATTERN.test(sessionId)) throw new Error("invalid sessionId");
  if (targetId && !IDENTIFIER_PATTERN.test(targetId)) throw new Error("invalid targetId");
  if (browserSessionId && !IDENTIFIER_PATTERN.test(browserSessionId)) throw new Error("invalid browserSessionId");
  return { profile, sessionId, targetId, browserSessionId };
}

export function sanitizeLiveViewUrl(value = "") {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|auth|session|code/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export class LiveScreenTicketStore {
  constructor({ ttlMs = 15000, maxEntries = 512, now = () => Date.now() } = {}) {
    this.ttlMs = Math.min(Math.max(Number(ttlMs) || 15000, 1000), 60000);
    this.maxEntries = Math.min(Math.max(Number(maxEntries) || 512, 16), 4096);
    this.now = now;
    this.entries = new Map();
  }

  digest(token) {
    return crypto.createHash("sha256").update(String(token)).digest("base64url");
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  issue(scope) {
    this.prune();
    const token = crypto.randomBytes(32).toString("base64url");
    this.entries.set(this.digest(token), { ...scope, expiresAt: this.now() + this.ttlMs });
    return { token, expiresAt: this.now() + this.ttlMs };
  }

  consume(token, binding) {
    const key = this.digest(token);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAt <= this.now()) return null;
    const expected = Buffer.from(String(entry.binding || ""));
    const actual = Buffer.from(String(binding || ""));
    if (!expected.length || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    return entry;
  }

  revoke(profile, sessionId) {
    for (const [key, entry] of this.entries) {
      if (entry.profile === profile && entry.sessionId === sessionId) this.entries.delete(key);
    }
  }
}

export function sanitizeCdpCommand(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = boundedInteger(raw.id, 1, 0x7fffffff);
  const method = String(raw.method || "");
  const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params) ? raw.params : {};
  if (!id || !method) return null;

  if (method === "Target.attachToTarget") {
    if (raw.sessionId || params.targetId !== context.pageId || params.flatten !== true) return null;
    return { id, method, params: { targetId: context.pageId, flatten: true } };
  }
  if (!context.sessionId || raw.sessionId !== context.sessionId) return null;

  if (method === "Page.enable" || method === "Page.stopScreencast") {
    return { id, method, params: {}, sessionId: context.sessionId };
  }
  if (method === "Page.startScreencast") {
    const maxWidth = Math.min(720, boundedInteger(params.maxWidth, 320, 1600, 720));
    const maxHeight = Math.min(405, boundedInteger(params.maxHeight, 240, 1080, 405));
    return {
      id,
      method,
      params: { format: "jpeg", quality: LIVE_SCREEN_JPEG_QUALITY, maxWidth, maxHeight, everyNthFrame: 1 },
      sessionId: context.sessionId,
    };
  }
  if (method === "Page.screencastFrameAck") {
    const frameId = boundedInteger(params.sessionId, 0, 0x7fffffff);
    return frameId === null ? null : { id, method, params: { sessionId: frameId }, sessionId: context.sessionId };
  }
  if (method === "Emulation.setDeviceMetricsOverride") {
    const width = boundedInteger(params.width, 320, 1920);
    const height = boundedInteger(params.height, 240, 1080);
    const deviceScaleFactor = boundedNumber(params.deviceScaleFactor ?? 1, 1, 2);
    const mobile = typeof params.mobile === "boolean" ? params.mobile : null;
    if (!width || !height || deviceScaleFactor === null || mobile === null) return null;
    return { id, method, params: { width, height, deviceScaleFactor, mobile }, sessionId: context.sessionId };
  }
  if (method === "Input.insertText") {
    const text = String(params.text ?? "");
    if (!text || text.length > LIVE_SCREEN_MAX_TEXT_CHARS) return null;
    return { id, method, params: { text }, sessionId: context.sessionId };
  }
  if (method === "Input.dispatchKeyEvent") {
    if (!KEY_TYPES.has(params.type)) return null;
    const key = shortString(params.key);
    const code = shortString(params.code);
    const modifiers = boundedInteger(params.modifiers ?? 0, 0, 15, 0);
    const windowsVirtualKeyCode = boundedInteger(params.windowsVirtualKeyCode ?? 0, 0, 255, 0);
    const nativeVirtualKeyCode = boundedInteger(params.nativeVirtualKeyCode ?? 0, 0, 255, 0);
    if (!key || !code) return null;
    return { id, method, params: { type: params.type, key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode }, sessionId: context.sessionId };
  }
  if (method === "Input.dispatchMouseEvent") {
    if (!MOUSE_TYPES.has(params.type)) return null;
    const width = boundedInteger(context.width, 320, 1920);
    const height = boundedInteger(context.height, 240, 1080);
    const x = boundedNumber(params.x, 0, width ?? -1);
    const y = boundedNumber(params.y, 0, height ?? -1);
    const button = MOUSE_BUTTONS.has(params.button) ? params.button : "none";
    const buttons = boundedInteger(params.buttons ?? 0, 0, 7, 0);
    const clickCount = boundedInteger(params.clickCount ?? 0, 0, 3, 0);
    const deltaX = boundedNumber(params.deltaX ?? 0, -2000, 2000, 0);
    const deltaY = boundedNumber(params.deltaY ?? 0, -2000, 2000, 0);
    const pointerType = ["mouse", "touch", "pen"].includes(params.pointerType) ? params.pointerType : "mouse";
    if (x === null || y === null) return null;
    return { id, method, params: { type: params.type, x, y, button, buttons, clickCount, deltaX, deltaY, pointerType }, sessionId: context.sessionId };
  }
  if (method === "Input.dispatchTouchEvent") {
    if (!TOUCH_TYPES.has(params.type) || !Array.isArray(params.touchPoints) || params.touchPoints.length > 10) return null;
    const width = boundedInteger(context.width, 320, 1920);
    const height = boundedInteger(context.height, 240, 1080);
    if (!width || !height) return null;
    if (["touchStart", "touchMove"].includes(params.type) && params.touchPoints.length === 0) return null;
    if (["touchEnd", "touchCancel"].includes(params.type) && params.touchPoints.length !== 0) return null;
    const touchPoints = [];
    for (const point of params.touchPoints) {
      const x = boundedNumber(point?.x, 0, width);
      const y = boundedNumber(point?.y, 0, height);
      const id = boundedInteger(point?.id, 0, 0x7fffffff);
      const radiusX = boundedNumber(point?.radiusX ?? 1, 0, 100);
      const radiusY = boundedNumber(point?.radiusY ?? 1, 0, 100);
      const force = boundedNumber(point?.force ?? 1, 0, 1);
      if ([x, y, id, radiusX, radiusY, force].some((value) => value === null)) return null;
      touchPoints.push({ x, y, id, radiusX, radiusY, force });
    }
    const modifiers = boundedInteger(params.modifiers ?? 0, 0, 15, 0);
    return { id, method, params: { type: params.type, touchPoints, modifiers }, sessionId: context.sessionId };
  }
  return null;
}
