import { toHermesProfileId } from "./profileIds.js";

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}을(를) 입력해주세요.`);
  return text;
}

export function resolveModelProvider(model, explicitProvider = "", options = [], fallbackProvider = "") {
  const selected = options.find((item) => item.id === model);
  return String(explicitProvider || selected?.provider || fallbackProvider || "").trim();
}

export function profileCreateRequest(draft, options = [], fallbackProvider = "") {
  const name = requiredText(draft.name, "프로필 ID");
  const description = String(draft.role ?? "").trim();
  const model = String(draft.model ?? "").trim();
  const body = { name, description };
  if (model) {
    body.provider = requiredText(
      resolveModelProvider(model, draft.provider, options, fallbackProvider),
      "모델 Provider",
    );
    body.model = model;
  }
  return { path: "/api/profiles", method: "POST", body };
}

export function profileUpdateRequests(selectedName, draft, options = [], fallbackProvider = "") {
  const currentName = toHermesProfileId(requiredText(selectedName, "현재 프로필 ID"));
  const requestedName = toHermesProfileId(requiredText(draft.name, "프로필 ID"));
  const requests = [];
  let targetName = currentName;

  if (requestedName !== currentName) {
    requests.push({
      path: `/api/profiles/${encodeURIComponent(currentName)}`,
      method: "PATCH",
      body: { new_name: requestedName },
    });
    targetName = requestedName;
  }

  requests.push({
    path: `/api/profiles/${encodeURIComponent(targetName)}/description`,
    method: "PUT",
    body: { description: String(draft.role ?? "").trim() },
  });

  const model = String(draft.model ?? "").trim();
  if (model) {
    requests.push({
      path: `/api/profiles/${encodeURIComponent(targetName)}/model`,
      method: "PUT",
      body: {
        provider: requiredText(
          resolveModelProvider(model, draft.provider, options, fallbackProvider),
          "모델 Provider",
        ),
        model,
      },
    });
  }
  return { targetName, requests };
}

export function modelSetRequest(draft, options = [], fallbackProvider = "", confirmExpensiveModel = false) {
  const model = requiredText(draft.model, "모델");
  const provider = requiredText(
    resolveModelProvider(model, draft.provider, options, fallbackProvider),
    "Provider",
  );
  return {
    path: "/api/model/set",
    method: "POST",
    body: {
      scope: "main",
      provider,
      model,
      confirm_expensive_model: Boolean(confirmExpensiveModel),
    },
  };
}

export function configUpdateRequest(config, profile = "") {
  const body = { config: { ...config } };
  if (profile) body.profile = profile;
  return { path: "/api/config", method: "PUT", body };
}

const HITL_DEFAULT_TTL_SECONDS = {
  "clarify.request": 300,
  "approval.request": 300,
  "sudo.request": 120,
  "secret.request": 300,
};

function hitlExpiresAt(payload, type, now) {
  const explicit = payload.expires_at ?? payload.expiresAt;
  if (explicit != null && explicit !== "") {
    const numeric = Number(explicit);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1000000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(explicit));
    if (!Number.isNaN(parsed)) return parsed;
  }
  const configured = Number(payload.timeout_seconds ?? payload.ttl_seconds ?? payload.timeout);
  const ttlSeconds = Number.isFinite(configured) && configured >= 0
    ? configured
    : HITL_DEFAULT_TTL_SECONDS[type];
  return now + ttlSeconds * 1000;
}

export function normalizeHitlRequest(event, now = Date.now()) {
  const payload = event?.payload ?? {};
  const type = String(event?.type ?? "");
  const supported = ["clarify.request", "approval.request", "sudo.request", "secret.request"];
  if (!supported.includes(type)) return null;
  const sessionId = requiredText(event.session_id, "Hermes 세션 ID");
  const requestId = String(payload.request_id ?? "").trim();
  if (type !== "approval.request" && !requestId) {
    throw new Error(`${type} 응답에 필요한 request_id가 없습니다.`);
  }
  const prompt = String(
    payload.question || payload.description || payload.prompt || payload.command || "사용자 확인이 필요합니다.",
  );
  const choices = Array.isArray(payload.choices) ? payload.choices.map(String).filter(Boolean) : [];
  return {
    id: `${sessionId}:${requestId || type}`,
    type,
    sessionId,
    requestId,
    prompt,
    choices,
    envVar: String(payload.env_var ?? ""),
    expiresAt: hitlExpiresAt(payload, type, now),
    error: "",
  };
}

export function isHitlRequestExpired(request, now = Date.now()) {
  return Boolean(request?.expiresAt && Number(request.expiresAt) <= now);
}

export function hitlResponseRequest(request, value, resolveAll = false) {
  if (!request?.type || !request?.sessionId) throw new Error("응답할 Hermes 요청이 없습니다.");
  if (isHitlRequestExpired(request)) throw new Error("Hermes 입력 요청이 만료되었습니다. 작업에서 다시 요청해 주세요.");
  if (request.type === "approval.request") {
    return {
      method: "approval.respond",
      params: {
        session_id: request.sessionId,
        choice: String(value || "deny"),
        all: Boolean(resolveAll),
      },
    };
  }
  const responseKey = {
    "clarify.request": "answer",
    "sudo.request": "password",
    "secret.request": "value",
  }[request.type];
  const responseMethod = {
    "clarify.request": "clarify.respond",
    "sudo.request": "sudo.respond",
    "secret.request": "secret.respond",
  }[request.type];
  if (!responseKey || !responseMethod || !request.requestId) throw new Error("지원하지 않는 Hermes 입력 요청입니다.");
  return {
    method: responseMethod,
    params: { request_id: request.requestId, [responseKey]: String(value ?? "") },
  };
}

export function sessionBranchRequest(sessionId, name = "") {
  return {
    method: "session.branch",
    params: {
      session_id: requiredText(sessionId, "분기할 Hermes 세션 ID"),
      ...(String(name).trim() ? { name: String(name).trim() } : {}),
    },
  };
}
