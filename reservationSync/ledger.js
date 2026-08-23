import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeBooking, sha256, stableJson } from "./normalization.js";

const SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function publicBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingKey: row.booking_key,
    venueId: row.venue_id,
    resourceId: row.resource_id,
    sourcePlatform: row.source_platform,
    externalBookingIdMasked: row.external_booking_id_masked,
    kind: row.kind,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    timeZone: row.time_zone,
    productCode: row.product_code,
    summary: row.summary,
    revision: row.revision,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

export class ReservationLedger {
  constructor({ databasePath, backupRoot }) {
    this.databasePath = databasePath;
    this.backupRoot = backupRoot;
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.restrictFilePermissions();
  }

  restrictFilePermissions() {
    for (const filePath of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(filePath)) chmodSync(filePath, 0o600);
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS venues (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
        buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_key TEXT NOT NULL UNIQUE,
        venue_id TEXT NOT NULL REFERENCES venues(id),
        resource_id TEXT NOT NULL,
        source_platform TEXT NOT NULL,
        external_booking_id TEXT NOT NULL,
        external_booking_id_masked TEXT NOT NULL,
        temporary_fingerprint TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        product_code TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        customer_hint TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
        payload_hash TEXT NOT NULL,
        missing_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        cancelled_at TEXT,
        raw_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(venue_id, source_platform, external_booking_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_window ON bookings(resource_id, start_at, end_at);
      CREATE INDEX IF NOT EXISTS idx_bookings_source_status ON bookings(source_platform, status);
      CREATE TABLE IF NOT EXISTS booking_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_key TEXT NOT NULL UNIQUE,
        booking_id INTEGER REFERENCES bookings(id),
        source_platform TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        parse_state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS projections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        target_platform TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        projection_uid TEXT NOT NULL,
        desired_action TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        external_ref TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        read_back_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(booking_id, target_platform, resource_id)
      );
      CREATE TABLE IF NOT EXISTS availability_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_platform TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        desired_hash TEXT NOT NULL,
        desired_json TEXT NOT NULL DEFAULT '{}',
        baseline_json TEXT NOT NULL DEFAULT '',
        applied_json TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        read_back_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_platform, resource_id, date_key)
      );
      CREATE TABLE IF NOT EXISTS connector_checkpoints (
        connector TEXT PRIMARY KEY,
        cursor TEXT NOT NULL DEFAULT '',
        etag TEXT NOT NULL DEFAULT '',
        last_modified TEXT NOT NULL DEFAULT '',
        last_attempt_at TEXT,
        last_success_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(state, available_at, lease_until);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        booking_id INTEGER REFERENCES bookings(id),
        revision INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        state TEXT NOT NULL,
        observed_count INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conflict_key TEXT NOT NULL UNIQUE,
        left_booking_id INTEGER NOT NULL REFERENCES bookings(id),
        right_booking_id INTEGER NOT NULL REFERENCES bookings(id),
        resource_id TEXT NOT NULL,
        overlap_start_at TEXT NOT NULL,
        overlap_end_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        acknowledged_at TEXT,
        resolution TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(SCHEMA_VERSION, nowIso());
  }

  configureVenue({ id, name, resourceId, timeZone, bufferBeforeMinutes = 0, bufferAfterMinutes = 0 }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO venues(id, name, resource_id, time_zone, buffer_before_minutes, buffer_after_minutes, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, resource_id=excluded.resource_id,
        time_zone=excluded.time_zone, buffer_before_minutes=excluded.buffer_before_minutes,
        buffer_after_minutes=excluded.buffer_after_minutes, updated_at=excluded.updated_at
    `).run(id, name, resourceId, timeZone, bufferBeforeMinutes, bufferAfterMinutes, timestamp, timestamp);
  }

  audit({ actor = "reservation-sync", action, entityType, entityKey, reason = "", details = {} }) {
    this.db.prepare(`INSERT INTO audit_log(actor, action, entity_type, entity_key, reason, details_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(actor, action, entityType, entityKey, reason, json(details), nowIso());
  }

  ingestUnknownObservation({ sourcePlatform, sourceMessageId, payload = {}, error }) {
    const timestamp = nowIso();
    const payloadHash = sha256(stableJson(payload));
    const observationKey = sha256(`${sourcePlatform}|${sourceMessageId}|${payloadHash}|unknown`);
    this.db.prepare(`INSERT OR IGNORE INTO booking_observations(
      observation_key, booking_id, source_platform, source_message_id, observed_at, payload_hash, parse_state, payload_json, error
    ) VALUES(?, NULL, ?, ?, ?, ?, 'unknown', ?, ?)`)
      .run(observationKey, sourcePlatform, sourceMessageId, timestamp, payloadHash, json(payload), String(error || "unknown template").slice(0, 300));
    this.audit({ action: "observation.quarantined", entityType: "observation", entityKey: observationKey, reason: String(error || "unknown") });
    return { observationKey, state: "unknown" };
  }

  hasSourceMessage(sourceMessageId) {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM booking_observations WHERE source_message_id=? LIMIT 1").get(sourceMessageId));
  }

  latestSourceUpdatedAt(bookingId) {
    let latest = "";
    const observations = this.db.prepare(`
      SELECT payload_json
      FROM booking_observations
      WHERE booking_id=? AND parse_state='parsed'
    `).all(bookingId);
    for (const observation of observations) {
      const sourceUpdatedAt = String(parseJson(observation.payload_json)?.sourceUpdatedAt || "");
      if (sourceUpdatedAt && (!latest || sourceUpdatedAt > latest)) latest = sourceUpdatedAt;
    }
    return latest;
  }

  ingestBooking(input, { sourceMessageId = "", observedAt = nowIso(), actor = "reservation-sync" } = {}) {
    const booking = normalizeBooking(input);
    const sourceUpdatedAt = String(input.sourceUpdatedAt || "");
    const maskedId = booking.externalBookingId.length <= 4
      ? "••••"
      : `${"•".repeat(Math.min(8, booking.externalBookingId.length - 4))}${booking.externalBookingId.slice(-4)}`;
    const observationKey = sha256(`${booking.sourcePlatform}|${sourceMessageId || booking.externalBookingId}|${booking.payloadHash}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM bookings WHERE booking_key = ?").get(booking.bookingKey);
      let bookingId;
      let changed = false;
      let created = false;
      let stale = false;
      let revision = existing?.revision || 0;
      if (!existing) {
        const result = this.db.prepare(`INSERT INTO bookings(
          booking_key, venue_id, resource_id, source_platform, external_booking_id, external_booking_id_masked,
          kind, status, start_at, end_at, time_zone, product_code, summary, customer_hint, revision,
          payload_hash, first_seen_at, last_seen_at, cancelled_at, raw_ref, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
          .run(booking.bookingKey, booking.venueId, booking.resourceId, booking.sourcePlatform,
            booking.externalBookingId, maskedId, booking.kind, booking.status, booking.startAt, booking.endAt,
            booking.timeZone, booking.productCode, booking.summary, booking.customerHint, booking.payloadHash,
            observedAt, observedAt, booking.status === "cancelled" ? observedAt : null, booking.rawRef, observedAt, observedAt);
        bookingId = Number(result.lastInsertRowid);
        revision = 1;
        changed = true;
        created = true;
      } else {
        bookingId = existing.id;
        const latestSourceUpdatedAt = this.latestSourceUpdatedAt(bookingId);
        stale = Boolean(sourceUpdatedAt && latestSourceUpdatedAt && sourceUpdatedAt < latestSourceUpdatedAt);
        if (stale) {
          this.db.prepare("UPDATE bookings SET last_seen_at=? WHERE id=?").run(observedAt, bookingId);
        } else {
          changed = existing.payload_hash !== booking.payloadHash;
          revision = existing.revision + (changed ? 1 : 0);
          this.db.prepare(`UPDATE bookings SET resource_id=?, kind=?, status=?, start_at=?, end_at=?, time_zone=?,
            product_code=?, summary=?, customer_hint=?, revision=?, payload_hash=?, missing_count=0,
            last_seen_at=?, cancelled_at=?, raw_ref=?, updated_at=? WHERE id=?`)
            .run(booking.resourceId, booking.kind, booking.status, booking.startAt, booking.endAt, booking.timeZone,
              booking.productCode, booking.summary, booking.customerHint, revision, booking.payloadHash, observedAt,
              booking.status === "cancelled" ? (existing.cancelled_at || observedAt) : null, booking.rawRef,
              changed ? observedAt : existing.updated_at, bookingId);
        }
      }
      this.db.prepare(`INSERT OR IGNORE INTO booking_observations(
        observation_key, booking_id, source_platform, source_message_id, observed_at, payload_hash, parse_state, payload_json, error
      ) VALUES(?, ?, ?, ?, ?, ?, 'parsed', ?, '')`)
        .run(observationKey, bookingId, booking.sourcePlatform, sourceMessageId || booking.externalBookingId,
          observedAt, booking.payloadHash, json({ sequence: input.sequence || 0, sourceUpdatedAt }));
      if (stale) {
        this.audit({ actor, action: "booking.observation.stale", entityType: "booking", entityKey: booking.bookingKey,
          details: { sourcePlatform: booking.sourcePlatform, sourceUpdatedAt } });
      }
      if (changed) {
        this.enqueueJob("plan-booking", { bookingId }, `plan:${bookingId}:r${revision}`, observedAt);
        const eventType = booking.status === "cancelled" ? "booking.cancelled" : created ? "booking.created" : "booking.changed";
        this.enqueueNotification({ eventType, bookingId, revision, payload: { bookingKey: booking.bookingKey } });
        this.audit({ actor, action: eventType, entityType: "booking", entityKey: booking.bookingKey,
          details: { sourcePlatform: booking.sourcePlatform, revision, status: booking.status } });
      }
      this.db.exec("COMMIT");
      return { booking: this.getBookingById(bookingId), created, changed, stale, revision };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueJob(type, payload, dedupeKey, availableAt = nowIso()) {
    const timestamp = nowIso();
    this.db.prepare(`INSERT OR IGNORE INTO jobs(type, dedupe_key, payload_json, state, available_at, created_at, updated_at)
      VALUES(?, ?, ?, 'pending', ?, ?, ?)`)
      .run(type, dedupeKey, json(payload), availableAt, timestamp, timestamp);
  }

  enqueueNotification({ eventType, bookingId = null, revision = 1, payload = {} }) {
    const timestamp = nowIso();
    const dedupeKey = `${eventType}:${bookingId ?? "system"}:r${revision}`;
    this.db.prepare(`INSERT OR IGNORE INTO notifications(
      dedupe_key, event_type, booking_id, revision, payload_json, state, available_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(dedupeKey, eventType, bookingId, revision, json(payload), timestamp, timestamp, timestamp);
  }

  claimJobs(limit = 10, leaseMs = 120_000) {
    const timestamp = nowIso();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const rows = this.db.prepare(`SELECT * FROM jobs
      WHERE available_at <= ? AND ((state IN ('pending','retrying')) OR (state='processing' AND lease_until < ?))
      ORDER BY id LIMIT ?`).all(timestamp, timestamp, limit);
    const claimed = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const result = this.db.prepare(`UPDATE jobs SET state='processing', lease_until=?, attempt_count=attempt_count+1,
          updated_at=? WHERE id=? AND ((state IN ('pending','retrying')) OR (state='processing' AND lease_until < ?))`)
          .run(leaseUntil, timestamp, row.id, timestamp);
        if (result.changes) claimed.push({ ...row, payload: parseJson(row.payload_json), leaseUntil });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return claimed;
  }

  completeJob(id) {
    this.db.prepare("UPDATE jobs SET state='complete', lease_until=NULL, last_error='', updated_at=? WHERE id=?").run(nowIso(), id);
  }

  failJob(id, error, attemptCount = 1) {
    const delay = Math.min(3_600_000, 5_000 * (2 ** Math.min(8, attemptCount)));
    this.db.prepare(`UPDATE jobs SET state='retrying', lease_until=NULL, last_error=?, available_at=?, updated_at=? WHERE id=?`)
      .run(String(error?.message || error).slice(0, 300), new Date(Date.now() + delay).toISOString(), nowIso(), id);
  }

  claimNotifications(limit = 10) {
    const timestamp = nowIso();
    const rows = this.db.prepare(`SELECT * FROM notifications WHERE state IN ('pending','retrying') AND available_at <= ?
      ORDER BY id LIMIT ?`).all(timestamp, limit);
    const claimed = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const result = this.db.prepare(`UPDATE notifications SET state='processing', attempt_count=attempt_count+1,
          updated_at=? WHERE id=? AND state IN ('pending','retrying')`).run(timestamp, row.id);
        if (result.changes) claimed.push({ ...row, payload: parseJson(row.payload_json) });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return claimed;
  }

  completeNotification(id) {
    const timestamp = nowIso();
    this.db.prepare("UPDATE notifications SET state='sent', sent_at=?, last_error='', updated_at=? WHERE id=?")
      .run(timestamp, timestamp, id);
  }

  failNotification(id, error, attemptCount = 1, retryAfterMs = null) {
    const delay = retryAfterMs ?? Math.min(3_600_000, 10_000 * (2 ** Math.min(8, attemptCount)));
    this.db.prepare(`UPDATE notifications SET state='retrying', last_error=?, available_at=?, updated_at=? WHERE id=?`)
      .run(String(error?.message || error).slice(0, 300), new Date(Date.now() + delay).toISOString(), nowIso(), id);
  }

  getBookingById(id) {
    return publicBooking(this.db.prepare("SELECT * FROM bookings WHERE id=?").get(id));
  }

  getBookingRowById(id) {
    return this.db.prepare("SELECT * FROM bookings WHERE id=?").get(id) || null;
  }

  listBookings({ limit = 100, sourcePlatform = "", status = "" } = {}) {
    const clauses = [];
    const values = [];
    if (sourcePlatform) { clauses.push("source_platform=?"); values.push(sourcePlatform); }
    if (status) { clauses.push("status=?"); values.push(status); }
    values.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    return this.db.prepare(`SELECT * FROM bookings ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY start_at DESC LIMIT ?`).all(...values).map(publicBooking);
  }

  activeBookingRows() {
    return this.db.prepare(`SELECT * FROM bookings WHERE status IN ('pending','confirmed','changed') ORDER BY start_at`).all();
  }

  planningBookingRows() {
    return this.db.prepare("SELECT * FROM bookings WHERE status <> 'unknown' ORDER BY start_at").all();
  }

  sourceBookingRows(sourcePlatform, { collector = "" } = {}) {
    const clauses = ["source_platform=?", "status IN ('pending','confirmed','changed','unknown')"];
    const values = [sourcePlatform];
    if (collector === "ical") {
      clauses.push("raw_ref LIKE 'ical:%'", "end_at > ?");
      values.push(nowIso());
    }
    return this.db.prepare(`SELECT * FROM bookings WHERE ${clauses.join(" AND ")}`).all(...values);
  }

  markSourceMissing(sourcePlatform, seenExternalIds, { anomalous = false } = {}) {
    if (anomalous) return { preserved: true, missing: 0, cancelled: 0 };
    const seen = new Set(seenExternalIds);
    const candidates = this.sourceBookingRows(sourcePlatform, { collector: "ical" });
    let missing = 0;
    let cancelled = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of candidates) {
        if (seen.has(row.external_booking_id)) continue;
        missing += 1;
        const nextMissing = row.missing_count + 1;
        if (nextMissing < 2) {
          this.db.prepare("UPDATE bookings SET missing_count=?, updated_at=? WHERE id=?").run(nextMissing, nowIso(), row.id);
          continue;
        }
        const revision = row.revision + 1;
        const timestamp = nowIso();
        this.db.prepare(`UPDATE bookings SET status='cancelled', missing_count=?, revision=?, cancelled_at=?,
          payload_hash=?, updated_at=? WHERE id=?`)
          .run(nextMissing, revision, timestamp, sha256(`${row.payload_hash}|cancelled|${revision}`), timestamp, row.id);
        this.enqueueJob("plan-booking", { bookingId: row.id }, `plan:${row.id}:r${revision}`, timestamp);
        this.enqueueNotification({ eventType: "booking.cancelled", bookingId: row.id, revision,
          payload: { reason: "missing-from-two-healthy-ical-scans" } });
        cancelled += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { preserved: false, missing, cancelled };
  }

  getCheckpoint(connector) {
    const row = this.db.prepare("SELECT * FROM connector_checkpoints WHERE connector=?").get(connector);
    return row ? { ...row, metadata: parseJson(row.metadata_json) } : null;
  }

  updateCheckpoint(connector, patch = {}) {
    const existing = this.getCheckpoint(connector) || {};
    const timestamp = nowIso();
    const merged = {
      cursor: patch.cursor ?? existing.cursor ?? "",
      etag: patch.etag ?? existing.etag ?? "",
      lastModified: patch.lastModified ?? existing.last_modified ?? "",
      lastAttemptAt: patch.lastAttemptAt ?? existing.last_attempt_at ?? timestamp,
      lastSuccessAt: patch.lastSuccessAt ?? existing.last_success_at ?? null,
      failureCount: patch.failureCount ?? existing.failure_count ?? 0,
      lastError: patch.lastError ?? existing.last_error ?? "",
      metadata: patch.metadata ?? existing.metadata ?? {},
    };
    this.db.prepare(`INSERT INTO connector_checkpoints(
      connector, cursor, etag, last_modified, last_attempt_at, last_success_at, failure_count, last_error, metadata_json, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connector) DO UPDATE SET cursor=excluded.cursor, etag=excluded.etag,
      last_modified=excluded.last_modified, last_attempt_at=excluded.last_attempt_at,
      last_success_at=excluded.last_success_at, failure_count=excluded.failure_count,
      last_error=excluded.last_error, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
      .run(connector, merged.cursor, merged.etag, merged.lastModified, merged.lastAttemptAt, merged.lastSuccessAt,
        merged.failureCount, String(merged.lastError).slice(0, 300), json(merged.metadata), timestamp);
    return this.getCheckpoint(connector);
  }

  startSyncRun(connector, mode = "scheduled") {
    const result = this.db.prepare(`INSERT INTO sync_runs(connector, mode, started_at, state) VALUES(?, ?, ?, 'running')`)
      .run(connector, mode, nowIso());
    return Number(result.lastInsertRowid);
  }

  finishSyncRun(id, { state = "complete", observed = 0, changed = 0, errors = 0, details = {} } = {}) {
    this.db.prepare(`UPDATE sync_runs SET finished_at=?, state=?, observed_count=?, changed_count=?, error_count=?, details_json=? WHERE id=?`)
      .run(nowIso(), state, observed, changed, errors, json(details), id);
  }

  listSyncRuns(limit = 30) {
    return this.db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?").all(Math.min(200, Math.max(1, Number(limit) || 30)))
      .map((row) => ({ ...row, details: parseJson(row.details_json), details_json: undefined }));
  }

  upsertProjection({ bookingId, targetPlatform, resourceId, projectionUid, desiredAction, state, payloadHash }) {
    const timestamp = nowIso();
    this.db.prepare(`INSERT INTO projections(
      booking_id, target_platform, resource_id, projection_uid, desired_action, state, payload_hash, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(booking_id, target_platform, resource_id) DO UPDATE SET
      projection_uid=excluded.projection_uid, desired_action=excluded.desired_action,
      state=CASE
        WHEN projections.payload_hash=excluded.payload_hash
          AND projections.desired_action=excluded.desired_action
          AND projections.state IN ('applied','removed','feed')
          THEN projections.state
        ELSE excluded.state END,
      payload_hash=excluded.payload_hash, updated_at=excluded.updated_at`)
      .run(bookingId, targetPlatform, resourceId, projectionUid, desiredAction, state, payloadHash, timestamp, timestamp);
    return this.db.prepare("SELECT * FROM projections WHERE booking_id=? AND target_platform=? AND resource_id=?")
      .get(bookingId, targetPlatform, resourceId);
  }

  updateProjection(id, patch = {}) {
    const existing = this.db.prepare("SELECT * FROM projections WHERE id=?").get(id);
    if (!existing) return null;
    this.db.prepare(`UPDATE projections SET state=?, external_ref=?, attempt_count=?, last_error=?, read_back_at=?, updated_at=? WHERE id=?`)
      .run(patch.state ?? existing.state, patch.externalRef ?? existing.external_ref,
        patch.attemptCount ?? existing.attempt_count, String(patch.lastError ?? existing.last_error).slice(0, 300),
        patch.readBackAt ?? existing.read_back_at, nowIso(), id);
    return this.db.prepare("SELECT * FROM projections WHERE id=?").get(id);
  }

  getProjection(id) {
    return this.db.prepare("SELECT * FROM projections WHERE id=?").get(id) || null;
  }

  upsertAvailabilityDay({ targetPlatform, resourceId, dateKey, desiredHash, desired, state = "desired" }) {
    const timestamp = nowIso();
    this.db.prepare(`INSERT INTO availability_days(
      target_platform, resource_id, date_key, desired_hash, desired_json, state, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_platform, resource_id, date_key) DO UPDATE SET
      desired_hash=excluded.desired_hash,
      desired_json=excluded.desired_json,
      state=CASE
        WHEN availability_days.desired_hash=excluded.desired_hash
          AND (availability_days.state IN ('applied','restored')
            OR (availability_days.state='legacy-protected' AND excluded.state='legacy-protected'))
          THEN availability_days.state
        ELSE excluded.state END,
      updated_at=excluded.updated_at`)
      .run(targetPlatform, resourceId, dateKey, desiredHash, json(desired), state, timestamp, timestamp);
    return this.getAvailabilityDay(targetPlatform, resourceId, dateKey);
  }

  getAvailabilityDay(targetPlatform, resourceId, dateKey) {
    const row = this.db.prepare(`SELECT * FROM availability_days
      WHERE target_platform=? AND resource_id=? AND date_key=?`).get(targetPlatform, resourceId, dateKey);
    return row ? {
      ...row,
      desired: parseJson(row.desired_json),
      baseline: parseJson(row.baseline_json, null),
      applied: parseJson(row.applied_json, null),
    } : null;
  }

  getAvailabilityDayById(id) {
    const row = this.db.prepare("SELECT * FROM availability_days WHERE id=?").get(id);
    return row ? {
      ...row,
      desired: parseJson(row.desired_json),
      baseline: parseJson(row.baseline_json, null),
      applied: parseJson(row.applied_json, null),
    } : null;
  }

  listAvailabilityDays(targetPlatform = "") {
    const rows = targetPlatform
      ? this.db.prepare("SELECT * FROM availability_days WHERE target_platform=? ORDER BY date_key").all(targetPlatform)
      : this.db.prepare("SELECT * FROM availability_days ORDER BY target_platform, date_key").all();
    return rows.map((row) => ({
      ...row,
      desired: parseJson(row.desired_json),
      baseline: parseJson(row.baseline_json, null),
      applied: parseJson(row.applied_json, null),
    }));
  }

  updateAvailabilityDay(id, patch = {}) {
    const existing = this.getAvailabilityDayById(id);
    if (!existing) return null;
    this.db.prepare(`UPDATE availability_days SET baseline_json=?, applied_json=?, state=?, attempt_count=?,
      last_error=?, read_back_at=?, updated_at=? WHERE id=?`)
      .run(
        patch.baseline === undefined ? existing.baseline_json : (patch.baseline ? json(patch.baseline) : ""),
        patch.applied === undefined ? existing.applied_json : (patch.applied ? json(patch.applied) : ""),
        patch.state ?? existing.state,
        patch.attemptCount ?? existing.attempt_count,
        String(patch.lastError ?? existing.last_error).slice(0, 300),
        patch.readBackAt ?? existing.read_back_at,
        nowIso(),
        id,
      );
    return this.getAvailabilityDayById(id);
  }

    legacyNaverProjectionRows() {
      return this.db.prepare(`SELECT p.*, b.booking_key, b.start_at, b.end_at, b.status AS booking_status
        FROM projections p JOIN bookings b ON b.id=p.booking_id
        WHERE p.target_platform='naver'
          AND p.external_ref LIKE '%"platform":"naver"%'`).all();
    }

  desiredGoogleProjections(limit = 20) {
    return this.db.prepare(`SELECT p.*, b.booking_key, b.source_platform, b.status AS booking_status,
      b.start_at, b.end_at, b.summary, b.venue_id, b.revision AS booking_revision
      FROM projections p JOIN bookings b ON b.id=p.booking_id
      WHERE p.target_platform='google' AND p.state IN ('desired','retrying') ORDER BY p.id LIMIT ?`).all(limit);
  }

  replaceConflicts(conflicts) {
    const timestamp = nowIso();
    const activeKeys = new Set(conflicts.map((item) => item.conflictKey));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const conflict of conflicts) {
        this.db.prepare(`INSERT INTO conflicts(
          conflict_key, left_booking_id, right_booking_id, resource_id, overlap_start_at, overlap_end_at, state, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'open', ?, ?)
        ON CONFLICT(conflict_key) DO UPDATE SET overlap_start_at=excluded.overlap_start_at,
          overlap_end_at=excluded.overlap_end_at, state=CASE WHEN conflicts.state='acknowledged' THEN 'acknowledged' ELSE 'open' END,
          updated_at=excluded.updated_at`)
          .run(conflict.conflictKey, conflict.leftBookingId, conflict.rightBookingId, conflict.resourceId,
            conflict.overlapStartAt, conflict.overlapEndAt, timestamp, timestamp);
      }
      const open = this.db.prepare("SELECT id, conflict_key FROM conflicts WHERE state IN ('open','acknowledged')").all();
      for (const row of open) {
        if (!activeKeys.has(row.conflict_key)) {
          this.db.prepare("UPDATE conflicts SET state='resolved', updated_at=? WHERE id=?").run(timestamp, row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listConflicts({ openOnly = true } = {}) {
    const rows = this.db.prepare(`SELECT c.*, lb.booking_key AS left_booking_key, rb.booking_key AS right_booking_key,
      lb.source_platform AS left_source, rb.source_platform AS right_source
      FROM conflicts c JOIN bookings lb ON lb.id=c.left_booking_id JOIN bookings rb ON rb.id=c.right_booking_id
      ${openOnly ? "WHERE c.state IN ('open','acknowledged')" : ""} ORDER BY c.updated_at DESC`).all();
    return rows.map((row) => ({
      id: row.id, conflictKey: row.conflict_key, state: row.state, resourceId: row.resource_id,
      overlapStartAt: row.overlap_start_at, overlapEndAt: row.overlap_end_at,
      left: { bookingKey: row.left_booking_key, sourcePlatform: row.left_source },
      right: { bookingKey: row.right_booking_key, sourcePlatform: row.right_source },
      acknowledgedAt: row.acknowledged_at, resolution: row.resolution, updatedAt: row.updated_at,
    }));
  }

  acknowledgeConflict(id, resolution, actor = "operator") {
    const timestamp = nowIso();
    const result = this.db.prepare(`UPDATE conflicts SET state='acknowledged', acknowledged_at=?, resolution=?, updated_at=?
      WHERE id=? AND state='open'`).run(timestamp, String(resolution || "운영자 확인").slice(0, 300), timestamp, id);
    if (!result.changes) throw new Error("확인할 수 있는 충돌 항목이 없습니다.");
    this.audit({ actor, action: "conflict.acknowledged", entityType: "conflict", entityKey: String(id), reason: resolution });
  }

  getOperationalStatus() {
    const counts = Object.fromEntries(this.db.prepare("SELECT status, COUNT(*) AS count FROM bookings GROUP BY status").all().map((row) => [row.status, row.count]));
    const connectors = this.db.prepare("SELECT * FROM connector_checkpoints ORDER BY connector").all().map((row) => ({
      connector: row.connector,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      failureCount: row.failure_count,
      lastError: row.last_error,
      metadata: parseJson(row.metadata_json),
    }));
    const jobs = Object.fromEntries(this.db.prepare("SELECT state, COUNT(*) AS count FROM jobs GROUP BY state").all().map((row) => [row.state, row.count]));
    const notificationCounts = Object.fromEntries(this.db.prepare("SELECT state, COUNT(*) AS count FROM notifications GROUP BY state").all().map((row) => [row.state, row.count]));
    const availabilityDays = Object.fromEntries(this.db.prepare("SELECT state, COUNT(*) AS count FROM availability_days GROUP BY state").all().map((row) => [row.state, row.count]));
    return {
      schemaVersion: SCHEMA_VERSION,
      bookings: counts,
      openConflicts: this.db.prepare("SELECT COUNT(*) AS count FROM conflicts WHERE state='open'").get().count,
      jobs,
      notifications: notificationCounts,
      availabilityDays,
      connectors,
      updatedAt: nowIso(),
    };
  }

  backup() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.restrictFilePermissions();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(this.backupRoot, `reservation-ledger-${timestamp}.sqlite`);
    copyFileSync(this.databasePath, target);
    chmodSync(target, 0o600);
    this.audit({ action: "ledger.backup", entityType: "database", entityKey: path.basename(target) });
    return target;
  }

  close() {
    this.db.close();
  }
}
