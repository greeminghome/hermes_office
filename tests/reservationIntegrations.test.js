import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RESERVATION_GOOGLE_SCOPES,
  getReservationIntegrationStatus,
  googleClientConfig,
  normalizedScopeList,
  reservationGoogleAuthorizationUrl,
  reservationSourceConfig,
  saveReservationGoogleClient,
  summarizeIcal,
} from "../reservationIntegrations.js";

test("reservation Google OAuth requires a usable client and preserves the configured redirect", () => {
  assert.equal(googleClientConfig({}, "https://office.test/callback"), null);
  assert.deepEqual(googleClientConfig({ web: {
    client_id: "client-id",
    client_secret: "client-secret",
    redirect_uris: ["https://old.test/callback"],
  } }, "https://office.test/bridge/reservations/google/callback"), {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://office.test/bridge/reservations/google/callback",
    type: "web",
  });
});

test("reservation sources accept only the fixed HTTPS platform hosts", () => {
  const config = reservationSourceConfig({
    hourplace_ical_url: "https://calendar-ics.hourplace.co.kr/private/hourplace.ics",
    spacecloud_ical_url: "https://api.spacecloud.kr/partner/reservations/ical?opaque=secret",
  });
  assert.equal(config.hourplace.configured, true);
  assert.equal(config.spacecloud.configured, true);
  assert.throws(() => reservationSourceConfig({
    hourplace_ical_url: "https://calendar-ics.hourplace.co.kr.evil.test/private.ics",
  }), /허용 목록/);
  assert.throws(() => reservationSourceConfig({
    spacecloud_ical_url: "http://api.spacecloud.kr/private.ics",
  }), /HTTPS/);
});

test("iCal summary rejects non-calendar responses and counts events", () => {
  assert.throws(() => summarizeIcal("<html>login</html>"), /올바른 iCal/);
  assert.deepEqual(summarizeIcal([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:first",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:second",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")), { events: 2, bytes: 120 });
});

test("reservation status never returns raw iCal URLs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-integrations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientPath = path.join(root, "client.json");
  const sourcesPath = path.join(root, "sources.json");
  await writeFile(clientPath, JSON.stringify({ web: {
    client_id: "public-client-id",
    client_secret: "private-client-secret",
    redirect_uris: ["https://office.test/bridge/reservations/google/callback"],
  } }));
  await writeFile(sourcesPath, JSON.stringify({
    hourplace_ical_url: "https://calendar-ics.hourplace.co.kr/private/secret-hourplace.ics",
    spacecloud_ical_url: "https://api.spacecloud.kr/partner/reservations/ical?ical_uid=secret-spacecloud",
  }));
  const status = await getReservationIntegrationStatus({ env: {
    RESERVATION_GOOGLE_CLIENT_SECRET_PATH: clientPath,
    RESERVATION_GOOGLE_TOKEN_PATH: path.join(root, "token.json"),
    RESERVATION_SOURCES_PATH: sourcesPath,
    RESERVATION_GOOGLE_REDIRECT_URI: "https://office.test/bridge/reservations/google/callback",
  } });
  assert.equal(status.google.configured, true);
  assert.equal(status.google.connected, false);
  assert.equal(status.sources.hourplace.configured, true);
  assert.equal(status.sources.spacecloud.configured, true);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("secret-hourplace"), false);
  assert.equal(serialized.includes("secret-spacecloud"), false);
  assert.equal(serialized.includes("private-client-secret"), false);
});

test("Google authorization URL requests offline Gmail and Calendar access with state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-oauth-url-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientPath = path.join(root, "client.json");
  await writeFile(clientPath, JSON.stringify({ web: {
    client_id: "public-client-id.apps.googleusercontent.com",
    client_secret: "private-client-secret",
    redirect_uris: ["https://office.test/bridge/reservations/google/callback"],
  } }));
  const authorizationUrl = await reservationGoogleAuthorizationUrl({
    env: {
      RESERVATION_GOOGLE_CLIENT_SECRET_PATH: clientPath,
      RESERVATION_GOOGLE_TOKEN_PATH: path.join(root, "token.json"),
      RESERVATION_GOOGLE_REDIRECT_URI: "https://office.test/bridge/reservations/google/callback",
    },
    state: "signed-state",
  });
  const parsed = new URL(authorizationUrl);
  assert.equal(parsed.origin, "https://accounts.google.com");
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "consent");
  assert.equal(parsed.searchParams.get("state"), "signed-state");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://office.test/bridge/reservations/google/callback");
  const scopes = normalizedScopeList(parsed.searchParams.get("scope"));
  assert.deepEqual(scopes, [...RESERVATION_GOOGLE_SCOPES].sort());
});

test("scope normalization is deterministic", () => {
  assert.deepEqual(normalizedScopeList("calendar gmail calendar"), ["calendar", "gmail"]);
});

test("Hermes stores only a validated web OAuth client with its fixed callback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-client-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientPath = path.join(root, "google-client.json");
  const redirectUri = "https://office.test/bridge/reservations/google/callback";
  await assert.rejects(() => saveReservationGoogleClient({
    env: { RESERVATION_GOOGLE_CLIENT_SECRET_PATH: clientPath, RESERVATION_GOOGLE_REDIRECT_URI: redirectUri },
    credentials: { client_id: "not-google", client_secret: "not-google" },
  }), /클라이언트 ID 형식/);
  const saved = await saveReservationGoogleClient({
    env: { RESERVATION_GOOGLE_CLIENT_SECRET_PATH: clientPath, RESERVATION_GOOGLE_REDIRECT_URI: redirectUri },
    credentials: {
      client_id: "175571625205-testclient.apps.googleusercontent.com",
      client_secret: "GOCSPX-1234567890abcdefghijkl",
    },
  });
  assert.deepEqual(saved, { configured: true, clientType: "web", redirectUri });
  const stored = JSON.parse(await readFile(clientPath, "utf8"));
  assert.equal(stored.web.redirect_uris[0], redirectUri);
  assert.equal(stored.web.client_id, "175571625205-testclient.apps.googleusercontent.com");
  assert.equal(stored.web.client_secret, "GOCSPX-1234567890abcdefghijkl");
});
