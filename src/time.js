export const KOREA_TIME_ZONE = "Asia/Seoul";

export function formatKoreaDateTime(value, options = {}) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KOREA_TIME_ZONE,
    ...options,
  }).format(value instanceof Date ? value : new Date(value));
}

export function formatKoreaHeaderDate(value = new Date()) {
  return formatKoreaDateTime(value, {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

export function formatKoreaClock(value = new Date(), withSeconds = true) {
  return formatKoreaDateTime(value, {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

export function formatKoreaShortDateTime(value) {
  return formatKoreaDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatKoreaAgentContext(value = new Date()) {
  return `현재 한국 시간(KST, Asia/Seoul): ${formatKoreaDateTime(value, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })}`;
}
