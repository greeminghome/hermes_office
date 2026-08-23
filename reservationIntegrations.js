import { promises as fs } from "node:fs";
import path from "node:path";
import { google } from "googleapis";

export const RESERVATION_GOOGLE_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
]);

const SOURCE_KEYS = Object.freeze(["hourplace", "spacecloud"]);
const SOURCE_HOSTS = Object.freeze({
  hourplace: "calendar-ics.hourplace.co.kr",
  spacecloud: "api.spacecloud.kr",
});
const MAX_ICAL_BYTES = 4 * 1024 * 1024;

function envPath(env, key) {
  return String(env[key] || "").trim();
}

async function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, payload) {
  if (!filePath) throw new Error("예약 OAuth 토큰 저장 경로가 설정되지 않았습니다.");
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

export function googleClientConfig(credentials, redirectUri = "") {
  const section = credentials?.web || credentials?.installed;
  if (!section?.client_id || !section?.client_secret) return null;
  const configuredRedirect = String(redirectUri || section.redirect_uris?.[0] || "").trim();
  if (!configuredRedirect) return null;
  return {
    clientId: section.client_id,
    clientSecret: section.client_secret,
    redirectUri: configuredRedirect,
    type: credentials.web ? "web" : "installed",
  };
}

export function normalizedScopeList(scope) {
  const values = Array.isArray(scope) ? scope : String(scope || "").split(/\s+/);
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

export function reservationSourceConfig(payload) {
  const result = {};
  for (const key of SOURCE_KEYS) {
    const configured = String(payload?.[`${key}_ical_url`] || payload?.[key]?.ical_url || "").trim();
    if (!configured) {
      result[key] = { configured: false, url: "", host: SOURCE_HOSTS[key] };
      continue;
    }
    let parsed;
    try {
      parsed = new URL(configured);
    } catch {
      throw new Error(`${key} iCal URL 형식이 올바르지 않습니다.`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== SOURCE_HOSTS[key]) {
      throw new Error(`${key} iCal URL의 HTTPS 호스트가 허용 목록과 일치하지 않습니다.`);
    }
    result[key] = { configured: true, url: parsed.toString(), host: parsed.hostname };
  }
  return result;
}

export function summarizeIcal(body) {
  const text = String(body || "");
  if (!/^BEGIN:VCALENDAR\r?$/m.test(text) || !/^END:VCALENDAR\r?$/m.test(text)) {
    throw new Error("응답이 올바른 iCal 캘린더가 아닙니다.");
  }
  return {
    events: (text.match(/^BEGIN:VEVENT\r?$/gm) || []).length,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

async function probeIcal(source, fetchImpl = fetch) {
  if (!source.configured) return { configured: false, healthy: false, state: "not-configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(source.url, {
      headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_ICAL_BYTES) throw new Error("iCal 응답이 허용 크기를 초과했습니다.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_ICAL_BYTES) throw new Error("iCal 응답이 허용 크기를 초과했습니다.");
    const summary = summarizeIcal(body);
    return { configured: true, healthy: true, state: "ready", host: source.host, ...summary };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return {
      configured: true,
      healthy: false,
      state: timeout ? "timeout" : "error",
      host: source.host,
      error: timeout ? "응답 시간이 초과되었습니다." : String(error?.message || "iCal 확인 실패").slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function reservationConfig(env) {
  const credentialsPath = envPath(env, "RESERVATION_GOOGLE_CLIENT_SECRET_PATH");
  const tokenPath = envPath(env, "RESERVATION_GOOGLE_TOKEN_PATH");
  const sourcesPath = envPath(env, "RESERVATION_SOURCES_PATH");
  const redirectUri = envPath(env, "RESERVATION_GOOGLE_REDIRECT_URI");
  const [credentials, token, sourcePayload] = await Promise.all([
    readJson(credentialsPath),
    readJson(tokenPath),
    readJson(sourcesPath),
  ]);
  return {
    credentials,
    token,
    sources: reservationSourceConfig(sourcePayload),
    client: googleClientConfig(credentials, redirectUri),
    tokenPath,
  };
}

function googleStatusBase(config) {
  const grantedScopes = normalizedScopeList(config.token?.scope || config.token?.scopes);
  const missingScopes = RESERVATION_GOOGLE_SCOPES.filter((scope) => !grantedScopes.includes(scope));
  return {
    configured: Boolean(config.client),
    clientType: config.client?.type || "",
    connected: Boolean(config.token?.refresh_token),
    account: "",
    scopes: grantedScopes,
    missingScopes,
    gmail: { healthy: null, state: config.token?.refresh_token ? "unchecked" : "not-connected" },
    calendar: { healthy: null, state: config.token?.refresh_token ? "unchecked" : "not-connected" },
  };
}

function oauthClient(config) {
  if (!config.client) throw new Error("예약용 Google OAuth 클라이언트가 설정되지 않았습니다.");
  const client = new google.auth.OAuth2(config.client.clientId, config.client.clientSecret, config.client.redirectUri);
  if (config.token) client.setCredentials(config.token);
  return client;
}

async function persistRefreshedCredentials(config, client) {
  if (!config.tokenPath || !config.token) return;
  const next = { ...config.token, ...client.credentials };
  if (!next.refresh_token && config.token.refresh_token) next.refresh_token = config.token.refresh_token;
  await writeJsonAtomic(config.tokenPath, next);
  config.token = next;
}

export async function createReservationGoogleAuth({ env = process.env } = {}) {
  const config = await reservationConfig(env);
  if (!config.client || !config.token?.refresh_token) {
    throw new Error("예약용 Google 계정이 연결되지 않았습니다.");
  }
  const client = oauthClient(config);
  client.on("tokens", (tokens) => {
    const next = { ...config.token, ...tokens };
    if (!next.refresh_token) next.refresh_token = config.token.refresh_token;
    writeJsonAtomic(config.tokenPath, next).catch((error) => {
      console.error("Reservation OAuth token refresh persistence failed:", error.message);
    });
    config.token = next;
  });
  return client;
}

async function verifyGoogle(config, status) {
  if (!config.client || !config.token?.refresh_token) return status;
  const client = oauthClient(config);
  const gmail = google.gmail({ version: "v1", auth: client });
  const calendar = google.calendar({ version: "v3", auth: client });
  const [gmailResult, calendarResult] = await Promise.allSettled([
    gmail.users.getProfile({ userId: "me" }),
    calendar.calendarList.list({ maxResults: 1, showHidden: false }),
  ]);
  if (gmailResult.status === "fulfilled") {
    status.account = gmailResult.value.data.emailAddress || "";
    status.gmail = { healthy: true, state: "ready" };
  } else {
    status.gmail = { healthy: false, state: "error", error: String(gmailResult.reason?.message || "Gmail 확인 실패").slice(0, 160) };
  }
  if (calendarResult.status === "fulfilled") {
    status.calendar = { healthy: true, state: "ready" };
  } else {
    status.calendar = { healthy: false, state: "error", error: String(calendarResult.reason?.message || "Calendar 확인 실패").slice(0, 160) };
  }
  await persistRefreshedCredentials(config, client).catch(() => {});
  status.connected = status.gmail.healthy === true && status.calendar.healthy === true && status.missingScopes.length === 0;
  return status;
}

export async function getReservationIntegrationStatus({ env = process.env, verify = false, fetchImpl = fetch } = {}) {
  const checkedAt = new Date().toISOString();
  try {
    const config = await reservationConfig(env);
    const googleStatus = googleStatusBase(config);
    if (verify) await verifyGoogle(config, googleStatus);
    const sourceEntries = await Promise.all(SOURCE_KEYS.map(async (key) => {
      const source = config.sources[key];
      const status = verify
        ? await probeIcal(source, fetchImpl)
        : { configured: source.configured, healthy: null, state: source.configured ? "unchecked" : "not-configured", host: source.host };
      return [key, status];
    }));
    return {
      enabled: Boolean(config.client || SOURCE_KEYS.some((key) => config.sources[key].configured)),
      checkedAt,
      google: googleStatus,
      sources: Object.fromEntries(sourceEntries),
    };
  } catch (error) {
    return {
      enabled: false,
      checkedAt,
      error: String(error?.message || "예약 연동 설정을 읽지 못했습니다.").slice(0, 200),
      google: { configured: false, connected: false, account: "", scopes: [], missingScopes: [...RESERVATION_GOOGLE_SCOPES], gmail: { healthy: false, state: "error" }, calendar: { healthy: false, state: "error" } },
      sources: Object.fromEntries(SOURCE_KEYS.map((key) => [key, { configured: false, healthy: false, state: "error", host: SOURCE_HOSTS[key] }])),
    };
  }
}

export async function reservationGoogleAuthorizationUrl({ env = process.env, state }) {
  const config = await reservationConfig(env);
  if (!config.client) throw new Error("예약용 Google OAuth 클라이언트가 설정되지 않았습니다.");
  if (config.client.type !== "web") throw new Error("Hermes 웹 OAuth에는 Google 웹 애플리케이션 클라이언트가 필요합니다.");
  return oauthClient(config).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [...RESERVATION_GOOGLE_SCOPES],
    state,
  });
}

export async function connectReservationGoogle({ env = process.env, code }) {
  if (!code) throw new Error("Google OAuth 승인 코드가 없습니다.");
  const config = await reservationConfig(env);
  if (!config.client) throw new Error("예약용 Google OAuth 클라이언트가 설정되지 않았습니다.");
  const client = oauthClient({ ...config, token: null });
  const result = await client.getToken(code);
  const tokens = result.tokens || {};
  if (!tokens.refresh_token) throw new Error("Google refresh token을 받지 못했습니다. 계정 동의를 다시 진행해주세요.");
  const scopes = normalizedScopeList(tokens.scope);
  const missing = RESERVATION_GOOGLE_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new Error("Gmail 또는 Calendar 권한이 모두 승인되지 않았습니다.");
  await writeJsonAtomic(config.tokenPath, { ...tokens, scopes });
  const verified = await getReservationIntegrationStatus({ env, verify: true });
  if (!verified.google.connected) {
    throw new Error("OAuth 토큰은 저장했지만 Gmail 또는 Calendar API 확인에 실패했습니다.");
  }
  return verified;
}

export async function saveReservationGoogleClient({ env = process.env, credentials }) {
  const clientPath = envPath(env, "RESERVATION_GOOGLE_CLIENT_SECRET_PATH");
  const redirectUri = envPath(env, "RESERVATION_GOOGLE_REDIRECT_URI");
  const clientId = String(credentials?.client_id || "").trim();
  const clientSecret = String(credentials?.client_secret || "").trim();
  if (!clientPath) throw new Error("예약용 Google OAuth 클라이언트 저장 경로가 설정되지 않았습니다.");
  if (!/^\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(clientId)) {
    throw new Error("Google OAuth 클라이언트 ID 형식이 올바르지 않습니다.");
  }
  if (!/^GOCSPX-[A-Za-z0-9_-]{16,}$/.test(clientSecret)) {
    throw new Error("Google OAuth 클라이언트 보안 비밀번호 형식이 올바르지 않습니다.");
  }
  if (!redirectUri.startsWith("https://")) throw new Error("예약용 Google OAuth HTTPS 콜백 주소가 설정되지 않았습니다.");
  await writeJsonAtomic(clientPath, {
    web: {
      client_id: clientId,
      client_secret: clientSecret,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: [redirectUri],
    },
  });
  return { configured: true, clientType: "web", redirectUri };
}
