#!/usr/bin/env python3
import json

from tools.approval import reset_current_session_key, set_current_session_key
from tools.browser_cdp_tool import _resolve_cdp_endpoint, browser_cdp
from tools.browser_tool import release_browser_session, reset_browser_route_override, set_browser_route_override


route_tokens = set_browser_route_override(
    "http://127.0.0.1:9222", "http://127.0.0.1:9223", "route-smoke"
)
implicit_route_tokens = set_browser_route_override(
    "http://127.0.0.1:9222", "http://127.0.0.1:9223", "route-smoke-implicit"
)
try:
    endpoint = _resolve_cdp_endpoint("route-smoke")
    assert endpoint.endswith("/session/route-smoke"), endpoint
    result = json.loads(browser_cdp("Target.getTargets", task_id="route-smoke"))
    assert result.get("success") is True, result

    implicit_token = set_current_session_key("route-smoke-implicit")
    try:
        implicit_endpoint = _resolve_cdp_endpoint()
        assert implicit_endpoint.endswith("/session/route-smoke-implicit"), implicit_endpoint
        implicit_result = json.loads(browser_cdp("Target.getTargets"))
        assert implicit_result.get("success") is True, implicit_result
    finally:
        reset_current_session_key(implicit_token)
finally:
    release_browser_session("route-smoke")
    release_browser_session("route-smoke-implicit")
    reset_browser_route_override(implicit_route_tokens)
    reset_browser_route_override(route_tokens)

print(
    json.dumps(
        {
            "ok": True,
            "endpoint": endpoint,
            "targets": len(result.get("result", {}).get("targetInfos", [])),
            "implicit_endpoint": implicit_endpoint,
            "implicit_targets": len(implicit_result.get("result", {}).get("targetInfos", [])),
        }
    )
)
