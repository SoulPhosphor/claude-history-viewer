import json
import tempfile
import unittest
from pathlib import Path

import advanced_search
import build_db
import related
from api_common import ApiError
from server import _ensure_runtime_schema, _ensure_userdata_schema, _purge_conversation, open_db
from tests.test_advanced_search import conversation


class RelatedConversationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        source = root / "conversations.json"
        source.write_text(
            json.dumps([
                conversation("one", "Housing One", ["gpt-4o"]),
                conversation("two", "Housing Two", ["gpt-4o"]),
                conversation("three", "Housing Three", ["gpt-4o"]),
            ]),
            encoding="utf-8",
        )
        self.db_path = root / "history.db"
        build_db.build(source, self.db_path)
        _ensure_runtime_schema(self.db_path)
        _ensure_userdata_schema(self.db_path)
        self.conn = open_db(self.db_path)

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def ids(self, cid):
        return {row["id"] for row in related.list_related(self.conn, cid)}

    def test_links_are_reciprocal(self):
        related.link(self.conn, {"a": "two", "b": "one"})
        self.assertEqual(self.ids("one"), {"two"})
        self.assertEqual(self.ids("two"), {"one"})
        # Linking again from the other side is the same link.
        related.link(self.conn, {"a": "one", "b": "two"})
        count = self.conn.execute("SELECT COUNT(*) FROM udb.conversation_links").fetchone()[0]
        self.assertEqual(count, 1)

    def test_unlink_removes_both_directions(self):
        related.link(self.conn, {"a": "one", "b": "two"})
        related.unlink(self.conn, "two", "one")
        self.assertEqual(self.ids("one"), set())
        self.assertEqual(self.ids("two"), set())

    def test_rows_carry_location(self):
        related.link(self.conn, {"a": "one", "b": "two"})
        self.conn.execute(
            "INSERT INTO conversation_meta (conversation_id, archived) VALUES ('two', 1)"
        )
        self.conn.commit()
        row = related.list_related(self.conn, "one")[0]
        self.assertTrue(row["archived"])
        self.assertEqual(row["title"], "Housing Two")
        self.assertIn("message_count", row)

    def test_rejects_self_and_unknown(self):
        with self.assertRaises(ApiError):
            related.link(self.conn, {"a": "one", "b": "one"})
        with self.assertRaises(ApiError):
            related.link(self.conn, {"a": "one", "b": "missing"})

    def test_purge_drops_links(self):
        related.link(self.conn, {"a": "one", "b": "two"})
        related.link(self.conn, {"a": "three", "b": "two"})
        _purge_conversation(self.conn, "two")
        self.conn.commit()
        self.assertEqual(self.ids("one"), set())
        self.assertEqual(self.ids("three"), set())

    def test_search_can_leave_out_the_source_chat(self):
        criteria = {
            "query": "Housing",
            "providers": ["chatgpt"],
            "search_in": {"include": ["titles"], "exclude": []},
            "exclude_ids": ["one"],
        }
        data = advanced_search.search(self.conn, criteria)
        self.assertEqual({row["id"] for row in data["results"]}, {"two", "three"})
        stored = self.conn.execute(
            "SELECT criteria_json FROM udb.advanced_search_recent"
        ).fetchone()[0]
        self.assertNotIn("exclude_ids", json.loads(stored))


if __name__ == "__main__":
    unittest.main()
