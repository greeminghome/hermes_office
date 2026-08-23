import { useCallback, useEffect, useMemo, useState } from "react";
import { hermesFetch } from "./hermes.js";
import {
  normalizeOfficeBoard,
  officialKanbanMovePlan,
  officialCreateTaskPayload,
  patchOfficeTaskFromLatest,
} from "./kanbanContracts.js";
import { TEAM_META } from "./officeData.js";
import { useModalFocus } from "./useModalFocus.js";

const COLUMNS = [
  ["triage", "분류", "TRIAGE"],
  ["todo", "할 일", "TODO"],
  ["scheduled", "예약됨", "SCHEDULED"],
  ["ready", "실행 준비", "READY"],
  ["running", "진행 중", "RUNNING"],
  ["blocked", "멈춤", "BLOCKED"],
  ["review", "검토", "REVIEW"],
  ["done", "완료", "DONE"],
];

const STATUS_LABEL = Object.fromEntries(COLUMNS.map(([id, label]) => [id, label]));
const BOARD_CACHE_KEY = "hermes-office-kanban-board";
const DONE_ARCHIVE_DAYS = 7;
const DONE_ARCHIVE_MS = DONE_ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

const MOVE_POLICIES = {
  triage: {
    title: "요청을 다시 분류합니다.",
    description: "업무가 아직 모호하거나 담당자/완료 기준이 정리되지 않았을 때 사용합니다.",
    noteLabel: "분류 메모",
    event: "업무가 분류 단계로 이동했습니다.",
  },
  todo: {
    title: "업무로 확정할까요?",
    description: "담당자와 우선순위를 확인하고 백로그에 넣습니다.",
    noteLabel: "완료 기준 또는 정리 메모",
    event: "업무가 할 일로 확정되었습니다.",
  },
  scheduled: {
    title: "언제 실행할까요?",
    description: "특정 시간이나 조건에 맞춰 실행할 업무로 예약합니다.",
    noteLabel: "예약 조건",
    event: "업무가 예약됨 상태로 이동했습니다.",
  },
  ready: {
    title: "실행 준비가 끝났나요?",
    description: "자료, 담당자, 완료 기준이 준비된 업무만 실행 준비로 보냅니다.",
    noteLabel: "준비 완료 기준",
    event: "업무가 실행 준비 상태로 이동했습니다.",
  },
  running: {
    title: "공식 dispatcher로 실행할까요?",
    description: "먼저 실행 준비로 전환한 뒤 공식 dispatcher가 claim해야 진행 중이 됩니다.",
    noteLabel: "실행 지시 또는 진행 메모",
    event: "공식 실행을 위해 업무를 실행 준비 상태로 이동했습니다.",
  },
  blocked: {
    title: "왜 멈췄나요?",
    description: "막힌 이유와 필요한 지원을 남겨야 나중에 재개할 수 있습니다.",
    noteLabel: "막힌 이유",
    event: "업무가 멈춤 상태로 이동했습니다.",
  },
  review: {
    title: "Hermes worker 검토 상태",
    description: "worker가 만든 검토 상태를 표시하는 전용 열입니다. 수동 이동은 지원하지 않습니다.",
    noteLabel: "",
    event: "",
  },
  done: {
    title: "완료 처리 전에 확인해주세요.",
    description: "완료는 최근 7일간 보드에 표시되고 이후 완료 아카이브로 이동합니다.",
    noteLabel: "최종 보고 또는 승인 메모",
    event: "업무가 완료 처리되었습니다.",
  },
};

function loadCachedBoard() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(BOARD_CACHE_KEY) || "null");
    if (!cached?.board || Date.now() - Number(cached.savedAt ?? 0) > 10 * 60 * 1000) return { columns: [] };
    return cached.board;
  } catch {
    return { columns: [] };
  }
}

function saveCachedBoard(board) {
  try {
    window.localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ board, savedAt: Date.now() }));
  } catch {
    // The live board remains available even if local storage is blocked.
  }
}

function taskStatus(task) {
  return task.status ?? task.column ?? "todo";
}

function taskChecklist(task) {
  return Array.isArray(task.metadata?.checklist) ? task.metadata.checklist : [];
}

function taskEvents(task) {
  return Array.isArray(task?.metadata?.task_events) ? task.metadata.task_events : [];
}

function isDeletedTask(task) {
  return Boolean(task?.metadata?.deleted_at);
}

function doneAt(task) {
  return task?.metadata?.completed_at ?? task?.updated_at ?? task?.last_active ?? task?.created_at ?? "";
}

function isArchivedDone(task) {
  if (taskStatus(task) !== "done") return false;
  const value = doneAt(task);
  if (!value) return false;
  const timestamp = typeof value === "number" && value > 0 && value < 1000000000000 ? value * 1000 : Date.parse(value);
  if (!timestamp || Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp > DONE_ARCHIVE_MS;
}

function formatDate(value) {
  if (!value) return "기록 없음";
  const normalized = typeof value === "number" && value > 0 && value < 1000000000000
    ? value * 1000
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "기록 없음";
  return new Intl.DateTimeFormat("ko", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function taskHealth(task) {
  const status = taskStatus(task);
  const checklist = taskChecklist(task);
  if (status === "blocked") return ["attention", "사용자 결정, 자료, 승인 또는 협업이 필요한 상태입니다."];
  if (status === "done") return ["done", "완료된 업무입니다. 최근 7일 후 완료 아카이브로 이동합니다."];
  if (checklist.length && checklist.every((item) => item.done)) return ["review", "체크리스트가 끝났습니다. 완료 검토를 요청할 수 있습니다."];
  return ["active", "담당자가 진행하거나 다음 액션을 기다리는 업무입니다."];
}

function taskPrompt(task, intent, extra = "") {
  const owner = TEAM_META[task.assignee]?.name ?? task.assignee ?? "담당자";
  const base = [
    "[업무보드 Task]",
    `업무명: ${task.title}`,
    `담당자: ${owner}`,
    `현재 상태: ${STATUS_LABEL[taskStatus(task)] ?? taskStatus(task)}`,
    task.body ? `설명: ${task.body}` : "",
    task.metadata?.meeting_topic ? `관련 회의: ${task.metadata.meeting_topic}` : "",
    extra ? `추가 지시: ${extra}` : "",
  ].filter(Boolean).join("\n");

  const prompts = {
    instruct: "이 업무에 대해 위 맥락을 반영해서 다음 액션을 제안하고 진행해주세요.",
    status: "현재 진행 상황, 완료된 것, 진행 중인 것, 막힌 부분, 다음 액션, 사용자 결정이 필요한 항목을 구분해서 보고해주세요.",
    unblock: "업무가 멈춘 이유를 진단해주세요. 필요한 자료, 결정, 협업 요청, 다음 진행 조건을 정리해서 보고해주세요.",
    review: "완료 검토 단계입니다. 산출물, 변경 내역, 검토 기준, 승인 또는 수정 요청이 필요한 부분을 정리해서 보고해주세요.",
  };

  return `${base}\n\n${prompts[intent] ?? prompts.status}`;
}

function buildTaskMeeting(task, collaborator) {
  const assignee = task.assignee ?? "default";
  const participants = ["default", assignee, collaborator]
    .filter((name) => name && TEAM_META[name]);
  return {
    id: crypto.randomUUID(),
    source: "kanban-task",
    topic: `업무 협업 회의: ${task.title}`,
    subtitle: "업무보드에서 시작된 협업 회의",
    participants: [...new Set(participants)].slice(0, 5),
    requestedBy: assignee,
    taskId: task.id,
    taskSnapshot: {
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      body: task.body ?? "",
      metadata: task.metadata ?? {},
    },
    startedAt: Date.now(),
  };
}

function emptyMoveForm(task) {
  return {
    assignee: task?.assignee ?? "default",
    priority: String(task?.priority ?? 0),
    dueDate: task?.metadata?.due_date ?? "",
    scheduledAt: task?.metadata?.scheduled_at ?? "",
    note: "",
    supportTarget: "",
    finalReportChecked: false,
    artifactChecked: false,
  };
}

export default function HermesKanban({ onOpenAgent, onStartMeeting }) {
  const [board, setBoard] = useState(loadCachedBoard);
  const [loading, setLoading] = useState(() => !loadCachedBoard().columns?.length);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("default");
  const [dragged, setDragged] = useState("");
  const [selectedTask, setSelectedTask] = useState(null);
  const [collaborator, setCollaborator] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [checklistInput, setChecklistInput] = useState("");
  const [moveRequest, setMoveRequest] = useState(null);
  const [moveForm, setMoveForm] = useState(() => emptyMoveForm(null));
  const [showDoneArchive, setShowDoneArchive] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [nativeOps, setNativeOps] = useState({ diagnostics: null, stats: null, workers: null });
  const moveDialogRef = useModalFocus(Boolean(moveRequest), () => {
    setMoveRequest(null);
    setMoveForm(emptyMoveForm(null));
  });
  const taskDialogRef = useModalFocus(Boolean(selectedTask) && !moveRequest, () => setSelectedTask(null));

  const loadBoard = useCallback(async () => {
    try {
      setError("");
      const [nextBoard, diagnostics, stats, workers] = await Promise.all([
        hermesFetch("/api/plugins/kanban/board", { cacheTtlMs: 10000 }),
        hermesFetch("/api/plugins/kanban/diagnostics", { cacheTtlMs: 15000 }).catch((error) => ({ error: error.message })),
        hermesFetch("/api/plugins/kanban/stats", { cacheTtlMs: 15000 }).catch((error) => ({ error: error.message })),
        hermesFetch("/api/plugins/kanban/workers/active", { cacheTtlMs: 10000 }).catch((error) => ({ error: error.message })),
      ]);
      const normalizedBoard = normalizeOfficeBoard(nextBoard);
      setBoard(normalizedBoard);
      setNativeOps({ diagnostics, stats, workers });
      saveCachedBoard(normalizedBoard);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(loadBoard, 0);
    const timer = window.setInterval(loadBoard, 15000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadBoard]);

  const allTasks = useMemo(
    () => (board.columns ?? []).flatMap((column) => (column.tasks ?? []).map((task) => ({ ...task, column: column.name }))),
    [board.columns],
  );

  const visibleTasks = useMemo(
    () => allTasks.filter((task) => !isDeletedTask(task)),
    [allTasks],
  );

  const archivedDoneTasks = useMemo(
    () => visibleTasks.filter((task) => taskStatus(task) === "done" && isArchivedDone(task)),
    [visibleTasks],
  );

  const taskColumn = useCallback((status) => {
    return visibleTasks.filter((task) => {
      if (taskStatus(task) !== status) return false;
      if (status !== "done") return true;
      return showDoneArchive ? isArchivedDone(task) : !isArchivedDone(task);
    });
  }, [showDoneArchive, visibleTasks]);

  const findBoardTask = useCallback((taskId) => {
    const task = allTasks.find((item) => item.id === taskId);
    return { task: task ?? null, column: task?.column ?? "" };
  }, [allTasks]);

  const selectedOwner = useMemo(
    () => TEAM_META[selectedTask?.assignee] ?? TEAM_META.default,
    [selectedTask?.assignee],
  );

  const selectedEvents = useMemo(() => taskEvents(selectedTask), [selectedTask]);
  const selectedChecklist = useMemo(() => taskChecklist(selectedTask ?? {}), [selectedTask]);
  const [healthTone, healthText] = useMemo(() => taskHealth(selectedTask ?? {}), [selectedTask]);

  const addEventToMetadata = (task, metadata, eventText, type = "action") => ({
    ...metadata,
    task_events: [
      {
        id: crypto.randomUUID(),
        type,
        actor: "user",
        text: eventText,
        at: new Date().toISOString(),
      },
      ...taskEvents(task),
    ].slice(0, 40),
  });

  const createTask = async () => {
    if (!title.trim()) return;
    try {
      await hermesFetch("/api/plugins/kanban/tasks", {
        method: "POST",
        body: JSON.stringify(officialCreateTaskPayload({ title, assignee })),
      });
      setTitle("");
      await loadBoard();
    } catch (createError) {
      setError(createError.message);
    }
  };

  const runOfficialDispatch = async () => {
    try {
      setNotice("Hermes dispatcher를 실행 중입니다.");
      await hermesFetch("/api/plugins/kanban/dispatch", {
        method: "POST",
        body: JSON.stringify({}),
        timeoutMs: 60000,
      });
      setNotice("Hermes dispatcher 실행이 완료되었습니다.");
      await loadBoard();
    } catch (dispatchError) {
      setError(dispatchError.message);
    }
  };

  const patchTask = async (task, patch, eventText = "", eventType = "action") => {
    const result = await patchOfficeTaskFromLatest(hermesFetch, task.id, patch, (latestTask) => {
      const baseMetadata = {
        ...(latestTask.metadata ?? {}),
        ...(patch.metadata ?? {}),
      };
      return eventText ? addEventToMetadata(latestTask, baseMetadata, eventText, eventType) : baseMetadata;
    });
    const nextTask = result.task;
    setSelectedTask((current) => (current?.id === task.id ? nextTask : current));
    await loadBoard();
    return nextTask;
  };

  const openMoveDialog = (taskId, targetStatus) => {
    if (!taskId) return;
    const { task } = findBoardTask(taskId);
    if (!task || isDeletedTask(task)) return;
    const currentStatus = taskStatus(task);
    if (currentStatus === targetStatus) return;
    if (currentStatus === "review" || targetStatus === "review") {
      setNotice("검토 상태는 Hermes worker의 완료·검토 흐름에서만 전환됩니다.");
      return;
    }
    setError("");
    setNotice("");
    setMoveRequest({ task, fromStatus: currentStatus, targetStatus });
    setMoveForm(emptyMoveForm(task));
  };

  const closeMoveDialog = () => {
    setMoveRequest(null);
    setMoveForm(emptyMoveForm(null));
  };

  const confirmMoveTask = async () => {
    if (!moveRequest?.task) return;
    const { task, targetStatus } = moveRequest;
    const policy = MOVE_POLICIES[targetStatus];
    if (targetStatus === "blocked" && !moveForm.note.trim()) {
      setError("멈춤 상태로 이동하려면 막힌 이유를 입력해주세요.");
      return;
    }
    if (targetStatus === "done" && (!moveForm.finalReportChecked || !moveForm.artifactChecked)) {
      setError("완료 처리 전에 최종 보고와 산출물 확인을 체크해주세요.");
      return;
    }

    const metadataPatch = {
      due_date: moveForm.dueDate,
      status_note: moveForm.note.trim(),
      last_status_from: moveRequest.fromStatus,
      last_status_to: targetStatus === "running" ? "ready" : targetStatus,
      last_status_changed_at: new Date().toISOString(),
    };
    if (targetStatus === "scheduled") metadataPatch.scheduled_at = moveForm.scheduledAt;
    if (targetStatus === "blocked") {
      metadataPatch.blocked_reason = moveForm.note.trim();
      metadataPatch.support_target = moveForm.supportTarget;
      metadataPatch.blocked_at = new Date().toISOString();
    }
    if (targetStatus === "running") {
      metadataPatch.dispatch_requested_at = new Date().toISOString();
      metadataPatch.execution_mode = "official-dispatch";
      metadataPatch.intended_status = "running";
    }
    if (targetStatus === "done") {
      metadataPatch.completed_at = new Date().toISOString();
      metadataPatch.final_report_checked = true;
      metadataPatch.artifact_checked = true;
    }

    try {
      const movePlan = officialKanbanMovePlan(targetStatus);
      const nextTask = await patchTask(task, {
        status: movePlan.status,
        assignee: moveForm.assignee,
        priority: Number(moveForm.priority) || 0,
        metadata: metadataPatch,
      }, `${policy.event}${moveForm.note.trim() ? ` 메모: ${moveForm.note.trim()}` : ""}`, `status:${targetStatus}`);

      closeMoveDialog();

      if (movePlan.dispatch) {
        await hermesFetch("/api/plugins/kanban/dispatch", {
          method: "POST",
          body: JSON.stringify({}),
          timeoutMs: 60000,
        });
        setNotice("실행 준비 전환 후 공식 dispatcher 호출을 완료했습니다.");
        await loadBoard();
        onOpenAgent?.({
          profile: nextTask.assignee ?? "default",
          taskId: nextTask.id,
          label: nextTask.title,
          prompt: taskPrompt(nextTask, "instruct", moveForm.note),
        });
      }
    } catch (moveError) {
      setError(moveError.message);
    }
  };

  const openTask = (task) => {
    const metadata = task.metadata ?? {};
    setSelectedTask(task);
    setCollaborator(metadata.collaborators?.[0] ?? "");
    setReviewer(metadata.reviewers?.[0] ?? "");
    setDueDate(metadata.due_date ?? "");
    setChecklistInput("");
    setDeleteReason("");
    setNotice("");
  };

  const saveTaskPlan = async () => {
    if (!selectedTask) return;
    try {
      await patchTask(selectedTask, {
        metadata: {
          due_date: dueDate,
          checklist: selectedChecklist,
        },
      }, "마감일과 체크리스트가 저장되었습니다.");
      setNotice("업무 계획을 저장했습니다.");
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const addChecklistItem = async () => {
    if (!selectedTask || !checklistInput.trim()) return;
    const nextChecklist = [
      ...selectedChecklist,
      { id: crypto.randomUUID(), text: checklistInput.trim(), done: false },
    ];
    try {
      await patchTask(selectedTask, {
        metadata: {
          checklist: nextChecklist,
          due_date: dueDate,
        },
      }, `체크리스트가 추가되었습니다. ${checklistInput.trim()}`);
      setChecklistInput("");
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const toggleChecklistItem = async (itemId) => {
    if (!selectedTask) return;
    const nextChecklist = selectedChecklist.map((item) =>
      item.id === itemId ? { ...item, done: !item.done } : item,
    );
    try {
      await patchTask(selectedTask, {
        metadata: {
          checklist: nextChecklist,
          due_date: dueDate,
        },
      }, "체크리스트 상태가 변경되었습니다.");
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const removeChecklistItem = async (itemId) => {
    if (!selectedTask) return;
    const target = selectedChecklist.find((item) => item.id === itemId);
    const nextChecklist = selectedChecklist.filter((item) => item.id !== itemId);
    try {
      await patchTask(selectedTask, {
        metadata: {
          checklist: nextChecklist,
          due_date: dueDate,
        },
      }, target ? `체크리스트가 삭제되었습니다. ${target.text}` : "체크리스트가 삭제되었습니다.");
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const saveCollaboration = async () => {
    if (!selectedTask) return;
    try {
      await patchTask(selectedTask, {
        metadata: {
          collaborators: collaborator ? [collaborator] : [],
          reviewers: reviewer ? [reviewer] : [],
          collaboration_requested_at: new Date().toISOString(),
        },
      }, "협업자와 검토자 구성이 저장되었습니다.");
      setNotice("협업 구조를 저장했습니다.");
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  const openAgentWithTask = async (intent) => {
    if (!selectedTask) return;
    const eventMap = {
      instruct: "담당자에게 추가 지시를 준비했습니다.",
      status: "담당자에게 진행 상황 보고를 요청했습니다.",
      unblock: "멈춤 원인 진단을 요청했습니다.",
      review: "완료 검토 보고를 요청했습니다.",
    };
    let task = selectedTask;
    try {
      if (intent === "unblock" && taskStatus(task) !== "blocked") {
        task = await patchTask(task, {
          status: "blocked",
          metadata: { blocked_at: new Date().toISOString() },
        }, "업무가 멈춤 상태로 전환되었습니다.", "status:blocked");
      }
      if (intent === "review") {
        task = await patchTask(task, {
          metadata: { review_requested_at: new Date().toISOString() },
        }, "완료 검토 보고를 요청했습니다.");
      }
      if (intent !== "review") await patchTask(task, {}, eventMap[intent]);
    } catch (actionError) {
      setError(actionError.message);
    }
    onOpenAgent?.({
      profile: task.assignee ?? "default",
      taskId: task.id,
      label: task.title,
      prompt: taskPrompt(task, intent),
    });
  };

  const decomposeSelectedTask = async () => {
    if (!selectedTask) return;
    try {
      setNotice("Hermes 공식 decompose를 실행 중입니다.");
      await hermesFetch(`/api/plugins/kanban/tasks/${encodeURIComponent(selectedTask.id)}/decompose`, {
        method: "POST",
        body: JSON.stringify({}),
        timeoutMs: 120000,
      });
      setNotice("Task decompose가 완료되었습니다. 보드를 새로고침했습니다.");
      await loadBoard();
    } catch (decomposeError) {
      setError(decomposeError.message);
    }
  };

  const startTaskMeeting = async () => {
    if (!selectedTask) return;
    const targetCollaborator = collaborator || reviewer || "";
    if (!targetCollaborator) {
      setNotice("협업자나 검토자를 먼저 선택해주세요.");
      return;
    }
    try {
      const task = await patchTask(selectedTask, {
        metadata: {
          collaborators: collaborator ? [collaborator] : selectedTask.metadata?.collaborators ?? [],
          reviewers: reviewer ? [reviewer] : selectedTask.metadata?.reviewers ?? [],
          collaboration_requested_at: new Date().toISOString(),
        },
      }, "업무 협업 회의가 시작되었습니다.");
      onStartMeeting?.(buildTaskMeeting(task, targetCollaborator));
    } catch (meetingError) {
      setError(meetingError.message);
    }
  };

  const approveTask = async () => {
    if (!selectedTask) return;
    try {
      await patchTask(selectedTask, {
        status: "done",
        metadata: {
          completed_at: new Date().toISOString(),
          final_report_checked: true,
          artifact_checked: true,
        },
      }, "사용자가 완료 승인했습니다.", "status:done");
      setNotice("완료 승인했습니다.");
    } catch (approvalError) {
      setError(approvalError.message);
    }
  };

  const requestTaskChanges = async () => {
    if (!selectedTask) return;
    try {
      const task = await patchTask(selectedTask, {
        metadata: { revision_requested_at: new Date().toISOString() },
      }, "사용자가 수정 요청을 준비했습니다.");
      onOpenAgent?.({
        profile: task.assignee ?? "default",
        taskId: task.id,
        label: task.title,
        prompt: `${taskPrompt(task, "review")}\n\n검토 결과 수정이 필요합니다. 수정해야 할 부분을 확인하고, 필요한 질문이 있으면 먼저 물어봐주세요.\n\n수정 요청:`,
      });
    } catch (approvalError) {
      setError(approvalError.message);
    }
  };

  const softDeleteTask = async () => {
    if (!selectedTask || !deleteReason.trim()) {
      setNotice("삭제 사유를 입력해주세요. 기록 보존을 위해 필수입니다.");
      return;
    }
    try {
      await patchTask(selectedTask, {
        status: "archived",
        metadata: {
          deleted_at: new Date().toISOString(),
          deleted_by: "user",
          delete_reason: deleteReason.trim(),
        },
      }, `업무를 공식 보관함으로 이동했습니다. 사유: ${deleteReason.trim()}`, "archived");
      setSelectedTask(null);
      setDeleteReason("");
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  return (
    <section className="native-kanban">
      <header>
        <div>
          <span>HERMES NATIVE KANBAN</span>
          <h2>AI 팀 업무 보드</h2>
          <p>드래그하면 상태별 정책 팝업이 열리고, 모든 변경은 task 타임라인에 기록됩니다.</p>
        </div>
        <div className="kanban-create">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="새 업무 제목" />
          <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            {Object.entries(TEAM_META).map(([name, meta]) => <option key={name} value={name}>{meta.name}</option>)}
          </select>
          <button type="button" onClick={createTask}>업무 추가</button>
        </div>
      </header>

      <div className="kanban-native-ops">
        <article>
          <small>DIAGNOSTICS</small>
          <strong>{Array.isArray(nativeOps.diagnostics?.diagnostics) ? nativeOps.diagnostics.diagnostics.length : nativeOps.diagnostics?.error ? "ERR" : "OK"}</strong>
          <span>{nativeOps.diagnostics?.error || "Hermes board diagnostics"}</span>
        </article>
        <article>
          <small>ACTIVE WORKERS</small>
          <strong>{Array.isArray(nativeOps.workers?.workers) ? nativeOps.workers.workers.length : nativeOps.workers?.active?.length ?? 0}</strong>
          <span>gateway dispatcher worker state</span>
        </article>
        <article>
          <small>OFFICIAL DISPATCH</small>
          <button type="button" onClick={runOfficialDispatch}>dispatcher 실행</button>
        </article>
      </div>

      <div className="kanban-policy-bar">
        <span>완료 task는 최근 {DONE_ARCHIVE_DAYS}일만 표시됩니다.</span>
        <button type="button" onClick={() => setShowDoneArchive((current) => !current)}>
          {showDoneArchive ? "최근 완료 보기" : `완료 아카이브 보기 (${archivedDoneTasks.length})`}
        </button>
      </div>

      {error && <p className="kanban-api-error">{error}</p>}
      {loading ? <p className="empty-state">Hermes 업무 보드를 불러오는 중입니다.</p> : (
        <div className="native-kanban-grid">
          {COLUMNS.map(([status, label, english]) => {
            const tasks = taskColumn(status);
            const isManualDropTarget = status !== "review";
            return (
              <section
                key={status}
                className={`native-kanban-column ${status}${isManualDropTarget ? "" : " display-only"}`}
                aria-label={isManualDropTarget ? `${label} 상태` : `${label} 상태, Hermes worker 전용, 수동 이동 불가`}
                onDragOver={isManualDropTarget ? (event) => event.preventDefault() : undefined}
                onDrop={isManualDropTarget ? () => {
                  openMoveDialog(dragged, status);
                  setDragged("");
                } : undefined}
              >
                <header>
                  <div>
                    <small>{english}</small>
                    <strong>{status === "done" && showDoneArchive ? "완료 아카이브" : label}</strong>
                    <em>{MOVE_POLICIES[status]?.description}</em>
                  </div>
                  <b>{tasks.length}</b>
                </header>
                <div>
                  {tasks.map((task) => {
                    const owner = TEAM_META[task.assignee] ?? TEAM_META.default;
                    return (
                      <article
                        key={task.id}
                        draggable={status !== "review"}
                        onDragStart={() => setDragged(task.id)}
                        onDragEnd={() => setDragged("")}
                        onClick={() => openTask(task)}
                      >
                        <small>#{String(task.id).slice(-6)} · P{task.priority ?? 0}</small>
                        <strong>{task.title}</strong>
                        {task.body && <p>{task.body}</p>}
                        {task.metadata?.status_note && <p className="task-note">{task.metadata.status_note}</p>}
                        {(task.metadata?.collaborators?.length > 0 || task.metadata?.reviewers?.length > 0) && (
                          <div className="task-collaboration">
                            {task.metadata.collaborators?.map((name) => <span key={name}>협업 {TEAM_META[name]?.name ?? name}</span>)}
                            {task.metadata.reviewers?.map((name) => <span key={name}>검토 {TEAM_META[name]?.name ?? name}</span>)}
                          </div>
                        )}
                        <button type="button" onClick={(event) => { event.stopPropagation(); onOpenAgent?.(task.assignee ?? "default"); }}>
                          <span style={{ "--avatar": owner.color }}>{owner.initials}</span>{owner.name}
                        </button>
                        <label
                          className="kanban-card-status-control"
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <span>상태 이동</span>
                          <select
                            aria-label={`${task.title} 상태 이동`}
                            value={taskStatus(task)}
                            disabled={taskStatus(task) === "review"}
                            onChange={(event) => openMoveDialog(task.id, event.target.value)}
                          >
                            {COLUMNS.filter(([targetStatus]) => targetStatus !== "review").map(([targetStatus, targetLabel]) => (
                              <option key={targetStatus} value={targetStatus}>{targetLabel}</option>
                            ))}
                            {taskStatus(task) === "review" && <option value="review">검토 · worker 전용</option>}
                          </select>
                        </label>
                      </article>
                    );
                  })}
                  {!tasks.length && <p>{status === "review" ? "Hermes worker 검토 대기 없음" : "여기로 업무를 옮기세요"}</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {moveRequest && (
        <div className="kanban-task-backdrop move-dialog-backdrop" onMouseDown={closeMoveDialog}>
          <section ref={moveDialogRef} className="kanban-move-dialog" role="dialog" aria-modal="true" aria-labelledby="kanban-move-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>STATUS MOVE POLICY</span>
                <h3 id="kanban-move-title">{MOVE_POLICIES[moveRequest.targetStatus].title}</h3>
                <p>{moveRequest.task.title}</p>
              </div>
              <button type="button" onClick={closeMoveDialog}>닫기</button>
            </header>
            <div className="move-route" aria-label={moveRequest.targetStatus === "running" ? "실행 준비 전환 후 공식 dispatcher 실행" : undefined}>
              <strong>{STATUS_LABEL[moveRequest.fromStatus] ?? moveRequest.fromStatus}</strong>
              <span>→</span>
              {moveRequest.targetStatus === "running" ? (
                <><strong>실행 준비</strong><span>→</span><strong>공식 dispatcher</strong></>
              ) : <strong>{STATUS_LABEL[moveRequest.targetStatus] ?? moveRequest.targetStatus}</strong>}
            </div>
            <p className="move-policy-copy">{MOVE_POLICIES[moveRequest.targetStatus].description}</p>

            <div className="move-dialog-grid">
              <label>
                담당자
                <select value={moveForm.assignee} onChange={(event) => setMoveForm((current) => ({ ...current, assignee: event.target.value }))}>
                  {Object.entries(TEAM_META).map(([name, meta]) => <option key={name} value={name}>{meta.name} · {meta.role}</option>)}
                </select>
              </label>
              <label>
                우선순위
                <select value={moveForm.priority} onChange={(event) => setMoveForm((current) => ({ ...current, priority: event.target.value }))}>
                  <option value="0">P0 중요</option>
                  <option value="1">P1 높음</option>
                  <option value="2">P2 보통</option>
                  <option value="3">P3 낮음</option>
                </select>
              </label>
              <label>
                마감 또는 기준일
                <input type="datetime-local" value={moveForm.dueDate} onChange={(event) => setMoveForm((current) => ({ ...current, dueDate: event.target.value }))} />
              </label>
              {moveRequest.targetStatus === "scheduled" && (
                <label>
                  예약 실행 시간
                  <input type="datetime-local" value={moveForm.scheduledAt} onChange={(event) => setMoveForm((current) => ({ ...current, scheduledAt: event.target.value }))} />
                </label>
              )}
              {moveRequest.targetStatus === "blocked" && (
                <label>
                  지원 요청 대상
                  <select value={moveForm.supportTarget} onChange={(event) => setMoveForm((current) => ({ ...current, supportTarget: event.target.value }))}>
                    <option value="">사용자 판단 필요</option>
                    {Object.entries(TEAM_META).map(([name, meta]) => <option key={name} value={name}>{meta.name}</option>)}
                    <option value="meeting">회의 필요</option>
                  </select>
                </label>
              )}
            </div>

            <label className="move-note-field">
              {MOVE_POLICIES[moveRequest.targetStatus].noteLabel}
              <textarea value={moveForm.note} onChange={(event) => setMoveForm((current) => ({ ...current, note: event.target.value }))} placeholder="이 상태로 이동하는 이유와 다음 액션을 남겨주세요." />
            </label>

            {moveRequest.targetStatus === "done" && (
              <div className="move-checks">
                <label><input type="checkbox" checked={moveForm.finalReportChecked} onChange={(event) => setMoveForm((current) => ({ ...current, finalReportChecked: event.target.checked }))} /> 최종 보고를 확인했습니다.</label>
                <label><input type="checkbox" checked={moveForm.artifactChecked} onChange={(event) => setMoveForm((current) => ({ ...current, artifactChecked: event.target.checked }))} /> 산출물 또는 결과물을 확인했습니다.</label>
              </div>
            )}

            <footer>
              <button type="button" onClick={closeMoveDialog}>취소</button>
              <button type="button" className="primary-button" onClick={confirmMoveTask}>
                {moveRequest.targetStatus === "running" ? "실행 준비 후 dispatcher 실행" : "상태 변경 확정"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {selectedTask && (
        <div className="kanban-task-backdrop" onMouseDown={() => setSelectedTask(null)}>
          <section ref={taskDialogRef} className="kanban-task-drawer task-ops-drawer" role="dialog" aria-modal="true" aria-labelledby="kanban-task-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>TASK OPERATIONS</span>
                <h3 id="kanban-task-title">{selectedTask.title}</h3>
              </div>
              <button type="button" onClick={() => setSelectedTask(null)}>닫기</button>
            </header>

            <div className="task-ops-status">
              <article><small>상태</small><strong>{STATUS_LABEL[taskStatus(selectedTask)] ?? taskStatus(selectedTask)}</strong></article>
              <article><small>담당자</small><strong>{selectedOwner.name}</strong></article>
              <article><small>우선순위</small><strong>P{selectedTask.priority ?? 0}</strong></article>
              <article><small>마감/기준일</small><strong>{dueDate ? formatDate(dueDate) : "미설정"}</strong></article>
            </div>

            <section className={`task-health-card ${healthTone}`}>
              <span>{healthTone.toUpperCase()}</span>
              <strong>{healthText}</strong>
            </section>

            {taskStatus(selectedTask) !== "review" && (
              <section className="task-ops-section task-status-move" aria-label="업무 상태 이동">
                <span>MOVE STATUS</span>
                <p>드래그 없이도 이동할 상태를 선택할 수 있습니다. 이동 정책과 필수 입력은 다음 화면에서 확인합니다.</p>
                <div className="task-status-move-grid">
                  {COLUMNS.filter(([targetStatus]) => targetStatus !== "review" && targetStatus !== taskStatus(selectedTask)).map(([targetStatus, targetLabel]) => (
                    <button
                      type="button"
                      key={targetStatus}
                      onClick={() => {
                        const taskId = selectedTask.id;
                        setSelectedTask(null);
                        openMoveDialog(taskId, targetStatus);
                      }}
                    >
                      {targetLabel}로 이동
                    </button>
                  ))}
                </div>
              </section>
            )}

            {selectedTask.body && (
              <section className="task-ops-section">
                <span>BRIEF</span>
                <p>{selectedTask.body}</p>
              </section>
            )}

            <section className="task-ops-section">
              <span>PLAN</span>
              <label>
                마감 또는 기준일
                <input type="datetime-local" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
              </label>
              <div className="task-checklist">
                {selectedChecklist.map((item) => (
                  <article key={item.id} className={item.done ? "done" : ""}>
                    <button type="button" onClick={() => toggleChecklistItem(item.id)}>{item.done ? "✓" : ""}</button>
                    <span>{item.text}</span>
                    <button type="button" onClick={() => removeChecklistItem(item.id)}>×</button>
                  </article>
                ))}
                {!selectedChecklist.length && <p>체크리스트가 아직 없습니다. 완료 기준을 작게 나누면 검토가 쉬워집니다.</p>}
              </div>
              <div className="task-checklist-add">
                <input value={checklistInput} onChange={(event) => setChecklistInput(event.target.value)} placeholder="예: 초안 1차 검토" />
                <button type="button" onClick={addChecklistItem}>추가</button>
              </div>
              <button type="button" onClick={saveTaskPlan}>계획 저장</button>
            </section>

            <section className="task-ops-actions">
              <span>NEXT ACTION</span>
              <button type="button" onClick={() => openAgentWithTask("instruct")}>담당자에게 지시하기</button>
              <button type="button" onClick={() => openAgentWithTask("status")}>진행 상황 물어보기</button>
              <button type="button" className="danger" onClick={() => openAgentWithTask("unblock")}>멈춤 해결</button>
              <button type="button" onClick={() => openAgentWithTask("review")}>완료 검토하기</button>
              <button type="button" onClick={decomposeSelectedTask}>공식 decompose</button>
            </section>

            <section className="task-ops-section task-review-actions">
              <span>REVIEW DECISION</span>
              <p>검토 단계에서는 승인 또는 수정 요청만 남기는 편이 가장 명확합니다.</p>
              <div className="task-ops-row">
                <button type="button" className="primary-button" onClick={approveTask}>승인하고 완료</button>
                <button type="button" onClick={requestTaskChanges}>수정 요청</button>
              </div>
            </section>

            <section className="task-ops-section">
              <span>COLLABORATION</span>
              <label>
                협업 요청
                <select value={collaborator} onChange={(event) => setCollaborator(event.target.value)}>
                  <option value="">협업자 없음</option>
                  {Object.entries(TEAM_META).filter(([name]) => name !== selectedTask.assignee).map(([name, meta]) => <option key={name} value={name}>{meta.name} · {meta.role}</option>)}
                </select>
              </label>
              <label>
                검토 요청
                <select value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
                  <option value="">검토자 없음</option>
                  {Object.entries(TEAM_META).filter(([name]) => name !== selectedTask.assignee).map(([name, meta]) => <option key={name} value={name}>{meta.name} · {meta.role}</option>)}
                </select>
              </label>
              <div className="task-ops-row">
                <button type="button" onClick={saveCollaboration}>협업 구조 저장</button>
                <button type="button" className="primary-button" onClick={startTaskMeeting}>미팅 열기</button>
              </div>
            </section>

            <section className="task-ops-section">
              <span>LINKED CONTEXT</span>
              <div className="task-context-list">
                <article><small>관련 회의</small><strong>{selectedTask.metadata?.meeting_topic ?? "연결된 회의 없음"}</strong></article>
                <article><small>회의 ID</small><strong>{selectedTask.metadata?.meeting_id ?? "기록 없음"}</strong></article>
                <article><small>협업 요청일</small><strong>{formatDate(selectedTask.metadata?.collaboration_requested_at)}</strong></article>
              </div>
            </section>

            {(selectedTask.metadata?.meeting_outcome || selectedTask.metadata?.meeting_summary) && (
              <section className="task-ops-section task-meeting-outcome">
                <span>MEETING OUTCOME</span>
                {selectedTask.metadata?.meeting_reporter && (
                  <article>
                    <small>최종 보고자</small>
                    <strong>{TEAM_META[selectedTask.metadata.meeting_reporter]?.name ?? selectedTask.metadata.meeting_reporter}</strong>
                  </article>
                )}
                {!!selectedTask.metadata?.meeting_decisions?.length && (
                  <div>
                    <small>결정사항</small>
                    {selectedTask.metadata.meeting_decisions.map((item) => <p key={item}>{item}</p>)}
                  </div>
                )}
                {!!selectedTask.metadata?.meeting_actions?.length && (
                  <div>
                    <small>담당 액션</small>
                    {selectedTask.metadata.meeting_actions.map((action) => (
                      <p key={`${action.assignee}-${action.title}`}><b>{TEAM_META[action.assignee]?.name ?? action.assignee}</b> {action.title}</p>
                    ))}
                  </div>
                )}
                {!!selectedTask.metadata?.meeting_blockers?.length && (
                  <div>
                    <small>막힘/승인 필요</small>
                    {selectedTask.metadata.meeting_blockers.map((item) => <p key={item}>{item}</p>)}
                  </div>
                )}
                {!selectedTask.metadata?.meeting_decisions?.length && selectedTask.metadata?.meeting_summary && (
                  <p>{selectedTask.metadata.meeting_summary}</p>
                )}
              </section>
            )}

            <section className="task-ops-section">
              <span>TIMELINE</span>
              <div className="task-timeline">
                {selectedEvents.map((event) => (
                  <article key={event.id}>
                    <i />
                    <div><strong>{event.text}</strong><small>{formatDate(event.at)}</small></div>
                  </article>
                ))}
                {!selectedEvents.length && (
                  <article>
                    <i />
                    <div><strong>아직 기록된 액션이 없습니다.</strong><small>다음 액션을 누르면 이곳에 운영 기록이 쌓입니다.</small></div>
                  </article>
                )}
              </div>
            </section>

            <section className="task-ops-section task-danger-zone">
              <span>DANGER ZONE</span>
              <p>삭제는 완전 삭제가 아니라 휴지통 처리입니다. 보드에서는 사라지고, 메타데이터에는 삭제 사유와 시간이 보존됩니다.</p>
              <label>
                삭제 사유
                <input value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="예: 중복 task라 정리합니다." />
              </label>
              <button type="button" className="danger-button" onClick={softDeleteTask}>task 삭제</button>
            </section>

            {notice && <p className="task-ops-notice">{notice}</p>}
          </section>
        </div>
      )}
    </section>
  );
}
