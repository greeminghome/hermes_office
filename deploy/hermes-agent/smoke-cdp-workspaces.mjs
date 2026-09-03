import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let WsPackage;
try { WsPackage = require("ws"); } catch { WsPackage = require("/opt/hermes/node_modules/ws"); }
const { WebSocket } = WsPackage;
const base = process.env.CDP_SMOKE_BASE || "http://127.0.0.1:9223";

async function json(path) {
  const response = await fetch(`${base}${path}`);
  const payload = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function sessionCall(sessionId, method, params = {}) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${method} timed out`));
    }, 8000);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.on("error", reject);
  });
}

const first = await json("/__session_target?session=smoke-a");
const second = await sessionCall("smoke-a", "Target.createTarget", { url: "https://example.com/" });
assert.ok(second.result?.targetId, JSON.stringify(second));

const workspaceA = await json("/__session_tabs?session=smoke-a&claim=0");
assert.equal(workspaceA.isolation, "browser-context");
assert.equal(workspaceA.tabs.length, 2);
assert.deepEqual(workspaceA.tabs.map((tab) => tab.slot), [1, 2]);
assert.equal(workspaceA.activeTargetId, second.result.targetId);

const workspaceB = await json("/__session_target?session=smoke-b");
assert.notEqual(workspaceB.browserContextId, first.browserContextId);
assert.notEqual(workspaceB.targetId, first.targetId);

const crossAttach = await sessionCall("smoke-a", "Target.attachToTarget", { targetId: workspaceB.targetId, flatten: true });
assert.match(String(crossAttach.error?.message || ""), /another Hermes session/);
const crossClose = await sessionCall("smoke-a", "Target.closeTarget", { targetId: workspaceB.targetId });
assert.match(String(crossClose.error?.message || ""), /another Hermes session/);

const visibleA = await sessionCall("smoke-a", "Target.getTargets");
assert.equal(visibleA.result?.targetInfos?.every((target) => target.browserContextId === first.browserContextId), true);

console.log(JSON.stringify({ ok: true, sessionATabs: workspaceA.tabs.length, isolated: true }));
