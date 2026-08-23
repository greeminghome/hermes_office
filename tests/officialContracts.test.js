import assert from "node:assert/strict";
import test from "node:test";

import {
  configUpdateRequest,
  hitlResponseRequest,
  isHitlRequestExpired,
  modelSetRequest,
  normalizeHitlRequest,
  profileCreateRequest,
  profileUpdateRequests,
  sessionBranchRequest,
} from "../src/officialContracts.js";

const models = [{ id: "gpt-5", provider: "openai" }];

test("profile create uses only the official create schema", () => {
  assert.deepEqual(profileCreateRequest({ name: "worker", role: "운영", model: "gpt-5" }, models), {
    path: "/api/profiles",
    method: "POST",
    body: { name: "worker", description: "운영", provider: "openai", model: "gpt-5" },
  });
});

test("profile update separates rename, description, and model contracts", () => {
  const result = profileUpdateRequests("old", { name: "new", role: "개발", model: "gpt-5" }, models);
  assert.equal(result.targetName, "new");
  assert.deepEqual(result.requests.map(({ path, method }) => ({ path, method })), [
    { path: "/api/profiles/old", method: "PATCH" },
    { path: "/api/profiles/new/description", method: "PUT" },
    { path: "/api/profiles/new/model", method: "PUT" },
  ]);
  assert.deepEqual(result.requests[0].body, { new_name: "new" });
});

test("editing Minjun's UI alias writes to the single deployed Hermes profile without renaming it", () => {
  const result = profileUpdateRequests("default", { name: "default", role: "총괄", model: "gpt-5" }, models);
  assert.equal(result.targetName, "greeming-minjun");
  assert.deepEqual(result.requests.map(({ path, method }) => ({ path, method })), [
    { path: "/api/profiles/greeming-minjun/description", method: "PUT" },
    { path: "/api/profiles/greeming-minjun/model", method: "PUT" },
  ]);
});

test("model and config writes use the official endpoints", () => {
  assert.deepEqual(modelSetRequest({ provider: "openai", model: "gpt-5" }), {
    path: "/api/model/set",
    method: "POST",
    body: { scope: "main", provider: "openai", model: "gpt-5", confirm_expensive_model: false },
  });
  assert.deepEqual(configUpdateRequest({ model_context_length: 200000 }), {
    path: "/api/config",
    method: "PUT",
    body: { config: { model_context_length: 200000 } },
  });
});

test("HITL requests retain session/request ids and map to exact RPC responses", () => {
  const now = Date.now();
  const clarify = normalizeHitlRequest({
    type: "clarify.request",
    session_id: "live-1",
    payload: { request_id: "ask-1", question: "계속할까요?" },
  }, now);
  assert.equal(clarify.requestId, "ask-1");
  assert.equal(clarify.expiresAt, now + 300000);
  assert.deepEqual(hitlResponseRequest(clarify, "네"), {
    method: "clarify.respond",
    params: { request_id: "ask-1", answer: "네" },
  }, now);

  const approval = normalizeHitlRequest({
    type: "approval.request",
    session_id: "live-2",
    payload: { choices: ["once", "deny"], command: "safe command" },
  });
  assert.deepEqual(hitlResponseRequest(approval, "once"), {
    method: "approval.respond",
    params: { session_id: "live-2", choice: "once", all: false },
  });
});

test("secret and sudo responses are ephemeral RPC payloads with no storage contract", () => {
  const secret = normalizeHitlRequest({
    type: "secret.request",
    session_id: "live-3",
    payload: { request_id: "secret-1", env_var: "API_KEY", prompt: "키 입력" },
  });
  assert.deepEqual(hitlResponseRequest(secret, "top-secret"), {
    method: "secret.respond",
    params: { request_id: "secret-1", value: "top-secret" },
  });
});

test("HITL expiry honors explicit TTL and blocks stale responses", () => {
  const request = normalizeHitlRequest({
    type: "sudo.request",
    session_id: "live-expiry",
    payload: { request_id: "sudo-1", timeout_seconds: 5 },
  }, 1000);
  assert.equal(request.expiresAt, 6000);
  assert.equal(isHitlRequestExpired(request, 5999), false);
  assert.equal(isHitlRequestExpired(request, 6000), true);
  assert.throws(
    () => hitlResponseRequest({ ...request, expiresAt: Date.now() - 1 }, "secret"),
    /만료/,
  );
});

test("branch uses the live gateway session instead of creating a blank draft", () => {
  assert.deepEqual(sessionBranchRequest("live-parent", "검토 분기"), {
    method: "session.branch",
    params: { session_id: "live-parent", name: "검토 분기" },
  });
});
