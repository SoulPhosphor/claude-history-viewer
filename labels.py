"""Reusable logic for the conversation-labeling feature.

The label data model: a small set of user-defined labels (name + colour + cycle
order) and a single optional label per conversation. These functions take an
open SQLite connection (with the user-data DB attached as ``udb``) and return
plain JSON-able dicts — exactly the bodies the HTTP handlers send. They never
touch the request handler; validation failures raise ``ApiError``.
"""
from __future__ import annotations
import re
import time
import uuid

from api_common import ApiError

_LABEL_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def norm_label_color(value, default="#888888"):
    s = str(value or "").strip()
    return s if _LABEL_COLOR_RE.match(s) else default


def labels_with_counts(conn):
    """Every label in cycle order, each with how many conversations use it."""
    rows = conn.execute(
        "SELECT l.id, l.name, l.color, l.sort_index, l.created_at, l.updated_at, "
        "       COUNT(cl.conversation_id) AS count "
        "FROM udb.labels l "
        "LEFT JOIN udb.conversation_labels cl ON cl.label_id = l.id "
        "GROUP BY l.id "
        "ORDER BY l.sort_index ASC, LOWER(l.name) ASC"
    ).fetchall()
    return [{
        "id":         r["id"],
        "name":       r["name"],
        "color":      r["color"],
        "sort_index": r["sort_index"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "count":      r["count"],
    } for r in rows]


def list_labels(conn):
    return {"labels": labels_with_counts(conn)}


def create_label(conn, payload):
    name = " ".join(str(payload.get("name") or "").split())[:60]
    if not name:
        raise ApiError("name is required", 400)
    color = norm_label_color(payload.get("color"))
    now = time.time()
    # New labels append to the end of the cycle order.
    row = conn.execute(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 AS next FROM udb.labels"
    ).fetchone()
    sort_index = row["next"] if row else 0
    lid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO udb.labels(id, name, color, sort_index, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (lid, name, color, sort_index, now, now),
    )
    conn.commit()
    return {"labels": labels_with_counts(conn), "id": lid}


def update_label(conn, lid, payload):
    lid = (lid or "").strip()
    sets, params = [], []
    if "name" in payload:
        name = " ".join(str(payload.get("name") or "").split())[:60]
        if not name:
            raise ApiError("name cannot be empty", 400)
        sets.append("name = ?"); params.append(name)
    if "color" in payload:
        sets.append("color = ?"); params.append(norm_label_color(payload.get("color")))
    if not sets:
        raise ApiError("nothing to update", 400)
    if not conn.execute("SELECT 1 FROM udb.labels WHERE id = ?", (lid,)).fetchone():
        raise ApiError("Unknown label", 404)
    sets.append("updated_at = ?"); params.append(time.time())
    params.append(lid)
    conn.execute(f"UPDATE udb.labels SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    return {"labels": labels_with_counts(conn)}


def delete_label(conn, lid):
    """Delete a label. Any conversation carrying it falls back to blank
    (its assignment row is removed) — never silently reassigned to another
    label."""
    lid = (lid or "").strip()
    if not conn.execute("SELECT 1 FROM udb.labels WHERE id = ?", (lid,)).fetchone():
        raise ApiError("Unknown label", 404)
    cur = conn.execute(
        "DELETE FROM udb.conversation_labels WHERE label_id = ?", (lid,)
    )
    cleared = cur.rowcount if cur.rowcount is not None else 0
    conn.execute("DELETE FROM udb.labels WHERE id = ?", (lid,))
    conn.commit()
    return {"labels": labels_with_counts(conn), "cleared": cleared}


def reorder_labels(conn, payload):
    """Set the cycle order from a full list of label ids. Ids not present
    keep their existing order after the ones given."""
    order = payload.get("order")
    if not isinstance(order, list):
        raise ApiError("order must be a list of label ids", 400)
    now = time.time()
    known = {r["id"] for r in conn.execute("SELECT id FROM udb.labels").fetchall()}
    idx = 0
    for lid in order:
        lid = str(lid)
        if lid not in known:
            continue
        conn.execute(
            "UPDATE udb.labels SET sort_index = ?, updated_at = ? WHERE id = ?",
            (idx, now, lid),
        )
        idx += 1
    conn.commit()
    return {"labels": labels_with_counts(conn)}


def conv_label(conn, conv_id):
    """The label a conversation currently carries, or None (the blank
    state). Shape matches what the sidebar/header square renders."""
    row = conn.execute(
        "SELECT l.id, l.name, l.color FROM udb.conversation_labels cl "
        "JOIN udb.labels l ON l.id = cl.label_id "
        "WHERE cl.conversation_id = ?",
        (conv_id,),
    ).fetchone()
    return ({"id": row["id"], "name": row["name"], "color": row["color"]}
            if row else None)


def get_conv_label(conn, conv_id):
    """The conversation's current label (or null). Lets the header re-read a
    single conversation's assignment after a bulk/restore without refetching
    its whole message list."""
    conv_id = (conv_id or "").strip()
    return {"conv_id": conv_id, "label": conv_label(conn, conv_id)}


def set_conv_label(conn, payload):
    """Set (or clear) a conversation's single label. A falsy label_id
    clears it back to blank — the assignment row is removed, never swapped
    for a placeholder label."""
    conv_id = str(payload.get("conv_id") or "").strip()
    raw = payload.get("label_id")
    label_id = str(raw).strip() if raw else ""
    if not conv_id:
        raise ApiError("conv_id is required", 400)
    if not conn.execute(
        "SELECT 1 FROM conversations WHERE id = ?", (conv_id,)
    ).fetchone():
        raise ApiError("Unknown conversation", 404)
    if label_id:
        if not conn.execute(
            "SELECT 1 FROM udb.labels WHERE id = ?", (label_id,)
        ).fetchone():
            raise ApiError("Unknown label", 404)
        conn.execute(
            "INSERT INTO udb.conversation_labels(conversation_id, label_id, assigned_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(conversation_id) DO UPDATE SET "
            "  label_id = excluded.label_id, assigned_at = excluded.assigned_at",
            (conv_id, label_id, time.time()),
        )
    else:
        conn.execute(
            "DELETE FROM udb.conversation_labels WHERE conversation_id = ?",
            (conv_id,),
        )
    conn.commit()
    return {"conv_id": conv_id, "label": conv_label(conn, conv_id)}
