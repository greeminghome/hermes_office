import path from "node:path";

export const RESERVATION_PLATFORMS = Object.freeze(["naver", "hourplace", "spacecloud"]);
export const BLOCKING_STATUSES = Object.freeze(["pending", "confirmed", "changed"]);

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function reservationSyncConfig(env = process.env) {
  const dataRoot = String(env.RESERVATION_DATA_ROOT || "/data/reservations").trim();
  const writeMode = String(env.RESERVATION_WRITE_MODE || "shadow").trim().toLowerCase();
  if (!new Set(["shadow", "write"]).has(writeMode)) {
    throw new Error("RESERVATION_WRITE_MODE must be shadow or write");
  }
  const timeZone = String(env.RESERVATION_TIME_ZONE || "Asia/Seoul").trim();
  if (timeZone !== "Asia/Seoul") {
    throw new Error("현재 예약 동기화는 Asia/Seoul 시간대만 지원합니다.");
  }
  return Object.freeze({
    enabled: booleanValue(env.RESERVATION_SYNC_ENABLED, false),
    writeMode,
    googleWriteEnabled: booleanValue(env.RESERVATION_GOOGLE_WRITE_ENABLED, false),
    hourplaceFeedEnabled: booleanValue(env.RESERVATION_HOURPLACE_FEED_ENABLED, false),
    naverAvailabilityEnabled: booleanValue(env.RESERVATION_NAVER_AVAILABILITY_ENABLED, false),
    spacecloudWriteEnabled: booleanValue(env.RESERVATION_SPACECLOUD_WRITE_ENABLED, false),
    telegramEnabled: booleanValue(env.RESERVATION_TELEGRAM_ENABLED, false),
    dataRoot,
    databasePath: String(env.RESERVATION_DATABASE_PATH || path.join(dataRoot, "reservation-ledger.sqlite")),
    backupRoot: String(env.RESERVATION_BACKUP_ROOT || path.join(dataRoot, "backups")),
    timeZone,
    venueId: String(env.RESERVATION_VENUE_ID || "hermes-office").trim(),
    venueName: String(env.RESERVATION_VENUE_NAME || "Hermes Office").trim(),
    resourceId: String(env.RESERVATION_RESOURCE_ID || "main-space").trim(),
    pendingBlocks: booleanValue(env.RESERVATION_PENDING_BLOCKS, false),
    bufferBeforeMinutes: positiveInteger(env.RESERVATION_BUFFER_BEFORE_MINUTES, 0, 0),
    bufferAfterMinutes: positiveInteger(env.RESERVATION_BUFFER_AFTER_MINUTES, 0, 0),
    icalPollMs: positiveInteger(env.RESERVATION_ICAL_POLL_MS, 120_000, 10_000),
    reconcileMs: positiveInteger(env.RESERVATION_RECONCILE_MS, 900_000, 60_000),
    browserHealthMs: positiveInteger(env.RESERVATION_BROWSER_HEALTH_MS, 300_000, 60_000),
    workerMs: positiveInteger(env.RESERVATION_WORKER_MS, 15_000, 1_000),
    backupMs: positiveInteger(env.RESERVATION_BACKUP_MS, 86_400_000, 60_000),
    googleTokenPath: String(env.RESERVATION_GOOGLE_TOKEN_PATH || "").trim(),
    googleClientSecretPath: String(env.RESERVATION_GOOGLE_CLIENT_SECRET_PATH || "").trim(),
    googleRedirectUri: String(env.RESERVATION_GOOGLE_REDIRECT_URI || "").trim(),
    sourceConfigPath: String(env.RESERVATION_SOURCES_PATH || "").trim(),
    filteredFeedTokens: Object.freeze({
      hourplace: String(env.RESERVATION_HOURPLACE_FEED_TOKEN || "").trim(),
      spacecloud: String(env.RESERVATION_SPACECLOUD_FEED_TOKEN || "").trim(),
    }),
    browserCdpUrl: String(env.RESERVATION_BROWSER_CDP_URL || env.LIVE_SCREEN_CDP_URL || "").trim(),
    browserTimeoutMs: positiveInteger(env.RESERVATION_BROWSER_TIMEOUT_MS, 20_000, 5_000),
    naver: Object.freeze({
      bizId: String(env.RESERVATION_NAVER_BIZ_ID || "").trim(),
      productId: String(env.RESERVATION_NAVER_PRODUCT_ID || "").trim(),
      productName: String(env.RESERVATION_NAVER_PRODUCT_NAME || "").trim(),
      minimumDurationMinutes: positiveInteger(env.RESERVATION_NAVER_MINIMUM_DURATION_MINUTES, 120, 60),
    }),
    spacecloud: Object.freeze({
      productId: String(env.RESERVATION_SPACECLOUD_PRODUCT_ID || "").trim(),
      spaceId: String(env.RESERVATION_SPACECLOUD_SPACE_ID || "").trim(),
    }),
    gmailPushAudience: String(env.RESERVATION_GMAIL_PUSH_AUDIENCE || "").trim(),
    gmailPushServiceAccount: String(env.RESERVATION_GMAIL_PUSH_SERVICE_ACCOUNT || "").trim().toLowerCase(),
    gmailTopic: String(env.RESERVATION_GMAIL_TOPIC || "").trim(),
    gmailIngestEnabled: booleanValue(env.RESERVATION_GMAIL_INGEST_ENABLED, false),
    gmailPollMs: positiveInteger(env.RESERVATION_GMAIL_POLL_MS, 120_000, 30_000),
    telegramSecretPath: String(env.RESERVATION_TELEGRAM_SECRET_PATH || "").trim(),
  });
}

export function blocksAvailability(status, pendingBlocks = false) {
  if (status === "pending") return pendingBlocks;
  return status === "confirmed" || status === "changed";
}
