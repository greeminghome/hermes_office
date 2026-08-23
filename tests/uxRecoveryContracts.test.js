import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/App.jsx", import.meta.url);
const kanbanPath = new URL("../src/HermesKanban.jsx", import.meta.url);
const officePath = new URL("../src/HermesOffice.jsx", import.meta.url);
const stylesPath = new URL("../src/styles.css", import.meta.url);

test("Kanban exposes touch and keyboard status movement without bypassing move policy", async () => {
  const source = await readFile(kanbanPath, "utf8");

  assert.match(source, /className="kanban-card-status-control"/);
  assert.match(source, /aria-label={`\$\{task\.title\} 상태 이동`}/);
  assert.match(source, /onChange=\{\(event\) => openMoveDialog\(task\.id, event\.target\.value\)\}/);
  assert.match(source, /aria-label="업무 상태 이동"/);
  assert.match(source, /openMoveDialog\(taskId, targetStatus\)/);
  assert.match(source, /targetStatus !== "review"/);
});

test("meeting room switches rosters above nine people to a non-overlapping grid", async () => {
  const [source, styles] = await Promise.all([
    readFile(officePath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);

  assert.match(source, /const usesExpandedLayout = participants\.length > 9/);
  assert.match(source, /meeting-desk \$\{usesExpandedLayout \? "expanded" : ""\}/);
  assert.match(source, /usesExpandedLayout \? "dynamic" : `seat-\$\{index \+ 1\}`/);
  assert.match(styles, /\.meeting-desk\.expanded\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /\.meeting-desk\.expanded \.meeting-seat\.dynamic\s*\{[\s\S]*?position:\s*static/);
});

test("system navigation follows the tabs pattern and announces async state", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /aria-selected=\{activeSection === id\}/);
  assert.match(source, /role="tabpanel"/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(source, new RegExp(`"${key}"`));
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
});

test("profile creation has an explicit mode and blocks duplicate IDs before a write", async () => {
  const source = await readFile(appPath, "utf8");
  const createStart = source.indexOf("const createProfile = () => {");
  const runWrite = source.indexOf("runSettingsWrite(async () => {", createStart);
  const duplicateCheck = source.indexOf("profiles.some", createStart);

  assert.match(source, /const \[profileMode, setProfileMode\] = useState\("edit"\)/);
  assert.match(source, /새 구성원 만들기/);
  assert.match(source, /프로필 생성/);
  assert.ok(createStart >= 0 && duplicateCheck > createStart && duplicateCheck < runWrite, "duplicate validation must happen before the network write flow");
  assert.match(source, /이미 존재하는 프로필 ID입니다/);
});

test("profile saves expose step results, readback, and recoverable retry actions", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /const executeProfileSave = async/);
  assert.match(source, /pendingRequests: requests\.slice\(index\)/);
  assert.match(source, /hermesFetch\("\/api\/profiles", \{ timeoutMs: 15000 \}\)/);
  assert.match(source, /실패 단계부터 다시 시도/);
  assert.match(source, /저장 결과 다시 확인/);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
});

test("operations console distinguishes outages and verifies mutable settings", async () => {
  const [source, releaseStyles] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(new URL("../src/systemPro.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /connection === "offline" \|\| connection === "error"/);
  assert.match(source, /readOnly={profileMode === "edit"}/);
  assert.match(source, /저장된 역할이 입력값과 일치하지 않습니다/);
  assert.match(source, /hermesFetch\("\/api\/model\/info", \{ timeoutMs: 15000 \}\)/);
  assert.match(source, /모델은 변경됐지만 컨텍스트 저장에 실패했습니다/);
  assert.match(source, /fieldset className="settings-fieldset" disabled={settingsBusy}/);
  assert.match(source, /className="settings-notice-slot"/);
  assert.match(source, /activeSection !== "overview" && <div className="system-settings-grid">/);
  assert.match(source, /readback\?\.config_context_length/);
  assert.match(source, /컨텍스트만 다시 저장/);
  assert.match(source, /status: "verification-failed"/);
  assert.match(source, /current\?\.status === "verification-failed"/);
  assert.match(releaseStyles, /grid-template-rows: auto auto auto auto auto minmax\(0, 1fr\)/);
  assert.match(source, /className="system-panel-intro"/);
  assert.match(source, /className="settings-summary-grid"/);
  assert.match(releaseStyles, /\.settings-notice\.error/);
  assert.match(releaseStyles, /\.professional-system > \.system-overview-section,[\s\S]*flex: 0 0 auto/);
  assert.match(releaseStyles, /overflow-y: auto !important/);
});
