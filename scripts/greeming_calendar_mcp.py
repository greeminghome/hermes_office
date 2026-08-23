#!/opt/hermes/.venv/bin/python3
"""Read-only Hermes MCP bridge for configured reservation calendars."""

from __future__ import annotations

import json
import os
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import FastMCP


SEOUL = ZoneInfo("Asia/Seoul")
ALLOWED_CALENDARS = {"integrated", "manual", "hourplace"}
BROKER_URL = os.environ.get("HERMES_CALENDAR_BROKER_URL", "http://hermes-office:4173").rstrip("/")
TOKEN_FILE = Path(os.environ.get("HERMES_CALENDAR_TOKEN_FILE", "/opt/data/private/calendar-read.token"))
PROFILE = os.environ.get("HERMES_AGENT_PROFILE", "default").strip().lower()

mcp = FastMCP(
    "hermes-reservation-calendar",
    instructions=(
        "Read the configured Google reservation calendars. This server is read-only and returns "
        "sanitized event fields; it cannot create, edit, or delete events."
    ),
)


def _token() -> str:
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise RuntimeError("Calendar broker credential is not configured.")
    return token


def _bound(value: str, *, end: bool) -> str:
    cleaned = str(value or "").strip()
    if not cleaned:
        today = datetime.now(SEOUL).date()
        target = today + (timedelta(days=30) if end else timedelta())
        return datetime.combine(target, time.min, SEOUL).isoformat()
    try:
        parsed_date = date.fromisoformat(cleaned)
    except ValueError:
        parsed_date = None
    if parsed_date is not None:
        if end:
            parsed_date += timedelta(days=1)
        return datetime.combine(parsed_date, time.min, SEOUL).isoformat()
    parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SEOUL)
    return parsed.isoformat()


def _calendar_keys(calendars: list[str] | None) -> list[str]:
    values = [str(value).strip().lower() for value in (calendars or ["integrated"]) if str(value).strip()]
    values = list(dict.fromkeys(values))
    unknown = [value for value in values if value not in ALLOWED_CALENDARS]
    if not values or unknown:
        raise ValueError("calendars must contain integrated, manual, or hourplace.")
    return values


def _request(params: dict[str, Any]) -> dict[str, Any]:
    request = Request(
        f"{BROKER_URL}/agent-api/calendar/events?{urlencode(params)}",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {_token()}",
            "X-Hermes-Agent-Profile": PROFILE,
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 400:
            raise ValueError("Calendar query range or filter is invalid.") from exc
        if exc.code == 401:
            raise RuntimeError("Calendar broker authorization failed.") from exc
        raise RuntimeError(f"Calendar broker returned HTTP {exc.code}.") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError("Calendar broker is temporarily unreachable.") from exc


@mcp.tool()
def calendar_events(
    start: str = "",
    end: str = "",
    calendars: list[str] | None = None,
    query: str = "",
    limit: int = 100,
) -> dict[str, Any]:
    """Read Google reservation calendar events.

    Args:
        start: Inclusive start date (YYYY-MM-DD) or RFC 3339 timestamp. Defaults to today in Korea.
        end: Inclusive end date (YYYY-MM-DD) or exclusive RFC 3339 timestamp. Defaults to 30 days ahead.
        calendars: integrated (all bookings), manual (manual source), and/or hourplace (blocking feed).
        query: Optional Google Calendar text search, maximum 120 characters.
        limit: Maximum events returned, from 1 to 250.
    """
    if not 1 <= int(limit) <= 250:
        raise ValueError("limit must be between 1 and 250.")
    if len(str(query)) > 120:
        raise ValueError("query must not exceed 120 characters.")
    keys = _calendar_keys(calendars)
    return _request({
        "time_min": _bound(start, end=False),
        "time_max": _bound(end, end=True),
        "calendars": ",".join(keys),
        "query": str(query).strip(),
        "limit": int(limit),
    })


if __name__ == "__main__":
    mcp.run(transport="stdio")
