"""Reusable logic for the conversation-labeling feature.

The label data model: a small set of user-defined labels (name + colour + cycle
order) and, per conversation, any number of them. These functions take an open
SQLite connection (with the user-data DB attached as ``udb``) and return plain
JSON-able dicts — exactly the bodies the HTTP handlers send. They never touch
the request handler; validation failures raise ``ApiError``.

User-configurable labels are stored in the persistent user-data DB (see
`labels` / `conversation_labels` in server._ensure_userdata_schema). A label is
a definition here; a conversation can carry several, and the blank state is the
absence of any assignment. Names have no built-in meaning — the user picks
them, and a name is optional (an unnamed label is a colour-only square) — and
stable ids mean a rename or recolour never moves any conversation off its
labels.
"""
from __future__ import annotations
import re
import time
import uuid

from api_common import ApiError

# Colours are stored as #rgb / #rrggbb and validated before write, so the
# value can be dropped straight into an inline style on the client.
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
    # The name is optional: a label can be a colour-only square. It only
    # ever shows as text when the display mode is "Square + Label".
    name = " ".join(str(payload.get("name") or "").split())[:60]
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
        # Clearing a name back to blank is allowed — the square stays.
        name = " ".join(str(payload.get("name") or "").split())[:60]
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


def conv_labels(conn, conv_id):
    """Every label a conversation carries, in the user's configured order.
    An empty list is the blank state. Shape matches what the sidebar and
    header squares render."""
    rows = conn.execute(
        "SELECT l.id, l.name, l.color FROM udb.conversation_labels cl "
        "JOIN udb.labels l ON l.id = cl.label_id "
        "WHERE cl.conversation_id = ? "
        "ORDER BY l.sort_index ASC, LOWER(l.name) ASC",
        (conv_id,),
    ).fetchall()
    return [{"id": r["id"], "name": r["name"], "color": r["color"]} for r in rows]


def labels_by_conv(conn, ids):
    """Batched conv_labels for a page of conversations: {conv_id: [label]}.
    One query for the whole page, so the sidebar never does an N+1."""
    out = {}
    if not ids:
        return out
    CH = 400
    for i in range(0, len(ids), CH):
        chunk = list(ids[i:i + CH])
        marks = ",".join("?" * len(chunk))
        for r in conn.execute(
            "SELECT cl.conversation_id AS cid, l.id AS id, l.name AS name, "
            "       l.color AS color "
            "FROM udb.conversation_labels cl "
            "JOIN udb.labels l ON l.id = cl.label_id "
            f"WHERE cl.conversation_id IN ({marks}) "
            "ORDER BY l.sort_index ASC, LOWER(l.name) ASC",
            tuple(chunk),
        ).fetchall():
            out.setdefault(r["cid"], []).append(
                {"id": r["id"], "name": r["name"], "color": r["color"]}
            )
    return out


def get_conv_label(conn, conv_id):
    """The conversation's current labels. Lets the header re-read a single
    conversation's assignments after a bulk/restore without refetching its
    whole message list."""
    conv_id = (conv_id or "").strip()
    return {"conv_id": conv_id, "labels": conv_labels(conn, conv_id)}


def set_conv_label(conn, payload):
    """Change which labels a conversation carries. The body names one of:

      {label_id, action: "add" | "remove" | "toggle" | "only"}
        act on that single label ("only" replaces the whole set with it),
      {label_ids: [...]}
        replace the whole set with exactly these,
      {label_id: null}  /  {label_ids: []}
        clear back to blank — the rows are removed, never swapped for a
        placeholder label.

    Always answers with the conversation's full label list."""
    conv_id = str(payload.get("conv_id") or "").strip()
    if not conv_id:
        raise ApiError("conv_id is required", 400)
    raw = payload.get("label_id")
    label_id = str(raw).strip() if raw else ""
    action = str(payload.get("action") or "").strip().lower()
    id_list = payload.get("label_ids")
    if not conn.execute(
        "SELECT 1 FROM conversations WHERE id = ?", (conv_id,)
    ).fetchone():
        raise ApiError("Unknown conversation", 404)
    known = {r["id"] for r in
             conn.execute("SELECT id FROM udb.labels").fetchall()}
    now = time.time()

    def add(lid):
        conn.execute(
            "INSERT OR IGNORE INTO udb.conversation_labels"
            "(conversation_id, label_id, assigned_at) VALUES (?, ?, ?)",
            (conv_id, lid, now),
        )

    def clear():
        conn.execute(
            "DELETE FROM udb.conversation_labels WHERE conversation_id = ?",
            (conv_id,),
        )

    if isinstance(id_list, list):
        wanted = [str(x).strip() for x in id_list if str(x or "").strip()]
        for lid in wanted:
            if lid not in known:
                raise ApiError("Unknown label", 404)
        clear()
        for lid in wanted:
            add(lid)
    elif not label_id:
        # No label named and no list: clear to blank.
        clear()
    else:
        if label_id not in known:
            raise ApiError("Unknown label", 404)
        has = conn.execute(
            "SELECT 1 FROM udb.conversation_labels "
            "WHERE conversation_id = ? AND label_id = ?",
            (conv_id, label_id),
        ).fetchone() is not None
        if action == "remove" or (action == "toggle" and has):
            conn.execute(
                "DELETE FROM udb.conversation_labels "
                "WHERE conversation_id = ? AND label_id = ?",
                (conv_id, label_id),
            )
        elif action == "only":
            clear()
            add(label_id)
        else:  # "add", "toggle" (not present), or no action given
            add(label_id)
    conn.commit()
    return {"conv_id": conv_id, "labels": conv_labels(conn, conv_id)}
