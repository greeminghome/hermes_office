import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/App.jsx", import.meta.url);
const consolePath = new URL("../src/MeetingConsole.jsx", import.meta.url);
const stylesPath = new URL("../src/styles.css", import.meta.url);

test("runtime meeting tabs expose selection, close, and ten-minute archive state", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /className="meeting-runtime-tab-close"/);
  assert.match(app, /aria-label={`\$\{cleanMeetingTopic\(meeting\.topic\)\} 회의 종료`}/);
  assert.match(app, /meetingArchiveCountdown\(meeting, meetingClock\)/);
  assert.match(app, /isMeetingArchiveDue\(meeting, now\)/);
  assert.doesNotMatch(app, /\}, 1200\)/);
});

test("meeting console can terminate Hermes sessions and archive its current record", async () => {
  const source = await readFile(consolePath, "utf8");
  assert.match(source, /gateway\.request\("session\.close", \{ session_id: sessionId \}, 10000\)/);
  assert.match(source, /persistMeeting\(finalEntries, "complete", round, finalOutcome\)/);
  assert.match(source, /onMeetingClosed\?\.\(\{ meetingId, completedAt, reason, outcome: finalOutcome \}\)/);
  assert.match(source, />\{phase === "complete" \? "지금 보관" : "회의 종료"\}<\/button>/);
});

test("fullscreen meeting layout owns the remaining viewport without clipping", async () => {
  const styles = await readFile(stylesPath, "utf8");
  assert.match(styles, /\.meeting-console-host:not\(\[hidden\]\)\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.meeting-console-host \.meeting-console\s*\{[\s\S]*?height:\s*100%;[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.meeting-console-host \.meeting-console-body\s*\{[\s\S]*?min-height:\s*0 !important;[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.meeting-runtime-tabs\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*hidden/);
});
