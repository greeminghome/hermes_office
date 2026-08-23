import { chromium } from "playwright-core";
import { sha256 } from "../normalization.js";
import { managedReservationSessionPage } from "./browserSessionPage.js";

const MANAGED_BY = "hermes-reservation-sync";
const SUPPORTED_PLATFORMS = new Set(["spacecloud"]);
let connectedBrowserPromise = null;
let writerQueue = Promise.resolve();

function shortError(error) {
  return String(error?.message || error).replace(/\s+/g, " ").slice(0, 300);
}

function parseReference(value) {
  if (!value) return { version: 1, items: [] };
  try {
    const parsed = JSON.parse(value);
    return parsed && Array.isArray(parsed.items) ? parsed : { version: 1, items: [] };
  } catch {
    return { version: 1, items: [] };
  }
}

function referenceString(platform, items) {
  return JSON.stringify({ version: 1, platform, items });
}

function kstParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function dateKey(value) {
  const parts = kstParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function targetSegments(booking, projection) {
  const hourMs = 60 * 60 * 1000;
  const startMs = Math.floor(new Date(booking.start_at).getTime() / hourMs) * hourMs;
  const endRaw = new Date(booking.end_at).getTime();
  const endMs = Math.ceil(endRaw / hourMs) * hourMs;
  const tag = sha256(projection.projection_uid).slice(0, 10);
  const revisionTag = projection.payload_hash.slice(0, 5);
  const segments = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const current = kstParts(cursor);
    const nextMidnight = Date.parse(`${current.year}-${current.month}-${current.day}T15:00:00.000Z`);
    const segmentEnd = Math.min(endMs, nextMidnight);
    const index = segments.length + 1;
    const start = kstParts(cursor);
    const end = kstParts(segmentEnd);
    const endHour = dateKey(cursor) === dateKey(segmentEnd) ? Number(end.hour) : 24;
    const name = `Hermes차단${tag}${index}${revisionTag}`;
    const marker = `HERMES_SYNC_UID:${tag}-${index} HASH:${revisionTag}`;
    segments.push({
      name,
      marker,
      date: `${start.year}-${start.month}-${start.day}`,
      startHour: Number(start.hour),
      endHour,
    });
    cursor = segmentEnd;
  }
  return segments;
}

function monthDelta(from, to) {
  return (Number(to.year) - Number(from.year)) * 12 + Number(to.month) - Number(from.month);
}

function currentKstMonth() {
  const current = kstParts(Date.now());
  return { year: Number(current.year), month: Number(current.month) };
}

function dateParts(date) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function calendarCellIndex({ year, month, day }) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return firstDay + day - 1;
}

function rewrittenCdpWebSocketUrl(configuredUrl, advertisedUrl) {
  const configured = new URL(configuredUrl);
  if (configured.protocol === "ws:" || configured.protocol === "wss:") return configured.toString();
  const advertised = new URL(advertisedUrl);
  advertised.protocol = configured.protocol === "https:" ? "wss:" : "ws:";
  advertised.host = configured.host;
  const prefix = configured.pathname.replace(/\/$/, "");
  advertised.pathname = `${prefix}${advertised.pathname}`;
  return advertised.toString();
}

async function resolvedCdpEndpoint(configuredUrl, timeoutMs) {
  const configured = new URL(configuredUrl);
  if (configured.protocol === "ws:" || configured.protocol === "wss:") return configured.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const versionUrl = `${configuredUrl.replace(/\/$/, "")}/json/version`;
    const response = await fetch(versionUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP version endpoint returned ${response.status}`);
    const version = await response.json();
    if (!version.webSocketDebuggerUrl) throw new Error("CDP websocket URL이 없습니다.");
    return rewrittenCdpWebSocketUrl(configuredUrl, version.webSocketDebuggerUrl);
  } finally {
    clearTimeout(timer);
  }
}

async function reservationBrowser(config) {
  if (!config.browserCdpUrl) throw new Error("RESERVATION_BROWSER_CDP_URL이 설정되지 않았습니다.");
  if (!connectedBrowserPromise) {
    connectedBrowserPromise = resolvedCdpEndpoint(config.browserCdpUrl, config.browserTimeoutMs)
      .then((endpoint) => chromium.connectOverCDP(endpoint, { timeout: config.browserTimeoutMs }))
      .then((browser) => {
        browser.on("disconnected", () => { connectedBrowserPromise = null; });
        return browser;
      })
      .catch((error) => {
        connectedBrowserPromise = null;
        throw error;
      });
  }
  return connectedBrowserPromise;
}

async function visibleLocator(locator, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("표시된 예약 플랫폼 컨트롤을 찾지 못했습니다.");
}

async function navigateSpacecloudMonth(page, config, date) {
  if (!config.spacecloud.productId || !config.spacecloud.spaceId) {
    throw new Error("SpaceCloud writer 상품 및 공간 ID가 설정되지 않았습니다.");
  }
  const url = `https://partner.spacecloud.kr/reservation-calendar?product=${encodeURIComponent(config.spacecloud.productId)}&space=${encodeURIComponent(config.spacecloud.spaceId)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const add = page.getByText("예약추가", { exact: true });
  try {
    await visibleLocator(add, config.browserTimeoutMs);
  } catch {
    throw new Error("SpaceCloud 로그인이 필요하거나 예약 캘린더에 접근할 수 없습니다.");
  }
  const target = dateParts(date);
  const header = page.getByText(/^20\d{2}\.\d{1,2}$/, { exact: true }).first();
  await header.waitFor({ state: "visible", timeout: config.browserTimeoutMs });
  const headerText = String(await header.textContent() || "");
  const match = headerText.match(/(20\d{2})\.(\d{1,2})/);
  if (!match) throw new Error("SpaceCloud 캘린더 월을 읽지 못했습니다.");
  const delta = monthDelta({ year: Number(match[1]), month: Number(match[2]) }, target);
  if (Math.abs(delta) > 18) throw new Error("SpaceCloud 자동 차단 가능 범위(18개월)를 벗어났습니다.");
  const direction = delta >= 0 ? "다음달" : "이전달";
  for (let index = 0; index < Math.abs(delta); index += 1) {
    await (await visibleLocator(page.getByText(direction, { exact: true }), config.browserTimeoutMs)).click();
    await page.waitForTimeout(120);
  }
}

async function selectSpacecloudDate(page, date) {
  const target = dateParts(date);
  await (await visibleLocator(page.getByTitle("달력 레이어팝업 열림"))).click();
  const delta = monthDelta(currentKstMonth(), target);
  if (Math.abs(delta) > 18) throw new Error("SpaceCloud 예약 날짜가 자동 입력 범위를 벗어났습니다.");
  const direction = delta >= 0 ? "다음" : "이전";
  for (let index = 0; index < Math.abs(delta); index += 1) {
    await (await visibleLocator(page.getByText(direction, { exact: true }))).click();
    await page.waitForTimeout(100);
  }
  const table = page.getByRole("table", { name: "달력 월간 테이블" });
  await table.locator("td").nth(calendarCellIndex(target)).click();
  const select = page.getByText("선택", { exact: true });
  if (await select.count()) await (await visibleLocator(select)).click();
}

async function openSpacecloudItem(page, config, item) {
  await navigateSpacecloudMonth(page, config, item.date);
  const event = page.getByText(item.name, { exact: false });
  try {
    await visibleLocator(event, 3_000);
  } catch {
    return false;
  }
  await (await visibleLocator(event, 3_000)).click();
  const detail = await page.locator("body").innerText();
  return detail.includes(item.marker) && detail.includes(item.name);
}

async function createSpacecloudItem(page, config, item) {
  await navigateSpacecloudMonth(page, config, item.date);
  await (await visibleLocator(page.getByText("예약추가", { exact: true }), config.browserTimeoutMs)).click();
  await selectSpacecloudDate(page, item.date);
  await page.getByRole("combobox", { name: "예약시간 *" }).selectOption({ label: `${item.startHour} 시` });
  await page.getByRole("combobox", { name: "이용종료 시간 선택" }).selectOption({ label: `${item.endHour} 시` });
  await page.getByRole("textbox", { name: "예약자명" }).fill(item.name);
  await page.getByRole("textbox").last().fill(`${MANAGED_BY} ${item.marker}`);
  await (await visibleLocator(page.getByText("확인", { exact: true }), config.browserTimeoutMs)).click();
  await page.waitForTimeout(350);
  if (!await openSpacecloudItem(page, config, item)) throw new Error("SpaceCloud 차단 read-back이 일치하지 않습니다.");
  return item;
}

async function removeSpacecloudItem(page, config, item) {
  if (!await openSpacecloudItem(page, config, item)) return { ...item, absent: true };
  const body = await page.locator("body").innerText();
  if (!body.includes(MANAGED_BY) || !body.includes(item.marker)) {
    throw new Error("Hermes 소유권이 확인되지 않은 SpaceCloud 예약은 삭제하지 않습니다.");
  }
  await (await visibleLocator(page.getByText("예약 삭제", { exact: true }), config.browserTimeoutMs)).click();
  const confirm = page.locator("button:visible, a:visible").filter({ hasText: /^확인$/ }).last();
  await confirm.click();
  await page.waitForTimeout(350);
  if (await openSpacecloudItem(page, config, item)) throw new Error("SpaceCloud 차단 삭제 read-back에 실패했습니다.");
  return { ...item, absent: true };
}

async function defaultPlatformAdapter(platform, config) {
  const browser = await reservationBrowser(config);
  if (platform === "spacecloud") {
    const { page } = await managedReservationSessionPage(browser, config, platform);
    return {
      ensure: (item) => createSpacecloudItem(page, config, item),
      remove: (item) => removeSpacecloudItem(page, config, item),
      read: (item) => openSpacecloudItem(page, config, item),
    };
  }
  throw new Error(`지원하지 않는 판매 채널 writer: ${platform}`);
}

async function probeSpacecloud(config) {
  const browser = await reservationBrowser(config);
  const { page, sessionId, targetId } = await managedReservationSessionPage(browser, config, "spacecloud");
  await navigateSpacecloudMonth(page, config, dateKey(Date.now()));
  return {
    platform: "spacecloud",
    state: "ready",
    authenticated: true,
    managementUiReady: true,
    liveSessionId: sessionId,
    targetId,
  };
}

async function applyProjection({ ledger, config, projectionId, adapters = {} }) {
  const projection = ledger.getProjection(projectionId);
  if (!projection || !SUPPORTED_PLATFORMS.has(projection.target_platform)) {
    throw new Error("판매 채널 projection을 찾지 못했습니다.");
  }
  const booking = ledger.getBookingRowById(projection.booking_id);
  if (!booking) throw new Error("판매 채널에 반영할 예약을 찾지 못했습니다.");
  const platform = projection.target_platform;
  const connector = `${platform}-browser-writer`;
  const checkpoint = ledger.getCheckpoint(connector);
  const attempt = (projection.attempt_count || 0) + 1;
  ledger.updateProjection(projection.id, { state: "applying", attemptCount: attempt, lastError: "" });
  try {
    const adapter = adapters[platform] || await defaultPlatformAdapter(platform, config);
    const previous = parseReference(projection.external_ref);
    if (projection.desired_action === "remove") {
      for (const item of previous.items.length ? previous.items : targetSegments(booking, projection)) await adapter.remove(item);
      const externalRef = referenceString(platform, previous.items);
      ledger.updateProjection(projection.id, { state: "removed", externalRef, readBackAt: new Date().toISOString(), lastError: "" });
      ledger.updateCheckpoint(connector, { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), failureCount: 0, lastError: "",
        metadata: { ...(checkpoint?.metadata || {}), state: "ready", enabled: true, authenticated: true, managementUiReady: true } });
      return { state: "removed", externalRef };
    }

    const desiredItems = targetSegments(booking, projection);
    const appliedItems = [];
    for (const desired of desiredItems) {
      const existing = previous.items.find((item) => item.name === desired.name && item.date === desired.date);
      if (existing && await adapter.read(existing)) appliedItems.push(existing);
      else appliedItems.push(await adapter.ensure(desired));
    }
    for (const old of previous.items) {
      if (!appliedItems.some((item) => item.name === old.name && item.date === old.date && item.id === old.id)) await adapter.remove(old);
    }
    for (const item of appliedItems) {
      if (!await adapter.read(item)) throw new Error(`${platform} 차단 read-back이 누락되었습니다.`);
    }
    const externalRef = referenceString(platform, appliedItems);
    ledger.updateProjection(projection.id, { state: "applied", externalRef, readBackAt: new Date().toISOString(), lastError: "" });
    ledger.updateCheckpoint(connector, { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), failureCount: 0, lastError: "",
      metadata: { ...(checkpoint?.metadata || {}), state: "ready", enabled: true, authenticated: true, managementUiReady: true } });
    return { state: "applied", externalRef };
  } catch (error) {
    const message = shortError(error);
    ledger.updateProjection(projection.id, { state: "retrying", attemptCount: attempt, lastError: message });
    ledger.updateCheckpoint(connector, {
      lastAttemptAt: new Date().toISOString(),
      failureCount: (checkpoint?.failure_count || 0) + 1,
      lastError: message,
      metadata: { ...(checkpoint?.metadata || {}), state: /로그인|authentication|auth(?:orization)? required/i.test(message) ? "auth-required" : "degraded",
        enabled: true, authenticated: !/로그인|authentication|auth(?:orization)? required/i.test(message), managementUiReady: false },
    });
    throw error;
  }
}

export function applyBrowserPlatformProjection(options) {
  const run = () => applyProjection(options);
  const result = writerQueue.then(run, run);
  writerQueue = result.catch(() => {});
  return result;
}

export function probeSpacecloudBrowserWriter({ config }) {
  const run = () => probeSpacecloud(config);
  const result = writerQueue.then(run, run);
  writerQueue = result.catch(() => {});
  return result;
}

export const browserPlatformContracts = Object.freeze({
  targetSegments,
  parseReference,
  referenceString,
  calendarCellIndex,
  rewrittenCdpWebSocketUrl,
});
