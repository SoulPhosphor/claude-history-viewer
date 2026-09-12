"""Reusable logic for conditional bulk labeling.

A deliberately narrow selection tool: it can only Set Label To (a label, or
Blank). It never deletes, archives, moves, or renames. All populated criteria
are combined with AND. Batches are deterministic — a stable id tie-breaker is
always appended to the ordering.

As with the other API-logic modules, these functions take an open connection
(user-data DB attached as ``udb``) and return JSON-able dicts; error cases raise
``ApiError``. The caller (server.py) owns opening/closing the connection.
"""
from __future__ import annotations
import datetime
import json
import re
import sqlite3
import time
import uuid

from api_common import ApiError

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Recent Bulk Changes: how many rows to keep/show. Default 5, user-adjustable.
BULK_HISTORY_DEFAULT = 5


def _bulk_epoch_day(s):
    """Local-midnight epoch for a YYYY-MM-DD string, else None. Dates are
    interpreted in local time to match the dates the UI shows."""
    s = str(s or "").strip()
    if not _DATE_RE.match(s):
        return None
    try:
        y, m, d = (int(x) for x in s.split("-"))
        return datetime.datetime(y, m, d).timestamp()
    except Exception:
        return None


def _bulk_epoch_next_day(s):
    """Local-midnight epoch of the day AFTER the given date, for building
    half-open [start, end) day ranges."""
    base = _bulk_epoch_day(s)
    if base is None:
        return None
    try:
        y, m, d = (int(x) for x in str(s).split("-"))
        nxt = datetime.date(y, m, d) + datetime.timedelta(days=1)
        return datetime.datetime(nxt.year, nxt.month, nxt.day).timestamp()
    except Exception:
        return None


def _bulk_date_clause(where, params, col, spec):
    """Append a date filter on `col` (create_time / update_time). Missing
    timestamps (0/NULL) never match a date filter."""
    if not isinstance(spec, dict):
        return
    op = str(spec.get("op") or "any").lower()
    if op == "before":
        e = _bulk_epoch_day(spec.get("date"))
        if e is not None:
            where.append(f"({col} > 0 AND {col} < ?)"); params.append(e)
    elif op == "after":
        e = _bulk_epoch_next_day(spec.get("date"))
        if e is not None:
            where.append(f"({col} > 0 AND {col} >= ?)"); params.append(e)
    elif op == "between":
        a = _bulk_epoch_day(spec.get("date"))
        an = _bulk_epoch_next_day(spec.get("date"))
        b = _bulk_epoch_day(spec.get("date2"))
        bn = _bulk_epoch_next_day(spec.get("date2"))
        if a is not None and b is not None:
            start, end = min(a, b), max(an, bn)
            where.append(f"({col} > 0 AND {col} >= ? AND {col} < ?)")
            params += [start, end]


def _build_bulk_query(crit, use_fts=True, noop_target="__none__"):
    """Turn a criteria dict into (where_sql, params, order_sql, limit_n).
    Every criterion is optional; populated ones are ANDed together.

    `noop_target` adds the skip-no-op condition so the limit applies only to
    conversations the operation would actually change:
      • "__none__"  — no condition (count of everything matching).
      • a label id  — exclude conversations already carrying that label.
      • None (Blank) — keep only conversations that currently carry a label
                       (clearing to blank is a no-op on already-blank ones).
    Applying the limit after this exclusion is what makes a repeated rule
    pick up the *next* batch instead of rewriting the same rows."""
    where = ["COALESCE(cm.deleted, 0) = 0"]
    params = []

    prov = str(crit.get("provider") or "all").lower()
    if prov in ("claude", "chatgpt"):
        where.append("c.provider = ?"); params.append(prov)

    _bulk_date_clause(where, params, "c.create_time", crit.get("started"))
    _bulk_date_clause(where, params, "c.update_time", crit.get("ended"))

    label = str(crit.get("label") or "any")
    if label == "blank":
        where.append("c.id NOT IN (SELECT conversation_id FROM udb.conversation_labels)")
    elif label != "any":
        if re.fullmatch(r"[0-9a-f]{32}", label):
            where.append("c.id IN (SELECT conversation_id FROM udb.conversation_labels "
                         "WHERE label_id = ?)"); params.append(label)
        else:
            where.append("0")

    folder = str(crit.get("folder") or "any")
    if folder == "none":
        where.append("c.id NOT IN (SELECT conversation_id FROM udb.folder_items)")
    elif folder != "any":
        if re.fullmatch(r"[0-9a-f]{32}", folder):
            where.append("c.id IN (SELECT conversation_id FROM udb.folder_items "
                         "WHERE folder_id = ?)"); params.append(folder)
        else:
            where.append("0")

    tag = str(crit.get("tag") or "").strip()
    if tag:
        where.append("c.id IN (SELECT conversation_id FROM udb.conversation_tags "
                     "WHERE tag = ?)"); params.append(tag)

    # Keyword reuses the same FTS-then-LIKE behaviour as the main search so
    # there is only one search implementation. len<3 or an FTS parse error
    # falls back to a title/tag LIKE (see bulk_select's retry).
    q = str(crit.get("keyword") or "").strip()
    if q:
        like = f"%{q}%"
        if use_fts and len(q) >= 3:
            where.append(
                "c.id IN ("
                "SELECT conversation_id FROM search_index WHERE search_index MATCH ? "
                "UNION SELECT c2.id FROM conversations c2 "
                "  LEFT JOIN conversation_meta cm2 ON cm2.conversation_id = c2.id "
                "  WHERE COALESCE(cm2.deleted,0)=0 "
                "    AND COALESCE(NULLIF(cm2.custom_title,''), c2.title) LIKE ? "
                "UNION SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?)"
            )
            params += [q, like, like]
        else:
            where.append(
                "(COALESCE(NULLIF(cm.custom_title,''), c.title) LIKE ? "
                "OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?))"
            )
            params += [like, like]

    # Skip-no-op: narrow to rows the target would actually change.
    if noop_target != "__none__":
        if noop_target is None:
            where.append(
                "c.id IN (SELECT conversation_id FROM udb.conversation_labels)"
            )
        else:
            where.append(
                "c.id NOT IN (SELECT conversation_id FROM udb.conversation_labels "
                "WHERE label_id = ?)"
            )
            params.append(noop_target)

    col, direction = {
        "started_asc":  ("c.create_time", "ASC"),
        "started_desc": ("c.create_time", "DESC"),
        "updated_asc":  ("c.update_time", "ASC"),
        "updated_desc": ("c.update_time", "DESC"),
    }.get(str(crit.get("order") or "started_asc"), ("c.create_time", "ASC"))
    # Stable id tie-breaker makes batches deterministic when timestamps tie.
    order_sql = f"ORDER BY {col} {direction}, c.id ASC"

    limit_n = None
    lim = crit.get("limit") or {}
    if isinstance(lim, dict) and lim.get("mode") == "first":
        try:
            n = int(lim.get("n"))
            if n > 0:
                limit_n = n
        except Exception:
            pass
    return " AND ".join(where), params, order_sql, limit_n


def _bulk_select(conn, crit, target_label_id):
    """Resolve the criteria against the target into:
      eligible    — conversations matching the conditions (ignores target),
      not_already  — of those, how many aren't already at the target,
      batch_ids    — the first-N (or all) of `not_already`, in order,
      limit_n      — the first-N limit, or None for "all".
    These are exactly the rows Apply will change. Retries once without FTS if
    the keyword makes SQLite's MATCH raise."""
    FROM = ("FROM conversations c "
            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id WHERE ")
    last_err = None
    for use_fts in (True, False):
        try:
            # Everything matching the conditions (no target exclusion).
            w0, p0, _order0, _lim0 = _build_bulk_query(crit, use_fts)
            eligible = conn.execute("SELECT COUNT(*) " + FROM + w0, p0).fetchone()[0]
            # Matching AND not already at the target — the changeable set.
            w1, p1, order_sql, limit_n = _build_bulk_query(
                crit, use_fts, noop_target=target_label_id
            )
            not_already = conn.execute(
                "SELECT COUNT(*) " + FROM + w1, p1
            ).fetchone()[0]
            sql = "SELECT c.id " + FROM + w1 + " " + order_sql
            p2 = list(p1)
            if limit_n is not None:
                sql += " LIMIT ?"; p2.append(limit_n)
            batch_ids = [r[0] for r in conn.execute(sql, p2).fetchall()]
            return {
                "eligible": eligible, "not_already": not_already,
                "batch_ids": batch_ids, "limit_n": limit_n,
            }
        except sqlite3.OperationalError as e:
            last_err = e
            if use_fts:
                continue
            raise
    raise last_err


def _bulk_target(conn, crit):
    """(label_id|None, name|None) for the Set-Label-To target; None if the
    target names a label that does not exist. Blank clears the label."""
    t = str(crit.get("target") or "blank")
    if t in ("blank", "", "none"):
        return (None, None)
    if not re.fullmatch(r"[0-9a-f]{32}", t):
        return None
    row = conn.execute("SELECT name FROM udb.labels WHERE id = ?", (t,)).fetchone()
    if not row:
        return None
    return (t, row["name"])


def _bulk_write(conn, ids, target_label_id):
    """Apply the target to `ids` — every id is a genuine change because the
    no-op rows were already excluded by _bulk_select. IN clauses / executemany
    are chunked to stay under SQLite's variable limit. The caller owns the
    transaction (commit / rollback)."""
    if not ids:
        return
    CH = 400
    if target_label_id:
        now = time.time()
        for i in range(0, len(ids), CH):
            conn.executemany(
                "INSERT INTO udb.conversation_labels(conversation_id, label_id, assigned_at) "
                "VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET "
                "label_id = excluded.label_id, assigned_at = excluded.assigned_at",
                [(cid, target_label_id, now) for cid in ids[i:i + CH]],
            )
    else:
        for i in range(0, len(ids), CH):
            chunk = ids[i:i + CH]
            marks = ",".join("?" * len(chunk))
            conn.execute(
                f"DELETE FROM udb.conversation_labels WHERE conversation_id IN ({marks})",
                tuple(chunk),
            )


def _bulk_fmt_day(s):
    """YYYY-MM-DD → 'Apr 1' for the readable history summary."""
    try:
        y, m, d = (int(x) for x in str(s).split("-"))
        return f"{datetime.date(y, m, d):%b} {d}"
    except Exception:
        return str(s)


def _bulk_describe(conn, crit):
    """The execution-time, human-readable filter+order summary stored with a
    bulk operation. Resolves label/folder ids to their *current* names and
    stores the text, so the history row stays readable even if a label is
    later renamed or deleted (it is never re-rendered from live ids)."""
    parts = []
    prov = str(crit.get("provider") or "all").lower()
    parts.append({"claude": "Claude", "chatgpt": "ChatGPT"}.get(prov, "All providers"))

    def dpart(spec, name):
        if not isinstance(spec, dict):
            return None
        op = str(spec.get("op") or "any").lower()
        if op == "before" and spec.get("date"):
            return f"{name} before {_bulk_fmt_day(spec['date'])}"
        if op == "after" and spec.get("date"):
            return f"{name} after {_bulk_fmt_day(spec['date'])}"
        if op == "between" and spec.get("date") and spec.get("date2"):
            return (f"{name} {_bulk_fmt_day(spec['date'])}"
                    f"–{_bulk_fmt_day(spec['date2'])}")
        return None

    for p in (dpart(crit.get("started"), "Started"), dpart(crit.get("ended"), "Updated")):
        if p:
            parts.append(p)

    label = str(crit.get("label") or "any")
    if label == "blank":
        parts.append("Blank")
    elif label != "any":
        r = conn.execute("SELECT name FROM udb.labels WHERE id = ?", (label,)).fetchone()
        parts.append(f"Label: {r['name'] if r else 'unknown'}")

    folder = str(crit.get("folder") or "any")
    if folder == "none":
        parts.append("No folder")
    elif folder != "any":
        r = conn.execute("SELECT name FROM udb.folders WHERE id = ?", (folder,)).fetchone()
        parts.append(f"Folder: {r['name'] if r else 'unknown'}")

    tag = str(crit.get("tag") or "").strip()
    if tag:
        parts.append(f"Tag: {tag}")
    kw = str(crit.get("keyword") or "").strip()
    if kw:
        parts.append(f"“{kw}”")

    parts.append({
        "started_asc": "Started oldest first", "started_desc": "Started newest first",
        "updated_asc": "Updated oldest first", "updated_desc": "Updated newest first",
    }.get(str(crit.get("order") or "started_asc"), "Started oldest first"))
    return " · ".join(parts)


def bulk_retention(conn):
    """The Recent-Bulk-Changes retention count (clamped 0..50)."""
    n = BULK_HISTORY_DEFAULT
    try:
        row = conn.execute(
            "SELECT pref_value FROM ui_preferences WHERE pref_key = 'bulkHistoryRetention'"
        ).fetchone()
        if row and row[0] is not None:
            try:
                n = int(json.loads(row[0]))
            except Exception:
                n = int(row[0])
    except (sqlite3.Error, ValueError, TypeError):
        n = BULK_HISTORY_DEFAULT
    return max(0, min(50, n))


def _prune_bulk_history(conn, n):
    """Keep only the newest `n` history rows, dropping the oldest excess."""
    conn.execute(
        "DELETE FROM udb.label_bulk_history WHERE id NOT IN ("
        "SELECT id FROM udb.label_bulk_history "
        "ORDER BY created_at DESC, id DESC LIMIT ?)",
        (max(0, int(n)),),
    )


def _bulk_history_rows(conn, n):
    rows = conn.execute(
        "SELECT id, created_at, criteria_json, description, target_label_id, "
        "target_label_name, limit_used, order_json, eligible_count, changed_count "
        "FROM udb.label_bulk_history ORDER BY created_at DESC, id DESC LIMIT ?",
        (max(0, int(n)),),
    ).fetchall()
    out = []
    for r in rows:
        try:
            crit = json.loads(r["criteria_json"] or "{}")
        except Exception:
            crit = {}
        out.append({
            "id": r["id"], "created_at": r["created_at"],
            "description": r["description"],
            "target_label_id": r["target_label_id"],
            "target_label_name": r["target_label_name"],
            "limit_used": r["limit_used"],
            "eligible_count": r["eligible_count"],
            "changed_count": r["changed_count"],
            "criteria": crit,
        })
    return out


def bulk_preview(conn, crit):
    """Count only — never mutates. Reports the three numbers the UI shows:
    matching, not-already-at-target, and how many this run would change."""
    target = _bulk_target(conn, crit)
    if target is None:
        raise ApiError("Unknown target label", 404)
    target_label_id, target_name = target
    try:
        sel = _bulk_select(conn, crit, target_label_id)
    except sqlite3.Error:
        raise ApiError("Could not evaluate the criteria", 400)
    return {
        "eligible": sel["eligible"],
        "not_already": sel["not_already"],
        "will_change": len(sel["batch_ids"]),
        "limit_n": sel["limit_n"],
        "target_label_id": target_label_id,
        "target_label_name": target_name,
        "target_blank": target_label_id is None,
    }


def bulk_apply(conn, crit):
    """Mutate only here, transactionally: the whole batch writes or nothing
    does. Records one Recent-Bulk-Changes entry and prunes to retention."""
    target = _bulk_target(conn, crit)
    if target is None:
        raise ApiError("Unknown target label", 404)
    target_label_id, target_name = target
    try:
        sel = _bulk_select(conn, crit, target_label_id)
    except sqlite3.Error:
        raise ApiError("Could not evaluate the criteria", 400)
    ids = sel["batch_ids"]
    changed = len(ids)
    desc = _bulk_describe(conn, crit)
    hid = uuid.uuid4().hex
    try:
        _bulk_write(conn, ids, target_label_id)
        conn.execute(
            "INSERT INTO udb.label_bulk_history(id, created_at, criteria_json, description, "
            "target_label_id, target_label_name, limit_used, order_json, "
            "eligible_count, changed_count) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (hid, time.time(), json.dumps(crit, ensure_ascii=False), desc,
             target_label_id, target_name, sel["limit_n"],
             json.dumps(crit.get("order") or "started_asc"),
             sel["eligible"], changed),
        )
        _prune_bulk_history(conn, bulk_retention(conn))
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise ApiError("The operation failed and was rolled back", 500)
    return {
        "eligible": sel["eligible"], "not_already": sel["not_already"],
        "changed": changed, "history_id": hid, "description": desc,
    }


def bulk_history(conn):
    n = bulk_retention(conn)
    return {"history": _bulk_history_rows(conn, n), "retention": n}


def bulk_retention_set(conn, payload):
    """Set the retention count and prune immediately (reducing it drops the
    oldest excess rows). Returns the updated history + retention."""
    try:
        n = int(payload.get("retention"))
    except (TypeError, ValueError):
        raise ApiError("retention must be an integer", 400)
    n = max(0, min(50, n))
    conn.execute(
        "INSERT OR REPLACE INTO ui_preferences(pref_key, pref_value) "
        "VALUES ('bulkHistoryRetention', ?)",
        (json.dumps(n),),
    )
    _prune_bulk_history(conn, n)
    conn.commit()
    return {"history": _bulk_history_rows(conn, n), "retention": n}
