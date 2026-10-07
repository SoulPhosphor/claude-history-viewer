"""Advanced conversation search and durable recent/saved search state."""

from __future__ import annotations

import json
import re
import time
import uuid
from collections import defaultdict
from functools import lru_cache

from api_common import ApiError


# Text is read only for conversations that already passed every other filter.
# _matching_rows fills this temporary table with their ids before the search.
_IN_SCOPE = " IN (SELECT id FROM temp.advanced_scope)"

TEXT_SOURCES = {
    "titles": (
        "Titles",
        "SELECT c.id AS conversation_id, 'titles' AS source, "
        "COALESCE(NULLIF(cm.custom_title, ''), c.title) AS text, NULL AS seq "
        "FROM conversations c LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.id" + _IN_SCOPE,
    ),
    "user_messages": (
        "User Message",
        "SELECT conversation_id, 'user_messages' AS source, content AS text, seq "
        "FROM messages WHERE role = 'user' AND conversation_id" + _IN_SCOPE,
    ),
    "ai_messages": (
        "AI Message",
        "SELECT conversation_id, 'ai_messages' AS source, content AS text, seq "
        "FROM messages WHERE role IN ('assistant', 'tool') AND conversation_id" + _IN_SCOPE,
    ),
    "attachments": (
        "Attachment",
        "SELECT conversation_id, 'attachments' AS source, ADV_ATTACHMENT_TEXT(attachments) AS text, seq "
        "FROM messages WHERE attachments IS NOT NULL AND TRIM(attachments) != '' "
        "AND conversation_id" + _IN_SCOPE,
    ),
    "summary": (
        "Summary",
        "SELECT conversation_id, 'summary' AS source, summary AS text, NULL AS seq "
        "FROM udb.conversation_summaries WHERE summary IS NOT NULL AND TRIM(summary) != '' "
        "AND conversation_id" + _IN_SCOPE,
    ),
    "condensed": (
        "Condensed Summary",
        "SELECT conversation_id, 'condensed' AS source, condensed_summary AS text, NULL AS seq "
        "FROM udb.conversation_summaries WHERE condensed_summary IS NOT NULL "
        "AND TRIM(condensed_summary) != '' AND conversation_id" + _IN_SCOPE,
    ),
    "user_notes": (
        "User Notes",
        "SELECT conversation_id, 'user_notes' AS source, user_notes AS text, NULL AS seq "
        "FROM udb.conversation_notes WHERE user_notes IS NOT NULL AND TRIM(user_notes) != '' "
        "AND conversation_id" + _IN_SCOPE,
    ),
    "notes_to_ai": (
        "Notes to AI",
        "SELECT conversation_id, 'notes_to_ai' AS source, notes_to_ai AS text, NULL AS seq "
        "FROM udb.conversation_notes WHERE notes_to_ai IS NOT NULL AND TRIM(notes_to_ai) != '' "
        "AND conversation_id" + _IN_SCOPE,
    ),
    "notes_from_ai": (
        "Notes from AI",
        "SELECT conversation_id, 'notes_from_ai' AS source, notes_from_ai AS text, NULL AS seq "
        "FROM udb.conversation_notes WHERE notes_from_ai IS NOT NULL AND TRIM(notes_from_ai) != '' "
        "AND conversation_id" + _IN_SCOPE,
    ),
    "bookmarks": (
        "Bookmark",
        "SELECT conversation_id, 'bookmarks' AS source, COALESCE(name, '') AS text, seq "
        "FROM udb.conversation_bookmarks WHERE conversation_id" + _IN_SCOPE,
    ),
}


# Spaces and tabs only: an exact phrase may have several spaces between its
# words, but never a line break.
_PHRASE_GAP = r"[^\S\n\r\v\f\x85\u2028\u2029]+"


def _terms(query: str) -> list[str]:
    return [part for part in re.findall(r"\S+", query.strip()) if part]


def _wrap_whole(body: str, whole: bool) -> str:
    return rf"(?<!\w){body}(?!\w)" if whole else body


@lru_cache(maxsize=64)
def _patterns(query: str, mode: str, whole: bool) -> tuple:
    """Compiled patterns for a query: one phrase for exact mode, else one per
    distinct word. Empty when there is nothing to search for."""
    terms = _terms(query)
    if not terms:
        return ()
    flags = re.IGNORECASE | re.UNICODE
    if mode == "exact":
        body = _PHRASE_GAP.join(re.escape(term) for term in terms)
        return (re.compile(_wrap_whole(body, whole), flags),)
    # Drop repeated words case-insensitively, but compile each as typed:
    # case-folding can change spelling ("Straße" -> "strasse"), which
    # IGNORECASE would then fail to match against the original text.
    unique = {}
    for term in terms:
        unique.setdefault(term.casefold(), term)
    return tuple(re.compile(_wrap_whole(re.escape(term), whole), flags) for term in unique.values())


def _text_matches(text, query, mode, whole) -> int:
    # Row-level test: does this text contain any of the patterns? "All words"
    # is decided per conversation afterwards, so a row only needs one word.
    text = str(text or "")
    return int(any(p.search(text) for p in _patterns(str(query or ""), str(mode), bool(whole))))


def _attachment_text(value) -> str:
    """Searchable text of a message's attachments: each file name and its
    extracted content, never the JSON keys or file types around them."""
    try:
        items = json.loads(value or "[]")
    except (TypeError, ValueError):
        return ""
    parts = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        for key in ("name", "content"):
            text = str(item.get(key) or "").strip()
            if text:
                parts.append(text)
    return "\n".join(parts)


def _register_functions(conn) -> None:
    conn.create_function("ADV_MATCH", 4, _text_matches, deterministic=True)
    conn.create_function("ADV_ATTACHMENT_TEXT", 1, _attachment_text, deterministic=True)


def _json_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v) for v in value if v is not None and str(v) != ""]


# Include value meaning "every option": no include restriction, so only the
# excluded values filter ("All" / "All Except Excluded" in the UI).
ALL = "__all__"


def _include_list(raw) -> list[str]:
    values = _json_list(raw)
    return [] if ALL in values else values


def _mode_filter(criteria: dict, key: str) -> dict:
    raw = ((criteria.get("filters") or {}).get(key) or {})
    return {
        "include": _include_list(raw.get("include")),
        "exclude": _json_list(raw.get("exclude")),
        "none": bool(raw.get("none")),
    }


def _placeholders(values: list) -> str:
    return ",".join("?" for _ in values)


def _append_relation_filter(where: list[str], params: list, spec: dict, *, table: str,
                            value_col: str, conv_col: str = "conversation_id") -> None:
    if spec["none"]:
        where.append(f"NOT EXISTS (SELECT 1 FROM {table} afn WHERE afn.{conv_col} = c.id)")
        return
    include = spec["include"]
    exclude = spec["exclude"]
    if include:
        where.append(
            f"EXISTS (SELECT 1 FROM {table} afi WHERE afi.{conv_col} = c.id "
            f"AND afi.{value_col} IN ({_placeholders(include)}))"
        )
        params.extend(include)
    if exclude:
        where.append(
            f"NOT EXISTS (SELECT 1 FROM {table} afe WHERE afe.{conv_col} = c.id "
            f"AND afe.{value_col} IN ({_placeholders(exclude)}))"
        )
        params.extend(exclude)


def _provider_condition(criteria: dict, provider: str, params: list) -> str:
    """Filters that belong to one provider: its models, gizmos and folders.
    Each applies only to that provider's conversations, so the other side's
    choices are kept but have no effect while it is not searched."""
    parts = [_provider_model_condition(criteria, provider, params)]
    _append_relation_filter(parts, params, _mode_filter(criteria, f"{provider}_folders"),
                            table="udb.folder_items", value_col="folder_id")
    return " AND ".join(parts)


def _provider_model_condition(criteria: dict, provider: str, params: list) -> str:
    if provider == "claude":
        spec = _mode_filter(criteria, "claude_models")
        include = spec["include"]
        exclude = spec["exclude"]
        parts = []
        unidentified = "__unidentified__"
        if include:
            normal = [v for v in include if v != unidentified]
            opts = []
            if normal:
                opts.append(
                    "EXISTS (SELECT 1 FROM udb.conversation_models acmi "
                    f"WHERE acmi.conversation_id = c.id AND acmi.model_id IN ({_placeholders(normal)}))"
                )
                params.extend(normal)
            if unidentified in include:
                opts.append("NOT EXISTS (SELECT 1 FROM udb.conversation_models acu WHERE acu.conversation_id = c.id)")
            parts.append("(" + " OR ".join(opts) + ")")
        if exclude:
            normal = [v for v in exclude if v != unidentified]
            if normal:
                parts.append(
                    "NOT EXISTS (SELECT 1 FROM udb.conversation_models acme "
                    f"WHERE acme.conversation_id = c.id AND acme.model_id IN ({_placeholders(normal)}))"
                )
                params.extend(normal)
            if unidentified in exclude:
                parts.append("EXISTS (SELECT 1 FROM udb.conversation_models ace WHERE ace.conversation_id = c.id)")
        return " AND ".join(parts) if parts else "1"

    model_spec = _mode_filter(criteria, "chatgpt_models")
    gizmo_spec = _mode_filter(criteria, "gizmos")
    parts = []
    if model_spec["include"]:
        vals = model_spec["include"]
        parts.append(
            "EXISTS (SELECT 1 FROM messages agmi WHERE agmi.conversation_id = c.id "
            f"AND agmi.model_slug IN ({_placeholders(vals)}))"
        )
        params.extend(vals)
    if model_spec["exclude"]:
        vals = model_spec["exclude"]
        parts.append(
            "NOT EXISTS (SELECT 1 FROM messages agme WHERE agme.conversation_id = c.id "
            f"AND agme.model_slug IN ({_placeholders(vals)}))"
        )
        params.extend(vals)
    if gizmo_spec["none"]:
        parts.append("(c.gizmo_id IS NULL OR c.gizmo_id = '')")
    else:
        if gizmo_spec["include"]:
            vals = gizmo_spec["include"]
            parts.append(f"c.gizmo_id IN ({_placeholders(vals)})")
            params.extend(vals)
        if gizmo_spec["exclude"]:
            vals = gizmo_spec["exclude"]
            parts.append(f"(c.gizmo_id IS NULL OR c.gizmo_id NOT IN ({_placeholders(vals)}))")
            params.extend(vals)
    return " AND ".join(parts) if parts else "1"


def _base_rows(conn, criteria: dict) -> list[dict]:
    providers = [p for p in _json_list(criteria.get("providers")) if p in ("claude", "chatgpt")]
    if not providers:
        providers = ["claude"]
    where = [f"c.provider IN ({_placeholders(providers)})"]
    params: list = list(providers)

    statuses = [s for s in _json_list(criteria.get("statuses")) if s in ("active", "archived", "deleted")]
    if not statuses:
        statuses = ["active"]
    status_parts = []
    if "active" in statuses:
        status_parts.append("(COALESCE(cm.deleted,0)=0 AND COALESCE(cm.archived,0)=0)")
    if "archived" in statuses:
        status_parts.append("(COALESCE(cm.deleted,0)=0 AND COALESCE(cm.archived,0)=1)")
    if "deleted" in statuses:
        status_parts.append("COALESCE(cm.deleted,0)=1")
    where.append("(" + " OR ".join(status_parts) + ")")
    if criteria.get("pinned_only"):
        where.append("EXISTS (SELECT 1 FROM pinned_conversations ap WHERE ap.conversation_id = c.id)")

    _append_relation_filter(where, params, _mode_filter(criteria, "tags"),
                            table="udb.conversation_tags", value_col="tag")
    _append_relation_filter(where, params, _mode_filter(criteria, "mood_tags"),
                            table="udb.conversation_mood_tags", value_col="tag")
    _append_relation_filter(where, params, _mode_filter(criteria, "labels"),
                            table="udb.conversation_labels", value_col="label_id")

    date = criteria.get("date") if isinstance(criteria.get("date"), dict) else {}
    # Dates are the conversation's last activity (update time, or its start
    # time when it has none; imports store a missing update time as 0). "7"/"30"/"90" mean the last that many days, counted from today; "custom"
    # uses the From/To boxes (either may be empty); "any" adds no date filter.
    date_range = str(date.get("range") or ("custom" if date.get("from") or date.get("to") else "any"))
    if date_range in ("7", "30", "90"):
        where.append("date(COALESCE(NULLIF(c.update_time, 0), c.create_time), 'unixepoch', 'localtime') >= date('now', 'localtime', ?)")
        # Today counts as the first day, so "7 days" is today and the six before.
        params.append(f"-{int(date_range) - 1} days")
    elif date_range == "custom":
        if date.get("from"):
            where.append("date(COALESCE(NULLIF(c.update_time, 0), c.create_time), 'unixepoch', 'localtime') >= date(?)")
            params.append(str(date["from"]))
        if date.get("to"):
            where.append("date(COALESCE(NULLIF(c.update_time, 0), c.create_time), 'unixepoch', 'localtime') <= date(?)")
            params.append(str(date["to"]))

    must_have = set(_json_list(criteria.get("must_have")))
    if "summary" in must_have:
        where.append(
            "EXISTS (SELECT 1 FROM udb.conversation_summaries ahs WHERE ahs.conversation_id=c.id "
            "AND (TRIM(COALESCE(ahs.summary,''))!='' OR TRIM(COALESCE(ahs.condensed_summary,''))!=''))"
        )
    if "notes" in must_have:
        where.append(
            "EXISTS (SELECT 1 FROM udb.conversation_notes ahn WHERE ahn.conversation_id=c.id "
            "AND (TRIM(COALESCE(ahn.user_notes,''))!='' OR TRIM(COALESCE(ahn.notes_to_ai,''))!='' "
            "OR TRIM(COALESCE(ahn.notes_from_ai,''))!=''))"
        )
    if "bookmarks" in must_have:
        where.append("EXISTS (SELECT 1 FROM udb.conversation_bookmarks ahb WHERE ahb.conversation_id=c.id)")
    if "attachments" in must_have:
        where.append(
            "EXISTS (SELECT 1 FROM messages aha WHERE aha.conversation_id=c.id "
            "AND aha.attachments IS NOT NULL AND TRIM(aha.attachments)!='')"
        )

    provider_parts = []
    if "claude" in providers:
        provider_parts.append("(c.provider='claude' AND " + _provider_condition(criteria, "claude", params) + ")")
    if "chatgpt" in providers:
        provider_parts.append("(c.provider='chatgpt' AND " + _provider_condition(criteria, "chatgpt", params) + ")")
    where.append("(" + " OR ".join(provider_parts) + ")")

    rows = conn.execute(
        "SELECT c.id, COALESCE(NULLIF(cm.custom_title,''),c.title) AS title, c.provider, "
        "c.create_time, c.update_time, c.gizmo_id "
        "FROM conversations c LEFT JOIN conversation_meta cm ON cm.conversation_id=c.id "
        "WHERE " + " AND ".join(where),
        tuple(params),
    ).fetchall()
    return [dict(r) for r in rows]


def _matching_rows(conn, source_names: list[str], query: str, mode: str, whole: bool,
                   scope_ids) -> list[dict]:
    valid = [name for name in source_names if name in TEXT_SOURCES]
    if not valid or not scope_ids or not _patterns(query, mode, whole):
        return []
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS advanced_scope (id TEXT PRIMARY KEY)")
    conn.execute("DELETE FROM temp.advanced_scope")
    conn.executemany("INSERT OR IGNORE INTO temp.advanced_scope(id) VALUES (?)",
                     ((cid,) for cid in scope_ids))
    union = " UNION ALL ".join(TEXT_SOURCES[name][1] for name in valid)
    rows = conn.execute(
        "WITH advanced_text AS (" + union + ") "
        "SELECT conversation_id, source, text, seq "
        "FROM advanced_text WHERE ADV_MATCH(text, ?, ?, ?)",
        (query, mode, int(whole)),
    ).fetchall()
    out = []
    for r in rows:
        row = dict(r)
        text = str(row["text"] or "")
        counts = [sum(1 for _ in p.finditer(text)) for p in _patterns(query, mode, whole)]
        row["terms"] = {i for i, count in enumerate(counts) if count}
        row["hit_count"] = sum(counts)
        out.append(row)
    return out


# Sources without a message position, in the order their text is preferred for
# the snippet. The title is last: it is already shown on the result card.
_UNPOSITIONED_ORDER = ["summary", "condensed", "user_notes", "notes_to_ai",
                       "notes_from_ai", "titles"]


def _hit_order(hit: dict) -> tuple:
    """Which hit supplies the snippet and jump target: the one holding the most
    of the searched words, then the earliest message, then the other sources."""
    seq = hit.get("seq")
    if seq is not None:
        place = (0, seq, list(TEXT_SOURCES).index(hit["source"]))
    else:
        place = (1, _UNPOSITIONED_ORDER.index(hit["source"]), 0)
    return (-len(hit["terms"]),) + place


def _snippet(text: str, query: str, mode: str, whole: bool, radius: int = 145) -> str:
    text = str(text or "")
    starts = [m.start() for p in _patterns(query, mode, whole) if (m := p.search(text))]
    center = min(starts) if starts else 0
    # Cut the window from the original text, so the match found above is the
    # one shown, then collapse whitespace for display.
    start = max(0, min(center - radius, len(text) - radius * 2))
    end = min(len(text), start + radius * 2)
    body = re.sub(r"\s+", " ", text[start:end]).strip()
    lead = "…" if text[:start].strip() else ""
    tail = "…" if text[end:].strip() else ""
    return lead + body + tail


def _attach_metadata(conn, results: list[dict]) -> None:
    ids = [r["id"] for r in results]
    if not ids:
        return
    marks = _placeholders(ids)
    tags = defaultdict(list)
    moods = defaultdict(list)
    label_map = defaultdict(list)
    bookmarks = set()
    models = defaultdict(list)
    for row in conn.execute(
        f"SELECT conversation_id, tag FROM udb.conversation_tags WHERE conversation_id IN ({marks}) ORDER BY tag",
        ids,
    ):
        tags[row[0]].append(row[1])
    for row in conn.execute(
        f"SELECT conversation_id, tag FROM udb.conversation_mood_tags WHERE conversation_id IN ({marks}) ORDER BY tag",
        ids,
    ):
        moods[row[0]].append(row[1])
    for row in conn.execute(
        "SELECT cl.conversation_id,l.id,l.name,l.color FROM udb.conversation_labels cl "
        "JOIN udb.labels l ON l.id=cl.label_id "
        f"WHERE cl.conversation_id IN ({marks}) ORDER BY l.sort_index",
        ids,
    ):
        label_map[row[0]].append({"id": row[1], "name": row[2], "color": row[3]})
    for row in conn.execute(
        f"SELECT DISTINCT conversation_id FROM udb.conversation_bookmarks WHERE conversation_id IN ({marks})",
        ids,
    ):
        bookmarks.add(row[0])
    for row in conn.execute(
        "SELECT cm.conversation_id,m.name FROM udb.conversation_models cm "
        "JOIN udb.claude_models m ON m.id=cm.model_id "
        f"WHERE cm.conversation_id IN ({marks}) ORDER BY cm.added_at",
        ids,
    ):
        models[row[0]].append(row[1])
    for row in conn.execute(
        f"SELECT DISTINCT conversation_id,model_slug FROM messages WHERE conversation_id IN ({marks}) "
        "AND model_slug IS NOT NULL AND TRIM(model_slug)!='' ORDER BY model_slug",
        ids,
    ):
        models[row[0]].append(row[1])
    # Where the conversation lives: the Recycle Bin, the archive, or a folder.
    status = {}
    for row in conn.execute(
        f"SELECT conversation_id, archived, deleted FROM conversation_meta WHERE conversation_id IN ({marks})",
        ids,
    ):
        status[row[0]] = (bool(row[1]), bool(row[2]))
    folders = {}
    for row in conn.execute(
        "SELECT fi.conversation_id, f.id, f.name, fi.pinned FROM udb.folder_items fi "
        f"JOIN udb.folders f ON f.id=fi.folder_id WHERE fi.conversation_id IN ({marks})",
        ids,
    ):
        folders[row[0]] = {"id": row[1], "name": row[2], "pinned": bool(row[3])}
    pinned = {row[0] for row in conn.execute(
        f"SELECT conversation_id FROM pinned_conversations WHERE conversation_id IN ({marks})",
        ids,
    )}
    for result in results:
        cid = result["id"]
        archived, deleted = status.get(cid, (False, False))
        folder = folders.get(cid)
        result["archived"] = archived
        result["deleted"] = deleted
        result["folder"] = {"id": folder["id"], "name": folder["name"]} if folder else None
        # A foldered chat is pinned within its folder; any other chat uses the
        # ordinary pin list.
        result["pinned"] = folder["pinned"] if folder else cid in pinned
        result["tags"] = tags[cid]
        result["mood_tags"] = moods[cid]
        result["labels"] = label_map[cid]
        result["bookmarked"] = cid in bookmarks
        result["models"] = models[cid] or (["Unidentified"] if result["provider"] == "claude" else [])


def _criteria_for_storage(payload: dict) -> dict:
    out = json.loads(json.dumps(payload, ensure_ascii=False))
    out.pop("offset", None)
    out.pop("limit", None)
    return out


# Display settings: changing them re-uses the same recent-search entry.
_DISPLAY_KEYS = ("sort", "result_view", "list_models")


def _remember_recent(conn, criteria: dict) -> None:
    stored = _criteria_for_storage(criteria)
    identity = {k: v for k, v in stored.items() if k not in _DISPLAY_KEYS}
    canonical = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    rid = uuid.uuid5(uuid.NAMESPACE_URL, canonical).hex
    now = time.time()
    # The entry keeps the latest display settings it was run with.
    conn.execute(
        "INSERT INTO udb.advanced_search_recent(id,criteria_json,created_at,last_used_at,use_count) "
        "VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET last_used_at=excluded.last_used_at, "
        "criteria_json=excluded.criteria_json, use_count=use_count+1",
        (rid, json.dumps(stored, ensure_ascii=False), now, now),
    )
    conn.execute(
        "DELETE FROM udb.advanced_search_recent WHERE id NOT IN ("
        "SELECT id FROM udb.advanced_search_recent ORDER BY last_used_at DESC LIMIT 25)"
    )
    conn.commit()


def search(conn, payload: dict, remember: bool = True) -> dict:
    _register_functions(conn)
    criteria = payload if isinstance(payload, dict) else {}
    query = str(criteria.get("query") or "").strip()
    mode = str(criteria.get("text_mode") or "all")
    if mode not in ("all", "any", "exact"):
        mode = "all"
    whole = bool(criteria.get("whole_words"))
    base = _base_rows(conn, criteria)
    by_id = {row["id"]: row for row in base}

    search_in = criteria.get("search_in") if isinstance(criteria.get("search_in"), dict) else {}
    included = _include_list(search_in.get("include"))
    excluded = _json_list(search_in.get("exclude"))
    allowed_sources = included or list(TEXT_SOURCES)
    allowed_sources = [s for s in allowed_sources if s not in excluded]

    # An excluded Search-In location is simply not searched. Finding the same
    # words there must not disqualify a chat that matched an included location.
    hit_rows = _matching_rows(conn, sorted(set(allowed_sources)), query, mode, whole, by_id)
    hits = defaultdict(list)
    for row in hit_rows:
        cid = row["conversation_id"]
        if cid in by_id and row["source"] in allowed_sources:
            hits[cid].append(row)

    # "All words" is judged across the whole conversation: each word must
    # appear in at least one searched location, not all in the same one.
    needed = len(_patterns(query, mode, whole))

    results = []
    for cid, row in by_id.items():
        conv_hits = hits.get(cid, [])
        if query:
            found = set().union(*(h["terms"] for h in conv_hits))
            if not found or (mode == "all" and len(found) < needed):
                continue
        first = min(conv_hits, key=_hit_order) if conv_hits else None
        results.append({
            **row,
            "match_count": sum(int(h.get("hit_count") or 0) for h in conv_hits),
            "snippet": _snippet(first["text"], query, mode, whole) if first else "",
            "snippet_source": TEXT_SOURCES[first["source"]][0] if first else "",
            "target_seq": first.get("seq") if first else None,
        })

    sort = str(criteria.get("sort") or "newest")
    if sort == "oldest":
        results.sort(key=lambda r: (r.get("create_time") or 0, r["title"].casefold()))
    elif sort in ("matches", "relevance"):
        results.sort(key=lambda r: (-(r.get("match_count") or 0), -(r.get("create_time") or 0)))
    else:
        results.sort(key=lambda r: (-(r.get("create_time") or 0), r["title"].casefold()))

    total = len(results)
    try:
        offset = max(0, int(criteria.get("offset") or 0))
        limit = max(1, min(100, int(criteria.get("limit") or 50)))
    except (TypeError, ValueError):
        offset, limit = 0, 50
    page = results[offset:offset + limit]
    _attach_metadata(conn, page)
    if offset == 0 and remember:
        _remember_recent(conn, criteria)
    return {"results": page, "total": total, "offset": offset, "limit": limit}


def browse(conn, payload: dict) -> dict:
    """Every conversation in one location (a folder, Archived or Deleted),
    as result cards. Browsing is not a search, so it is not added to Recent."""
    payload = payload if isinstance(payload, dict) else {}
    kind = str(payload.get("kind") or "")
    provider = str(payload.get("provider") or "")
    if kind == "folder":
        row = conn.execute(
            "SELECT provider FROM udb.folders WHERE id=?", (str(payload.get("id") or ""),)
        ).fetchone()
        if not row:
            raise ApiError("Folder not found.", 404)
        provider = row[0] or provider
    elif kind not in ("archived", "deleted"):
        raise ApiError("Unknown location.", 400)
    if provider not in ("claude", "chatgpt"):
        provider = "claude"
    criteria = {
        "providers": [provider],
        "sort": payload.get("sort") if payload.get("sort") in ("newest", "oldest") else "newest",
        "offset": payload.get("offset"),
        "limit": payload.get("limit"),
    }
    if kind == "folder":
        # A folder shows what the sidebar shows in it: everything but deleted chats.
        criteria["statuses"] = ["active", "archived"]
        criteria["filters"] = {f"{provider}_folders": {"include": [str(payload["id"])]}}
    else:
        criteria["statuses"] = [kind]
    return search(conn, criteria, remember=False)


def options(conn) -> dict:
    def values(sql, params=()):
        return [dict(r) for r in conn.execute(sql, params).fetchall()]

    tags = [r["value"] for r in values(
        "SELECT DISTINCT tag AS value FROM udb.conversation_tags WHERE TRIM(tag)!='' ORDER BY tag COLLATE NOCASE"
    )]
    moods = [r["value"] for r in values(
        "SELECT DISTINCT tag AS value FROM udb.conversation_mood_tags WHERE TRIM(tag)!='' ORDER BY tag COLLATE NOCASE"
    )]
    labels = values("SELECT id,name,color FROM udb.labels ORDER BY sort_index,name COLLATE NOCASE")
    folders = values("SELECT id,name,provider FROM udb.folders ORDER BY name COLLATE NOCASE")
    assigned_claude = values(
        "SELECT DISTINCT m.id,m.name FROM udb.conversation_models cm "
        "JOIN udb.claude_models m ON m.id=cm.model_id ORDER BY m.name COLLATE NOCASE"
    )
    chatgpt_models = [r["value"] for r in values(
        "SELECT DISTINCT model_slug AS value FROM messages m JOIN conversations c ON c.id=m.conversation_id "
        "WHERE c.provider='chatgpt' AND model_slug IS NOT NULL AND TRIM(model_slug)!='' "
        "ORDER BY model_slug COLLATE NOCASE"
    )]
    gizmos = values(
        "SELECT DISTINCT c.gizmo_id AS id,COALESCE(NULLIF(gn.display_name,''),c.gizmo_id) AS name "
        "FROM conversations c LEFT JOIN udb.gizmo_names gn ON gn.gizmo_id=c.gizmo_id "
        "WHERE c.provider='chatgpt' AND c.gizmo_id IS NOT NULL AND c.gizmo_id!='' "
        "ORDER BY name COLLATE NOCASE"
    )
    return {
        "tags": tags,
        "mood_tags": moods,
        "labels": labels,
        "folders": folders,
        "claude_models": assigned_claude,
        "chatgpt_models": chatgpt_models,
        "gizmos": gizmos,
    }


def history(conn) -> dict:
    recent = []
    for row in conn.execute(
        "SELECT id,criteria_json,created_at,last_used_at,use_count FROM udb.advanced_search_recent "
        "ORDER BY last_used_at DESC LIMIT 25"
    ):
        item = dict(row)
        item["criteria"] = json.loads(item.pop("criteria_json"))
        recent.append(item)
    saved = []
    for row in conn.execute(
        "SELECT id,name,criteria_json,created_at,updated_at FROM udb.advanced_search_saved "
        "ORDER BY updated_at DESC,name COLLATE NOCASE"
    ):
        item = dict(row)
        item["criteria"] = json.loads(item.pop("criteria_json"))
        saved.append(item)
    return {"recent": recent, "saved": saved}


def save_search(conn, payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    criteria = payload.get("criteria")
    if not name:
        raise ApiError("A saved search name is required.", 400)
    if not isinstance(criteria, dict):
        raise ApiError("Search criteria are required.", 400)
    sid = uuid.uuid4().hex
    now = time.time()
    conn.execute(
        "INSERT INTO udb.advanced_search_saved(id,name,criteria_json,created_at,updated_at) "
        "VALUES (?,?,?,?,?)",
        (sid, name, json.dumps(_criteria_for_storage(criteria), ensure_ascii=False), now, now),
    )
    conn.commit()
    return {"ok": True, "id": sid}


def delete_saved(conn, saved_id: str) -> dict:
    cur = conn.execute("DELETE FROM udb.advanced_search_saved WHERE id=?", (saved_id,))
    conn.commit()
    if not cur.rowcount:
        raise ApiError("Saved search not found.", 404)
    return {"ok": True}
