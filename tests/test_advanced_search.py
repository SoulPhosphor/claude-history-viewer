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

    def test_changing_sort_or_view_reuses_the_recent_search(self):
        for sort, view in (("newest", "default"), ("oldest", "compact")):
            advanced_search.search(self.conn, {
                **self.criteria("all"), "sort": sort, "result_view": view,
            })
        recent = advanced_search.history(self.conn)["recent"]
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["criteria"]["sort"], "oldest")
        self.assertEqual(recent[0]["use_count"], 2)

    def test_importing_a_chatgpt_backup_stores_every_model(self):
        records = build_db.dedup_records(build_db.parse_backup(
            [conversation("imported", "Imported Chat", ["gpt-4o", "o3"])], "chatgpt",
        ))
        build_db.reconcile_backup(self.conn, records, "chatgpt")
        self.conn.commit()
        rows = self.conn.execute(
            "SELECT DISTINCT model_slug FROM messages "
            "WHERE conversation_id='imported' AND model_slug IS NOT NULL"
        ).fetchall()
        self.assertEqual({row[0] for row in rows}, {"gpt-4o", "o3"})

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

    def add_folder(self, folder_id, provider, conversation_id):
        self.conn.execute(
            "INSERT INTO udb.folders(id,name,provider) VALUES (?,?,?)",
            (folder_id, folder_id, provider),
        )
        self.conn.execute(
            "INSERT INTO udb.folder_items(conversation_id,folder_id) VALUES (?,?)",
            (conversation_id, folder_id),
        )
        self.conn.commit()

    def filtered(self, filters):
        data = advanced_search.search(self.conn, {"providers": ["chatgpt"], "filters": filters})
        return {row["id"] for row in data["results"]}

    def test_folder_choices_apply_only_to_their_own_provider(self):
        self.add_folder("gpt-folder", "chatgpt", "exact")
        self.add_folder("claude-folder", "claude", "missing-claude-chat")
        both = {
            "chatgpt_folders": {"include": ["gpt-folder"], "exclude": [], "none": False},
            "claude_folders": {"include": ["claude-folder"], "exclude": [], "none": False},
        }
        self.assertEqual(self.filtered(both), {"exact"})
        # A remembered Claude choice has no effect while only ChatGPT is searched.
        claude_only = {"claude_folders": both["claude_folders"]}
        self.assertEqual(self.filtered(claude_only), {"exact", "gapped"})

    def test_all_except_excluded_keeps_everything_but_the_excluded(self):
        self.conn.execute(
            "INSERT INTO udb.conversation_tags(conversation_id,tag,added_at) VALUES ('exact','drop',1)"
        )
        self.conn.commit()
        tags = {"include": [advanced_search.ALL], "exclude": ["drop"], "none": False}
        self.assertEqual(self.filtered({"tags": tags}), {"gapped"})
        tags["exclude"] = []
        self.assertEqual(self.filtered({"tags": tags}), {"exact", "gapped"})

    def test_all_text_locations_searches_every_location(self):
        data = advanced_search.search(self.conn, {
            "query": "Housing Project",
            "text_mode": "exact",
            "providers": ["chatgpt"],
            "search_in": {"include": [advanced_search.ALL], "exclude": []},
        })
        self.assertEqual([row["id"] for row in data["results"]], ["exact"])


def chat(cid, texts, attachments=None):
    """A ChatGPT conversation with one message per (role, text) pair."""
    rows = []
    parent = None
    for index, (role, text) in enumerate(texts):
        node_id = f"{cid}-{index}"
        rows.append(message(node_id, parent, role, text))
        parent = node_id
    mapping = dict(rows)
    for node_id, node in rows[1:]:
        mapping[node["parent"]]["children"].append(node_id)
    return {
        "id": cid,
        "title": cid,
        "create_time": 1,
        "update_time": 2,
        "current_node": parent,
        "mapping": mapping,
    }


class AdvancedTextMatchingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        source = root / "conversations.json"
        filler = "filler " * 100
        source.write_text(
            json.dumps([
                chat("split", [("user", "tell me about housing"), ("assistant", "the project is big")]),
                chat("one-word", [("user", "only housing here")]),
                chat("spaced", [("user", "Housing   Project plan")]),
                chat("newline", [("user", "Housing\nProject plan")]),
                chat("snippet", [("user", "project first. " + filler + "housing project later")]),
                chat("ordered", [
                    ("user", "housing"),
                    ("assistant", "housing project"),
                    ("user", "housing project again"),
                ]),
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

    def search(self, query, mode, sources=("user_messages", "ai_messages"), whole=False):
        return advanced_search.search(self.conn, {
            "query": query,
            "text_mode": mode,
            "whole_words": whole,
            "providers": ["chatgpt"],
            "search_in": {"include": list(sources), "exclude": []},
        })["results"]

    def ids(self, *args, **kwargs):
        return {row["id"] for row in self.search(*args, **kwargs)}

    def test_all_words_may_be_spread_across_the_conversation(self):
        found = self.ids("housing project", "all")
        self.assertIn("split", found)
        self.assertNotIn("one-word", found)

    def test_any_word_matches_a_single_word(self):
        self.assertIn("one-word", self.ids("housing project", "any"))

    def test_exact_phrase_allows_several_spaces(self):
        self.assertIn("spaced", self.ids("housing project", "exact"))

    def test_exact_phrase_does_not_cross_a_line_break(self):
        self.assertNotIn("newline", self.ids("housing project", "exact"))

    def test_exact_phrase_does_not_allow_words_between(self):
        self.assertNotIn("split", self.ids("housing project", "exact"))

    def test_snippet_shows_the_exact_phrase_match(self):
        row = next(r for r in self.search("housing project", "exact") if r["id"] == "snippet")
        self.assertIn("housing project later", row["snippet"])

    def test_snippet_respects_whole_words(self):
        text = "start " + "x " * 200 + "art here"
        self.assertIn("art here", advanced_search._snippet(text, "art", "all", True))

    def test_snippet_comes_from_earliest_message_with_most_words(self):
        row = next(r for r in self.search("housing project", "all") if r["id"] == "ordered")
        self.assertEqual(row["snippet"], "housing project")
        self.assertEqual(row["snippet_source"], "AI Message")

    def test_title_is_the_last_choice_for_the_snippet(self):
        row = next(
            r for r in self.search("housing", "all", sources=("titles", "user_messages"))
            if r["id"] == "one-word"
        )
        self.assertEqual(row["snippet_source"], "User Message")

    def test_text_is_read_only_for_conversations_that_passed_the_filters(self):
        advanced_search._register_functions(self.conn)
        rows = advanced_search._matching_rows(
            self.conn, ["user_messages", "titles"], "housing", "all", False, {"split"},
        )
        self.assertEqual({row["conversation_id"] for row in rows}, {"split"})

    def test_attachment_search_ignores_json_keys(self):
        stored = json.dumps([{"name": "plan.md", "type": "markdown", "content": "rent figures"}])
        self.conn.execute(
            "UPDATE messages SET attachments=? WHERE conversation_id='one-word'", (stored,)
        )
        self.conn.commit()
        self.assertNotIn("one-word", self.ids("content", "all", sources=("attachments",)))
        self.assertNotIn("one-word", self.ids("markdown", "all", sources=("attachments",)))
        self.assertIn("one-word", self.ids("rent", "all", sources=("attachments",)))
        self.assertIn("one-word", self.ids("plan.md", "all", sources=("attachments",)))
        row = self.search("rent", "all", sources=("attachments",))[0]
        self.assertNotIn("{", row["snippet"])


if __name__ == "__main__":
    unittest.main()
