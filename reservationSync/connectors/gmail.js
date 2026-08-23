import { google } from "googleapis";
import { createReservationGoogleAuth } from "../../reservationIntegrations.js";
import { parseReservationEmail } from "../parsers/reservationEmail.js";

export const GMAIL_PARSER_VERSION = 4;

export function sortGmailMessagesOldestFirst(messages = []) {
  return [...messages].sort((left, right) => Number(left?.internalDate || 0) - Number(right?.internalDate || 0));
}

function addedMessageIds(history = []) {
  const ids = new Set();
  for (const entry of history) {
    for (const added of entry.messagesAdded || []) {
      if (added.message?.id) ids.add(added.message.id);
    }
  }
  return [...ids];
}

export async function renewGmailWatch({ ledger, config, auth = null }) {
  if (!config.gmailTopic) throw new Error("Gmail Pub/Sub topic이 설정되지 않았습니다.");
  const googleAuth = auth || await createReservationGoogleAuth();
  const gmail = google.gmail({ version: "v1", auth: googleAuth });
  const response = await gmail.users.watch({
    userId: "me",
    requestBody: { topicName: config.gmailTopic, labelIds: ["INBOX"], labelFilterBehavior: "include" },
  });
  const metadata = { expiration: response.data.expiration || "" };
  ledger.updateCheckpoint("gmail-history", {
    cursor: response.data.historyId || ledger.getCheckpoint("gmail-history")?.cursor || "",
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    failureCount: 0,
    lastError: "",
    metadata,
  });
  return metadata;
}

export async function processGmailHistory({ ledger, config, historyId, auth = null, mode = "push" }) {
  const connector = "gmail-history";
  const runId = ledger.startSyncRun(connector, mode);
  const checkpoint = ledger.getCheckpoint(connector);
  try {
    if (!config.gmailIngestEnabled) throw new Error("실제 이메일 fixture 검증 전이라 Gmail 수집이 비활성화되어 있습니다.");
    const startHistoryId = checkpoint?.cursor;
    if (!startHistoryId) {
      ledger.updateCheckpoint(connector, { cursor: historyId, lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(), failureCount: 0, lastError: "",
        metadata: { ...(checkpoint?.metadata || {}), primed: true } });
      ledger.finishSyncRun(runId, { details: { primed: true } });
      return { state: "primed", changed: 0, unknown: 0 };
    }
    const googleAuth = auth || await createReservationGoogleAuth();
    const gmail = google.gmail({ version: "v1", auth: googleAuth });
    const history = [];
    let pageToken;
    do {
      const response = await gmail.users.history.list({ userId: "me", startHistoryId, historyTypes: ["messageAdded"], pageToken, maxResults: 500 });
      history.push(...(response.data.history || []));
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    let changed = 0;
    let unknown = 0;
    const messages = await Promise.all(addedMessageIds(history).map(async (messageId) => {
      const response = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      return response.data;
    }));
    for (const message of sortGmailMessagesOldestFirst(messages)) {
      const parsed = parseReservationEmail(message, config);
      if (parsed.state !== "parsed") {
        unknown += 1;
        ledger.ingestUnknownObservation({ sourcePlatform: "gmail", sourceMessageId: message.id,
          payload: parsed.metadata, error: parsed.reason });
        continue;
      }
      const result = ledger.ingestBooking(parsed.booking, { sourceMessageId: message.id });
      if (result.changed) changed += 1;
    }
    const completedAt = new Date().toISOString();
    ledger.updateCheckpoint(connector, { cursor: historyId, lastAttemptAt: completedAt, lastSuccessAt: completedAt,
      failureCount: 0, lastError: "",
      metadata: { ...(checkpoint?.metadata || {}), historyEntries: history.length, unknown } });
    ledger.finishSyncRun(runId, { state: unknown ? "partial" : "complete", observed: history.length, changed, errors: unknown });
    return { state: unknown ? "partial" : "complete", changed, unknown };
  } catch (error) {
    ledger.updateCheckpoint(connector, { lastAttemptAt: new Date().toISOString(),
      failureCount: (checkpoint?.failure_count || 0) + 1, lastError: String(error?.message || error).slice(0, 300) });
    ledger.finishSyncRun(runId, { state: "failed", errors: 1, details: { error: String(error?.message || error).slice(0, 200) } });
    throw error;
  }
}

export async function pollReservationGmail({ ledger, config, auth = null, mode = "scheduled" }) {
  const connector = "gmail-poll";
  const runId = ledger.startSyncRun(connector, mode);
  const checkpoint = ledger.getCheckpoint(connector);
  const attemptAt = new Date().toISOString();
  try {
    if (!config.gmailIngestEnabled) throw new Error("Gmail 수집이 비활성화되어 있습니다.");
    const googleAuth = auth || await createReservationGoogleAuth();
    const gmail = google.gmail({ version: "v1", auth: googleAuth });
    const response = await gmail.users.messages.list({
      userId: "me",
      q: "newer_than:1y (from:navercorp.com OR from:spacecloud.kr)",
      maxResults: 100,
    });
    let changed = 0;
    let unknown = 0;
    let skipped = 0;
    const reprocess = Number(checkpoint?.metadata?.parserVersion || 0) < GMAIL_PARSER_VERSION;
    const messages = [];
    for (const item of response.data.messages || []) {
      if (!item.id) continue;
      if (!reprocess && ledger.hasSourceMessage(item.id)) {
        skipped += 1;
        continue;
      }
      const message = await gmail.users.messages.get({ userId: "me", id: item.id, format: "full" });
      messages.push(message.data);
    }
    for (const message of sortGmailMessagesOldestFirst(messages)) {
      const parsed = parseReservationEmail(message, config);
      if (parsed.state !== "parsed") {
        unknown += 1;
        ledger.ingestUnknownObservation({ sourcePlatform: "gmail", sourceMessageId: message.id,
          payload: parsed.metadata, error: parsed.reason });
        continue;
      }
      const result = ledger.ingestBooking(parsed.booking, { sourceMessageId: message.id });
      if (result.changed) changed += 1;
    }
    const completedAt = new Date().toISOString();
    ledger.updateCheckpoint(connector, {
      lastAttemptAt: attemptAt,
      lastSuccessAt: completedAt,
      failureCount: 0,
      lastError: "",
      metadata: { parserVersion: GMAIL_PARSER_VERSION, listed: (response.data.messages || []).length,
        changed, unknown, skipped, reprocessed: reprocess },
    });
    ledger.finishSyncRun(runId, { state: unknown ? "partial" : "complete",
      observed: (response.data.messages || []).length, changed, errors: unknown, details: { skipped } });
    return { connector, state: unknown ? "partial" : "complete", changed, unknown, skipped };
  } catch (error) {
    ledger.updateCheckpoint(connector, { lastAttemptAt: attemptAt,
      failureCount: (checkpoint?.failure_count || 0) + 1, lastError: String(error?.message || error).slice(0, 300) });
    ledger.finishSyncRun(runId, { state: "failed", errors: 1, details: { error: String(error?.message || error).slice(0, 200) } });
    throw error;
  }
}

export async function verifyGmailPushOidc({ authorization, config }) {
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match || !config.gmailPushAudience || !config.gmailPushServiceAccount) return false;
  const verifier = new google.auth.OAuth2();
  const ticket = await verifier.verifyIdToken({ idToken: match[1], audience: config.gmailPushAudience });
  const payload = ticket.getPayload();
  return payload?.email_verified === true
    && String(payload.email || "").toLowerCase() === config.gmailPushServiceAccount;
}

export function decodeGmailPush(body) {
  const encoded = body?.message?.data;
  if (!encoded) throw new Error("Gmail Pub/Sub 메시지 데이터가 없습니다.");
  const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!/^\d+$/.test(String(payload.historyId || ""))) throw new Error("Gmail historyId가 올바르지 않습니다.");
  return { historyId: String(payload.historyId), emailAddress: String(payload.emailAddress || "") };
}
