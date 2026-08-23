import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildMeetingSeatPlacements,
  buildOfficeAgentPlacements,
  OFFICE_FLOOR_ZONES,
  resolveProfileMeta,
  ROOMS,
} from "../src/officeData.js";
import {
  advanceOfficePoint,
  findOfficePath,
  isOfficePointWalkable,
  moveOfficePoint,
  nearestOfficeWalkablePoint,
  OFFICE_COLLISION_RECTS,
  OFFICE_USER_HOME,
} from "../src/officeNavigation.js";

const roster = (count) => Array.from({ length: count }, (_, index) => ({
  name: index === 0 ? "default" : index === 1 ? "greeming-seoyun" : `external-agent-${String(index).padStart(2, "0")}`,
  description: `Dynamic role ${index}`,
  gateway_running: index % 2 === 0,
}));

function coordinateKeys(placements) {
  return Object.values(placements).map(({ x, y }) => `${x.toFixed(6)}:${y.toFixed(6)}`);
}

for (const count of [0, 1, 9, 12, 20]) {
  test(`office seats are deterministic and collision-free for ${count} profiles`, () => {
    const profiles = roster(count);
    const forward = buildOfficeAgentPlacements(profiles, OFFICE_FLOOR_ZONES, ROOMS);
    const reversed = buildOfficeAgentPlacements([...profiles].reverse(), OFFICE_FLOOR_ZONES, ROOMS);
    assert.deepEqual(forward, reversed);
    assert.equal(Object.keys(forward).length, count);
    assert.equal(new Set(coordinateKeys(forward)).size, count);

    for (const placement of Object.values(forward)) {
      const zone = OFFICE_FLOOR_ZONES.find((candidate) => candidate.id === placement.roomId);
      assert.ok(zone, `missing zone ${placement.roomId}`);
      assert.ok(placement.x >= zone.x && placement.x <= zone.x + zone.w, `${placement.x} outside ${zone.id}`);
      assert.ok(placement.y >= zone.y && placement.y <= zone.y + zone.h, `${placement.y} outside ${zone.id}`);
      assert.ok(isOfficePointWalkable([placement.x, placement.y]), `${placement.roomId} seat intersects furniture`);
    }
  });

  test(`meeting seats are deterministic and collision-free for ${count} profiles`, () => {
    const profiles = roster(count);
    const forward = buildMeetingSeatPlacements(profiles);
    const reversed = buildMeetingSeatPlacements([...profiles].reverse());
    assert.deepEqual(forward, reversed);
    assert.equal(Object.keys(forward).length, count);
    const keys = Object.values(forward).map(([x, y]) => `${x.toFixed(6)}:${y.toFixed(6)}`);
    assert.equal(new Set(keys).size, count);
  });
}

test("all meeting seats remain inside the calibrated daylight meeting room", () => {
  const meeting = OFFICE_FLOOR_ZONES.find((zone) => zone.id === "meeting");
  for (const count of [1, 9, 12, 20, 50]) {
    const seats = buildMeetingSeatPlacements(roster(count));
    for (const [x, y] of Object.values(seats)) {
      assert.ok(x > meeting.x && x < meeting.x + meeting.w, `${count} seat x=${x} is outside`);
      assert.ok(y > meeting.y && y < meeting.y + meeting.h, `${count} seat y=${y} is outside`);
    }
  }
});

test("visible meeting markers do not overlap at supported map sizes", () => {
  const seats = Object.values(buildMeetingSeatPlacements(roster(5)));
  for (const [width, height] of [[1088, 612], [1158, 652], [1272, 716]]) {
    for (let left = 0; left < seats.length; left += 1) {
      for (let right = left + 1; right < seats.length; right += 1) {
        const dx = Math.abs(seats[left][0] - seats[right][0]) / 100 * width;
        const dy = Math.abs(seats[left][1] - seats[right][1]) / 100 * height;
        assert.ok(dx >= 48 || dy >= 56, `${width}x${height} seats ${left}/${right} overlap (${dx}, ${dy})`);
      }
    }
  }
});

test("unregistered profiles receive their own readable fallback metadata", () => {
  const meta = resolveProfileMeta({
    name: "external-growth-agent",
    description: "Growth experiments",
  });
  assert.equal(meta.id, "external-growth-agent");
  assert.equal(meta.name, "External Growth Agent");
  assert.equal(meta.role, "Growth experiments");
  assert.equal(meta.initials, "EG");
  assert.match(meta.color, /^hsl\(\d+ 30% 48%\)$/);
  assert.notEqual(meta.name, "민준");
});

test("Minjun's runtime alias uses the registered identity and one office seat", () => {
  const meta = resolveProfileMeta({ name: "greeming-minjun", description: "runtime" });
  assert.equal(meta.id, "default");
  assert.equal(meta.name, "민준");
  const placements = buildOfficeAgentPlacements([
    { name: "default", gateway_running: false },
    { name: "greeming-minjun", gateway_running: true },
  ]);
  assert.deepEqual(Object.keys(placements), ["default"]);
});

test("known profile room hints remain valid while unknown profiles get a real seat", () => {
  const placements = buildOfficeAgentPlacements([
    { name: "default" },
    { name: "greeming-seoyun" },
    { name: "outside-contractor" },
  ]);
  assert.equal(placements.default.roomId, "executive");
  assert.equal(placements["greeming-seoyun"].roomId, "operations");
  assert.ok(placements["outside-contractor"].roomId);
  assert.notDeepEqual(placements["outside-contractor"], { roomId: "meeting", x: 50, y: 50 });
});

test("organization room assignment overrides legacy hints and stays inside the selected room", () => {
  const assignments = {
    default: "tech",
    "greeming-seoyun": "creative",
  };
  const placements = buildOfficeAgentPlacements(
    [{ name: "default" }, { name: "greeming-seoyun" }],
    OFFICE_FLOOR_ZONES,
    ROOMS,
    assignments,
  );
  for (const [profileName, roomId] of Object.entries(assignments)) {
    const placement = placements[profileName];
    const zone = OFFICE_FLOOR_ZONES.find((candidate) => candidate.id === roomId);
    assert.equal(placement.roomId, roomId);
    assert.ok(placement.x > zone.x && placement.x < zone.x + zone.w);
    assert.ok(placement.y > zone.y && placement.y < zone.y + zone.h);
  }
});

test("office map renders the approved lossless art and pixel people in one layered canvas scene", async () => {
  const [source, releaseStyles, navigationSource, index, mapAsset, atlasAsset] = await Promise.all([
    readFile(new URL("../src/HermesOffice.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/officeMap.css", import.meta.url), "utf8"),
    readFile(new URL("../src/officeNavigation.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-office-open-topdown-v1.png", import.meta.url)),
    readFile(new URL("../public/agents/pixel-agent-atlas-v1.png", import.meta.url)),
  ]);
  assert.match(source, /const OFFICE_SCENE_IMAGE = "\/agent-office-open-topdown-v1\.png"/);
  assert.match(source, /function OfficeSceneCanvas/);
  assert.match(source, /className="office-scene-map-canvas"/);
  assert.match(source, /className="office-scene-canvas"/);
  assert.match(source, /drawScenePerson/);
  assert.match(source, /OFFICE_SCENE_OCCLUDERS/);
  assert.match(source, /const OFFICE_AGENT_ATLAS = "\/agents\/pixel-agent-atlas-v1\.png"/);
  assert.match(source, /OFFICE_AGENT_SPRITE_ROWS/);
  assert.match(source, /imageSmoothingEnabled = false/);
  assert.match(source, /findOfficePath\(\[current\.xPercent, current\.yPercent\]/);
  assert.match(source, /dataset\.collisionSafe/);
  assert.match(source, /dataset\.mapReady/);
  assert.match(source, /dataset\.motionFps/);
  assert.match(source, /dataset\.motionModel = "frame-independent"/);
  assert.doesNotMatch(source, /className="floorplan-art"/);
  assert.doesNotMatch(source, /hermes-office-daylight-glass-v3\.webp|greeming-office-map-2d\.webp/);
  assert.doesNotMatch(index, /greeming-office-map-2d\.webp/);
  assert.equal(mapAsset.readUInt32BE(16), 1536);
  assert.equal(mapAsset.readUInt32BE(20), 1024);
  assert.ok(mapAsset.length > 2_600_000, "the approved lossless map asset should not be replaced by a low-quality export");
  assert.equal(atlasAsset.readUInt32BE(16), 1024);
  assert.equal(atlasAsset.readUInt32BE(20), 1440);
  assert.equal(atlasAsset[25], 6, "the pixel atlas must preserve RGBA transparency");
  assert.ok(atlasAsset.length > 900_000, "the pixel atlas should retain its generated sprite detail");
  assert.doesNotMatch(source, /className="office-floor-grid"/);
  assert.doesNotMatch(source, /className="floor-room-label"/);
  assert.doesNotMatch(source, /className="door"/);
  assert.match(source, /aria-label={`\$\{zone\.label\} 영역 열기`}/);
  assert.match(source, /<span className="sr-only">{zone\.label}<\/span>/);
  assert.doesNotMatch(source, /<span>입구<\/span>/);
  assert.doesNotMatch(source, /TEAM SYNC/);
  assert.doesNotMatch(source, /AGENT_PLACEMENTS|MEETING_SEATS/);
  assert.match(source, /roomAssignments={roomAssignments}/);
  assert.match(releaseStyles, /--office-map-ratio:\s*3 \/ 2/);
  assert.match(releaseStyles, /\.floorplan-stage[\s\S]*padding:\s*0 !important/);
  assert.match(releaseStyles, /\.office-scene-canvas[\s\S]*pointer-events:\s*none/);
  assert.match(releaseStyles, /\.office-scene-map-canvas[\s\S]*z-index:\s*0/);
  assert.match(releaseStyles, /\.floor-agent\.scene-hit-target[\s\S]*opacity:\s*0/);
  assert.match(releaseStyles, /\.floorplan-card[\s\S]*border:\s*0 !important/);
  assert.match(releaseStyles, /\.floorplan-building:focus-visible/);
  assert.match(releaseStyles, /\.floorplan-building\.isometric-office \.floor-room\.map-zone[\s\S]*background:\s*transparent !important/);
  assert.match(releaseStyles, /\.floorplan-building\.isometric-office \.floor-room\.map-zone[\s\S]*pointer-events:\s*none/);
  assert.match(source, /onKeyDown={onMapKeyDown}/);
  assert.match(source, /onPointerDown={moveToPoint}/);
  assert.match(source, /onDoubleClick={openRoomAtPoint}/);
  assert.match(source, /event\.target !== mapRef\.current/);
  assert.match(source, /\.floor-user-marker, \.floor-meeting-roster/);
  assert.match(source, /meetingProfiles\.length > 5 \? 4 : 5/);
  assert.match(source, /__meeting-overflow__/);
  assert.match(source, /className="floor-meeting-roster"/);
  assert.match(source, /회의 참가자 \$\{meetingProfiles\.length\}명 전체 목록/);
  assert.match(source, /<ul aria-label="전체 회의 참가자">/);
  assert.match(source, /<li key={profile\.name}><button type="button"/);
  assert.doesNotMatch(source, /<button type="button" role="listitem"/);
  assert.match(navigationSource, /id: "top-aisle"/);
  assert.match(navigationSource, /id: "bottom-aisle"/);
  assert.match(navigationSource, /id: "left-aisle"/);
  assert.match(navigationSource, /id: "center-aisle"/);
  assert.match(navigationSource, /id: "right-aisle"/);
  assert.match(navigationSource, /OFFICE_COLLISION_RECTS/);
  assert.ok(OFFICE_COLLISION_RECTS.length >= 20);
  assert.match(navigationSource, /segmentIsWalkable/);
  assert.match(navigationSource, /findOfficePath/);
  assert.doesNotMatch(source, /window\.addEventListener\("keydown", onKeyDown\)[\s\S]{0,100}moveWithinWalls/);
});

test("office movement cannot cross walls and click paths stay inside rooms or corridors", () => {
  assert.deepEqual(moveOfficePoint([22.5, 48], [8, 0]), [22.5, 48]);
  const path = findOfficePath(OFFICE_USER_HOME.marker, [7, 22]);
  assert.ok(path.length >= 3, "travel across the office should route through corridors");
  assert.deepEqual(path[0], OFFICE_USER_HOME.marker);
  assert.deepEqual(path.at(-1), [7, 22]);
  assert.ok(path.every(isOfficePointWalkable));
  assert.equal(isOfficePointWalkable([29, 48]), false, "west collaboration table must block movement");
  assert.equal(isOfficePointWalkable([48, 48]), false, "central sofa must block movement");
  assert.equal(isOfficePointWalkable([69, 48]), false, "bar counter must block movement");
  assert.equal(isOfficePointWalkable([50, 64]), true, "lower collaboration aisle must stay walkable");

  const meetingPath = findOfficePath([27, 22], [80.5, 48]);
  assert.ok(meetingPath.length >= 3, "agents must route around the central furniture to a meeting");
  assert.ok(meetingPath.every(isOfficePointWalkable));
});

test("movement speed is frame-independent and visually equal in both axes", () => {
  const sceneSize = { width: 1600, height: 900 };
  const horizontal = advanceOfficePoint([20, 20], [80, 20], 10, 1, sceneSize);
  const vertical = advanceOfficePoint([20, 20], [20, 80], 10, 1, sceneSize);
  const horizontalPixels = (horizontal[0] - 20) / 100 * sceneSize.width;
  const verticalPixels = (vertical[1] - 20) / 100 * sceneSize.height;
  assert.ok(Math.abs(horizontalPixels - 90) < 0.001);
  assert.ok(Math.abs(verticalPixels - 90) < 0.001);

  const oneFrame = advanceOfficePoint([20, 20], [80, 20], 10, 1 / 30, sceneSize);
  const twoHalfFrames = advanceOfficePoint(
    advanceOfficePoint([20, 20], [80, 20], 10, 1 / 60, sceneSize),
    [80, 20],
    10,
    1 / 60,
    sceneSize,
  );
  assert.ok(Math.abs(oneFrame[0] - twoHalfFrames[0]) < 0.000001);
});

test("clicks on furniture resolve to the nearest genuinely walkable aisle", () => {
  for (const blockedPoint of [[29, 48], [48, 48], [69, 48], [50, 58]]) {
    const resolved = nearestOfficeWalkablePoint(blockedPoint);
    assert.ok(isOfficePointWalkable(resolved), `${blockedPoint} resolved to blocked ${resolved}`);
    assert.ok(Math.hypot(resolved[0] - blockedPoint[0], resolved[1] - blockedPoint[1]) < 12);
  }
});
