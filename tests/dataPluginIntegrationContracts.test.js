import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isExactGoogleDriveReadonlyScope } from "../googleDriveMirrorContracts.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Google Drive mirror accepts only the exact read-only OAuth scope", () => {
  assert.equal(isExactGoogleDriveReadonlyScope("https://www.googleapis.com/auth/drive.readonly"), true);
  assert.equal(isExactGoogleDriveReadonlyScope("https://www.googleapis.com/auth/drive"), false);
  assert.equal(isExactGoogleDriveReadonlyScope("https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file"), false);
  assert.equal(isExactGoogleDriveReadonlyScope(""), false);
});

test("Data Room never aliases a missing space to the first filesystem root", async () => {
  const room = await readFile(path.join(projectRoot, "src", "DataRoom.jsx"), "utf8");

  assert.match(room, /roots\.find\(\(root\) => spaceForRoot\(root\)\?\.id === spaceId\) \?\? null/);
  assert.doesNotMatch(room, /\?\? roots\[0\]/);
  assert.match(room, /저장소가 서버에 연결되지 않았습니다/);
  assert.match(room, /실제 Google Drive 자료가 아직 동기화되지 않았습니다/);
  assert.match(room, /DRIVE_PLACEHOLDER_FILES/);
  assert.match(room, /drive-status/);
  assert.match(room, /driveReadyKeyRef\.current === driveReadyKey/);
  assert.match(room, /setDriveRefreshVersion\(\(current\) => current \+ 1\)/);
});

test("server starts the authenticated Google Drive mirror without exposing OAuth data", async () => {
  const [server, compose, mirror] = await Promise.all([
    readFile(path.join(projectRoot, "server.js"), "utf8"),
    readFile(path.join(projectRoot, "docker-compose.office.yml"), "utf8"),
    readFile(path.join(projectRoot, "googleDriveMirror.js"), "utf8"),
  ]);
  assert.match(server, /startGoogleDriveMirror\(\)/);
  assert.match(server, /\/bridge\/data-room\/drive-status/);
  assert.match(compose, /HERMES_GOOGLE_TOKEN_PATH: "\$\{HERMES_GOOGLE_TOKEN_PATH:-\/run\/secrets\/google_office_readonly_token\.json\}"/);
  assert.doesNotMatch(compose, /\/google_token\.json:\/run\/secrets\/google_token\.json:ro/);
  assert.match(compose, /HERMES_GOOGLE_CLIENT_SECRET_PATH: "\$\{HERMES_GOOGLE_CLIENT_SECRET_PATH:-\/run\/secrets\/google_client_secret\.json\}"/);
  assert.match(compose, /\.\/deploy\/secrets:\/run\/secrets:ro/);
  assert.match(mirror, /includeItemsFromAllDrives: true/);
  assert.match(mirror, /supportsAllDrives: true/);
  assert.match(mirror, /!isExactGoogleDriveReadonlyScope\(token\.scope\)/);
  assert.match(mirror, /class ByteLimitTransform extends Transform/);
  assert.match(mirror, /new ByteLimitTransform\(maxFileBytes\)/);
  assert.match(mirror, /partial: true, entries: checkpointEntries/);
  assert.match(mirror, /GOOGLE_DRIVE_MIRROR_READ_ONLY === "true"/);
  assert.match(mirror, /const readOnlyInterval = setInterval/);
  assert.match(mirror, /drive\.files\.list\([\s\S]*?signal: controller\.signal/);
  assert.match(mirror, /writeFileAtomic\(path\.join\(mirrorRoot, "asset_manifest\.csv"\)/);
  assert.doesNotMatch(mirror, /sendJson\([^\n]+token/i);
});

test("Instagram is one canonical shared integration inside the standard plugin grid", async () => {
  const hub = await readFile(path.join(projectRoot, "src", "PluginHub.jsx"), "utf8");

  assert.match(hub, /const INSTAGRAM_OWNER_PROFILE = "default"/);
  assert.match(hub, /loadInstagramStatus\(INSTAGRAM_OWNER_PROFILE\)/);
  assert.match(hub, /connectInstagram\(INSTAGRAM_OWNER_PROFILE\)/);
  assert.match(hub, /disconnectInstagram\(INSTAGRAM_OWNER_PROFILE, selectedAccountId\)/);
  assert.match(hub, /<article className=\{`plugin-card instagram-plugin-card/);
  assert.match(hub, /<div className="plugin-grid official-toolset-grid">\s*<InstagramIntegrationCard filter=\{filter\} \/>/);
  assert.doesNotMatch(hub, /<InstagramIntegrationCard key=\{selectedProfile\}/);
  assert.doesNotMatch(hub, /loadInstagramStatus\(profileName\)/);
});
