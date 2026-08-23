const CONTEXT_MARKERS = [
  "[internal:agent-office-runtime-context]",
  "[workspace 영역 권한 규칙]",
  "[workspace",
  "[채팅 파일 작업 규칙]",
  "[chat file",
];

const SENSITIVE_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET|COOKIE|AUTH)[A-Z0-9_]*)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SENSITIVE_QUERY = /([?&](?:access_token|token|api_key|key|password|secret|auth)=)[^&#\s]+/gi;
const MAX_ARCHIVE_MESSAGE_CHARS = 20000;

export function sanitizeArchiveText(value = "") {
  let text = String(value ?? "").trim();
  const markerIndex = CONTEXT_MARKERS
    .map((marker) => text.toLowerCase().indexOf(marker.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (markerIndex !== undefined) text = text.slice(0, markerIndex).trim();
  text = text
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, (_match, key) => `${key}=[REDACTED]`)
    .replace(SENSITIVE_QUERY, "$1[REDACTED]");
  if (text.length > MAX_ARCHIVE_MESSAGE_CHARS) {
    return `${text.slice(0, MAX_ARCHIVE_MESSAGE_CHARS)}\n\n[긴 메시지의 나머지 내용은 안전한 표시를 위해 생략되었습니다.]`;
  }
  return text;
}

export function sanitizeArchiveMessages(messages = []) {
  return messages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({ ...message, content: sanitizeArchiveText(message.content) }))
    .filter((message) => message.content);
}
