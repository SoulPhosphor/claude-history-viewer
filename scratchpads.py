"""Scratch Pads: free-standing Markdown documents, plus the lookups their
internal links need.

A Scratch Pad belongs to no conversation and to neither provider. Pads live in
the persistent user-data database (`udb.scratch_pads`), so they survive
history.db being rebuilt. Each pad keeps a generated id that never changes when
it is renamed.

Internal links inside a pad name a conversation by its stable id, and a single
message by that conversation's id plus the message's seq (the same pair a
bookmark stores). `resolve_link` checks such a link still points somewhere;
`link_suggestions` feeds the Insert Link popup.

Every function takes an open connection (from server.open_db, with udb
attached), returns a JSON-able dict, and raises ApiError for an error status.
"""
from __future__ import annotations

import time
import uuid

import message_ids
from api_common import ApiError

DEFAULT_TITLE = "Untitled Scratch Pad"
TITLE_MAX = 200
SUGGEST_CONVERSATIONS = 8
SUGGEST_BOOKMARKS = 6

_COLUMNS = "id, title, content, created_at, updated_at"


def _row(row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _clean_title(value, fallback: str | None = DEFAULT_TITLE) -> str:
    title = " ".join(str(value or "").split())[:TITLE_MAX]
    if not title:
        if fallback is None:
            raise ApiError("A Scratch Pad needs a title.", 400)
        return fallback
    return title


def _like(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _get(conn, pad_id: str):
    row = conn.execute(
        f"SELECT {_COLUMNS} FROM udb.scratch_pads WHERE id = ?", (pad_id,)
    ).fetchone()
    if not row:
        raise ApiError("That Scratch Pad no longer exists.", 404)
    return row


# ── Pads ──────────────────────────────────────────────────────────────────────
def list_pads(conn, q: str = "") -> dict:
    """Every pad, most recently modified first. `q` narrows by title."""
    q = (q or "").strip()
    sql = "SELECT id, title, created_at, updated_at FROM udb.scratch_pads"
    params: tuple = ()
    if q:
        sql += " WHERE title LIKE ? ESCAPE '\\'"
        params = (_like(q),)
    sql += " ORDER BY updated_at DESC, created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    return {"scratch_pads": [dict(r) for r in rows], "q": q}


def get_pad(conn, pad_id: str) -> dict:
    return {"scratch_pad": _row(_get(conn, pad_id))}


def create_pad(conn, payload: dict) -> dict:
    now = time.time()
    pad_id = uuid.uuid4().hex
    title = _clean_title(payload.get("title"))
    content = str(payload.get("content") or "")
    conn.execute(
        "INSERT INTO udb.scratch_pads (id, title, content, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (pad_id, title, content, now, now),
    )
    conn.commit()
    return get_pad(conn, pad_id)


def update_pad(conn, pad_id: str, payload: dict) -> dict:
    """Change the title and/or the content. The id never changes."""
    _get(conn, pad_id)
    sets, params = [], []
    if "title" in payload:
        sets.append("title = ?")
        params.append(_clean_title(payload.get("title"), fallback=None))
    if "content" in payload:
        content = payload.get("content")
        if not isinstance(content, str):
            raise ApiError("Content must be text.", 400)
        sets.append("content = ?")
        params.append(content)
    if sets:
        sets.append("updated_at = ?")
        params.append(time.time())
        conn.execute(
            f"UPDATE udb.scratch_pads SET {', '.join(sets)} WHERE id = ?",
            (*params, pad_id),
        )
        conn.commit()
    return get_pad(conn, pad_id)


def delete_pad(conn, pad_id: str) -> dict:
    _get(conn, pad_id)
    conn.execute("DELETE FROM udb.scratch_pads WHERE id = ?", (pad_id,))
    conn.commit()
    return {"ok": True, "id": pad_id}


def appended_content(content: str, block: str) -> str:
    """`content` with `block` added as its own paragraph at the end."""
    content = content or ""
    if not content.strip():
        return block
    return content.rstrip("\n") + "\n\n" + block


def append_to_pad(conn, pad_id: str, payload: dict) -> dict:
    """Add a Markdown block (one link) to the end of a pad, in one statement,
    so two quick additions can never overwrite each other."""
    block = str(payload.get("markdown") or "").strip("\n")
    if not block.strip():
        raise ApiError("Nothing to add.", 400)
    if "\n" in block:
        raise ApiError("Add one line at a time.", 400)
    _get(conn, pad_id)
    # One UPDATE reads and writes the content, so two overlapping appends (two
    # tabs, two quick clicks) both land. Same rule as appended_content().
    conn.execute(
        "UPDATE udb.scratch_pads SET content = CASE "
        "WHEN TRIM(content, ' ' || char(9) || char(10) || char(13)) = '' THEN ?1 "
        "ELSE RTRIM(content, char(10)) || char(10) || char(10) || ?1 END, "
        "updated_at = ?2 WHERE id = ?3",
        (block, time.time(), pad_id),
    )
    conn.commit()
    data = get_pad(conn, pad_id)
    data["appended"] = block
    return data


# ── Links ─────────────────────────────────────────────────────────────────────
_TITLE_SQL = "COALESCE(NULLIF(cm.custom_title, ''), c.title)"


def link_suggestions(conn, q: str) -> dict:
    """Conversations whose title matches, and named bookmarks whose name
    matches, across both providers. Recycle Bin chats are left out. Titles that
    start with the text come first; ties go to the most recent chat."""
    q = (q or "").strip()
    if not q:
        return {"q": q, "conversations": [], "bookmarks": []}
    like = _like(q)
    prefix = _like(q)[1:]  # "text%": drop the leading wildcard
    conversations = conn.execute(
        f"SELECT c.id, {_TITLE_SQL} AS title, c.provider, c.update_time "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        f"WHERE COALESCE(cm.deleted, 0) = 0 AND {_TITLE_SQL} LIKE ? ESCAPE '\\' "
        f"ORDER BY ({_TITLE_SQL} LIKE ? ESCAPE '\\') DESC, c.update_time DESC "
        "LIMIT ?",
        (like, prefix, SUGGEST_CONVERSATIONS),
    ).fetchall()
    bookmarks = conn.execute(
        f"SELECT b.id, b.name, b.seq, b.conversation_id, {_TITLE_SQL} AS conversation_title, "
        "c.provider, COALESCE(b.message_uuid, (SELECT m.message_uuid FROM messages m "
        "WHERE m.conversation_id = b.conversation_id AND m.seq = b.seq)) AS message_uuid "
        "FROM udb.conversation_bookmarks b "
        "JOIN conversations c ON c.id = b.conversation_id "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE COALESCE(cm.deleted, 0) = 0 AND TRIM(COALESCE(b.name, '')) != '' "
        "AND b.name LIKE ? ESCAPE '\\' "
        "ORDER BY (b.name LIKE ? ESCAPE '\\') DESC, c.update_time DESC, b.seq "
        "LIMIT ?",
        (like, prefix, SUGGEST_BOOKMARKS * 2),
    ).fetchall()
    # A bookmark whose message is gone is not offered as a link target.
    bookmarks = [
        b for b in bookmarks if not message_ids.bookmark_missing(conn, b["conversation_id"], b)
    ][:SUGGEST_BOOKMARKS]
    return {
        "q": q,
        "conversations": [dict(r) for r in conversations],
        "bookmarks": [dict(r) for r in bookmarks],
    }


def resolve_link(conn, conversation_id: str, seq=None, message_id: str = "") -> dict:
    """Where an internal link points now. Never raises for a missing target:
    the caller explains what is gone instead of opening something else.

    A message link that carries the message's export id finds the message by
    that id, so it still lands on the right message if its position moved; the
    seq in the link is only the fallback. The answer's `seq` is where to go."""
    conversation_id = (conversation_id or "").strip()
    if seq in ("", None):
        seq = None
    else:
        try:
            seq = int(seq)
        except (TypeError, ValueError):
            raise ApiError("Invalid message number.", 400)
    if not conversation_id:
        raise ApiError("Missing conversation id.", 400)
    row = conn.execute(
        f"SELECT c.id, {_TITLE_SQL} AS title, c.provider, "
        "COALESCE(cm.deleted, 0) AS deleted, COALESCE(cm.archived, 0) AS archived "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.id = ?",
        (conversation_id,),
    ).fetchone()
    out = {
        "conversation_id": conversation_id,
        "seq": seq,
        "exists": bool(row),
        "message_exists": None,
    }
    if not row:
        return out
    out.update({
        "title": row["title"],
        "provider": row["provider"],
        "deleted": bool(row["deleted"]),
        "archived": bool(row["archived"]),
    })
    message_id = (message_id or "").strip()
    if seq is not None or message_id:
        # By the message's id; its old position is never a stand-in for a
        # message that is gone (message_ids.locate).
        current = message_ids.locate(conn, conversation_id, message_id or None, seq)
        out["message_exists"] = current is not None
        if current is not None:
            seq = current
            out["seq"] = current
        bookmark = None
        if out["message_exists"]:
            bookmark = conn.execute(
                "SELECT name FROM udb.conversation_bookmarks WHERE conversation_id = ? "
                "AND (message_uuid = ? OR (message_uuid IS NULL AND seq = ?)) LIMIT 1",
                (conversation_id, message_ids.message_uuid_at(conn, conversation_id, seq), seq),
            ).fetchone()
        out["bookmark_name"] = (bookmark["name"] or "").strip() if bookmark else ""
    return out
