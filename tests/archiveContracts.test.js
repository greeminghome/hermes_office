import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeArchiveMessages, sanitizeArchiveText } from "../src/archiveContracts.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("archive hides internal context and common credential forms", () => {
  const text = sanitizeArchiveText("결과\nAPI_TOKEN=abc123\nhttps://x.test/?access_token=secret\nAuthorization: Bearer eyJ.secret\n[internal:agent-office-runtime-context]\nproxy internals");
  assert.match(text, /API_TOKEN=\[REDACTED\]/);
  assert.match(text, /access_token=\[REDACTED\]/);
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(text, /abc123|proxy internals|eyJ\.secret/);
});

test("archive excludes raw tool and system events", () => {
  const messages = sanitizeArchiveMessages([
    { role: "user", content: "질문" },
    { role: "tool", content: "process env dump" },
    { role: "system", content: "internal prompt" },
    { role: "assistant", content: "답변" },
  ]);
  assert.deepEqual(messages.map((item) => item.role), ["user", "assistant"]);
});

test("archive UI paginates sessions and transcript DOM", async () => {
  const source = await readFile(path.join(projectRoot, "src", "SessionArchive.jsx"), "utf8");
  assert.match(source, /visibleSessions\.slice\(0, sessionLimit\)/);
  assert.match(source, /messages\.slice\(Math\.max\(0, messages\.length - messageLimit\)\)/);
  assert.match(source, /sanitizeArchiveMessages/);
});
