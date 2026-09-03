#!/usr/bin/env python3
import json
import os
import tempfile


with tempfile.TemporaryDirectory(prefix="hermes-browser-alias-") as workspace_dir:
    os.environ["HERMES_BROWSER_WORKSPACE_DIR"] = workspace_dir

    from tools.browser_tool import browser_workspace_id, register_browser_session_workspace

    parent = "workspace-smoke-parent"
    continuation = "workspace-smoke-continuation"
    nested = "workspace-smoke-nested"

    assert register_browser_session_workspace(continuation, parent) == parent
    assert register_browser_session_workspace(nested, continuation) == parent
    assert browser_workspace_id(parent) == parent
    assert browser_workspace_id(continuation) == parent
    assert browser_workspace_id(nested) == parent
    assert browser_workspace_id(f"{nested}::local") == f"{parent}::local"

    print(json.dumps({"ok": True, "canonical": parent, "nested": True}))
