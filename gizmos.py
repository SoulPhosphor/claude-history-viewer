"""Custom GPT (ChatGPT gizmo) data operations.

Names are user-owned metadata in userdata.db; imported gizmo identity stays in
history.db. Nothing here changes message content or provider architecture.
"""
from __future__ import annotations

import time
import uuid

from api_common import ApiError


def _clean_id(value) -> str:
    return str(value or "").strip()


def list_gizmos(conn) -> dict:
    rows = conn.execute(
        "SELECT c.gizmo_id, COALESCE(c.gizmo_type, '') AS gizmo_type, "
        "COUNT(*) AS conversation_count, gn.display_name "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "LEFT JOIN udb.gizmo_names gn ON gn.gizmo_id = c.gizmo_id "
        "WHERE c.provider = 'chatgpt' "
        "AND c.gizmo_id IS NOT NULL AND TRIM(c.gizmo_id) <> '' "
        "AND COALESCE(cm.deleted, 0) = 0 "
        "GROUP BY c.gizmo_id, c.gizmo_type, gn.display_name "
        "ORDER BY COALESCE(NULLIF(gn.display_name, ''), c.gizmo_id) COLLATE NOCASE"
    ).fetchall()
    out = []
    for row in rows:
        samples = conn.execute(
            "SELECT COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title "
            "FROM conversations c "
            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
            "WHERE c.provider = 'chatgpt' AND c.gizmo_id = ? "
            "AND COALESCE(cm.deleted, 0) = 0 "
            "ORDER BY c.update_time DESC, c.create_time DESC LIMIT 3",
            (row["gizmo_id"],),
        ).fetchall()
        out.append({
            "gizmo_id": row["gizmo_id"],
            "gizmo_type": row["gizmo_type"],
            "display_name": row["display_name"] or "",
            "conversation_count": row["conversation_count"],
            "sample_titles": [r["title"] or "Untitled" for r in samples],
        })
    return {"gizmos": out}


def list_conversations(conn, gizmo_id) -> dict:
    gid = _clean_id(gizmo_id)
    if not gid:
        raise ApiError("missing gizmo_id", 400)
    name_row = conn.execute(
        "SELECT display_name FROM udb.gizmo_names WHERE gizmo_id = ?", (gid,)
    ).fetchone()
    rows = conn.execute(
        "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
        "c.create_time, c.update_time, c.message_count, COALESCE(c.gizmo_type, '') AS gizmo_type "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.provider = 'chatgpt' AND c.gizmo_id = ? "
        "AND COALESCE(cm.deleted, 0) = 0 "
        "ORDER BY c.update_time DESC, c.create_time DESC",
        (gid,),
    ).fetchall()
    return {
        "gizmo_id": gid,
        "display_name": name_row["display_name"] if name_row else "",
        "conversations": [dict(r) for r in rows],
    }


def rename_gizmo(conn, gizmo_id, payload) -> dict:
    gid = _clean_id(gizmo_id)
    if not gid:
        raise ApiError("missing gizmo id", 400)
    exists = conn.execute(
        "SELECT 1 FROM conversations WHERE provider = 'chatgpt' AND gizmo_id = ? LIMIT 1",
        (gid,),
    ).fetchone()
    if not exists:
        raise ApiError("Custom GPT not found", 404)
    raw = payload.get("display_name", payload.get("name", ""))
    name = " ".join(str(raw or "").split())[:120]
    if name:
        conn.execute(
            "INSERT INTO udb.gizmo_names(gizmo_id, display_name, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(gizmo_id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at",
            (gid, name, time.time()),
        )
    else:
        conn.execute("DELETE FROM udb.gizmo_names WHERE gizmo_id = ?", (gid,))
    conn.commit()
    return {"ok": True, "gizmo_id": gid, "display_name": name}


def move_to_folder(conn, gizmo_id, payload) -> dict:
    """Move every non-deleted chat for one gizmo into one ChatGPT folder.

    Mirrors the ordinary folder move: loose pins are cleared and archived chats
    are restored. The manager's UI supplies folder_name; folder_id remains
    supported for parity with the original feature, but is provider-validated.
    """
    gid = _clean_id(gizmo_id)
    if not gid:
        raise ApiError("missing gizmo id", 400)
    cids = [r["id"] for r in conn.execute(
        "SELECT c.id FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.provider = 'chatgpt' AND c.gizmo_id = ? "
        "AND COALESCE(cm.deleted, 0) = 0",
        (gid,),
    ).fetchall()]
    if not cids:
        raise ApiError("Custom GPT has no conversations", 404)

    fid = _clean_id(payload.get("folder_id"))
    folder_name = " ".join(str(payload.get("folder_name") or "").split())[:120]
    now = time.time()
    if fid:
        folder = conn.execute(
            "SELECT id, provider FROM udb.folders WHERE id = ?", (fid,)
        ).fetchone()
        if not folder:
            raise ApiError("folder not found", 404)
        if (folder["provider"] or "") != "chatgpt":
            raise ApiError("folder belongs to a different provider", 409)
    else:
        if not folder_name:
            raise ApiError("missing folder_id or folder_name", 400)
        fid = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO udb.folders(id, name, created_at, updated_at, provider) VALUES (?, ?, ?, ?, 'chatgpt')",
            (fid, folder_name, now, now),
        )

    for cid in cids:
        conn.execute(
            "INSERT INTO udb.folder_items(conversation_id, folder_id, added_at, pinned) "
            "VALUES (?, ?, ?, 0) "
            "ON CONFLICT(conversation_id) DO UPDATE SET folder_id=excluded.folder_id, added_at=excluded.added_at, pinned=0",
            (cid, fid, now),
        )
        conn.execute("DELETE FROM pinned_conversations WHERE conversation_id = ?", (cid,))
        conn.execute(
            "INSERT INTO conversation_meta(conversation_id, archived, deleted) VALUES (?, 0, 0) "
            "ON CONFLICT(conversation_id) DO UPDATE SET archived=0",
            (cid,),
        )
    conn.execute("UPDATE udb.folders SET updated_at = ? WHERE id = ?", (now, fid))
    conn.commit()
    return {"ok": True, "folder_id": fid, "moved": len(cids)}
