import sqlite3
import tempfile
import unittest
from pathlib import Path

from server import (
    Handler,
    _ensure_runtime_schema,
    _ensure_userdata_schema,
    _userdata_path,
)


ROOT = Path(__file__).parents[1]
NOTES_JS = (ROOT / "static" / "notes.js").read_text()
INDEX = (ROOT / "static" / "index.html").read_text()
SERVER = (ROOT / "server.py").read_text()
APP_JS = (ROOT / "static" / "app.js").read_text()
BOOKMARKS_HUB_JS = (ROOT / "static" / "bookmarks_hub.js").read_text()


class NotesApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "history.db"
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT)")
        conn.commit()
        conn.close()
        _ensure_runtime_schema(self.db_path)
        _ensure_userdata_schema(self.db_path)

    def tearDown(self):
        self.tempdir.cleanup()

    def handler(self, payload=None):
        handler = object.__new__(Handler)
        handler.db_path = self.db_path
        handler._read_json_body = lambda: payload or {}
        handler.response = None
        handler.send_json = lambda body, status=200: setattr(
            handler, "response", (status, body)
        )
        return handler

    def test_schema_keeps_three_note_fields_separate(self):
        conn = sqlite3.connect(_userdata_path(self.db_path))
        try:
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(conversation_notes)")
            }
        finally:
            conn.close()
        self.assertTrue(
            {"conversation_id", "user_notes", "notes_to_ai", "notes_from_ai"}
            <= columns
        )

    def test_partial_updates_do_not_overwrite_other_note_fields(self):
        first = self.handler(
            {
                "user_notes": "mine",
                "notes_to_ai": "context",
                "notes_from_ai": "result",
            }
        )
        first._api_notes_update("conversation-1")
        self.assertEqual(first.response[0], 200)

        second = self.handler({"notes_from_ai": "new result"})
        second._api_notes_update("conversation-1")
        self.assertEqual(second.response[0], 200)

        read = self.handler()
        read._api_notes_get("conversation-1")
        self.assertEqual(
            {
                key: read.response[1][key]
                for key in ("user_notes", "notes_to_ai", "notes_from_ai")
            },
            {
                "user_notes": "mine",
                "notes_to_ai": "context",
                "notes_from_ai": "new result",
            },
        )

    def test_blank_notes_are_returned_for_a_new_conversation(self):
        read = self.handler()
        read._api_notes_get("new-conversation")
        self.assertEqual(read.response[0], 200)
        for field in ("user_notes", "notes_to_ai", "notes_from_ai"):
            self.assertEqual(read.response[1][field], "")


class NotesUiContractTests(unittest.TestCase):
    def test_all_three_fields_exist_in_both_interfaces(self):
        for field in ("user_notes", "notes_to_ai", "notes_from_ai"):
            self.assertGreaterEqual(INDEX.count(f'data-note-field="{field}"'), 5)

    def test_side_panel_revert_uses_visit_baseline_and_autosave(self):
        self.assertIn("_notesVisit.baseline = { ...values }", NOTES_JS)
        self.assertIn("const value = _notesVisit.baseline[field]", NOTES_JS)
        self.assertIn("scheduleSideAutosave", NOTES_JS)
        self.assertIn("if (_notesVisit.convId === convId) return", NOTES_JS)

    def test_sidebar_overlays_are_layered_instead_of_destroying_each_other(self):
        self.assertIn("raiseSidebarOverlay(notesSidePanel)", NOTES_JS)
        self.assertNotIn("closeBookmarkViews();\n\n  if (_sidebarWasCollapsed", NOTES_JS)

    def test_side_panel_protects_loading_and_failed_autosaves(self):
        self.assertIn("setSideNotesLoading(true)", NOTES_JS)
        self.assertIn("_notesPendingValues.set(field, value)", NOTES_JS)
        self.assertIn("if (!saved) return false", NOTES_JS)
        self.assertIn("notes-side-save-retry", INDEX)

    def test_unload_save_uses_fetch_keepalive(self):
        self.assertIn("{ keepalive: true }", NOTES_JS)

    def test_full_editor_is_guarded_while_notes_load(self):
        self.assertIn("setFullNotesLoading(true)", NOTES_JS)
        self.assertIn("token !== _notesFullLoadToken", NOTES_JS)

    def test_oversized_keepalive_warns_and_purge_removes_notes(self):
        self.assertIn("pendingIsOversized", NOTES_JS)
        self.assertIn(
            "DELETE FROM udb.conversation_notes WHERE conversation_id = ?",
            SERVER,
        )

    def test_unload_does_not_race_active_or_queued_autosaves(self):
        self.assertIn("_notesOutstandingSaves += 1", NOTES_JS)
        self.assertIn("pendingHasQueuedWrites", NOTES_JS)
        self.assertIn("!pendingHasQueuedWrites", NOTES_JS)

    def test_canceled_history_navigation_restores_the_conversation_entry(self):
        self.assertIn("_gbRestoringCanceledPopstate", BOOKMARKS_HUB_JS)
        self.assertIn("_auditRestoringCanceledPopstate", APP_JS)
        self.assertIn("history.forward()", BOOKMARKS_HUB_JS)


if __name__ == "__main__":
    unittest.main()
