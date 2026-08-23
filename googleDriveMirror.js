import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { google } from "googleapis";
import { isExactGoogleDriveReadonlyScope } from "./googleDriveMirrorContracts.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const EXPORTS = new Map([
  ["application/vnd.google-apps.document", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" }],
  ["application/vnd.google-apps.spreadsheet", { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" }],
  ["application/vnd.google-apps.presentation", { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" }],
  ["application/vnd.google-apps.drawing", { mimeType: "application/pdf", extension: ".pdf" }],
]);

const status = {
  enabled: false,
  phase: "disabled",
  files: 0,
  folders: 0,
  skipped: 0,
  lastStartedAt: "",
  lastCompletedAt: "",
  message: "Google Drive 동기화가 설정되지 않았습니다.",
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function oauthClient(tokenPath, secretPath) {
  const token = readJson(tokenPath);
  if (!isExactGoogleDriveReadonlyScope(token.scope)) {
    throw new Error("Google Drive mirror requires an exact drive.readonly token");
  }
  const secret = fs.existsSync(secretPath) ? readJson(secretPath) : {};
  const clientInfo = secret.installed || secret.web || token;
  const client = new google.auth.OAuth2(
    token.client_id || clientInfo.client_id,
    token.client_secret || clientInfo.client_secret,
    clientInfo.redirect_uris?.[0] || "http://localhost",
  );
  client.setCredentials(token);
  return client;
}

function safeSegment(value, fallback = "untitled") {
  const withoutControls = [...String(value || fallback).normalize("NFKC")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? "_" : character;
    })
    .join("");
  const normalized = withoutControls
    .replace(/[\\/]/g, "_")
    .replace(/^\.+$/, "_")
    .trim();
  return (normalized || fallback).slice(0, 160);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function listDriveFiles(drive, maxItems, timeoutMs) {
  const files = [];
  let pageToken;
  do {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await drive.files.list({
        q: "trashed = false",
        pageSize: Math.min(1000, Math.max(1, maxItems - files.length)),
        pageToken,
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: "nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,md5Checksum,webViewLink)",
      }, { signal: controller.signal });
      files.push(...(response.data.files || []));
      pageToken = response.data.nextPageToken || undefined;
    } finally {
      clearTimeout(timer);
    }
  } while (pageToken && files.length < maxItems);
  return files.slice(0, maxItems);
}

function relativePaths(files) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const folders = new Map();
  const resolveFolder = (folderId, seen = new Set()) => {
    if (!folderId || !byId.has(folderId) || seen.has(folderId)) return "";
    if (folders.has(folderId)) return folders.get(folderId);
    const folder = byId.get(folderId);
    if (folder.mimeType !== FOLDER_MIME) return "";
    const nextSeen = new Set(seen).add(folderId);
    const parent = resolveFolder(folder.parents?.[0], nextSeen);
    const result = path.join(parent, safeSegment(folder.name, `folder-${folderId.slice(-6)}`));
    folders.set(folderId, result);
    return result;
  };
  for (const file of files) if (file.mimeType === FOLDER_MIME) resolveFolder(file.id);
  return { byId, folders, resolveFolder };
}

class ByteLimitTransform extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new Error("Google Drive file exceeds the configured byte limit"));
      return;
    }
    callback(null, chunk);
  }
}

async function writeFileAtomic(filePath, content, mode) {
  const temporary = `${filePath}.part-${process.pid}-${randomUUID()}`;
  try {
    await fs.promises.writeFile(temporary, content, { mode });
    await fs.promises.rename(temporary, filePath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(filePath, value, mode = 0o600) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function downloadFile(drive, file, destination, exportSpec, maxFileBytes, timeoutMs) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part-${process.pid}-${randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestOptions = { responseType: "stream", signal: controller.signal };
    const response = exportSpec
      ? await drive.files.export({ fileId: file.id, mimeType: exportSpec.mimeType }, requestOptions)
      : await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true }, requestOptions);
    await pipeline(
      response.data,
      new ByteLimitTransform(maxFileBytes),
      fs.createWriteStream(temporary, { mode: 0o640 }),
    );
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

async function syncGoogleDrive(options) {
  const { tokenPath, secretPath, mirrorRoot, maxItems, maxFileBytes, fileTimeoutMs } = options;
  status.phase = "syncing";
  status.files = 0;
  status.folders = 0;
  status.skipped = 0;
  status.lastStartedAt = new Date().toISOString();
  status.message = "Google Drive의 최신 자료를 확인하고 있습니다.";
  const drive = google.drive({ version: "v3", auth: oauthClient(tokenPath, secretPath) });
  const files = await listDriveFiles(drive, maxItems, fileTimeoutMs);
  const { folders, resolveFolder } = relativePaths(files);
  await fs.promises.mkdir(mirrorRoot, { recursive: true });

  const statePath = path.join(mirrorRoot, ".drive-mirror-state.json");
  let previous = { entries: {} };
  try { previous = readJson(statePath); } catch { /* first sync */ }
  const nextEntries = {};
  const checkpointEntries = { ...(previous.entries || {}) };
  const usedPaths = new Set();
  let mirrored = 0;
  let skipped = 0;
  let processed = 0;
  status.folders = folders.size;

  const updateProgress = async () => {
    status.files = mirrored;
    status.skipped = skipped;
    processed += 1;
    if (processed % 25 === 0) {
      await writeJsonAtomic(statePath, { syncedAt: "", partial: true, entries: checkpointEntries });
    }
  };

  for (const file of files) {
    if (!file.id || file.mimeType === FOLDER_MIME) continue;
    const exportSpec = EXPORTS.get(file.mimeType);
    const size = Number(file.size || 0);
    if (!exportSpec && size > maxFileBytes) {
      delete checkpointEntries[file.id];
      skipped += 1;
      await updateProgress();
      continue;
    }
    const parent = resolveFolder(file.parents?.[0]);
    const baseName = `${safeSegment(file.name, `file-${file.id.slice(-6)}`)}${exportSpec?.extension || ""}`;
    let relativePath = path.join(parent, baseName);
    if (usedPaths.has(relativePath.toLowerCase())) {
      const parsed = path.parse(relativePath);
      relativePath = path.join(parsed.dir, `${parsed.name}-${file.id.slice(-6)}${parsed.ext}`);
    }
    usedPaths.add(relativePath.toLowerCase());
    const destination = path.join(mirrorRoot, relativePath);
    if (!isInside(mirrorRoot, destination)) {
      delete checkpointEntries[file.id];
      skipped += 1;
      await updateProgress();
      continue;
    }
    nextEntries[file.id] = { path: relativePath.split(path.sep).join("/"), modifiedTime: file.modifiedTime || "", mimeType: file.mimeType };
    const unchanged = previous.entries?.[file.id]?.path === nextEntries[file.id].path
      && previous.entries?.[file.id]?.modifiedTime === nextEntries[file.id].modifiedTime
      && fs.existsSync(destination);
    if (!unchanged) {
      try {
        await downloadFile(drive, file, destination, exportSpec, maxFileBytes, fileTimeoutMs);
      } catch {
        delete nextEntries[file.id];
        delete checkpointEntries[file.id];
        skipped += 1;
        await updateProgress();
        continue;
      }
    }
    checkpointEntries[file.id] = nextEntries[file.id];
    mirrored += 1;
    await updateProgress();
  }

  const nextPaths = new Set(Object.values(nextEntries).map((entry) => entry.path));
  for (const entry of Object.values(previous.entries || {})) {
    if (nextPaths.has(entry.path)) continue;
    const stalePath = path.join(mirrorRoot, entry.path || "");
    if (entry.path && isInside(mirrorRoot, stalePath)) await fs.promises.rm(stalePath, { force: true }).catch(() => {});
  }

  const manifest = [
    "id,name,mimeType,modifiedTime,webViewLink,mirrorPath",
    ...files.filter((file) => file.mimeType !== FOLDER_MIME).map((file) => {
      const entry = nextEntries[file.id];
      return [file.id, file.name, file.mimeType, file.modifiedTime, file.webViewLink, entry?.path || "SKIPPED"].map(csvCell).join(",");
    }),
  ].join("\n");
  const completedAt = new Date().toISOString();
  await writeFileAtomic(path.join(mirrorRoot, "asset_manifest.csv"), `${manifest}\n`, 0o640);
  await writeJsonAtomic(statePath, { syncedAt: completedAt, partial: false, entries: nextEntries });

  status.phase = "ready";
  status.files = mirrored;
  status.folders = folders.size;
  status.skipped = skipped;
  status.lastCompletedAt = completedAt;
  status.message = `${mirrored}개 Google Drive 자료를 동기화했습니다.`;
}

export function getGoogleDriveMirrorStatus() {
  return { ...status };
}

export function startGoogleDriveMirror(env = process.env) {
  const tokenPath = env.HERMES_GOOGLE_TOKEN_PATH || "";
  const secretPath = env.HERMES_GOOGLE_CLIENT_SECRET_PATH || "";
  const mirrorRoot = env.GOOGLE_DRIVE_MIRROR_ROOT || "";
  if (env.GOOGLE_DRIVE_MIRROR_READ_ONLY === "true" && mirrorRoot && fs.existsSync(mirrorRoot)) {
    status.enabled = true;
    const refreshReadOnlyStatus = () => {
      let mirrorState = { syncedAt: "", entries: {} };
      try { mirrorState = readJson(path.join(mirrorRoot, ".drive-mirror-state.json")); } catch { /* sync may still be running */ }
      status.phase = mirrorState.syncedAt ? "ready" : "syncing";
      status.files = Object.keys(mirrorState.entries || {}).length;
      status.folders = 0;
      status.skipped = 0;
      status.lastCompletedAt = mirrorState.syncedAt || "";
      status.message = mirrorState.syncedAt
        ? `${status.files}개의 Google Drive 자료를 읽기 전용으로 표시합니다.`
        : "Google Drive의 첫 동기화가 완료되기를 기다리고 있습니다.";
    };
    refreshReadOnlyStatus();
    const readOnlyInterval = setInterval(
      refreshReadOnlyStatus,
      Math.max(5_000, Number(env.GOOGLE_DRIVE_READ_ONLY_POLL_MS || 15_000)),
    );
    readOnlyInterval.unref?.();
    return () => clearInterval(readOnlyInterval);
  }
  if (!tokenPath || !secretPath || !mirrorRoot || !fs.existsSync(tokenPath) || !fs.existsSync(secretPath)) return () => {};

  status.enabled = true;
  status.phase = "starting";
  status.message = "Google Drive 연결을 준비하고 있습니다.";
  const options = {
    tokenPath,
    secretPath,
    mirrorRoot,
    maxItems: Math.max(1, Number(env.GOOGLE_DRIVE_SYNC_MAX_ITEMS || 5000)),
    maxFileBytes: Math.max(1024, Number(env.GOOGLE_DRIVE_SYNC_MAX_FILE_BYTES || 100 * 1024 * 1024)),
    fileTimeoutMs: Math.max(10_000, Number(env.GOOGLE_DRIVE_FILE_TIMEOUT_MS || 120_000)),
  };
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncGoogleDrive(options);
    } catch {
      status.phase = "error";
      status.message = "Google Drive 동기화에 실패했습니다. OAuth 권한과 서버 연결을 확인해주세요.";
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(run, 0);
  const interval = setInterval(run, Math.max(60_000, Number(env.GOOGLE_DRIVE_SYNC_INTERVAL_MS || 300_000)));
  interval.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
