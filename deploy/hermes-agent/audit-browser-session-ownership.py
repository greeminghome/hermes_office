#!/usr/bin/env python3
"""Read-only audit of durable Hermes session ownership and browser router state."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from collections import defaultdict
from pathlib import Path


DATA_ROOT = Path(os.environ.get("HERMES_DATA_ROOT") or "/opt/data")
PROFILES = [
    item.strip()
    for item in os.environ.get("HERMES_GATEWAY_PROFILES", "").split(",")
    if item.strip()
]

if not PROFILES:
    raise SystemExit("HERMES_GATEWAY_PROFILES must list the deployed profiles")
if len(PROFILES) != len(set(PROFILES)):
    raise SystemExit("HERMES_GATEWAY_PROFILES contains duplicate profile names")

CONFIGS = [
    {"profile": "default", "cdpPort": 9222, "routerPort": 9223, "db": DATA_ROOT / "state.db"},
    *[
        {
            "profile": profile,
            "cdpPort": int(os.environ.get("HERMES_PROFILE_CDP_BASE_PORT") or 9300) + index,
            "routerPort": int(os.environ.get("HERMES_PROFILE_CDP_PROXY_BASE_PORT") or 9400) + index,
            "db": DATA_ROOT / "profiles" / profile / "state.db",
        }
        for index, profile in enumerate(PROFILES)
    ],
]
CONFIG_BY_PROFILE = {item["profile"]: item for item in CONFIGS}


def session_ids(database: Path) -> set[str]:
    if not database.is_file():
        return set()
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
        if "id" not in columns:
            return set()
        return {str(row[0]) for row in connection.execute("SELECT id FROM sessions") if row[0]}
    finally:
        connection.close()


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


database_owners: dict[str, list[str]] = defaultdict(list)
database_counts = {}
for config in CONFIGS:
    ids = session_ids(config["db"])
    database_counts[config["profile"]] = len(ids)
    for session_id in ids:
        database_owners[session_id].append(config["profile"])

owner_records = {}
owner_issues = []
owner_root = Path(os.environ.get("HERMES_BROWSER_SESSION_OWNER_DIR") or DATA_ROOT / "browser-session-owners")
for path in sorted(owner_root.glob("*.json")):
    payload = read_json(path, {})
    session_id = str(payload.get("sessionKey") or "")
    profile = str(payload.get("profile") or "")
    profile_index = payload.get("profileIndex")
    expected_name = hashlib.sha256(session_id.encode("utf-8")).hexdigest() + ".json" if session_id else ""
    if not session_id or path.name != expected_name:
        owner_issues.append({"kind": "invalid-owner-filename", "file": path.name})
        continue
    if profile not in PROFILES:
        owner_issues.append({"kind": "unknown-owner-profile", "sessionId": session_id, "profile": profile})
        continue
    expected_index = PROFILES.index(profile)
    if profile_index != expected_index:
        owner_issues.append({
            "kind": "owner-index-mismatch",
            "sessionId": session_id,
            "profile": profile,
            "expectedIndex": expected_index,
            "actualIndex": profile_index,
        })
        continue
    if session_id in owner_records and owner_records[session_id]["profile"] != profile:
        owner_issues.append({"kind": "duplicate-owner", "sessionId": session_id})
        continue
    owner_records[session_id] = {"profile": profile, "profileIndex": profile_index}

workspace_locations: dict[str, list[str]] = defaultdict(list)
workspace_counts = {}
workspace_issues = []
for config in CONFIGS:
    state_path = DATA_ROOT / f"browser-session-targets-{config['cdpPort']}.json"
    state = read_json(state_path, {})
    if not isinstance(state, dict):
        workspace_issues.append({"kind": "invalid-router-state", "profile": config["profile"]})
        state = {}
    workspace_counts[config["profile"]] = len(state)
    seen_contexts = set()
    for session_id, record in state.items():
        workspace_locations[str(session_id)].append(config["profile"])
        context_id = str(record.get("browserContextId") or "") if isinstance(record, dict) else ""
        if not context_id:
            workspace_issues.append({"kind": "missing-browser-context", "sessionId": session_id, "profile": config["profile"]})
        elif context_id in seen_contexts:
            workspace_issues.append({"kind": "shared-browser-context", "sessionId": session_id, "profile": config["profile"]})
        seen_contexts.add(context_id)

        db_profiles = database_owners.get(str(session_id), [])
        if len(db_profiles) == 1 and db_profiles[0] != config["profile"]:
            workspace_issues.append({
                "kind": "database-owner-route-mismatch",
                "sessionId": session_id,
                "databaseProfile": db_profiles[0],
                "routerProfile": config["profile"],
            })
        recorded_owner = owner_records.get(str(session_id))
        if recorded_owner and recorded_owner["profile"] != config["profile"]:
            workspace_issues.append({
                "kind": "persisted-owner-route-mismatch",
                "sessionId": session_id,
                "ownerProfile": recorded_owner["profile"],
                "routerProfile": config["profile"],
            })

for session_id, locations in workspace_locations.items():
    if len(locations) > 1:
        workspace_issues.append({"kind": "workspace-present-in-multiple-profiles", "sessionId": session_id, "profiles": locations})

database_issues = [
    {"kind": "session-present-in-multiple-databases", "sessionId": session_id, "profiles": owners}
    for session_id, owners in database_owners.items()
    if len(owners) > 1
]

alias_issues = []
alias_count = 0
alias_root = Path(os.environ.get("HERMES_BROWSER_WORKSPACE_DIR") or DATA_ROOT / "browser-session-workspaces")
for path in sorted(alias_root.glob("*.json")):
    payload = read_json(path, {})
    session_id = str(payload.get("sessionKey") or "")
    workspace_id = str(payload.get("workspaceKey") or "")
    expected_name = hashlib.sha256(session_id.encode("utf-8")).hexdigest() + ".json" if session_id else ""
    if not session_id or not workspace_id or session_id == workspace_id or path.name != expected_name:
        alias_issues.append({"kind": "invalid-workspace-alias", "file": path.name})
        continue
    alias_count += 1
    source_owners = database_owners.get(session_id, [])
    target_owners = database_owners.get(workspace_id, [])
    if len(source_owners) == 1 and len(target_owners) == 1 and source_owners[0] != target_owners[0]:
        alias_issues.append({
            "kind": "cross-profile-workspace-alias",
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "sessionProfile": source_owners[0],
            "workspaceProfile": target_owners[0],
        })

issues = database_issues + owner_issues + workspace_issues + alias_issues
report = {
    "ok": not issues,
    "profileCount": len(CONFIGS),
    "databaseSessionCounts": database_counts,
    "routerWorkspaceCounts": workspace_counts,
    "persistedOwnerCount": len(owner_records),
    "workspaceAliasCount": alias_count,
    "issues": issues,
}
print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
if issues:
    raise SystemExit(1)
