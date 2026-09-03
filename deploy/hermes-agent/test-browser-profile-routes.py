#!/usr/bin/env python3
"""Execute actual routing functions without loading the LLM/tool dependencies."""
import ast
import json
import os
from pathlib import Path
import re
import logging
import sys
import tempfile
import types
from typing import Optional
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent


def load_functions(filename, names):
    tree = ast.parse((ROOT / "overrides" / filename).read_text(encoding="utf-8"))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in nodes} == set(names)
    namespace = {
        "os": os, "Path": Path, "json": json, "re": re, "Optional": Optional,
        "_profile_name_pattern": re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$"),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, "exec"), namespace)
    return namespace


class ProfileRoutes(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.registry = Path(self.temporary.name) / "registry.json"
        environment = patch.dict(os.environ, {
            "HERMES_GATEWAY_PROFILES": "team-one,team-two",
            "HERMES_PROFILE_RUNTIME_REGISTRY": str(self.registry),
            "HERMES_PROFILE_CDP_BASE_PORT": "9300",
            "HERMES_PROFILE_CDP_PROXY_BASE_PORT": "9400",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.browser = load_functions("browser_tool.py", [
            "_configured_runtime_profile_entries", "_runtime_profile_entries",
            "_runtime_profile_index", "_browser_route_for_profile",
            "_browser_route_for_profile_index", "_persisted_browser_session_route",
        ])
        self.gateway = load_functions("tui_gateway_server.py", ["_profile_browser_route"])

    def routes(self, profile):
        return [self.browser["_browser_route_for_profile"](profile), self.gateway["_profile_browser_route"](profile)]

    def write_registry(self):
        self.registry.write_text(json.dumps({"profiles": [
            {"profile": "team-one", "index": 0, "active": True},
            {"profile": "team-two", "index": 1, "active": False},
            {"profile": "team-new", "index": 7, "active": True},
        ]}), encoding="utf-8")

    def test_static_startup_fallback_is_exact(self):
        self.assertEqual(self.routes("team-two"), [("http://127.0.0.1:9301", "http://127.0.0.1:9401")] * 2)
        self.assertEqual(self.routes("unknown"), [("", "")] * 2)

    def test_dynamic_slot_is_shared_by_tool_and_gateway(self):
        self.write_registry()
        self.assertEqual(self.routes("team-new"), [("http://127.0.0.1:9307", "http://127.0.0.1:9407")] * 2)
        self.assertEqual(self.routes("team-two"), [("", "")] * 2)
        self.assertEqual(self.routes("../team-one"), [("", "")] * 2)

    def test_persisted_owner_must_match_runtime_slot(self):
        self.write_registry()
        owner = Path(self.temporary.name) / "owner.json"
        self.browser["_browser_session_owner_path"] = lambda key: owner
        owner.write_text(json.dumps({"sessionKey": "session", "profile": "team-new", "profileIndex": 7}), encoding="utf-8")
        self.assertEqual(self.browser["_persisted_browser_session_route"]("session"), ("http://127.0.0.1:9307", "http://127.0.0.1:9407"))
        owner.write_text(json.dumps({"sessionKey": "session", "profile": "team-new", "profileIndex": 0}), encoding="utf-8")
        self.assertEqual(self.browser["_persisted_browser_session_route"]("session"), ("", ""))

    def test_malformed_registry_never_routes_dynamic_to_default(self):
        self.registry.write_text("not-json", encoding="utf-8")
        self.assertEqual(self.routes("team-new"), [("", "")] * 2)

    def test_corrupted_registry_fails_closed_for_previously_configured_members(self):
        self.registry.write_text("not-json", encoding="utf-8")
        self.assertEqual(self.routes("team-one"), [("", "")] * 2)

    def test_empty_authoritative_registry_does_not_resurrect_retired_profiles(self):
        self.registry.write_text(json.dumps({"profiles": []}), encoding="utf-8")
        self.assertEqual(self.routes("team-one"), [("", "")] * 2)

    def test_transport_teardown_preserves_workspace_but_explicit_close_disposes(self):
        gateway = load_functions("tui_gateway_server.py", ["_teardown_session"])
        gateway["_finalize_session"] = lambda *args, **kwargs: None
        gateway["logger"] = logging.getLogger("test")
        released = []
        browser_module = types.ModuleType("tools.browser_tool")
        browser_module.release_browser_session = released.append
        approval_module = types.ModuleType("tools.approval")
        approval_module.unregister_gateway_notify = lambda key: None
        with patch.dict(sys.modules, {"tools.browser_tool": browser_module, "tools.approval": approval_module}):
            for reason in ("ws_disconnect", "ws_orphan_reap", "tui_shutdown", "idle_timeout"):
                gateway["_teardown_session"]({"session_key": "preserved"}, end_reason=reason)
            self.assertEqual(released, [])
            gateway["_teardown_session"]({"session_key": "explicit"}, end_reason="tui_close")
            self.assertEqual(released, ["explicit"])


if __name__ == "__main__":
    unittest.main()
