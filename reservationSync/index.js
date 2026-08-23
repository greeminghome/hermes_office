import { reservationSyncConfig } from "./config.js";
import { ReservationLedger } from "./ledger.js";
import { syncIcalSource } from "./connectors/ical.js";
import { applyGoogleProjection, applyHourplaceFeedProjection, ensureReservationCalendars, listReservationCalendarEvents, reconcileManagedGoogleEvents, syncManualCalendar } from "./connectors/googleCalendar.js";
import { decodeGmailPush, pollReservationGmail, processGmailHistory, renewGmailWatch, verifyGmailPushOidc } from "./connectors/gmail.js";
import { deliverNotificationOutbox } from "./notificationOutbox.js";
import { planBooking, reconcileNaverAvailabilityPlans, refreshConflicts } from "./planner.js";
import { filteredIcalForTarget, secureTokenMatches } from "./writers/filteredIcal.js";
import { applyBrowserPlatformProjection, probeSpacecloudBrowserWriter } from "./writers/browserPlatform.js";
import { applyNaverAvailabilityDay, probeNaverAvailabilityWriter } from "./writers/naverAvailability.js";
import { RESERVATION_BROWSER_SESSIONS } from "./writers/browserSessionPage.js";

const WRITER_CONNECTORS = Object.freeze({
  naver: "naver-availability-writer",
  spacecloud: "spacecloud-browser-writer",
});
const RETIRED_CONNECTORS = new Set(["naver-browser-writer"]);

function shortError(error) {
  return String(error?.message || error).replace(/\s+/g, " ").slice(0, 300);
}

function browserWriterFailureState(error) {
  const message = shortError(error);
  if (/로그인|authentication|auth(?:orization)? required/i.test(message)) return "auth-required";
  if (/CDP|ECONNREFUSED|fetch failed|browser.*disconnected|브라우저.*연결/i.test(message)) return "unreachable";
  return "degraded";
}

export class ReservationSyncController {
  constructor({ env = process.env, fetchImpl = fetch, writerProbes = null } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.config = reservationSyncConfig(env);
    this.ledger = null;
    this.started = false;
    this.running = false;
    this.workPromise = null;
    this.timers = [];
    this.lastCycle = null;
    this.writerProbes = writerProbes || {
      naver: (config) => probeNaverAvailabilityWriter({ config }),
      spacecloud: (config) => probeSpacecloudBrowserWriter({ config }),
    };
  }

  ensureLedger() {
    if (!this.ledger) {
      this.ledger = new ReservationLedger({ databasePath: this.config.databasePath, backupRoot: this.config.backupRoot });
      this.ledger.configureVenue({
        id: this.config.venueId,
        name: this.config.venueName,
        resourceId: this.config.resourceId,
        timeZone: this.config.timeZone,
        bufferBeforeMinutes: this.config.bufferBeforeMinutes,
        bufferAfterMinutes: this.config.bufferAfterMinutes,
      });
    }
    return this.ledger;
  }

  schedule(callback, intervalMs) {
    const timer = setInterval(() => callback().catch((error) => {
      console.error("Reservation sync scheduled task failed:", error.message);
    }), intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  async start() {
    if (this.started) return this.status();
    this.started = true;
    if (!this.config.enabled) return this.status();
    this.ensureLedger();
    this.schedule(() => this.syncIcal("scheduled"), this.config.icalPollMs);
    if (this.config.gmailIngestEnabled) this.schedule(() => this.syncGmail("scheduled"), this.config.gmailPollMs);
    this.schedule(() => this.syncGoogle("scheduled"), this.config.reconcileMs);
    if (this.config.browserCdpUrl) this.schedule(() => this.syncWriterHealth("scheduled"), this.config.browserHealthMs);
    this.schedule(() => this.processWork(), this.config.workerMs);
    this.schedule(async () => { this.ledger.backup(); }, this.config.backupMs);
    if (this.config.gmailIngestEnabled && this.config.gmailTopic) {
      queueMicrotask(() => renewGmailWatch({ ledger: this.ledger, config: this.config }).catch((error) => {
        console.error("Reservation Gmail watch startup renewal failed:", error.message);
      }));
      this.schedule(() => renewGmailWatch({ ledger: this.ledger, config: this.config }), 24 * 60 * 60 * 1000);
    }
    queueMicrotask(() => this.runCycle("startup").catch((error) => {
      console.error("Reservation sync startup cycle failed:", error.message);
    }));
    return this.status();
  }

  async syncIcal(mode = "manual") {
    const ledger = this.ensureLedger();
    const results = await Promise.allSettled(["hourplace", "spacecloud"].map((sourcePlatform) =>
      syncIcalSource({ sourcePlatform, ledger, config: this.config, fetchImpl: this.fetchImpl, mode })));
    return results.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { connector: `${["hourplace", "spacecloud"][index]}-ical`, state: "failed", error: String(result.reason?.message || result.reason).slice(0, 200) });
  }

  async syncGmail(mode = "manual") {
    if (!this.config.gmailIngestEnabled) return { state: "disabled" };
    return pollReservationGmail({ ledger: this.ensureLedger(), config: this.config, mode });
  }

  async syncGoogle(mode = "manual") {
    if (!this.config.googleWriteEnabled) return { state: "disabled" };
    const ledger = this.ensureLedger();
    await ensureReservationCalendars({ ledger, config: this.config });
    const manual = await syncManualCalendar({ ledger, config: this.config, mode });
    const orphans = await reconcileManagedGoogleEvents({ ledger, config: this.config });
    return { ...manual, orphansRemoved: orphans.removed, duplicatesRemoved: orphans.duplicatesRemoved };
  }

  async syncWriterHealth(mode = "manual") {
    if (!this.config.browserCdpUrl) return { state: "disabled", reason: "missing-browser-cdp" };
    const ledger = this.ensureLedger();
    const enabled = {
      naver: this.config.writeMode === "write" && this.config.naverAvailabilityEnabled,
      spacecloud: this.config.writeMode === "write" && this.config.spacecloudWriteEnabled,
    };
    const results = await Promise.all(Object.entries(this.writerProbes).map(async ([platform, probe]) => {
      const connector = WRITER_CONNECTORS[platform];
      if (!connector || typeof probe !== "function") return { platform, state: "unsupported" };
      const checkedAt = new Date().toISOString();
      const checkpoint = ledger.getCheckpoint(connector);
      try {
        const result = await probe(this.config);
        const metadata = {
          state: "ready",
          enabled: Boolean(enabled[platform]),
          authenticated: result?.authenticated !== false,
          managementUiReady: result?.managementUiReady !== false,
          liveSessionId: result?.liveSessionId || RESERVATION_BROWSER_SESSIONS[platform] || "",
          checkedAt,
          mode,
        };
        ledger.updateCheckpoint(connector, {
          lastAttemptAt: checkedAt,
          lastSuccessAt: checkedAt,
          failureCount: 0,
          lastError: "",
          metadata,
        });
        return { platform, ...metadata };
      } catch (error) {
        const message = shortError(error);
        const state = browserWriterFailureState(error);
        const metadata = {
          state,
          enabled: Boolean(enabled[platform]),
          authenticated: state !== "auth-required",
          managementUiReady: false,
          liveSessionId: RESERVATION_BROWSER_SESSIONS[platform] || "",
          checkedAt,
          mode,
        };
        ledger.updateCheckpoint(connector, {
          lastAttemptAt: checkedAt,
          failureCount: (checkpoint?.failure_count || 0) + 1,
          lastError: message,
          metadata,
        });
        return { platform, ...metadata, error: message };
      }
    }));
    return { state: results.every((item) => item.state === "ready") ? "ready" : "attention", results };
  }

  async processWork() {
    if (this.workPromise) return this.workPromise;
    this.workPromise = this.processWorkOnce();
    try {
      return await this.workPromise;
    } finally {
      this.workPromise = null;
    }
  }

  async processWorkOnce() {
    const ledger = this.ensureLedger();
    let processed = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const jobs = ledger.claimJobs(20);
      if (!jobs.length) break;
      for (const job of jobs) {
        try {
          if (job.type === "plan-booking") {
            planBooking(ledger, job.payload.bookingId, this.config);
            reconcileNaverAvailabilityPlans(ledger, this.config);
          }
          else if (job.type === "apply-google") await applyGoogleProjection({ ledger, config: this.config, projectionId: job.payload.projectionId });
          else if (job.type === "apply-sales") await applyBrowserPlatformProjection({ ledger, config: this.config, projectionId: job.payload.projectionId });
          else if (job.type === "apply-hourplace-feed") await applyHourplaceFeedProjection({ ledger, config: this.config, projectionId: job.payload.projectionId });
          else if (job.type === "apply-naver-availability") await applyNaverAvailabilityDay({ ledger, config: this.config, availabilityDayId: job.payload.availabilityDayId });
          else throw new Error(`지원하지 않는 예약 작업: ${job.type}`);
          ledger.completeJob(job.id);
          processed += 1;
        } catch (error) {
          ledger.failJob(job.id, error, job.attempt_count + 1);
        }
      }
    }
    const conflicts = refreshConflicts(ledger, this.config);
    await deliverNotificationOutbox({ ledger, config: this.config, fetchImpl: this.fetchImpl }).catch((error) => {
      console.error("Reservation notification outbox failed:", error.message);
    });
    return { processed, conflicts: conflicts.length };
  }

  async runCycle(mode = "manual") {
    if (!this.config.enabled) return { state: "disabled" };
    if (this.running) return { state: "already-running" };
    this.running = true;
    const startedAt = new Date().toISOString();
    try {
      const gmail = await this.syncGmail(mode).catch((error) => ({ state: "failed", error: String(error.message || error).slice(0, 200) }));
      const ical = await this.syncIcal(mode);
      const google = await this.syncGoogle(mode).catch((error) => ({ state: "failed", error: String(error.message || error).slice(0, 200) }));
      const writerHealth = await this.syncWriterHealth(mode).catch((error) => ({ state: "failed", error: shortError(error) }));
      for (const booking of this.ensureLedger().planningBookingRows()) planBooking(this.ledger, booking.id, this.config);
      reconcileNaverAvailabilityPlans(this.ledger, this.config);
      const work = await this.processWork();
      this.lastCycle = { state: "complete", startedAt, finishedAt: new Date().toISOString(), gmail, ical, google, writerHealth, work };
      return this.lastCycle;
    } finally {
      this.running = false;
    }
  }

  async handleGmailPush({ authorization, body }) {
    if (!this.config.enabled || !this.config.gmailIngestEnabled) throw new Error("Gmail push 수집이 활성화되지 않았습니다.");
    if (!await verifyGmailPushOidc({ authorization, config: this.config })) throw new Error("Gmail push OIDC 인증에 실패했습니다.");
    const payload = decodeGmailPush(body);
    return processGmailHistory({ ledger: this.ensureLedger(), config: this.config, historyId: payload.historyId });
  }

  calendarFeed(targetPlatform, token) {
    if (!this.config.enabled || !new Set(["hourplace", "spacecloud"]).has(targetPlatform)) return null;
    const expected = this.config.filteredFeedTokens[targetPlatform];
    if (!secureTokenMatches(expected, token)) return null;
    return filteredIcalForTarget({ ledger: this.ensureLedger(), config: this.config, targetPlatform });
  }

  listBookings(query = {}) {
    return this.config.enabled ? this.ensureLedger().listBookings(query) : [];
  }

  getBooking(id) {
    return this.config.enabled ? this.ensureLedger().getBookingById(Number(id)) : null;
  }

  listConflicts() {
    return this.config.enabled ? this.ensureLedger().listConflicts() : [];
  }

  async listGoogleCalendarEvents(query, profile) {
    if (!this.config.enabled) throw new Error("예약 동기화가 비활성화되어 있습니다.");
    return listReservationCalendarEvents({ ledger: this.ensureLedger(), config: this.config, query, profile });
  }

  acknowledgeConflict(id, resolution, actor) {
    if (!this.config.enabled) throw new Error("예약 동기화가 비활성화되어 있습니다.");
    this.ensureLedger().acknowledgeConflict(Number(id), resolution, actor);
    return this.ensureLedger().listConflicts();
  }

  status() {
    const rawOperational = this.ledger ? this.ledger.getOperationalStatus() : null;
    const operational = rawOperational ? {
      ...rawOperational,
      connectors: rawOperational.connectors.filter((item) => !RETIRED_CONNECTORS.has(item.connector)),
    } : null;
    const checkpoints = new Map((operational?.connectors || []).map((item) => [item.connector, item]));
    const writerHealth = Object.fromEntries(Object.entries(WRITER_CONNECTORS).map(([platform, connector]) => {
      const checkpoint = checkpoints.get(connector);
      return [platform, {
        state: checkpoint?.metadata?.state || "unchecked",
        enabled: platform === "naver"
          ? this.config.writeMode === "write" && this.config.naverAvailabilityEnabled
          : this.config.writeMode === "write" && this.config.spacecloudWriteEnabled,
        authenticated: checkpoint?.metadata?.authenticated ?? null,
        managementUiReady: checkpoint?.metadata?.managementUiReady ?? null,
        liveSessionId: checkpoint?.metadata?.liveSessionId || RESERVATION_BROWSER_SESSIONS[platform] || "",
        checkedAt: checkpoint?.metadata?.checkedAt || "",
        failureCount: checkpoint?.failureCount || 0,
      }];
    }));
    return {
      enabled: this.config.enabled,
      mode: this.config.writeMode,
      running: this.running,
      phase: this.config.enabled ? (this.config.writeMode === "write" ? "guarded-projection" : "shadow-read") : "disabled",
      googleProjection: this.config.googleWriteEnabled ? "enabled" : "disabled",
      gmailPush: this.config.gmailIngestEnabled && this.config.gmailTopic ? "enabled" : this.config.gmailIngestEnabled ? "polling" : "awaiting-fixtures-and-pubsub",
      telegram: this.config.telegramEnabled ? "enabled" : "awaiting-secret",
      platformWriters: {
        hourplace: this.config.hourplaceFeedEnabled ? "google-ical" : "shadow",
        spacecloud: this.config.writeMode === "write" && this.config.spacecloudWriteEnabled ? "browser-write" : "shadow",
        naver: this.config.writeMode === "write" && this.config.naverAvailabilityEnabled ? "availability-schedule" : "shadow",
      },
      platformWriterHealth: writerHealth,
      policy: {
        pendingBlocks: this.config.pendingBlocks,
        bufferBeforeMinutes: this.config.bufferBeforeMinutes,
        bufferAfterMinutes: this.config.bufferAfterMinutes,
        timeZone: this.config.timeZone,
      },
      lastCycle: this.lastCycle,
      operational,
    };
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.ledger?.close();
    this.ledger = null;
    this.started = false;
  }
}

export function createReservationSyncController(options) {
  return new ReservationSyncController(options);
}
