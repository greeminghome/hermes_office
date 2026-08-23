import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesPath = new URL("../src/styles.css", import.meta.url);
const appPath = new URL("../src/App.jsx", import.meta.url);

test("mobile meeting and Kanban surfaces remain vertically reachable", async () => {
  const styles = await readFile(stylesPath, "utf8");

  assert.match(styles, /\.app-shell > main:has\(\.meeting-lobby-page\)[\s\S]*?overflow-y:\s*auto\s*!important/);
  assert.match(styles, /\.meeting-lobby-page\s*\{[\s\S]*?height:\s*auto\s*!important[\s\S]*?overflow-y:\s*visible\s*!important/);
  assert.match(styles, /\.native-kanban-grid\s*\{[\s\S]*?min-height:\s*360px\s*!important/);
  assert.match(styles, /\.native-kanban-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(8,/);
  assert.doesNotMatch(styles, /native-kanban-grid\s*\{[^}]*repeat\(7,/);
});

test("mobile refresh and selected navigation expose explicit state", async () => {
  const [styles, app] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /\.topbar-meta button:not\(\.meeting-jump\)::after\s*\{[\s\S]*?content:\s*"↻"\s*!important/);
  assert.match(app, /aria-current=\{view === id \? "page" : undefined\}/);
  assert.match(app, /aria-pressed=\{active\}/);
});
