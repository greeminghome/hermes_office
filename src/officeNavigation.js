export const OFFICE_USER_HOME = {
  id: "center-walkway",
  label: "중앙 통로",
  marker: [50, 70.5],
};

export const OFFICE_CORRIDORS = [
  // Outer loop and the permanently open approaches visible in the source art.
  { id: "top-aisle", x: 2.0, y: 20.5, w: 96.0, h: 4.2 },
  { id: "bottom-aisle", x: 2.0, y: 69.0, w: 96.0, h: 5.2 },
  { id: "left-aisle", x: 7.7, y: 23.5, w: 12.8, h: 47.6 },
  { id: "right-aisle", x: 79.5, y: 23.5, w: 12.8, h: 47.6 },
  { id: "main-corridor", x: 9.0, y: 24.0, w: 82.0, h: 7.8 },
  { id: "lower-corridor", x: 9.0, y: 64.2, w: 82.0, h: 7.0 },

  // Narrow internal routes preserve the furniture footprints in the open hub.
  { id: "center-north", x: 19.0, y: 29.0, w: 61.8, h: 6.0 },
  { id: "center-south", x: 19.0, y: 61.0, w: 61.8, h: 6.0 },
  { id: "center-aisle", x: 19.0, y: 29.0, w: 5.2, h: 38.0 },
  { id: "center-west-crossing", x: 37.0, y: 29.0, w: 4.2, h: 38.0 },
  { id: "center-east-crossing", x: 68.5, y: 29.0, w: 5.5, h: 38.0 },
  { id: "right-crossing", x: 77.2, y: 29.0, w: 3.6, h: 38.0 },

  // Open side alcoves contain the agent standing positions.
  { id: "left-alcoves", x: 7.6, y: 25.0, w: 2.6, h: 45.0 },
  { id: "right-alcoves", x: 89.8, y: 25.0, w: 2.8, h: 45.0 },
];

export const OFFICE_COLLISION_RECTS = [
  // North rooms and worktables.
  { id: "north-lounge-west", x: 2.0, y: 2.0, w: 11.8, h: 18.2 },
  { id: "north-desk-west-a", x: 16.0, y: 3.2, w: 9.2, h: 17.3 },
  { id: "north-desk-west-b", x: 26.6, y: 3.2, w: 9.1, h: 17.3 },
  { id: "north-lounge-center-a", x: 39.7, y: 2.0, w: 9.1, h: 21.2 },
  { id: "north-lounge-center-b", x: 50.0, y: 2.0, w: 10.1, h: 21.2 },
  { id: "north-desk-east-a", x: 66.3, y: 3.2, w: 9.0, h: 17.3 },
  { id: "north-desk-east-b", x: 76.8, y: 3.2, w: 8.8, h: 17.3 },
  { id: "north-lounge-east", x: 86.2, y: 2.0, w: 11.7, h: 18.2 },

  // Small rooms along the west wall. Their east edges remain open.
  { id: "west-pod-a", x: 1.8, y: 26.0, w: 5.9, h: 13.2 },
  { id: "west-pod-b", x: 1.8, y: 42.0, w: 5.9, h: 13.0 },
  { id: "west-pod-c", x: 1.8, y: 56.7, w: 5.9, h: 12.3 },

  // Central collaboration island furniture.
  { id: "island-table-west", x: 23.3, y: 35.0, w: 14.8, h: 25.4 },
  { id: "island-sofa", x: 40.2, y: 34.6, w: 14.3, h: 26.8 },
  { id: "island-lounge", x: 55.5, y: 37.0, w: 8.0, h: 22.4 },
  { id: "island-planter", x: 40.4, y: 56.0, w: 17.2, h: 5.4 },
  { id: "island-bar", x: 65.0, y: 34.5, w: 14.8, h: 26.6 },

  // East work booths. The corridor remains open immediately to their west.
  { id: "east-booth-a", x: 92.0, y: 25.8, w: 6.0, h: 13.7 },
  { id: "east-booth-b", x: 92.0, y: 41.2, w: 6.0, h: 13.4 },
  { id: "east-booth-c", x: 92.0, y: 56.4, w: 6.0, h: 12.7 },

  // South work areas and facilities. Their north edge is the open lower aisle.
  { id: "south-worktables", x: 2.5, y: 74.5, w: 36.0, h: 23.2 },
  { id: "south-meeting-pods", x: 39.5, y: 74.3, w: 21.9, h: 23.5 },
  { id: "south-kitchen", x: 63.0, y: 74.0, w: 11.6, h: 23.8 },
  { id: "south-facilities", x: 76.0, y: 73.4, w: 22.0, h: 24.4 },
];

export const OFFICE_WALKABLE_ZONES = [...OFFICE_CORRIDORS];

const clampPoint = (value, min = 4.5, max = 95.5) => Math.min(max, Math.max(min, value));
const CHARACTER_CLEARANCE = 0.52;
const WALKABLE_SEARCH_STEP = 0.25;

function pointInRect([x, y], rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function pointHitsObstacle([x, y], rect) {
  return x >= rect.x - CHARACTER_CLEARANCE
    && x <= rect.x + rect.w + CHARACTER_CLEARANCE
    && y >= rect.y - CHARACTER_CLEARANCE
    && y <= rect.y + rect.h + CHARACTER_CLEARANCE;
}

export function isOfficePointWalkable(marker) {
  return OFFICE_WALKABLE_ZONES.some((zone) => pointInRect(marker, zone))
    && !OFFICE_COLLISION_RECTS.some((obstacle) => pointHitsObstacle(marker, obstacle));
}

export function nearestOfficeWalkablePoint(marker) {
  const requested = [
    clampPoint(Number(marker?.[0]) || OFFICE_USER_HOME.marker[0]),
    clampPoint(Number(marker?.[1]) || OFFICE_USER_HOME.marker[1], 4.5, 95),
  ];
  if (isOfficePointWalkable(requested)) {
    return requested.map((value) => Number(value.toFixed(2)));
  }

  // Search outward from the requested point so clicks on furniture land on the
  // closest real aisle instead of a corridor rectangle that still intersects it.
  for (let radius = WALKABLE_SEARCH_STEP; radius <= 48; radius += WALKABLE_SEARCH_STEP) {
    const sampleCount = Math.max(12, Math.ceil((Math.PI * 2 * radius) / WALKABLE_SEARCH_STEP));
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < sampleCount; index += 1) {
      const angle = (index / sampleCount) * Math.PI * 2;
      const candidate = [
        clampPoint(requested[0] + Math.cos(angle) * radius),
        clampPoint(requested[1] + Math.sin(angle) * radius, 4.5, 95),
      ];
      if (!isOfficePointWalkable(candidate)) continue;
      const distance = (candidate[0] - requested[0]) ** 2 + (candidate[1] - requested[1]) ** 2;
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best) return best.map((value) => Number(value.toFixed(2)));
  }

  return [...OFFICE_USER_HOME.marker];
}

export function advanceOfficePoint(
  currentMarker,
  targetMarker,
  speedUnitsPerSecond,
  deltaSeconds,
  sceneSize = { width: 100, height: 100 },
) {
  const width = Math.max(1, Number(sceneSize.width) || 100);
  const height = Math.max(1, Number(sceneSize.height) || 100);
  const dx = targetMarker[0] - currentMarker[0];
  const dy = targetMarker[1] - currentMarker[1];
  const screenDx = dx / 100 * width;
  const screenDy = dy / 100 * height;
  const screenDistance = Math.hypot(screenDx, screenDy);
  if (screenDistance <= 0.001) return [...targetMarker];

  const pixelsPerSecond = Math.max(0, speedUnitsPerSecond) / 100 * Math.min(width, height);
  const screenStep = Math.min(screenDistance, pixelsPerSecond * Math.max(0, deltaSeconds));
  const progress = screenStep / screenDistance;
  return [
    currentMarker[0] + dx * progress,
    currentMarker[1] + dy * progress,
  ];
}

function segmentIsWalkable(from, to) {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const samples = Math.max(1, Math.ceil(distance / 0.35));
  for (let index = 1; index <= samples; index += 1) {
    const progress = index / samples;
    if (!isOfficePointWalkable([
      from[0] + (to[0] - from[0]) * progress,
      from[1] + (to[1] - from[1]) * progress,
    ])) return false;
  }
  return true;
}

export function moveOfficePoint(currentMarker, delta) {
  const current = nearestOfficeWalkablePoint(currentMarker);
  const next = [
    clampPoint(current[0] + delta[0]),
    clampPoint(current[1] + delta[1], 4.5, 95),
  ];
  if (segmentIsWalkable(current, next)) return next;
  const xOnly = [next[0], current[1]];
  if (segmentIsWalkable(current, xOnly)) return xOnly;
  const yOnly = [current[0], next[1]];
  if (segmentIsWalkable(current, yOnly)) return yOnly;
  return current;
}

const pathKey = ([x, y]) => `${x}:${y}`;
const heuristic = (left, right) => Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]);

class MinPriorityQueue {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(value, priority) {
    const entry = { value, priority };
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= entry.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = entry;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      const right = child + 1;
      if (right < this.items.length && this.items[right].priority < this.items[child].priority) {
        child = right;
      }
      if (this.items[child].priority >= last.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

function simplifyPath(path) {
  if (path.length < 3) return path;
  const simplified = [path[0]];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let candidate = path.length - 1;
    while (candidate > anchor + 1 && !segmentIsWalkable(path[anchor], path[candidate])) candidate -= 1;
    simplified.push(path[candidate]);
    anchor = candidate;
  }
  return simplified;
}

export function findOfficePath(startMarker, targetMarker, gridSize = 1) {
  const start = nearestOfficeWalkablePoint(startMarker);
  const target = nearestOfficeWalkablePoint(targetMarker);
  if (segmentIsWalkable(start, target)) return [start, target];

  const snap = ([x, y]) => [Math.round(x / gridSize) * gridSize, Math.round(y / gridSize) * gridSize];
  const startNode = nearestOfficeWalkablePoint(snap(start));
  const targetNode = nearestOfficeWalkablePoint(snap(target));
  const open = new MinPriorityQueue();
  const cameFrom = new Map();
  const cost = new Map([[pathKey(startNode), 0]]);
  const closed = new Set();
  const directions = [[gridSize, 0], [-gridSize, 0], [0, gridSize], [0, -gridSize]];
  let reached = null;
  open.push(startNode, heuristic(startNode, targetNode));

  for (let iteration = 0; open.size && iteration < 18000; iteration += 1) {
    const current = open.pop()?.value;
    if (!current) break;
    const currentKey = pathKey(current);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    if (heuristic(current, targetNode) <= gridSize && segmentIsWalkable(current, target)) {
      reached = current;
      break;
    }

    directions.forEach(([dx, dy]) => {
      const next = [Number((current[0] + dx).toFixed(2)), Number((current[1] + dy).toFixed(2))];
      if (!isOfficePointWalkable(next) || !segmentIsWalkable(current, next)) return;
      const nextKey = pathKey(next);
      const nextCost = (cost.get(currentKey) ?? 0) + gridSize;
      if (nextCost >= (cost.get(nextKey) ?? Number.POSITIVE_INFINITY)) return;
      cameFrom.set(nextKey, current);
      cost.set(nextKey, nextCost);
      open.push(next, nextCost + heuristic(next, targetNode));
    });
  }

  if (!reached) return [start];
  const path = [target, reached];
  let cursor = reached;
  while (pathKey(cursor) !== pathKey(startNode)) {
    const previous = cameFrom.get(pathKey(cursor));
    if (!previous) break;
    path.push(previous);
    cursor = previous;
  }
  path.push(start);
  return simplifyPath(path.reverse());
}
