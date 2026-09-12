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
                closed          INTEGER DEFAULT 0,
                provider        TEXT,
                compare         INTEGER DEFAULT 0
            );
            -- Previously-deleted conversations held aside from an import for the
            -- user to review before re-importing (the "Review" import choice,
            -- and the "has new messages" case of the skip choice). Holds the
            -- full parsed record as JSON so it can be imported later without
            -- re-reading the (now renamed) backup file. Transient review state,
            -- so it lives in history.db rather than the persistent user DB.
            CREATE TABLE IF NOT EXISTS pending_reimport (
                conversation_id TEXT NOT NULL,
                provider        TEXT NOT NULL,
                chat_name       TEXT,
                first_message   REAL,
                last_message    REAL,
                total_messages  INTEGER,
                record_json     TEXT,
                reason          TEXT,
                created_at      REAL,
                PRIMARY KEY (conversation_id, provider)
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
            # Conversation identity is (id, provider). Databases built before this
            # column existed get it here and are backfilled below from the
            # dataset-wide format recorded at build time.
            "ALTER TABLE conversations ADD COLUMN provider TEXT",
            # Compare items carry their own provider for tab colouring.
            "ALTER TABLE workspace_tabs ADD COLUMN provider TEXT",
            # 1 only when the user explicitly added the chat to Compare.
            "ALTER TABLE workspace_tabs ADD COLUMN compare INTEGER DEFAULT 0",
        ):
            try:
                conn.execute(col_sql)
            except sqlite3.Error:
                pass
        # The top strip is now the Compare bar. Older versions created a tab row
        # every time a chat was opened; none of those were deliberate Compare
        # selections, so drop every non-compare row. Compare additions are
        # written with compare = 1, so this only ever removes the legacy rows
        # and, on a database with nothing selected, leaves the table empty (no
        # reserved space for the strip).
        try:
            conn.execute(
                "DELETE FROM workspace_tabs WHERE COALESCE(compare, 0) = 0"
            )
        except sqlite3.Error:
            pass
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations (import_status)"
            )
        except sqlite3.Error:
            pass
        # Backfill provider on legacy rows from the recorded dataset format.
        try:
            row = conn.execute(
                "SELECT pref_value FROM ui_preferences WHERE pref_key = 'dataset_format'"
            ).fetchone()
            fmt = "claude"
            if row and row[0]:
                try:
                    fmt = json.loads(row[0])
                except Exception:
                    fmt = row[0]
            if fmt not in ("claude", "chatgpt"):
                fmt = "claude"
            conn.execute(
                "UPDATE conversations SET provider = ? WHERE provider IS NULL OR provider = ''",
                (fmt,),
            )
        except sqlite3.Error:
            pass
        # Import-history table: one row per backup brought in via "Import New
        # Chats". Created at runtime so databases built before the feature gain
        # it without a rebuild.
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS imported_backups (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_name    TEXT,
                    provider     TEXT,
                    file_hash    TEXT,
                    first_chat   REAL,
                    last_chat    REAL,
                    total_chats  INTEGER,
                    imported_at  REAL,
                    added        INTEGER DEFAULT 0,
                    updated      INTEGER DEFAULT 0,
                    unchanged    INTEGER DEFAULT 0,
                    skipped      INTEGER DEFAULT 0,
                    errors       INTEGER DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_imported_backups_provider
                    ON imported_backups (provider);
                """
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
                updated_at REAL,
                -- Which side the folder belongs to: folders are scoped to a
                -- provider so the Claude and ChatGPT sidebars stay separate.
                provider   TEXT
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

            -- Free-form tags a user attaches to a conversation. Lives here (not
            -- in history.db's conversation_meta) so tags survive a rebuild —
            -- conversation IDs are stable across rebuilds, so membership holds.
            CREATE TABLE IF NOT EXISTS conversation_tags (
                conversation_id TEXT NOT NULL,
                tag             TEXT NOT NULL,
                added_at        REAL,
                PRIMARY KEY (conversation_id, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_conv_tags_tag ON conversation_tags (tag);

            -- A lightweight tombstone left behind when a conversation is
            -- permanently deleted from the Recycle Bin. It holds no message
            -- content — only enough identity/metadata for a later import to
            -- recognise the conversation was deliberately deleted and decide
            -- whether to re-import it. Lives here (not history.db) so it
            -- survives a rebuild; identity is (conversation_id, provider), the
            -- same rule the importer uses everywhere else.
            CREATE TABLE IF NOT EXISTS deleted_records (
                conversation_id TEXT NOT NULL,
                provider        TEXT NOT NULL,
                chat_name       TEXT,
                first_message   REAL,
                last_message    REAL,
                total_messages  INTEGER,
                deleted_at      REAL,
                PRIMARY KEY (conversation_id, provider)
            );

            -- User-configurable conversation labels. A label is a definition
            -- (name/colour/order) here; a conversation's assignment lives in
            -- conversation_labels below. Names carry no hard-coded meaning —
            -- the user chooses them — and the stable id means renaming or
            -- recolouring a label never disturbs which conversations use it.
            CREATE TABLE IF NOT EXISTS labels (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                color      TEXT,
                -- Position in the click-cycle / display order (0-based).
                sort_index INTEGER NOT NULL DEFAULT 0,
                created_at REAL,
                updated_at REAL
            );

            -- Which label a conversation has. A conversation has at most one
            -- label; the blank state is simply the absence of a row (no fake
            -- "Blank" label). Keyed on conversation_id alone, matching the
            -- existing tags/folders/model tables — conversation ids are stable
            -- across rebuilds, so assignments survive a history.db rebuild.
            CREATE TABLE IF NOT EXISTS conversation_labels (
                conversation_id TEXT PRIMARY KEY,
                label_id        TEXT NOT NULL,
                assigned_at     REAL
            );
            CREATE INDEX IF NOT EXISTS idx_conv_labels_label
                ON conversation_labels (label_id);

            -- A short, durable log of each successful conditional bulk-label
            -- operation. Not an undo journal — it holds no conversation bodies
            -- and no per-conversation before/after state, only enough to remind
            -- the user what they did and to let them reuse a prior selection.
            -- Recovery from a bad change is the job of snapshots, not this.
            CREATE TABLE IF NOT EXISTS label_bulk_history (
                id                TEXT PRIMARY KEY,
                created_at        REAL,
                -- The selection criteria, serialized, so it can be reloaded.
                criteria_json     TEXT,
                -- A human-readable summary captured at execution time.
                description       TEXT,
                -- The label applied; NULL means "cleared to blank".
                target_label_id   TEXT,
                -- The label's name at the time, kept even if it is later renamed
                -- or deleted so old history stays readable.
                target_label_name TEXT,
                limit_used        INTEGER,
                -- Sorting/order settings used to pick which matches the limit hit.
                order_json        TEXT,
                eligible_count    INTEGER,
                changed_count     INTEGER
            );

            -- Manual safety snapshots of user-owned metadata (never message
            -- content or imported source text). Capped at 10 rows; creation is
            -- blocked at the cap until the user deletes one (nothing is ever
            -- deleted silently). The payload is versioned JSON so new categories
            -- can be added later without invalidating old snapshots.
            CREATE TABLE IF NOT EXISTS snapshots (
                id             TEXT PRIMARY KEY,
                name           TEXT,
                created_at     REAL,
                schema_version INTEGER,
                payload        TEXT,
                -- Optional display metadata computed at capture time.
                item_count     INTEGER,
                payload_size   INTEGER
            );
            """
        )
        # Add the folders.provider column on databases created before folders
        # were scoped by provider. ADD COLUMN errors if it already exists.
        try:
            conn.execute("ALTER TABLE folders ADD COLUMN provider TEXT")
        except sqlite3.Error:
            pass
        conn.commit()
        _seed_claude_models(conn)
    finally:
        conn.close()


def _backfill_folder_providers(db_path: Path) -> None:
    """Give every pre-existing folder a provider. A folder that already holds a
    conversation inherits that conversation's provider; an empty one falls back
    to the dataset's own format. Runs once at startup, then no-ops."""
    conn = open_db(db_path)
    try:
        row = conn.execute(
            "SELECT pref_value FROM ui_preferences WHERE pref_key = 'dataset_format'"
        ).fetchone()
        fmt = "claude"
        if row and row[0]:
            try:
                fmt = json.loads(row[0])
            except Exception:
                fmt = row[0]
        if fmt not in ("claude", "chatgpt"):
            fmt = "claude"
        conn.execute(
            "UPDATE udb.folders SET provider = ("
            "  SELECT c.provider FROM udb.folder_items fi "
            "  JOIN conversations c ON c.id = fi.conversation_id "
            "  WHERE fi.folder_id = udb.folders.id AND c.provider IS NOT NULL "
            "  LIMIT 1"
            ") WHERE provider IS NULL OR provider = ''"
        )
        conn.execute(
            "UPDATE udb.folders SET provider = ? WHERE provider IS NULL OR provider = ''",
            (fmt,),
        )
        conn.commit()
    except sqlite3.Error:
        pass
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

# ── Import New Chats (scan / detect / merge / rename) ─────────────────────────

def _resolve_backup_name(source_dir: Path, this_path: Path, base: str, file_hash: str):
    """
    Pick the final filename for a backup and detect an exact duplicate.

    Returns (final_name, is_duplicate). Starts from `base.json`; if that name is
    taken by a *different* file it compares hashes: a match means the identical
    backup is already present (skip the import), a mismatch is a date collision
    so it tries -1, -2, … until a free name is found.
    """
    import hashlib
    n = 0
    while True:
        name = f"{base}.json" if n == 0 else f"{base}-{n}.json"
        p = source_dir / name
        if not p.exists():
            return name, False
        try:
            if p.samefile(this_path):
                return name, False  # this very file is already correctly named
        except OSError:
            pass
        try:
            other_hash = hashlib.sha256(p.read_bytes()).hexdigest()
        except OSError:
            other_hash = None
        if other_hash == file_hash:
            return name, True
        n += 1


def _record_dates(record: dict) -> tuple:
    """First-message date, last-message date and total-message count for one
    importer record — derived from its messages, falling back to the
    conversation's own create/update times when the messages carry none. Used
    to fill a review row and to compare an incoming backup against a stored
    permanent-deletion record."""
    meta = record.get("meta") or {}
    msgs = record.get("msgs") or []
    times = [m.get("create_time") for m in msgs if m.get("create_time")]
    first = min(times) if times else meta.get("create_time")
    last = max(times) if times else meta.get("update_time")
    total = len(msgs) if msgs else (meta.get("message_count") or 0)
    return first, last, total


def import_new_backups(conn, source_dir: Path,
                       deleted_mode: str = "skip",
                       review_new_messages: bool = False) -> dict:
    """
    Scan `source_dir` for conversation backups not yet imported, identify each
    by its contents, merge it into the database, and rename it to
    Provider-conversations-YYYY-MM-DD.json. Returns a summary the UI shows.

    `deleted_mode` controls what happens to conversations that were previously
    permanently deleted (they carry a record in udb.deleted_records):
      • "skip"   — don't re-import them. With `review_new_messages`, a backup
                   whose last message is newer than the deleted version is held
                   aside for review instead of being skipped silently.
      • "all"    — re-import them normally with the rest of the backup and clear
                   their deletion record.
      • "review" — import the rest of the backup now, but hold every previously
                   deleted conversation aside for the user to review.
    Held-aside conversations are stored in pending_reimport (with their full
    record) and surfaced in the import screen's review area.
    """
    if deleted_mode not in ("skip", "all", "review"):
        deleted_mode = "skip"
    import hashlib
    import build_db

    summary = {
        "added": 0, "updated": 0, "unchanged": 0, "skipped": 0, "errors": 0,
        # Conversations held aside for review this run (Review choice, or a
        # previously deleted chat with new messages under the skip choice).
        "review": 0,
        "files": [], "notes": [],
    }
    known_hashes = set()
    for row in conn.execute("SELECT file_hash FROM imported_backups"):
        if row[0]:
            known_hashes.add(row[0])

    # Permanent-deletion records, keyed by identity (id, provider) → last-message
    # date, so we can recognise a previously deleted conversation in a backup.
    deleted_map: dict = {}
    for row in conn.execute(
        "SELECT conversation_id, provider, last_message FROM udb.deleted_records"
    ):
        deleted_map[(row[0], row[1])] = row[2]

    # Only top-level *.json files are candidates. memories/users are export
    # siblings, never conversation backups.
    candidates = sorted(p for p in source_dir.glob("*.json") if p.is_file())
    for path in candidates:
        name = path.name
        if name in ("memories.json", "users.json"):
            continue
        try:
            raw = path.read_bytes()
        except OSError as e:
            summary["notes"].append(f"{name}: could not read ({e}) — skipped")
            continue
        file_hash = hashlib.sha256(raw).hexdigest()
        if file_hash in known_hashes:
            continue  # exact same file already imported

        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            summary["notes"].append(f"{name}: not valid JSON — skipped")
            continue

        provider = build_db.detect_provider(data)
        if provider is None:
            summary["notes"].append(
                f"{name}: not a recognized Claude or ChatGPT export — skipped"
            )
            continue

        records = build_db.dedup_records(build_db.parse_backup(data, provider))
        if not records:
            summary["notes"].append(f"{name}: no conversations found — skipped")
            continue
        first_ts, last_ts = build_db.backup_date_range(records)

        if name == "conversations.json":
            # The seed export keeps its canonical name: the documented
            # `rm -f history.db && python3 app.py` rebuild needs that exact path.
            # It is still hash-recorded below, so it imports at most once and is
            # skipped on every later scan. (Fresh builds record it up front and
            # never reach this loop; this covers databases built beforehand.)
            final_name, is_dup = name, False
        else:
            date_str = _ts_to_date(last_ts) or datetime.date.today().isoformat()
            label = "Claude" if provider == "claude" else "ChatGPT"
            base = f"{label}-conversations-{date_str}"
            final_name, is_dup = _resolve_backup_name(source_dir, path, base, file_hash)
        if is_dup:
            summary["notes"].append(
                f"{name}: identical to already-imported {final_name} — skipped"
            )
            known_hashes.add(file_hash)
            continue

        # Split the backup's records against the permanent-deletion records so
        # previously deleted conversations are handled per the chosen mode and
        # never silently resurrected.
        to_import = []          # reconciled normally this run
        reimported_keys = []    # previously deleted, being re-imported (mode all)
        held = []               # (record, reason) held aside for review
        skipped_deleted = 0     # previously deleted, skipped silently
        for rec in records:
            key = (rec["meta"]["id"], provider)
            if key not in deleted_map:
                to_import.append(rec)
                continue
            if deleted_mode == "all":
                to_import.append(rec)
                reimported_keys.append(key)
            elif deleted_mode == "review":
                held.append((rec, "review"))
            else:  # skip
                if review_new_messages:
                    _f, inc_last, _t = _record_dates(rec)
                    stored_last = deleted_map[key]
                    if (inc_last is not None and stored_last is not None
                            and float(inc_last) > float(stored_last) + 1.0):
                        held.append((rec, "new_messages"))
                    else:
                        skipped_deleted += 1
                else:
                    skipped_deleted += 1

        counts = build_db.reconcile_backup(conn, to_import, provider)
        for k in ("added", "updated", "unchanged", "skipped", "errors"):
            summary[k] += counts[k]
        counts["skipped"] += skipped_deleted
        summary["skipped"] += skipped_deleted

        # A successfully re-imported conversation is no longer deleted.
        for cid, prov in reimported_keys:
            conn.execute(
                "DELETE FROM udb.deleted_records "
                "WHERE conversation_id = ? AND provider = ?",
                (cid, prov),
            )
            deleted_map.pop((cid, prov), None)

        # Hold reviewed conversations aside with their full record for later.
        for rec, reason in held:
            first, last, total = _record_dates(rec)
            conn.execute(
                "INSERT OR REPLACE INTO pending_reimport "
                "(conversation_id, provider, chat_name, first_message, "
                " last_message, total_messages, record_json, reason, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (rec["meta"]["id"], provider, rec["meta"].get("title") or "Untitled",
                 first, last, total, json.dumps(rec, ensure_ascii=False),
                 reason, time.time()),
            )
        summary["review"] += len(held)
        counts["review"] = len(held)

        final_path = source_dir / final_name
        try:
            if final_path != path:
                path.rename(final_path)
        except OSError:
            final_name = name  # keep the original name if the rename fails

        conn.execute(
            "INSERT INTO imported_backups "
            "(file_name, provider, file_hash, first_chat, last_chat, "
            " total_chats, imported_at, added, updated, unchanged, skipped, errors) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (final_name, provider, file_hash, first_ts, last_ts,
             len(records), time.time(),
             counts["added"], counts["updated"], counts["unchanged"],
             counts["skipped"], counts["errors"]),
        )
        known_hashes.add(file_hash)
        summary["files"].append({
            "file_name": final_name, "provider": provider,
            "total_chats": len(records), **counts,
        })

    return summary


# ── Permanent deletion (Recycle Bin → gone) ─────────────────────────────────────


def _conv_tombstone_meta(conn, cid: str) -> dict | None:
    """Gather the lightweight metadata kept in a permanent-deletion record.

    First/last message dates come from the message rows; the conversation's own
    create/update times are the fallback when a message lacks a timestamp (or a
    metadata-only record has no messages at all). Holds no message content."""
    row = conn.execute(
        "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
        "c.provider, c.create_time, c.update_time, c.message_count "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.id = ?",
        (cid,),
    ).fetchone()
    if row is None:
        return None
    mrow = conn.execute(
        "SELECT MIN(create_time), MAX(create_time), COUNT(*) "
        "FROM messages WHERE conversation_id = ?",
        (cid,),
    ).fetchone()
    msg_first, msg_last, msg_count = (mrow or (None, None, 0))
    first_message = msg_first if msg_first else row["create_time"]
    last_message = msg_last if msg_last else row["update_time"]
    total_messages = msg_count if msg_count else (row["message_count"] or 0)
    return {
        "conversation_id": cid,
        "provider": row["provider"] or "",
        "chat_name": row["title"] or "Untitled",
        "first_message": first_message,
        "last_message": last_message,
        "total_messages": total_messages,
    }


def _purge_conversation(conn, cid: str) -> bool:
    """Permanently remove one conversation: write its deletion record, then drop
    every stored row that belongs to it (content and viewer metadata) from both
    the history and user-data databases. The caller owns the transaction so a
    batch stays all-or-nothing. Returns True when the conversation existed.

    Never touches the on-disk backup JSON, and never removes shared physical
    attachment/image files (ownership can't be safely established here)."""
    meta = _conv_tombstone_meta(conn, cid)
    if meta is None:
        return False
    conn.execute(
        "INSERT OR REPLACE INTO udb.deleted_records "
        "(conversation_id, provider, chat_name, first_message, last_message, "
        " total_messages, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (meta["conversation_id"], meta["provider"], meta["chat_name"],
         meta["first_message"], meta["last_message"], meta["total_messages"],
         time.time()),
    )
    # Conversation content and history-side derived rows.
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM search_index WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM artifacts WHERE conv_id = ?", (cid,))
    conn.execute("DELETE FROM conversation_meta WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM pinned_conversations WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM workspace_tabs WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))
    # User-data-side viewer metadata that now has no conversation to belong to.
    for stmt in (
        "DELETE FROM udb.folder_items WHERE conversation_id = ?",
        "DELETE FROM udb.conversation_tags WHERE conversation_id = ?",
        "DELETE FROM udb.conversation_models WHERE conversation_id = ?",
        "DELETE FROM udb.conversation_model_flags WHERE conversation_id = ?",
    ):
        try:
            conn.execute(stmt, (cid,))
        except sqlite3.Error:
            pass  # a table may be absent on a partial DB; never abort the purge
    return True


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
        elif path == "/api/claude-models/reload":
            self._api_claude_models_reload()
        elif path == "/api/conversation-models":
            self._api_conversation_model_add()
        elif path == "/api/conversation-models/dismiss":
            self._api_conversation_model_dismiss()
        elif path == "/api/tags":
            self._api_tag_add()
        elif path == "/api/labels":
            self._api_label_create()
        elif path == "/api/labels/reorder":
            self._api_labels_reorder()
        elif path == "/api/conversation-labels":
            self._api_conversation_label_set()
        elif path == "/api/import-new":
            self._api_import_new()
        elif path == "/api/recycle-bin/restore":
            self._api_recycle_restore()
        elif path == "/api/recycle-bin/purge":
            self._api_recycle_purge()
        elif path == "/api/import-new/review-import":
            self._api_review_import()
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
        elif path.startswith("/api/labels/"):
            self._api_label_update(urllib.parse.unquote(path[len("/api/labels/"):]))
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
        elif path.startswith("/api/tags/"):
            parts = [urllib.parse.unquote(p) for p
                     in path[len("/api/tags/"):].split("/") if p]
            if len(parts) != 2:
                self.send_error(404); return
            self._api_tag_remove(parts[0], parts[1])
        elif path.startswith("/api/labels/"):
            self._api_label_delete(urllib.parse.unquote(path[len("/api/labels/"):]))
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
        elif path == "/api/imported-backups":
            self._api_imported_backups(qs)
        elif path == "/api/import-new/review":
            self._api_review_list(qs)
        elif path == "/api/folders":
            self._api_folders_list(qs)
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
        elif path == "/api/tags":
            self._api_tags_all()
        elif path == "/api/labels":
            self._api_labels_list()
        elif path == "/api/preferences":
            self._api_preferences()
        elif path == "/api/pinned":
            self._api_pinned_list(qs)
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

    def _send_conv_list(self, conn, rows, total, offset, limit, provider=None):
        """Ship a conversation page, tagged with each row's warning icons.

        unverified_count drives the "Unverified Models" entry in the sidebar
        filter, which only exists while something is actually flagged. Model
        warnings are Claude-only, so they are computed only when the Claude side
        is being shown (or, for an older client that sends no provider, when the
        whole dataset is Claude).
        """
        convs = [dict(r) for r in rows]
        # Attach each row's label in one batched query so the sidebar can draw
        # its square without a request per conversation (no N+1).
        ids = [c["id"] for c in convs]
        if ids:
            marks = ",".join("?" * len(ids))
            labels_by_conv = {}
            for r in conn.execute(
                "SELECT cl.conversation_id AS cid, l.id AS id, l.name AS name, l.color AS color "
                "FROM udb.conversation_labels cl "
                "JOIN udb.labels l ON l.id = cl.label_id "
                f"WHERE cl.conversation_id IN ({marks})",
                tuple(ids),
            ).fetchall():
                labels_by_conv[r["cid"]] = {"id": r["id"], "name": r["name"], "color": r["color"]}
            for c in convs:
                c["label"] = labels_by_conv.get(c["id"])
        claude_side = (provider == "claude") if provider else (self._dataset_format(conn) == "claude")
        if claude_side:
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
        # Which side (Claude or ChatGPT) the sidebar toggle is showing. Validated
        # against a fixed whitelist so it is safe to interpolate as a literal.
        provider = ((qs.get("provider") or [""])[0]).strip().lower()
        if provider not in ("claude", "chatgpt"):
            provider = None
        prov_sql = f" AND c.provider = '{provider}'" if provider else ""
        # A "label:<id>" (or "label:__unlabeled__") view filters by conversation
        # label. It behaves like the "all" view for the deleted/archived/folder
        # gating, then adds the label constraint — so a labelled chat still shows
        # even when archived or inside a folder.
        label_filter = None
        if view.startswith("label:"):
            label_filter = view[len("label:"):]
            view = "labelview"
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
                    f"WHERE c.id IN ({marks}) AND COALESCE(cm.deleted, 0) = 0" + prov_sql + " "
                    "ORDER BY c.update_time DESC, c.create_time DESC LIMIT ? OFFSET ?",
                    (*flagged, limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM conversations c "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                    f"WHERE c.id IN ({marks}) AND COALESCE(cm.deleted, 0) = 0" + prov_sql,
                    tuple(flagged),
                ).fetchone()[0]
                self._send_conv_list(conn, rows, total, offset, limit, provider)
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
                    "AND c.id NOT IN (SELECT conversation_id FROM udb.folder_items)"
                    + prov_sql + " "
                    # Ordered newest-first like the other views so the list's
                    # month headers stay chronological. (The pinned view is now
                    # a filter, not the old drag-to-reorder top section.)
                    "ORDER BY c.update_time DESC, c.create_time DESC "
                    "LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM pinned_conversations p "
                    "JOIN conversations c ON c.id = p.conversation_id "
                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = p.conversation_id "
                    "WHERE COALESCE(cm.deleted, 0) = 0 "
                    "AND p.conversation_id NOT IN (SELECT conversation_id FROM udb.folder_items)"
                    + prov_sql
                ).fetchone()[0]
                self._send_conv_list(conn, rows, total, offset, limit, provider)
                return

            where_clauses = []
            if view == "deleted":
                where_clauses.append("COALESCE(cm.deleted, 0) = 1")
            else:
                where_clauses.append("COALESCE(cm.deleted, 0) = 0")

            if view == "archived":
                where_clauses.append("COALESCE(cm.archived, 0) = 1")
            elif view in ("all", "deleted", "labelview"):
                pass
            else:
                where_clauses.append("COALESCE(cm.archived, 0) = 0")

            if view == "recent":
                where_clauses.append(
                    "c.id NOT IN (SELECT conversation_id FROM pinned_conversations)"
                )
            # Foldered chats never appear in the main list — they live only in
            # their folder in the sidebar — EXCEPT in the Recycle Bin. A deleted
            # chat is hidden from its folder (the folder query filters
            # deleted = 0), so the Recycle Bin is the only place it can be seen
            # and restored; excluding it here would strand it. Its folder
            # membership is preserved so restoring returns it to that folder.
            # A label view searches across folders too, so a labelled chat that
            # lives in a folder still appears under its label filter.
            if view not in ("deleted", "labelview"):
                where_clauses.append(
                    "c.id NOT IN (SELECT conversation_id FROM udb.folder_items)"
                )
            # Restrict to the toggled side (Claude or ChatGPT). `provider` is
            # whitelisted above, so this literal is safe.
            if provider:
                where_clauses.append(f"c.provider = '{provider}'")
            # The label constraint. label_id is a uuid4 hex, validated before it
            # is interpolated (like `provider`); an unrecognised value yields no
            # rows rather than an error.
            if label_filter is not None:
                if label_filter == "__unlabeled__":
                    where_clauses.append(
                        "c.id NOT IN (SELECT conversation_id FROM udb.conversation_labels)"
                    )
                elif re.fullmatch(r"[0-9a-f]{32}", label_filter):
                    where_clauses.append(
                        "c.id IN (SELECT conversation_id FROM udb.conversation_labels "
                        f"WHERE label_id = '{label_filter}')"
                    )
                else:
                    where_clauses.append("0")
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
                            "  UNION "
                            "  SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?"
                            ") "
                            + order_sql + " "
                            "LIMIT ? OFFSET ?",
                            (q, like, like, limit, offset),
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
                            "  UNION "
                            "  SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?"
                            ")",
                            (q, like, like),
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
                            "WHERE " + where_sql + " AND (COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ? "
                            "OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?)) "
                            + order_sql + " LIMIT ? OFFSET ?",
                            (like, like, limit, offset),
                        ).fetchall()
                        total = conn.execute(
                            "SELECT COUNT(*) FROM conversations c "
                            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                            "WHERE " + where_sql + " AND (COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ? "
                            "OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?))",
                            (like, like)
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
                        "WHERE " + where_sql + " AND (COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ? "
                            "OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?)) "
                        + order_sql + " LIMIT ? OFFSET ?",
                        (like, like, limit, offset),
                    ).fetchall()
                    total = conn.execute(
                        "SELECT COUNT(*) FROM conversations c "
                        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                        "WHERE " + where_sql + " AND (COALESCE(NULLIF(cm.custom_title, ''), c.title) LIKE ? "
                        "OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?))",
                        (like, like)
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
            self._send_conv_list(conn, rows, total, offset, limit, provider)
        finally:
            conn.close()

    def _api_detail(self, conv_id):
        conn = open_db(self.db_path)
        try:
            conv = conn.execute(
                "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
                "c.create_time, c.update_time, c.message_count, c.preview, "
                "COALESCE(c.import_status, 'normal') AS import_status, "
                "c.provider AS provider, "
                "COALESCE(cm.deleted, 0) AS deleted, "
                # The conversation's own pin/folder state, so the thread menu is
                # correct even for a Compare item from the opposite provider
                # (whose state is absent from the sidebar-scoped lists).
                "CASE WHEN pc.conversation_id IS NULL THEN 0 ELSE 1 END AS pinned, "
                "fi.folder_id AS folder_id, "
                "COALESCE(fi.pinned, 0) AS folder_pinned "
                "FROM conversations c "
                "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "LEFT JOIN pinned_conversations pc ON pc.conversation_id = c.id "
                "LEFT JOIN udb.folder_items fi ON fi.conversation_id = c.id "
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
            conv_dict = dict(conv)
            # The current label rides along so opening a conversation stays one
            # request; the header square reads it directly.
            conv_dict["label"] = self._conv_label(conn, conv_id)
            self.send_json({"conversation": conv_dict,
                            "messages": [parse_msg(m) for m in msgs],
                            "artifacts": artifacts_meta,
                            "models": models,
                            "tags": self._conv_tags(conn, conv_id)})
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
            # And tag matches
            for r in conn.execute(
                "SELECT DISTINCT conversation_id FROM udb.conversation_tags WHERE tag LIKE ? LIMIT 15",
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
                by_source = False
                if conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_sources'"
                ).fetchone():
                    # message_count arrived with the per-source metadata; an
                    # import_sources built before it can't answer these queries.
                    cols = {r[1] for r in conn.execute("PRAGMA table_info(import_sources)")}
                    by_source = "message_count" in cols and bool(
                        conn.execute("SELECT 1 FROM import_sources LIMIT 1").fetchone()
                    )

                if status:
                    if status not in valid:
                        self.send_json({"error": "unknown status"}, 400); return
                    if by_source:
                        # Every column comes from the source object itself. A
                        # collapsed duplicate reporting the winning record's
                        # message count and dates would contradict the very
                        # thing this view exists to show. Only a user's rename
                        # is borrowed, and only for the record actually stored.
                        rows = conn.execute(
                            "SELECT s.conversation_id AS id, "
                            "CASE WHEN s.kept = 1 "
                            "     THEN COALESCE(NULLIF(cm.custom_title, ''), s.title) "
                            "     ELSE s.title END AS title, "
                            "s.create_time, s.update_time, "
                            "COALESCE(s.message_count, 0) AS message_count, s.preview, "
                            "s.import_status, s.source_index, s.kept "
                            "FROM import_sources s "
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

    # ── Import New Chats ─────────────────────────────────────────────────────────
    # Scans the source folder for backup files not yet imported, identifies each
    # as a Claude or ChatGPT export by its contents, merges it into the database,
    # and renames the source file to Provider-conversations-YYYY-MM-DD.json.

    def _api_imported_backups(self, qs):
        """The import-history table. Provider filtering and sorting happen on the
        client; this returns every recorded backup, newest import first."""
        provider = ((qs.get("provider") or ["all"])[0]).strip().lower()
        conn = open_db(self.db_path)
        try:
            if provider in ("claude", "chatgpt"):
                rows = conn.execute(
                    "SELECT file_name, provider, first_chat, last_chat, total_chats, "
                    "imported_at, added, updated, unchanged, skipped, errors "
                    "FROM imported_backups WHERE provider = ? "
                    "ORDER BY imported_at DESC, id DESC",
                    (provider,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT file_name, provider, first_chat, last_chat, total_chats, "
                    "imported_at, added, updated, unchanged, skipped, errors "
                    "FROM imported_backups ORDER BY imported_at DESC, id DESC"
                ).fetchall()
            self.send_json({"backups": [dict(r) for r in rows]})
        finally:
            conn.close()

    def _api_import_new(self):
        source_dir = Path(self.source_dir)
        if not source_dir.exists():
            self.send_json({"error": "source folder not found"}, 400); return
        payload = self._read_json_body()
        deleted_mode = str(payload.get("deleted_mode") or "skip").strip().lower()
        if deleted_mode not in ("skip", "all", "review"):
            deleted_mode = "skip"
        review_new_messages = bool(payload.get("review_new_messages"))
        conn = open_db(self.db_path)
        try:
            summary = import_new_backups(
                conn, source_dir,
                deleted_mode=deleted_mode,
                review_new_messages=review_new_messages,
            )
            conn.commit()
        finally:
            conn.close()
        # Newly-renamed files change the on-disk set; refresh the attachment
        # source index so any new attachments resolve without a restart.
        try:
            _build_source_index(self.source_dir)
        except Exception:
            pass
        self.send_json(summary)

    # ── Folders ────────────────────────────────────────────────────────────────

    def _api_folders_list(self, qs=None):
        """Return the folders and the conversations they hold (for the sidebar),
        scoped to the toggled side when a provider is given."""
        qs = qs or {}
        provider = ((qs.get("provider") or [""])[0]).strip().lower()
        if provider not in ("claude", "chatgpt"):
            provider = None
        prov_folder = f" WHERE provider = '{provider}'" if provider else ""
        prov_item = f" AND c.provider = '{provider}'" if provider else ""
        conn = open_db(self.db_path)
        try:
            folders = conn.execute(
                "SELECT id, name, created_at, updated_at FROM udb.folders"
                + prov_folder + " "
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
                "WHERE COALESCE(cm.deleted, 0) = 0" + prov_item + " "
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
        # The folder belongs to the side it was created on.
        provider = (payload.get("provider") or "").strip().lower()
        if provider not in ("claude", "chatgpt"):
            provider = "claude"
        fid = uuid.uuid4().hex
        conn = open_db(self.db_path)
        try:
            conn.execute(
                "INSERT INTO udb.folders (id, name, created_at, updated_at, provider) "
                "VALUES (?, ?, ?, NULL, ?)",
                (fid, name, time.time(), provider),
            )
            conn.commit()
            self.send_json({"ok": True, "id": fid, "name": name, "provider": provider})
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
            folder = conn.execute(
                "SELECT provider FROM udb.folders WHERE id = ?", (fid,)
            ).fetchone()
            if not folder:
                self.send_json({"error": "folder not found"}, 404); return
            # Folders are provider-scoped and folder membership is filtered by
            # provider in both sidebars, so a chat placed in the other provider's
            # folder would vanish from every list. Reject the mismatch outright
            # (a Compare item from the opposite side can reach this path).
            convrow = conn.execute(
                "SELECT provider FROM conversations WHERE id = ?", (cid,)
            ).fetchone()
            if convrow is None:
                self.send_json({"error": "conversation not found"}, 404); return
            folder_provider = folder["provider"]
            conv_provider = convrow["provider"]
            if folder_provider and conv_provider and folder_provider != conv_provider:
                self.send_json(
                    {"error": "folder belongs to a different provider"}, 409
                ); return
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

    def _reload_claude_models_from_seed(self, conn) -> dict:
        """Re-import claude_models.json's periods into the user-data DB.

        Unlike the one-time startup seed (_seed_claude_models), this runs on
        demand — the "Reload Model Data" button — to pick up corrections to
        the shipped file, such as periods that were missing an end date on
        an earlier import. For a model whose name matches an entry in the
        file, its existing periods are dropped and replaced with exactly
        what the file lists; a model the user added by hand, with no entry
        in the file, is left untouched.
        """
        try:
            with open(MODEL_SEED_FILE, encoding="utf-8") as f:
                rows = json.load(f).get("models") or []
        except Exception as e:
            return {"error": f"Could not read {MODEL_SEED_FILE.name}: {e}"}

        now = time.time()
        touched: set[str] = set()
        added = 0
        for entry in rows:
            name = str(entry.get("name") or "").strip()
            start = str(entry.get("start_date") or "").strip()
            if not name or not start:
                continue
            end = entry.get("end_date")
            end = str(end).strip() if end else None
            row = conn.execute(
                "SELECT id FROM udb.claude_models WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()
            if row:
                model_id = row["id"]
            else:
                model_id = uuid.uuid4().hex
                conn.execute(
                    "INSERT INTO udb.claude_models(id, name, created_at) VALUES (?, ?, ?)",
                    (model_id, name, now),
                )
                added += 1
            if model_id not in touched:
                # First entry seen for this model in this reload: clear its
                # old periods so a stale/broken one (e.g. a prior import
                # that lost its end date) doesn't linger next to the fix.
                conn.execute(
                    "DELETE FROM udb.claude_model_periods WHERE model_id = ?", (model_id,),
                )
                touched.add(model_id)
            conn.execute(
                "INSERT INTO udb.claude_model_periods(id, model_id, start_date, end_date, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, model_id, start, end, now),
            )
        conn.commit()
        return {"ok": True, "models_touched": len(touched), "models_added": added}

    def _api_claude_models_reload(self):
        conn = open_db(self.db_path)
        try:
            result = self._reload_claude_models_from_seed(conn)
            if result.get("error"):
                self.send_json(result, 400); return
            self.send_json({**result, "models": self._model_rows(conn),
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

    # ── Conversation tags ────────────────────────────────────────────────────
    # Free-form tags, stored in the persistent user-data DB (see
    # conversation_tags in _ensure_userdata_schema) so they survive a
    # history.db rebuild the way folders and model choices do.

    def _conv_tags(self, conn, conv_id):
        rows = conn.execute(
            "SELECT tag FROM udb.conversation_tags WHERE conversation_id = ? "
            "ORDER BY added_at", (conv_id,),
        ).fetchall()
        return [r["tag"] for r in rows]

    def _api_tags_all(self):
        """Every distinct tag in use, for the add-tag autocomplete."""
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT DISTINCT tag FROM udb.conversation_tags ORDER BY tag COLLATE NOCASE"
            ).fetchall()
            self.send_json({"tags": [r["tag"] for r in rows]})
        finally:
            conn.close()

    def _api_tag_add(self):
        payload = self._read_json_body()
        conv_id = str(payload.get("conv_id") or "").strip()
        # Collapse internal whitespace along with trimming the ends, so
        # "  UI   Test " and "UI Test" land as the same tag.
        tag = " ".join(str(payload.get("tag") or "").split())[:40]
        if not conv_id or not tag:
            self.send_json({"error": "conv_id and tag are required"}, 400); return
        conn = open_db(self.db_path)
        try:
            if not conn.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (conv_id,)
            ).fetchone():
                self.send_json({"error": "Unknown conversation"}, 404); return
            conn.execute(
                "INSERT OR IGNORE INTO udb.conversation_tags(conversation_id, tag, added_at) "
                "VALUES (?, ?, ?)", (conv_id, tag, time.time()),
            )
            conn.commit()
            self.send_json({"tags": self._conv_tags(conn, conv_id)})
        finally:
            conn.close()

    def _api_tag_remove(self, conv_id, tag):
        conn = open_db(self.db_path)
        try:
            conn.execute(
                "DELETE FROM udb.conversation_tags WHERE conversation_id = ? AND tag = ?",
                (conv_id, tag),
            )
            conn.commit()
            self.send_json({"tags": self._conv_tags(conn, conv_id)})
        finally:
            conn.close()

    # ── Conversation labels ──────────────────────────────────────────────────
    # User-configurable labels stored in the persistent user-data DB (see
    # `labels` / `conversation_labels` in _ensure_userdata_schema). A label is a
    # definition here; a conversation has at most one, and the blank state is
    # the absence of an assignment. Names have no built-in meaning — the user
    # picks them — and stable ids mean a rename or recolour never moves any
    # conversation off its label.

    # Colours are stored as #rgb / #rrggbb and validated before write, so the
    # value can be dropped straight into an inline style on the client.
    _LABEL_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

    def _norm_label_color(self, value, default="#888888"):
        s = str(value or "").strip()
        return s if self._LABEL_COLOR_RE.match(s) else default

    def _labels_with_counts(self, conn):
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

    def _api_labels_list(self):
        conn = open_db(self.db_path)
        try:
            self.send_json({"labels": self._labels_with_counts(conn)})
        finally:
            conn.close()

    def _api_label_create(self):
        payload = self._read_json_body()
        name = " ".join(str(payload.get("name") or "").split())[:60]
        if not name:
            self.send_json({"error": "name is required"}, 400); return
        color = self._norm_label_color(payload.get("color"))
        now = time.time()
        conn = open_db(self.db_path)
        try:
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
            self.send_json({"labels": self._labels_with_counts(conn), "id": lid})
        finally:
            conn.close()

    def _api_label_update(self, lid):
        lid = (lid or "").strip()
        payload = self._read_json_body()
        sets, params = [], []
        if "name" in payload:
            name = " ".join(str(payload.get("name") or "").split())[:60]
            if not name:
                self.send_json({"error": "name cannot be empty"}, 400); return
            sets.append("name = ?"); params.append(name)
        if "color" in payload:
            sets.append("color = ?"); params.append(self._norm_label_color(payload.get("color")))
        if not sets:
            self.send_json({"error": "nothing to update"}, 400); return
        conn = open_db(self.db_path)
        try:
            if not conn.execute("SELECT 1 FROM udb.labels WHERE id = ?", (lid,)).fetchone():
                self.send_json({"error": "Unknown label"}, 404); return
            sets.append("updated_at = ?"); params.append(time.time())
            params.append(lid)
            conn.execute(f"UPDATE udb.labels SET {', '.join(sets)} WHERE id = ?", params)
            conn.commit()
            self.send_json({"labels": self._labels_with_counts(conn)})
        finally:
            conn.close()

    def _api_label_delete(self, lid):
        """Delete a label. Any conversation carrying it falls back to blank
        (its assignment row is removed) — never silently reassigned to another
        label."""
        lid = (lid or "").strip()
        conn = open_db(self.db_path)
        try:
            if not conn.execute("SELECT 1 FROM udb.labels WHERE id = ?", (lid,)).fetchone():
                self.send_json({"error": "Unknown label"}, 404); return
            cur = conn.execute(
                "DELETE FROM udb.conversation_labels WHERE label_id = ?", (lid,)
            )
            cleared = cur.rowcount if cur.rowcount is not None else 0
            conn.execute("DELETE FROM udb.labels WHERE id = ?", (lid,))
            conn.commit()
            self.send_json({"labels": self._labels_with_counts(conn), "cleared": cleared})
        finally:
            conn.close()

    def _api_labels_reorder(self):
        """Set the cycle order from a full list of label ids. Ids not present
        keep their existing order after the ones given."""
        payload = self._read_json_body()
        order = payload.get("order")
        if not isinstance(order, list):
            self.send_json({"error": "order must be a list of label ids"}, 400); return
        now = time.time()
        conn = open_db(self.db_path)
        try:
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
            self.send_json({"labels": self._labels_with_counts(conn)})
        finally:
            conn.close()

    def _conv_label(self, conn, conv_id):
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

    def _api_conversation_label_set(self):
        """Set (or clear) a conversation's single label. A falsy label_id
        clears it back to blank — the assignment row is removed, never swapped
        for a placeholder label."""
        payload = self._read_json_body()
        conv_id = str(payload.get("conv_id") or "").strip()
        raw = payload.get("label_id")
        label_id = str(raw).strip() if raw else ""
        if not conv_id:
            self.send_json({"error": "conv_id is required"}, 400); return
        conn = open_db(self.db_path)
        try:
            if not conn.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (conv_id,)
            ).fetchone():
                self.send_json({"error": "Unknown conversation"}, 404); return
            if label_id:
                if not conn.execute(
                    "SELECT 1 FROM udb.labels WHERE id = ?", (label_id,)
                ).fetchone():
                    self.send_json({"error": "Unknown label"}, 404); return
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
            self.send_json({"conv_id": conv_id, "label": self._conv_label(conn, conv_id)})
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

    def _api_pinned_list(self, qs=None):
        # Scope the loose Pinned list to the toggled side so a Claude pin does not
        # linger in the ChatGPT sidebar (and vice versa). `provider` is validated
        # against a fixed whitelist, so it is safe to interpolate as a literal.
        qs = qs or {}
        provider = ((qs.get("provider") or [""])[0]).strip().lower()
        if provider not in ("claude", "chatgpt"):
            provider = None
        prov_sql = f" AND c.provider = '{provider}'" if provider else ""
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT p.conversation_id, p.pinned_at, p.order_index, "
                "COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, c.update_time, c.message_count, c.preview "
                "FROM pinned_conversations p "
                "JOIN conversations c ON c.id = p.conversation_id "
                "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "WHERE COALESCE(cm.deleted, 0) = 0" + prov_sql + " "
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
                # No pinned DESC: the tab strip has no pin control any more, so
                # honouring the flag would strand a database written by an
                # older version with some tabs permanently jumping the queue
                # and no way to release them.
                "SELECT id, tab_type, conversation_id, artifact_id, title, pinned, sort_index, last_active_at, provider "
                "FROM workspace_tabs WHERE closed = 0 AND compare = 1 "
                "ORDER BY sort_index ASC, last_active_at DESC"
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
            provider = (payload.get("provider") or "").strip().lower()
            if provider not in ("claude", "chatgpt"):
                provider = None
            conn.execute(
                "INSERT OR REPLACE INTO workspace_tabs(id, tab_type, conversation_id, artifact_id, title, pinned, sort_index, last_active_at, closed, provider, compare) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)",
                (
                    tab_id,
                    tab_type,
                    payload.get("conversation_id"),
                    payload.get("artifact_id"),
                    payload.get("title") or "",
                    1 if payload.get("pinned") else 0,
                    int(payload.get("sort_index", next_idx)),
                    float(payload.get("last_active_at", time.time())),
                    provider,
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

    # ── Recycle Bin ─────────────────────────────────────────────────────────────

    def _recycle_target_ids(self, conn, payload):
        """Resolve which deleted conversations a bulk action applies to.

        `all` selects every conversation currently in the Recycle Bin, scoped to
        the given provider side so it matches the count the user sees; otherwise
        the explicit `ids` list is used (filtered to actually-deleted rows)."""
        provider = (payload.get("provider") or "").strip().lower()
        if provider not in ("claude", "chatgpt"):
            provider = None
        prov_sql = " AND c.provider = ?" if provider else ""
        prov_args = (provider,) if provider else ()
        if payload.get("all"):
            rows = conn.execute(
                "SELECT c.id FROM conversations c "
                "JOIN conversation_meta cm ON cm.conversation_id = c.id "
                "WHERE COALESCE(cm.deleted, 0) = 1" + prov_sql,
                prov_args,
            ).fetchall()
            return [r[0] for r in rows]
        ids = payload.get("ids") or []
        ids = [str(i) for i in ids if i]
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            "SELECT c.id FROM conversations c "
            "JOIN conversation_meta cm ON cm.conversation_id = c.id "
            f"WHERE COALESCE(cm.deleted, 0) = 1 AND c.id IN ({marks})" + prov_sql,
            (*ids, *prov_args),
        ).fetchall()
        return [r[0] for r in rows]

    def _api_recycle_restore(self):
        """Restore conversations out of the Recycle Bin: clear the deleted flag
        while leaving every other bit of metadata (folder, pins, tags, models)
        intact, so each returns to exactly the state it had before deletion."""
        payload = self._read_json_body()
        conn = open_db(self.db_path)
        try:
            ids = self._recycle_target_ids(conn, payload)
            if not ids:
                self.send_json({"ok": True, "restored": 0}); return
            marks = ",".join("?" * len(ids))
            # Single statement → the whole selection restores or none does.
            conn.execute(
                f"UPDATE conversation_meta SET deleted = 0 "
                f"WHERE conversation_id IN ({marks})",
                tuple(ids),
            )
            conn.commit()
            self.send_json({"ok": True, "restored": len(ids)})
        except sqlite3.Error as e:
            conn.rollback()
            self.send_json({"error": f"restore failed: {e}"}, 500)
        finally:
            conn.close()

    def _api_recycle_purge(self):
        """Permanently delete conversations from the Recycle Bin. Runs the whole
        batch inside one transaction so a mid-way failure leaves nothing
        half-deleted — either every selected conversation is gone (with a
        deletion record written for each) or the database is untouched."""
        payload = self._read_json_body()
        conn = open_db(self.db_path)
        try:
            ids = self._recycle_target_ids(conn, payload)
            if not ids:
                self.send_json({"ok": True, "purged": 0}); return
            purged = 0
            for cid in ids:
                if _purge_conversation(conn, cid):
                    purged += 1
            conn.commit()
            self.send_json({"ok": True, "purged": purged})
        except sqlite3.Error as e:
            conn.rollback()
            self.send_json({"error": f"permanent delete failed: {e}"}, 500)
        finally:
            conn.close()

    # ── Re-import review ─────────────────────────────────────────────────────────

    def _api_review_list(self, qs=None):
        """Conversations held aside from an import for the user to review before
        re-importing (the Review choice, and the has-new-messages skip case)."""
        conn = open_db(self.db_path)
        try:
            rows = conn.execute(
                "SELECT conversation_id, provider, chat_name, first_message, "
                "last_message, total_messages, reason, created_at "
                "FROM pending_reimport ORDER BY created_at DESC, chat_name ASC"
            ).fetchall()
            self.send_json({"review": [dict(r) for r in rows]})
        except sqlite3.Error:
            self.send_json({"review": []})
        finally:
            conn.close()

    def _api_review_import(self):
        """Resolve reviewed conversations. `import_ids` are re-imported from the
        record stored at import time (reusing the canonical import logic, so no
        duplicate is created and the identity is unchanged) and their deletion
        record is cleared; `dismiss_ids` are simply dropped from the review list
        and stay permanently deleted. All applied in one transaction."""
        import build_db
        payload = self._read_json_body()

        def _norm(items):
            out = []
            for it in (items or []):
                if isinstance(it, dict):
                    cid = str(it.get("id") or it.get("conversation_id") or "")
                    prov = str(it.get("provider") or "")
                else:
                    cid, prov = str(it), ""
                if cid:
                    out.append((cid, prov))
            return out

        conn = open_db(self.db_path)
        try:
            if payload.get("import_all"):
                import_ids = [(r[0], r[1]) for r in conn.execute(
                    "SELECT conversation_id, provider FROM pending_reimport"
                ).fetchall()]
            else:
                import_ids = _norm(payload.get("import_ids"))
            if payload.get("dismiss_all"):
                dismiss_ids = [(r[0], r[1]) for r in conn.execute(
                    "SELECT conversation_id, provider FROM pending_reimport"
                ).fetchall()]
            else:
                dismiss_ids = _norm(payload.get("dismiss_ids"))

            imported = 0
            for cid, prov in import_ids:
                row = conn.execute(
                    "SELECT provider, record_json FROM pending_reimport "
                    "WHERE conversation_id = ? AND (provider = ? OR ? = '')",
                    (cid, prov, prov),
                ).fetchone()
                if row is None:
                    continue
                provider = row["provider"]
                try:
                    record = json.loads(row["record_json"])
                except Exception:
                    record = None
                if record:
                    # Reuse the canonical reconcile path → same identity, no dup.
                    build_db.reconcile_backup(conn, [record], provider)
                # No longer deleted once re-imported.
                conn.execute(
                    "DELETE FROM udb.deleted_records "
                    "WHERE conversation_id = ? AND provider = ?",
                    (cid, provider),
                )
                conn.execute(
                    "DELETE FROM pending_reimport "
                    "WHERE conversation_id = ? AND provider = ?",
                    (cid, provider),
                )
                imported += 1

            dismissed = 0
            for cid, prov in dismiss_ids:
                cur = conn.execute(
                    "DELETE FROM pending_reimport "
                    "WHERE conversation_id = ? AND (provider = ? OR ? = '')",
                    (cid, prov, prov),
                )
                dismissed += cur.rowcount or 0

            conn.commit()
            self.send_json({"ok": True, "imported": imported, "dismissed": dismissed})
        except sqlite3.Error as e:
            conn.rollback()
            self.send_json({"error": f"review import failed: {e}"}, 500)
        finally:
            conn.close()


def serve(port=8000, db_path=Path("history.db"), source_dir=Path("source")):
    _ensure_runtime_schema(db_path)
    _ensure_userdata_schema(db_path)
    _backfill_folder_providers(db_path)
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
