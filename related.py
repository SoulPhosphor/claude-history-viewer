"""Related Conversations: reciprocal links between two conversations.

A link is one row in udb.conversation_links (see server._ensure_userdata_schema)
holding the pair in sorted order, so linking A to B is the same row as linking
B to A. Any two conversations can be linked, whatever their provider or
location. Links live in userdata.db so they survive a history.db rebuild, and
a conversation purged from the Recycle Bin takes its links with it
(server._purge_conversation).
"""

from __future__ import annotations

import time

import advanced_search
from api_common import ApiError


def _pair(a, b) -> tuple[str, str]:
    a = str(a or "").strip()
    b = str(b or "").strip()
    if not a or not b:
        raise ApiError("Two conversation ids are required.", 400)
    if a == b:
        raise ApiError("A conversation cannot be linked to itself.", 400)
    return (a, b) if a < b else (b, a)


def _require_conversations(conn, ids) -> None:
    marks = ",".join("?" * len(ids))
    found = {r[0] for r in conn.execute(
        f"SELECT id FROM conversations WHERE id IN ({marks})", tuple(ids)
    )}
    if len(found) != len(set(ids)):
        raise ApiError("Conversation not found.", 404)


def related_ids(conn, cid: str) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT conversation_b FROM udb.conversation_links WHERE conversation_a = ? "
        "UNION SELECT conversation_a FROM udb.conversation_links WHERE conversation_b = ?",
        (cid, cid),
    )]


def list_related(conn, cid: str) -> list[dict]:
    """The conversations linked to `cid`, with what a sidebar row shows plus
    where each one lives (folder, Archived or Deleted)."""
    ids = related_ids(conn, cid)
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    rows = [dict(r) for r in conn.execute(
        "SELECT c.id, COALESCE(NULLIF(cm.custom_title,''), c.title) AS title, c.provider, "
        "c.create_time, c.update_time, c.message_count, c.preview "
        "FROM conversations c LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        f"WHERE c.id IN ({marks})",
        tuple(ids),
    )]
    advanced_search._attach_metadata(conn, rows)
    with_summary = {r[0] for r in conn.execute(
        "SELECT conversation_id FROM udb.conversation_summaries "
        f"WHERE conversation_id IN ({marks}) "
        "AND condensed_summary IS NOT NULL AND TRIM(condensed_summary) != ''",
        tuple(ids),
    )}
    for row in rows:
        row["has_condensed_summary"] = row["id"] in with_summary
    return rows


def link(conn, payload: dict) -> dict:
    payload = payload if isinstance(payload, dict) else {}
    a, b = _pair(payload.get("a"), payload.get("b"))
    _require_conversations(conn, (a, b))
    conn.execute(
        "INSERT OR IGNORE INTO udb.conversation_links (conversation_a, conversation_b, linked_at) "
        "VALUES (?, ?, ?)",
        (a, b, time.time()),
    )
    conn.commit()
    return {"ok": True}


def unlink(conn, a, b) -> dict:
    a, b = _pair(a, b)
    conn.execute(
        "DELETE FROM udb.conversation_links WHERE conversation_a = ? AND conversation_b = ?",
        (a, b),
    )
    conn.commit()
    return {"ok": True}
