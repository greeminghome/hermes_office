import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("MCP catalog, install and test preserve the selected Hermes profile", async () => {
  const [client, hub] = await Promise.all([
    readFile(path.join(projectRoot, "src", "hermes.js"), "utf8"),
    readFile(path.join(projectRoot, "src", "PluginHub.jsx"), "utf8"),
  ]);

  assert.match(client, /loadHermesMcpCatalog\(profile = ""\)/);
  assert.match(client, /`\/api\/mcp\/catalog\$\{suffix\}`/);
  assert.match(client, /installHermesMcp\(name, env = \{\}, enable = true, profile = ""\)/);
  assert.match(client, /const hermesProfile = toHermesProfileId\(profile\)/);
  assert.match(client, /\{ name, env, enable, \.\.\.\(hermesProfile \? \{ profile: hermesProfile \} : \{\}\) \}/);
  assert.match(client, /testHermesMcp\(name, profile = ""\)/);
  assert.match(hub, /loadHermesMcpCatalog\(profile\)/);
  assert.match(hub, /installHermesMcp\(item\.name, env, true, selectedProfile\)/);
  assert.match(hub, /testHermesMcp\(server\.name, selectedProfile\)/);
});

test("model picker does not invent provider models when official inventory is unavailable", async () => {
  const [app, client] = await Promise.all([
    readFile(path.join(projectRoot, "src", "App.jsx"), "utf8"),
    readFile(path.join(projectRoot, "src", "hermes.js"), "utf8"),
  ]);
  assert.doesNotMatch(app, /DEFAULT_MODEL_OPTIONS/);
  assert.doesNotMatch(app, /gpt-5\.5/);
  assert.match(client, /hermesFetch\("\/api\/model\/options\?include_unconfigured=1"/);
  assert.doesNotMatch(client, /\/api\/model\/models|\/api\/providers\/models|\/api\/model\/available/);
});

test("Plugin actions expose trust details and confirm destructive or executable changes", async () => {
  const hub = await readFile(path.join(projectRoot, "src", "PluginHub.jsx"), "utf8");
  assert.match(hub, /설치 원본과 실행 내용 확인/);
  assert.match(hub, /item\.bootstrap\.join\(" → "\)/);
  assert.match(hub, /MCP를 설치할까요/);
  assert.match(hub, /Instagram 연결을 해제할까요/);
  assert.match(hub, /visibleServers\.map/);
  assert.match(hub, /loadComputerUseStatus\(profile\)/);
  assert.match(hub, /toolset\.runtime\.platform_supported/);
  assert.doesNotMatch(hub, /disabled=\{busyKey === `tool:\$\{toolset\.name\}` \|\| !toolset\.available\}/);
});
