import { blocksAvailability, RESERVATION_PLATFORMS } from "./config.js";
import { projectionUid, sha256, stableJson } from "./normalization.js";
import { detectBookingConflicts } from "./conflictDetector.js";
import { desiredNaverDayPlans, splitBookingIntoNaverDays } from "./naverAvailability.js";

export function desiredProjectionTargets(booking) {
  const source = booking.source_platform;
  return ["google", ...RESERVATION_PLATFORMS.filter((platform) => platform !== source)];
}

export function planBooking(ledger, bookingId, config) {
  const booking = ledger.getBookingRowById(bookingId);
  if (!booking) throw new Error("계획할 예약을 찾지 못했습니다.");
  const blocks = blocksAvailability(booking.status, config.pendingBlocks);
  if (booking.status === "unknown") return [];
  const targets = desiredProjectionTargets(booking);
  const planned = [];
  for (const targetPlatform of targets) {
    const futureSalesBlock = targetPlatform === "google" || new Date(booking.end_at).getTime() > Date.now();
    const desiredAction = blocks && futureSalesBlock ? "ensure" : "remove";
    const uid = projectionUid({
      targetPlatform,
      originPlatform: booking.source_platform,
      externalBookingId: booking.external_booking_id,
      venueId: booking.venue_id,
    });
    const payloadHash = sha256(stableJson({
      uid,
      desiredAction,
      startAt: booking.start_at,
      endAt: booking.end_at,
      status: booking.status,
      revision: booking.revision,
    }));
    const canApplyGoogle = targetPlatform === "google" && config.googleWriteEnabled;
    const usesHourplaceFeed = targetPlatform === "hourplace" && config.hourplaceFeedEnabled;
    const canApplySales = config.writeMode === "write" && (
      targetPlatform === "spacecloud" && config.spacecloudWriteEnabled
    );
    const usesNaverAvailability = targetPlatform === "naver" && config.naverAvailabilityEnabled;
    const state = usesNaverAvailability ? "aggregate" : canApplyGoogle || canApplySales || usesHourplaceFeed ? "desired" : "shadow";
    const projection = ledger.upsertProjection({
      bookingId,
      targetPlatform,
      resourceId: booking.resource_id,
      projectionUid: uid,
      desiredAction,
      state,
      payloadHash,
    });
    if (canApplyGoogle) {
      ledger.enqueueJob("apply-google", { projectionId: projection.id },
        `google:${projection.id}:${desiredAction}:${payloadHash}`);
    }
    if (canApplySales) {
      ledger.enqueueJob("apply-sales", { projectionId: projection.id },
        `${targetPlatform}:${projection.id}:${desiredAction}:${payloadHash}`);
    }
    if (usesHourplaceFeed) {
      ledger.enqueueJob("apply-hourplace-feed", { projectionId: projection.id },
        `hourplace-feed:${projection.id}:${desiredAction}:${payloadHash}`);
    }
    planned.push(projection);
  }
  return planned;
}

export function reconcileNaverAvailabilityPlans(ledger, config) {
  const plans = new Map(desiredNaverDayPlans(ledger.activeBookingRows(), config).map((plan) => [plan.date, plan]));
  const protectedDates = new Set();
  for (const legacy of ledger.legacyNaverProjectionRows()) {
    for (const segment of splitBookingIntoNaverDays(legacy, config)) protectedDates.add(segment.date);
  }
  const existing = ledger.listAvailabilityDays("naver");
  const dates = new Set([...plans.keys(), ...protectedDates, ...existing.map((row) => row.date_key)]);
  const planned = [];
  for (const date of [...dates].sort()) {
    const plan = plans.get(date) || {
      date,
      desired: { date, busy: [], bookingKeys: [], sources: [] },
    };
    const desiredHash = plan.desiredHash || sha256(stableJson(plan.desired));
    const legacyProtected = protectedDates.has(date);
    const canWrite = config.writeMode === "write" && config.naverAvailabilityEnabled && !legacyProtected;
    const day = ledger.upsertAvailabilityDay({
      targetPlatform: "naver",
      resourceId: config.resourceId,
      dateKey: date,
      desiredHash,
      desired: plan.desired,
      state: legacyProtected ? "legacy-protected" : canWrite ? "desired" : "shadow",
    });
    if (canWrite && day.state !== "applied" && day.state !== "restored") {
      ledger.enqueueJob("apply-naver-availability", { availabilityDayId: day.id },
        `naver-availability:${date}:${desiredHash}`);
    }
    planned.push(day);
  }
  return planned;
}

export function refreshConflicts(ledger, config) {
  const conflicts = detectBookingConflicts(ledger.activeBookingRows(), config);
  ledger.replaceConflicts(conflicts);
  return conflicts;
}
