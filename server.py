#!/usr/bin/env python3
"""Minimal HTTP server for Claude History Viewer."""
from __future__ import annotations
import datetime, html, json, mimetypes, os, re, sqlite3, sys, time, urllib.parse, uuid
import importlib
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

# Set CHV_TIMING=1 to log each request's method, path, and duration to stderr.
# Off by default so normal runs stay quiet; useful for spotting slow endpoints.
_TIMING = os.environ.get("CHV_TIMING", "").strip() not in ("", "0", "false", "no")

try:
    _docx_module = importlib.import_module("docx")
    _DocxDocument = getattr(_docx_module, "Document", None)
    _DOCX_OK = callable(_DocxDocument)
except Exception:
    _DocxDocument = None
    _DOCX_OK = False

def _userdata_path(db_path) -> Path:
    """Path to the persistent user-data DB (folders etc.), a sibling of the
    history DB. Kept in its own file so it survives history.db being rebuilt or
    deleted — conversation IDs are stable across rebuilds, so membership holds."""
    return Path(db_path).parent / "userdata.db"


def open_db(db_path):
    # One short-lived connection per request. With ThreadingHTTPServer several
    # requests can run at once, so give SQLite a busy timeout (waits instead of
    # immediately raising "database is locked") and enable WAL so readers never
    # block the occasional small writer. Each connection is created and closed
    # inside a single request/thread, so check_same_thread stays at its default.
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        # Per-connection, lock-free settings only. journal_mode=WAL is a
        # persistent DB property set once at startup (see _ensure_runtime_schema)
        # — setting it here per request would make many cold connections contend
        # on the WAL switch's exclusive lock.
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.Error:
        pass  # pragmas are best-effort; never fail a request over them
    try:
        # Attach the persistent user-data DB as schema `udb` so folder tables
        # can be joined against conversations in the same query.
        conn.execute("ATTACH DATABASE ? AS udb", (str(_userdata_path(db_path)),))
    except sqlite3.Error:
        pass
    return conn


def _ensure_runtime_schema(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        # Enable WAL once (persistent): readers don't block the occasional small
        # writer, so archive/pin writes can't stall list/detail reads.
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.Error:
            pass
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversation_meta (
                conversation_id TEXT PRIMARY KEY,
                custom_title    TEXT,
                archived        INTEGER DEFAULT 0,
                deleted         INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS pinned_conversations (
                conversation_id TEXT PRIMARY KEY,
                pinned_at       REAL,
                order_index     INTEGER
            );
            CREATE TABLE IF NOT EXISTS ui_preferences (
                pref_key   TEXT PRIMARY KEY,
                pref_value TEXT
            );
            CREATE TABLE IF NOT EXISTS workspace_tabs (
                id              TEXT PRIMARY KEY,
                tab_type        TEXT NOT NULL,
                conversation_id TEXT,
                artifact_id     TEXT,
                title           TEXT,
                pinned          INTEGER DEFAULT 0,
                sort_index      INTEGER DEFAULT 0,
                last_active_at  REAL,
                closed          INTEGER DEFAULT 0
            );
            """
        )
        # Indexes that speed up the conversation-list sort and detail load.
        # Created at runtime so existing databases benefit without a rebuild.
        # Each is best-effort: a missing base table (partial DB) must not abort
        # the runtime-schema setup above.
        for idx_sql in (
            "CREATE INDEX IF NOT EXISTS idx_conv_update ON conversations (update_time DESC, create_time DESC)",
            "CREATE INDEX IF NOT EXISTS idx_meta_flags  ON conversation_meta (deleted, archived)",
            "CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts (conv_id)",
        ):
            try:
                conn.execute(idx_sql)
            except sqlite3.Error:
                pass
        # Ensure the import-audit columns exist on databases built before they
        # were added. ADD COLUMN is non-destructive; it errors if the column
        # already exists (fresh build) so we swallow that. Values stay NULL
        # until the next rebuild populates them.
        for col_sql in (
            "ALTER TABLE conversations ADD COLUMN import_status TEXT DEFAULT 'normal'",
            "ALTER TABLE conversations ADD COLUMN source_index INTEGER",
        ):
            try:
                conn.execute(col_sql)
            except sqlite3.Error:
                pass
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations (import_status)"
            )
        except sqlite3.Error:
            pass
        conn.execute(
            "UPDATE conversation_meta SET custom_title = NULL WHERE TRIM(COALESCE(custom_title, '')) = ''"
        )
        conn.execute(
            """
            UPDATE workspace_tabs
               SET title = (
                   SELECT COALESCE(NULLIF(cm.custom_title, ''), c.title)
                     FROM conversations c
                     LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id
                    WHERE c.id = workspace_tabs.conversation_id
               )
             WHERE tab_type = 'conversation'
               AND conversation_id IS NOT NULL
               AND TRIM(COALESCE(title, '')) = ''
            """
        )
        conn.commit()
    finally:
        conn.close()


def _ensure_userdata_schema(db_path: Path) -> None:
    """Create the persistent user-data DB (folders + folder membership)."""
    conn = sqlite3.connect(_userdata_path(db_path))
    try:
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.Error:
            pass
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS folders (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                created_at REAL,
                updated_at REAL
            );
            CREATE TABLE IF NOT EXISTS folder_items (
                conversation_id TEXT PRIMARY KEY,
                folder_id       TEXT NOT NULL,
                added_at        REAL,
                pinned          INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_folder_items_folder ON folder_items (folder_id);

            -- Claude model availability. A model is one row in claude_models;
            -- each window it was offered in claude.ai is one row in
            -- claude_model_periods, so a model that came back after a gap
            -- (Claude Fable 5) is one model with two period rows.
            CREATE TABLE IF NOT EXISTS claude_models (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS claude_model_periods (
                id         TEXT PRIMARY KEY,
                model_id   TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date   TEXT,
                created_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_model_periods ON claude_model_periods (model_id);

            -- Which models the user says a conversation used. Many-to-many.
            CREATE TABLE IF NOT EXISTS conversation_models (
                conversation_id TEXT NOT NULL,
                model_id        TEXT NOT NULL,
                added_at        REAL,
                PRIMARY KEY (conversation_id, model_id)
            );

            -- Per-conversation "I checked this, stop warning me" state. Cleared
            -- automatically when the warning's condition stops being true, so
            -- the icon comes back if the dates drift out of range again.
            CREATE TABLE IF NOT EXISTS conversation_model_flags (
                conversation_id    TEXT PRIMARY KEY,
                range_dismissed    INTEGER DEFAULT 0,
                coverage_dismissed INTEGER DEFAULT 0
            );

            -- Bookkeeping for the one-time seed import (see _seed_claude_models).
            CREATE TABLE IF NOT EXISTS udb_meta (
                meta_key   TEXT PRIMARY KEY,
                meta_value TEXT
            );
            """
        )
        conn.commit()
        _seed_claude_models(conn)
    finally:
        conn.close()


# ── Claude model availability ────────────────────────────────────────────────

MODEL_SEED_FILE = Path(__file__).parent / "claude_models.json"


def _seed_claude_models(conn) -> None:
    """Import claude_models.json once, then never again.

    The JSON ships with the app only as a starting list. Once imported, the
    user-data DB is the single source of truth: it travels with the user's
    other data, and their edits are never overwritten by the shipped file.
    The seed is also skipped if the user has emptied the table on purpose.
    """
    try:
        done = conn.execute(
            "SELECT meta_value FROM udb_meta WHERE meta_key = 'claude_models_seeded'"
        ).fetchone()
    except sqlite3.Error:
        return
    if done:
        return
    rows = []
    try:
        with open(MODEL_SEED_FILE, encoding="utf-8") as f:
            rows = json.load(f).get("models") or []
    except Exception:
        rows = []  # a missing or unreadable seed just means an empty list
    now = time.time()
    by_name: dict[str, str] = {}
    for entry in rows:
        name = str(entry.get("name") or "").strip()
        start = str(entry.get("start_date") or "").strip()
        if not name or not start:
            continue
        end = entry.get("end_date")
        end = str(end).strip() if end else None
        key = name.casefold()
        model_id = by_name.get(key)
        if model_id is None:
            model_id = uuid.uuid4().hex
            by_name[key] = model_id
            conn.execute(
                "INSERT INTO claude_models(id, name, created_at) VALUES (?, ?, ?)",
                (model_id, name, now),
            )
        conn.execute(
            "INSERT INTO claude_model_periods(id, model_id, start_date, end_date, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, model_id, start, end, now),
        )
    conn.execute(
        "INSERT OR REPLACE INTO udb_meta(meta_key, meta_value) VALUES ('claude_models_seeded', ?)",
        (str(now),),
    )
    conn.commit()


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _norm_date(value) -> str | None:
    """Accept a YYYY-MM-DD string, reject anything else. Dates are compared as
    strings throughout, which is exactly right for zero-padded ISO dates."""
    s = str(value or "").strip()
    return s if _DATE_RE.match(s) else None


def _ts_to_date(ts) -> str | None:
    """Epoch seconds -> local YYYY-MM-DD, matching the date the UI displays."""
    try:
        return datetime.date.fromtimestamp(float(ts)).isoformat()
    except Exception:
        return None


def _conv_date_range(create_time, update_time):
    """The span a conversation covers, as inclusive (first_day, last_day).

    Returns (None, None) when the export carries no usable timestamps; callers
    treat that as "cannot judge availability" and raise no warnings.
    """
    a = _ts_to_date(create_time)
    b = _ts_to_date(update_time)
    days = [d for d in (a, b) if d]
    if not days:
        return None, None
    return min(days), max(days)


def _period_overlaps(start, end, first_day, last_day) -> bool:
    """Does [start, end) overlap the inclusive day span [first_day, last_day]?

    end is exclusive (claude.json's stated interval semantics) and None means
    "still available".
    """
    if start > last_day:
        return False
    return end is None or end > first_day


def _periods_cover(periods, first_day, last_day) -> bool:
    """Do these [start, end) windows together cover every day of the span?"""
    OPEN = "9999-12-31"
    # The span is inclusive of last_day, so coverage must reach past it.
    target = _day_after(last_day)
    reached = first_day
    for start, end in sorted(periods, key=lambda p: p[0]):
        if start > reached:
            break  # gap before this window: the span is not fully covered
        stop = end or OPEN
        if stop > reached:
            reached = stop
        if reached >= target:
            return True
    return reached >= target


def _day_after(day: str) -> str:
    try:
        d = datetime.date.fromisoformat(day) + datetime.timedelta(days=1)
        return d.isoformat()
    except Exception:
        return day


def _load_model_periods(conn) -> dict[str, list[tuple[str, str | None]]]:
    """model_id -> its [start, end) windows."""
    out: dict[str, list[tuple[str, str | None]]] = {}
    try:
        rows = conn.execute(
            "SELECT model_id, start_date, end_date FROM udb.claude_model_periods"
        ).fetchall()
    except sqlite3.Error:
        return out
    for r in rows:
        out.setdefault(r["model_id"], []).append((r["start_date"], r["end_date"]))
    return out


def _conversation_warnings(selected_periods, first_day, last_day):
    """The two warning conditions for one conversation.

    out_of_range: at least one selected model has no window overlapping the
                  conversation at all.
    incomplete:   the selected models together do not cover the conversation
                  from its first day to its last.

    Both are False when nothing is selected — an unset conversation is simply
    unknown, not wrong.
    """
    if not selected_periods or not first_day:
        return False, False
    out_of_range = any(
        not any(_period_overlaps(s, e, first_day, last_day) for s, e in periods)
        for periods in selected_periods
    )
    flat = [p for periods in selected_periods for p in periods]
    incomplete = not _periods_cover(flat, first_day, last_day)
    return out_of_range, incomplete


def _compute_conv_flags(conn, conv_rows):
    """Effective warning icons for a batch of conversations.

    conv_rows: iterable of (conversation_id, create_time, update_time).
    Returns {conversation_id: {"warn_range": bool, "warn_coverage": bool}}.

    Dismissals are re-armed here: a dismissal only suppresses a warning whose
    condition is currently true, so a dismissed warning that later becomes
    accurate again is forgotten, and the icon returns if it goes wrong again.
    """
    rows = [r for r in conv_rows if r[0]]
    if not rows:
        return {}
    try:
        sel_rows = conn.execute(
            "SELECT conversation_id, model_id FROM udb.conversation_models"
        ).fetchall()
    except sqlite3.Error:
        return {}
    selections: dict[str, list[str]] = {}
    for r in sel_rows:
        selections.setdefault(r["conversation_id"], []).append(r["model_id"])
    if not selections:
        return {}
    periods_by_model = _load_model_periods(conn)
    dismissed = {}
    try:
        for r in conn.execute(
            "SELECT conversation_id, range_dismissed, coverage_dismissed "
            "FROM udb.conversation_model_flags"
        ).fetchall():
            dismissed[r["conversation_id"]] = (
                bool(r["range_dismissed"]), bool(r["coverage_dismissed"])
            )
    except sqlite3.Error:
        pass

    out, stale = {}, []
    for conv_id, create_time, update_time in rows:
        model_ids = selections.get(conv_id)
        if not model_ids:
            continue
        first_day, last_day = _conv_date_range(create_time, update_time)
        oor, inc = _conversation_warnings(
            [periods_by_model.get(mid, []) for mid in model_ids], first_day, last_day
        )
        d_range, d_cov = dismissed.get(conv_id, (False, False))
        # Re-arm: a dismissal for a condition that no longer holds is dropped.
        if (d_range and not oor) or (d_cov and not inc):
            stale.append((conv_id, 1 if (d_range and oor) else 0,
                          1 if (d_cov and inc) else 0))
            d_range, d_cov = d_range and oor, d_cov and inc
        out[conv_id] = {
            "warn_range": bool(oor and not d_range),
            "warn_coverage": bool(inc and not d_cov),
        }
    for conv_id, keep_range, keep_cov in stale:
        try:
            if keep_range or keep_cov:
                conn.execute(
                    "UPDATE udb.conversation_model_flags "
                    "SET range_dismissed = ?, coverage_dismissed = ? WHERE conversation_id = ?",
                    (keep_range, keep_cov, conv_id),
                )
            else:
                conn.execute(
                    "DELETE FROM udb.conversation_model_flags WHERE conversation_id = ?",
                    (conv_id,),
                )
        except sqlite3.Error:
            pass
    if stale:
        try:
            conn.commit()
        except sqlite3.Error:
            pass
    return out


def _flagged_conv_ids(conn) -> list[str]:
    """Every conversation currently showing at least one warning icon."""
    try:
        rows = conn.execute(
            "SELECT DISTINCT c.id, c.create_time, c.update_time "
            "FROM conversations c JOIN udb.conversation_models m ON m.conversation_id = c.id"
        ).fetchall()
    except sqlite3.Error:
        return []
    flags = _compute_conv_flags(conn, [(r["id"], r["create_time"], r["update_time"]) for r in rows])
    return [cid for cid, f in flags.items() if f["warn_range"] or f["warn_coverage"]]

def _norm_filename(s: str) -> str:
    """Normalize for matching: lowercase + spaces→underscores."""
    return s.lower().replace(" ", "_")

def _extract_snippet(text: str, q: str, radius: int = 100) -> str:
    """Return a plain-text snippet of `text` centered around query `q`."""
    if not text:
        return ""
    idx = text.lower().find(q.lower())
    if idx == -1:
        return text[:radius * 2] + ("…" if len(text) > radius * 2 else "")
    start = max(0, idx - radius // 2)
    end   = min(len(text), idx + len(q) + radius)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return prefix + text[start:end] + suffix

_SOURCE_INDEX: dict[str, list[Path]] = {}


def _source_index_add(key: str, path: Path) -> None:
    if not key:
        return
    bucket = _SOURCE_INDEX.setdefault(key, [])
    if path not in bucket:
        bucket.append(path)

def _build_source_index(source_dir):
    _SOURCE_INDEX.clear()
    if not source_dir.exists():
        return
    for root, _dirs, files in os.walk(source_dir):
        for fname in files:
            p = Path(root) / fname
            rel = str(p.relative_to(source_dir)).replace("\\", "/")
            rel_stem = str(Path(rel).with_suffix(""))
            _source_index_add(fname, p)
            _source_index_add(p.stem, p)
            _source_index_add(rel, p)
            _source_index_add(rel_stem, p)

class Handler(BaseHTTPRequestHandler):
    db_path = Path("history.db")

    source_dir = Path("source")

    def log_message(self, fmt, *args): pass

    def handle_one_request(self):
        t0 = time.perf_counter()
        super().handle_one_request()
        if _TIMING:
            dt = (time.perf_counter() - t0) * 1000
            try:
                sys.stderr.write(
                    f"[timing] {getattr(self, 'command', '?')} "
                    f"{getattr(self, 'path', '?')} {dt:.1f}ms\n"
                )
                sys.stderr.flush()
            except Exception:
                pass

    def _request_target(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        return parsed, path

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        _, path = self._request_target()
        if path == "/api/upload-file":
            self._api_upload_file()
        elif path == "/api/pinned":
            self._api_pinned_add()
        elif path == "/api/pinned/reorder":
            self._api_pinned_reorder()
        elif path == "/api/tabs":
            self._api_tabs_create()
        elif path == "/api/folders":
            self._api_folder_create()
        elif path == "/api/folder-items":
            self._api_folder_item_add()
        elif path == "/api/claude-models":
            self._api_claude_model_add()
        elif path == "/api/conversation-models":
            self._api_conversation_model_add()
        elif path == "/api/conversation-models/dismiss":
            self._api_conversation_model_dismiss()
        else:
            self.send_error(404)

    def do_PATCH(self):
        _, path = self._request_target()
        if path == "/api/preferences":
            self._api_preferences_update()
        elif path.startswith("/api/tabs/"):
            self._api_tab_update(urllib.parse.unquote(path[len("/api/tabs/"):]))
        elif path.startswith("/api/folder-items/"):
            self._api_folder_item_update(urllib.parse.unquote(path[len("/api/folder-items/"):]))
        elif path.startswith("/api/folders/"):
            self._api_folder_update(urllib.parse.unquote(path[len("/api/folders/"):]))
        elif path.startswith("/api/conversation/"):
            self._api_conversation_update(urllib.parse.unquote(path[len("/api/conversation/"):]))
        elif path.startswith("/api/claude-models/"):
            self._api_claude_model_update(urllib.parse.unquote(path[len("/api/claude-models/"):]))
        else:
            self.send_error(404)

    def do_DELETE(self):
        _, path = self._request_target()
        if path.startswith("/api/pinned/"):
            self._api_pinned_remove(urllib.parse.unquote(path[len("/api/pinned/"):]))
        elif path.startswith("/api/tabs/"):
            self._api_tab_remove(urllib.parse.unquote(path[len("/api/tabs/"):]))
        elif path.startswith("/api/folder-items/"):
            self._api_folder_item_remove(urllib.parse.unquote(path[len("/api/folder-items/"):]))
        elif path.startswith("/api/claude-models/"):
            self._api_claude_model_remove(urllib.parse.unquote(path[len("/api/claude-models/"):]))
        elif path.startswith("/api/conversation-models/"):
            parts = [urllib.parse.unquote(p) for p
                     in path[len("/api/conversation-models/"):].split("/") if p]
            if len(parts) != 2:
                self.send_error(404); return
            self._api_conversation_model_remove(parts[0], parts[1])
        else:
            self.send_error(404)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            return {}

    def _parse_multipart_form(self, body: bytes, boundary: bytes) -> dict[str, list[dict]]:
        fields: dict[str, list[dict]] = {}
        marker = b"--" + boundary
        for chunk in body.split(marker):
            part = chunk.strip(b"\r\n")
            if not part or part == b"--":
                continue
            if part.endswith(b"--"):
                part = part[:-2]
            if b"\r\n\r\n" not in part:
                continue
            head, data = part.split(b"\r\n\r\n", 1)
            data = data.rstrip(b"\r\n")
            headers = head.decode("utf-8", errors="replace").split("\r\n")
            disp = next((h for h in headers if h.lower().startswith("content-disposition:")), "")
            if not disp:
                continue
            params = dict(re.findall(r'([a-zA-Z0-9_-]+)="([^"]*)"', disp))
            name = params.get("name", "")
            if not name:
                continue
            fields.setdefault(name, []).append({
                "filename": params.get("filename", ""),
                "data": data,
            })
        return fields

    def _api_upload_file(self):
        length = int(self.headers.get("Content-Length", 0))
        ctype = self.headers.get("Content-Type", "")
        m = re.match(r"multipart/form-data\s*;\s*boundary=(.+)", ctype, re.IGNORECASE)
        if not m:
            self.send_json({"error": "Expected multipart/form-data"}, 400); return
        boundary = m.group(1).strip().strip('"').encode("utf-8")
        body = self.rfile.read(length)
        fields = self._parse_multipart_form(body, boundary)
        files  = fields.get("file", [])
        names  = fields.get("name", [])
        if not files or not names:
            self.send_json({"error": "Missing file or name"}, 400); return
        file_data = files[0].get("data", b"")
        file_name = names[0].get("data", b"").decode("utf-8", errors="replace")
        # Sanitise: strip path separators
        safe_name = Path(file_name).name
        if not safe_name:
            self.send_json({"error": "Invalid filename"}, 400); return
        dest_dir = Path(__file__).parent / "source" / "files"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / safe_name
        dest.write_bytes(file_data)
        # Re-index so next /files/ request can find the new file
        _build_source_index(Path(__file__).parent / "source")
        self.send_json({"ok": True, "saved": safe_name})

    def do_GET(self):
        parsed, path = self._request_target()
        qs     = urllib.parse.parse_qs(parsed.query)
        static_dir = Path(__file__).parent / "static"

        if path in ("/", "/index.html"):
            self._serve_file(static_dir / "index.html")
        elif path in ("/app.js", "/static/app.js"):
            self._serve_file(static_dir / "app.js")
        elif path in ("/style.css", "/static/style.css"):
            self._serve_file(static_dir / "style.css")
        elif path == "/api/conversations":
            self._api_conversations(qs)
        elif path.startswith("/api/conversation/"):
            self._api_detail(urllib.parse.unquote(path[len("/api/conversation/"):]))
        elif path == "/api/search":
            self._api_search(qs)
        elif path == "/api/gallery":
            self._api_gallery()
        elif path == "/api/attachment-report":
            self._api_attachment_report()
        elif path == "/api/import-audit":
            self._api_import_audit(qs)
        elif path == "/api/folders":
            self._api_folders_list()
        elif path == "/api/memories":
            self._api_memories()
        elif path == "/api/projects":
            self._api_projects()
        elif path.startswith("/api/project/"):
            self._api_project(urllib.parse.unquote(path[len("/api/project/"):]))
        elif path.startswith("/api/artifact/"):
            self._api_artifact(urllib.parse.unquote(path[len("/api/artifact/"):]))
        elif path == "/api/claude-models":
            self._api_claude_models()
        elif path == "/api/conversation-models":
            self._api_conversation_models(qs)
        elif path == "/api/preferences":
            self._api_preferences()
        elif path == "/api/pinned":
            self._api_pinned_list()
        elif path == "/api/tabs":
            self._api_tabs()
        elif path == "/api/files-manifest":
            self._api_files_manifest()
        elif path == "/api/file-content":
            self._api_file_content(qs)
        elif path == "/api/search-in-conversation":
            self._api_search_in_conversation(qs)
        elif path.startswith("/files/"):
            self._serve_user_file(urllib.parse.unquote(path[len("/files/"):]))
        elif path.startswith("/chatfiles/"):
            self._serve_named_file(urllib.parse.unquote(path[len("/chatfiles/"):]),
                                   Path(__file__).parent / "source" / "chat_files")
        elif path.startswith("/source/"):
            self._serve_source(urllib.parse.unquote(path[len("/source/"):]))
        else:
            self.send_error(404)

    def _serve_file(self, p):
        if not p.is_file():
            self.send_error(404); return
        data = p.read_bytes()
        mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_source(self, file_id):
        if not re.match(r'^[\w\-./]+$', file_id):
            self.send_error(400); return
        key = file_id.lstrip("/")
        candidates = _SOURCE_INDEX.get(key, [])
        if not candidates:
            self.send_error(404); return
        if len(candidates) > 1:
            self.send_error(409, "Ambiguous source id; use a relative path"); return
        p = candidates[0]
        if p.is_file():
            data = p.read_bytes()
            mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def _serve_named_file(self, filename, base_dir):
        if re.search(r'[\x00-\x1f]', filename) or '..' in filename:
            self.send_error(400); return
        target = (base_dir / filename).resolve()
        if not str(target).startswith(str(base_dir.resolve())):
            self.send_error(403); return
        if not target.is_file():
            self.send_error(404); return
        data = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition",
                         f'inline; filename="{urllib.parse.quote(target.name)}"')
        self.end_headers()
        self.wfile.write(data)

    def _serve_user_file(self, key: str):
        """Serve a file from source/files/ by filename (case-insensitive, space↔underscore)."""
        if re.search(r'[\x00-\x1f]', key) or '..' in key:
            self.send_error(400); return
        files_dir = Path(__file__).parent / "source" / "files"
        p = files_dir / key
        if not p.is_file():
            # Try case-insensitive + space↔underscore normalization
            key_norm = _norm_filename(key)
            p = None
            if files_dir.exists():
                for f in files_dir.iterdir():
                    if _norm_filename(f.name) == key_norm:
                        p = f
                        break
        if not p or not p.is_file():
            self.send_error(404); return
        data = p.read_bytes()
        mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.send_header("Content-Disposition",
                         f'attachment; filename="{urllib.parse.quote(p.name)}"')
        self.end_headers()
        self.wfile.write(data)

    def _api_files_manifest(self):
        """Return list of available files in source/files/ with name→uuid mapping."""
        files_dir = Path(__file__).parent / "source" / "files"
        result = {}
        if files_dir.exists():
            for f in files_dir.iterdir():
                if f.is_file() and not f.name.startswith('.'):
                    result[f.name] = f.name  # name → name (uuid lookup in frontend)
        self.send_json({"files": list(result.keys())})

    def _api_file_content(self, qs):
        """Return text content of a file in source/files/ (DOCX → plain text, image → url)."""
        name = ((qs.get("name") or [""])[0]).strip()
        if not name:
            self.send_json({"error": "missing name"}); return
        files_dir = Path(__file__).parent / "source" / "files"
        # Normalize lookup
        norm = _norm_filename(name)
        real_path = None
        if files_dir.exists():
            for f in files_dir.iterdir():
                if _norm_filename(f.name) == norm:
                    real_path = f
                    break
        if not real_path or not real_path.is_file():
            self.send_json({"error": f"File not found: {name}"}); return
        ext = real_path.suffix.lower()
        # Image
        image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif"}
        if ext in image_exts:
            self.send_json({"name": name, "content": "", "type": "image",
                            "url": "/files/" + urllib.parse.quote(real_path.name)}); return
        # DOCX
        if ext == ".docx":
            docx_document = _DocxDocument
            if not _DOCX_OK or not callable(docx_document):
                self.send_json({"error": "python-docx not installed"}); return
            try:
                doc = docx_document(str(real_path))
                paragraphs = []
                for para in getattr(doc, "paragraphs", []):
                    text = getattr(para, "text", "")
                    if text.strip():
                        paragraphs.append(text)
                content = "\n\n".join(paragraphs)
                self.send_json({"name": name, "content": content, "type": "docx"}); return
            except Exception as e:
                self.send_json({"error": f"Failed to read DOCX: {e}"}); return
        # PDF or other text-like file: try reading as UTF-8 text
        if ext == ".pdf":
            self.send_json({"error": "PDF preview not supported; download the file instead"}); return
        try:
            content = real_path.read_text(encoding="utf-8", errors="replace")
            self.send_json({"name": name, "content": content, "type": ext.lstrip(".")}); return
        except Exception as e:
            self.send_json({"error": f"Cannot read file: {e}"}); return

    def _api_search_in_conversation(self, qs):
        conv_id = ((qs.get("conv_id") or [""])[0]).strip()
        q = ((qs.get("q") or [""])[0]).strip()
        if not conv_id or not q:
            self.send_json({"matches": []}); return
        conn = open_db(self.db_path)
        try:
            # Messages whose content contains the term
            content_rows = conn.execute(
                "SELECT seq, role FROM messages WHERE conversation_id = ? AND content LIKE ? ORDER BY seq",
                (conv_id, f"%{q}%")
            ).fetchall()

            # Messages linked to artifacts whose content contains the term
            try:
                artifact_rows = conn.execute("""
                    SELECT DISTINCT m.seq, m.role
                    FROM messages m
                    JOIN json_each(m.artifact_ids) j ON json_valid(m.artifact_ids)
                    JOIN artifacts a ON a.conv_id = m.conversation_id AND a.id = j.value
                    WHERE m.conversation_id = ?
                      AND a.content LIKE ?
                    ORDER BY m.seq
                """, (conv_id, f"%{q}%")).fetchall()
            except Exception:
                artifact_rows = []

            # Merge and deduplicate by seq, preserving order
            seen = {}
            for r in list(content_rows) + list(artifact_rows):
                if r["seq"] not in seen:
                    seen[r["seq"]] = r["role"]
            matches = [{"seq": k, "role": v} for k, v in sorted(seen.items())]
            self.send_json({"matches": matches, "total": len(matches)})
        finally:
            conn.close()

    def _send_conv_list(self, conn, rows, total, offset, limit):
        """Ship a conversation page, tagged with each row's warning icons.

        unverified_count drives the "Unverified Models" entry in the sidebar
        filter, which only exists while something is actually flagged.
        """
        convs = [dict(r) for r in rows]
        if self._dataset_format(conn) == "claude":
            flags = _compute_conv_flags(
                conn, [(c["id"], c.get("create_time"), c.get("update_time")) for c in convs]
            )
            for c in convs:
                f = flags.get(c["id"])
                c["warn_range"] = bool(f and f["warn_range"])
                c["warn_coverage"] = bool(f and f["warn_coverage"])
            unverified = len(_flagged_conv_ids(conn))
        else:
            unverified = 0
        self.send_json({"conversations": convs, "total": total, "offset": offset,
                        "limit": limit, "unverified_count": unverified})

    def _api_conversations(self, qs):
        limit  = int((qs.get("limit") or ["50"])[0])
        offset = int((qs.get("offset") or ["0"])[0])
        q      = ((qs.get("q") or [""])[0]).strip()
        view   = ((qs.get("view") or ["recent"])[0]).strip().lower()
        pinned_first = ((qs.get("pinned_first") or ["0"])[0]).strip() in ("1", "true", "yes")
        conn = open_db(self.db_path)
        try:
            if view == "unverified":
                flagged = _flagged_conv_ids(conn)
                if not flagged:
                    self.send_json({"conversations": [], "total": 0, "offset": offset,
                                    "limit": limit, "unverified_count": 0})
                    return
                marks = ",".join("?" * len(flagged))
                rows = conn.execute(
                    "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
                    "c.create_time, c.update_time, c.message_count, c.preview "
                    "FROM conversations c "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                    f"WHERE c.id IN ({marks}) AND COALESCE(cm.deleted, 0) = 0 "
                    "ORDER BY c.update_time DESC, c.create_time DESC LIMIT ? OFFSET ?",
                    (*flagged, limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM conversations c "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                    f"WHERE c.id IN ({marks}) AND COALESCE(cm.deleted, 0) = 0",
                    tuple(flagged),
                ).fetchone()[0]
                self._send_conv_list(conn, rows, total, offset, limit)
                return

            if view == "pinned":
                rows = conn.execute(
                    "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.create_time, c.update_time, c.message_count, c.preview "
                    "FROM pinned_conversations p "
                    "JOIN conversations c ON c.id = p.conversation_id "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                    "WHERE COALESCE(cm.deleted, 0) = 0 "
                    # Foldered chats live only in their folder, never the loose
                    # Pinned view.
                    "AND c.id NOT IN (SELECT conversation_id FROM udb.folder_items) "
                    # Ordered newest-first like the other views so the list's
                    # month headers stay chronological. (The pinned view is now
                    # a filter, not the old drag-to-reorder top section.)
                    "ORDER BY c.update_time DESC, c.create_time DESC "
                    "LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM pinned_conversations p "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = p.conversation_id "
                    "WHERE COALESCE(cm.deleted, 0) = 0 "
                    "AND p.conversation_id NOT IN (SELECT conversation_id FROM udb.folder_items)"
                ).fetchone()[0]
                self._send_conv_list(conn, rows, total, offset, limit)
                return

            where_clauses = []
            if view == "deleted":
                where_clauses.append("COALESCE(cm.deleted, 0) = 1")
            else:
                where_clauses.append("COALESCE(cm.deleted, 0) = 0")

            if view == "archived":
                where_clauses.append("COALESCE(cm.archived, 0) = 1")
            elif view == "all":
                pass
            elif view == "deleted":
                pass
            else:
                where_clauses.append("COALESCE(cm.archived, 0) = 0")

            if view == "recent":
                where_clauses.append(
                    "c.id NOT IN (SELECT conversation_id FROM pinned_conversations)"
                )
            # Foldered chats never appear in the main list (any view); they live
            # only in their folder in the sidebar.
            where_clauses.append(
                "c.id NOT IN (SELECT conversation_id FROM udb.folder_items)"
            )
            where_sql = " AND ".join(where_clauses)

            if q:
                like = f"%{q}%"
                if len(q) >= 3:
                    try:
                        order_sql = (
                            "ORDER BY CASE WHEN p.conversation_id IS NULL THEN 1 ELSE 0 END, "
                            "p.order_index ASC, c.update_time DESC, c.create_time DESC"
                        ) if pinned_first else "ORDER BY c.update_time DESC, c.create_time DESC"
                        rows = conn.execute(
                            "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.create_time, c.update_time, c.message_count, c.preview "
                            "FROM conversations c "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                            "LEFT JOIN pinned_conversations p ON p.conversation_id = c.id "
                            "WHERE " + where_sql + " AND c.id IN ("
                            "  SELECT conversation_id FROM search_index WHERE search_index MATCH ? "
                            "  UNION "
                            "  SELECT c2.id FROM conversations c2 "
                            "  LEFT JOIN conversation_meta cm2 ON cm2.conversation_id = c2.id "
                            "  WHERE COALESCE(cm2.deleted, 0) = 0 AND COALESCE(NULLIF(cm2.custom_title, ''), c2.title) LIKE ?"
                            ") "
                            + order_sql + " "
                            "LIMIT ? OFFSET ?",
                            (q, like, limit, offset),
                        ).fetchall()
                        total = conn.execute(
                            "SELECT COUNT(*) FROM conversations c "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                            "WHERE " + where_sql + " AND c.id IN ("
                            "  SELECT conversation_id FROM search_index WHERE search_index MATCH ? "
                            "  UNION "
                            "  SELECT c2.id FROM conversations c2 "
                            "  LEFT JOIN conversation_meta cm2 ON cm2.conversation_id = c2.id "
                            "  WHERE COALESCE(cm2.deleted, 0) = 0 AND COALESCE(NULLIF(cm2.custom_title, ''), c2.title) LIKE ?"
                            ")",
                            (q, like),
                        ).fetchone()[0]
                    except Exception:
                        order_sql = (
                            "ORDER BY CASE WHEN p.conversation_id IS NULL THEN 1 ELSE 0 END, "
                            "p.order_index ASC, c.update_time DESC, c.create_time DESC"
                        ) if pinned_first else "ORDER BY c.update_time DESC, c.create_time DESC"
                        rows = conn.execute(
                            "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.create_time, c.update_time, c.message_count, c.preview "
                            "FROM conversations c "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                            "LEFT JOIN pinned_conversations p ON p.conversation_id = c.id "
                            "WHERE " + where_sql + " AND COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ? "
                            + order_sql + " LIMIT ? OFFSET ?",
                            (like, limit, offset),
                        ).fetchall()
                        total = conn.execute(
                            "SELECT COUNT(*) FROM conversations c "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                            "WHERE " + where_sql + " AND COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ?",
                            (like,)
                        ).fetchone()[0]
                else:
                    order_sql = (
                        "ORDER BY CASE WHEN p.conversation_id IS NULL THEN 1 ELSE 0 END, "
                        "p.order_index ASC, c.update_time DESC, c.create_time DESC"
                    ) if pinned_first else "ORDER BY c.update_time DESC, c.create_time DESC"
                    rows = conn.execute(
                        "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.create_time, c.update_time, c.message_count, c.preview "
                        "FROM conversations c "
                        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                        "LEFT JOIN pinned_conversations p ON p.conversation_id = c.id "
                        "WHERE " + where_sql + " AND COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ? "
                        + order_sql + " LIMIT ? OFFSET ?",
                        (like, limit, offset),
                    ).fetchall()
                    total = conn.execute(
                        "SELECT COUNT(*) FROM conversations c "
                        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                        "WHERE " + where_sql + " AND COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ?",
                        (like,)
                    ).fetchone()[0]
            else:
                order_sql = (
                    "ORDER BY CASE WHEN p.conversation_id IS NULL THEN 1 ELSE 0 END, "
                    "p.order_index ASC, c.update_time DESC, c.create_time DESC"
                ) if pinned_first else "ORDER BY c.update_time DESC, c.create_time DESC"
                rows = conn.execute(
                    "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.create_time, c.update_time, c.message_count, c.preview "
                    "FROM conversations c "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                    "LEFT JOIN pinned_conversations p ON p.conversation_id = c.id "
                    "WHERE " + where_sql + " "
                    + order_sql + " "
                    "LIMIT ? OFFSET ?", (limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM conversations c "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                    "WHERE " + where_sql
                ).fetchone()[0]
            self._send_conv_list(conn, rows, total, offset, limit)
        finally:
            conn.close()

    def _api_detail(self, conv_id):
        conn = open_db(self.db_path)
        try:
            conv = conn.execute(
                "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
                "c.create_time, c.update_time, c.message_count, c.preview, "
                "COALESCE(c.import_status, 'normal') AS import_status, "
                "COALESCE(cm.deleted, 0) AS deleted "
                "FROM conversations c LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                # No deleted filter: soft-deleted means "kept out of the lists",
                # not "unreadable". The import audit lists these deliberately,
                # and refusing them here left it opening records it could not show.
                "WHERE c.id = ?", (conv_id,)
            ).fetchone()
            if not conv:
                self.send_error(404); return
            msgs = conn.execute(
                "SELECT seq, role, content, attachments, artifact_ids, siblings, branch_index, create_time "
                "FROM messages WHERE conversation_id = ? ORDER BY seq", (conv_id,),
            ).fetchall()
            def parse_msg(m):
                d = dict(m)
                for field in ("attachments", "siblings", "artifact_ids"):
                    raw = d.get(field)
                    if raw:
                        try: d[field] = json.loads(raw)
                        except: d[field] = [] if field != "siblings" else None
                    else:
                        d[field] = [] if field != "siblings" else None
                return d
            try:
                art_rows = conn.execute(
                    "SELECT id, title, type, lang FROM artifacts WHERE conv_id = ?", (conv_id,),
                ).fetchall()
                artifacts_meta = {r["id"]: dict(r) for r in art_rows}
            except Exception:
                artifacts_meta = {}
            # The model strip's state rides along with the detail so opening a
            # conversation stays a single request. None on a ChatGPT export,
            # where the whole feature is absent.
            models = (self._conv_model_state(conn, conv_id)
                      if self._dataset_format(conn) == "claude" else None)
            self.send_json({"conversation": dict(conv),
                            "messages": [parse_msg(m) for m in msgs],
                            "artifacts": artifacts_meta,
                            "models": models})
        finally:
            conn.close()

    def _api_search(self, qs):
        q     = ((qs.get("q") or [""])[0]).strip()
        limit = int((qs.get("limit") or ["40"])[0])
        if not q:
            self.send_json({"results": [], "q": q}); return
        conn = open_db(self.db_path)
        try:
            # Step 1: find matching conversations via FTS or title LIKE
            conv_ids = []
            conv_ids_set = set()
            if len(q) >= 3:
                try:
                    for r in conn.execute(
                        "SELECT DISTINCT conversation_id FROM search_index WHERE search_index MATCH ? LIMIT 30",
                        (q,)
                    ).fetchall():
                        if r[0] not in conv_ids_set:
                            conv_ids.append(r[0]); conv_ids_set.add(r[0])
                except Exception:
                    pass
            # Always add title LIKE matches
            for r in conn.execute(
                "SELECT id FROM conversations WHERE title LIKE ? LIMIT 15",
                (f"%{q}%",)
            ).fetchall():
                if r[0] not in conv_ids_set:
                    conv_ids.append(r[0]); conv_ids_set.add(r[0])

            # Step 2: for each conv, find messages matching query
            results = []
            for conv_id in conv_ids[:25]:
                conv = conn.execute(
                    "SELECT title FROM conversations WHERE id = ?", (conv_id,)
                ).fetchone()
                if not conv: continue
                conv_title = conv["title"]
                msg_rows = conn.execute(
                    "SELECT seq, role, content FROM messages "
                    "WHERE conversation_id = ? AND content LIKE ? ORDER BY seq LIMIT 3",
                    (conv_id, f"%{q}%")
                ).fetchall()
                if msg_rows:
                    for m in msg_rows:
                        snippet = _extract_snippet(m["content"] or "", q, 100)
                        results.append({
                            "conv_id":    conv_id,
                            "conv_title": conv_title,
                            "seq":        m["seq"],
                            "role":       m["role"],
                            "snippet":    snippet,
                        })
                else:
                    # Title matched but no message body match → add title-level result
                    results.append({
                        "conv_id":    conv_id,
                        "conv_title": conv_title,
                        "seq":        None,
                        "role":       None,
                        "snippet":    "",
                    })
            self.send_json({"results": results[:limit], "q": q})
        finally:
            conn.close()

    def _api_gallery(self):
        image_exts = frozenset({"png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "heic", "heif"})

        def is_image_like(name: str, file_type: str) -> bool:
            file_type = (file_type or "").strip().lower().lstrip(".")
            name_ext = Path(name or "").suffix.lower().lstrip(".")
            return file_type == "image" or file_type in image_exts or name_ext in image_exts

        def ensure_group(groups: dict, conv_id: str, title: str, update_time, message_count, preview: str):
            group = groups.get(conv_id)
            if group is None:
                group = {
                    "conv_id": conv_id,
                    "conv_title": title,
                    "update_time": update_time,
                    "message_count": message_count,
                    "preview": preview or "",
                    "items": [],
                }
                groups[conv_id] = group
            return group

        def finalize_groups(groups: dict) -> list[dict]:
            out = list(groups.values())
            for group in out:
                group["items"].sort(
                    key=lambda item: (
                        item.get("seq") is None,
                        item.get("seq") or 0,
                        item.get("name") or "",
                    )
                )
            out.sort(key=lambda group: group.get("update_time") or 0, reverse=True)
            return out

        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT m.conversation_id AS conv_id, m.seq, m.role, m.content, m.attachments, "
                "c.title AS conv_title, c.update_time, c.message_count, c.preview, "
                "COALESCE(NULLIF(cm.custom_title, ''), c.title) AS display_title "
                "FROM messages m JOIN conversations c ON c.id = m.conversation_id "
                "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "WHERE COALESCE(cm.deleted, 0) = 0 "
                "ORDER BY c.update_time DESC, m.seq"
            ).fetchall()

            image_groups = {}
            attachment_groups = {}
            linked_image_names = set()

            for r in rows:
                conv_id = r["conv_id"]
                title = r["display_title"] or r["conv_title"] or conv_id
                base_item = {
                    "conv_id": conv_id,
                    "conv_title": title,
                    "update_time": r["update_time"],
                    "message_count": r["message_count"],
                    "preview": r["preview"] or "",
                    "seq": r["seq"],
                    "role": r["role"],
                    "context": (r["content"] or "").strip()[:120],
                }
                try:
                    attachments = json.loads(r["attachments"] or "[]")
                except Exception:
                    attachments = []
                for att in attachments:
                    if not isinstance(att, dict):
                        continue
                    name = (att.get("name") or att.get("file_name") or "").strip()
                    file_type = (att.get("type") or att.get("file_type") or "").strip()
                    content = (att.get("content") or "").strip()
                    item = {
                        **base_item,
                        "name": name or "Attachment",
                        "type": file_type,
                        "has_content": bool(content),
                    }
                    if is_image_like(name, file_type):
                        item["kind"] = "image"
                        linked_image_names.add(_norm_filename(name or item["name"]))
                        ensure_group(image_groups, conv_id, title, r["update_time"], r["message_count"], r["preview"])["items"].append(item)
                    else:
                        item["kind"] = "attachment"
                        ensure_group(attachment_groups, conv_id, title, r["update_time"], r["message_count"], r["preview"])["items"].append(item)

            artifact_groups = {}
            art_rows = conn.execute(
                "SELECT a.id, a.conv_id, a.msg_seq, a.title, a.type, a.lang, a.content, "
                "c.title AS conv_title, c.update_time, c.message_count, c.preview, "
                "COALESCE(NULLIF(cm.custom_title, ''), c.title) AS display_title "
                "FROM artifacts a JOIN conversations c ON c.id = a.conv_id "
                "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "WHERE COALESCE(cm.deleted, 0) = 0 "
                "ORDER BY c.update_time DESC, a.msg_seq, a.id"
            ).fetchall()
            for r in art_rows:
                title = r["display_title"] or r["conv_title"] or r["conv_id"]
                ensure_group(artifact_groups, r["conv_id"], title, r["update_time"], r["message_count"], r["preview"])["items"].append({
                    "conv_id": r["conv_id"],
                    "conv_title": title,
                    "update_time": r["update_time"],
                    "message_count": r["message_count"],
                    "preview": r["preview"] or "",
                    "artifact_id": r["id"],
                    "msg_seq": r["msg_seq"],
                    "seq": r["msg_seq"],
                    "name": r["title"] or r["id"],
                    "type": r["type"] or "artifact",
                    "lang": r["lang"] or "",
                    "context": (r["content"] or "").strip()[:120],
                    "kind": "artifact",
                })

            unlinked_images = []
            source_dirs = [
                Path(__file__).parent / "source" / "dalle-generations",
                Path(__file__).parent / "source" / "files",
            ]
            for src_dir in source_dirs:
                if not src_dir.exists():
                    continue
                for f in sorted(src_dir.iterdir()):
                    if not f.is_file() or f.name.startswith('.'):
                        continue
                    if f.suffix.lower().lstrip(".") not in image_exts:
                        continue
                    if src_dir.name == "files" and _norm_filename(f.name) in linked_image_names:
                        continue
                    unlinked_images.append({
                        "filename": f.name,
                        "url": f"/source/{f.name}" if src_dir.name == "dalle-generations" else "/files/" + urllib.parse.quote(f.name),
                    })

            self.send_json({
                "sections": [
                    {
                        "key": "images",
                        "title": "Conversation Images",
                        "meta": "Images that can jump back to their source conversation.",
                        "count": sum(len(group["items"]) for group in image_groups.values()),
                        "groups": finalize_groups(image_groups),
                    },
                    {
                        "key": "attachments",
                        "title": "Attachments",
                        "meta": "All attachment chips grouped by conversation.",
                        "count": sum(len(group["items"]) for group in attachment_groups.values()),
                        "groups": finalize_groups(attachment_groups),
                    },
                    {
                        "key": "artifacts",
                        "title": "Artifacts",
                        "meta": "Claude-generated artifacts grouped by the conversation that created them.",
                        "count": sum(len(group["items"]) for group in artifact_groups.values()),
                        "groups": finalize_groups(artifact_groups),
                    },
                ],
                "unlinked_images": unlinked_images,
            })
        finally:
            conn.close()

    def _api_attachment_report(self):
        """Return all attachments that couldn't be displayed (no content + not in source/files/)."""
        files_dir = Path(__file__).parent / "source" / "files"
        local_norms = set()
        if files_dir.exists():
            for f in files_dir.iterdir():
                if f.is_file() and not f.name.startswith('.'):
                    local_norms.add(_norm_filename(f.name))
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT m.seq, m.role, m.content, m.attachments, c.id AS conv_id, c.title AS conv_title "
                "FROM messages m JOIN conversations c ON c.id = m.conversation_id "
                "WHERE m.attachments IS NOT NULL AND m.attachments != '[]' AND m.attachments != '' "
                "ORDER BY c.update_time DESC, m.seq"
            ).fetchall()
        finally:
            conn.close()

        missing = []
        seen = set()
        for r in rows:
            try:
                atts = json.loads(r["attachments"] or "[]")
            except Exception:
                continue
            for a in atts:
                name = a.get("name") or ""
                if not name:
                    continue
                has_content = bool(a.get("content"))
                norm = _norm_filename(name)
                in_local = norm in local_norms
                if not has_content and not in_local:
                    key = (r["conv_id"], name)
                    if key in seen:
                        continue
                    seen.add(key)
                    ctx = (r["content"] or "").strip()[:80]
                    missing.append({
                        "conv_id":    r["conv_id"],
                        "conv_title": r["conv_title"],
                        "seq":        r["seq"],
                        "role":       r["role"],
                        "file_name":  name,
                        "file_type":  a.get("type") or "",
                        "context":    ctx,
                    })
        self.send_json({"missing": missing, "total": len(missing)})

    def _api_import_audit(self, qs):
        """Import-audit inspection view.

        Without ?status=… : return per-status counts over the whole database.
        With    ?status=X : return the conversations whose import_status = X,
        so the UI can browse the records that came in as metadata_only, etc.
        """
        status = ((qs.get("status") or [""])[0]).strip().lower()
        valid = {"normal", "fallback", "metadata_only", "parse_error"}
        conn = open_db(self.db_path)
        try:
            # import_status/source_index may be absent on very old DBs; the
            # runtime schema adds them, but stay defensive.
            try:
                # import_sources holds one row per object in conversations.json,
                # duplicates included, so the audit adds up to the source file.
                # Databases built before it existed fall back to conversations,
                # which undercounts collapsed duplicates but still works.
                by_source = bool(conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_sources'"
                ).fetchone()) and bool(conn.execute(
                    "SELECT 1 FROM import_sources LIMIT 1"
                ).fetchone())

                if status:
                    if status not in valid:
                        self.send_json({"error": "unknown status"}, 400); return
                    if by_source:
                        rows = conn.execute(
                            "SELECT s.conversation_id AS id, "
                            "COALESCE(NULLIF(cm.custom_title, ''), s.title) AS title, "
                            "c.create_time, c.update_time, "
                            "COALESCE(c.message_count, 0) AS message_count, c.preview, "
                            "s.import_status, s.source_index, s.kept "
                            "FROM import_sources s "
                            "LEFT JOIN conversations c ON c.id = s.conversation_id "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = s.conversation_id "
                            "WHERE s.import_status = ? "
                            "ORDER BY s.source_index ASC",
                            (status,),
                        ).fetchall()
                    else:
                        rows = conn.execute(
                            "SELECT c.id, "
                            "COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
                            "c.create_time, c.update_time, c.message_count, c.preview, "
                            "c.import_status, c.source_index, 1 AS kept "
                            "FROM conversations c "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                            # No archived/deleted filter: this is an import audit, so
                            # it must show every record of the status (counts match).
                            "WHERE COALESCE(c.import_status, 'normal') = ? "
                            "ORDER BY c.source_index IS NULL, c.source_index ASC, c.create_time DESC",
                            (status,),
                        ).fetchall()
                    self.send_json({
                        "status": status,
                        "conversations": [dict(r) for r in rows],
                        "total": len(rows),
                    })
                    return

                counts = {}
                if by_source:
                    for r in conn.execute(
                        "SELECT import_status AS s, COUNT(*) AS n "
                        "FROM import_sources GROUP BY import_status"
                    ).fetchall():
                        counts[r["s"]] = r["n"]
                    total = conn.execute("SELECT COUNT(*) FROM import_sources").fetchone()[0]
                    synthetic = conn.execute(
                        "SELECT COUNT(*) FROM import_sources WHERE synthetic = 1"
                    ).fetchone()[0]
                    collapsed = conn.execute(
                        "SELECT COUNT(*) FROM import_sources WHERE kept = 0"
                    ).fetchone()[0]
                else:
                    for r in conn.execute(
                        "SELECT COALESCE(import_status, 'normal') AS s, COUNT(*) AS n "
                        "FROM conversations GROUP BY COALESCE(import_status, 'normal')"
                    ).fetchall():
                        counts[r["s"]] = r["n"]
                    total = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
                    synthetic = conn.execute(
                        "SELECT COUNT(*) FROM conversations WHERE id LIKE 'synthetic-%'"
                    ).fetchone()[0]
                    collapsed = 0
            except sqlite3.Error as e:
                self.send_json({"error": f"audit unavailable: {e}"}, 500); return

            self.send_json({
                "total":         total,
                "normal":        counts.get("normal", 0),
                "fallback":      counts.get("fallback", 0),
                "metadata_only": counts.get("metadata_only", 0),
                "parse_error":   counts.get("parse_error", 0),
                "synthetic":     synthetic,
                "collapsed":     collapsed,
                "stored":        conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0],
            })
        finally:
            conn.close()

    # ── Folders ────────────────────────────────────────────────────────────────

    def _api_folders_list(self):
        """Return every folder and the conversations it holds (for the sidebar)."""
        conn = open_db(self.db_path)
        try:
            folders = conn.execute(
                "SELECT id, name, created_at, updated_at FROM udb.folders "
                # Alphabetical by default; a folder that has been used (a chat
                # moved into it → updated_at set) floats to the top by recency.
                "ORDER BY (updated_at IS NULL), updated_at DESC, LOWER(name) ASC"
            ).fetchall()
            rows = conn.execute(
                "SELECT fi.folder_id AS folder_id, fi.pinned AS pinned, "
                "c.id AS id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
                "c.create_time AS create_time, c.update_time AS update_time, "
                "c.message_count AS message_count "
                "FROM udb.folder_items fi "
                "JOIN conversations c ON c.id = fi.conversation_id "
                "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "WHERE COALESCE(cm.deleted, 0) = 0 "
                # Pinned chats float to the top within the folder, then newest.
                "ORDER BY fi.pinned DESC, c.update_time DESC, c.create_time DESC"
            ).fetchall()
            by_folder: dict = {}
            for r in rows:
                by_folder.setdefault(r["folder_id"], []).append({
                    "id":            r["id"],
                    "title":         r["title"],
                    "create_time":   r["create_time"],
                    "update_time":   r["update_time"],
                    "message_count": r["message_count"],
                    "pinned":        bool(r["pinned"]),
                })
            out = [{
                "id":            f["id"],
                "name":          f["name"],
                "created_at":    f["created_at"],
                "updated_at":    f["updated_at"],
                "conversations": by_folder.get(f["id"], []),
            } for f in folders]
            self.send_json({"folders": out})
        finally:
            conn.close()

    def _api_folder_create(self):
        payload = self._read_json_body()
        name = (payload.get("name") or "").strip()
        if not name:
            self.send_json({"error": "missing name"}, 400); return
        fid = uuid.uuid4().hex
        conn = open_db(self.db_path)
        try:
            conn.execute(
                "INSERT INTO udb.folders (id, name, created_at, updated_at) "
                "VALUES (?, ?, ?, NULL)",
                (fid, name, time.time()),
            )
            conn.commit()
            self.send_json({"ok": True, "id": fid, "name": name})
        finally:
            conn.close()

    def _api_folder_update(self, fid):
        payload = self._read_json_body()
        name = (payload.get("name") or "").strip()
        if not fid or not name:
            self.send_json({"error": "missing name"}, 400); return
        conn = open_db(self.db_path)
        try:
            conn.execute("UPDATE udb.folders SET name = ? WHERE id = ?", (name, fid))
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_folder_item_add(self):
        """Move a conversation into a folder. Clears any loose pin and the
        archived flag (foldered chats are not archived, and never show in the
        loose Pinned view)."""
        payload = self._read_json_body()
        fid = (payload.get("folder_id") or "").strip()
        cid = (payload.get("conversation_id") or "").strip()
        if not fid or not cid:
            self.send_json({"error": "missing folder_id or conversation_id"}, 400); return
        now = time.time()
        conn = open_db(self.db_path)
        try:
            if not conn.execute("SELECT 1 FROM udb.folders WHERE id = ?", (fid,)).fetchone():
                self.send_json({"error": "folder not found"}, 404); return
            conn.execute("DELETE FROM pinned_conversations WHERE conversation_id = ?", (cid,))
            conn.execute(
                "INSERT OR IGNORE INTO conversation_meta(conversation_id, custom_title, archived, deleted) "
                "VALUES (?, NULL, 0, 0)", (cid,),
            )
            conn.execute("UPDATE conversation_meta SET archived = 0 WHERE conversation_id = ?", (cid,))
            conn.execute(
                "INSERT INTO udb.folder_items (conversation_id, folder_id, added_at, pinned) "
                "VALUES (?, ?, ?, 0) "
                "ON CONFLICT(conversation_id) DO UPDATE SET "
                "  folder_id = excluded.folder_id, added_at = excluded.added_at, pinned = 0",
                (cid, fid, now),
            )
            conn.execute("UPDATE udb.folders SET updated_at = ? WHERE id = ?", (now, fid))
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_folder_item_update(self, cid):
        """Toggle the pinned-within-folder flag for one conversation."""
        payload = self._read_json_body()
        if not cid:
            self.send_json({"error": "missing conversation id"}, 400); return
        conn = open_db(self.db_path)
        try:
            if "pinned" in payload:
                conn.execute(
                    "UPDATE udb.folder_items SET pinned = ? WHERE conversation_id = ?",
                    (1 if payload.get("pinned") else 0, cid),
                )
                conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_folder_item_remove(self, cid):
        """Remove a conversation from its folder → it returns to the main list."""
        if not cid:
            self.send_json({"error": "missing conversation id"}, 400); return
        conn = open_db(self.db_path)
        try:
            conn.execute("DELETE FROM udb.folder_items WHERE conversation_id = ?", (cid,))
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_memories(self):
        conn = open_db(self.db_path)
        try:
            rows = conn.execute("SELECT id, content FROM memories ORDER BY id").fetchall()
            self.send_json({"memories": [dict(r) for r in rows]})
        except Exception:
            self.send_json({"memories": []})
        finally:
            conn.close()

    def _api_projects(self):
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT p.id, p.name, p.description, p.create_time, p.update_time, "
                "COUNT(d.id) AS doc_count "
                "FROM projects p LEFT JOIN project_docs d ON d.project_id = p.id "
                "GROUP BY p.id "
                "ORDER BY p.update_time DESC"
            ).fetchall()
            self.send_json({"projects": [dict(r) for r in rows]})
        except Exception:
            self.send_json({"projects": []})
        finally:
            conn.close()

    def _api_project(self, project_id):
        conn = open_db(self.db_path)
        try:
            proj = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not proj:
                self.send_error(404); return
            docs = conn.execute(
                "SELECT id, filename, content, create_time FROM project_docs "
                "WHERE project_id = ? ORDER BY create_time", (project_id,),
            ).fetchall()
            self.send_json({"project": dict(proj), "docs": [dict(d) for d in docs]})
        finally:
            conn.close()

    def _api_artifact(self, artifact_id):
        conn = open_db(self.db_path)
        try:
            row = conn.execute(
                "SELECT id, conv_id, msg_seq, title, type, lang, content "
                "FROM artifacts WHERE id = ?", (artifact_id,),
            ).fetchone()
            if row:
                self.send_json(dict(row))
            else:
                self.send_error(404)
        finally:
            conn.close()

    # ── Claude model availability ────────────────────────────────────────────

    def _dataset_format(self, conn) -> str:
        """'claude' or 'chatgpt' for the loaded export.

        build_db records this at index time. Databases built before the model
        feature existed have no record, so sniff the head of the export once
        and store the answer rather than re-reading a large file every request.
        """
        try:
            row = conn.execute(
                "SELECT pref_value FROM ui_preferences WHERE pref_key = 'dataset_format'"
            ).fetchone()
        except sqlite3.Error:
            return "claude"
        if row:
            try:
                value = json.loads(row["pref_value"])
            except Exception:
                value = row["pref_value"]
            if value in ("claude", "chatgpt"):
                return value
        fmt = "claude"
        try:
            with open(Path(self.source_dir) / "conversations.json", encoding="utf-8",
                      errors="replace") as f:
                head = f.read(8192)
            fmt = "claude" if '"chat_messages"' in head else "chatgpt"
        except Exception:
            pass
        try:
            conn.execute(
                "INSERT OR REPLACE INTO ui_preferences(pref_key, pref_value) VALUES "
                "('dataset_format', ?)", (json.dumps(fmt),),
            )
            conn.commit()
        except sqlite3.Error:
            pass
        return fmt

    def _model_rows(self, conn):
        """Every model period, newest model first, a model's own periods newest
        first inside its group — so a model that returned after a gap keeps its
        rows together."""
        try:
            rows = conn.execute(
                "SELECT p.id AS period_id, p.model_id, m.name, p.start_date, p.end_date "
                "FROM udb.claude_model_periods p "
                "JOIN udb.claude_models m ON m.id = p.model_id"
            ).fetchall()
        except sqlite3.Error:
            return []
        groups: dict[str, list[dict]] = {}
        for r in rows:
            groups.setdefault(r["model_id"], []).append(dict(r))
        ordered = sorted(
            groups.values(),
            key=lambda g: min(p["start_date"] for p in g),
            reverse=True,
        )
        out = []
        for group in ordered:
            out.extend(sorted(group, key=lambda p: p["start_date"], reverse=True))
        return out

    def _api_claude_models(self):
        conn = open_db(self.db_path)
        try:
            self.send_json({"models": self._model_rows(conn),
                            "format": self._dataset_format(conn)})
        finally:
            conn.close()

    def _api_claude_model_add(self):
        payload = self._read_json_body()
        name  = str(payload.get("name") or "").strip()
        start = _norm_date(payload.get("start_date"))
        # An omitted end date means "still available"; a malformed one is an
        # error. Collapsing the two would turn a typo into an open-ended period.
        raw_end = str(payload.get("end_date") or "").strip()
        end = None if not raw_end else _norm_date(raw_end)
        if not name:
            self.send_json({"error": "Model Name is required"}, 400); return
        if not start:
            self.send_json({"error": "Beginning date is required (YYYY-MM-DD)"}, 400); return
        if raw_end and not end:
            self.send_json({"error": "End date must be YYYY-MM-DD"}, 400); return
        if end and end <= start:
            self.send_json({"error": "End date must be after the beginning date"}, 400); return
        conn = open_db(self.db_path)
        try:
            # Re-using an existing name adds a second availability window to
            # that same model rather than creating a duplicate model.
            row = conn.execute(
                "SELECT id FROM udb.claude_models WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()
            now = time.time()
            model_id = row["id"] if row else uuid.uuid4().hex
            if not row:
                conn.execute(
                    "INSERT INTO udb.claude_models(id, name, created_at) VALUES (?, ?, ?)",
                    (model_id, name, now),
                )
            conn.execute(
                "INSERT INTO udb.claude_model_periods(id, model_id, start_date, end_date, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, model_id, start, end, now),
            )
            conn.commit()
            self.send_json({"ok": True, "models": self._model_rows(conn)})
        finally:
            conn.close()

    def _api_claude_model_update(self, period_id):
        payload = self._read_json_body()
        conn = open_db(self.db_path)
        try:
            row = conn.execute(
                "SELECT model_id, start_date, end_date FROM udb.claude_model_periods WHERE id = ?",
                (period_id,),
            ).fetchone()
            if not row:
                self.send_json({"error": "Unknown model row"}, 404); return
            start, end = row["start_date"], row["end_date"]
            if "start_date" in payload:
                start = _norm_date(payload.get("start_date"))
                if not start:
                    self.send_json({"error": "Beginning date is required (YYYY-MM-DD)"}, 400); return
            if "end_date" in payload:
                raw = str(payload.get("end_date") or "").strip()
                end = None if not raw else _norm_date(raw)
                if raw and not end:
                    self.send_json({"error": "End date must be YYYY-MM-DD"}, 400); return
            if end and end <= start:
                self.send_json({"error": "End date must be after the beginning date"}, 400); return
            if "name" in payload:
                name = str(payload.get("name") or "").strip()
                if not name:
                    self.send_json({"error": "Model Name is required"}, 400); return
                # The name belongs to the model, so editing it in any row
                # renames the model and every availability window it has.
                conn.execute("UPDATE udb.claude_models SET name = ? WHERE id = ?",
                             (name, row["model_id"]))
            conn.execute(
                "UPDATE udb.claude_model_periods SET start_date = ?, end_date = ? WHERE id = ?",
                (start, end, period_id),
            )
            conn.commit()
            self.send_json({"ok": True, "models": self._model_rows(conn)})
        finally:
            conn.close()

    def _api_claude_model_remove(self, period_id):
        conn = open_db(self.db_path)
        try:
            row = conn.execute(
                "SELECT model_id FROM udb.claude_model_periods WHERE id = ?", (period_id,)
            ).fetchone()
            if not row:
                self.send_json({"error": "Unknown model row"}, 404); return
            conn.execute("DELETE FROM udb.claude_model_periods WHERE id = ?", (period_id,))
            # Dropping a model's last window drops the model, and with it any
            # conversation that pointed at it.
            left = conn.execute(
                "SELECT COUNT(*) FROM udb.claude_model_periods WHERE model_id = ?",
                (row["model_id"],),
            ).fetchone()[0]
            if not left:
                conn.execute("DELETE FROM udb.claude_models WHERE id = ?", (row["model_id"],))
                conn.execute("DELETE FROM udb.conversation_models WHERE model_id = ?",
                             (row["model_id"],))
            conn.commit()
            self.send_json({"ok": True, "models": self._model_rows(conn)})
        finally:
            conn.close()

    def _conv_model_state(self, conn, conv_id):
        """Selected models, the models still offerable for this conversation,
        and the two warning states — everything the header strip needs."""
        conv = conn.execute(
            "SELECT create_time, update_time FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        if not conv:
            return None
        first_day, last_day = _conv_date_range(conv["create_time"], conv["update_time"])
        rows = self._model_rows(conn)
        by_model: dict[str, dict] = {}
        for r in rows:
            entry = by_model.setdefault(
                r["model_id"], {"model_id": r["model_id"], "name": r["name"], "periods": []}
            )
            entry["periods"].append((r["start_date"], r["end_date"]))
        chosen = [
            r["model_id"] for r in conn.execute(
                "SELECT model_id FROM udb.conversation_models WHERE conversation_id = ? "
                "ORDER BY added_at", (conv_id,)
            ).fetchall()
        ]
        chosen = [mid for mid in chosen if mid in by_model]
        selected = [{"model_id": mid, "name": by_model[mid]["name"]} for mid in chosen]
        # Offer only models whose availability overlaps the conversation, and
        # never one that is already selected.
        available = []
        if first_day:
            for entry in by_model.values():
                if entry["model_id"] in chosen:
                    continue
                if any(_period_overlaps(s, e, first_day, last_day) for s, e in entry["periods"]):
                    available.append({"model_id": entry["model_id"], "name": entry["name"]})
        flags = _compute_conv_flags(
            conn, [(conv_id, conv["create_time"], conv["update_time"])]
        ).get(conv_id, {"warn_range": False, "warn_coverage": False})
        return {
            "selected": selected,
            "available": available,
            "warn_range": flags["warn_range"],
            "warn_coverage": flags["warn_coverage"],
        }

    def _api_conversation_models(self, qs):
        conv_id = ((qs.get("conv_id") or [""])[0]).strip()
        conn = open_db(self.db_path)
        try:
            state = self._conv_model_state(conn, conv_id)
            if state is None:
                self.send_json({"error": "Unknown conversation"}, 404); return
            self.send_json(state)
        finally:
            conn.close()

    def _api_conversation_model_add(self):
        payload = self._read_json_body()
        conv_id  = str(payload.get("conv_id") or "").strip()
        model_id = str(payload.get("model_id") or "").strip()
        if not conv_id or not model_id:
            self.send_json({"error": "conv_id and model_id are required"}, 400); return
        conn = open_db(self.db_path)
        try:
            if not conn.execute("SELECT 1 FROM udb.claude_models WHERE id = ?",
                                (model_id,)).fetchone():
                self.send_json({"error": "Unknown model"}, 404); return
            conn.execute(
                "INSERT OR IGNORE INTO udb.conversation_models(conversation_id, model_id, added_at) "
                "VALUES (?, ?, ?)", (conv_id, model_id, time.time()),
            )
            conn.commit()
            state = self._conv_model_state(conn, conv_id)
            if state is None:
                self.send_json({"error": "Unknown conversation"}, 404); return
            self.send_json(state)
        finally:
            conn.close()

    def _api_conversation_model_remove(self, conv_id, model_id):
        conn = open_db(self.db_path)
        try:
            conn.execute(
                "DELETE FROM udb.conversation_models WHERE conversation_id = ? AND model_id = ?",
                (conv_id, model_id),
            )
            conn.commit()
            state = self._conv_model_state(conn, conv_id)
            if state is None:
                self.send_json({"error": "Unknown conversation"}, 404); return
            self.send_json(state)
        finally:
            conn.close()

    def _api_conversation_model_dismiss(self):
        payload = self._read_json_body()
        conv_id = str(payload.get("conv_id") or "").strip()
        kind    = str(payload.get("kind") or "").strip()
        if not conv_id or kind not in ("range", "coverage"):
            self.send_json({"error": "conv_id and kind ('range'|'coverage') are required"}, 400)
            return
        column = "range_dismissed" if kind == "range" else "coverage_dismissed"
        conn = open_db(self.db_path)
        try:
            conn.execute(
                "INSERT OR IGNORE INTO udb.conversation_model_flags(conversation_id) VALUES (?)",
                (conv_id,),
            )
            conn.execute(
                f"UPDATE udb.conversation_model_flags SET {column} = 1 WHERE conversation_id = ?",
                (conv_id,),
            )
            conn.commit()
            state = self._conv_model_state(conn, conv_id)
            if state is None:
                self.send_json({"error": "Unknown conversation"}, 404); return
            self.send_json(state)
        finally:
            conn.close()

    def _api_preferences(self):
        conn = open_db(self.db_path)
        try:
            rows = conn.execute("SELECT pref_key, pref_value FROM ui_preferences").fetchall()
            prefs = {}
            for r in rows:
                try:
                    prefs[r["pref_key"]] = json.loads(r["pref_value"])
                except Exception:
                    prefs[r["pref_key"]] = r["pref_value"]
            self.send_json({"preferences": prefs})
        finally:
            conn.close()

    def _api_preferences_update(self):
        payload = self._read_json_body()
        prefs = payload.get("preferences") if isinstance(payload.get("preferences"), dict) else payload
        if not isinstance(prefs, dict):
            self.send_json({"error": "Invalid preferences payload"}, 400); return
        conn = open_db(self.db_path)
        try:
            for k, v in prefs.items():
                conn.execute(
                    "INSERT OR REPLACE INTO ui_preferences(pref_key, pref_value) VALUES (?, ?)",
                    (str(k), json.dumps(v, ensure_ascii=False)),
                )
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_pinned_list(self):
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT p.conversation_id, p.pinned_at, p.order_index, "
                "COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.update_time, c.message_count, c.preview "
                "FROM pinned_conversations p "
                "JOIN conversations c ON c.id = p.conversation_id "
                "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "WHERE COALESCE(cm.deleted, 0) = 0 "
                "ORDER BY p.order_index ASC, p.pinned_at DESC"
            ).fetchall()
            self.send_json({"pinned": [dict(r) for r in rows]})
        finally:
            conn.close()

    def _api_pinned_add(self):
        payload = self._read_json_body()
        conv_id = (payload.get("conversation_id") or "").strip()
        if not conv_id:
            self.send_json({"error": "missing conversation_id"}, 400); return
        conn = open_db(self.db_path)
        try:
            exists = conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            if not exists:
                self.send_json({"error": "conversation not found"}, 404); return
            next_idx = conn.execute("SELECT COALESCE(MAX(order_index), -1) + 1 FROM pinned_conversations").fetchone()[0]
            conn.execute(
                "INSERT OR REPLACE INTO pinned_conversations(conversation_id, pinned_at, order_index) VALUES (?, ?, ?)",
                (conv_id, time.time(), int(next_idx)),
            )
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_pinned_remove(self, conv_id):
        conn = open_db(self.db_path)
        try:
            conn.execute("DELETE FROM pinned_conversations WHERE conversation_id = ?", (conv_id,))
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_pinned_reorder(self):
        payload = self._read_json_body()
        ids = payload.get("ids") or []
        if not isinstance(ids, list):
            self.send_json({"error": "ids must be a list"}, 400); return
        conn = open_db(self.db_path)
        try:
            for i, cid in enumerate(ids):
                conn.execute(
                    "UPDATE pinned_conversations SET order_index = ? WHERE conversation_id = ?",
                    (i, str(cid)),
                )
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_tabs(self):
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT id, tab_type, conversation_id, artifact_id, title, pinned, sort_index, last_active_at "
                "FROM workspace_tabs WHERE closed = 0 ORDER BY pinned DESC, sort_index ASC, last_active_at DESC"
            ).fetchall()
            self.send_json({"tabs": [dict(r) for r in rows]})
        finally:
            conn.close()

    def _api_tabs_create(self):
        payload = self._read_json_body()
        tab_id = (payload.get("id") or str(uuid.uuid4())).strip()
        tab_type = (payload.get("tab_type") or "conversation").strip()
        conn = open_db(self.db_path)
        try:
            next_idx = conn.execute("SELECT COALESCE(MAX(sort_index), -1) + 1 FROM workspace_tabs WHERE closed = 0").fetchone()[0]
            conn.execute(
                "INSERT OR REPLACE INTO workspace_tabs(id, tab_type, conversation_id, artifact_id, title, pinned, sort_index, last_active_at, closed) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
                (
                    tab_id,
                    tab_type,
                    payload.get("conversation_id"),
                    payload.get("artifact_id"),
                    payload.get("title") or "",
                    1 if payload.get("pinned") else 0,
                    int(payload.get("sort_index", next_idx)),
                    float(payload.get("last_active_at", time.time())),
                ),
            )
            conn.commit()
            self.send_json({"ok": True, "id": tab_id})
        finally:
            conn.close()

    def _api_tab_update(self, tab_id):
        payload = self._read_json_body()
        if not tab_id:
            self.send_json({"error": "missing tab id"}, 400); return
        fields = []
        values = []
        for k in ("title", "conversation_id", "artifact_id", "sort_index", "tab_type"):
            if k in payload:
                fields.append(f"{k} = ?")
                values.append(payload[k])
        if "pinned" in payload:
            fields.append("pinned = ?")
            values.append(1 if payload.get("pinned") else 0)
        fields.append("last_active_at = ?")
        values.append(time.time())
        values.append(tab_id)
        conn = open_db(self.db_path)
        try:
            conn.execute(f"UPDATE workspace_tabs SET {', '.join(fields)} WHERE id = ?", tuple(values))
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_tab_remove(self, tab_id):
        conn = open_db(self.db_path)
        try:
            conn.execute("UPDATE workspace_tabs SET closed = 1 WHERE id = ?", (tab_id,))
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()

    def _api_conversation_update(self, conv_id):
        payload = self._read_json_body()
        if not conv_id:
            self.send_json({"error": "missing conversation id"}, 400); return
        rename = payload.get("title")
        archive = payload.get("archived")
        deleted = payload.get("deleted")
        conn = open_db(self.db_path)
        try:
            exists = conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            if not exists:
                self.send_json({"error": "conversation not found"}, 404); return
            conn.execute(
                "INSERT OR IGNORE INTO conversation_meta(conversation_id, custom_title, archived, deleted) VALUES (?, NULL, 0, 0)",
                (conv_id,),
            )
            if isinstance(rename, str):
                cleaned_title = rename.strip() or None
                conn.execute(
                    "UPDATE conversation_meta SET custom_title = ? WHERE conversation_id = ?",
                    (cleaned_title, conv_id),
                )
            if archive is not None:
                conn.execute(
                    "UPDATE conversation_meta SET archived = ? WHERE conversation_id = ?",
                    (1 if archive else 0, conv_id),
                )
                # Archiving a foldered chat removes it from its folder (a chat
                # cannot be both archived and in a folder).
                if archive:
                    conn.execute(
                        "DELETE FROM udb.folder_items WHERE conversation_id = ?",
                        (conv_id,),
                    )
            if deleted is not None:
                conn.execute(
                    "UPDATE conversation_meta SET deleted = ? WHERE conversation_id = ?",
                    (1 if deleted else 0, conv_id),
                )
            conn.commit()
            self.send_json({"ok": True})
        finally:
            conn.close()


def serve(port=8000, db_path=Path("history.db"), source_dir=Path("source")):
    _ensure_runtime_schema(db_path)
    _ensure_userdata_schema(db_path)
    _build_source_index(source_dir)
    Handler.db_path = db_path
    Handler.source_dir = source_dir
    # ThreadingHTTPServer: handle each request on its own thread so one slow or
    # idle connection (e.g. a browser preconnect socket, or an aborted fetch)
    # can never block every other request. This is the fix for the UI hanging
    # on "Loading…". daemon_threads lets the process exit cleanly on Ctrl-C.
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    serve()
