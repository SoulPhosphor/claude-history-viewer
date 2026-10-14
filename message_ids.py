"""Stable message ids.

A message's `seq` is its position in the chat's shown branch. It can move when
a backup is re-imported and an earlier message was edited or regenerated (the
chat switches branches), and would move if messages could ever be edited or
deleted in the app. Each export also gives every message its own id (Claude
`uuid`, ChatGPT node `id`), which never moves; build_db stores it in
`messages.message_uuid`.

The id is the identity. Message links and bookmarks find their message by
id, and when that id is gone the message is gone: they never fall back to
whatever now sits at the old position. The position is used only for a
conversation that has no ids at all (an export without them, or an older
database whose backups are no longer in source/).

A message id is only ever looked up together with its conversation id, so
ids from different providers can never be confused with one another.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path


# Part of the "files already checked" marker: bump it whenever the way ids are
# read from a backup changes, so older databases get one fresh pass.
BACKFILL_VERSION = 1


def message_seq(conn, conversation_id: str, message_uuid: str):
    """The current seq of a message, or None when it is gone."""
    if not message_uuid:
        return None
    row = conn.execute(
        "SELECT seq FROM messages WHERE conversation_id = ? AND message_uuid = ? LIMIT 1",
        (conversation_id, message_uuid),
    ).fetchone()
    return row[0] if row else None


def conversation_has_ids(conn, conversation_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM messages WHERE conversation_id = ? AND message_uuid IS NOT NULL LIMIT 1",
        (conversation_id,),
    ).fetchone() is not None


def locate(conn, conversation_id: str, message_uuid, seq):
    """The current seq of a linked or bookmarked message, or None when it is
    gone. By id whenever the conversation has ids; by position otherwise."""
    if message_uuid and str(message_uuid).startswith(GONE_PREFIX):
        return None
    if message_uuid and conversation_has_ids(conn, conversation_id):
        return message_seq(conn, conversation_id, message_uuid)
    # No id to go by (an older link, or a chat without ids): its position.
    if seq is None:
        return None
    row = conn.execute(
        "SELECT 1 FROM messages WHERE conversation_id = ? AND seq = ? LIMIT 1",
        (conversation_id, seq),
    ).fetchone()
    return seq if row else None


def message_uuid_at(conn, conversation_id: str, seq):
    """The message id at a seq, or None (no message, or no id recorded)."""
    row = conn.execute(
        "SELECT message_uuid FROM messages WHERE conversation_id = ? AND seq = ? LIMIT 1",
        (conversation_id, seq),
    ).fetchone()
    return row[0] if row and row[0] else None


def message_fingerprint(role, content):
    """A short fingerprint of a message's role and exact text, kept on its
    bookmark so the bookmark can recognise its message after a rebuild, even
    when that message has no id."""
    if role is None or content is None:
        return None
    return hashlib.sha1(f"{role}\n{content}".encode("utf-8")).hexdigest()


def _message_at(conn, conversation_id: str, seq):
    return conn.execute(
        "SELECT role, content, message_uuid FROM messages WHERE conversation_id = ? AND seq = ? LIMIT 1",
        (conversation_id, seq),
    ).fetchone()


def _nearest_with_fingerprint(conn, conversation_id: str, fingerprint: str, seq, claimed=frozenset()):
    """The matching message nearest `seq` that no other bookmark has claimed,
    so bookmarks on identical messages each get one of their own."""
    best = None
    for row_seq, role, content, row_uuid in conn.execute(
        "SELECT seq, role, content, message_uuid FROM messages WHERE conversation_id = ?",
        (conversation_id,),
    ):
        if row_seq in claimed:
            continue
        if message_fingerprint(role, content) == fingerprint:
            if best is None or abs(row_seq - seq) < abs(best[0] - seq):
                best = (row_seq, row_uuid)
    return best


def _mark_gone(conn, bookmark_id: str) -> None:
    conn.execute(
        "UPDATE udb.conversation_bookmarks SET message_uuid = ? WHERE id = ?",
        (GONE_PREFIX + bookmark_id, bookmark_id),
    )


def _history_built_at(conn):
    """When history.db was built, or None for one built before this was kept
    (bookmarks older than such a database were made against it)."""
    try:
        row = conn.execute("SELECT built_at FROM history_build WHERE id = 1").fetchone()
    except sqlite3.Error:
        return None
    return float(row[0]) if row and row[0] is not None else None


def bookmark_fingerprint_at(conn, conversation_id: str, seq):
    row = _message_at(conn, conversation_id, seq)
    return message_fingerprint(row[0], row[1]) if row else None


def reanchor_bookmarks(conn, conversation_id: str) -> None:
    """Point each bookmark of a conversation at its message's current seq.

    A bookmark that knows its message id follows that message. One without an
    id is checked against the fingerprint of its message: it stays if the
    message at its position still matches, or moves to the nearest matching
    message no other bookmark holds (each gets its own), or is marked gone.
    Only a bookmark with neither (made before this version and never seen
    since) takes the message at its position, and it records that message's
    id and fingerprint at once. A bookmark whose message is gone is kept but
    never placed on another message."""
    rows = conn.execute(
        "SELECT id, seq, message_uuid, message_hash, created_at FROM udb.conversation_bookmarks "
        "WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchall()
    built_at = _history_built_at(conn)
    changed = False
    claimed: set = set()
    moving = []

    def apply(sql, params, bookmark_id):
        nonlocal changed
        try:
            conn.execute(sql, params)
        except sqlite3.IntegrityError:
            # Another bookmark already holds that message: this one is gone
            # rather than left on a position that may hold another message.
            _mark_gone(conn, bookmark_id)
        changed = True

    # First pass: bookmarks that know where they are claim their message.
    for bookmark_id, seq, message_uuid, fingerprint, created_at in rows:
        if message_uuid:
            current = message_seq(conn, conversation_id, message_uuid)
            if current is None:
                continue
            claimed.add(current)
            if current != seq or not fingerprint:
                apply(
                    "UPDATE udb.conversation_bookmarks SET seq = ?, "
                    "message_hash = COALESCE(message_hash, ?) WHERE id = ?",
                    (current, bookmark_fingerprint_at(conn, conversation_id, current), bookmark_id),
                    bookmark_id,
                )
            continue
        here = _message_at(conn, conversation_id, seq)
        if fingerprint:
            if here and message_fingerprint(here[0], here[1]) == fingerprint:
                claimed.add(seq)
                if here[2]:
                    apply(
                        "UPDATE udb.conversation_bookmarks SET message_uuid = ? WHERE id = ?",
                        (here[2], bookmark_id),
                        bookmark_id,
                    )
            else:
                moving.append((bookmark_id, seq, fingerprint))
        elif built_at is not None and float(created_at or 0) < built_at:
            # Made against an earlier database (rebuilt before this version
            # could record its message): its position proves nothing here.
            _mark_gone(conn, bookmark_id)
            changed = True
        elif here:
            claimed.add(seq)
            apply(
                "UPDATE udb.conversation_bookmarks SET message_uuid = ?, message_hash = ? WHERE id = ?",
                (here[2], message_fingerprint(here[0], here[1]), bookmark_id),
                bookmark_id,
            )
    # Second pass: the rest each take the nearest unclaimed matching message.
    for bookmark_id, seq, fingerprint in moving:
        target = _nearest_with_fingerprint(conn, conversation_id, fingerprint, seq, claimed)
        if target is None:
            _mark_gone(conn, bookmark_id)
            changed = True
            continue
        claimed.add(target[0])
        apply(
            "UPDATE udb.conversation_bookmarks SET seq = ?, message_uuid = ? WHERE id = ?",
            (target[0], target[1], bookmark_id),
            bookmark_id,
        )
    if changed:
        conn.commit()


def bookmark_missing(conn, conversation_id: str, bookmark) -> bool:
    """True when a bookmark's message is no longer in the conversation."""
    return locate(conn, conversation_id, bookmark["message_uuid"], bookmark["seq"]) is None


def fill_missing_from_sources(db_path: Path, source_dir: Path) -> int:
    """Give messages imported before ids were kept their export ids.

    Reads the backups in `source_dir` and matches each message on conversation,
    provider, position, role and exact text, so a message whose text differs
    from the backup is left without an id rather than given the wrong one.
    Returns how many messages gained an id. Safe to run again at any time."""
    import build_db

    conn = sqlite3.connect(db_path, timeout=30.0)
    filled = 0
    try:
        try:
            missing = conn.execute(
                "SELECT COUNT(*) FROM messages WHERE message_uuid IS NULL"
            ).fetchone()[0]
        except sqlite3.Error:
            return 0
        if not missing:
            return 0
        paths = [
            p for p in sorted(Path(source_dir).glob("*.json"))
            if p.is_file() and p.name not in ("memories.json", "users.json")
        ]
        # Some messages may have no id in any backup. Re-reading every backup
        # on each start would then be wasted work, so remember which set of
        # files was last checked and only look again when it changes.
        signature = json.dumps([BACKFILL_VERSION] + [[p.name, p.stat().st_size, int(p.stat().st_mtime)] for p in paths])
        # Kept in its own one-row table, not in the UI preferences.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_id_backfill "
            "(id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT)"
        )
        conn.commit()
        done = conn.execute("SELECT signature FROM message_id_backfill WHERE id = 1").fetchone()
        if done and done[0] == signature:
            return 0
        print("Recording message ids from the backups in source/ (one time)…", flush=True)
        def records_of(path):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return None, []
            provider = build_db.detect_provider(data)
            if provider is None:
                return None, []
            return provider, build_db.parse_backup(data, provider)

        # A chat can be in several backups, and a regenerated message can keep
        # its text and position while getting a new id. The stored chat is the
        # newest version (imports never roll back), so take each chat's ids
        # only from the newest backup that holds it: pass one finds it, pass
        # two applies it.
        newest: dict = {}
        for index, path in enumerate(paths):
            provider, records = records_of(path)
            for record in records:
                meta = record.get("meta") or {}
                key = (provider, meta.get("id"))
                when = float(meta.get("update_time") or 0)
                if key not in newest or when >= newest[key][0]:
                    newest[key] = (when, index)
        for index, path in enumerate(paths):
            if not any(best == index for _when, best in newest.values()):
                continue
            provider, records = records_of(path)
            updates = []
            for record in records:
                meta = record.get("meta") or {}
                if newest.get((provider, meta.get("id")), (0, None))[1] != index:
                    continue
                for m in record.get("msgs") or []:
                    if m.get("message_uuid"):
                        updates.append((m["message_uuid"], m["conversation_id"], provider,
                                        m.get("seq"), m.get("role"), m.get("content")))
            before = conn.total_changes
            conn.executemany(
                "UPDATE messages SET message_uuid = ? "
                "WHERE conversation_id = ? AND message_uuid IS NULL "
                "AND conversation_id IN (SELECT id FROM conversations WHERE provider = ?) "
                "AND seq = ? AND role = ? AND content = ?",
                updates,
            )
            conn.commit()
            filled += conn.total_changes - before
        try:
            conn.execute(
                "INSERT OR REPLACE INTO message_id_backfill (id, signature) VALUES (1, ?)",
                (signature,),
            )
            conn.commit()
        except sqlite3.Error:
            pass
    finally:
        conn.close()
    return filled


# ── Bookmarks made before message ids were kept ───────────────────────────────
# Such a bookmark only knows a position. It must learn its message's id while
# that position still points at its message, which is before anything replaces
# the chat's messages: at start-up (bind_legacy_bookmarks) and just before a
# re-import replaces a chat (bookmarks_before_replace / bookmarks_after_replace).

GONE_PREFIX = "gone:"


def bind_legacy_bookmarks(conn) -> None:
    """Give every bookmark without a message id the id at its position."""
    for (conversation_id,) in conn.execute(
        "SELECT DISTINCT conversation_id FROM udb.conversation_bookmarks WHERE message_uuid IS NULL"
    ).fetchall():
        reanchor_bookmarks(conn, conversation_id)


def bookmarks_before_replace(conn, conversation_id: str) -> list:
    """Call before a chat's messages are replaced. Binds what can be bound by
    id, and remembers the text of the rest (messages that have no id)."""
    reanchor_bookmarks(conn, conversation_id)
    return conn.execute(
        "SELECT b.id, b.seq, m.role, m.content FROM udb.conversation_bookmarks b "
        "LEFT JOIN messages m ON m.conversation_id = b.conversation_id AND m.seq = b.seq "
        "WHERE b.conversation_id = ? AND b.message_uuid IS NULL",
        (conversation_id,),
    ).fetchall()


def bookmarks_after_replace(conn, conversation_id: str, remembered: list) -> None:
    """Call after the messages were replaced. Each remembered bookmark goes to
    the message with the same role and text nearest its old position that no
    other bookmark holds. With no such message it is marked gone, so it never
    lands on another message."""
    remembered_ids = {row[0] for row in remembered}
    claimed: set = set()
    for bookmark_id, seq, message_uuid in conn.execute(
        "SELECT id, seq, message_uuid FROM udb.conversation_bookmarks WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchall():
        if bookmark_id in remembered_ids:
            continue
        current = locate(conn, conversation_id, message_uuid, seq)
        if current is not None:
            claimed.add(current)
    for bookmark_id, old_seq, role, content in remembered:
        match = None
        if role is not None:
            match = _nearest_with_fingerprint(
                conn, conversation_id, message_fingerprint(role, content), old_seq, claimed)
        try:
            if match:
                claimed.add(match[0])
                conn.execute(
                    "UPDATE udb.conversation_bookmarks SET seq = ?, message_uuid = ?, message_hash = ? WHERE id = ?",
                    (match[0], match[1], message_fingerprint(role, content), bookmark_id),
                )
            else:
                _mark_gone(conn, bookmark_id)
        except sqlite3.IntegrityError:
            _mark_gone(conn, bookmark_id)
