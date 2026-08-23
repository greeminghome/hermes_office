import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "../..");

function fail(message) {
  console.error(`package verification failed: ${message}`);
  process.exitCode = 1;
}

const requiredFiles = [
  ".env.example",
  ".github/workflows/ci.yml",
  "Dockerfile",
  "docker-compose.office.yml",
  "deploy/docker-compose.agent-network.yml",
  "deploy/docker-compose.traefik.yml",
  "deploy/hermes-agent/Dockerfile",
  "deploy/hermes-agent/LICENSE.hermes-agent",
  "deploy/hermes-agent/overrides/cdp-http-proxy.js",
  "deploy/reservation_sources.example.json",
  "deploy/scripts/backup.sh",
  "deploy/scripts/doctor.sh",
  "deploy/scripts/install.sh",
  "deploy/scripts/restore.sh",
  "deploy/scripts/update.sh",
  "docs/DEPLOYMENT.md",
  "docs/HANDOFF_CHECKLIST.md",
  "SECURITY.md",
];

for (const relative of requiredFiles) {
  try {
    readFileSync(path.join(projectRoot, relative));
  } catch {
    fail(`required file is missing: ${relative}`);
  }
}

let files = [];
try {
  files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
} catch (error) {
  fail(`cannot enumerate package files: ${error.message}`);
}

const forbiddenPaths = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)deploy\/secrets\//,
  /(^|\/)(?:backups?|chat-files|profiles)(\/|$)/,
  /(?:^|\/)(?:reservation_sources|google_office_readonly_token|google_reservation_oauth_token|google_client_secret)\.json$/,
  /\.(?:sqlite|sqlite-wal|sqlite-shm|db|pem|key)$/i,
];
for (const file of files) {
  if (file === ".env.example") continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) fail(`runtime secret or data path is tracked: ${file}`);
}

const secretPatterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "OpenAI-style token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/, "Google API key"],
  [/srv1737112\.hstgr\.cloud/i, "production hostname"],
  [/greeminghome\.studio@gmail\.com/i, "production Google account"],
  [/\b(?:751445|4573492|72609|43517)\b/, "production reservation identifier"],
];
for (const file of files) {
  if (file === "deploy/scripts/verify-package.mjs") continue;
  if (/\.(?:png|jpe?g|gif|webp|ico|woff2?|zip|gz)$/i.test(file)) continue;
  let contents;
  try {
    contents = readFileSync(path.join(projectRoot, file), "utf8");
  } catch {
    continue;
  }
  for (const [pattern, label] of secretPatterns) {
    if (pattern.test(contents)) fail(`${label} found in ${file}`);
  }
}

const compose = readFileSync(path.join(projectRoot, "docker-compose.office.yml"), "utf8");
const example = readFileSync(path.join(projectRoot, ".env.example"), "utf8");
for (const unsafe of ["RESERVATION_SYNC_ENABLED", "RESERVATION_GOOGLE_WRITE_ENABLED", "RESERVATION_NAVER_AVAILABILITY_ENABLED", "RESERVATION_SPACECLOUD_WRITE_ENABLED"]) {
  if (!new RegExp(`^${unsafe}=false$`, "m").test(example)) fail(`${unsafe} must default to false`);
}
if (!/^RESERVATION_WRITE_MODE=shadow$/m.test(example)) fail("reservation write mode must default to shadow");
if (/\/docker\//.test(compose)) fail("compose contains a host-specific /docker bind mount");
if (!/read_only:\s*true/.test(compose) || !/cap_drop:[\s\S]*?- ALL/.test(compose)) {
  fail("compose is missing the read-only or dropped-capability runtime guard");
}

try {
  JSON.parse(readFileSync(path.join(projectRoot, "deploy/reservation_sources.example.json"), "utf8"));
} catch (error) {
  fail(`reservation source example is invalid JSON: ${error.message}`);
}

if (!process.exitCode) console.log(`package verification passed (${files.length} files scanned)`);
