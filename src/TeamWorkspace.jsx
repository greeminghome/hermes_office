import { useEffect, useMemo, useState } from "react";
import {
  ORGANIZATION_DEPARTMENTS,
  ORGANIZATION_ROOMS,
  addOrganizationNode,
  buildDefaultOrganizationNodes,
  moveOrganizationNode,
  organizationDescendants,
  organizationReportingContext,
  organizationVisibleNodeIds,
  removeOrganizationNode,
  validateOrganizationNodes,
} from "../organizationHierarchy.js";
import { WORKSPACE_AREAS, areaOwnerLabels, canWriteWorkspaceArea } from "./governance.js";
import { decodeHermesText, loadProfileCapabilities, loadProfileSessions } from "./hermes.js";
import { resolveProfileMeta } from "./officeData.js";

const TABS = [
  ["hierarchy", "조직도"],
  ["overview", "R&R / 현재 업무"],
  ["skills", "Skills"],
  ["tools", "Tools"],
  ["plugins", "Plugins / MCP"],
  ["permissions", "권한"],
];

const TAB_COPY = {
  overview: ["MEMBER OPERATIONS", "R&R · 현재 업무", "담당 범위와 실시간 상태, 최근 업무를 함께 확인합니다."],
  skills: ["CAPABILITY INVENTORY", "Skills", "현재 프로필이 실행할 수 있는 전문 역량입니다."],
  tools: ["RUNTIME TOOLING", "Tools", "Hermes 런타임에서 실제로 사용 가능한 도구를 확인합니다."],
  plugins: ["CONNECTED EXTENSIONS", "Plugins · MCP", "프로필에 연결된 플러그인과 MCP 서버의 현재 상태입니다."],
  permissions: ["GOVERNANCE", "권한", "자료실 쓰기, 검토 및 승인 경계를 업무 영역별로 확인합니다."],
};

const APPROVAL_RULES = [
  ["외부 공개", "게시, 발행, 고객 발송, 외부 플랫폼 반영은 담당자 확인 또는 대표 승인이 필요합니다."],
  ["비용/가격", "가격 확정, 결제, 예산, 매출 관련 변경은 대표 또는 재무 담당 검토가 필요합니다."],
  ["보안/배포", "서버 배포, API 키, 계정, 개인정보, 자동화 권한 변경은 대표 승인 후 진행합니다."],
  ["법무/계약", "약관, 계약, 법무 판단, 사고 대응은 대표 검토 영역으로 자동 전환합니다."],
];

const COLLABORATION_RULES = [
  ["검토 요청", "담당 영역 밖의 변경은 직접 쓰지 않고 담당자에게 검토 요청을 보냅니다."],
  ["작업 위임", "전문성이 필요한 일은 관련 구성원에게 작업 요청으로 넘길 수 있습니다."],
  ["회의 전환", "여러 담당자 판단이 필요한 경우 AI 회의로 전환할 수 있습니다."],
];
const TEAM_CACHE_KEY = "greeming-hermes-team-workspace";
const EMPTY_ORGANIZATION_NODES = [];

function loadTeamCache() {
  try {
    return JSON.parse(window.localStorage.getItem(TEAM_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveTeamCache(profileName, data, sessions) {
  try {
    const current = loadTeamCache();
    window.localStorage.setItem(TEAM_CACHE_KEY, JSON.stringify({
      ...current,
      [profileName]: { data, sessions, savedAt: Date.now() },
    }));
  } catch {
    // This cache only speeds up profile switching.
  }
}

function cleanText(value) {
  return decodeHermesText(value ?? "");
}

function permissionLevel(profileName, area) {
  if (canWriteWorkspaceArea(profileName, area)) return "write";
  if (area.critical) return "approval";
  return "read";
}

function permissionCopy(level) {
  return {
    write: ["쓰기 가능", "파일 추가 · 수정 · 삭제 가능"],
    approval: ["대표 승인", "중요 변경은 대표 검토 필요"],
    read: ["승인 필요", "읽기와 검토 후 담당자 요청"],
  }[level];
}

function sortNodes(nodes) {
  return [...nodes].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4h6M12 2v2M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Z" />
      <path d="M8 13h.01M16 13h.01M9 17h6" />
    </svg>
  );
}

function ProfileAvatar({ meta, className = "", online = false }) {
  return (
    <span className={`profile-avatar ${className}`} style={{ "--avatar": meta.color }}>
      {meta.avatar ? <img src={meta.avatar} alt="" /> : <AgentGlyph />}
      {className.includes("organization-avatar") && <i className={online ? "online" : ""} />}
    </span>
  );
}

function DepartmentIcon({ id }) {
  const content = {
    all: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    leadership: <><circle cx="12" cy="12" r="7" /><path d="m12 8 2 4-2 4-2-4 2-4Z" /></>,
    operations: <><path d="M7 6h12M7 12h12M7 18h12" /><path d="m3.5 6 .8.8L6 5M3.5 12l.8.8L6 11M3.5 18l.8.8L6 17" /></>,
    brand: <path d="m12 3 8 9-8 9-8-9 8-9Z" />,
    growth: <><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 2 5-6" /></>,
    content: <><path d="M6 3h9l3 3v15H6Z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
    creative: <><path d="m12 3 1.4 4.2L18 9l-4.2 1.4L12 15l-1.4-4.2L6 9l4.2-1.4L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></>,
    customer: <><path d="M5 17h-2v-5a9 9 0 0 1 18 0v5h-2" /><path d="M5 13h3v6H5ZM16 13h3v6h-3ZM16 20h-4" /></>,
    finance: <><path d="M5 20V10M10 20V5M15 20v-8M20 20V8" /><path d="M3 20h19" /></>,
    technology: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
    general: <><circle cx="12" cy="6" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="m10.8 8.2-3.6 6.6M13.2 8.2l3.6 6.6M8.5 17h7" /></>,
  }[id] ?? null;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{content}</svg>;
}

function activityLabel(activity, isOnline) {
  if (activity?.view?.url) return "라이브 브라우저";
  if (activity?.state === "working") return "작업 중";
  return isOnline ? "요청 대기" : "오프라인";
}

function formatAuditTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시간 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function HierarchyBranch({
  node,
  nodes,
  profileMap,
  activities,
  selectedId,
  draggedId,
  onSelect,
  onDragStart,
  onDragEnd,
  onDrop,
  onTouchArm,
  editing,
  visibleNodeIds,
  depth = 1,
}) {
  if (!visibleNodeIds.has(node.id)) return null;
  const profile = profileMap.get(node.id) ?? { name: node.id, description: "현재 Hermes에 로드되지 않은 프로필" };
  const meta = resolveProfileMeta(profile);
  const activity = activities[node.id] ?? {};
  const department = ORGANIZATION_DEPARTMENTS.find((item) => item.id === node.department)?.label ?? "공통";
  const room = ORGANIZATION_ROOMS.find((item) => item.id === node.roomId)?.label ?? "운영실";
  const children = sortNodes(nodes.filter((item) => item.parentId === node.id && visibleNodeIds.has(item.id)));
  const managerNode = nodes.find((item) => item.id === node.parentId);
  const managerMeta = managerNode ? resolveProfileMeta(profileMap.get(managerNode.id) ?? managerNode.id) : null;
  const isOnline = Boolean(profile.gateway_running);
  const state = activityLabel(activity, isOnline);

  return (
    <li role="none">
      <article
        className={`organization-node-card ${selectedId === node.id ? "selected" : ""} ${draggedId === node.id ? "dragging" : ""} ${editing ? "editable" : ""}`}
        draggable={editing}
        tabIndex={0}
        role="treeitem"
        aria-level={depth}
        aria-selected={selectedId === node.id}
        aria-expanded={children.length ? true : undefined}
        aria-label={`${meta.name}, ${meta.role}, ${room}. ${editing ? "선택하거나 드래그하여 보고선을 변경" : "선택하여 운영 상태 확인"}`}
        onClick={() => {
          if (editing && draggedId && draggedId !== node.id) onDrop(node.id);
          else onSelect(node.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (editing && draggedId && draggedId !== node.id) onDrop(node.id);
            else onSelect(node.id);
          }
        }}
        onDragStart={(event) => editing && onDragStart(event, node.id)}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          if (editing && draggedId && draggedId !== node.id) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (editing) onDrop(node.id);
        }}
      >
        <div className="organization-node-head">
          <ProfileAvatar meta={meta} className="organization-avatar" online={isOnline} />
          <span>
            <small>{department}</small>
            <strong>{meta.name}</strong>
            <em>{meta.role}</em>
          </span>
        </div>
        <footer>
          <span>{managerMeta ? `${managerMeta.name}에게 보고` : "최상위 보고선"}</span>
          <span>{room}</span>
          <span>직속 {children.length}명</span>
          <b className={activity.state === "working" || activity.view?.url ? "live" : isOnline ? "ready" : ""}>{state}</b>
        </footer>
      </article>
      {editing && (
        <button
          type="button"
          className={`organization-move-handle ${draggedId === node.id ? "armed" : ""}`}
          aria-label={draggedId === node.id ? `${meta.name} 이동 취소` : `${meta.name} 이동 시작`}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(node.id);
            onTouchArm(draggedId === node.id ? "" : node.id);
          }}
        >
          {draggedId === node.id ? "이동 취소" : "이동"}
        </button>
      )}
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <HierarchyBranch
              key={child.id}
              node={child}
              nodes={nodes}
              profileMap={profileMap}
              activities={activities}
              selectedId={selectedId}
              draggedId={draggedId}
              onSelect={onSelect}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
              onTouchArm={onTouchArm}
              editing={editing}
              visibleNodeIds={visibleNodeIds}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function OrganizationHierarchy({ profiles, activities, missions, organization, status, error, onSave, onChat, onOpenOffice, activeProfileId, onSelectProfile }) {
  const persistedNodes = organization?.nodes ?? EMPTY_ORGANIZATION_NODES;
  const [draftNodes, setDraftNodes] = useState(EMPTY_ORGANIZATION_NODES);
  const [editing, setEditing] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState("all");
  const nodes = editing ? draftNodes : persistedNodes;
  const [draggedId, setDraggedId] = useState("");
  const [addProfileId, setAddProfileId] = useState("");
  const [localError, setLocalError] = useState("");
  const [editingBaseRevision, setEditingBaseRevision] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [treeScale, setTreeScale] = useState(1);
  const profileMap = useMemo(() => new Map(profiles.map((profile) => [profile.name, profile])), [profiles]);
  const roots = useMemo(() => sortNodes(nodes.filter((node) => node.parentId === null)), [nodes]);
  const visibleNodeIds = useMemo(() => organizationVisibleNodeIds(nodes, selectedDepartment), [nodes, selectedDepartment]);
  const unassigned = profiles.filter((profile) => !nodes.some((node) => node.id === profile.name));
  const effectiveSelectedId = nodes.some((node) => node.id === activeProfileId) ? activeProfileId : roots[0]?.id ?? "";
  const effectiveAddProfileId = unassigned.some((profile) => profile.name === addProfileId)
    ? addProfileId
    : unassigned[0]?.name ?? "";
  const selectedNode = nodes.find((node) => node.id === effectiveSelectedId) ?? null;
  const selectedProfile = selectedNode ? profileMap.get(selectedNode.id) ?? { name: selectedNode.id } : null;
  const selectedMeta = selectedProfile ? resolveProfileMeta(selectedProfile) : null;
  const blockedParents = selectedNode ? organizationDescendants(nodes, selectedNode.id) : new Set();
  const busy = status === "saving" || status === "loading";
  const revisionConflict = editing && editingBaseRevision != null && organization?.revision !== editingBaseRevision;
  const departmentRows = ORGANIZATION_DEPARTMENTS
    .map((department) => ({
      ...department,
      count: nodes.filter((node) => node.department === department.id).length,
      working: nodes.filter((node) => node.department === department.id && activities[node.id]?.state === "working").length,
    }))
    .filter((department) => department.count > 0);
  const selectedMissions = selectedNode ? (missions ?? []).filter((mission) => mission.owner === selectedNode.id) : [];
  const selectedActivity = selectedNode ? activities[selectedNode.id] ?? {} : {};
  const selectedRoom = selectedNode ? ORGANIZATION_ROOMS.find((room) => room.id === selectedNode.roomId) : null;
  const selectedDepartmentMeta = selectedNode ? ORGANIZATION_DEPARTMENTS.find((department) => department.id === selectedNode.department) : null;
  const reporting = selectedNode
    ? organizationReportingContext(nodes, selectedNode.id)
    : { managerId: null, directReportIds: [], escalationPathIds: [], depth: 0 };
  const managerMeta = reporting.managerId ? resolveProfileMeta(profileMap.get(reporting.managerId) ?? reporting.managerId) : null;
  const directReportMetas = reporting.directReportIds.map((id) => ({ id, ...resolveProfileMeta(profileMap.get(id) ?? id) }));
  const escalationMetas = reporting.escalationPathIds.map((id) => ({ id, ...resolveProfileMeta(profileMap.get(id) ?? id) }));
  const selectedPermissions = selectedNode ? WORKSPACE_AREAS.map((area) => ({ ...area, level: permissionLevel(selectedNode.id, area) })) : [];
  const directWriteAreas = selectedPermissions.filter((area) => area.level === "write");
  const representativeApprovalAreas = selectedPermissions.filter((area) => area.level === "approval");
  const reviewAreas = selectedPermissions.filter((area) => area.level === "read");
  const recentAudits = Array.isArray(organization?.audit) ? [...organization.audit].slice(-3).reverse() : [];
  const changedCount = editing ? nodes.filter((node) => {
    const current = persistedNodes.find((item) => item.id === node.id);
    return !current || current.parentId !== node.parentId || current.department !== node.department || current.roomId !== node.roomId;
  }).length + persistedNodes.filter((node) => !nodes.some((item) => item.id === node.id)).length : 0;

  const selectNode = (id) => {
    onSelectProfile?.(id);
    setInspectorOpen(true);
  };

  const commit = async (nextNodes) => {
    setLocalError("");
    try {
      const validated = validateOrganizationNodes(nextNodes);
      if (editing) {
        setDraftNodes(validated);
      } else {
        await onSave(validated);
      }
      return true;
    } catch (saveError) {
      setLocalError(saveError?.message || "조직 구조를 저장하지 못했습니다.");
      return false;
    }
  };

  const move = async (id, parentId) => {
    if (!editing || !id || id === parentId) return;
    try {
      const next = moveOrganizationNode(nodes, id, parentId || null);
      if (await commit(next)) selectNode(id);
    } catch (moveError) {
      setLocalError(moveError?.message || "보고선을 변경하지 못했습니다.");
    } finally {
      setDraggedId("");
    }
  };

  const updateSelected = (changes) => {
    if (!editing || !selectedNode) return;
    commit(nodes.map((node) => node.id === selectedNode.id ? { ...node, ...changes } : node));
  };

  const addMember = async () => {
    if (!editing || !effectiveAddProfileId) return;
    try {
      const next = addOrganizationNode(nodes, effectiveAddProfileId, {
        parentId: selectedNode?.id ?? roots[0]?.id ?? null,
        department: selectedNode?.department ?? "general",
        roomId: selectedNode?.roomId ?? "operations",
      });
      if (await commit(next)) selectNode(effectiveAddProfileId);
    } catch (addError) {
      setLocalError(addError?.message || "구성원을 추가하지 못했습니다.");
    }
  };

  const removeMember = async () => {
    if (!editing || !selectedNode || !window.confirm(`${selectedMeta?.name ?? selectedNode.id}을 조직도에서 제외할까요? Hermes 프로필 자체는 삭제되지 않습니다.`)) return;
    const next = removeOrganizationNode(nodes, selectedNode.id);
    if (await commit(next)) selectNode(next.find((node) => node.parentId === null)?.id ?? profiles[0]?.name ?? "");
  };

  const resetStructure = async () => {
    if (!editing || !window.confirm("현재 보고선과 룸 배치를 Hermes 기본 구조로 되돌릴까요?")) return;
    const next = buildDefaultOrganizationNodes(profiles);
    if (await commit(next)) selectNode(next.find((node) => node.parentId === null)?.id ?? profiles[0]?.name ?? "");
  };

  const startEditing = () => {
    setDraftNodes(persistedNodes.map((node) => ({ ...node })));
    setEditingBaseRevision(organization?.revision ?? 0);
    setEditing(true);
    setInspectorOpen(true);
    setLocalError("");
  };

  const cancelEditing = () => {
    setDraftNodes(EMPTY_ORGANIZATION_NODES);
    setEditing(false);
    setDraggedId("");
    setEditingBaseRevision(null);
    setLocalError("");
  };

  const saveDraft = async () => {
    setLocalError("");
    if (revisionConflict) {
      setLocalError("편집 중 서버의 조직도가 변경되었습니다. 최신 구조를 불러온 뒤 변경사항을 다시 적용해주세요.");
      return;
    }
    try {
      await onSave(validateOrganizationNodes(draftNodes));
      setEditing(false);
      setDraftNodes(EMPTY_ORGANIZATION_NODES);
      setEditingBaseRevision(null);
    } catch (saveError) {
      setLocalError(saveError?.message || "조직 구조를 저장하지 못했습니다.");
    }
  };

  return (
    <div className={`organization-hierarchy ${editing ? "editing" : "viewing"}`}>
      <header className="organization-toolbar">
        <div className="organization-toolbar-copy">
          <small>OPERATING REPORTING LINE</small>
          <h4>보고 체계</h4>
          <p>{editing
            ? "카드를 상급자에게 옮겨 운영 보고선과 오피스 배치를 조정하세요. 저장 전에는 반영되지 않습니다."
            : "상급자·직속 보고자·권한 경계를 확인합니다. 이 구조는 오피스 운영용이며 Hermes 실행 라우팅은 프로필 설정에서 별도로 관리됩니다."}</p>
        </div>
        <div className="organization-toolbar-right">
          <div className="organization-metrics" aria-label="조직 현황">
            <span><small>구성원</small><strong>{nodes.length}</strong></span>
            <span><small>부서</small><strong>{departmentRows.length}</strong></span>
            <span><small>REV.</small><strong>{organization?.revision ?? 0}</strong></span>
          </div>
          <div className="organization-edit-actions">
            {editing ? (
              <>
                <span className={changedCount ? "changed" : ""}>{changedCount ? `${changedCount}개 변경됨` : "변경 없음"}</span>
                <button type="button" className="secondary" disabled={busy} onClick={cancelEditing}>취소</button>
                <button type="button" className="primary" disabled={busy || !changedCount} onClick={saveDraft}>{status === "saving" ? "저장 중" : "변경사항 저장"}</button>
              </>
            ) : (
              <button type="button" className="primary" disabled={busy} onClick={startEditing}>구조 편집</button>
            )}
          </div>
        </div>
      </header>

      {(error || localError || revisionConflict) && (
        <div className="organization-error" role="alert">
          <span>{localError || (revisionConflict ? "편집 중 서버의 조직도가 변경되었습니다. 오래된 초안을 저장하지 않도록 차단했습니다." : error)}</span>
          {revisionConflict && <button type="button" onClick={startEditing}>최신 구조로 편집 다시 시작</button>}
        </div>
      )}

      <div className={`organization-layout ${inspectorOpen ? "inspector-open" : ""}`}>
        <section className="organization-canvas" aria-label={editing ? "드래그 가능한 AI 조직도" : "AI 조직 보고 체계"}>
          <nav className="organization-departments" aria-label="부서별 조직도 필터">
            <button type="button" className={selectedDepartment === "all" ? "active" : ""} aria-pressed={selectedDepartment === "all"} onClick={() => setSelectedDepartment("all")}>
              <span className="organization-department-icon"><DepartmentIcon id="all" /></span>
              <span><strong>전체</strong><small>보고선 전체</small></span>
              <b>{nodes.length}</b>
            </button>
            {departmentRows.map((department) => (
              <button type="button" key={department.id} className={selectedDepartment === department.id ? "active" : ""} aria-pressed={selectedDepartment === department.id} onClick={() => setSelectedDepartment(department.id)}>
                <span className="organization-department-icon"><DepartmentIcon id={department.id} /></span>
                <span><strong>{department.label}</strong><small>{department.working ? `${department.working}명 작업 중` : "보고선 보기"}</small></span>
                <b>{department.count}</b>
              </button>
            ))}
          </nav>
          <div className="organization-canvas-guide">
            <span><i /> {editing ? "드래그하여 상급자 변경" : "실시간 Hermes 운영 상태"}</span>
            <span>{selectedDepartment === "all" ? `${profiles.filter((profile) => profile.gateway_running).length}명 온라인` : "상위 보고선도 함께 표시"}</span>
            <b className={status === "error" || error ? "error" : status}>{status === "saving" ? "저장 중" : status === "loading" ? "불러오는 중" : status === "error" || error ? "동기화 오류" : editing ? "편집 중" : "서버 동기화"}</b>
            <div className="organization-view-controls" aria-label="조직도 보기 설정">
              <button type="button" aria-label="조직도 축소" disabled={treeScale <= 0.8} onClick={() => setTreeScale((current) => Math.max(0.8, Number((current - 0.1).toFixed(1))))}>−</button>
              <button type="button" className="organization-scale" aria-label="조직도 배율 초기화" onClick={() => setTreeScale(1)}>{Math.round(treeScale * 100)}%</button>
              <button type="button" aria-label="조직도 확대" disabled={treeScale >= 1.2} onClick={() => setTreeScale((current) => Math.min(1.2, Number((current + 0.1).toFixed(1))))}>+</button>
              <button type="button" className="organization-open-inspector" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen((current) => !current)}>{selectedMeta?.name ?? "구성원"} 상세</button>
            </div>
            {editing && draggedId && <button type="button" className="organization-cancel-move" onClick={() => setDraggedId("")}>이동 취소</button>}
          </div>
          {editing && (
            <button
              type="button"
              className={`organization-root-drop ${draggedId ? "active" : ""}`}
              disabled={!draggedId}
              onClick={() => draggedId && move(draggedId, null)}
              onDragOver={(event) => draggedId && event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedId) move(draggedId, null);
              }}
            >
              여기로 놓으면 최상위 보고선으로 이동
            </button>
          )}
          {roots.length ? (
            <div className="organization-tree-scroll">
              <ul className="organization-tree" role="tree" aria-label="운영 보고 체계" style={{ zoom: treeScale }}>
                {roots.map((root) => (
                  <HierarchyBranch
                    key={root.id}
                    node={root}
                    nodes={nodes}
                    profileMap={profileMap}
                    activities={activities}
                    selectedId={effectiveSelectedId}
                    draggedId={draggedId}
                    onSelect={selectNode}
                    onDragStart={(event, id) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", id);
                      setDraggedId(id);
                    }}
                    onDragEnd={() => setDraggedId("")}
                    onDrop={(parentId) => draggedId && move(draggedId, parentId)}
                    onTouchArm={setDraggedId}
                    editing={editing}
                    visibleNodeIds={visibleNodeIds}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <div className="organization-empty">
              <strong>조직 구조가 비어 있습니다.</strong>
              <p>편집 모드에서 Hermes 프로필을 추가하거나 기본 구조를 복원하세요.</p>
            </div>
          )}
        </section>

        {inspectorOpen && <aside className="organization-inspector">
          <div className="organization-inspector-heading">
            {selectedMeta && <ProfileAvatar meta={selectedMeta} className="organization-inspector-avatar" online={Boolean(selectedProfile?.gateway_running)} />}
            <div>
              <small>{editing ? "STRUCTURE EDITOR" : "MEMBER BRIEF"}</small>
              <strong>{selectedMeta ? selectedMeta.name : "구성원을 선택하세요"}</strong>
              <p>{selectedMeta ? selectedMeta.role : "조직도에서 구성원을 선택하면 보고선과 운영 범위를 확인할 수 있습니다."}</p>
            </div>
            <button type="button" className="organization-inspector-close" aria-label="구성원 상세 닫기" onClick={() => setInspectorOpen(false)}>×</button>
          </div>

          {editing ? (
            <>
              {selectedNode && (
                <div className="organization-fields">
                  <label>
                    <span>상급 보고선</span>
                    <select value={selectedNode.parentId ?? ""} disabled={busy} onChange={(event) => move(selectedNode.id, event.target.value || null)}>
                      <option value="">최상위</option>
                      {sortNodes(nodes).filter((node) => node.id !== selectedNode.id && !blockedParents.has(node.id)).map((node) => (
                        <option key={node.id} value={node.id}>{resolveProfileMeta(profileMap.get(node.id) ?? node.id).name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>담당 부서</span>
                    <select value={selectedNode.department} disabled={busy} onChange={(event) => updateSelected({ department: event.target.value })}>
                      {ORGANIZATION_DEPARTMENTS.map((department) => <option key={department.id} value={department.id}>{department.label}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>오피스 룸</span>
                    <select value={selectedNode.roomId} disabled={busy} onChange={(event) => updateSelected({ roomId: event.target.value })}>
                      {ORGANIZATION_ROOMS.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}
                    </select>
                    <small>저장하면 오피스맵의 실제 좌석 위치에도 반영됩니다.</small>
                  </label>
                  <button type="button" className="organization-remove-member" disabled={busy} onClick={removeMember}>조직도에서 제외</button>
                </div>
              )}
              <div className="organization-add-member">
                <span>구성원 추가</span>
                <select value={effectiveAddProfileId} disabled={busy || !unassigned.length} onChange={(event) => setAddProfileId(event.target.value)}>
                  {unassigned.length
                    ? unassigned.map((item) => <option key={item.name} value={item.name}>{resolveProfileMeta(item).name} · {item.name}</option>)
                    : <option value="">모든 프로필이 배치됨</option>}
                </select>
                <button type="button" disabled={busy || !effectiveAddProfileId} onClick={addMember}>{selectedNode ? "선택한 구성원 아래 추가" : "조직도에 추가"}</button>
              </div>
              <button type="button" className="organization-reset" disabled={busy} onClick={resetStructure}>Hermes 기본 구조로 복원</button>
              <div className="organization-hermes-note">
                <strong>안전한 편집</strong>
                <p>드래그와 설정 변경은 임시안에만 반영됩니다. 상단의 변경사항 저장을 눌러야 보고선과 오피스 룸이 함께 적용됩니다.</p>
              </div>
            </>
          ) : selectedNode ? (
            <div className="organization-live-panel">
              <div className="organization-live-state">
                <span className={selectedProfile?.gateway_running ? "online" : ""}><i />{selectedProfile?.gateway_running ? "온라인" : "오프라인"}</span>
                <b>{activityLabel(selectedActivity, Boolean(selectedProfile?.gateway_running))}</b>
              </div>
              <div className="organization-source-note">
                <DepartmentIcon id={selectedNode.department} />
                <p><strong>오피스 운영 보고선</strong><span>Hermes 실행 라우팅·도구 권한은 프로필 설정에서 별도로 관리됩니다.</span></p>
              </div>
              <section className="organization-reporting-panel">
                <small>REPORTING LINE</small>
                <div className="organization-reporting-facts">
                  <span><small>직속 상급자</small><strong>{managerMeta?.name ?? "최상위"}</strong></span>
                  <span><small>직속 보고자</small><strong>{directReportMetas.length}명</strong></span>
                  <span><small>조직 깊이</small><strong>{reporting.depth + 1}단계</strong></span>
                </div>
                <div className="organization-reporting-path" aria-label="대표까지의 전체 보고 경로">
                  {escalationMetas.map((item, index) => (
                    <button type="button" key={item.id} className={item.id === selectedNode.id ? "current" : ""} onClick={() => selectNode(item.id)}>
                      {item.name}{index < escalationMetas.length - 1 && <span aria-hidden="true">›</span>}
                    </button>
                  ))}
                </div>
                <div className="organization-direct-reports">
                  <span>직속 보고자</span>
                  <div>
                    {directReportMetas.map((item) => <button type="button" key={item.id} onClick={() => selectNode(item.id)}>{item.name}</button>)}
                    {!directReportMetas.length && <small>배정된 직속 보고자가 없습니다.</small>}
                  </div>
                </div>
              </section>
              <div className="organization-live-facts">
                <span><small>부서</small><strong>{selectedDepartmentMeta?.label ?? "공통"}</strong></span>
                <span><small>오피스</small><strong>{selectedRoom?.label ?? "운영실"}</strong></span>
                <span><small>업무</small><strong>{selectedMissions.length}건</strong></span>
              </div>
              <section className="organization-current-work">
                <small>CURRENT WORK</small>
                <strong>{cleanText(selectedActivity.text || selectedMissions[0]?.title || "새 요청 대기 중")}</strong>
                <p>{selectedActivity.collaborator ? `${selectedActivity.collaborator}와 협업 중` : "현재 별도 협업 요청은 없습니다."}</p>
              </section>
              <section className="organization-authority-panel">
                <small>WORKSPACE AUTHORITY</small>
                <div>
                  <span className="write"><b>{directWriteAreas.length}</b> 직접 편집</span>
                  <span className="approval"><b>{representativeApprovalAreas.length}</b> 대표 승인</span>
                  <span><b>{reviewAreas.length}</b> 검토 요청</span>
                </div>
                <p>{directWriteAreas.length ? directWriteAreas.map((area) => area.label).join(" · ") : "직접 편집 가능한 자료실 영역이 없습니다."}</p>
              </section>
              <section className="organization-profile-scope">
                <small>HERMES PROFILE SCOPE</small>
                <strong>{selectedProfile?.description || `${selectedMeta.name}의 Hermes 프로필 책임 범위가 아직 입력되지 않았습니다.`}</strong>
                <p>Profile ID · {selectedNode.id}<br />Model · {selectedProfile?.model ?? "기본 모델"}</p>
              </section>
              <section className="organization-assignments">
                <small>ASSIGNED WORK</small>
                {selectedMissions.slice(0, 3).map((mission) => (
                  <article key={mission.id ?? mission.title}>
                    <strong>{cleanText(mission.title || "진행 중 업무")}</strong>
                    <span>{mission.progress != null && Number.isFinite(Number(mission.progress)) ? `${mission.progress}%` : mission.status ?? "진행 중"}</span>
                  </article>
                ))}
                {!selectedMissions.length && <p>현재 배정된 업무가 없습니다.</p>}
              </section>
              <section className="organization-audit-list">
                <small>RECENT STRUCTURE CHANGES</small>
                {recentAudits.map((entry, index) => (
                  <article key={`${entry.at ?? "audit"}-${index}`}>
                    <strong>{entry.actor ?? "system"}</strong>
                    <span>{entry.action ?? `revision ${entry.revision ?? "-"}`} · {formatAuditTime(entry.at)}</span>
                  </article>
                ))}
                {!recentAudits.length && <p>아직 저장된 조직 변경 이력이 없습니다.</p>}
              </section>
              <div className="organization-inspector-actions">
                <button type="button" className="primary" onClick={() => onChat(selectedNode.id)}>대화 시작</button>
                <button type="button" onClick={onOpenOffice}>오피스에서 보기</button>
              </div>
            </div>
          ) : null}
        </aside>}
      </div>
    </div>
  );
}

export default function TeamWorkspace({
  profiles,
  activities,
  missions = [],
  onChat,
  onOpenOffice = () => {},
  organization = { version: 1, revision: 0, nodes: [], audit: [] },
  organizationStatus = "loading",
  organizationError = "",
  onSaveOrganization = async () => {},
}) {
  const [teamCache] = useState(() => loadTeamCache());
  const [active, setActive] = useState(profiles[0]?.name ?? "default");
  const [tab, setTab] = useState("hierarchy");
  const [data, setData] = useState(() => teamCache[profiles[0]?.name ?? "default"]?.data ?? { skills: [], toolsets: [], plugins: [], mcp: [], cron: [] });
  const [sessions, setSessions] = useState(() => teamCache[profiles[0]?.name ?? "default"]?.sessions ?? []);
  const [loadedName, setLoadedName] = useState(() => teamCache[profiles[0]?.name ?? "default"] ? (profiles[0]?.name ?? "default") : "");
  const activeName = profiles.some((item) => item.name === active) ? active : profiles[0]?.name ?? "default";
  const profile = profiles.find((item) => item.name === activeName) ?? profiles[0];
  const meta = resolveProfileMeta(profile ?? activeName);
  const activity = activities[activeName] ?? { state: "online", text: "대기 중", collaborator: "" };

  const loading = loadedName !== activeName;

  useEffect(() => {
    if (!activeName) return undefined;
    let ignore = false;
    const cached = teamCache[activeName];
    if (cached && Date.now() - Number(cached.savedAt ?? 0) < 10 * 60 * 1000) {
      window.setTimeout(() => {
        if (ignore) return;
        setData(cached.data);
        setSessions(cached.sessions);
        setLoadedName(activeName);
      }, 0);
    }
    Promise.all([loadProfileCapabilities(activeName), loadProfileSessions(activeName, 6)])
      .then(([capabilities, recent]) => {
        if (ignore) return;
        setData(capabilities);
        setSessions(recent);
        setLoadedName(activeName);
        saveTeamCache(activeName, capabilities, recent);
      })
      .catch(() => {
        if (!ignore) setLoadedName(activeName);
      });
    return () => {
      ignore = true;
    };
  }, [activeName, teamCache]);

  const enabledTools = useMemo(
    () => data.toolsets.filter((tool) => tool.enabled && tool.available),
    [data.toolsets],
  );
  const pluginEntries = useMemo(() => {
    if (Array.isArray(data.plugins)) return data.plugins;
    if (!data.plugins || typeof data.plugins !== "object") return [];
    return Object.entries(data.plugins).map(([name, value]) => (
      value && typeof value === "object" ? { name, ...value } : { name, status: String(value ?? "configured") }
    ));
  }, [data.plugins]);
  const permissionAreas = useMemo(
    () => WORKSPACE_AREAS.map((area) => ({ ...area, level: permissionLevel(activeName, area) })),
    [activeName],
  );
  const writableAreas = permissionAreas.filter((area) => area.level === "write");
  const approvalAreas = permissionAreas.filter((area) => area.level === "approval");
  const requestAreas = permissionAreas.filter((area) => area.level === "read");
  const onlineCount = profiles.filter((item) => item.gateway_running).length;
  const activeMissionCount = missions.filter((mission) => mission.status !== "done").length;

  return (
    <div className="team-workspace">
      <header className="team-workspace-header">
        <div>
          <small>AI ORGANIZATION</small>
          <h2>팀 운영 구조</h2>
          <p>보고선, 역할, 현재 업무와 실행 역량을 한 화면에서 관리합니다.</p>
        </div>
        <dl>
          <div><dt>ONLINE</dt><dd>{onlineCount}/{profiles.length}</dd></div>
          <div><dt>ACTIVE WORK</dt><dd>{activeMissionCount}</dd></div>
          <div><dt>SYNC</dt><dd className={organizationStatus === "ready" ? "online" : ""}>{organizationStatus === "ready" ? "LIVE" : organizationStatus.toUpperCase()}</dd></div>
        </dl>
      </header>
      <aside className="team-roster" aria-label="AI 구성원">
        <header className="team-roster-heading">
          <span>AI TEAM</span>
          <strong>구성원</strong>
          <small>{onlineCount}/{profiles.length} 온라인</small>
        </header>
        {profiles.map((item) => {
          const member = resolveProfileMeta(item);
          return (
            <button type="button" key={item.name} className={activeName === item.name ? "active" : ""} onClick={() => setActive(item.name)}>
              <ProfileAvatar meta={member} />
              <div><strong>{member.name}</strong><small>{member.role}</small></div>
              <i className={item.gateway_running ? "online" : ""} />
            </button>
          );
        })}
      </aside>
      <section>
        <header className="team-profile-hero">
          <ProfileAvatar meta={meta} />
          <div><small>{activeName}</small><h3>{meta.name}</h3><p>{meta.role}</p></div>
          <b className={`team-profile-state ${profile?.gateway_running ? "online" : ""}`}><i />{profile?.gateway_running ? "ONLINE" : "OFFLINE"}</b>
          <button type="button" onClick={() => onChat(activeName)}>대화 시작</button>
        </header>
        <nav className="team-tabs" role="tablist" aria-label="AI 조직 구성원 정보">
          {TABS.map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} aria-controls={`team-panel-${id}`} key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        {tab === "hierarchy" ? (
          <div id="team-panel-hierarchy" role="tabpanel" className="team-hierarchy-panel">
            <OrganizationHierarchy
              profiles={profiles}
              activities={activities}
              missions={missions}
              organization={organization}
              status={organizationStatus}
              error={organizationError}
              onSave={onSaveOrganization}
              onChat={onChat}
              onOpenOffice={onOpenOffice}
              activeProfileId={activeName}
              onSelectProfile={setActive}
            />
          </div>
        ) : loading ? <div className="module-loading"><i /><span>프로필 역량을 확인하는 중입니다.</span></div> : (
          <div id={`team-panel-${tab}`} role="tabpanel" className="team-detail">
            {TAB_COPY[tab] && (
              <header className="team-detail-heading">
                <div><span>{TAB_COPY[tab][0]}</span><h4>{TAB_COPY[tab][1]}</h4></div>
                <p>{TAB_COPY[tab][2]}</p>
              </header>
            )}
            {tab === "overview" && (
              <>
                <div className="team-status-grid">
                  <article><small>현재 상태</small><strong>{activity.text}</strong><span>{activity.state}</span></article>
                  <article><small>작업 대상</small><strong>{activity.collaborator || "없음"}</strong><span>LIVE ACTIVITY</span></article>
                  <article><small>모델</small><strong>{profile?.model ?? "기본 모델"}</strong><span>{profile?.gateway_running ? "GATEWAY ONLINE" : "GATEWAY OFFLINE"}</span></article>
                </div>
                <div className="role-card">
                  <span>ROLE & RESPONSIBILITY</span>
                  <h4>{meta.role}</h4>
                  <p>{profile?.description || `${meta.name}은 ${meta.role} 영역의 담당자입니다. 전문 영역 밖의 판단이 필요하면 관련 구성원에게 작업 또는 검토를 요청합니다.`}</p>
                </div>
                <div className="recent-work">
                  <span>RECENT WORK</span>
                  {sessions.map((session) => (
                    <article key={session.id}>
                      <strong>{cleanText(session.title || session.preview)?.slice(0, 90) || "제목 없는 업무"}</strong>
                      <small>{session.message_count}개 메시지</small>
                    </article>
                  ))}
                  {!sessions.length && <p className="empty-state">최근 기록이 없습니다.</p>}
                </div>
              </>
            )}
            {tab === "skills" && <div className="capability-grid">{data.skills.map((skill) => <article key={skill.name}><span>{skill.category || "skill"}</span><strong>{skill.name}</strong><p>{skill.description}</p></article>)}{!data.skills.length && <p className="empty-state">등록된 Skill이 없습니다.</p>}</div>}
            {tab === "tools" && <div className="capability-grid">{enabledTools.map((tool) => <article key={tool.name}><span>{tool.configured ? "CONFIGURED" : "NOT CONFIGURED"}</span><strong>{tool.label}</strong><p>{tool.description}</p><small>{tool.tools?.join(", ")}</small></article>)}{!enabledTools.length && <p className="empty-state">사용 가능한 Tool이 없습니다.</p>}</div>}
            {tab === "plugins" && <div className="capability-sections"><section><div className="capability-section-heading"><span>PLUGINS</span><b>{pluginEntries.length}</b></div>{pluginEntries.map((plugin) => <article key={plugin.name ?? JSON.stringify(plugin)}><div><strong>{plugin.name ?? plugin.id ?? "Plugin"}</strong><p>{plugin.description ?? plugin.summary ?? "Hermes 프로필 확장"}</p></div><small>{plugin.status ?? (plugin.enabled === false ? "disabled" : "configured")}</small></article>)}{!pluginEntries.length && <p className="empty-state">연결된 플러그인이 없습니다.</p>}</section><section><div className="capability-section-heading"><span>MCP SERVERS</span><b>{data.mcp.length}</b></div>{data.mcp.map((server) => <article key={server.name ?? JSON.stringify(server)}><div><strong>{server.name ?? "MCP server"}</strong><p>{server.description ?? server.transport ?? "MCP connection"}</p></div><small>{server.status ?? server.transport ?? "configured"}</small></article>)}{!data.mcp.length && <p className="empty-state">연결된 MCP 서버가 없습니다.</p>}</section></div>}
            {tab === "permissions" && (
              <div className="permissions-panel">
                <section className="permission-summary">
                  <article>
                    <small>쓰기 가능</small>
                    <strong>{writableAreas.length}</strong>
                    <span>{writableAreas.map((area) => area.id).join(" · ") || "없음"}</span>
                  </article>
                  <article>
                    <small>승인 필요</small>
                    <strong>{requestAreas.length + approvalAreas.length}</strong>
                    <span>담당자 또는 대표 승인 후 변경</span>
                  </article>
                  <article>
                    <small>위험 변경</small>
                    <strong>대표 검토</strong>
                    <span>법무 · 비용 · 배포 · 보안</span>
                  </article>
                </section>

                <section className="permission-section">
                  <div className="permission-section-title">
                    <span>WORKSPACE ACCESS</span>
                    <h4>자료실 영역 권한</h4>
                  </div>
                  <div className="permission-area-grid">
                    {permissionAreas.map((area) => {
                      const [label, detail] = permissionCopy(area.level);
                      return (
                        <article key={area.id} className={`permission-area ${area.level}`}>
                          <div>
                            <strong>{area.id}</strong>
                            <b>{area.label}</b>
                          </div>
                          <span>{label}</span>
                          <small>{detail}</small>
                          <p>담당: {areaOwnerLabels(area)}</p>
                        </article>
                      );
                    })}
                  </div>
                </section>

                <section className="permission-section">
                  <div className="permission-section-title">
                    <span>APPROVAL BOUNDARY</span>
                    <h4>승인 경계</h4>
                  </div>
                  <div className="permission-rule-list">
                    {APPROVAL_RULES.map(([title, description]) => (
                      <article key={title}>
                        <strong>{title}</strong>
                        <p>{description}</p>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="permission-section">
                  <div className="permission-section-title">
                    <span>COLLABORATION</span>
                    <h4>협업 가능 범위</h4>
                  </div>
                  <div className="permission-rule-list compact">
                    {COLLABORATION_RULES.map(([title, description]) => (
                      <article key={title}>
                        <strong>{title}</strong>
                        <p>{description}</p>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
