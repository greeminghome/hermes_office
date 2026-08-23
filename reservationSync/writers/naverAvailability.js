import { chromium } from "playwright-core";
import { availabilityFingerprint, availableWindowsAfterBusy, canonicalAvailability } from "../naverAvailability.js";
import { managedReservationSessionPage } from "./browserSessionPage.js";

let connectedBrowserPromise = null;
let writerQueue = Promise.resolve();

function shortError(error) {
  return String(error?.message || error).replace(/\s+/g, " ").slice(0, 300);
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
    const response = await fetch(`${configuredUrl.replace(/\/$/, "")}/json/version`, { signal: controller.signal });
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

function dateParts(date) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function calendarCellIndex({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + day - 1;
}

function timeLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`NAVER 운영시간을 해석할 수 없습니다: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function temporaryDateLabel(date) {
  const { year, month, day } = dateParts(date);
  return `${String(year).slice(-2)}.${month}.${day}`;
}

function holidayDateLabel(date) {
  const { year, month, day } = dateParts(date);
  return `${year}년 ${month}월 ${day}일`;
}

function holidayAvailability(date) {
  return canonicalAvailability({ date, source: "holiday", slotMinutes: 60, capacity: 1, intervals: [] });
}

async function navigate(page, config) {
  if (!config.naver.bizId || !config.naver.productId || !config.naver.productName) {
    throw new Error("NAVER writer 사업장, 상품 ID 및 상품명이 설정되지 않았습니다.");
  }
  const url = `https://partner.booking.naver.com/bizes/${encodeURIComponent(config.naver.bizId)}/biz-items/${encodeURIComponent(config.naver.productId)}/schedules`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (/nid\.naver\.com|\/login/i.test(page.url())) throw new Error("NAVER SmartPlace 로그인이 필요합니다.");
  try {
    await page.getByRole("link", { name: "일정설정", exact: true }).waitFor({ state: "visible", timeout: config.browserTimeoutMs });
  } catch (error) {
    if (/nid\.naver\.com|\/login/i.test(page.url())) {
      throw new Error("NAVER SmartPlace 로그인이 필요합니다.", { cause: error });
    }
    throw error;
  }
  if (!await page.getByRole("button", { name: config.naver.productName, exact: true }).count()) {
    throw new Error("NAVER 로그인 계정 또는 예약 상품이 설정과 일치하지 않습니다.");
  }
  return url;
}

async function temporaryEntry(page, date) {
  const label = page.getByText(temporaryDateLabel(date), { exact: true }).first();
  if (!await label.count()) return null;
  let container = label;
  for (let depth = 0; depth < 8; depth += 1) {
    container = container.locator("xpath=..");
    const text = await container.innerText().catch(() => "");
    const editCount = await container.getByRole("button", { name: "수정", exact: true }).count();
    const deleteCount = await container.getByRole("button", { name: "삭제", exact: true }).count();
    if (text.includes("임시 운영") && editCount === 1 && deleteCount === 1) return container;
  }
  throw new Error(`NAVER 임시 운영 항목을 식별하지 못했습니다: ${date}`);
}

async function parseScheduleDialog(dialog, date, source) {
  const fields = dialog.getByRole("textbox");
  const count = await fields.count();
  if (count < 3 || count % 3 !== 0) throw new Error("NAVER 운영시간 입력 구조가 예상과 다릅니다.");
  const capacity = Number(await dialog.getByRole("spinbutton").inputValue());
  const text = await dialog.innerText();
  const stepMatch = text.match(/매\s*(\d+)\s*시간\s*마다/);
  const slotMinutes = Number(stepMatch?.[1] || 1) * 60;
  const intervals = [];
  for (let index = 0; index < count; index += 3) {
    intervals.push({
      startMinute: parseTime(await fields.nth(index).inputValue()),
      lastStartMinute: parseTime(await fields.nth(index + 1).inputValue()),
      price: Number(String(await fields.nth(index + 2).inputValue()).replace(/\D/g, "")),
      capacity,
      slotMinutes,
    });
  }
  return canonicalAvailability({ date, source, capacity, slotMinutes, intervals });
}

async function readBaseSchedule(page, date) {
  const editButtons = page.getByRole("button", { name: "수정", exact: true });
  if (!await editButtons.count()) throw new Error("NAVER 기본 운영시간 수정 버튼을 찾지 못했습니다.");
  await editButtons.first().click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByText("기본 운영시간 수정하기", { exact: true }).waitFor({ state: "visible" });
  const modeWeekend = await dialog.getByRole("radio", { name: "평일/주말 달라요", exact: true }).isChecked();
  const modeSame = await dialog.getByRole("radio", { name: "모든 영업일 같아요", exact: true }).isChecked();
  if (!modeWeekend && !modeSame) {
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    throw new Error("요일별 NAVER 기본 운영시간은 아직 자동 차단할 수 없습니다.");
  }
  const fields = dialog.getByRole("textbox");
  const fieldCount = await fields.count();
  const weekend = new Date(`${date}T00:00:00+09:00`).getDay() % 6 === 0;
  const offset = modeWeekend && weekend ? fieldCount / 2 : 0;
  const selectedCount = modeWeekend ? fieldCount / 2 : fieldCount;
  const capacity = Number(await dialog.getByRole("spinbutton").inputValue());
  const text = await dialog.innerText();
  const stepMatch = text.match(/매\s*(\d+)\s*시간\s*마다/);
  const slotMinutes = Number(stepMatch?.[1] || 1) * 60;
  const intervals = [];
  for (let index = offset; index < offset + selectedCount; index += 3) {
    intervals.push({
      startMinute: parseTime(await fields.nth(index).inputValue()),
      lastStartMinute: parseTime(await fields.nth(index + 1).inputValue()),
      price: Number(String(await fields.nth(index + 2).inputValue()).replace(/\D/g, "")),
      capacity,
      slotMinutes,
    });
  }
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  return canonicalAvailability({ date, source: "base", capacity, slotMinutes, intervals });
}

async function readTemporarySchedule(page, date, entry) {
  await entry.getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "저장", exact: true }).waitFor({ state: "visible" });
  const value = await parseScheduleDialog(dialog, date, "override");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  return value;
}

async function openHolidayEditor(page) {
  const label = page.getByText("휴무일", { exact: true }).first();
  let edit = label.locator("xpath=following::button[normalize-space(.)='수정하기'][1]");
  if (!await edit.count()) edit = page.getByRole("button", { name: "수정하기", exact: true }).first();
  await edit.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByText("휴무일 수정하기", { exact: true }).waitFor({ state: "visible" });
  return dialog;
}

function dateFromHolidayLabel(label) {
  const match = String(label || "").trim().match(/^(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일$/);
  return match
    ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`
    : "";
}

async function holidayDialogState(dialog) {
  const none = await dialog.getByRole("radio", { name: "없어요", exact: true }).isChecked();
  if (none) return { mode: "none", dates: [], complex: false };
  const customButtons = dialog.locator("button[class*='Custom__button-date']");
  const labels = await customButtons.allTextContents();
  const dates = labels.map(dateFromHolidayLabel).filter(Boolean).sort();
  const unknownCustom = labels.some((label) => !dateFromHolidayLabel(label));
  const weekdayChecks = await dialog.getByRole("checkbox").evaluateAll((items) => items.some((item) => item.checked));
  const publicRadios = await dialog.getByRole("radio").evaluateAll((items) => items.some((item) => (
    item.checked && /Public__input/.test(String(item.className || ""))
  )));
  const publicButtons = await dialog.locator("button[class*='Public__button-holiday']").evaluateAll((items) => items.some((item) => (
    /active|selected/i.test(String(item.className || ""))
  )));
  return {
    mode: "configured",
    dates,
    complex: unknownCustom || weekdayChecks || publicRadios || publicButtons,
  };
}

async function readHolidayState(page) {
  const dialog = await openHolidayEditor(page);
  const state = await holidayDialogState(dialog);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  return state;
}

async function readSchedule(page, config, date) {
  await navigate(page, config);
  const holiday = await readHolidayState(page);
  if (holiday.complex) throw new Error("기존 NAVER 정기·공휴일 설정이 있어 자동 차단을 중단했습니다.");
  if (holiday.dates.includes(date)) {
    const value = holidayAvailability(date);
    return { ...value, fingerprint: availabilityFingerprint(value), holidayDates: holiday.dates };
  }
  const entry = await temporaryEntry(page, date);
  const value = entry ? await readTemporarySchedule(page, date, entry) : await readBaseSchedule(page, date);
  return { ...value, fingerprint: availabilityFingerprint(value), holidayDates: holiday.dates };
}

async function selectDateInDialog(dialog, date) {
  const target = dateParts(date);
  const table = dialog.getByRole("table", { name: "달력 테이블" });
  const heading = String(await table.locator("thead").innerText());
  const match = heading.match(/(20\d{2})\.\s*(\d{1,2})\./);
  if (!match) throw new Error("NAVER 달력 월을 읽지 못했습니다.");
  const delta = (target.year - Number(match[1])) * 12 + target.month - Number(match[2]);
  if (Math.abs(delta) > 12) throw new Error("NAVER 일정 차단 가능 범위(12개월)를 벗어났습니다.");
  const direction = delta >= 0 ? "다음 달" : "이전 달";
  for (let index = 0; index < Math.abs(delta); index += 1) {
    await table.getByRole("button", { name: direction, exact: true }).click();
  }
  await table.locator("tbody button").nth(calendarCellIndex(target)).click();
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
}

async function selectHolidayDate(dialog, date) {
  const target = dateParts(date);
  const table = dialog.getByRole("table", { name: "달력 테이블" });
  const heading = String(await table.locator("thead").innerText());
  const match = heading.match(/(20\d{2})\.\s*(\d{1,2})\./);
  if (!match) throw new Error("NAVER 휴무일 달력 월을 읽지 못했습니다.");
  const delta = (target.year - Number(match[1])) * 12 + target.month - Number(match[2]);
  if (Math.abs(delta) > 12) throw new Error("NAVER 휴무일 설정 가능 범위(12개월)를 벗어났습니다.");
  const direction = delta >= 0 ? "다음 달" : "이전 달";
  for (let index = 0; index < Math.abs(delta); index += 1) {
    await table.getByRole("button", { name: direction, exact: true }).click();
  }
  await table.locator("tbody button").nth(calendarCellIndex(target)).click();
  await dialog.getByRole("radio", { name: "한번만", exact: true }).locator("xpath=..").click();
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
}

async function openScheduleEditor(page, date) {
  const entry = await temporaryEntry(page, date);
  if (entry) {
    await entry.getByRole("button", { name: "수정", exact: true }).click();
    return page.getByRole("dialog").last();
  }
  const addExisting = page.getByRole("button", { name: "임시 운영 시간 추가", exact: true });
  if (await addExisting.count()) await addExisting.click();
  else await page.getByRole("button", { name: "설정하기", exact: true }).first().click();
  const dateDialog = page.getByRole("dialog").last();
  await selectDateInDialog(dateDialog, date);
  return page.getByRole("dialog").last();
}

async function replaceField(field, value) {
  await field.click();
  await field.press("Control+A");
  await field.press("Backspace");
  await field.pressSequentially(String(value));
}

async function writeTemporarySchedule(page, config, desired) {
  await navigate(page, config);
  const dialog = await openScheduleEditor(page, desired.date);
  let intervalCount = (await dialog.getByRole("textbox").count()) / 3;
  while (intervalCount < desired.intervals.length) {
    await dialog.getByRole("button", { name: "시간추가", exact: true }).click();
    intervalCount += 1;
  }
  while (intervalCount > desired.intervals.length) {
    await dialog.getByRole("button", { name: "삭제", exact: true }).last().click();
    intervalCount -= 1;
  }
  const fields = dialog.getByRole("textbox");
  for (let index = 0; index < desired.intervals.length; index += 1) {
    const interval = desired.intervals[index];
    await replaceField(fields.nth(index * 3), timeLabel(interval.startMinute));
    await replaceField(fields.nth(index * 3 + 1), timeLabel(interval.lastStartMinute));
    await replaceField(fields.nth(index * 3 + 2), interval.price);
  }
  const capacity = dialog.getByRole("spinbutton");
  await replaceField(capacity, desired.capacity);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  const optionDialog = page.getByRole("dialog").filter({ hasText: "예약 상품 옵션 연결" });
  if (await optionDialog.count()) await optionDialog.getByRole("button", { name: "취소", exact: true }).click();
  await page.waitForTimeout(350);
}

async function restoreBaseSchedule(page, config, date) {
  await navigate(page, config);
  const entry = await temporaryEntry(page, date);
  if (!entry) return;
  await entry.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("heading", { name: "예약 시간대 삭제", exact: true }).waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await page.waitForTimeout(350);
}

async function updateHolidayDate(page, config, date, action, ownedDates) {
  await navigate(page, config);
  const dialog = await openHolidayEditor(page);
  let state = await holidayDialogState(dialog);
  if (state.complex) {
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    throw new Error("기존 NAVER 정기·공휴일 설정이 있어 휴무일 변경을 중단했습니다.");
  }
  const foreignDates = state.dates.filter((item) => !ownedDates.has(item));
  if (foreignDates.length) {
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    throw new Error("Hermes가 소유하지 않은 NAVER 수동 휴무일이 있어 변경을 중단했습니다.");
  }
  const present = state.dates.includes(date);
  if ((action === "add" && present) || (action === "remove" && !present)) {
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    return;
  }
  if (action === "add") {
    if (state.mode === "none") {
      await dialog.getByRole("radio", { name: "있어요", exact: true }).locator("xpath=..").click();
    }
    await dialog.getByRole("button", { name: "+ 날짜로 추가", exact: true }).click();
    await selectHolidayDate(page.getByRole("dialog").last(), date);
  } else {
    const dateButton = dialog.getByRole("button", { name: holidayDateLabel(date), exact: true });
    await dateButton.locator("xpath=..").getByRole("button", { name: "삭제", exact: true }).click();
    state = await holidayDialogState(dialog);
    if (!state.dates.length) {
      await dialog.getByRole("radio", { name: "없어요", exact: true }).locator("xpath=..").click();
    }
  }
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForTimeout(350);
}

async function defaultAdapter(config) {
  const browser = await reservationBrowser(config);
  const { page } = await managedReservationSessionPage(browser, config, "naver");
  return {
    read: (date) => readSchedule(page, config, date),
    apply: (desired) => writeTemporarySchedule(page, config, desired),
    restore: (date) => restoreBaseSchedule(page, config, date),
    applyHoliday: (date, ownedDates) => updateHolidayDate(page, config, date, "add", ownedDates),
    restoreHoliday: (date, ownedDates) => updateHolidayDate(page, config, date, "remove", ownedDates),
  };
}

async function probeNaver(config) {
  const browser = await reservationBrowser(config);
  const { page, sessionId, targetId } = await managedReservationSessionPage(browser, config, "naver");
  await navigate(page, config);
  return {
    platform: "naver",
    state: "ready",
    authenticated: true,
    managementUiReady: true,
    liveSessionId: sessionId,
    targetId,
  };
}

async function applyDay({ ledger, config, availabilityDayId, adapter = null }) {
  let day = ledger.getAvailabilityDayById(availabilityDayId);
  if (!day || day.target_platform !== "naver") throw new Error("NAVER 날짜별 가용시간 계획을 찾지 못했습니다.");
  const connector = "naver-availability-writer";
  const checkpoint = ledger.getCheckpoint(connector);
  const attempt = (day.attempt_count || 0) + 1;
  ledger.updateAvailabilityDay(day.id, { state: "applying", attemptCount: attempt, lastError: "" });
  try {
    const runtime = adapter || await defaultAdapter(config);
    let remote = await runtime.read(day.date_key);
    if (!day.baseline) {
      if (remote.source !== "base") throw new Error("기존 NAVER 임시 운영시간이 있어 자동 차단이 중단되었습니다.");
      day = ledger.updateAvailabilityDay(day.id, { baseline: remote });
    }
    const baseline = day.baseline;
    const ownedHolidayDates = new Set(ledger.listAvailabilityDays("naver")
      .filter((item) => item.applied?.source === "holiday")
      .map((item) => item.date_key));
    ownedHolidayDates.add(day.date_key);
    const desiredIntervals = availableWindowsAfterBusy(
      baseline,
      day.desired.busy || [],
      config.naver.minimumDurationMinutes,
    );
    if (!(day.desired.busy || []).length) {
      if (day.applied) {
        if (remote.fingerprint !== availabilityFingerprint(day.applied)) {
          throw new Error("NAVER 운영시간이 마지막 적용값과 달라 자동 복원을 중단했습니다.");
        }
        if (day.applied.source === "holiday") await runtime.restoreHoliday(day.date_key, ownedHolidayDates);
        else await runtime.restore(day.date_key);
      }
      const readBack = await runtime.read(day.date_key);
      if (readBack.source !== "base" || readBack.fingerprint !== availabilityFingerprint(baseline)) {
        throw new Error("NAVER 기본 운영시간 복원 read-back이 일치하지 않습니다.");
      }
      ledger.updateAvailabilityDay(day.id, { state: "restored", applied: null, readBackAt: new Date().toISOString(), lastError: "" });
      ledger.updateCheckpoint(connector, { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), failureCount: 0, lastError: "",
        metadata: { ...(checkpoint?.metadata || {}), state: "ready", enabled: true, authenticated: true, managementUiReady: true } });
      return { state: "restored", date: day.date_key };
    }
    if (!desiredIntervals.length) {
      const desired = holidayAvailability(day.date_key);
      const desiredFingerprint = availabilityFingerprint(desired);
      if (day.applied && remote.fingerprint !== availabilityFingerprint(day.applied) && remote.fingerprint !== desiredFingerprint) {
        throw new Error("NAVER 운영시간에 수동 변경이 감지되어 전일 차단을 중단했습니다.");
      }
      if (!day.applied && remote.source !== "base" && remote.fingerprint !== desiredFingerprint) {
        throw new Error("Hermes가 소유하지 않은 NAVER 휴무일은 덮어쓰지 않습니다.");
      }
      if (remote.source === "override") {
        await runtime.restore(day.date_key);
        remote = await runtime.read(day.date_key);
        if (remote.source !== "base" || remote.fingerprint !== availabilityFingerprint(baseline)) {
          throw new Error("NAVER 임시 운영시간 제거 read-back이 기본 운영시간과 다릅니다.");
        }
      }
      if (remote.fingerprint !== desiredFingerprint) await runtime.applyHoliday(day.date_key, ownedHolidayDates);
      const readBack = await runtime.read(day.date_key);
      if (readBack.source !== "holiday" || readBack.fingerprint !== desiredFingerprint) {
        throw new Error("NAVER 전일 휴무 read-back이 계획과 일치하지 않습니다.");
      }
      ledger.updateAvailabilityDay(day.id, { state: "applied", applied: desired, readBackAt: new Date().toISOString(), lastError: "" });
      ledger.updateCheckpoint(connector, { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), failureCount: 0, lastError: "",
        metadata: { ...(checkpoint?.metadata || {}), state: "ready", enabled: true, authenticated: true, managementUiReady: true } });
      return { state: "applied", date: day.date_key, intervals: 0, mode: "holiday" };
    }
    const desired = canonicalAvailability({
      date: day.date_key,
      source: "override",
      slotMinutes: baseline.slotMinutes,
      capacity: baseline.capacity,
      intervals: desiredIntervals,
    });
    const desiredFingerprint = availabilityFingerprint(desired);
    if (remote.source === "holiday") {
      if (day.applied?.source !== "holiday" || remote.fingerprint !== availabilityFingerprint(day.applied)) {
        throw new Error("Hermes가 소유하지 않은 NAVER 휴무일은 변경하지 않습니다.");
      }
      await runtime.restoreHoliday(day.date_key, ownedHolidayDates);
      remote = await runtime.read(day.date_key);
      if (remote.source !== "base" || remote.fingerprint !== availabilityFingerprint(baseline)) {
        throw new Error("NAVER 휴무일 해제 read-back이 기본 운영시간과 다릅니다.");
      }
    }
    if (day.applied && remote.fingerprint !== availabilityFingerprint(day.applied) && remote.fingerprint !== desiredFingerprint) {
      throw new Error("NAVER 운영시간에 수동 변경이 감지되어 덮어쓰지 않습니다.");
    }
    if (!day.applied && remote.source !== "base" && remote.fingerprint !== desiredFingerprint) {
      throw new Error("Hermes가 소유하지 않은 NAVER 임시 운영시간은 덮어쓰지 않습니다.");
    }
    if (remote.fingerprint !== desiredFingerprint) await runtime.apply(desired);
    const readBack = await runtime.read(day.date_key);
    if (readBack.source !== "override" || readBack.fingerprint !== desiredFingerprint) {
      throw new Error("NAVER 날짜별 가용시간 read-back이 계획과 일치하지 않습니다.");
    }
    ledger.updateAvailabilityDay(day.id, { state: "applied", applied: desired, readBackAt: new Date().toISOString(), lastError: "" });
    ledger.updateCheckpoint(connector, { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), failureCount: 0, lastError: "",
      metadata: { ...(checkpoint?.metadata || {}), state: "ready", enabled: true, authenticated: true, managementUiReady: true } });
    return { state: "applied", date: day.date_key, intervals: desired.intervals.length };
  } catch (error) {
    const message = shortError(error);
    ledger.updateAvailabilityDay(day.id, { state: "retrying", attemptCount: attempt, lastError: message });
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

export function applyNaverAvailabilityDay(options) {
  const run = () => applyDay(options);
  const result = writerQueue.then(run, run);
  writerQueue = result.catch(() => {});
  return result;
}

export function probeNaverAvailabilityWriter({ config }) {
  const run = () => probeNaver(config);
  const result = writerQueue.then(run, run);
  writerQueue = result.catch(() => {});
  return result;
}

export const naverAvailabilityWriterContracts = Object.freeze({
  parseTime,
  timeLabel,
  temporaryDateLabel,
  holidayDateLabel,
  calendarCellIndex,
  rewrittenCdpWebSocketUrl,
});
