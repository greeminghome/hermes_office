import assert from "node:assert/strict";
import test from "node:test";

globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const {
  joinOfficeTaskBody,
  normalizeOfficeBoard,
  officeMissionsFromBoard,
  officialKanbanMovePlan,
  officialCreateTaskPayload,
  officialTaskPatch,
  patchOfficeTaskFromLatest,
  splitOfficeTaskBody,
} = await import("../src/kanbanContracts.js");

test("Office task metadata round-trips through the official body field", () => {
  const metadata = { due_date: "2026-07-20", checklist: [{ id: "1", text: "검수", done: false }] };
  const encoded = joinOfficeTaskBody("사용자 설명", metadata);
  assert.deepEqual(splitOfficeTaskBody(encoded), { description: "사용자 설명", metadata });
});

test("board normalization hides the versioned marker while preserving extension state", () => {
  const body = joinOfficeTaskBody("설명", { collaborators: ["hermes-content"] });
  const board = normalizeOfficeBoard({ columns: [{ name: "todo", tasks: [{ id: "t1", body }] }] });
  assert.equal(board.columns[0].tasks[0].body, "설명");
  assert.deepEqual(board.columns[0].tasks[0].metadata.collaborators, ["hermes-content"]);
});

test("command center missions are derived only from official board tasks", () => {
  const body = joinOfficeTaskBody("공식 업무 설명", {
    due_date: "2026-07-20",
    checklist: [{ id: "step-1", text: "검수", done: true }],
  });
  const missions = officeMissionsFromBoard({
    columns: [{ name: "running", tasks: [{ id: "t1", title: "공식 업무", assignee: "hermes-technology", body }] }],
  });
  assert.equal(missions.length, 1);
  assert.equal(missions[0].status, "working");
  assert.equal(missions[0].room, "tech");
  assert.equal(missions[0].progress, 100);
  assert.equal(missions[0].steps[0].label, "검수");
});

test("command center hides tasks soft-deleted into the official archive", () => {
  const activeBody = joinOfficeTaskBody("유지", {});
  const deletedBody = joinOfficeTaskBody("삭제", { deleted_at: "2026-07-18T00:00:00Z", delete_reason: "중복" });
  const missions = officeMissionsFromBoard({
    columns: [{ name: "todo", tasks: [
      { id: "active", title: "유지 Task", body: activeBody },
      { id: "deleted", title: "삭제 Task", body: deletedBody },
    ] }],
  });
  assert.deepEqual(missions.map((mission) => mission.id), ["active"]);
});

test("create uses only official fields and stores extension data in body", () => {
  const payload = officialCreateTaskPayload({ title: " 새 업무 ", assignee: "default" });
  assert.deepEqual(Object.keys(payload).sort(), ["assignee", "body", "priority", "title", "triage"]);
  assert.equal(payload.title, "새 업무");
  assert.deepEqual(splitOfficeTaskBody(payload.body).metadata.checklist, []);
});

test("blocked and scheduled transitions use top-level block_reason", () => {
  const task = { body: "설명" };
  const blocked = officialTaskPatch(task, { status: "blocked", metadata: {} }, { blocked_reason: "결정 대기" });
  assert.equal(blocked.block_reason, "결정 대기");
  assert.equal("metadata" in blocked, false);
});

test("running uses ready then official dispatch and review is worker-only", () => {
  assert.deepEqual(officialKanbanMovePlan("running"), { status: "ready", dispatch: true });
  assert.deepEqual(officialKanbanMovePlan("todo"), { status: "todo", dispatch: false });
  assert.throws(() => officialKanbanMovePlan("review"), /Hermes worker/);
});

test("done metadata is sent only through the official completion handoff", () => {
  const metadata = { final_report_checked: true, status_note: "완료 검수" };
  const payload = officialTaskPatch({ body: "설명" }, { status: "done" }, metadata);
  assert.equal(payload.summary, "완료 검수");
  assert.deepEqual(payload.metadata, { hermes_office: metadata });
  assert.equal(splitOfficeTaskBody(payload.body).metadata.final_report_checked, true);
});

test("mutation refreshes task detail and preserves a concurrent body edit", async () => {
  const calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push({ path, options });
    if (!options.method) {
      return {
        task: {
          id: "task-1",
          body: joinOfficeTaskBody("다른 작업자가 방금 고친 본문", { task_events: [], concurrent: true }),
        },
      };
    }
    return { task: { id: "task-1" } };
  };

  const result = await patchOfficeTaskFromLatest(fetcher, "task-1", { status: "ready" }, (latestTask) => ({
    ...latestTask.metadata,
    moved_by_office: true,
  }));

  assert.deepEqual(calls[0], {
    path: "/api/plugins/kanban/tasks/task-1",
    options: { cacheTtlMs: 0, dedupe: false },
  });
  assert.equal(calls[1].options.method, "PATCH");
  const written = JSON.parse(calls[1].options.body);
  assert.equal(splitOfficeTaskBody(written.body).description, "다른 작업자가 방금 고친 본문");
  assert.equal(splitOfficeTaskBody(written.body).metadata.concurrent, true);
  assert.equal(result.task.body, "다른 작업자가 방금 고친 본문");
});

test("mutation fails closed when latest task detail cannot be read", async () => {
  let calls = 0;
  await assert.rejects(
    patchOfficeTaskFromLatest(async () => {
      calls += 1;
      throw new Error("detail unavailable");
    }, "task-1", { status: "ready" }, {}),
    /detail unavailable/,
  );
  assert.equal(calls, 1);
});

test("meeting and archive metadata remain durable in the official body field", () => {
  const meeting = officialTaskPatch({ body: "회의 후속 작업" }, {}, { meeting_id: "meeting-1" });
  assert.equal("metadata" in meeting, false);
  assert.equal(splitOfficeTaskBody(meeting.body).metadata.meeting_id, "meeting-1");

  const archived = officialTaskPatch(
    { body: meeting.body },
    { status: "archived" },
    { ...splitOfficeTaskBody(meeting.body).metadata, deleted_at: "2026-07-14T00:00:00Z" },
  );
  assert.equal(archived.status, "archived");
  assert.equal("metadata" in archived, false);
  assert.equal(splitOfficeTaskBody(archived.body).metadata.deleted_at, "2026-07-14T00:00:00Z");
});
