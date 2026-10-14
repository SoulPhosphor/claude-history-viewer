import json
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import build_db
import scratchpads
from api_common import ApiError
from server import Handler, _ensure_runtime_schema, _ensure_userdata_schema, _userdata_path, open_db
from tests.test_advanced_search import conversation


def build_history(root: Path, conversations):
    source = root / "conversations.json"
    source.write_text(json.dumps(conversations), encoding="utf-8")
    db_path = root / "history.db"
    build_db.build(source, db_path)
    _ensure_runtime_schema(db_path)
    _ensure_userdata_schema(db_path)
    return source, db_path


class ScratchPadStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source, self.db_path = build_history(self.root, [
            conversation("one", "Cognitive Scaffolding Research", ["gpt-4o"]),
            conversation("two", "Emotional Intelligence", ["gpt-4o"]),
            conversation("three", "Scaffolding in the Recycle Bin", ["gpt-4o"]),
        ])
        self.conn = open_db(self.db_path)

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def reopen(self):
        self.conn.close()
        self.conn = open_db(self.db_path)

    def test_create_rename_save_reopen_delete(self):
        pad = scratchpads.create_pad(self.conn, {})["scratch_pad"]
        self.assertEqual(pad["title"], scratchpads.DEFAULT_TITLE)
        self.assertEqual(pad["content"], "")
        pad_id = pad["id"]

        renamed = scratchpads.update_pad(self.conn, pad_id, {"title": "  AI   Research "})["scratch_pad"]
        self.assertEqual(renamed["id"], pad_id)
        self.assertEqual(renamed["title"], "AI Research")

        body = "# Notes\n\n**bold** and [a chat](chv://conversation/one)"
        scratchpads.update_pad(self.conn, pad_id, {"content": body})
        self.reopen()
        again = scratchpads.get_pad(self.conn, pad_id)["scratch_pad"]
        self.assertEqual(again["content"], body)
        self.assertEqual(again["title"], "AI Research")

        scratchpads.delete_pad(self.conn, pad_id)
        with self.assertRaises(ApiError) as caught:
            scratchpads.get_pad(self.conn, pad_id)
        self.assertEqual(caught.exception.status, 404)

    def test_empty_title_rename_is_refused(self):
        pad_id = scratchpads.create_pad(self.conn, {"title": "Keep"})["scratch_pad"]["id"]
        with self.assertRaises(ApiError):
            scratchpads.update_pad(self.conn, pad_id, {"title": "   "})
        self.assertEqual(scratchpads.get_pad(self.conn, pad_id)["scratch_pad"]["title"], "Keep")

    def test_pads_are_independent_and_sorted_by_last_change(self):
        first = scratchpads.create_pad(self.conn, {"title": "First"})["scratch_pad"]["id"]
        time.sleep(0.01)
        second = scratchpads.create_pad(self.conn, {"title": "Second"})["scratch_pad"]["id"]
        scratchpads.update_pad(self.conn, second, {"content": "only second"})
        time.sleep(0.01)
        scratchpads.update_pad(self.conn, first, {"content": "only first"})
        listed = [row["id"] for row in scratchpads.list_pads(self.conn)["scratch_pads"]]
        self.assertEqual(listed, [first, second])
        self.assertEqual(scratchpads.get_pad(self.conn, second)["scratch_pad"]["content"], "only second")

    def test_title_search(self):
        scratchpads.create_pad(self.conn, {"title": "AI Research"})
        scratchpads.create_pad(self.conn, {"title": "Groceries"})
        scratchpads.create_pad(self.conn, {"title": "100% done_now"})
        titles = [r["title"] for r in scratchpads.list_pads(self.conn, "research")["scratch_pads"]]
        self.assertEqual(titles, ["AI Research"])
        # LIKE wildcards in the search text are literal.
        titles = [r["title"] for r in scratchpads.list_pads(self.conn, "%")["scratch_pads"]]
        self.assertEqual(titles, ["100% done_now"])

    def test_append_keeps_content_and_adds_its_own_paragraph(self):
        pad_id = scratchpads.create_pad(self.conn, {})["scratch_pad"]["id"]
        scratchpads.append_to_pad(self.conn, pad_id, {"markdown": "[One](chv://conversation/one)"})
        self.assertEqual(
            scratchpads.get_pad(self.conn, pad_id)["scratch_pad"]["content"],
            "[One](chv://conversation/one)",
        )
        scratchpads.update_pad(self.conn, pad_id, {"content": "## Heading\n- item\n\n\n"})
        scratchpads.append_to_pad(self.conn, pad_id, {"markdown": "[Two](chv://conversation/two)"})
        self.assertEqual(
            scratchpads.get_pad(self.conn, pad_id)["scratch_pad"]["content"],
            "## Heading\n- item\n\n[Two](chv://conversation/two)",
        )
        with self.assertRaises(ApiError):
            scratchpads.append_to_pad(self.conn, pad_id, {"markdown": "two\nlines"})

    def test_save_from_an_older_copy_is_refused(self):
        pad = scratchpads.create_pad(self.conn, {"content": "draft"})["scratch_pad"]
        opened_at = pad["version"]
        # Renaming is not a content change.
        renamed = scratchpads.update_pad(self.conn, pad["id"], {"title": "Renamed"})["scratch_pad"]
        self.assertEqual(renamed["version"], opened_at)
        # Another window adds a link, then this window saves from its old copy.
        appended = scratchpads.append_to_pad(self.conn, pad["id"], {"markdown": "[L](chv://conversation/one)"})
        self.assertEqual(appended["scratch_pad"]["version"], opened_at + 1)
        with self.assertRaises(ApiError) as caught:
            scratchpads.update_pad(self.conn, pad["id"], {"content": "mine", "base_version": opened_at})
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("[L]", scratchpads.get_pad(self.conn, pad["id"])["scratch_pad"]["content"])
        # Saving against the current version works and bumps it.
        saved = scratchpads.update_pad(self.conn, pad["id"], {"content": "mine", "base_version": opened_at + 1})
        self.assertEqual(saved["scratch_pad"]["version"], opened_at + 2)

    def test_save_reply_is_the_saved_write_even_if_an_append_follows(self):
        pad = scratchpads.create_pad(self.conn, {"content": "start"})["scratch_pad"]
        real_get_pad = scratchpads.get_pad
        appender = []

        def get_pad_while_another_window_appends(conn, pad_id):
            def add():
                other = open_db(self.db_path)
                try:
                    scratchpads.append_to_pad(other, pad_id, {"markdown": "[L](chv://conversation/one)"})
                finally:
                    other.close()
            if not appender:
                appender.append(threading.Thread(target=add))
                appender[0].start()
                appender[0].join(0.3)  # lands now unless the save still holds the lock
            return real_get_pad(conn, pad_id)

        scratchpads.get_pad = get_pad_while_another_window_appends
        try:
            saved = scratchpads.update_pad(self.conn, pad["id"], {"content": "mine", "base_version": pad["version"]})
        finally:
            scratchpads.get_pad = real_get_pad
            appender[0].join()
        self.assertEqual((saved["scratch_pad"]["content"], saved["scratch_pad"]["version"]),
                         ("mine", pad["version"] + 1))
        # The append still lands after the save.
        self.assertIn("[L]", real_get_pad(self.conn, pad["id"])["scratch_pad"]["content"])

    def test_overlapping_appends_both_land(self):
        pad_id = scratchpads.create_pad(self.conn, {"content": "start"})["scratch_pad"]["id"]
        lines = [f"[L{i}](chv://conversation/one)" for i in range(8)]
        errors = []

        def add(line):
            conn = open_db(self.db_path)
            try:
                scratchpads.append_to_pad(conn, pad_id, {"markdown": line})
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)
            finally:
                conn.close()

        threads = [threading.Thread(target=add, args=(line,)) for line in lines]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        content = scratchpads.get_pad(self.conn, pad_id)["scratch_pad"]["content"]
        for line in lines:
            self.assertIn(line, content)
        self.assertTrue(content.startswith("start\n\n"))

    def test_pads_survive_restart_and_history_rebuild(self):
        pad_id = scratchpads.create_pad(self.conn, {"title": "Durable", "content": "kept"})["scratch_pad"]["id"]
        self.conn.close()
        # Rebuild history.db from scratch: userdata.db sits beside it untouched.
        self.db_path.unlink()
        for suffix in ("-wal", "-shm"):
            Path(str(self.db_path) + suffix).unlink(missing_ok=True)
        build_db.build(self.source, self.db_path)
        _ensure_runtime_schema(self.db_path)
        _ensure_userdata_schema(self.db_path)
        self.assertTrue(_userdata_path(self.db_path).exists())
        self.conn = open_db(self.db_path)
        pad = scratchpads.get_pad(self.conn, pad_id)["scratch_pad"]
        self.assertEqual((pad["title"], pad["content"]), ("Durable", "kept"))
        # Conversation ids are stable, so a link still resolves after the rebuild.
        self.assertTrue(scratchpads.resolve_link(self.conn, "one")["exists"])

    def test_schema_upgrade_keeps_existing_user_data(self):
        self.conn.execute(
            "INSERT INTO udb.folders (id, name, created_at, updated_at, provider) "
            "VALUES ('f1', 'Kept folder', 1, 1, 'chatgpt')"
        )
        self.conn.commit()
        scratchpads.create_pad(self.conn, {"title": "Kept pad"})
        self.conn.close()
        _ensure_userdata_schema(self.db_path)  # running the migration again
        self.conn = open_db(self.db_path)
        self.assertEqual(self.conn.execute("SELECT name FROM udb.folders").fetchone()[0], "Kept folder")
        self.assertEqual(
            [r["title"] for r in scratchpads.list_pads(self.conn)["scratch_pads"]], ["Kept pad"]
        )


class LinkLookupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, self.db_path = build_history(Path(self.temp.name), [
            conversation("one", "Cognitive Scaffolding Research", ["gpt-4o"]),
            conversation("two", "Emotional Intelligence", ["gpt-4o"]),
            conversation("three", "Scaffolding in the Recycle Bin", ["gpt-4o"]),
        ])
        self.conn = open_db(self.db_path)
        self.conn.execute("INSERT INTO conversation_meta (conversation_id, deleted) VALUES ('three', 1)")
        self.seq = self.conn.execute(
            "SELECT seq FROM messages WHERE conversation_id = 'two' ORDER BY seq LIMIT 1"
        ).fetchone()[0]
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, source, created_at, updated_at) "
            "VALUES ('bm1', 'two', ?, 'Cognitive scaffolding', 'user', 1, 1)",
            (self.seq,),
        )
        self.conn.execute(
            "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, source, created_at, updated_at) "
            "VALUES ('bm2', 'one', ?, '', 'user', 1, 1)",
            (self.seq,),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_suggestions_cover_titles_and_named_bookmarks(self):
        data = scratchpads.link_suggestions(self.conn, "scaffold")
        self.assertEqual([c["id"] for c in data["conversations"]], ["one"])  # Recycle Bin left out
        self.assertEqual(data["conversations"][0]["provider"], "chatgpt")
        self.assertEqual([b["id"] for b in data["bookmarks"]], ["bm1"])  # unnamed left out
        self.assertEqual(data["bookmarks"][0]["conversation_title"], "Emotional Intelligence")
        self.assertEqual(scratchpads.link_suggestions(self.conn, "  ")["conversations"], [])

    def test_gone_bookmarks_never_crowd_out_live_ones(self):
        for n in range(15):
            self.conn.execute(
                "INSERT INTO udb.conversation_bookmarks (id, conversation_id, seq, name, source, created_at, updated_at, message_uuid) "
                "VALUES (?, 'two', ?, ?, 'user', 1, 1, ?)",
                (f"g{n}", 9000 + n, f"Scaffold gone {n}", f"gone:g{n}"),
            )
        self.conn.commit()
        self.assertEqual([b["id"] for b in scratchpads.link_suggestions(self.conn, "scaffold")["bookmarks"]], ["bm1"])

    def test_renamed_conversation_title_is_searched_and_resolved(self):
        self.conn.execute("INSERT INTO conversation_meta (conversation_id, custom_title) VALUES ('two', 'Renamed Chat')")
        self.conn.commit()
        self.assertEqual([c["id"] for c in scratchpads.link_suggestions(self.conn, "renamed")["conversations"]], ["two"])
        self.assertEqual(scratchpads.resolve_link(self.conn, "two")["title"], "Renamed Chat")

    def test_resolve_reports_missing_targets(self):
        self.assertFalse(scratchpads.resolve_link(self.conn, "nope")["exists"])
        found = scratchpads.resolve_link(self.conn, "two", str(self.seq))
        self.assertTrue(found["exists"])
        self.assertTrue(found["message_exists"])
        self.assertEqual(found["bookmark_name"], "Cognitive scaffolding")
        self.assertFalse(scratchpads.resolve_link(self.conn, "two", "9999")["message_exists"])
        self.assertTrue(scratchpads.resolve_link(self.conn, "three")["deleted"])
        with self.assertRaises(ApiError):
            scratchpads.resolve_link(self.conn, "two", "x")

    def test_message_link_survives_bookmark_rename_and_delete(self):
        self.conn.execute("UPDATE udb.conversation_bookmarks SET name = 'New name' WHERE id = 'bm1'")
        self.conn.commit()
        self.assertTrue(scratchpads.resolve_link(self.conn, "two", self.seq)["message_exists"])
        self.conn.execute("DELETE FROM udb.conversation_bookmarks WHERE id = 'bm1'")
        self.conn.commit()
        found = scratchpads.resolve_link(self.conn, "two", self.seq)
        self.assertTrue(found["message_exists"])
        self.assertEqual(found["bookmark_name"], "")


class ScratchPadRouteTests(unittest.TestCase):
    """The HTTP routes, through the real request handler."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, db_path = build_history(Path(self.temp.name), [
            conversation("one", "Cognitive Scaffolding Research", ["gpt-4o"]),
        ])
        handler = type("TestHandler", (Handler,), {"db_path": db_path})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_round_trip(self):
        status, created = self.call("POST", "/api/scratchpads", {"title": "AI Research"})
        self.assertEqual(status, 200)
        pad_id = created["scratch_pad"]["id"]
        self.call("PATCH", f"/api/scratchpads/{pad_id}", {"content": "Hello"})
        status, appended = self.call("POST", f"/api/scratchpads/{pad_id}/append",
                                     {"markdown": "[Chat](chv://conversation/one)"})
        self.assertEqual(appended["scratch_pad"]["content"], "Hello\n\n[Chat](chv://conversation/one)")
        status, listed = self.call("GET", "/api/scratchpads?q=research")
        self.assertEqual([p["id"] for p in listed["scratch_pads"]], [pad_id])
        status, suggestions = self.call("GET", "/api/link-suggestions?q=cognitive")
        self.assertEqual([c["id"] for c in suggestions["conversations"]], ["one"])
        status, resolved = self.call("GET", "/api/link-resolve?conversation=one")
        self.assertTrue(resolved["exists"])
        status, _ = self.call("DELETE", f"/api/scratchpads/{pad_id}")
        self.assertEqual(status, 200)
        status, missing = self.call("GET", f"/api/scratchpads/{pad_id}")
        self.assertEqual(status, 404)
        self.assertIn("no longer exists", missing["error"])
        status, _ = self.call("PATCH", f"/api/scratchpads/{pad_id}", {"content": "x"})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
