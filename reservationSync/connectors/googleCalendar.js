import { google } from "googleapis";
import { createReservationGoogleAuth } from "../../reservationIntegrations.js";
import { publicCalendarEvent } from "../../agentCalendarAccess.js";
import { googleEventId } from "../normalization.js";

function reservationCalendarNames(config) {
  const venueName = String(config?.venueName || "Hermes Office").trim() || "Hermes Office";
  return {
    integrated: `${venueName} 전체 예약`,
    manual: `${venueName} 수동 일정`,
    hourplace: `${venueName} 아워플레이스 차단`,
  };
}

async function listCalendars(calendar) {
  const entries = [];
  let pageToken;
  do {
    const response = await calendar.calendarList.list({ maxResults: 250, pageToken });
    entries.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return entries;
}

async function findOrCreateCalendar(calendar, entries, summary, timeZone) {
  const existing = entries.find((item) => item.summary === summary && !item.deleted);
  if (existing?.id) return existing.id;
  const response = await calendar.calendars.insert({ requestBody: { summary, timeZone } });
  if (!response.data.id) throw new Error(`${summary} 캘린더를 생성하지 못했습니다.`);
  return response.data.id;
}

async function ensurePublicReader(calendar, calendarId) {
  try {
    const existing = await calendar.acl.get({ calendarId, ruleId: "default" });
    if (existing.data.role === "reader") return;
    await calendar.acl.update({
      calendarId,
      ruleId: "default",
      requestBody: { scope: { type: "default" }, role: "reader" },
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      await calendar.acl.insert({
        calendarId,
        requestBody: { scope: { type: "default" }, role: "reader" },
      });
    } catch (insertError) {
      if (Number(insertError?.code || insertError?.response?.status) !== 409) throw insertError;
    }
  }
}

async function ensureCalendarUnselected(calendar, calendarId) {
  const entry = await calendar.calendarList.get({ calendarId });
  if (entry.data.selected === false) return;
  await calendar.calendarList.patch({ calendarId, requestBody: { selected: false } });
}

export function hourplacePublicIcalUrl(calendarId) {
  if (!calendarId) throw new Error("아워플레이스용 Google Calendar ID가 없습니다.");
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
}

export async function ensureReservationCalendars({ ledger, config, auth = null }) {
  const connector = "google-calendars";
  const checkpoint = ledger.getCheckpoint(connector);
  const hourplaceReady = !config.hourplaceFeedEnabled
    || (checkpoint?.metadata?.hourplaceCalendarId
      && checkpoint?.metadata?.hourplaceCalendarPublic
      && checkpoint?.metadata?.hourplaceCalendarUnselected);
  if (checkpoint?.metadata?.integratedCalendarId && checkpoint?.metadata?.manualCalendarId && hourplaceReady) {
    return checkpoint.metadata;
  }
  const googleAuth = auth || await createReservationGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth: googleAuth });
  const entries = await listCalendars(calendar);
  const names = reservationCalendarNames(config);
  const integratedCalendarId = await findOrCreateCalendar(calendar, entries, names.integrated, config.timeZone);
  const manualCalendarId = await findOrCreateCalendar(calendar, entries, names.manual, config.timeZone);
  let hourplaceCalendarId = checkpoint?.metadata?.hourplaceCalendarId || "";
  let hourplaceCalendarPublic = false;
  if (config.hourplaceFeedEnabled) {
    hourplaceCalendarId = await findOrCreateCalendar(calendar, entries, names.hourplace, config.timeZone);
    await ensurePublicReader(calendar, hourplaceCalendarId);
    await ensureCalendarUnselected(calendar, hourplaceCalendarId);
    hourplaceCalendarPublic = true;
  }
  const metadata = {
    integratedCalendarId,
    manualCalendarId,
    hourplaceCalendarId,
    hourplaceCalendarPublic,
    hourplaceCalendarUnselected: Boolean(config.hourplaceFeedEnabled && hourplaceCalendarId),
    integratedCalendarName: names.integrated,
    manualCalendarName: names.manual,
    hourplaceCalendarName: names.hourplace,
  };
  ledger.updateCheckpoint(connector, {
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    failureCount: 0,
    lastError: "",
    metadata,
  });
  ledger.audit({ action: "google.calendars.ready", entityType: "connector", entityKey: connector,
    details: {
      integratedCalendarName: names.integrated,
      manualCalendarName: names.manual,
      hourplaceCalendarName: config.hourplaceFeedEnabled ? names.hourplace : "",
    } });
  return metadata;
}

export async function listReservationCalendarEvents({ ledger, config, query, profile, auth = null }) {
  const checkpoint = ledger.getCheckpoint("google-calendars");
  const metadata = checkpoint?.metadata || {};
  const names = reservationCalendarNames(config);
  const available = {
    integrated: {
      key: "integrated",
      name: metadata.integratedCalendarName || names.integrated,
      id: metadata.integratedCalendarId || "",
    },
    manual: {
      key: "manual",
      name: metadata.manualCalendarName || names.manual,
      id: metadata.manualCalendarId || "",
    },
    hourplace: {
      key: "hourplace",
      name: metadata.hourplaceCalendarName || names.hourplace,
      id: metadata.hourplaceCalendarId || "",
    },
  };
  const selected = query.calendars.map((key) => available[key]);
  const unavailable = selected.filter((entry) => !entry?.id).map((entry) => entry?.key || "unknown");
  if (unavailable.length) throw new Error(`준비되지 않은 예약 캘린더: ${unavailable.join(", ")}`);

  const googleAuth = auth || await createReservationGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth: googleAuth });
  const items = [];
  for (const selectedCalendar of selected) {
    const calendarItems = [];
    let pageToken;
    do {
      const remaining = query.limit - calendarItems.length;
      if (remaining <= 0) break;
      const response = await calendar.events.list({
        calendarId: selectedCalendar.id,
        timeMin: query.timeMin,
        timeMax: query.timeMax,
        q: query.query || undefined,
        singleEvents: true,
        showDeleted: false,
        orderBy: "startTime",
        maxResults: Math.min(250, remaining),
        pageToken,
      });
      for (const event of response.data.items || []) {
        if (!event?.id || event.status === "cancelled") continue;
        calendarItems.push(publicCalendarEvent(event, selectedCalendar));
        if (calendarItems.length >= query.limit) break;
      }
      pageToken = calendarItems.length < query.limit ? response.data.nextPageToken || undefined : undefined;
    } while (pageToken);
    items.push(...calendarItems);
  }
  items.sort((left, right) => String(left.startAt).localeCompare(String(right.startAt)) || left.calendar.localeCompare(right.calendar));
  items.splice(query.limit);
  ledger.audit({
    action: "google.calendar.agent-read",
    entityType: "agent",
    entityKey: profile,
    details: {
      calendars: query.calendars,
      timeMin: query.timeMin,
      timeMax: query.timeMax,
      queryUsed: Boolean(query.query),
      returned: items.length,
    },
  });
  return {
    generatedAt: new Date().toISOString(),
    timeZone: config.timeZone,
    range: { startAt: query.timeMin, endAt: query.timeMax },
    calendars: selected.map(({ key, name }) => ({ key, name })),
    count: items.length,
    items,
  };
}

function eventDateTime(value, timeZone) {
  return { dateTime: value, timeZone };
}

function isNotFound(error) {
  return new Set([404, 410]).has(Number(error?.code))
    || new Set([404, 410]).has(Number(error?.response?.status));
}

export async function applyGoogleProjection({ ledger, config, projectionId, auth = null }) {
  const projection = ledger.getProjection(projectionId);
  if (!projection || projection.target_platform !== "google") throw new Error("Google projection을 찾지 못했습니다.");
  const booking = ledger.getBookingRowById(projection.booking_id);
  if (!booking) throw new Error("Google에 반영할 예약을 찾지 못했습니다.");
  const googleAuth = auth || await createReservationGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth: googleAuth });
  const calendars = await ensureReservationCalendars({ ledger, config, auth: googleAuth });
  const calendarId = calendars.integratedCalendarId;
  const eventId = googleEventId(booking.booking_key);
  if (projection.desired_action === "remove") {
    try {
      const existing = await calendar.events.get({ calendarId, eventId });
      const privateProperties = existing.data.extendedProperties?.private || {};
      if (privateProperties.managedBy !== "hermes-reservation-sync" || privateProperties.bookingKey !== booking.booking_key) {
        throw new Error("Hermes가 생성하지 않은 Google 일정은 삭제하지 않습니다.");
      }
      await calendar.events.delete({ calendarId, eventId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    ledger.updateProjection(projection.id, { state: "removed", externalRef: eventId, readBackAt: new Date().toISOString(), lastError: "" });
    return { state: "removed", eventId };
  }
  const requestBody = {
    id: eventId,
    summary: `[예약] ${booking.source_platform === "hourplace" ? "아워플레이스" : booking.source_platform === "spacecloud" ? "스페이스클라우드" : booking.source_platform === "naver" ? "네이버" : "수동"} · ${config.venueName}`,
    description: "Hermes 통합 예약 원장에서 관리하는 조회용 일정입니다. 원본 플랫폼에서만 예약을 변경하거나 취소하세요.",
    start: eventDateTime(booking.start_at, config.timeZone),
    end: eventDateTime(booking.end_at, config.timeZone),
    transparency: "opaque",
    visibility: "private",
    colorId: "2",
    extendedProperties: {
      private: {
        managedBy: "hermes-reservation-sync",
        origin: booking.source_platform,
        bookingKey: booking.booking_key,
        payloadHash: projection.payload_hash,
      },
    },
  };
  try {
    await calendar.events.update({ calendarId, eventId, requestBody, sendUpdates: "none" });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await calendar.events.insert({ calendarId, requestBody, sendUpdates: "none" });
  }
  const readBack = await calendar.events.get({ calendarId, eventId });
  const privateProperties = readBack.data.extendedProperties?.private || {};
  if (privateProperties.bookingKey !== booking.booking_key || privateProperties.payloadHash !== projection.payload_hash) {
    throw new Error("Google Calendar read-back이 원장 projection과 일치하지 않습니다.");
  }
  ledger.updateProjection(projection.id, { state: "applied", externalRef: eventId, readBackAt: new Date().toISOString(), lastError: "" });
  return { state: "applied", eventId };
}

export async function applyHourplaceFeedProjection({ ledger, config, projectionId, auth = null }) {
  const projection = ledger.getProjection(projectionId);
  if (!projection || projection.target_platform !== "hourplace") {
    throw new Error("아워플레이스 projection을 찾지 못했습니다.");
  }
  const booking = ledger.getBookingRowById(projection.booking_id);
  if (!booking) throw new Error("아워플레이스에 반영할 예약을 찾지 못했습니다.");
  if (booking.source_platform === "hourplace") throw new Error("아워플레이스 원본 예약을 아워플레이스 피드에 되돌릴 수 없습니다.");

  const googleAuth = auth || await createReservationGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth: googleAuth });
  const calendars = await ensureReservationCalendars({ ledger, config, auth: googleAuth });
  const calendarId = calendars.hourplaceCalendarId;
  if (!calendarId) throw new Error("아워플레이스용 Google Calendar가 준비되지 않았습니다.");
  const eventId = googleEventId(`hourplace:${booking.booking_key}`);

  if (projection.desired_action === "remove") {
    try {
      const existing = await calendar.events.get({ calendarId, eventId });
      const privateProperties = existing.data.extendedProperties?.private || {};
      if (privateProperties.managedBy !== "hermes-reservation-sync"
        || privateProperties.target !== "hourplace"
        || privateProperties.bookingKey !== booking.booking_key) {
        throw new Error("Hermes가 생성하지 않은 아워플레이스 차단 일정은 삭제하지 않습니다.");
      }
      await calendar.events.delete({ calendarId, eventId, sendUpdates: "none" });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    ledger.updateProjection(projection.id, {
      state: "removed",
      externalRef: eventId,
      readBackAt: new Date().toISOString(),
      lastError: "",
    });
    return { state: "removed", eventId };
  }

  const requestBody = {
    id: eventId,
    summary: "Reserved",
    description: "",
    start: eventDateTime(booking.start_at, config.timeZone),
    end: eventDateTime(booking.end_at, config.timeZone),
    transparency: "opaque",
    visibility: "public",
    extendedProperties: {
      private: {
        managedBy: "hermes-reservation-sync",
        target: "hourplace",
        origin: booking.source_platform,
        bookingKey: booking.booking_key,
        payloadHash: projection.payload_hash,
      },
    },
  };
  try {
    await calendar.events.update({ calendarId, eventId, requestBody, sendUpdates: "none" });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await calendar.events.insert({ calendarId, requestBody, sendUpdates: "none" });
  }
  const readBack = await calendar.events.get({ calendarId, eventId });
  const privateProperties = readBack.data.extendedProperties?.private || {};
  if (privateProperties.managedBy !== "hermes-reservation-sync"
    || privateProperties.target !== "hourplace"
    || privateProperties.bookingKey !== booking.booking_key
    || privateProperties.payloadHash !== projection.payload_hash) {
    throw new Error("아워플레이스 차단 일정 read-back이 원장 projection과 일치하지 않습니다.");
  }
  ledger.updateProjection(projection.id, {
    state: "applied",
    externalRef: eventId,
    readBackAt: new Date().toISOString(),
    lastError: "",
  });
  return { state: "applied", eventId };
}

function manualEventInterval(event, timeZone) {
  if (event.start?.dateTime && event.end?.dateTime) {
    return { startAt: new Date(event.start.dateTime).toISOString(), endAt: new Date(event.end.dateTime).toISOString() };
  }
  if (event.start?.date && event.end?.date) {
    const localMidnight = (value) => new Date(`${value}T00:00:00+09:00`).toISOString();
    return { startAt: localMidnight(event.start.date), endAt: localMidnight(event.end.date) };
  }
  throw new Error(`수동 일정의 시작/종료 시각을 해석할 수 없습니다 (${timeZone}).`);
}

export async function syncManualCalendar({ ledger, config, auth = null, mode = "scheduled" }) {
  const connector = "google-manual-calendar";
  const runId = ledger.startSyncRun(connector, mode);
  const checkpoint = ledger.getCheckpoint(connector);
  const attemptAt = new Date().toISOString();
  try {
    const googleAuth = auth || await createReservationGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth: googleAuth });
    const calendars = await ensureReservationCalendars({ ledger, config, auth: googleAuth });
    const params = {
      calendarId: calendars.manualCalendarId,
      singleEvents: true,
      showDeleted: true,
      maxResults: 2500,
    };
    if (checkpoint?.cursor) params.syncToken = checkpoint.cursor;
    else params.timeMin = new Date(Date.now() - 30 * 86_400_000).toISOString();
    let response;
    try {
      response = await calendar.events.list(params);
    } catch (error) {
      if ((error?.code === 410 || error?.response?.status === 410) && checkpoint?.cursor) {
        response = await calendar.events.list({
          calendarId: calendars.manualCalendarId,
          singleEvents: true,
          showDeleted: true,
          maxResults: 2500,
          timeMin: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        });
      } else throw error;
    }
    let changed = 0;
    let unknown = 0;
    for (const event of response.data.items || []) {
      if (!event.id) continue;
      try {
        const interval = manualEventInterval(event, config.timeZone);
        const result = ledger.ingestBooking({
          sourcePlatform: "manual",
          venueId: config.venueId,
          resourceId: config.resourceId,
          externalBookingId: event.id,
          kind: "manual_block",
          status: event.status === "cancelled" ? "cancelled" : "confirmed",
          ...interval,
          timeZone: config.timeZone,
          summary: "수동 일정",
          rawRef: `google-calendar:${event.id}`,
          sequence: event.sequence || 0,
          sourceUpdatedAt: event.updated || "",
        }, { sourceMessageId: event.id });
        if (result.changed) changed += 1;
      } catch (error) {
        unknown += 1;
        ledger.ingestUnknownObservation({ sourcePlatform: "manual", sourceMessageId: event.id,
          payload: { eventId: event.id, status: event.status || "" }, error: error.message });
      }
    }
    const completedAt = new Date().toISOString();
    ledger.updateCheckpoint(connector, {
      cursor: response.data.nextSyncToken || checkpoint?.cursor || "",
      lastAttemptAt: attemptAt,
      lastSuccessAt: completedAt,
      failureCount: 0,
      lastError: "",
      metadata: { eventCount: (response.data.items || []).length, unknownCount: unknown },
    });
    ledger.finishSyncRun(runId, { state: unknown ? "partial" : "complete", observed: (response.data.items || []).length,
      changed, errors: unknown });
    return { connector, state: unknown ? "partial" : "complete", changed, unknown };
  } catch (error) {
    ledger.updateCheckpoint(connector, { lastAttemptAt: attemptAt,
      failureCount: (checkpoint?.failure_count || 0) + 1, lastError: String(error?.message || error).slice(0, 300) });
    ledger.finishSyncRun(runId, { state: "failed", errors: 1, details: { error: String(error?.message || error).slice(0, 200) } });
    throw error;
  }
}

export async function reconcileManagedGoogleEvents({ ledger, config, auth = null }) {
  const googleAuth = auth || await createReservationGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth: googleAuth });
  const calendars = await ensureReservationCalendars({ ledger, config, auth: googleAuth });
  const activeBookings = new Map(ledger.activeBookingRows().map((booking) => [booking.booking_key, booking]));
  let removed = 0;
  let duplicatesRemoved = 0;
  const managedCalendars = [
    { calendarId: calendars.integratedCalendarId, target: "google" },
    ...(config.hourplaceFeedEnabled && calendars.hourplaceCalendarId
      ? [{ calendarId: calendars.hourplaceCalendarId, target: "hourplace" }]
      : []),
  ];
  for (const managed of managedCalendars) {
    let pageToken;
    do {
      const response = await calendar.events.list({
        calendarId: managed.calendarId,
        privateExtendedProperty: ["managedBy=hermes-reservation-sync"],
        showDeleted: false,
        singleEvents: true,
        maxResults: 2500,
        pageToken,
      });
      for (const event of response.data.items || []) {
        const privateProperties = event.extendedProperties?.private || {};
        if (!event.id || privateProperties.managedBy !== "hermes-reservation-sync") continue;
        if (managed.target === "hourplace" && privateProperties.target !== "hourplace") continue;
        const activeBooking = activeBookings.get(privateProperties.bookingKey);
        const belongsOnTarget = activeBooking
          && !(managed.target === "hourplace" && activeBooking.source_platform === "hourplace");
        if (belongsOnTarget) {
          const canonicalId = managed.target === "hourplace"
            ? googleEventId(`hourplace:${privateProperties.bookingKey}`)
            : googleEventId(privateProperties.bookingKey);
          if (event.id === canonicalId) continue;
          await calendar.events.delete({ calendarId: managed.calendarId, eventId: event.id, sendUpdates: "none" });
          duplicatesRemoved += 1;
          continue;
        }
        await calendar.events.delete({ calendarId: managed.calendarId, eventId: event.id, sendUpdates: "none" });
        removed += 1;
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }
  if (removed) ledger.audit({ action: "google.orphans.removed", entityType: "connector", entityKey: "google-calendars", details: { removed } });
  if (duplicatesRemoved) ledger.audit({ action: "google.duplicates.removed", entityType: "connector", entityKey: "google-calendars", details: { duplicatesRemoved } });
  return { removed, duplicatesRemoved };
}
