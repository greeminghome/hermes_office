export const RESERVATION_BROWSER_SESSIONS = Object.freeze({
  naver: "reservation-naver-ops",
  spacecloud: "reservation-spacecloud-ops",
});

function sessionTargetUrl(configuredUrl, sessionId) {
  const endpoint = new URL(configuredUrl);
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
    throw new Error("예약 운영 브라우저 세션에는 HTTP(S) CDP 주소가 필요합니다.");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/__session_target`;
  endpoint.search = new URLSearchParams({ session: sessionId }).toString();
  endpoint.hash = "";
  return endpoint.toString();
}

async function targetIdForPage(context, page) {
  let session;
  try {
    session = await context.newCDPSession(page);
    const info = await session.send("Target.getTargetInfo");
    return String(info?.targetInfo?.targetId || "");
  } catch {
    return "";
  } finally {
    await session?.detach().catch(() => {});
  }
}

export async function managedReservationSessionPage(browser, config, platform, { fetchImpl = fetch } = {}) {
  const sessionId = RESERVATION_BROWSER_SESSIONS[platform];
  if (!sessionId) throw new Error(`지원하지 않는 예약 브라우저 세션: ${platform}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.browserTimeoutMs);
  timer.unref?.();
  let payload;
  try {
    const response = await fetchImpl(sessionTargetUrl(config.browserCdpUrl, sessionId), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`예약 브라우저 세션 endpoint returned ${response.status}`);
    payload = await response.json();
  } finally {
    clearTimeout(timer);
  }
  const targetId = String(payload?.targetId || "");
  if (!targetId) throw new Error("예약 브라우저 세션 target이 비어 있습니다.");

  const deadline = Date.now() + config.browserTimeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (await targetIdForPage(context, page) === targetId) {
          await page.evaluate((name) => { window.name = name; }, `hermes-${sessionId}`).catch(() => {});
          return { page, sessionId, targetId };
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("예약 브라우저 세션 page를 CDP에서 찾지 못했습니다.");
}

export const browserSessionPageContracts = Object.freeze({ sessionTargetUrl });
