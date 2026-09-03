#!/usr/bin/env python3
"""Bind the upstream raw browser_cdp tool to Hermes' session router."""

from pathlib import Path


path = Path("/opt/hermes/tools/browser_cdp_tool.py")
source = path.read_text(encoding="utf-8")

old_resolver = '''def _resolve_cdp_endpoint() -> str:
    """Return the normalized CDP WebSocket URL, or empty string if unavailable.

    Delegates to ``tools.browser_tool._get_cdp_override`` so precedence stays
    consistent with the rest of the browser tool surface:

    1. ``BROWSER_CDP_URL`` env var (live override from ``/browser connect``)
    2. ``browser.cdp_url`` in ``config.yaml``
    """
    try:
        from tools.browser_tool import _get_cdp_override  # type: ignore[import-not-found]

        return (_get_cdp_override() or "").strip()
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("browser_cdp: failed to resolve CDP endpoint: %s", exc)
        return ""
'''

previous_resolver = '''def _resolve_cdp_endpoint(task_id: Optional[str] = None) -> str:
    """Return the exact session-routed WebSocket endpoint when task_id exists."""
    try:
        from tools.browser_tool import (  # type: ignore[import-not-found]
            _get_cdp_override,
            browser_session_endpoint,
        )

        if task_id:
            routed = (browser_session_endpoint(task_id) or "").strip()
            if routed:
                return routed
        return (_get_cdp_override(task_id) or "").strip()
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("browser_cdp: failed to resolve CDP endpoint: %s", exc)
        return ""
'''

new_resolver = '''def _resolve_cdp_endpoint(task_id: Optional[str] = None) -> str:
    """Return the exact session-routed WebSocket endpoint for the active task."""
    try:
        from tools.browser_tool import (  # type: ignore[import-not-found]
            _get_cdp_override,
            browser_session_endpoint,
        )

        # ``task_id`` is intentionally absent from the public browser_cdp
        # schema, so ordinary model calls pass None. browser_session_endpoint
        # resolves that case from the active Hermes session ContextVar. Skipping
        # it sent raw CDP calls to the profile Chrome and left Live Screen with
        # no session-owned target.
        routed = (browser_session_endpoint(task_id) or "").strip()
        if routed:
            return routed
        return (_get_cdp_override(task_id) or "").strip()
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("browser_cdp: failed to resolve CDP endpoint: %s", exc)
        return ""
'''

if new_resolver not in source:
    candidates = [item for item in (old_resolver, previous_resolver) if item in source]
    if len(candidates) != 1:
        raise SystemExit(f"browser_cdp resolver patch expected one known version, found {len(candidates)}")
    source = source.replace(candidates[0], new_resolver, 1)

replacements = [
    ("    del task_id  # stateless path below\n", ""),
    ("    endpoint = _resolve_cdp_endpoint()\n", "    endpoint = _resolve_cdp_endpoint(task_id)\n"),
]

for old, new in replacements:
    count = source.count(old)
    if count > 1:
        raise SystemExit(f"browser_cdp patch expected at most one match, found {count}: {old[:80]!r}")
    if count == 1:
        source = source.replace(old, new, 1)

path.write_text(source, encoding="utf-8")
