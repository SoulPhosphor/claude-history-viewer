"""Reusable logic for manual safety snapshots.

A snapshot captures only user-owned mutable metadata (labels, folders, tags,
titles, archive/delete state, pins) — never message content. They are created
only by an explicit button press (never automatically), capped at 10, and
deleted only by the user. Restore is transactional and skips — rather than
inventing — conversations a snapshot references that no longer resolve. The
payload is versioned so future categories can be added.

These functions take an open connection (user-data DB attached as ``udb``) and
return JSON-able dicts; error cases raise ``ApiError``. The caller owns the
connection lifecycle; restore leaves commit/rollback to itself.
"""
from __future__ import annotations
import datetime
import json
import sqlite3
import time
import uuid

from api_common import ApiError

SNAPSHOT_SCHEMA_VERSION = 1
SNAPSHOT_MAX = 10
# The restorable categories, in display order, with human-readable names.
SNAPSHOT_CATEGORIES = [
    ("labels", "Labels"),
    ("folders", "Folders"),
    ("tags", "Tags"),
    ("titles", "Titles"),
    ("meta_state", "Archive/Delete state"),
    ("pins", "Pins"),
]


def _capture_snapshot(conn):
    """Gather the mutable-metadata payload and a per-category count map."""
    def rows(sql):
        return [dict(r) for r in conn.execute(sql).fetchall()]
    label_defs = rows("SELECT id, name, color, sort_index, created_at, updated_at FROM udb.labels")
    label_asg = rows("SELECT conversation_id, label_id, assigned_at FROM udb.conversation_labels")
    folder_defs = rows("SELECT id, name, created_at, updated_at, provider FROM udb.folders")
    folder_mem = rows("SELECT conversation_id, folder_id, added_at, pinned FROM udb.folder_items")
    tags = rows("SELECT conversation_id, tag, added_at FROM udb.conversation_tags")
    titles = rows("SELECT conversation_id, custom_title FROM conversation_meta "
                  "WHERE custom_title IS NOT NULL AND custom_title <> ''")
    meta_state = rows("SELECT conversation_id, archived, deleted FROM conversation_meta "
                      "WHERE COALESCE(archived,0)=1 OR COALESCE(deleted,0)=1")
    pins = rows("SELECT conversation_id, pinned_at, order_index FROM pinned_conversations")
    data = {
        "labels": {"definitions": label_defs, "assignments": label_asg},
        "folders": {"definitions": folder_defs, "memberships": folder_mem},
        "tags": tags,
        "titles": titles,
        "meta_state": meta_state,
        "pins": pins,
    }
    counts = {
        "labels": len(label_defs), "label_assignments": len(label_asg),
        "folders": len(folder_defs), "folder_items": len(folder_mem),
        "tags": len(tags), "titles": len(titles),
        "meta_state": len(meta_state), "pins": len(pins),
    }
    return data, counts


def _snapshot_list(conn):
    rows = conn.execute(
        "SELECT id, name, created_at, schema_version, item_count, payload_size, summary "
        "FROM udb.snapshots ORDER BY created_at DESC, id DESC"
    ).fetchall()
    out = []
    for r in rows:
        try:
            summary = json.loads(r["summary"] or "{}")
        except Exception:
            summary = {}
        out.append({
            "id": r["id"], "name": r["name"], "created_at": r["created_at"],
            "schema_version": r["schema_version"], "item_count": r["item_count"],
            "payload_size": r["payload_size"], "summary": summary,
        })
    return out


def snapshot_list(conn):
    return {"snapshots": _snapshot_list(conn), "max": SNAPSHOT_MAX}


def snapshot_create(conn, payload):
    name = str(payload.get("name") or "").strip()[:120]
    count = conn.execute("SELECT COUNT(*) FROM udb.snapshots").fetchone()[0]
    if count >= SNAPSHOT_MAX:
        # Never auto-delete the oldest; the user must make room.
        raise ApiError(
            f"Maximum of {SNAPSHOT_MAX} snapshots reached. "
            "Delete a snapshot before creating another.",
            409,
        )
    data, counts = _capture_snapshot(conn)
    blob = json.dumps(
        {"version": SNAPSHOT_SCHEMA_VERSION, "categories": counts, "data": data},
        ensure_ascii=False,
    )
    if not name:
        name = "Snapshot " + datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    sid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO udb.snapshots(id, name, created_at, schema_version, payload, "
        "item_count, payload_size, summary) VALUES (?,?,?,?,?,?,?,?)",
        (sid, name, time.time(), SNAPSHOT_SCHEMA_VERSION, blob,
         sum(counts.values()), len(blob.encode("utf-8")),
         json.dumps(counts, ensure_ascii=False)),
    )
    conn.commit()
    return {"snapshots": _snapshot_list(conn), "max": SNAPSHOT_MAX}


def snapshot_delete(conn, sid):
    sid = (sid or "").strip()
    conn.execute("DELETE FROM udb.snapshots WHERE id = ?", (sid,))
    conn.commit()
    return {"snapshots": _snapshot_list(conn), "max": SNAPSHOT_MAX}


def _restore_categories(conn, data, selected):
    """Return each selected category to its recorded state. A conversation
    the snapshot references that no longer exists is skipped (counted), never
    recreated. Caller owns the transaction."""
    valid = {r[0] for r in conn.execute("SELECT id FROM conversations").fetchall()}
    skipped = 0

    if "labels" in selected:
        conn.execute("DELETE FROM udb.conversation_labels")
        conn.execute("DELETE FROM udb.labels")
        def_ids = set()
        for d in (data.get("labels") or {}).get("definitions") or []:
            conn.execute(
                "INSERT INTO udb.labels(id, name, color, sort_index, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (d.get("id"), d.get("name"), d.get("color"), d.get("sort_index") or 0,
                 d.get("created_at"), d.get("updated_at")),
            )
            def_ids.add(d.get("id"))
        for a in (data.get("labels") or {}).get("assignments") or []:
            if a.get("conversation_id") not in valid or a.get("label_id") not in def_ids:
                skipped += 1; continue
            conn.execute(
                "INSERT OR REPLACE INTO udb.conversation_labels(conversation_id, label_id, assigned_at) "
                "VALUES (?,?,?)",
                (a["conversation_id"], a["label_id"], a.get("assigned_at")),
            )

    if "folders" in selected:
        conn.execute("DELETE FROM udb.folder_items")
        conn.execute("DELETE FROM udb.folders")
        fids = set()
        for f in (data.get("folders") or {}).get("definitions") or []:
            conn.execute(
                "INSERT INTO udb.folders(id, name, created_at, updated_at, provider) "
                "VALUES (?,?,?,?,?)",
                (f.get("id"), f.get("name"), f.get("created_at"), f.get("updated_at"),
                 f.get("provider")),
            )
            fids.add(f.get("id"))
        for m in (data.get("folders") or {}).get("memberships") or []:
            if m.get("conversation_id") not in valid or m.get("folder_id") not in fids:
                skipped += 1; continue
            conn.execute(
                "INSERT OR REPLACE INTO udb.folder_items(conversation_id, folder_id, added_at, pinned) "
                "VALUES (?,?,?,?)",
                (m["conversation_id"], m["folder_id"], m.get("added_at"), m.get("pinned") or 0),
            )

    if "tags" in selected:
        conn.execute("DELETE FROM udb.conversation_tags")
        for t in data.get("tags") or []:
            if t.get("conversation_id") not in valid:
                skipped += 1; continue
            conn.execute(
                "INSERT OR REPLACE INTO udb.conversation_tags(conversation_id, tag, added_at) "
                "VALUES (?,?,?)",
                (t["conversation_id"], t["tag"], t.get("added_at")),
            )

    if "titles" in selected:
        # Reset every custom title, then reapply the recorded ones — so titles
        # set after the snapshot are reverted too. Touches only custom_title.
        conn.execute("UPDATE conversation_meta SET custom_title = NULL")
        for ti in data.get("titles") or []:
            cid = ti.get("conversation_id")
            if cid not in valid:
                skipped += 1; continue
            conn.execute(
                "INSERT INTO conversation_meta(conversation_id, custom_title, archived, deleted) "
                "VALUES (?,?,0,0) ON CONFLICT(conversation_id) DO UPDATE SET "
                "custom_title = excluded.custom_title",
                (cid, ti.get("custom_title")),
            )

    if "meta_state" in selected:
        # Reset archive/delete everywhere, then reapply recorded flags. Touches
        # only archived/deleted, never custom_title.
        conn.execute("UPDATE conversation_meta SET archived = 0, deleted = 0")
        for ms in data.get("meta_state") or []:
            cid = ms.get("conversation_id")
            if cid not in valid:
                skipped += 1; continue
            conn.execute(
                "INSERT INTO conversation_meta(conversation_id, custom_title, archived, deleted) "
                "VALUES (?, NULL, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET "
                "archived = excluded.archived, deleted = excluded.deleted",
                (cid, int(bool(ms.get("archived"))), int(bool(ms.get("deleted")))),
            )

    if "pins" in selected:
        conn.execute("DELETE FROM pinned_conversations")
        for p in data.get("pins") or []:
            cid = p.get("conversation_id")
            if cid not in valid:
                skipped += 1; continue
            conn.execute(
                "INSERT OR REPLACE INTO pinned_conversations(conversation_id, pinned_at, order_index) "
                "VALUES (?,?,?)",
                (cid, p.get("pinned_at"), p.get("order_index")),
            )

    return skipped


def snapshot_restore(conn, sid, payload):
    sid = (sid or "").strip()
    valid_cats = {k for k, _ in SNAPSHOT_CATEGORIES}
    req = payload.get("categories")
    if isinstance(req, list):
        selected = [c for c in req if c in valid_cats]
    else:
        selected = list(valid_cats)  # default: all supported categories
    if not selected:
        raise ApiError("Select at least one category to restore.", 400)
    row = conn.execute(
        "SELECT payload, schema_version FROM udb.snapshots WHERE id = ?", (sid,)
    ).fetchone()
    if not row:
        raise ApiError("Unknown snapshot", 404)
    try:
        parsed = json.loads(row["payload"] or "{}")
    except Exception:
        raise ApiError("Snapshot payload is corrupt", 400)
    if int(parsed.get("version") or row["schema_version"] or 0) != SNAPSHOT_SCHEMA_VERSION:
        raise ApiError("Snapshot schema version is not supported", 400)
    data = parsed.get("data") or {}
    try:
        skipped = _restore_categories(conn, data, selected)
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise ApiError("The restore failed and was rolled back", 500)
    return {"ok": True, "skipped": skipped, "restored": selected}
