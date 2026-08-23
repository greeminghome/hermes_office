const OFFICE_MARKER = "greeming-office-kanban:v1";
const MARKER_PATTERN = /\n?<!-- greeming-office-kanban:v1 ([A-Za-z0-9_-]+) -->\s*$/;

function encodeMetadata(metadata) {
  const json = JSON.stringify(metadata ?? {});
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeMetadata(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function splitOfficeTaskBody(body = "") {
  const source = String(body ?? "");
  const match = source.match(MARKER_PATTERN);
  if (!match) return { description: source, metadata: {} };
  try {
    return {
      description: source.slice(0, match.index).trimEnd(),
      metadata: decodeMetadata(match[1]),
    };
  } catch {
    return { description: source, metadata: {} };
  }
}

export function joinOfficeTaskBody(description = "", metadata = {}) {
  const cleanDescription = String(description ?? "").replace(MARKER_PATTERN, "").trimEnd();
  const marker = `<!-- ${OFFICE_MARKER} ${encodeMetadata(metadata)} -->`;
  return cleanDescription ? `${cleanDescription}\n\n${marker}` : marker;
}

export function normalizeOfficeTask(task = {}) {
  const { description, metadata } = splitOfficeTaskBody(task.body);
  return { ...task, body: description, metadata };
}

export function normalizeOfficeBoard(board = {}) {
  return {
    ...board,
    columns: (board.columns ?? []).map((column) => ({
      ...column,
      tasks: (column.tasks ?? []).map(normalizeOfficeTask),
    })),
  };
}

const MISSION_STATUS_BY_TASK_STATUS = {
  running: "working",
  review: "approval",
  blocked: "approval",
  done: "done",
  archived: "done",
};

const ROOM_BY_PROFILE = {
  default: "executive",
  "greeming-seoyun": "operations",
  "greeming-jian": "brand",
  "greeming-taeo": "content",
  "greeming-harin": "content",
  "greeming-doyun": "creative",
  "greeming-yuna": "customer",
  "greeming-junseo": "finance",
  "greeming-jaehyun": "tech",
};

function taskProgress(task, status) {
  const checklist = Array.isArray(task.metadata?.checklist) ? task.metadata.checklist : [];
  if (checklist.length) {
    return Math.round((checklist.filter((item) => item.done).length / checklist.length) * 100);
  }
  if (["done", "archived"].includes(status)) return 100;
  if (status === "review") return 90;
  if (status === "running") return 60;
  if (status === "ready") return 20;
  return 0;
}

export function officeMissionsFromBoard(board = {}) {
  const normalized = normalizeOfficeBoard(board);
  return (normalized.columns ?? []).flatMap((column) => (column.tasks ?? [])
    .filter((task) => !task.metadata?.deleted_at)
    .map((task) => {
    const status = String(task.status ?? column.name ?? "triage");
    const owner = task.assignee || "default";
    const checklist = Array.isArray(task.metadata?.checklist) ? task.metadata.checklist : [];
    return {
      id: task.id,
      title: task.title || "제목 없는 Hermes 업무",
      objective: task.body || "Hermes Kanban에서 생성된 업무입니다.",
      owner,
      room: ROOM_BY_PROFILE[owner] ?? "operations",
      status: MISSION_STATUS_BY_TASK_STATUS[status] ?? "queued",
      officialStatus: status,
      progress: taskProgress(task, status),
      due: task.metadata?.due_date || "기한 미정",
      priority: Number(task.priority ?? 0) > 0 ? "high" : "normal",
      steps: checklist.map((item, index) => ({
        id: item.id ?? `${task.id}-step-${index}`,
        label: item.text ?? item.label ?? `체크리스트 ${index + 1}`,
        done: Boolean(item.done),
      })),
      metadata: task.metadata ?? {},
    };
    }));
}

export function officialTaskPatch(task, patch, metadata) {
  const payload = { ...patch };
  delete payload.metadata;
  payload.body = joinOfficeTaskBody(patch.body ?? task.body ?? "", metadata);
  if (["blocked", "scheduled"].includes(payload.status)) {
    payload.block_reason = String(
      patch.block_reason ?? metadata?.blocked_reason ?? metadata?.status_note ?? "",
    ).trim();
  }
  if (payload.status === "done") {
    payload.summary = String(patch.summary ?? metadata?.status_note ?? "Completed in Hermes Office").trim();
    payload.metadata = { greeming_office: metadata };
  }
  return payload;
}

export function officialKanbanMovePlan(targetStatus) {
  const status = String(targetStatus ?? "");
  if (status === "review") {
    throw new Error("검토 상태는 Hermes worker 흐름에서만 전환됩니다.");
  }
  if (status === "running") return { status: "ready", dispatch: true };
  return { status, dispatch: false };
}

export async function patchOfficeTaskFromLatest(fetcher, taskId, patch, metadataForTask) {
  const path = `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`;
  const detail = await fetcher(path, { cacheTtlMs: 0, dedupe: false });
  if (!detail?.task || String(detail.task.id) !== String(taskId)) {
    throw new Error("Hermes task 최신 본문을 확인하지 못해 변경을 중단했습니다.");
  }
  const latestTask = normalizeOfficeTask(detail.task);
  const metadata = typeof metadataForTask === "function"
    ? metadataForTask(latestTask)
    : metadataForTask;
  const payload = officialTaskPatch(latestTask, patch, metadata);
  await fetcher(path, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return {
    payload,
    task: { ...latestTask, ...patch, metadata },
  };
}

export function officialCreateTaskPayload({ title, assignee, description = "" }) {
  return {
    title: String(title).trim(),
    assignee,
    priority: 0,
    triage: false,
    body: joinOfficeTaskBody(description, {
      due_date: "",
      checklist: [],
      task_events: [],
    }),
  };
}
