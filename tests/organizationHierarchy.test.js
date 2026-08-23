import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addOrganizationNode,
  buildDefaultOrganizationNodes,
  moveOrganizationNode,
  organizationReportingContext,
  organizationRoomAssignments,
  organizationVisibleNodeIds,
  removeOrganizationNode,
  validateOrganizationNodes,
} from "../organizationHierarchy.js";

const profiles = [
  { name: "default" },
  { name: "hermes-operations" },
  { name: "hermes-brand" },
  { name: "external-agent" },
];

test("default hierarchy contains every actual Hermes profile exactly once", () => {
  const nodes = buildDefaultOrganizationNodes(profiles);
  assert.deepEqual(new Set(nodes.map((node) => node.id)), new Set(profiles.map((profile) => profile.name)));
  assert.equal(nodes.find((node) => node.id === "default")?.parentId, null);
  assert.equal(nodes.find((node) => node.id === "hermes-operations")?.parentId, "default");
  assert.equal(nodes.find((node) => node.id === "hermes-brand")?.parentId, "hermes-operations");
});

test("the primary Hermes profile and UI alias collapse into one organization node", () => {
  const nodes = buildDefaultOrganizationNodes([
    { name: "default" },
    { name: "hermes-director" },
    { name: "hermes-operations" },
  ]);
  assert.deepEqual(nodes.map((node) => node.id), ["default", "hermes-operations"]);

  const migrated = validateOrganizationNodes([
    { id: "default", parentId: null, department: "leadership", roomId: "executive", order: 0 },
    { id: "hermes-director", parentId: "default", department: "general", roomId: "operations", order: 99 },
    { id: "hermes-operations", parentId: "hermes-director", department: "operations", roomId: "operations", order: 1 },
  ]);
  assert.equal(migrated.filter((node) => node.id === "default").length, 1);
  assert.equal(migrated.find((node) => node.id === "default")?.roomId, "executive");
  assert.equal(migrated.find((node) => node.id === "hermes-operations")?.parentId, "default");
});

test("drag-style moves reject reporting cycles", () => {
  const nodes = buildDefaultOrganizationNodes(profiles);
  assert.throws(
    () => moveOrganizationNode(nodes, "default", "hermes-brand"),
    /순환 보고선/,
  );
  const moved = moveOrganizationNode(nodes, "external-agent", "hermes-brand");
  assert.equal(moved.find((node) => node.id === "external-agent")?.parentId, "hermes-brand");
});

test("adding and removing a member preserves a valid tree and reparents children", () => {
  const base = buildDefaultOrganizationNodes(profiles.slice(0, 3));
  const added = addOrganizationNode(base, "external-agent", { parentId: "hermes-brand", roomId: "creative" });
  assert.equal(added.find((node) => node.id === "external-agent")?.parentId, "hermes-brand");
  const removed = removeOrganizationNode(added, "hermes-brand");
  assert.equal(removed.find((node) => node.id === "external-agent")?.parentId, "hermes-operations");
  assert.doesNotThrow(() => validateOrganizationNodes(removed));
});

test("room assignments are derived only from validated organization nodes", () => {
  const nodes = buildDefaultOrganizationNodes(profiles);
  const assignments = organizationRoomAssignments(nodes);
  assert.equal(assignments.default, "executive");
  assert.equal(assignments["hermes-brand"], "brand");
  assert.throws(
    () => organizationRoomAssignments([{ id: "default", parentId: "missing", roomId: "tech" }]),
    /Unknown parent/,
  );
});

test("reporting context exposes manager, direct reports, depth, and the full escalation path", () => {
  const nodes = moveOrganizationNode(buildDefaultOrganizationNodes(profiles), "external-agent", "hermes-brand");
  const context = organizationReportingContext(nodes, "hermes-brand");
  assert.equal(context.managerId, "hermes-operations");
  assert.deepEqual(context.directReportIds, ["external-agent"]);
  assert.deepEqual(context.escalationPathIds, ["default", "hermes-operations", "hermes-brand"]);
  assert.equal(context.depth, 2);
});

test("department filters preserve every ancestor required to understand the reporting line", () => {
  const nodes = moveOrganizationNode(buildDefaultOrganizationNodes(profiles), "external-agent", "hermes-brand").map((node) => (
    node.id === "external-agent" ? { ...node, department: "creative" } : node
  ));
  const visible = organizationVisibleNodeIds(nodes, "creative");
  assert.deepEqual(visible, new Set(["external-agent", "hermes-brand", "hermes-operations", "default"]));
  assert.deepEqual(organizationVisibleNodeIds(nodes, "all"), new Set(nodes.map((node) => node.id)));
});

test("B1 organization console separates live operations from staged structure editing", async () => {
  const [workspaceSource, appSource, serverSource, b1Styles, mainSource] = await Promise.all([
    readFile(new URL("../src/TeamWorkspace.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../src/organizationB1.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspaceSource, /\["hierarchy", "조직도"\]/);
  assert.match(workspaceSource, /draggable={editing}/);
  assert.match(workspaceSource, /editing && draggedId && draggedId !== node\.id\) onDrop\(node\.id\)/);
  assert.match(workspaceSource, /구조 편집/);
  assert.match(workspaceSource, /변경사항 저장/);
  assert.match(workspaceSource, /setDraftNodes\(validated\)/);
  assert.match(workspaceSource, /await onSave\(validateOrganizationNodes\(draftNodes\)\)/);
  assert.match(workspaceSource, /organization-departments/);
  assert.match(workspaceSource, /MEMBER BRIEF/);
  assert.match(workspaceSource, /REPORTING LINE/);
  assert.match(workspaceSource, /WORKSPACE AUTHORITY/);
  assert.match(workspaceSource, /HERMES PROFILE SCOPE/);
  assert.match(workspaceSource, /조직도에서 제외/);
  assert.match(workspaceSource, /오피스 룸/);
  assert.match(workspaceSource, /저장 전에는 반영되지 않습니다/);
  assert.match(workspaceSource, /role="tablist"/);
  assert.match(workspaceSource, /role="tree"/);
  assert.match(workspaceSource, /<DepartmentIcon id={department\.id}/);
  assert.doesNotMatch(workspaceSource, /department\.label\.slice\(0, 1\)/);
  assert.doesNotMatch(workspaceSource, /member\.initials/);
  assert.match(appSource, /roomAssignments={roomAssignments}/);
  assert.match(appSource, /missions={missions}/);
  assert.match(appSource, /onOpenOffice={\(\) => navigate\("office"\)}/);
  assert.match(appSource, /onSaveOrganization={saveOrganizationStructure}/);
  assert.match(appSource, /const normalizedNodes = validateOrganizationNodes\(state\?\.nodes \?\? \[\]\)/);
  assert.match(appSource, /await saveOrganization\(normalizedNodes, state\.revision\)/);
  assert.doesNotMatch(appSource, /\.filter\(\(profile\) => TEAM_META\[profile\.name\]\)/);
  assert.match(serverSource, /url\.pathname === "\/bridge\/organization"/);
  assert.match(serverSource, /baseRevision/);
  assert.match(mainSource, /organizationB1\.css/);
  assert.match(b1Styles, /grid-template-columns: minmax\(440px, 1fr\) minmax\(318px, 346px\)/);
  assert.match(b1Styles, /width: min\(100%, 520px\)/);
  assert.match(b1Styles, /\.team-workspace\.organization-mode > aside[\s\S]*display: block !important/);
  assert.match(b1Styles, /@container \(max-width: 900px\)/);
  assert.match(b1Styles, /flex: 1 1 auto/);
  assert.doesNotMatch(b1Styles, /min-height: min\(760px/);
  assert.match(b1Styles, /@media \(max-width: 1180px\)/);
  assert.match(b1Styles, /@media \(max-width: 820px\)/);
});
