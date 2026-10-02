import json
import tempfile
import unittest
from pathlib import Path

import advanced_search
import build_db
from server import _ensure_runtime_schema, _ensure_userdata_schema, open_db


def message(node_id, parent, role, text, model=None):
    metadata = {"model_slug": model} if model else {}
    return node_id, {
        "id": node_id,
        "parent": parent,
        "children": [],
        "message": {
            "author": {"role": role},
            "content": {"content_type": "text", "parts": [text]},
            "metadata": metadata,
            "create_time": 1,
        },
    }


def conversation(cid, title, models):
    rows = [message(f"{cid}-user", None, "user", "Find this conversation")]
    parent = rows[0][0]
    for index, model in enumerate(models):
        node_id = f"{cid}-assistant-{index}"
        rows.append(message(node_id, parent, "assistant", f"Reply {index}", model))
        parent = node_id
    mapping = dict(rows)
    for node_id, node in rows[1:]:
        mapping[node["parent"]]["children"].append(node_id)
    return {
        "id": cid,
        "title": title,
        "create_time": 1,
        "update_time": 2,
        "current_node": parent,
        "mapping": mapping,
    }


class AdvancedSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        source = root / "conversations.json"
        source.write_text(
            json.dumps([
                conversation("exact", "Housing Project", ["gpt-4o", "gpt-4.1"]),
                conversation("gapped", "Housing Execution Project", ["gpt-4o"]),
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

    def criteria(self, mode):
        return {
            "query": "Housing Project",
            "text_mode": mode,
            "providers": ["chatgpt"],
            "statuses": ["active"],
            "search_in": {"include": ["titles"], "exclude": []},
        }

    def test_all_words_allows_words_with_text_between_them(self):
        data = advanced_search.search(self.conn, self.criteria("all"))
        self.assertEqual({row["id"] for row in data["results"]}, {"exact", "gapped"})

    def test_exact_phrase_rejects_gapped_title(self):
        data = advanced_search.search(self.conn, self.criteria("exact"))
        self.assertEqual([row["id"] for row in data["results"]], ["exact"])

    def test_every_chatgpt_model_is_stored_and_returned(self):
        data = advanced_search.search(self.conn, self.criteria("exact"))
        self.assertEqual(set(data["results"][0]["models"]), {"gpt-4o", "gpt-4.1"})

    def test_tag_selection_is_an_exact_filter_not_word_search_text(self):
        self.conn.execute(
            "INSERT INTO udb.conversation_tags(conversation_id,tag,added_at) VALUES (?,?,?)",
            ("exact", "Housing Project", 1),
        )
        self.conn.commit()
        typed = self.criteria("exact")
        typed["search_in"] = {"include": ["user_messages"], "exclude": []}
        self.assertEqual(advanced_search.search(self.conn, typed)["total"], 0)

        filtered = {
            "providers": ["chatgpt"],
            "statuses": ["active"],
            "filters": {
                "tags": {"include": ["Housing Project"], "exclude": [], "none": False}
            },
        }
        data = advanced_search.search(self.conn, filtered)
        self.assertEqual([row["id"] for row in data["results"]], ["exact"])


if __name__ == "__main__":
    unittest.main()
