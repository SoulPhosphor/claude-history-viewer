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


if __name__ == "__main__":
    unittest.main()
