import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reservationSyncConfig } from "../reservationSync/config.js";
import { detectBookingConflicts } from "../reservationSync/conflictDetector.js";
import { ReservationLedger } from "../reservationSync/ledger.js";
import { googleEventId, maskSensitiveText, normalizeBooking, projectionUid } from "../reservationSync/normalization.js";
import { parseIcal } from "../reservationSync/parsers/ical.js";
import { parseReservationEmail } from "../reservationSync/parsers/reservationEmail.js";
import { planBooking, reconcileNaverAvailabilityPlans } from "../reservationSync/planner.js";
import { availabilityFingerprint, availableWindowsAfterBusy, canonicalAvailability } from "../reservationSync/naverAvailability.js";
import { filteredIcalForTarget, secureTokenMatches } from "../reservationSync/writers/filteredIcal.js";
import { applyBrowserPlatformProjection, browserPlatformContracts } from "../reservationSync/writers/browserPlatform.js";
import { applyNaverAvailabilityDay, naverAvailabilityWriterContracts } from "../reservationSync/writers/naverAvailability.js";
import { browserSessionPageContracts, managedReservationSessionPage, RESERVATION_BROWSER_SESSIONS } from "../reservationSync/writers/browserSessionPage.js";
import { createReservationSyncController } from "../reservationSync/index.js";
import { processGmailHistory, sortGmailMessagesOldestFirst } from "../reservationSync/connectors/gmail.js";
import { hourplacePublicIcalUrl } from "../reservationSync/connectors/googleCalendar.js";

async function ledgerFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-ledger-"));
  const ledger = new ReservationLedger({ databasePath: path.join(root, "ledger.sqlite"), backupRoot: path.join(root, "backups") });
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  ledger.configureVenue({ id: "demo-venue", name: "테스트 공간", resourceId: "main", timeZone: "Asia/Seoul" });
  return ledger;
}

function booking(overrides = {}) {
  return {
    sourcePlatform: "hourplace",
    venueId: "demo-venue",
    resourceId: "main",
    externalBookingId: "HP-12345678",
    status: "confirmed",
    startAt: "2099-08-20T05:00:00.000Z",
    endAt: "2099-08-20T07:00:00.000Z",
    timeZone: "Asia/Seoul",
    summary: "아워플레이스 예약",
    ...overrides,
  };
}

test("reservation sync defaults to fail-safe shadow policies", () => {
  const config = reservationSyncConfig({ RESERVATION_DATA_ROOT: "/tmp/reservations" });
  assert.equal(config.enabled, false);
  assert.equal(config.writeMode, "shadow");
  assert.equal(config.pendingBlocks, false);
  assert.equal(config.googleWriteEnabled, false);
  assert.equal(config.hourplaceFeedEnabled, false);
  assert.equal(config.naverAvailabilityEnabled, false);
  assert.equal(config.spacecloudWriteEnabled, false);
  assert.equal(config.browserHealthMs, 300_000);
  assert.equal(config.venueName, "Hermes Office");
  assert.equal(config.naver.bizId, "");
  assert.equal(config.naver.productId, "");
  assert.equal(config.spacecloud.productId, "");
  assert.equal(config.spacecloud.spaceId, "");
  assert.throws(() => reservationSyncConfig({ RESERVATION_WRITE_MODE: "unsafe" }), /shadow or write/);
});

test("reservation browser pages use stable isolated session targets that Live Screen can reopen", async () => {
  const page = { evaluate: async () => {} };
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "target-naver" } }),
      detach: async () => {},
    }),
  };
  let requestedUrl = "";
  const result = await managedReservationSessionPage({ contexts: () => [context] }, {
    browserCdpUrl: "http://hermes-agent:9405",
    browserTimeoutMs: 1_000,
  }, "naver", {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ targetId: "target-naver" }) };
    },
  });
  assert.equal(result.page, page);
  assert.equal(result.sessionId, RESERVATION_BROWSER_SESSIONS.naver);
  assert.equal(requestedUrl, "http://hermes-agent:9405/__session_target?session=reservation-naver-ops");
  assert.equal(browserSessionPageContracts.sessionTargetUrl("https://browser.example/cdp/", "reservation-spacecloud-ops"), "https://browser.example/cdp/__session_target?session=reservation-spacecloud-ops");
});

test("browser writer health distinguishes ready, auth, connectivity, and UI failures without enabling writes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-writer-health-"));
  const controller = createReservationSyncController({
    env: {
      RESERVATION_SYNC_ENABLED: "true",
      RESERVATION_WRITE_MODE: "write",
      RESERVATION_DATA_ROOT: root,
      RESERVATION_BROWSER_CDP_URL: "http://browser.test:9405",
      RESERVATION_NAVER_AVAILABILITY_ENABLED: "false",
      RESERVATION_SPACECLOUD_WRITE_ENABLED: "false",
    },
    writerProbes: {
      naver: async () => ({ authenticated: true, managementUiReady: true }),
      spacecloud: async () => { throw new Error("SpaceCloud 로그인이 필요합니다."); },
    },
  });
  t.after(async () => {
    controller.stop();
    await rm(root, { recursive: true, force: true });
  });

  const first = await controller.syncWriterHealth("test");
  assert.equal(first.state, "attention");
  assert.deepEqual(Object.fromEntries(first.results.map((item) => [item.platform, item.state])), {
    naver: "ready",
    spacecloud: "auth-required",
  });
  controller.ensureLedger().updateCheckpoint("naver-browser-writer", {
    lastSuccessAt: "2026-08-17T00:00:00.000Z",
    metadata: { state: "ready" },
  });
  let status = controller.status();
  assert.equal(status.platformWriters.naver, "shadow");
  assert.equal(status.platformWriters.spacecloud, "shadow");
  assert.equal(status.platformWriterHealth.naver.enabled, false);
  assert.equal(status.platformWriterHealth.naver.authenticated, true);
  assert.equal(status.platformWriterHealth.spacecloud.authenticated, false);
  assert.equal(status.operational.connectors.some((item) => item.connector === "naver-browser-writer"), false);

  controller.writerProbes = {
    naver: async () => { throw new Error("CDP version endpoint returned 503"); },
    spacecloud: async () => { throw new Error("SpaceCloud 예약 캘린더 구조가 예상과 다릅니다."); },
  };
  const second = await controller.syncWriterHealth("test");
  assert.deepEqual(Object.fromEntries(second.results.map((item) => [item.platform, item.state])), {
    naver: "unreachable",
    spacecloud: "degraded",
  });
  status = controller.status();
  assert.equal(status.platformWriterHealth.naver.state, "unreachable");
  assert.equal(status.platformWriterHealth.spacecloud.state, "degraded");
  assert.equal(status.operational.connectors.find((item) => item.connector === "naver-availability-writer").failureCount, 1);
  assert.equal(status.operational.connectors.find((item) => item.connector === "spacecloud-browser-writer").failureCount, 2);
});

test("card-payment operations block only confirmed bookings and expose authenticated Gmail push", () => {
  const env = {
    RESERVATION_SYNC_ENABLED: "true",
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_PENDING_BLOCKS: "false",
    RESERVATION_BUFFER_BEFORE_MINUTES: "0",
    RESERVATION_BUFFER_AFTER_MINUTES: "0",
    RESERVATION_GMAIL_INGEST_ENABLED: "true",
    RESERVATION_GMAIL_TOPIC: "projects/example-project/topics/hermes-gmail-reservations",
    RESERVATION_GMAIL_PUSH_AUDIENCE: "https://office.test/webhooks/google/gmail",
    RESERVATION_GMAIL_PUSH_SERVICE_ACCOUNT: "hermes-gmail-push@example-project.iam.gserviceaccount.com",
  };
  const config = reservationSyncConfig(env);
  assert.equal(config.pendingBlocks, false);
  assert.equal(config.bufferBeforeMinutes, 0);
  assert.equal(config.bufferAfterMinutes, 0);
  assert.equal(config.gmailTopic, "projects/example-project/topics/hermes-gmail-reservations");

  const status = createReservationSyncController({ env }).status();
  assert.equal(status.gmailPush, "enabled");
  assert.deepEqual(status.policy, {
    pendingBlocks: false,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    timeZone: "Asia/Seoul",
  });
});

test("reservation worker coalesces overlapping scheduler ticks", async () => {
  const controller = createReservationSyncController({
    env: { RESERVATION_DATA_ROOT: "/tmp/reservations" },
  });
  let calls = 0;
  let release;
  controller.processWorkOnce = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { processed: 1, conflicts: 0 };
  };

  const first = controller.processWork();
  const second = controller.processWork();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { processed: 1, conflicts: 0 },
    { processed: 1, conflicts: 0 },
  ]);
});

test("booking identifiers and Google event IDs are deterministic and opaque", () => {
  const first = normalizeBooking(booking());
  const second = normalizeBooking(booking());
  assert.equal(first.bookingKey, second.bookingKey);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.match(googleEventId(first.bookingKey), /^grm[a-f0-9]{40}$/);
  assert.equal(projectionUid({ targetPlatform: "naver", originPlatform: "hourplace", externalBookingId: "secret", venueId: "demo-venue" })
    .includes("secret"), false);
  assert.equal(maskSensitiveText("010-1234-5678 test@example.com 123456789"), "•••-••••-•••• •••@••• •••••6789");
});

test("iCal parser unfolds events, converts Seoul time to UTC, and quarantines recurrence", () => {
  const parsed = parseIcal([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:space-1",
    "DTSTART;TZID=Asia/Seoul:20260820T140000",
    "DTEND;TZID=Asia/Seoul:20260820T160000",
    "SUMMARY:Private customer",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:repeat-1",
    "DTSTART;TZID=Asia/Seoul:20260821T140000",
    "DTEND;TZID=Asia/Seoul:20260821T160000",
    "RRULE:FREQ=WEEKLY",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"), { sourcePlatform: "spacecloud", venueId: "demo-venue", resourceId: "main" });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.unknown.length, 1);
  assert.equal(parsed.events[0].startAt, "2026-08-20T05:00:00.000Z");
  assert.equal(parsed.events[0].endAt, "2026-08-20T07:00:00.000Z");
  assert.equal(parsed.events[0].summary, "스페이스클라우드 예약");
  const rotatedUid = parseIcal([
    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:rotated-space-uid",
    "DTSTART;TZID=Asia/Seoul:20260820T140000", "DTEND;TZID=Asia/Seoul:20260820T160000",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n"), { sourcePlatform: "spacecloud", venueId: "demo-venue", resourceId: "main" });
  assert.equal(rotatedUid.events[0].externalBookingId, parsed.events[0].externalBookingId);
  assert.notEqual(rotatedUid.events[0].sourceMessageId, parsed.events[0].sourceMessageId);
});

test("ledger is idempotent, revisions only on change, and jobs survive reopen", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-reopen-"));
  const databasePath = path.join(root, "ledger.sqlite");
  const backupRoot = path.join(root, "backups");
  const firstLedger = new ReservationLedger({ databasePath, backupRoot });
  firstLedger.configureVenue({ id: "demo-venue", name: "테스트 공간", resourceId: "main", timeZone: "Asia/Seoul" });
  const first = firstLedger.ingestBooking(booking(), { sourceMessageId: "m-1" });
  const duplicate = firstLedger.ingestBooking(booking(), { sourceMessageId: "m-1" });
  const changed = firstLedger.ingestBooking(booking({ endAt: "2099-08-20T08:00:00.000Z" }), { sourceMessageId: "m-2" });
  assert.equal(first.created, true);
  assert.equal(duplicate.changed, false);
  assert.equal(changed.revision, 2);
  firstLedger.close();
  const reopened = new ReservationLedger({ databasePath, backupRoot });
  t.after(async () => {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(reopened.listBookings().length, 1);
  const jobs = reopened.claimJobs(10);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((item) => item.type), ["plan-booking", "plan-booking"]);
});

test("older source updates cannot overwrite a newer reservation state", async (t) => {
  const ledger = await ledgerFixture(t);
  const confirmed = ledger.ingestBooking(booking({ sourcePlatform: "naver", externalBookingId: "NV-ORDER-1" ,
    status: "confirmed", sourceUpdatedAt: "2026-08-18T00:00:00.000Z" }), { sourceMessageId: "newer" });
  const stale = ledger.ingestBooking(booking({ sourcePlatform: "naver", externalBookingId: "NV-ORDER-1",
    status: "pending", sourceUpdatedAt: "2026-08-17T00:00:00.000Z" }), { sourceMessageId: "older" });
  assert.equal(confirmed.booking.status, "confirmed");
  assert.equal(stale.stale, true);
  assert.equal(stale.changed, false);
  assert.equal(ledger.listBookings()[0].status, "confirmed");
  assert.equal(ledger.planningBookingRows().length, 1);
});

test("Gmail messages are applied oldest first so the newest state wins", () => {
  const sorted = sortGmailMessagesOldestFirst([
    { id: "newest", internalDate: "200" },
    { id: "oldest", internalDate: "100" },
  ]);
  assert.deepEqual(sorted.map((message) => message.id), ["oldest", "newest"]);
});

test("Gmail push history preserves the users.watch expiration checkpoint", async () => {
  let checkpointPatch;
  const ledger = {
    startSyncRun: () => 1,
    getCheckpoint: () => ({ cursor: "", metadata: { expiration: "2099-01-01T00:00:00.000Z" } }),
    updateCheckpoint: (_connector, patch) => { checkpointPatch = patch; },
    finishSyncRun: () => {},
  };
  const result = await processGmailHistory({
    ledger,
    config: { gmailIngestEnabled: true },
    historyId: "123456789",
  });
  assert.equal(result.state, "primed");
  assert.deepEqual(checkpointPatch.metadata, {
    expiration: "2099-01-01T00:00:00.000Z",
    primed: true,
  });
});

test("missing iCal events are cancelled only after two healthy scans", async (t) => {
  const ledger = await ledgerFixture(t);
  ledger.ingestBooking(booking({ startAt: "2099-08-20T05:00:00.000Z", endAt: "2099-08-20T07:00:00.000Z",
    rawRef: "ical:HP-12345678" }));
  const first = ledger.markSourceMissing("hourplace", []);
  assert.equal(first.cancelled, 0);
  assert.equal(ledger.listBookings()[0].status, "confirmed");
  const preserved = ledger.markSourceMissing("hourplace", [], { anomalous: true });
  assert.equal(preserved.preserved, true);
  assert.equal(ledger.listBookings()[0].status, "confirmed");
  const second = ledger.markSourceMissing("hourplace", []);
  assert.equal(second.cancelled, 1);
  assert.equal(ledger.listBookings()[0].status, "cancelled");
});

test("iCal disappearance never cancels Gmail-only or historical reservations", async (t) => {
  const ledger = await ledgerFixture(t);
  ledger.ingestBooking(booking({ sourcePlatform: "spacecloud", externalBookingId: "SC-GMAIL-1",
    startAt: "2099-08-20T05:00:00.000Z", endAt: "2099-08-20T07:00:00.000Z", rawRef: "gmail:message-1" }));
  ledger.ingestBooking(booking({ sourcePlatform: "spacecloud", externalBookingId: "SC-ICAL-PAST",
    startAt: "2020-08-20T05:00:00.000Z", endAt: "2020-08-20T07:00:00.000Z", rawRef: "ical:SC-ICAL-PAST" }));
  ledger.markSourceMissing("spacecloud", []);
  ledger.markSourceMissing("spacecloud", []);
  assert.deepEqual(ledger.listBookings().map((item) => item.status), ["confirmed", "confirmed"]);
});

test("planner excludes the origin and keeps sales-channel writers in shadow", async (t) => {
  const ledger = await ledgerFixture(t);
  const result = ledger.ingestBooking(booking());
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_GOOGLE_WRITE_ENABLED: "false",
  });
  const projections = planBooking(ledger, result.booking.id, config);
  assert.deepEqual(projections.map((item) => item.target_platform).sort(), ["google", "naver", "spacecloud"]);
  assert.equal(projections.every((item) => item.state === "shadow"), true);
});

test("write mode aggregates NAVER availability and keeps SpaceCloud as a browser job", async (t) => {
  const ledger = await ledgerFixture(t);
  const result = ledger.ingestBooking(booking());
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_WRITE_MODE: "write",
    RESERVATION_HOURPLACE_FEED_ENABLED: "true",
    RESERVATION_NAVER_AVAILABILITY_ENABLED: "true",
    RESERVATION_SPACECLOUD_WRITE_ENABLED: "true",
  });
  const projections = planBooking(ledger, result.booking.id, config);
  assert.deepEqual(Object.fromEntries(projections.map((item) => [item.target_platform, item.state])), {
    google: "shadow",
    naver: "aggregate",
    spacecloud: "desired",
  });
  const jobs = ledger.claimJobs(20);
  assert.equal(jobs.filter((item) => item.type === "apply-sales").length, 1);
  reconcileNaverAvailabilityPlans(ledger, config);
  const availabilityJobs = ledger.claimJobs(20);
  assert.equal(availabilityJobs.filter((item) => item.type === "apply-naver-availability").length, 1);
});

test("NAVER and SpaceCloud bookings project to the dedicated Hourplace Google iCal", async (t) => {
  const ledger = await ledgerFixture(t);
  const result = ledger.ingestBooking(booking({ sourcePlatform: "naver", externalBookingId: "NV-ICAL-1" }));
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_HOURPLACE_FEED_ENABLED: "true",
  });
  const projection = planBooking(ledger, result.booking.id, config)
    .find((item) => item.target_platform === "hourplace");
  assert.equal(projection.state, "desired");
  assert.equal(projection.desired_action, "ensure");
  const jobs = ledger.claimJobs(20);
  assert.equal(jobs.filter((item) => item.type === "apply-hourplace-feed").length, 1);
  assert.equal(
    hourplacePublicIcalUrl("calendar id@group.calendar.google.com"),
    "https://calendar.google.com/calendar/ical/calendar%20id%40group.calendar.google.com/public/basic.ics",
  );
});

test("SpaceCloud browser writer expands partial hours, reads back, and removes only managed projections", async (t) => {
  assert.equal(
    browserPlatformContracts.rewrittenCdpWebSocketUrl(
      "http://hermes-agent:9223",
      "ws://127.0.0.1:9222/devtools/browser/session-id",
    ),
    "ws://hermes-agent:9223/devtools/browser/session-id",
  );
  const ledger = await ledgerFixture(t);
  const result = ledger.ingestBooking(booking({
    startAt: "2099-08-20T14:30:00.000Z",
    endAt: "2099-08-20T16:15:00.000Z",
  }));
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_WRITE_MODE: "write",
    RESERVATION_SPACECLOUD_WRITE_ENABLED: "true",
  });
  const projection = planBooking(ledger, result.booking.id, config).find((item) => item.target_platform === "spacecloud");
  const segments = browserPlatformContracts.targetSegments(ledger.getBookingRowById(result.booking.id), projection);
  assert.deepEqual(segments.map((item) => [item.date, item.startHour, item.endHour]), [
    ["2099-08-20", 23, 24],
    ["2099-08-21", 0, 2],
  ]);
  assert.equal(segments.every((item) => /^[가-힣A-Za-z0-9]{1,30}$/.test(item.name)), true);

  const managed = new Map();
  const adapter = {
    ensure: async (item) => {
      const created = { ...item, id: `SC-${managed.size + 1}` };
      managed.set(created.id, created);
      return created;
    },
    read: async (item) => managed.has(item.id),
    remove: async (item) => {
      managed.delete(item.id);
      return { ...item, absent: true };
    },
  };
  const applied = await applyBrowserPlatformProjection({
    ledger,
    config,
    projectionId: projection.id,
    adapters: { spacecloud: adapter },
  });
  assert.equal(applied.state, "applied");
  assert.equal(managed.size, 2);
  const stored = ledger.getProjection(projection.id);
  assert.equal(stored.state, "applied");
  assert.equal(browserPlatformContracts.parseReference(stored.external_ref).items.length, 2);

  ledger.upsertProjection({
    bookingId: result.booking.id,
    targetPlatform: "spacecloud",
    resourceId: "main",
    projectionUid: stored.projection_uid,
    desiredAction: "remove",
    state: "desired",
    payloadHash: `${stored.payload_hash}-cancelled`,
  });
  const removed = await applyBrowserPlatformProjection({
    ledger,
    config,
    projectionId: projection.id,
    adapters: { spacecloud: adapter },
  });
  assert.equal(removed.state, "removed");
  assert.equal(managed.size, 0);
});

test("NAVER availability subtracts merged busy intervals and restores the inherited schedule", async (t) => {
  assert.equal(naverAvailabilityWriterContracts.timeLabel(0), "00:00");
  assert.equal(naverAvailabilityWriterContracts.timeLabel(1380), "23:00");
  assert.equal(naverAvailabilityWriterContracts.temporaryDateLabel("2027-08-18"), "27.8.18");
  assert.equal(naverAvailabilityWriterContracts.holidayDateLabel("2027-08-18"), "2027년 8월 18일");
  const baseline = canonicalAvailability({
    date: "2099-08-20",
    source: "base",
    slotMinutes: 60,
    capacity: 1,
    intervals: [{ startMinute: 0, lastStartMinute: 1380, slotMinutes: 60, capacity: 1, price: 31_200 }],
  });
  assert.deepEqual(
    availableWindowsAfterBusy(baseline, [
      { startMinute: 720, endMinute: 900 },
      { startMinute: 840, endMinute: 960 },
    ], 120).map((item) => [item.startMinute, item.lastStartMinute]),
    [[0, 660], [960, 1380]],
  );

  const ledger = await ledgerFixture(t);
  const created = ledger.ingestBooking(booking());
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_WRITE_MODE: "write",
    RESERVATION_NAVER_AVAILABILITY_ENABLED: "true",
    RESERVATION_NAVER_MINIMUM_DURATION_MINUTES: "120",
  });
  planBooking(ledger, created.booking.id, config);
  const [day] = reconcileNaverAvailabilityPlans(ledger, config);
  let remote = { ...baseline, fingerprint: availabilityFingerprint(baseline) };
  const adapter = {
    read: async () => remote,
    apply: async (desired) => { remote = { ...desired, fingerprint: availabilityFingerprint(desired) }; },
    restore: async () => { remote = { ...baseline, fingerprint: availabilityFingerprint(baseline) }; },
  };
  const applied = await applyNaverAvailabilityDay({ ledger, config, availabilityDayId: day.id, adapter });
  assert.equal(applied.state, "applied");
  assert.deepEqual(remote.intervals.map((item) => [item.startMinute, item.lastStartMinute]), [[0, 780], [960, 1380]]);

  ledger.ingestBooking(booking({ status: "cancelled", sourceUpdatedAt: "2099-08-19T00:00:00.000Z" }));
  const restoredDay = reconcileNaverAvailabilityPlans(ledger, config).find((item) => item.date_key === "2099-08-20");
  const restored = await applyNaverAvailabilityDay({ ledger, config, availabilityDayId: restoredDay.id, adapter });
  assert.equal(restored.state, "restored");
  assert.equal(remote.source, "base");
});

test("NAVER full-day conflicts use an owned one-off holiday and restore without bookings", async (t) => {
  const date = "2099-08-20";
  const baseline = canonicalAvailability({
    date,
    source: "base",
    slotMinutes: 60,
    capacity: 1,
    intervals: [{ startMinute: 0, lastStartMinute: 1380, slotMinutes: 60, capacity: 1, price: 31_200 }],
  });
  const holiday = canonicalAvailability({ date, source: "holiday", slotMinutes: 60, capacity: 1, intervals: [] });
  const ledger = await ledgerFixture(t);
  const created = ledger.ingestBooking(booking({
    startAt: "2099-08-19T15:00:00.000Z",
    endAt: "2099-08-20T15:00:00.000Z",
  }));
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_WRITE_MODE: "write",
    RESERVATION_NAVER_AVAILABILITY_ENABLED: "true",
  });
  planBooking(ledger, created.booking.id, config);
  const [day] = reconcileNaverAvailabilityPlans(ledger, config);
  let remote = { ...baseline, fingerprint: availabilityFingerprint(baseline) };
  let holidayAdds = 0;
  let holidayRemoves = 0;
  const adapter = {
    read: async () => remote,
    apply: async () => { throw new Error("full-day path must not create a temporary time window"); },
    restore: async () => { throw new Error("full-day path must not delete a temporary time window"); },
    applyHoliday: async () => {
      holidayAdds += 1;
      remote = { ...holiday, fingerprint: availabilityFingerprint(holiday), holidayDates: [date] };
    },
    restoreHoliday: async () => {
      holidayRemoves += 1;
      remote = { ...baseline, fingerprint: availabilityFingerprint(baseline), holidayDates: [] };
    },
  };
  const applied = await applyNaverAvailabilityDay({ ledger, config, availabilityDayId: day.id, adapter });
  assert.deepEqual(applied, { state: "applied", date, intervals: 0, mode: "holiday" });
  assert.equal(holidayAdds, 1);
  assert.equal(remote.source, "holiday");

  ledger.ingestBooking(booking({
    status: "cancelled",
    startAt: "2099-08-19T15:00:00.000Z",
    endAt: "2099-08-20T15:00:00.000Z",
    sourceUpdatedAt: "2099-08-19T00:00:00.000Z",
  }));
  const restoreDay = reconcileNaverAvailabilityPlans(ledger, config).find((item) => item.date_key === date);
  const restored = await applyNaverAvailabilityDay({ ledger, config, availabilityDayId: restoreDay.id, adapter });
  assert.equal(restored.state, "restored");
  assert.equal(holidayRemoves, 1);
  assert.equal(remote.source, "base");
});

test("legacy NAVER administrator blocks remain protected after source cancellation", async (t) => {
  const ledger = await ledgerFixture(t);
  const created = ledger.ingestBooking(booking({ sourcePlatform: "spacecloud", externalBookingId: "SC-LEGACY" }));
  const config = reservationSyncConfig({
    RESERVATION_DATA_ROOT: "/tmp/reservations",
    RESERVATION_WRITE_MODE: "write",
    RESERVATION_NAVER_AVAILABILITY_ENABLED: "true",
  });
  const projections = planBooking(ledger, created.booking.id, config);
  const legacy = projections.find((item) => item.target_platform === "naver");
  ledger.updateProjection(legacy.id, {
    state: "applied",
    externalRef: JSON.stringify({ platform: "naver", kind: "administrator-booking", ids: ["preserve-me"] }),
  });
  ledger.ingestBooking(booking({
    sourcePlatform: "spacecloud",
    externalBookingId: "SC-LEGACY",
    status: "cancelled",
    sourceUpdatedAt: "2099-08-19T00:00:00.000Z",
  }));
  planBooking(ledger, created.booking.id, config);
  const protectedDay = reconcileNaverAvailabilityPlans(ledger, config).find((item) => item.date_key === "2099-08-20");
  assert.equal(protectedDay.state, "legacy-protected");
});

test("conflict detection uses half-open intervals and resource boundaries", () => {
  const rows = [
    { id: 1, booking_key: "one", source_platform: "naver", external_booking_id: "1", resource_id: "main", status: "confirmed", start_at: "2026-08-20T05:00:00Z", end_at: "2026-08-20T07:00:00Z" },
    { id: 2, booking_key: "two", source_platform: "hourplace", external_booking_id: "2", resource_id: "main", status: "confirmed", start_at: "2026-08-20T06:00:00Z", end_at: "2026-08-20T08:00:00Z" },
    { id: 3, booking_key: "three", source_platform: "spacecloud", external_booking_id: "3", resource_id: "other", status: "confirmed", start_at: "2026-08-20T06:00:00Z", end_at: "2026-08-20T08:00:00Z" },
    { id: 4, booking_key: "four", source_platform: "spacecloud", external_booking_id: "4", resource_id: "main", status: "confirmed", start_at: "2026-08-20T08:00:00Z", end_at: "2026-08-20T09:00:00Z" },
  ];
  const conflicts = detectBookingConflicts(rows);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].leftBookingId, 1);
  assert.equal(conflicts[0].rightBookingId, 2);
});

test("filtered iCal excludes the target platform and never includes customer details", async (t) => {
  const ledger = await ledgerFixture(t);
  ledger.ingestBooking(booking({ summary: "홍길동 010-1234-5678" }));
  ledger.ingestBooking(booking({ sourcePlatform: "naver", externalBookingId: "NV-55" }));
  const config = reservationSyncConfig({ RESERVATION_DATA_ROOT: "/tmp/reservations" });
  const body = filteredIcalForTarget({ ledger, config, targetPlatform: "hourplace" });
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /SUMMARY:Reserved/);
  assert.match(body, /TZID:Asia\/Seoul/);
  assert.match(body, /DTSTART:20990820T140000/);
  assert.equal(body.includes("HP-12345678"), false);
  assert.equal(body.includes("홍길동"), false);
  assert.equal((body.match(/BEGIN:VEVENT/g) || []).length, 1);
  const token = "a".repeat(32);
  assert.equal(secureTokenMatches(token, token), true);
  assert.equal(secureTokenMatches(token, "b".repeat(32)), false);
  assert.equal(secureTokenMatches("short", "short"), false);
});

test("deterministic email parser accepts a complete fixture and quarantines new templates", () => {
  const encode = (value) => Buffer.from(value).toString("base64url");
  const complete = parseReservationEmail({
    id: "gmail-1",
    internalDate: String(Date.parse("2026-08-18T00:00:00Z")),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "예약 <notice@spacecloud.kr>" },
        { name: "Subject", value: "스페이스클라우드 예약 확정" },
      ],
      body: { data: encode("예약번호: SC-123456 이용일시: 2026.08.20 14:00 ~ 16:00 결제 완료") },
    },
  }, { venueId: "demo-venue", resourceId: "main" });
  assert.equal(complete.state, "parsed");
  assert.equal(complete.booking.startAt, "2026-08-20T05:00:00.000Z");
  const naver = parseReservationEmail({
    id: "gmail-naver",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "네이버 예약 <notice@navercorp.com>" },
        { name: "Subject", value: "새로운 예약이 접수되었습니다" },
      ],
      body: { data: encode("발송일시 2026.08.18 21:54 예약번호 NV-123456 이용일시 2026.08.20 오후 2:00 ~ 오후 4:00") },
    },
  }, { venueId: "demo-venue", resourceId: "main" });
  assert.equal(naver.state, "parsed");
  assert.equal(naver.booking.status, "pending");
  assert.equal(naver.booking.startAt, "2026-08-20T05:00:00.000Z");
  const withoutId = parseReservationEmail({
    id: "gmail-space",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "스페이스클라우드 <notice@spacecloud.kr>" },
        { name: "Subject", value: "공간에 새로운 예약이 들어왔습니다" },
      ],
      body: { data: encode("2026-08-20 14:00 ~ 16:00") },
    },
  }, { venueId: "demo-venue", resourceId: "main" });
  assert.equal(withoutId.state, "parsed");
  assert.match(withoutId.booking.externalBookingId, /^tmp_/);
  const unknown = parseReservationEmail({ id: "gmail-2", payload: { headers: [], body: { data: encode("new template") } } },
    { venueId: "demo-venue" });
  assert.equal(unknown.state, "unknown");
});

test("controller completes an iCal shadow cycle without a model or sales-channel write", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservation-controller-"));
  const sourcesPath = path.join(root, "sources.json");
  await writeFile(sourcesPath, JSON.stringify({
    hourplace_ical_url: "https://calendar-ics.hourplace.co.kr/private/hourplace.ics",
    spacecloud_ical_url: "https://api.spacecloud.kr/partner/reservations/ical?opaque=test",
  }));
  const ical = (uid) => [
    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid}`,
    "DTSTART;TZID=Asia/Seoul:20260820T140000", "DTEND;TZID=Asia/Seoul:20260820T160000",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  const controller = createReservationSyncController({
    env: {
      RESERVATION_SYNC_ENABLED: "true",
      RESERVATION_WRITE_MODE: "shadow",
      RESERVATION_DATA_ROOT: root,
      RESERVATION_SOURCES_PATH: sourcesPath,
      RESERVATION_GOOGLE_WRITE_ENABLED: "false",
    },
    fetchImpl: async (url) => new Response(ical(String(url).includes("hourplace") ? "hour-1" : "space-1"), {
      status: 200,
      headers: { "content-type": "text/calendar", etag: "fixture-v1" },
    }),
  });
  t.after(async () => {
    controller.stop();
    await rm(root, { recursive: true, force: true });
  });
  const result = await controller.runCycle("test");
  assert.equal(result.state, "complete");
  assert.equal(controller.listBookings().length, 2);
  assert.equal(controller.listConflicts().length, 1);
  assert.equal(controller.status().mode, "shadow");
  assert.equal(controller.status().googleProjection, "disabled");
});
