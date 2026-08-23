import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HermesGateway } from "./gateway.js";
import { hermesFetch } from "./hermes.js";
import { mergeActivityView } from "./activityView.js";
import HermesPrompt from "./HermesPrompt.jsx";
import { TEAM_META } from "./officeData.js";
import { hitlResponseRequest, isHitlRequestExpired, normalizeHitlRequest } from "./officialContracts.js";
import { patchOfficeTaskFromLatest } from "./kanbanContracts.js";

const MEETING_STORAGE_KEY = "hermes-office-meetings";

function loadMeetingRecord(meetingId) {
  try {
    const meetings = JSON.parse(window.localStorage.getItem(MEETING_STORAGE_KEY) || "[]");
    return meetings.find((item) => item.id === meetingId) ?? null;
  } catch {
    return null;
  }
}

function meetingPrompt(topic, speaker, transcript, round) {
  const context = transcript.length
    ? `\n\nMeeting transcript so far:\n${transcript.map((item) => `- ${TEAM_META[item.profile]?.name}: ${item.text}`).join("\n")}`
    : "";
  return [
    `[Hermes Office team meeting / round ${round}]`,
    `Topic: ${topic}`,
    `You are ${speaker.name} (${speaker.role}).`,
    "Speak from your role. Give concise opinions, risks, recommendations, and next actions.",
    "If another participant already covered something, only add what is necessary.",
    "Write in Korean when the topic or user context is Korean. Keep the statement clear enough to be logged as meeting minutes.",
    context,
  ].join("\n");
}

function synthesisPrompt(topic, transcript) {
  return [
    "[Meeting synthesis and close]",
    `Topic: ${topic}`,
    "As the chair, write the final meeting minutes from the statements below.",
    "Organize the result in Korean if the topic is Korean.",
    "Include: 1) decisions, 2) unresolved issues or risks, 3) action items by owner, 4) approvals needed from the user.",
    "At the end, add one line per Kanban task in this exact format:",
    "[KANBAN] profile | task title | completion criteria",
    "Use only these profile ids: default, hermes-operations, hermes-brand, hermes-growth, hermes-content, hermes-creative, hermes-customer, hermes-finance, hermes-technology.",
    "",
    ...transcript.map((item) => `${TEAM_META[item.profile]?.name}: ${item.text}`),
  ].join("\n");
}

function extractKanbanActions(summaryText) {
  return [...summaryText.matchAll(/^\[KANBAN\]\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/gm)]
    .map((match) => ({
      assignee: match[1].trim(),
      title: match[2].trim(),
      body: match[3].trim(),
    }))
    .filter((action) => TEAM_META[action.assignee] && action.title);
}

function cleanSummaryLines(summaryText) {
  return summaryText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*0-9.)]+\s*/, "").trim())
    .filter((line) => line && !line.startsWith("[KANBAN]"));
}

function buildMeetingOutcome({ meeting, participants, chair, summaryText, completedRound }) {
  const reporter = meeting.requestedBy && TEAM_META[meeting.requestedBy] ? meeting.requestedBy : chair;
  const actions = extractKanbanActions(summaryText);
  const lines = cleanSummaryLines(summaryText);
  const decisions = lines
    .filter((line) => /(action|todo|next|decision|decide|owner|done|complete)/i.test(line))
    .slice(0, 6);
  const blockers = lines
    .filter((line) => /(block|risk|issue|pending|approve|confirm|need|required)/i.test(line))
    .slice(0, 5);

  return {
    reporter,
    reporterName: TEAM_META[reporter]?.name ?? reporter,
    chair,
    round: completedRound,
    completedAt: new Date().toISOString(),
    participants,
    decisions: decisions.length ? decisions : lines.slice(0, 4),
    blockers,
    actions,
    collaborations: actions
      .filter((action) => action.assignee !== reporter)
      .map((action) => ({
        from: reporter,
        to: action.assignee,
        title: action.title,
        reason: action.body,
      })),
  };
}

function outcomeReportText(outcome) {
  if (!outcome) return "";
  const decisionLines = outcome.decisions.length
    ? outcome.decisions.map((item) => `- ${item}`)
    : ["- Review the meeting summary."];
  const actionLines = outcome.actions.length
    ? outcome.actions.map((action) => `- ${TEAM_META[action.assignee]?.name ?? action.assignee}: ${action.title} (${action.body})`)
    : ["- No generated Kanban actions."];
  const blockerLines = outcome.blockers.length
    ? outcome.blockers.map((item) => `- ${item}`)
    : ["- No explicit blockers or approval requests."];

  return [
    "Decisions",
    ...decisionLines,
    "",
    "Actions",
    ...actionLines,
    "",
    "Blockers / approvals",
    ...blockerLines,
  ].join("\n");
}

function phaseLabel(phase) {
  const labels = {
    preparing: "회의 연결을 준비하고 있습니다",
    discussion: "참여자들이 의견을 정리하고 있습니다",
    synthesis: "주담당자가 회의록을 정리하고 있습니다",
    complete: "회의가 완료되었습니다",
    error: "회의 진행 확인이 필요합니다",
  };
  return labels[phase] ?? "회의 진행 중";
}

function meetingEventText(eventType, payload = {}) {
  if (eventType === "message.start") return "발언을 시작했습니다.";
  if (eventType === "thinking.delta" || eventType === "reasoning.delta") return payload.text || "판단 근거를 정리하고 있습니다.";
  if (eventType === "reasoning.available") return payload.text || "추론 요약이 준비되었습니다.";
  if (eventType === "tool.generating") return payload.name ? `${payload.name} 입력을 구성하고 있습니다.` : "도구 입력을 구성하고 있습니다.";
  if (eventType === "tool.progress") return payload.preview || payload.context || payload.name || "도구 진행 상황이 업데이트되었습니다.";
  if (eventType === "browser.progress") return payload.message || payload.text || "브라우저 기반 작업을 진행하고 있습니다.";
  if (eventType === "review.summary") return payload.text || "검토 요약이 도착했습니다.";
  if (eventType === "session.info") return payload.version || payload.model || payload.provider || "Hermes 세션 정보가 업데이트되었습니다.";
  if (eventType === "status.update") return payload.text || "진행 상태가 업데이트되었습니다.";
  if (eventType === "background.complete") return payload.text || "백그라운드 작업이 완료되었습니다.";
  if (eventType === "billing.step_up.verification") return payload.user_code ? `계정 확인 코드: ${payload.user_code}` : "계정 확인이 필요합니다.";
  if (eventType === "voice.status" || eventType === "voice.transcript") return payload.text || payload.state || "음성 이벤트가 업데이트되었습니다.";
  if (eventType?.startsWith("subagent.")) {
    return payload.summary || payload.text || payload.goal || payload.tool_preview || payload.tool_name || "협업 구성원 이벤트가 업데이트되었습니다.";
  }
  if (eventType === "clarify.request") return payload.question || "추가 확인이 필요합니다.";
  if (eventType === "approval.request" || eventType === "sudo.request" || eventType === "secret.request") {
    return payload.description || payload.prompt || payload.command || "사용자 승인 또는 입력이 필요합니다.";
  }
  if (eventType === "gateway.stderr" || eventType === "gateway.protocol_error" || eventType === "gateway.start_timeout") {
    return payload.message || payload.stderr_tail || "Gateway 런타임 확인이 필요합니다.";
  }
  return payload.text || payload.message || "";
}

function appendMeetingSystemEntry(setEntries, profile, eventType, payload = {}) {
  const text = meetingEventText(eventType, payload);
  if (!text) return;
  setEntries((current) => {
    const last = current[current.length - 1];
    if (last?.system && last.profile === profile && last.eventType === eventType && last.text === text) return current;
    return [...current, {
      id: crypto.randomUUID(),
      profile,
      kind: "system",
      system: true,
      eventType,
      text,
      pending: false,
      time: new Date().toLocaleTimeString("ko", { hour: "2-digit", minute: "2-digit" }),
    }].slice(-80);
  });
}

async function assertHermesSetupReady(gateway) {
  const setup = await gateway.request("setup.status", {}, 15000).catch(() => null);
  if (setup?.provider_configured === false) {
    throw new Error("Hermes provider 설정이 필요합니다. 운영 관리에서 모델/API 설정을 먼저 확인해주세요.");
  }
}

export default function MeetingConsole({ meeting, onActivityChange, onMeetingComplete, closeRequest, onMeetingClosed, onMeetingReopened, onExit }) {
  const restoredMeeting = useMemo(() => loadMeetingRecord(meeting.id), [meeting.id]);
  const [connection, setConnection] = useState("connecting");
  const [phase, setPhase] = useState(() => restoredMeeting?.status ?? "preparing");
  const [speaker, setSpeaker] = useState("");
  const [entries, setEntries] = useState(() => restoredMeeting?.entries ?? []);
  const [tools, setTools] = useState([]);
  const [error, setError] = useState("");
  const [pendingRequest, setPendingRequest] = useState(null);
  const [round, setRound] = useState(() => restoredMeeting?.round ?? 1);
  const [outcome, setOutcome] = useState(() => restoredMeeting?.outcome ?? null);
  const gatewayRef = useRef(null);
  const sessionsRef = useRef(new Map());
  const profileBySessionRef = useRef(new Map());
  const completionRef = useRef(new Map());
  const streamedTextRef = useRef(new Map());
  const startedRef = useRef(Boolean(restoredMeeting?.entries?.length) || restoredMeeting?.status === "complete");
  const kanbanSyncedRef = useRef(false);
  const reportedRoundsRef = useRef(new Set());
  const closingRef = useRef(false);
  const handledCloseRequestRef = useRef(0);
  const bottomRef = useRef(null);

  const participants = useMemo(
    () => meeting.participants.filter((profile) => TEAM_META[profile]),
    [meeting.participants],
  );
  const chair = participants.includes("default") ? "default" : participants[0];
  const meetingId = meeting.id;

  const persistMeeting = useCallback((nextEntries, nextPhase, nextRound, nextOutcome = outcome) => {
    const storedMeetings = (() => {
      try {
        return JSON.parse(window.localStorage.getItem(MEETING_STORAGE_KEY) || "[]");
      } catch {
        return [];
      }
    })();
    const meetings = Array.isArray(storedMeetings) ? storedMeetings : [];
    const existingRecord = meetings.find((item) => item.id === meetingId);
    const completedAt = nextPhase === "complete"
      ? (nextOutcome?.completedAt ?? existingRecord?.completedAt ?? new Date().toISOString())
      : undefined;
    const record = {
      id: meetingId,
      topic: meeting.topic,
      participants,
      chair,
      startedAt: meeting.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      status: nextPhase,
      round: nextRound,
      entries: nextEntries.filter((entry) => !entry.pending && entry.text),
      source: meeting.source ?? "meeting-console",
      requestedBy: meeting.requestedBy ?? chair,
      taskId: meeting.taskId ?? "",
      outcome: nextOutcome,
      completedAt,
    };
    const index = meetings.findIndex((item) => item.id === meetingId);
    if (index >= 0) meetings[index] = record;
    else meetings.unshift(record);
    window.localStorage.setItem(MEETING_STORAGE_KEY, JSON.stringify(meetings.slice(0, 100)));
  }, [chair, meeting.requestedBy, meeting.source, meeting.startedAt, meeting.taskId, meeting.topic, meetingId, outcome, participants]);

  const syncKanbanActions = useCallback(async (summaryText, meetingOutcome) => {
    if (kanbanSyncedRef.current) return;
    const actions = meetingOutcome?.actions?.length ? meetingOutcome.actions : extractKanbanActions(summaryText);
    if (!actions.length) return;
    kanbanSyncedRef.current = true;
    await Promise.all(actions.map(async (action, index) => {
      const created = await hermesFetch("/api/plugins/kanban/tasks", {
        method: "POST",
        body: JSON.stringify({
        title: action.title,
        body: action.body,
        assignee: action.assignee,
        priority: 0,
        triage: false,
        idempotency_key: `${meetingId}-${index}-${action.assignee}`,
        }),
      });
      const taskId = created.id ?? created.task?.id;
      if (taskId) {
        const metadata = {
          source: "meeting",
          meeting_id: meetingId,
          meeting_topic: meeting.topic,
          meeting_round: meetingOutcome?.round,
          meeting_reporter: meetingOutcome?.reporter,
          meeting_decisions: meetingOutcome?.decisions ?? [],
          meeting_blockers: meetingOutcome?.blockers ?? [],
          meeting_outcome: meetingOutcome ?? null,
          reviewers: action.assignee === "hermes-operations" ? [] : ["hermes-operations"],
          task_events: [{
            id: crypto.randomUUID(),
            type: "meeting:task-created",
            actor: "meeting",
            text: `Meeting created a task for ${TEAM_META[action.assignee]?.name ?? action.assignee}.`,
            at: new Date().toISOString(),
          }],
        };
        await patchOfficeTaskFromLatest(hermesFetch, taskId, {}, (latestTask) => ({
          ...(latestTask.metadata ?? {}),
          ...metadata,
        }));
      }
    }));
  }, [meeting.topic, meetingId]);

  const publishMeetingReport = useCallback((summaryText, completedRound, meetingOutcome) => {
    const reportKey = `${meetingId}:${completedRound}`;
    if (reportedRoundsRef.current.has(reportKey)) return;
    reportedRoundsRef.current.add(reportKey);
    const reporter = meeting.requestedBy && TEAM_META[meeting.requestedBy]
      ? meeting.requestedBy
      : chair;
    const reporterName = TEAM_META[reporter]?.name ?? "Reporter";
    const reportText = [
      `${reporterName} completed the requested meeting.`,
      "",
      `Meeting topic: ${meeting.topic}`,
      `Participants: ${participants.map((name) => TEAM_META[name]?.name).filter(Boolean).join(", ")}`,
      "",
      "Meeting summary:",
      summaryText,
      "",
      outcomeReportText(meetingOutcome),
      "",
      "Possible Kanban items were created automatically. Full statements remain in the meeting archive.",
    ].join("\n");
    onMeetingComplete?.({
      id: `meeting-report-${meetingId}-${completedRound}`,
      type: "meeting-report",
      profile: reporter,
      meetingId,
      topic: meeting.topic,
      round: completedRound,
      participants,
      summary: reportText,
      outcome: meetingOutcome,
      createdAt: Date.now(),
    });
  }, [chair, meeting.requestedBy, meeting.topic, meetingId, onMeetingComplete, participants]);

  const syncTaskMeetingResult = useCallback(async (summaryText, completedRound, meetingOutcome) => {
    if (!meeting.taskId || !meeting.taskSnapshot) return;
    await patchOfficeTaskFromLatest(hermesFetch, meeting.taskId, {}, (latestTask) => {
      const baseMetadata = latestTask.metadata ?? {};
      const taskEvents = Array.isArray(baseMetadata.task_events) ? baseMetadata.task_events : [];
      return {
        ...baseMetadata,
        meeting_id: meetingId,
        meeting_topic: meeting.topic,
        meeting_completed_at: new Date().toISOString(),
        meeting_summary: summaryText,
        meeting_reporter: meetingOutcome?.reporter,
        meeting_round: completedRound,
        meeting_decisions: meetingOutcome?.decisions ?? [],
        meeting_actions: meetingOutcome?.actions ?? [],
        meeting_blockers: meetingOutcome?.blockers ?? [],
        meeting_collaborations: meetingOutcome?.collaborations ?? [],
        meeting_outcome: meetingOutcome ?? null,
        task_events: [
          {
            id: `meeting-${meetingId}-${completedRound}`,
            type: "meeting:complete",
            actor: "meeting",
            text: "Task collaboration meeting completed and the result was recorded.",
            at: new Date().toISOString(),
          },
          ...taskEvents,
        ].slice(0, 30),
      };
    });
  }, [meeting.taskId, meeting.taskSnapshot, meeting.topic, meetingId]);

  const updateEntry = useCallback((profile, updater) => {
    setEntries((current) => {
      const index = current.findLastIndex((entry) => entry.profile === profile && entry.pending);
      if (index < 0) return current;
      const next = [...current];
      next[index] = updater(next[index]);
      return next;
    });
  }, []);

  const waitForCompletion = useCallback((sessionId) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      completionRef.current.delete(sessionId);
      reject(new Error(`${TEAM_META[profileBySessionRef.current.get(sessionId)]?.name ?? "Participant"} response timed out.`));
    }, 180000);
    completionRef.current.set(sessionId, {
      resolve: (text) => {
        window.clearTimeout(timer);
        resolve(text);
      },
      reject,
    });
  }), []);

  const ensureSession = useCallback(async (profile) => {
    if (sessionsRef.current.has(profile)) return sessionsRef.current.get(profile);
    await assertHermesSetupReady(gatewayRef.current);
    const created = await gatewayRef.current.request("session.create", {
      cols: 96,
      profile,
      title: `[Meeting] ${meeting.topic}`,
    });
    sessionsRef.current.set(profile, created.session_id);
    profileBySessionRef.current.set(created.session_id, profile);
    return created.session_id;
  }, [meeting.topic]);

  const ask = useCallback(async (profile, prompt, kind = "statement") => {
    const sessionId = await ensureSession(profile);
    setSpeaker(profile);
    setEntries((current) => [...current, {
      id: crypto.randomUUID(),
      profile,
      kind,
      text: "",
      pending: true,
      time: new Date().toLocaleTimeString("ko", { hour: "2-digit", minute: "2-digit" }),
    }]);
    onActivityChange?.(profile, {
      state: "meeting",
      text: kind === "summary" ? "Synthesizing meeting" : "Speaking in meeting",
      collaborator: participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
    });
    const completion = waitForCompletion(sessionId);
    await gatewayRef.current.request("prompt.submit", { session_id: sessionId, text: prompt });
    return completion;
  }, [ensureSession, onActivityChange, participants, waitForCompletion]);

  const runRound = useCallback(async (nextRound, existingEntries = []) => {
    if (closingRef.current) return "";
    setPhase("discussion");
    setRound(nextRound);
    const transcript = existingEntries.filter((entry) => !entry.pending && entry.text && !entry.system);
    for (const profile of participants) {
      if (closingRef.current) return "";
      const text = await ask(
        profile,
        meetingPrompt(meeting.topic, TEAM_META[profile], transcript, nextRound),
      );
      transcript.push({ profile, text });
    }

    setPhase("synthesis");
    if (closingRef.current) return "";
    const summary = await ask(chair, synthesisPrompt(meeting.topic, transcript), "summary");
    const nextOutcome = buildMeetingOutcome({
      meeting,
      participants,
      chair,
      summaryText: summary,
      completedRound: nextRound,
    });
    setOutcome(nextOutcome);
    setPhase("complete");
    syncKanbanActions(summary, nextOutcome).catch((syncError) => setError(`Meeting completed, but Kanban sync failed: ${syncError.message}`));
    syncTaskMeetingResult(summary, nextRound, nextOutcome).catch((syncError) => setError(`Meeting completed, but task sync failed: ${syncError.message}`));
    publishMeetingReport(summary, nextRound, nextOutcome);
    setSpeaker("");
    participants.forEach((profile) => onActivityChange?.(profile, {
      state: "online",
      text: "Meeting complete",
      collaborator: "",
    }));
    return summary;
  }, [ask, chair, meeting, onActivityChange, participants, publishMeetingReport, syncKanbanActions, syncTaskMeetingResult]);

  const closeMeeting = useCallback(async (reason = "manual") => {
    if (closingRef.current) return;
    closingRef.current = true;
    const completedAt = new Date().toISOString();
    const finalOutcome = outcome ?? {
      reporter: meeting.requestedBy ?? chair,
      reporterName: TEAM_META[meeting.requestedBy ?? chair]?.name ?? TEAM_META[chair]?.name,
      chair,
      round,
      completedAt,
      participants,
      decisions: [],
      blockers: [],
      actions: [],
      collaborations: [],
      closedReason: reason,
    };
    const finalEntries = phase === "complete" ? entries : [...entries.filter((entry) => !entry.pending), {
      id: crypto.randomUUID(),
      profile: chair,
      kind: "system",
      system: true,
      eventType: "meeting.closed",
      text: "사용자가 회의를 종료했습니다. 현재까지의 기록을 아카이브로 이동합니다.",
      pending: false,
      time: new Date().toLocaleTimeString("ko", { hour: "2-digit", minute: "2-digit" }),
    }];
    setEntries(finalEntries);
    setOutcome(finalOutcome);
    setPhase("complete");
    setSpeaker("");
    persistMeeting(finalEntries, "complete", round, finalOutcome);
    completionRef.current.forEach(({ reject }) => reject(new Error("Meeting closed by user.")));
    completionRef.current.clear();
    const gateway = gatewayRef.current;
    if (gateway) {
      await Promise.allSettled([...sessionsRef.current.values()].map((sessionId) => (
        gateway.request("session.close", { session_id: sessionId }, 10000)
      )));
    }
    participants.forEach((profile) => onActivityChange?.(profile, {
      state: "online",
      text: "회의 종료",
      collaborator: "",
    }));
    onMeetingClosed?.({ meetingId, completedAt, reason, outcome: finalOutcome });
  }, [chair, entries, meeting.requestedBy, meetingId, onActivityChange, onMeetingClosed, outcome, participants, persistMeeting, phase, round]);

  useEffect(() => {
    if (!closeRequest || handledCloseRequestRef.current === closeRequest) return;
    handledCloseRequestRef.current = closeRequest;
    closeMeeting("tab-close").catch((closeError) => {
      setError(`회의 종료 중 확인이 필요합니다: ${closeError.message}`);
      closingRef.current = false;
    });
  }, [closeMeeting, closeRequest]);

  useEffect(() => {
    const gateway = new HermesGateway();
    gatewayRef.current = gateway;
    const removeState = gateway.onState(setConnection);
    const removeEvent = gateway.onEvent((event) => {
      if (event.type === "gateway.ready" || event.type === "skin.changed" || event.type === "notification.clear") return;
      const profile = profileBySessionRef.current.get(event.session_id);
      if (!profile) return;
      const payload = event.payload ?? {};

      if (event.type === "message.start") {
        setPhase((current) => current === "preparing" ? "discussion" : current);
      } else if (event.type === "message.delta") {
        streamedTextRef.current.set(
          event.session_id,
          `${streamedTextRef.current.get(event.session_id) ?? ""}${payload.text ?? ""}`,
        );
        updateEntry(profile, (entry) => ({ ...entry, text: `${entry.text}${payload.text ?? ""}` }));
      } else if (event.type === "message.complete") {
        const completedText = payload.text || streamedTextRef.current.get(event.session_id) || "";
        streamedTextRef.current.delete(event.session_id);
        updateEntry(profile, (entry) => ({ ...entry, text: completedText || entry.text, pending: false }));
        window.setTimeout(() => {
          const pending = completionRef.current.get(event.session_id);
          if (pending) {
            completionRef.current.delete(event.session_id);
            pending.resolve(completedText);
          }
        }, 0);
      } else if (event.type === "thinking.delta" || event.type === "reasoning.delta" || event.type === "reasoning.available") {
        if (event.type === "reasoning.available") {
          appendMeetingSystemEntry(setEntries, profile, event.type, payload);
        }
        onActivityChange?.(profile, {
          state: "meeting",
          text: event.type === "reasoning.available" ? meetingEventText(event.type, payload) : "생각 중",
          collaborator: participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
        });
      } else if (event.type === "tool.start") {
        setTools((current) => [...current.filter((tool) => tool.id !== payload.tool_id), {
          id: payload.tool_id,
          profile,
          name: payload.name ?? "tool",
          context: payload.context ?? "",
          preview: payload.args_text ?? "",
          running: true,
        }].slice(-8));
        onActivityChange?.(profile, mergeActivityView({
          state: "working",
          text: payload.context || `${payload.name ?? "tool"} running`,
          collaborator: participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
        }, payload));
      } else if (event.type === "tool.generating" || event.type === "tool.progress") {
        const toolId = payload.tool_id ?? `${profile}-${payload.name ?? "tool"}`;
        setTools((current) => {
          const existing = current.find((tool) => tool.id === toolId);
          const nextTool = {
            ...(existing ?? { id: toolId, profile, name: payload.name ?? "tool", context: "" }),
            preview: payload.preview ?? payload.args_text ?? existing?.preview ?? "",
            context: payload.context ?? existing?.context ?? "",
            running: true,
          };
          return [...current.filter((tool) => tool.id !== toolId), nextTool].slice(-8);
        });
        appendMeetingSystemEntry(setEntries, profile, event.type, payload);
        onActivityChange?.(profile, mergeActivityView({
          state: "working",
          text: meetingEventText(event.type, payload),
          collaborator: participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
        }, payload));
      } else if (event.type === "tool.complete") {
        setTools((current) => current.map((tool) =>
          tool.id === payload.tool_id ? { ...tool, running: false, summary: payload.summary, preview: payload.summary ?? tool.preview } : tool,
        ));
        onActivityChange?.(profile, mergeActivityView({
          state: "meeting",
          text: payload.summary || payload.context || `${payload.name ?? "tool"} complete`,
          collaborator: participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
        }, payload));
      } else if (
        event.type === "browser.progress" ||
        event.type === "review.summary" ||
        event.type === "session.info" ||
        event.type === "status.update" ||
        event.type === "background.complete" ||
        event.type === "billing.step_up.verification" ||
        event.type === "voice.status" ||
        event.type === "voice.transcript" ||
        event.type === "notification.show" ||
        event.type?.startsWith("subagent.")
      ) {
        appendMeetingSystemEntry(setEntries, profile, event.type, payload);
        onActivityChange?.(profile, mergeActivityView({
          state: event.type?.startsWith("subagent.") ? "meeting" : "working",
          text: meetingEventText(event.type, payload),
          collaborator: event.type?.startsWith("subagent.")
            ? payload.subagent_id || "subagent"
            : participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
        }, payload));
      } else if (event.type === "clarify.request" || event.type === "approval.request" || event.type === "sudo.request" || event.type === "secret.request") {
        appendMeetingSystemEntry(setEntries, profile, event.type, payload);
        try {
          setPendingRequest({ ...normalizeHitlRequest(event), profile });
        } catch (requestError) {
          setError(requestError.message);
        }
        onActivityChange?.(profile, {
          state: "approval",
          text: meetingEventText(event.type, payload),
          collaborator: "사용자",
        });
      } else if (["clarify.expire", "approval.expire", "secret.expire", "sudo.expire"].includes(event.type)) {
        const expiredRequestId = String(payload.request_id ?? "");
        setPendingRequest((current) => {
          if (!current || current.profile !== profile) return current;
          if (expiredRequestId && current.requestId !== expiredRequestId) return current;
          return null;
        });
        appendMeetingSystemEntry(setEntries, profile, event.type, {
          ...payload,
          message: "일회성 보안 입력 요청이 만료되었습니다.",
        });
        onActivityChange?.(profile, { state: "idle", text: "보안 입력 요청 만료", collaborator: "" });
      } else if (event.type === "gateway.stderr" || event.type === "gateway.protocol_error" || event.type === "gateway.start_timeout") {
        appendMeetingSystemEntry(setEntries, profile, event.type, payload);
        setError(meetingEventText(event.type, payload));
        setPhase("error");
      } else if (event.type === "error") {
        const pending = completionRef.current.get(event.session_id);
        completionRef.current.delete(event.session_id);
        pending?.reject(new Error(payload.message ?? "Meeting processing failed."));
      }
    });

    gateway.connect().catch((meetingError) => {
        setError(meetingError.message);
        setPhase("error");
        setSpeaker("");
      });

    return () => {
      removeState();
      removeEvent();
      gateway.close();
    };
  }, [onActivityChange, participants, updateEntry]);

  useEffect(() => {
    if (connection !== "open" || startedRef.current) return undefined;
    const startTimer = window.setTimeout(() => {
      if (startedRef.current) return;
      startedRef.current = true;
      runRound(1).catch((meetingError) => {
        if (closingRef.current) return;
        setError(meetingError.message);
        setPhase("error");
        setSpeaker("");
      });
    }, 0);
    return () => window.clearTimeout(startTimer);
  }, [connection, runRound]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, tools]);

  useEffect(() => {
    persistMeeting(entries, phase, round);
  }, [entries, persistMeeting, phase, round]);

  useEffect(() => {
    if (!pendingRequest?.expiresAt) return undefined;
    const expire = () => {
      setPendingRequest((current) => current?.id === pendingRequest.id && isHitlRequestExpired(current) ? null : current);
      appendMeetingSystemEntry(setEntries, pendingRequest.profile, "status.update", { text: "Hermes 사용자 입력 요청이 만료되었습니다." });
      onActivityChange?.(pendingRequest.profile, { state: "idle", text: "사용자 입력 요청 만료", collaborator: "" });
    };
    const delay = Math.max(0, Number(pendingRequest.expiresAt) - Date.now());
    if (delay === 0) expire();
    const timer = delay > 0 ? window.setTimeout(expire, delay) : 0;
    return () => { if (timer) window.clearTimeout(timer); };
  }, [onActivityChange, pendingRequest]);

  const runAdditionalRound = async () => {
    setError("");
    onMeetingReopened?.({ meetingId });
    try {
      await runRound(round + 1, entries);
    } catch (roundError) {
      if (closingRef.current) return;
      setError(roundError.message);
      setPhase("error");
    }
  };

  const requestConsoleClose = () => {
    if (phase !== "complete" && !window.confirm("진행 중인 회의를 종료하고 현재 기록을 아카이브로 이동할까요?")) return;
    closeMeeting(phase === "complete" ? "archive-now" : "manual").catch((closeError) => {
      setError(`회의 종료 중 확인이 필요합니다: ${closeError.message}`);
      closingRef.current = false;
    });
  };

  const respondToPendingRequest = async (value) => {
    if (!pendingRequest || pendingRequest.responding) return;
    if (isHitlRequestExpired(pendingRequest)) {
      setPendingRequest(null);
      return;
    }
    setPendingRequest((current) => current ? { ...current, responding: true, error: "" } : current);
    try {
      const rpc = hitlResponseRequest(pendingRequest, value);
      await gatewayRef.current.request(rpc.method, rpc.params, 30000);
      const profile = pendingRequest.profile;
      setPendingRequest(null);
      appendMeetingSystemEntry(setEntries, profile, "status.update", { text: "사용자 응답을 전달해 회의를 계속합니다." });
      onActivityChange?.(profile, {
        state: "meeting",
        text: "사용자 응답 반영 중",
        collaborator: participants.filter((name) => name !== profile).map((name) => TEAM_META[name]?.name).join(", "),
      });
    } catch (responseError) {
      setPendingRequest((current) => current ? { ...current, responding: false, error: responseError.message } : current);
    }
  };

  const summary = [...entries].reverse().find((entry) => entry.kind === "summary" && !entry.pending);

  return (
    <div className="meeting-console">
      <header className="meeting-console-header">
        <div>
          <span>LIVE AI MEETING · ROUND {round}</span>
          <h2>{meeting.topic}</h2>
          <p>{phaseLabel(phase)}</p>
        </div>
        <div className="meeting-console-actions">
          <div className="meeting-live-badge"><i className={phase} />{connection === "open" ? "LIVE" : "연결 중"}</div>
          <button type="button" className="meeting-end-button" onClick={requestConsoleClose}>{phase === "complete" ? "지금 보관" : "회의 종료"}</button>
        </div>
      </header>

      <div className="meeting-console-body">
        <aside className="meeting-participants">
          <span>참여자</span>
          {participants.map((profile) => {
            const meta = TEAM_META[profile];
            const hasSpoken = entries.some((entry) => entry.profile === profile && !entry.pending);
            return (
              <article key={profile} className={speaker === profile ? "speaking" : hasSpoken ? "spoken" : ""}>
                <b style={{ "--avatar": meta.color }}>{meta.initials}</b>
                <div><strong>{meta.name}</strong><small>{speaker === profile ? "발언 중" : hasSpoken ? "발언 완료" : "대기"}</small></div>
                <i />
              </article>
            );
          })}
          <div className="meeting-progress">
            <small>회의 진행률</small>
            <div><i style={{ width: `${Math.min(100, (entries.filter((entry) => !entry.pending).length / (participants.length + 1)) * 100)}%` }} /></div>
          </div>
        </aside>

        <main className="meeting-transcript">
          {!entries.length && <div className="meeting-waiting"><i /><strong>회의를 준비하고 있습니다</strong><span>참여 구성원의 Hermes 프로필을 연결하는 중입니다.</span></div>}
          {entries.map((entry) => {
            const meta = TEAM_META[entry.profile];
            return (
              <article key={entry.id} className={`meeting-entry ${entry.kind} ${entry.pending ? "pending" : ""}`}>
                <span style={{ "--avatar": meta.color }}>{meta.initials}</span>
                <div>
                  <header><strong>{meta.name}</strong><small>{entry.system ? "진행 이벤트" : entry.kind === "summary" ? "회의록" : meta.role} · {entry.time}</small></header>
                  <p>{entry.text || "발언을 준비하고 있습니다..."}</p>
                </div>
              </article>
            );
          })}
          {tools.some((tool) => tool.running) && (
            <div className="meeting-tool-strip">
              {tools.filter((tool) => tool.running).map((tool) => (
                <span key={tool.id}><i />{TEAM_META[tool.profile]?.name} · {tool.name} {tool.preview || tool.context}</span>
              ))}
            </div>
          )}
          <HermesPrompt key={pendingRequest?.id || "no-prompt"} request={pendingRequest} busy={Boolean(pendingRequest?.responding)} onRespond={respondToPendingRequest} />
          {error && <p className="profile-chat-error">{error}</p>}
          <div ref={bottomRef} />
        </main>

        <aside className="meeting-notes">
          <span>회의 보드</span>
          <section>
            <small>안건</small>
            <strong>{meeting.topic}</strong>
          </section>
          <section>
            <small>주담당자</small>
            <strong>{TEAM_META[chair]?.name}</strong>
          </section>
          <section className="meeting-summary-preview">
            <small>요약</small>
            <p>{summary?.text || "모든 참여자의 발언이 끝나면 최종 회의록이 표시됩니다."}</p>
          </section>
          <section className="meeting-outcome-panel">
            <small>최종 보고 담당</small>
            <strong>{outcome?.reporterName ?? TEAM_META[meeting.requestedBy ?? chair]?.name ?? TEAM_META[chair]?.name}</strong>
            <p>회의 종료 후 요청자 또는 회의 개설자가 최종 보고를 담당합니다.</p>
          </section>
          <section className="meeting-outcome-panel">
            <small>결정 사항</small>
            {(outcome?.decisions?.length ? outcome.decisions : ["회의가 완료되면 결정사항이 여기에 정리됩니다."]).map((item) => (
              <p key={item}>{item}</p>
            ))}
          </section>
          <section className="meeting-outcome-panel">
            <small>후속 업무</small>
            {(outcome?.actions?.length ? outcome.actions : []).map((action) => (
              <article key={`${action.assignee}-${action.title}`}>
                <b>{TEAM_META[action.assignee]?.name ?? action.assignee}</b>
                <span>{action.title}</span>
              </article>
            ))}
            {!outcome?.actions?.length && <p>Kanban으로 보낼 액션이 생기면 담당자별로 표시됩니다.</p>}
          </section>
          <section className="meeting-outcome-panel">
            <small>협업 요청</small>
            {(outcome?.collaborations?.length ? outcome.collaborations : []).map((item) => (
              <article key={`${item.to}-${item.title}`}>
                <b>{TEAM_META[item.to]?.name ?? item.to}</b>
                <span>{item.title}</span>
              </article>
            ))}
            {!outcome?.collaborations?.length && <p>협업 요청이 필요한 task가 생기면 여기에 표시됩니다.</p>}
          </section>
        </aside>
      </div>

      <footer className="meeting-console-footer">
        <button type="button" className="secondary-button" onClick={onExit}>오피스로 돌아가기</button>
        <span>{entries.filter((entry) => !entry.pending).length}개 회의 발언</span>
        <div className="meeting-footer-actions">
          <button type="button" className="meeting-end-button mobile" onClick={requestConsoleClose}>{phase === "complete" ? "지금 보관" : "회의 종료"}</button>
          <button type="button" className="primary-button" disabled={phase !== "complete"} onClick={runAdditionalRound}>한 라운드 더 진행</button>
        </div>
      </footer>
    </div>
  );
}
