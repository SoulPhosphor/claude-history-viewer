"""Message ids from the export: kept on import, filled in for older databases,
and used so message links and bookmarks follow a message that moved."""
import json
import tempfile
import unittest
from pathlib import Path

import build_db
import message_ids
import scratchpads
import sqlite3
from server import _ensure_runtime_schema, _ensure_userdata_schema, _userdata_path, open_db


def node(node_id, parent, role, text):
    return {
        "id": node_id, "parent": parent, "children": [],
        "message": {"id": node_id, "author": {"role": role},
                    "content": {"content_type": "text", "parts": [text]}, "create_time": 1},
    }


def chat(cid, turns, current):
    """turns: [(node_id, parent, role, text)]; current: the shown branch's leaf."""
    mapping = {t[0]: node(*t) for t in turns}
    for t in turns:
        if t[1]:
            mapping[t[1]]["children"].append(t[0])
    return {"id": cid, "title": "Chat " + cid, "create_time": 1, "update_time": 2,
            "current_node": current, "mapping": mapping}


# One chat; branch "b" has an extra edited turn early on, so every later
# message sits one position further down than on branch "a".
TURNS = [
    ("u1", None, "user", "hello"),
    ("a1", "u1", "assistant", "hi"),
    ("u2", "a1", "user", "tell me about cats"),
    ("a2", "u2", "assistant", "cats are great"),
    ("u2b", "a1", "user", "first, about dogs"),
    ("a2b", "u2b", "assistant", "dogs are great"),
    ("u3b", "a2b", "user", "tell me about cats"),
    ("a3b", "u3b", "assistant", "cats are great"),
]


class MessageIdTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "conversations.json").write_text(json.dumps([chat("c1", TURNS, "a2")]))
        self.db = self.root / "history.db"
        build_db.build(self.source / "conversations.json", self.db)
        _ensure_runtime_schema(self.db)
        _ensure_userdata_schema(self.db)
        self.conn = open_db(self.db)

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def seq_of(self, message_uuid):
        return message_ids.message_seq(self.conn, "c1", message_uuid)

    def reimport_branch_b(self):
        records = build_db.parse_backup([chat("c1", TURNS, "a3b")], "chatgpt")
        build_db.reconcile_backup(self.conn, records, "chatgpt")
        self.conn.commit()

    def test_import_keeps_each_messages_export_id(self):
        rows = self.conn.execute(
            "SELECT message_uuid FROM messages WHERE conversation_id = 'c1' ORDER BY seq"
        ).fetchall()
        self.assertEqual([r[0] for r in rows], ["u1", "a1", "u2", "a2"])

    def test_message_without_its_own_id_uses_its_tree_node_id(self):
        conv = chat("c9", TURNS[:2], "a1")
        for entry in conv["mapping"].values():
            entry["message"].pop("id")
        _meta, msgs = build_db.parse_conversation(conv)
        self.assertEqual([m["message_uuid"] for m in msgs], ["u1", "a1"])

    def test_link_and_bookmark_follow_a_message_that_moved(self):
        old_seq = self.seq_of("a2")
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at, message_uuid) "
            "VALUES ('bm', 'c1', ?, 'cats', 1, 1, NULL)", (old_seq,))
        self.conn.commit()
        message_ids.reanchor_bookmarks(self.conn, "c1")  # learns its id from where it points
        self.reimport_branch_b()
        # The same text now has a different export id and position; the original
        # message "a2" is gone from the shown branch, so nothing may match it.
        self.assertIsNone(self.seq_of("a2"))
        # A message present in both branches keeps its id and is found by it.
        self.assertEqual(self.seq_of("a1"), 1)
        resolved = scratchpads.resolve_link(self.conn, "c1", 1, "a1")
        self.assertEqual((resolved["seq"], resolved["message_exists"]), (1, True))

    def test_bookmark_seq_moves_with_its_message(self):
        self.reimport_branch_b()
        cats = self.seq_of("u3b")
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at, message_uuid) "
            "VALUES ('bm', 'c1', 0, 'cats', 1, 1, 'u3b')")
        self.conn.commit()
        message_ids.reanchor_bookmarks(self.conn, "c1")
        seq = self.conn.execute("SELECT seq FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()[0]
        self.assertEqual(seq, cats)
        # A link carrying the id lands on the message even with a stale seq.
        self.assertEqual(scratchpads.resolve_link(self.conn, "c1", 0, "u3b")["seq"], cats)

    def test_older_database_is_filled_from_the_backups(self):
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.commit()
        filled = message_ids.fill_missing_from_sources(self.db, self.source)
        self.assertEqual(filled, 4)
        self.assertEqual(self.seq_of("u2"), 2)
        # Nothing left to do: a second run reads nothing and changes nothing.
        self.assertEqual(message_ids.fill_missing_from_sources(self.db, self.source), 0)
        # Its bookkeeping stays out of the user's preferences.
        prefs = [r[0] for r in self.conn.execute("SELECT pref_key FROM ui_preferences")]
        self.assertFalse(any("backfill" in key for key in prefs))

    def test_fill_never_crosses_providers_or_edited_text(self):
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.execute("UPDATE messages SET content = 'edited' WHERE seq = 0")
        self.conn.commit()
        claude_backup = self.source / "other.json"
        # A Claude-shaped backup reusing the same conversation id must not
        # give its ids to the ChatGPT chat.
        claude_backup.write_text(json.dumps([{
            "uuid": "c1", "name": "x", "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
            "chat_messages": [{"uuid": "claude-1", "sender": "human", "text": "hi",
                               "created_at": "2024-01-01T00:00:00Z", "parent_message_uuid": None}],
        }]))
        message_ids.fill_missing_from_sources(self.db, self.source)
        rows = dict(self.conn.execute(
            "SELECT seq, message_uuid FROM messages WHERE conversation_id = 'c1'").fetchall())
        self.assertIsNone(rows[0])  # text no longer matches the backup
        self.assertNotIn("claude-1", rows.values())

    def test_a_gone_message_is_never_replaced_by_its_old_position(self):
        old_seq = self.seq_of("a2")
        self.reimport_branch_b()
        # Something else now sits at a2's old position; the link must not open it.
        self.assertIsNotNone(self.conn.execute(
            "SELECT 1 FROM messages WHERE conversation_id = 'c1' AND seq = ?", (old_seq,)).fetchone())
        resolved = scratchpads.resolve_link(self.conn, "c1", old_seq, "a2")
        self.assertFalse(resolved["message_exists"])

    def test_bookmark_on_a_gone_message_stays_but_is_not_placed(self):
        old_seq = self.seq_of("a2")
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at, message_uuid) "
            "VALUES ('bm', 'c1', ?, 'cats', 1, 1, 'a2')", (old_seq,))
        self.conn.commit()
        self.reimport_branch_b()
        message_ids.reanchor_bookmarks(self.conn, "c1")
        row = self.conn.execute("SELECT seq, message_uuid FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()
        self.assertEqual(tuple(row), (old_seq, "a2"))  # kept, untouched
        bookmark = self.conn.execute("SELECT seq, message_uuid FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()
        self.assertTrue(message_ids.bookmark_missing(self.conn, "c1", bookmark))
        # The message now at that position can still get its own bookmark.
        now_there = message_ids.message_uuid_at(self.conn, "c1", old_seq)
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at, message_uuid) "
            "VALUES ('bm2', 'c1', ?, 'new', 1, 1, ?)", (old_seq, now_there))
        self.conn.commit()

    def test_one_bookmark_per_message(self):
        for bid in ("x", "y"):
            try:
                self.conn.execute(
                    "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at, message_uuid) "
                    f"VALUES ('{bid}', 'c1', 0, '', 1, 1, 'u1')")
            except sqlite3.IntegrityError:
                self.assertEqual(bid, "y")
                return
        self.fail("two bookmarks were allowed on one message")

    def test_chat_without_ids_falls_back_to_position(self):
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.commit()
        self.assertEqual(message_ids.locate(self.conn, "c1", "a2", 3), 3)
        self.assertIsNone(message_ids.locate(self.conn, "c1", None, 99))

    def test_old_bookmark_table_is_upgraded_without_losing_bookmarks(self):
        self.conn.close()
        udb = sqlite3.connect(_userdata_path(self.db))
        udb.executescript(
            """
            DROP TABLE conversation_bookmarks;
            CREATE TABLE conversation_bookmarks (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
                name TEXT, source TEXT DEFAULT 'user', created_at REAL, updated_at REAL,
                UNIQUE(conversation_id, seq));
            INSERT INTO conversation_bookmarks VALUES ('old', 'c1', 2, 'kept', 'user', 1, 1);
            """
        )
        udb.commit()
        udb.close()
        _ensure_userdata_schema(self.db)
        self.conn = open_db(self.db)
        sql = self.conn.execute(
            "SELECT sql FROM udb.sqlite_master WHERE name = 'conversation_bookmarks'").fetchone()[0]
        self.assertNotIn("UNIQUE(conversation_id, seq)", sql)
        row = self.conn.execute("SELECT id, seq, name FROM udb.conversation_bookmarks").fetchone()
        self.assertEqual(tuple(row), ("old", 2, "kept"))
        message_ids.reanchor_bookmarks(self.conn, "c1")
        self.assertEqual(self.conn.execute(
            "SELECT message_uuid FROM udb.conversation_bookmarks WHERE id = 'old'").fetchone()[0], "u2")

    def test_old_bookmark_follows_its_text_through_a_reimport(self):
        # A chat imported before ids were kept, with a bookmark that only knows
        # a position.
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        cats_answer = 3
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at) "
            "VALUES ('bm', 'c1', ?, 'cats', 1, 1)", (cats_answer,))
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at) "
            "VALUES ('bm2', 'c1', 2, 'gone', 1, 1)")
        self.conn.commit()
        self.reimport_branch_b()
        rows = {r[0]: (r[1], r[2]) for r in self.conn.execute(
            "SELECT id, seq, message_uuid FROM udb.conversation_bookmarks")}
        # "cats are great" moved down one place and got a new id: it follows.
        self.assertEqual(rows["bm"], (self.seq_of("a3b"), "a3b"))
        # "tell me about cats" (u2) has the same text as u3b, so it follows too.
        self.assertEqual(rows["bm2"][1], "u3b")

    def test_old_bookmark_on_a_message_that_vanished_is_marked_gone(self):
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.execute("UPDATE messages SET content = 'only in the old version' WHERE seq = 3")
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at) "
            "VALUES ('bm', 'c1', 3, 'x', 1, 1)")
        self.conn.commit()
        self.reimport_branch_b()
        bookmark = self.conn.execute(
            "SELECT seq, message_uuid FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()
        self.assertTrue(bookmark["message_uuid"].startswith(message_ids.GONE_PREFIX))
        self.assertTrue(message_ids.bookmark_missing(self.conn, "c1", bookmark))

    def test_bind_legacy_bookmarks_at_start(self):
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at) "
            "VALUES ('bm', 'c1', 2, 'x', 1, 1)")
        self.conn.commit()
        message_ids.bind_legacy_bookmarks(self.conn)
        self.assertEqual(self.conn.execute(
            "SELECT message_uuid FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()[0], "u2")

    def test_backfill_takes_ids_from_the_newest_backup(self):
        # An older backup of the same chat where the last reply had another id
        # (regenerated with the same text) must not win.
        old = chat("c1", TURNS, "a2")
        old["update_time"] = 1
        old["mapping"]["a2"]["message"]["id"] = "a2-old"
        (self.source / "aaa-older.json").write_text(json.dumps([old]))
        (self.source / "conversations.json").write_text(json.dumps([dict(chat("c1", TURNS, "a2"), update_time=5)]))
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.commit()
        message_ids.fill_missing_from_sources(self.db, self.source)
        self.assertEqual(self.seq_of("a2"), 3)
        self.assertIsNone(self.seq_of("a2-old"))

    def test_bookmark_survives_a_full_rebuild_by_its_fingerprint(self):
        # An export without message ids: only text can identify a message.
        def no_ids(conv):
            for entry in conv["mapping"].values():
                entry["message"]["id"] = None
            return conv
        def strip(conv):
            conv = no_ids(conv)
            return conv
        source = self.source / "conversations.json"
        source.write_text(json.dumps([strip(chat("c1", TURNS, "a2"))]))
        self.conn.close()
        self.db.unlink()
        build_db.build(source, self.db)
        _ensure_runtime_schema(self.db)
        self.conn = open_db(self.db)
        # Node ids still fill in when the message has none; drop them to model
        # an export that has no ids at all.
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at) "
            "VALUES ('bm', 'c1', 3, 'cats', 1, 1)")  # "cats are great" (a2)
        self.conn.commit()
        message_ids.bind_legacy_bookmarks(self.conn)  # first start: learns the fingerprint
        # Full rebuild (rm history.db) from an export where the chat shows
        # branch b, so "cats are great" now sits one place further down.
        source.write_text(json.dumps([strip(chat("c1", TURNS, "a3b"))]))
        self.conn.close()
        self.db.unlink()
        build_db.build(source, self.db)
        _ensure_runtime_schema(self.db)
        self.conn = open_db(self.db)
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.commit()
        message_ids.bind_legacy_bookmarks(self.conn)
        seq = self.conn.execute("SELECT seq FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()[0]
        content = self.conn.execute(
            "SELECT content FROM messages WHERE conversation_id = 'c1' AND seq = ?", (seq,)).fetchone()[0]
        self.assertEqual(content, "cats are great")
        self.assertEqual(seq, 5)

    def test_rebuilt_chat_without_the_message_marks_the_bookmark_gone(self):
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, created_at, updated_at) "
            "VALUES ('bm', 'c1', 3, 'x', 1, 1)")
        self.conn.commit()
        message_ids.bind_legacy_bookmarks(self.conn)
        self.conn.execute("UPDATE messages SET message_uuid = NULL")
        self.conn.execute("UPDATE messages SET content = 'rewritten' WHERE seq = 3")
        self.conn.execute("UPDATE udb.conversation_bookmarks SET message_uuid = NULL")
        self.conn.commit()
        message_ids.reanchor_bookmarks(self.conn, "c1")
        row = self.conn.execute("SELECT seq, message_uuid FROM udb.conversation_bookmarks WHERE id = 'bm'").fetchone()
        self.assertTrue(row["message_uuid"].startswith(message_ids.GONE_PREFIX))


if __name__ == "__main__":
    unittest.main()
