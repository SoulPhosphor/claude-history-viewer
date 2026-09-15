"""Reusable logic for conditional bulk labeling.

A deliberately narrow selection tool: it can only change which labels a
conversation carries (Added / Removed / Cleared). It never deletes, archives,
moves, or renames. All populated criteria are combined with AND. Batches are
deterministic — a stable id tie-breaker is always appended to the ordering.

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

def _build_bulk_query(crit, use_fts=True):
    """Turn a criteria dict into (where_sql, params, order_sql, limit_n)
    for the full eligible set — every criterion is optional; populated
    ones are ANDed together. Never excludes rows the action would treat as
    a no-op; callers that need that (an "All matching" apply, so the limit
    applies only to conversations the write would actually change) AND in
    a clause from _bulk_noop_clause themselves."""
    where = ["COALESCE(cm.deleted, 0) = 0"]
    params = []

    prov = str(crit.get("provider") or "all").lower()
    if prov in ("claude", "chatgpt"):
        where.append("c.provider = ?"); params.append(prov)

    _bulk_date_clause(where, params, "c.create_time", crit.get("started"))
    _bulk_date_clause(where, params, "c.update_time", crit.get("ended"))

    # Labels/folders/tags/keywords are each a list of chip values, OR'd
    # together within the field (any chip matches); an empty list means no
    # filter on that field ("Any"). Fields are still ANDed with each other.
    labels = crit.get("labels")
    labels = labels if isinstance(labels, list) else []
    if labels:
        ors = []
        for lab in labels:
            lab = str(lab)
            if lab == "blank":
                ors.append("c.id NOT IN (SELECT conversation_id FROM udb.conversation_labels)")
            elif re.fullmatch(r"[0-9a-f]{32}", lab):
                ors.append("c.id IN (SELECT conversation_id FROM udb.conversation_labels "
                           "WHERE label_id = ?)"); params.append(lab)
            else:
                ors.append("0")
        where.append("(" + " OR ".join(ors) + ")")

    folders = crit.get("folders")
    folders = folders if isinstance(folders, list) else []
    if folders:
        ors = []
        for fol in folders:
            fol = str(fol)
            if fol == "none":
                ors.append("c.id NOT IN (SELECT conversation_id FROM udb.folder_items)")
            elif re.fullmatch(r"[0-9a-f]{32}", fol):
                ors.append("c.id IN (SELECT conversation_id FROM udb.folder_items "
                           "WHERE folder_id = ?)"); params.append(fol)
            else:
                ors.append("0")
        where.append("(" + " OR ".join(ors) + ")")

    tags = crit.get("tags")
    tags = [str(t).strip() for t in tags if str(t).strip()] if isinstance(tags, list) else []
    if tags:
        marks = ",".join("?" * len(tags))
        where.append("c.id IN (SELECT conversation_id FROM udb.conversation_tags "
                     f"WHERE tag IN ({marks}))")
        params += tags

    # Keyword reuses the same FTS-then-LIKE behaviour as the main search so
    # there is only one search implementation. len<3 or an FTS parse error
    # falls back to a title/tag LIKE (see _bulk_run's retry). Multiple
    # keyword chips are OR'd together.
    keywords = crit.get("keywords")
    keywords = [str(k).strip() for k in keywords if str(k).strip()] if isinstance(keywords, list) else []
    if keywords:
        ors = []
        for q in keywords:
            like = f"%{q}%"
            if use_fts and len(q) >= 3:
                ors.append(
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
                ors.append(
                    "(COALESCE(NULLIF(cm.custom_title,''), c.title) LIKE ? "
                    "OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?))"
                )
                params += [like, like]
        where.append("(" + " OR ".join(ors) + ")")

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

def _bulk_action_targets(conn, crit):
    """Resolve the criteria's action into (action, mode, ids_names):
      action    — "added", "removed", or "cleared".
      mode      — "all" (every current label def) or "specific".
      ids_names — [(label_id, name), ...] the action actually touches;
                  empty for "cleared" (it never targets specific labels).
    Unknown/deleted label ids in label_targets are silently dropped rather
    than failing — a saved Unfinished Label Run must keep working even if
    a label it names is later renamed or deleted; the caller decides
    whether an empty result is worth rejecting (only relevant when the
    run/apply is first created, from live, user-picked ids)."""
    action = str(crit.get("label_action") or "added").lower()
    if action not in ("added", "removed", "cleared"):
        action = "added"
    if action == "cleared":
        return action, "all", []
    raw = crit.get("label_targets")
    raw = raw if isinstance(raw, list) else []
    if "all" in [str(t) for t in raw]:
        rows = conn.execute("SELECT id, name FROM udb.labels").fetchall()
        return action, "all", [(r["id"], r["name"]) for r in rows]
    ids_names = []
    for t in raw:
        t = str(t)
        if not re.fullmatch(r"[0-9a-f]{32}", t):
            continue
        row = conn.execute("SELECT name FROM udb.labels WHERE id = ?", (t,)).fetchone()
        if row:
            ids_names.append((t, row["name"]))
    return action, "specific", ids_names

def _bulk_noop_clause(action, ids_names):
    """(sql, params) that is true for a conversation the action would NOT
    change — already in the target state — or None if there's nothing to
    exclude (an Added/Removed with no resolved target labels can never
    change anything, so every eligible row would be a no-op; callers treat
    that as "nothing to skip" and just get zero out of the not-already
    count naturally). Never has a leading AND — callers wrap it."""
    ids = [i for i, _ in ids_names]
    if action == "cleared":
        return "c.id NOT IN (SELECT conversation_id FROM udb.conversation_labels)", []
    if not ids:
        return None
    marks = ",".join("?" * len(ids))
    if action == "added":
        # No-op: the conversation already carries every one of these.
        return (
            f"(SELECT COUNT(DISTINCT label_id) FROM udb.conversation_labels "
            f"WHERE conversation_id = c.id AND label_id IN ({marks})) = {len(ids)}",
            list(ids),
        )
    # action == "removed": no-op if the conversation carries none of these.
    return (
        f"c.id NOT IN (SELECT conversation_id FROM udb.conversation_labels "
        f"WHERE label_id IN ({marks}))",
        list(ids),
    )

def _bulk_action_summary(action, mode, ids_names):
    """Frozen, human-readable "Labels should be" line — e.g. "Added:
    Housing, Research", "Removed: All", "Cleared"."""
    word = {"added": "Added", "removed": "Removed", "cleared": "Cleared"}[action]
    if action == "cleared":
        return word
    if mode == "all":
        return f"{word}: All"
    names = [n for _, n in ids_names]
    return f"{word}: {', '.join(names)}" if names else f"{word}: (none)"

def _bulk_select(conn, crit, action_spec):
    """Resolve the criteria against the action into:
      eligible    — conversations matching the conditions (action ignored),
      not_already  — of those, how many the action would actually change,
      batch_ids    — the rows Apply will actually write, in order,
      limit_n      — the first-N limit, or None for "all".
    A "First N" limit is a run-style batch: it takes the first N of the
    full eligible set unconditionally, the same rows Continue would take
    next, rather than skipping ones already in the target state — so
    Preview matches what Apply/Continue actually do. "All matching" keeps
    the old not-already-skip behaviour, since it always finishes in one
    shot and skipping no-ops there is a pure efficiency win with no
    behaviour difference for the caller. Retries once without FTS if the
    keyword makes SQLite's MATCH raise."""
    action, _mode, ids_names = action_spec
    noop = _bulk_noop_clause(action, ids_names)
    FROM = ("FROM conversations c "
            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id WHERE ")
    last_err = None
    for use_fts in (True, False):
        try:
            # Everything matching the conditions (action ignored).
            w0, p0, order_sql, limit_n = _build_bulk_query(crit, use_fts)
            eligible = conn.execute("SELECT COUNT(*) " + FROM + w0, p0).fetchone()[0]
            # Matching AND the action would actually change it.
            if noop:
                noop_sql, noop_params = noop
                w1, p1 = w0 + f" AND NOT ({noop_sql})", p0 + noop_params
            else:
                w1, p1 = w0, p0
            not_already = conn.execute(
                "SELECT COUNT(*) " + FROM + w1, p1
            ).fetchone()[0]
            if limit_n is not None:
                sql = "SELECT c.id " + FROM + w0 + " " + order_sql + " LIMIT ?"
                batch_ids = [r[0] for r in conn.execute(sql, (*p0, limit_n)).fetchall()]
            else:
                sql = "SELECT c.id " + FROM + w1 + " " + order_sql
                batch_ids = [r[0] for r in conn.execute(sql, p1).fetchall()]
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

def _bulk_eligible_ids(conn, crit):
    """The full ordered set of conversations matching the criteria, target
    ignored — the frozen list an Unfinished Label Run is built from and
    sliced against on every Continue. Retries once without FTS, like the
    other bulk helpers, if the keyword makes SQLite's MATCH raise."""
    FROM = ("FROM conversations c "
            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id WHERE ")
    last_err = None
    for use_fts in (True, False):
        try:
            where, params, order_sql, _limit_n = _build_bulk_query(crit, use_fts)
            sql = "SELECT c.id " + FROM + where + " " + order_sql
            return [r[0] for r in conn.execute(sql, params).fetchall()]
        except sqlite3.OperationalError as e:
            last_err = e
            if use_fts:
                continue
            raise
    raise last_err

def _bulk_page(conn, crit, action_spec, offset, limit):
    """One page of the batch, resolved entirely in SQL.

    _bulk_select materializes every id because Apply needs them all. A
    preview only ever shows a page at a time, so this counts with COUNT(*)
    and fetches with LIMIT/OFFSET instead — otherwise each "Load more" would
    re-materialize the whole history. Returns (rows, total), where total is
    the size of the batch the run would change. Retries once without FTS,
    like _bulk_select, if the keyword makes SQLite's MATCH raise."""
    action, _mode, ids_names = action_spec
    # A "First N" limit is a run-style batch: the page is the first N of
    # the full eligible set (matches _bulk_select), not the
    # would-actually-change set. "All matching" keeps the old
    # not-already-skip behaviour.
    noop = None if (crit.get("limit") or {}).get("mode") == "first" \
        else _bulk_noop_clause(action, ids_names)
    FROM = ("FROM conversations c "
            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id WHERE ")
    last_err = None
    for use_fts in (True, False):
        try:
            where, params, order_sql, limit_n = _build_bulk_query(crit, use_fts)
            if noop:
                noop_sql, noop_params = noop
                where, params = where + f" AND NOT ({noop_sql})", params + noop_params
            total = conn.execute(
                "SELECT COUNT(*) " + FROM + where, params
            ).fetchone()[0]
            # A first-N limit caps the batch, and so the page too.
            if limit_n is not None:
                total = min(total, limit_n)
            page_n = min(limit, max(0, total - offset))
            if page_n <= 0:
                return [], total
            rows = conn.execute(
                "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
                "c.create_time, c.update_time, c.message_count, c.preview "
                + FROM + where + " " + order_sql + " LIMIT ? OFFSET ?",
                (*params, page_n, offset),
            ).fetchall()
            return [dict(r) for r in rows], total
        except sqlite3.OperationalError as e:
            last_err = e
            if use_fts:
                continue
            raise
    raise last_err

def _bulk_write(conn, ids, action_spec):
    """Apply the action to `ids` — Added/Removed touch only the resolved
    target labels (existing labels the batch already carries are left
    alone), Cleared wipes every label the batch carries. IN clauses /
    executemany are chunked to stay under SQLite's variable limit. The
    caller owns the transaction (commit / rollback)."""
    if not ids:
        return
    action, _mode, ids_names = action_spec
    target_ids = [i for i, _ in ids_names]
    CH = 400
    now = time.time()
    for i in range(0, len(ids), CH):
        chunk = ids[i:i + CH]
        marks = ",".join("?" * len(chunk))
        if action == "cleared":
            conn.execute(
                f"DELETE FROM udb.conversation_labels WHERE conversation_id IN ({marks})",
                tuple(chunk),
            )
        elif action == "removed":
            if not target_ids:
                continue
            tmarks = ",".join("?" * len(target_ids))
            conn.execute(
                f"DELETE FROM udb.conversation_labels WHERE conversation_id IN ({marks}) "
                f"AND label_id IN ({tmarks})",
                tuple(chunk) + tuple(target_ids),
            )
        elif action == "added" and target_ids:
            conn.executemany(
                "INSERT OR IGNORE INTO udb.conversation_labels"
                "(conversation_id, label_id, assigned_at) VALUES (?, ?, ?)",
                [(cid, lid, now) for cid in chunk for lid in target_ids],
            )

def _bulk_fmt_day(s):
    """YYYY-MM-DD → 'Apr 1' for the readable history summary."""
    try:
        y, m, d = (int(x) for x in str(s).split("-"))
        return f"{datetime.date(y, m, d):%b} {d}"
    except Exception:
        return str(s)

def _bulk_label_names(conn, labels):
    """Resolve a list of label chip values (ids, or 'blank') to display
    names, dropping ones with no meaning; a deleted label reads 'unknown'
    rather than vanishing, so old runs/history stay honest about intent."""
    out = []
    for lab in labels if isinstance(labels, list) else []:
        lab = str(lab)
        if lab == "blank":
            out.append("Blank")
        elif re.fullmatch(r"[0-9a-f]{32}", lab):
            r = conn.execute("SELECT name FROM udb.labels WHERE id = ?", (lab,)).fetchone()
            if r is None:
                out.append("unknown")
            else:
                out.append(str(r["name"] or "").strip() or "(unnamed)")
    return out

def _bulk_folder_names(conn, folders):
    out = []
    for fol in folders if isinstance(folders, list) else []:
        fol = str(fol)
        if fol == "none":
            out.append("No folder")
        elif re.fullmatch(r"[0-9a-f]{32}", fol):
            r = conn.execute("SELECT name FROM udb.folders WHERE id = ?", (fol,)).fetchone()
            out.append(r["name"] if r else "unknown")
    return out

_BULK_ORDER_LABELS = {
    "started_asc": "Started oldest first", "started_desc": "Started newest first",
    "updated_asc": "Last Message oldest first", "updated_desc": "Last Message newest first",
}

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

    for p in (dpart(crit.get("started"), "Started"), dpart(crit.get("ended"), "Last Message")):
        if p:
            parts.append(p)

    label_names = _bulk_label_names(conn, crit.get("labels"))
    if label_names:
        parts.append(f"Has Label: {', '.join(label_names)}")

    folder_names = _bulk_folder_names(conn, crit.get("folders"))
    if folder_names:
        parts.append(f"Folder: {', '.join(folder_names)}")

    tags = [str(t).strip() for t in (crit.get("tags") or []) if str(t).strip()]
    if tags:
        parts.append(f"Tag: {', '.join(tags)}")
    keywords = [str(k).strip() for k in (crit.get("keywords") or []) if str(k).strip()]
    if keywords:
        parts.append(f"Keyword: {', '.join(keywords)}")

    parts.append(_BULK_ORDER_LABELS.get(
        str(crit.get("order") or "started_asc"), "Started oldest first"))
    return " · ".join(parts)

def _bulk_criteria_lines(conn, crit):
    """A read-only "Criteria:" line list for a saved Unfinished Label Run,
    frozen at creation time (label/folder names resolved then, so a later
    rename or deletion never rewrites what the run says it selected)."""
    lines = []
    prov = str(crit.get("provider") or "all").lower()
    lines.append(("Provider", {"claude": "Claude", "chatgpt": "ChatGPT"}.get(prov, "All")))

    def dval(spec):
        if not isinstance(spec, dict):
            return "Any"
        op = str(spec.get("op") or "any").lower()
        if op == "before" and spec.get("date"):
            return f"Before {_bulk_fmt_day(spec['date'])}"
        if op == "after" and spec.get("date"):
            return f"After {_bulk_fmt_day(spec['date'])}"
        if op == "between" and spec.get("date") and spec.get("date2"):
            return f"{_bulk_fmt_day(spec['date'])} - {_bulk_fmt_day(spec['date2'])}"
        return "Any"

    lines.append(("Started", dval(crit.get("started"))))
    lines.append(("Last Message", dval(crit.get("ended"))))

    label_names = _bulk_label_names(conn, crit.get("labels"))
    lines.append(("Has Label", ", ".join(label_names) if label_names else "Any"))

    tags = [str(t).strip() for t in (crit.get("tags") or []) if str(t).strip()]
    lines.append(("Tag", ", ".join(tags) if tags else "Any"))

    folder_names = _bulk_folder_names(conn, crit.get("folders"))
    lines.append(("Folder", ", ".join(folder_names) if folder_names else "Any"))

    keywords = [str(k).strip() for k in (crit.get("keywords") or []) if str(k).strip()]
    lines.append(("Keyword", ", ".join(keywords) if keywords else "Any"))

    lines.append(("Order", _BULK_ORDER_LABELS.get(
        str(crit.get("order") or "started_asc"), "Started oldest first")))

    action, mode, ids_names = _bulk_action_targets(conn, crit)
    lines.append(("Labels should be", _bulk_action_summary(action, mode, ids_names)))
    return lines

# Recent Bulk Changes: how many rows to keep/show. Default 5, user-adjustable.
BULK_HISTORY_DEFAULT = 5

def _bulk_retention(conn):
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
        "SELECT id, created_at, criteria_json, description, label_action, "
        "action_summary, limit_used, order_json, eligible_count, changed_count "
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
            "label_action": r["label_action"],
            # A row recorded before this action model existed has no
            # frozen summary; fall back to something rather than blank.
            "action_summary": r["action_summary"] or "(bulk change)",
            "limit_used": r["limit_used"],
            "eligible_count": r["eligible_count"],
            "changed_count": r["changed_count"],
            "criteria": crit,
        })
    return out

def _bulk_validate_action(action, mode, ids_names):
    """Error string, or None if the action is well-formed enough to run.
    Added/Removed need at least one label actually resolved (either a
    specific chip whose label still exists, or "All" with at least one
    label defined) — an empty target can never change anything."""
    if action != "cleared" and not ids_names:
        return "Which labels it should apply to: choose at least one label, or All."
    return None


def bulk_preview(conn, crit):
    """Count only — never mutates. Reports the three numbers the UI shows:
    matching, would-actually-change, and how many this run would change."""
    action_spec = _bulk_action_targets(conn, crit)
    err = _bulk_validate_action(*action_spec)
    if err:
        raise ApiError(err, 400)
    try:
        sel = _bulk_select(conn, crit, action_spec)
    except sqlite3.Error:
        raise ApiError("Could not evaluate the criteria", 400)
    action, mode, ids_names = action_spec
    return {
        "eligible": sel["eligible"],
        "not_already": sel["not_already"],
        "will_change": len(sel["batch_ids"]),
        "limit_n": sel["limit_n"],
        "label_action": action,
        "action_summary": _bulk_action_summary(action, mode, ids_names),
    }


def bulk_preview_page(conn, payload):
    """The batch itself, as conversation rows the sidebar can render.

    This is what makes Preview *apply* the criteria: the sidebar shows the
    exact conversations this run would change, in the order the run would take
    them, instead of only a count. Never mutates. Body is the same criteria
    object as bulk_preview, plus optional limit/offset for paging.

    The one function here that does not return a ready-to-send body: the
    sidebar rows go out through server.py's shared conversation-list renderer,
    so this returns (rows, total, offset, limit, provider) for it to send."""
    crit = payload.get("criteria") if isinstance(payload.get("criteria"), dict) else payload
    try:
        limit = max(1, min(200, int(payload.get("limit") or 50)))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(payload.get("offset") or 0))
    except (TypeError, ValueError):
        offset = 0
    action_spec = _bulk_action_targets(conn, crit)
    try:
        rows, total = _bulk_page(conn, crit, action_spec, offset, limit)
    except sqlite3.Error:
        raise ApiError("Could not evaluate the criteria", 400)
    prov = str(crit.get("provider") or "all").lower()
    return (rows, total, offset, limit,
            prov if prov in ("claude", "chatgpt") else None)


def bulk_apply(conn, crit):
    """Mutate only here, transactionally. A "First N" limit that doesn't cover
    every eligible conversation saves an Unfinished Label Run instead of
    logging straight to Recent Bulk Changes — see bulk_run_continue for how it
    is carried forward. Everything else (an "All matching" apply, or a "First
    N" that happens to cover everything) completes in one shot and logs
    directly, as before."""
    action_spec = _bulk_action_targets(conn, crit)
    err = _bulk_validate_action(*action_spec)
    if err:
        raise ApiError(err, 400)
    action, mode, ids_names = action_spec
    action_summary = _bulk_action_summary(action, mode, ids_names)
    try:
        sel = _bulk_select(conn, crit, action_spec)
    except sqlite3.Error:
        raise ApiError("Could not evaluate the criteria", 400)
    ids = sel["batch_ids"]
    changed = len(ids)
    desc = _bulk_describe(conn, crit)

    if sel["limit_n"] is not None and changed < sel["eligible"]:
        # Partial "First N": freeze the full ordered eligible set and
        # save it as an Unfinished Label Run instead of completing.
        try:
            all_ids = _bulk_eligible_ids(conn, crit)
        except sqlite3.Error:
            raise ApiError("Could not evaluate the criteria", 400)
        rid = uuid.uuid4().hex
        lines = _bulk_criteria_lines(conn, crit)
        order_desc = _BULK_ORDER_LABELS.get(
            str(crit.get("order") or "started_asc"), "Started oldest first")
        try:
            _bulk_write(conn, ids, action_spec)
            conn.execute(
                "INSERT INTO udb.label_bulk_runs(id, created_at, criteria_json, "
                "criteria_lines_json, order_desc, label_action, action_summary, "
                "total_qualifying, completed_count, batch_size, ids_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (rid, time.time(), json.dumps(crit, ensure_ascii=False),
                 json.dumps(lines, ensure_ascii=False), order_desc,
                 action, action_summary, sel["eligible"], changed,
                 sel["limit_n"], json.dumps(all_ids)),
            )
            conn.commit()
        except sqlite3.Error:
            conn.rollback()
            raise ApiError("The operation failed and was rolled back", 500)
        return {
            "eligible": sel["eligible"], "not_already": sel["not_already"],
            "changed": changed, "description": desc, "action_summary": action_summary,
            "run_id": rid, "run_complete": False,
        }

    hid = uuid.uuid4().hex
    try:
        _bulk_write(conn, ids, action_spec)
        conn.execute(
            "INSERT INTO udb.label_bulk_history(id, created_at, criteria_json, description, "
            "label_action, action_summary, limit_used, order_json, "
            "eligible_count, changed_count) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (hid, time.time(), json.dumps(crit, ensure_ascii=False), desc,
             action, action_summary, sel["limit_n"],
             json.dumps(crit.get("order") or "started_asc"),
             sel["eligible"], changed),
        )
        _prune_bulk_history(conn, _bulk_retention(conn))
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise ApiError("The operation failed and was rolled back", 500)
    return {
        "eligible": sel["eligible"], "not_already": sel["not_already"],
        "changed": changed, "history_id": hid, "description": desc,
        "action_summary": action_summary, "run_complete": True,
    }


def bulk_run_list(conn):
    """The saved Unfinished Label Runs, newest first."""
    rows = conn.execute(
        "SELECT id, created_at, criteria_lines_json, label_action, action_summary, "
        "total_qualifying, completed_count, batch_size "
        "FROM udb.label_bulk_runs ORDER BY created_at DESC, id DESC"
    ).fetchall()
    out = []
    for r in rows:
        try:
            lines = json.loads(r["criteria_lines_json"] or "[]")
        except Exception:
            lines = []
        out.append({
            "id": r["id"], "created_at": r["created_at"],
            "criteria_lines": lines,
            "label_action": r["label_action"],
            "action_summary": r["action_summary"] or "(bulk change)",
            "total_qualifying": r["total_qualifying"],
            "completed_count": r["completed_count"],
            "batch_size": r["batch_size"],
        })
    return {"runs": out}


def bulk_run_continue(conn, payload):
    """Process the run's next batch: the same saved action, applied
    unconditionally to the next `batch_size` ids in the run's frozen
    order, starting right after completed_count. Never re-evaluates the
    original criteria or looks at the conversations' current labels —
    only the frozen list and the completed count decide what happens
    next. Target label ids are re-resolved from the frozen criteria each
    time only so a rename or deletion since the run started doesn't break
    the write (a vanished label is just dropped from the write, per
    _bulk_action_targets); the frozen action_summary/criteria_lines shown
    to the user never change. Finishing the list removes the run and logs
    one Recent-Bulk-Changes entry for the whole thing."""
    rid = str(payload.get("id") or "")
    row = conn.execute(
        "SELECT * FROM udb.label_bulk_runs WHERE id = ?", (rid,)
    ).fetchone()
    if not row:
        raise ApiError("Run not found", 404)
    try:
        batch_size = int(payload.get("batch_size"))
        if batch_size < 1:
            raise ValueError
    except (TypeError, ValueError):
        batch_size = max(1, int(row["batch_size"] or 1))
    try:
        ids = json.loads(row["ids_json"] or "[]")
    except Exception:
        ids = []
    try:
        crit = json.loads(row["criteria_json"] or "{}")
    except Exception:
        crit = {}
    action_spec = _bulk_action_targets(conn, crit)
    completed = int(row["completed_count"] or 0)
    total = int(row["total_qualifying"] or len(ids))
    batch = ids[completed:completed + batch_size]
    changed = len(batch)
    new_completed = completed + changed
    try:
        _bulk_write(conn, batch, action_spec)
        if new_completed >= total or not batch:
            desc = _bulk_describe(conn, crit)
            hid = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO udb.label_bulk_history(id, created_at, criteria_json, "
                "description, label_action, action_summary, limit_used, "
                "order_json, eligible_count, changed_count) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (hid, time.time(), row["criteria_json"], desc,
                 row["label_action"], row["action_summary"], batch_size,
                 json.dumps(crit.get("order") or "started_asc"), total, total),
            )
            conn.execute("DELETE FROM udb.label_bulk_runs WHERE id = ?", (rid,))
            _prune_bulk_history(conn, _bulk_retention(conn))
            conn.commit()
            return {
                "complete": True, "changed": changed, "history_id": hid,
                "completed_count": total, "total_qualifying": total,
            }
        conn.execute(
            "UPDATE udb.label_bulk_runs SET completed_count = ?, batch_size = ? "
            "WHERE id = ?",
            (new_completed, batch_size, rid),
        )
        conn.commit()
        return {
            "complete": False, "changed": changed,
            "completed_count": new_completed, "total_qualifying": total,
            "batch_size": batch_size,
        }
    except sqlite3.Error:
        conn.rollback()
        raise ApiError("The operation failed and was rolled back", 500)


def bulk_run_delete(conn, run_id):
    """Delete only the saved run/progress — never touches any conversation
    or the labels already applied by batches this run already processed."""
    conn.execute("DELETE FROM udb.label_bulk_runs WHERE id = ?", (run_id,))
    conn.commit()
    return {"ok": True}


def bulk_history(conn):
    n = _bulk_retention(conn)
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
