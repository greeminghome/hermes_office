import { promises as fs } from "node:fs";
import { reservationSourceConfig } from "../../reservationIntegrations.js";
import { parseIcal } from "../parsers/ical.js";

const MAX_ICAL_BYTES = 4 * 1024 * 1024;

async function sourceDefinitions(config) {
  if (!config.sourceConfigPath) return {};
  const payload = JSON.parse(await fs.readFile(config.sourceConfigPath, "utf8"));
  return reservationSourceConfig(payload);
}

function anomaly(previousCount, nextCount) {
  if (!Number.isInteger(previousCount)) return false;
  if (previousCount > 0 && nextCount === 0) return true;
  return previousCount >= 4 && nextCount < Math.floor(previousCount / 2);
}

export async function syncIcalSource({ sourcePlatform, ledger, config, fetchImpl = fetch, mode = "scheduled" }) {
  const connector = `${sourcePlatform}-ical`;
  const runId = ledger.startSyncRun(connector, mode);
  const checkpoint = ledger.getCheckpoint(connector);
  const attemptAt = new Date().toISOString();
  try {
    const definitions = await sourceDefinitions(config);
    const source = definitions[sourcePlatform];
    if (!source?.configured) throw new Error(`${sourcePlatform} iCal 소스가 설정되지 않았습니다.`);
    const headers = { Accept: "text/calendar, text/plain;q=0.9" };
    if (checkpoint?.etag) headers["If-None-Match"] = checkpoint.etag;
    if (checkpoint?.last_modified) headers["If-Modified-Since"] = checkpoint.last_modified;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetchImpl(source.url, { headers, redirect: "error", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 304) {
      ledger.updateCheckpoint(connector, {
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        failureCount: 0,
        lastError: "",
        metadata: { ...(checkpoint?.metadata || {}), notModified: true },
      });
      ledger.finishSyncRun(runId, { details: { notModified: true } });
      return { connector, state: "not-modified", observed: 0, changed: 0 };
    }
    if (!response.ok) throw new Error(`iCal HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_ICAL_BYTES) throw new Error("iCal 응답이 허용 크기를 초과했습니다.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_ICAL_BYTES) throw new Error("iCal 응답이 허용 크기를 초과했습니다.");
    const parsed = parseIcal(body, {
      sourcePlatform,
      venueId: config.venueId,
      resourceId: config.resourceId,
      timeZone: config.timeZone,
    });
    const previousCount = Number.isInteger(checkpoint?.metadata?.eventCount) ? checkpoint.metadata.eventCount : null;
    const anomalous = anomaly(previousCount, parsed.total);
    let changed = 0;
    for (const event of parsed.events) {
      const result = ledger.ingestBooking(event, { sourceMessageId: event.sourceMessageId || event.externalBookingId });
      if (result.changed) changed += 1;
    }
    for (const item of parsed.unknown) {
      ledger.ingestUnknownObservation({
        sourcePlatform,
        sourceMessageId: item.externalBookingId,
        payload: { externalBookingId: item.externalBookingId },
        error: item.reason,
      });
    }
    const missingResult = ledger.markSourceMissing(sourcePlatform,
      parsed.events.map((event) => event.externalBookingId), { anomalous });
    const completedAt = new Date().toISOString();
    ledger.updateCheckpoint(connector, {
      etag: response.headers.get("etag") || checkpoint?.etag || "",
      lastModified: response.headers.get("last-modified") || checkpoint?.last_modified || "",
      lastAttemptAt: attemptAt,
      lastSuccessAt: completedAt,
      failureCount: 0,
      lastError: anomalous ? "비정상적인 항목 감소를 감지해 기존 예약을 보존했습니다." : "",
      metadata: {
        eventCount: parsed.total,
        parsedCount: parsed.events.length,
        unknownCount: parsed.unknown.length,
        anomalous,
        missingPreserved: missingResult.preserved,
      },
    });
    ledger.finishSyncRun(runId, {
      state: parsed.unknown.length ? "partial" : "complete",
      observed: parsed.total,
      changed,
      errors: parsed.unknown.length,
      details: { anomalous, ...missingResult },
    });
    return { connector, state: anomalous ? "preserved" : "complete", observed: parsed.total, changed, unknown: parsed.unknown.length };
  } catch (error) {
    ledger.updateCheckpoint(connector, {
      lastAttemptAt: attemptAt,
      failureCount: (checkpoint?.failure_count || 0) + 1,
      lastError: String(error?.name === "AbortError" ? "iCal 요청 시간 초과" : error?.message || error).slice(0, 300),
    });
    ledger.finishSyncRun(runId, { state: "failed", errors: 1, details: { error: String(error?.message || error).slice(0, 200) } });
    throw error;
  }
}
