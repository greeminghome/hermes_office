import { promises as fs } from "node:fs";

async function telegramConfig(secretPath) {
  if (!secretPath) return null;
  const payload = JSON.parse(await fs.readFile(secretPath, "utf8"));
  const botToken = String(payload.bot_token || payload.botToken || "").trim();
  const chatId = String(payload.chat_id || payload.chatId || "").trim();
  return botToken && chatId ? { botToken, chatId } : null;
}

function platformLabel(platform) {
  return ({ naver: "네이버", hourplace: "아워플레이스", spacecloud: "스페이스클라우드", manual: "수동 일정" })[platform] || platform;
}

function eventLabel(eventType) {
  return ({ "booking.created": "예약 접수", "booking.changed": "예약 변경", "booking.cancelled": "예약 취소",
    "booking.conflict": "예약 충돌", "connector.failed": "연동 장애" })[eventType] || "예약 알림";
}

function formatNotification(item, booking, timeZone, venueName) {
  if (!booking) return `[${eventLabel(item.event_type)}]\nHermes 예약 동기화 상태를 확인해주세요.`;
  const start = new Intl.DateTimeFormat("ko-KR", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(booking.startAt));
  const end = new Intl.DateTimeFormat("ko-KR", { timeZone, timeStyle: "short" }).format(new Date(booking.endAt));
  return `[${eventLabel(item.event_type)} · ${platformLabel(booking.sourcePlatform)}]\n일시: ${start} ~ ${end}\n장소: ${venueName}\n예약번호: ${booking.externalBookingIdMasked}`;
}

export async function deliverNotificationOutbox({ ledger, config, fetchImpl = fetch, limit = 10 }) {
  if (!config.telegramEnabled) return { state: "disabled", processed: 0 };
  const secret = await telegramConfig(config.telegramSecretPath);
  if (!secret) throw new Error("예약 Telegram secret이 설정되지 않았습니다.");
  const items = ledger.claimNotifications(limit);
  let sent = 0;
  for (const item of items) {
    try {
      const booking = item.booking_id ? ledger.getBookingById(item.booking_id) : null;
      const response = await fetchImpl(`https://api.telegram.org/bot${secret.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: secret.chatId, text: formatNotification(item, booking, config.timeZone, config.venueName),
          disable_web_page_preview: true }),
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000 || null;
        const error = new Error(`Telegram HTTP ${response.status}`);
        error.retryAfterMs = retryAfter;
        throw error;
      }
      ledger.completeNotification(item.id);
      sent += 1;
    } catch (error) {
      ledger.failNotification(item.id, error, item.attempt_count + 1, error.retryAfterMs);
    }
  }
  return { state: "complete", processed: items.length, sent };
}
