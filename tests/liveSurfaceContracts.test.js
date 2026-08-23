import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Office and command center do not seed or persist demo mission and approval data", async () => {
  const app = await readFile(path.join(projectRoot, "src", "App.jsx"), "utf8");
  assert.doesNotMatch(app, /INITIAL_MISSIONS|INITIAL_APPROVALS/);
  assert.match(app, /const \[missions, setMissions\] = useState\(\[\]\)/);
  assert.match(app, /const board = await hermesFetch\("\/api\/plugins\/kanban\/board"/);
  assert.match(app, /setMissions\(officeMissionsFromBoard\(board\)\)/);
  assert.doesNotMatch(app, /setItem\("greeming-hermes-missions"/);
  assert.doesNotMatch(app, /setItem\("greeming-hermes-approvals"/);
});
