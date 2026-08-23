import { toUiProfileId } from "./src/profileIds.js";

export const ORGANIZATION_VERSION = 1;
export const ORGANIZATION_MAX_NODES = 100;

export const ORGANIZATION_DEPARTMENTS = [
  { id: "leadership", label: "리더십" },
  { id: "operations", label: "운영" },
  { id: "brand", label: "브랜드" },
  { id: "growth", label: "마케팅 · 성장" },
  { id: "content", label: "콘텐츠" },
  { id: "creative", label: "크리에이티브" },
  { id: "customer", label: "고객 경험" },
  { id: "finance", label: "재무" },
  { id: "technology", label: "기술" },
  { id: "general", label: "공통" },
];

export const ORGANIZATION_ROOMS = [
  { id: "executive", label: "대표실" },
  { id: "operations", label: "운영실" },
  { id: "brand", label: "브랜드룸" },
  { id: "content", label: "콘텐츠룸" },
  { id: "creative", label: "크리에이티브룸" },
  { id: "customer", label: "고객 데스크" },
  { id: "tech", label: "기술실" },
  { id: "finance", label: "재무실" },
];

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const departmentIds = new Set(ORGANIZATION_DEPARTMENTS.map((item) => item.id));
const roomIds = new Set(ORGANIZATION_ROOMS.map((item) => item.id));

function profileId(profile) {
  return toUiProfileId(String(typeof profile === "string" ? profile : profile?.name ?? profile?.id ?? "").trim());
}

function defaultMetadata(id) {
  const presets = {
    default: { parentId: null, department: "leadership", roomId: "executive", order: 0 },
    "greeming-seoyun": { parentId: "default", department: "operations", roomId: "operations", order: 0 },
    "greeming-jaehyun": { parentId: "default", department: "technology", roomId: "tech", order: 1 },
    "greeming-jian": { parentId: "greeming-seoyun", department: "brand", roomId: "brand", order: 0 },
    "greeming-taeo": { parentId: "greeming-seoyun", department: "growth", roomId: "content", order: 1 },
    "greeming-yuna": { parentId: "greeming-seoyun", department: "customer", roomId: "customer", order: 2 },
    "greeming-junseo": { parentId: "greeming-seoyun", department: "finance", roomId: "finance", order: 3 },
    "greeming-doyun": { parentId: "greeming-jian", department: "creative", roomId: "creative", order: 0 },
    "greeming-harin": { parentId: "greeming-taeo", department: "content", roomId: "content", order: 0 },
  };
  return presets[id] ?? { parentId: "default", department: "general", roomId: "operations", order: 99 };
}

export function buildDefaultOrganizationNodes(profiles = []) {
  const ids = [...new Set(profiles.map(profileId).filter(Boolean))];
  if (!ids.length) return [];
  const rootId = ids.includes("default") ? "default" : ids[0];
  return ids.map((id, index) => {
    const preset = defaultMetadata(id);
    const configuredParent = preset.parentId && ids.includes(preset.parentId) ? preset.parentId : rootId;
    return {
      id,
      parentId: id === rootId ? null : (configuredParent === id ? rootId : configuredParent),
      department: preset.department,
      roomId: preset.roomId,
      order: preset.order === 99 ? index : preset.order,
    };
  });
}

function canonicalNode(raw, index) {
  const id = String(raw?.id ?? "").trim();
  if (!PROFILE_ID_PATTERN.test(id)) throw new Error(`Invalid Hermes profile id at node ${index}.`);
  const parentId = raw?.parentId == null || raw.parentId === "" ? null : String(raw.parentId).trim();
  if (parentId !== null && !PROFILE_ID_PATTERN.test(parentId)) throw new Error(`Invalid parent profile id for ${id}.`);
  const department = departmentIds.has(raw?.department) ? raw.department : "general";
  const roomId = roomIds.has(raw?.roomId) ? raw.roomId : "operations";
  const order = Number.isInteger(raw?.order) ? Math.max(0, Math.min(999, raw.order)) : index;
  return { id, parentId, department, roomId, order };
}

export function validateOrganizationNodes(nodes, { allowEmpty = true } = {}) {
  if (!Array.isArray(nodes)) throw new Error("Organization nodes must be an array.");
  if (!allowEmpty && nodes.length === 0) throw new Error("Organization must contain at least one profile.");
  if (nodes.length > ORGANIZATION_MAX_NODES) throw new Error(`Organization supports up to ${ORGANIZATION_MAX_NODES} profiles.`);
  const parsed = nodes.map((raw, index) => ({ node: canonicalNode(raw, index), sourceId: String(raw?.id ?? "").trim() }));
  const exactIds = new Set();
  for (const { sourceId } of parsed) {
    if (exactIds.has(sourceId)) throw new Error(`Duplicate organization profile: ${sourceId}`);
    exactIds.add(sourceId);
  }
  const normalized = new Map();
  for (const { node, sourceId } of parsed) {
    const id = toUiProfileId(node.id);
    const mappedParentId = node.parentId ? toUiProfileId(node.parentId) : null;
    const candidate = { ...node, id, parentId: mappedParentId === id ? null : mappedParentId };
    const existing = normalized.get(id);
    if (!existing || sourceId === id) normalized.set(id, { node: candidate, sourceId });
  }
  const canonical = [...normalized.values()].map(({ node }) => node);
  const byId = new Map();
  for (const node of canonical) {
    byId.set(node.id, node);
  }
  for (const node of canonical) {
    if (node.parentId === node.id) throw new Error(`${node.id} cannot report to itself.`);
    if (node.parentId && !byId.has(node.parentId)) throw new Error(`Unknown parent ${node.parentId} for ${node.id}.`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("Organization hierarchy cannot contain a reporting cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    const parentId = byId.get(id)?.parentId;
    if (parentId) visit(parentId);
    visiting.delete(id);
    visited.add(id);
  };
  canonical.forEach((node) => visit(node.id));
  return canonical.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function organizationDescendants(nodes, profileIdValue) {
  const children = new Map();
  for (const node of nodes) {
    const items = children.get(node.parentId) ?? [];
    items.push(node.id);
    children.set(node.parentId, items);
  }
  const descendants = new Set();
  const visit = (id) => {
    for (const child of children.get(id) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      visit(child);
    }
  };
  visit(toUiProfileId(profileIdValue));
  return descendants;
}

export function organizationReportingContext(nodes, profileIdValue) {
  const current = validateOrganizationNodes(nodes);
  const byId = new Map(current.map((node) => [node.id, node]));
  const selected = byId.get(toUiProfileId(profileIdValue));
  if (!selected) {
    return { managerId: null, directReportIds: [], escalationPathIds: [], depth: 0 };
  }

  const escalationPathIds = [];
  let cursor = selected;
  while (cursor) {
    escalationPathIds.unshift(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }

  return {
    managerId: selected.parentId,
    directReportIds: current
      .filter((node) => node.parentId === selected.id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((node) => node.id),
    escalationPathIds,
    depth: Math.max(0, escalationPathIds.length - 1),
  };
}

export function organizationVisibleNodeIds(nodes, department = "all") {
  const current = validateOrganizationNodes(nodes);
  if (department === "all") return new Set(current.map((node) => node.id));

  const byId = new Map(current.map((node) => [node.id, node]));
  const visible = new Set();
  for (const node of current.filter((item) => item.department === department)) {
    let cursor = node;
    while (cursor && !visible.has(cursor.id)) {
      visible.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
  }
  return visible;
}

export function moveOrganizationNode(nodes, id, parentId) {
  const current = validateOrganizationNodes(nodes);
  id = toUiProfileId(id);
  parentId = parentId ? toUiProfileId(parentId) : null;
  if (!current.some((node) => node.id === id)) throw new Error(`Unknown profile: ${id}`);
  if (parentId && !current.some((node) => node.id === parentId)) throw new Error(`Unknown parent: ${parentId}`);
  if (parentId === id || organizationDescendants(current, id).has(parentId)) {
    throw new Error("하위 구성원 아래로 이동하면 순환 보고선이 만들어집니다.");
  }
  return validateOrganizationNodes(current.map((node) => node.id === id ? { ...node, parentId } : node));
}

export function addOrganizationNode(nodes, id, options = {}) {
  const current = validateOrganizationNodes(nodes);
  id = toUiProfileId(id);
  if (current.some((node) => node.id === id)) throw new Error("이미 조직도에 포함된 구성원입니다.");
  return validateOrganizationNodes([...current, {
    id,
    parentId: options.parentId ? toUiProfileId(options.parentId) : current.find((node) => node.parentId === null)?.id ?? null,
    department: options.department ?? "general",
    roomId: options.roomId ?? "operations",
    order: options.order ?? current.length,
  }]);
}

export function removeOrganizationNode(nodes, id) {
  const current = validateOrganizationNodes(nodes);
  id = toUiProfileId(id);
  const removed = current.find((node) => node.id === id);
  if (!removed) return current;
  return validateOrganizationNodes(current
    .filter((node) => node.id !== id)
    .map((node) => node.parentId === id ? { ...node, parentId: removed.parentId } : node));
}

export function organizationRoomAssignments(nodes = []) {
  return Object.fromEntries(validateOrganizationNodes(nodes).map((node) => [node.id, node.roomId]));
}
