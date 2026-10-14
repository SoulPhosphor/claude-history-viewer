"""Scratch Pad editor and internal-link behaviour that runs in Node, plus the
wiring contracts between the modules (no browser needed)."""
from pathlib import Path
import json
import subprocess
import unittest


ROOT = Path(__file__).parents[1]
INDEX = (ROOT / "static/index.html").read_text()
SCRATCH = (ROOT / "static/scratchpads.js").read_text()
ADVANCED = (ROOT / "static/advanced_search.js").read_text()
APP = (ROOT / "static/app.js").read_text()
PRELUDE = (
    "const c=require('./static/summary_editor_core.js');"
    "const L=require('./static/internal_links.js');"
    "const out=(v)=>process.stdout.write(JSON.stringify(v));"
)


def run_node(expression):
    result = subprocess.run(
        ["node", "-e", PRELUDE + expression],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


class InternalLinkFormatTests(unittest.TestCase):
    def test_conversation_and_message_links_round_trip(self):
        result = run_node(
            "out([L.conversationLink('abc-1'), L.messageLink('abc-1', 7),"
            " L.parse('chv://conversation/abc-1'), L.parse('  chv://conversation/abc-1/message/7 '),"
            " L.parse(L.conversationLink('a b/c')), L.messageLink('abc-1', 7, 'm/1'),"
            " L.parse(L.messageLink('abc-1', 7, 'm/1'))]);"
        )
        self.assertEqual(result[0], "chv://conversation/abc-1")
        self.assertEqual(result[1], "chv://conversation/abc-1/message/7")
        self.assertEqual(result[2], {"conversationId": "abc-1", "seq": None, "messageId": None})
        self.assertEqual(result[3], {"conversationId": "abc-1", "seq": 7, "messageId": None})
        self.assertEqual(result[4], {"conversationId": "a b/c", "seq": None, "messageId": None})
        self.assertEqual(result[5], "chv://conversation/abc-1/message/7/m%2F1")
        self.assertEqual(result[6], {"conversationId": "abc-1", "seq": 7, "messageId": "m/1"})
        # The message id rides inside Markdown links too.
        kinds = run_node(f"out(c.inlineSegments('[x]({result[5]})').map((s) => s.kind));")
        self.assertEqual(kinds, ["link"])

    def test_other_text_is_not_an_internal_link(self):
        result = run_node(
            "out(['https://example.com', 'chv://conversation/', 'chv://conversation/x/message/y',"
            " 'hello', ''].map(L.parse));"
        )
        self.assertEqual(result, [None] * 5)

    def test_external_urls_are_recognized_and_made_markdown_safe(self):
        result = run_node(
            "out(['https://example.com/a(b)', 'www.example.com', 'mailto:me@example.com',"
            " 'not a url', 'ftp://x', 'https://'].map(L.externalUrl));"
        )
        self.assertEqual(result[0], "https://example.com/a%28b%29")
        self.assertEqual(result[1], "https://www.example.com")
        self.assertEqual(result[2], "mailto:me@example.com")
        self.assertEqual(result[3:], [None, None, None])

    def test_only_added_links_are_merged_after_a_conflict(self):
        cases = [
            ("foo", "foobar", None),                      # an ordinary edit that extends the text
            ("foo", "foo\n\n[L](chv://conversation/1)", "[L](chv://conversation/1)"),
            ("foo\n", "foo\n\n[A](chv://conversation/1)\n\n[B](https://x.org)", "[A](chv://conversation/1)\n\n[B](https://x.org)"),
            ("", "[L](chv://conversation/1)", "[L](chv://conversation/1)"),
            ("", "typed elsewhere", None),
            ("foo", "foo\n\nnot a link", None),
            ("foo", "changed", None),
            ("foo", "foo", ""),
        ]
        for saved, current, expected in cases:
            result = run_node(f"out(L.appendedLinks({json.dumps(saved)}, {json.dumps(current)}));")
            self.assertEqual(result, expected, (saved, current))

    def test_labels_cannot_break_the_link(self):
        result = run_node("out([L.markdown('a [b]\\n c', 'chv://conversation/1'), L.cleanLabel('  ')]);")
        self.assertEqual(result, ["[a (b) c](chv://conversation/1)", "Link"])


class EditorLinkTests(unittest.TestCase):
    def insert(self, source, start, end, label="L", target="chv://conversation/x"):
        return run_node(
            f"out(c.insertLink({json.dumps(source)}, {start}, {end}, {json.dumps(label)}, {json.dumps(target)}));"
        )

    def test_internal_links_render_as_link_tokens(self):
        segments = run_node("out(c.inlineSegments('See [Chat](chv://conversation/abc/message/2).'));")
        link = next(s for s in segments if s["kind"] == "link")
        self.assertEqual(link["text"], "Chat")
        target = run_node("out(c.linkTarget(c.inlineSegments('[Chat](chv://conversation/abc)')[0]));")
        self.assertEqual(target, "chv://conversation/abc")

    def test_insert_at_cursor_keeps_the_rest_of_the_document(self):
        source = "first line\nsecond line"
        result = self.insert(source, 6, 6)
        self.assertEqual(result["source"], "first [L](chv://conversation/x)line\nsecond line")
        self.assertEqual(result["caret"], result["end"])

    def test_link_at_line_end_gets_a_space_for_the_caret(self):
        result = self.insert("text", 4, 4)
        self.assertEqual(result["source"], "text[L](chv://conversation/x) ")
        self.assertEqual(result["caret"], len(result["source"]))
        result = self.insert("a\nb", 1, 1)
        self.assertEqual(result["source"], "a[L](chv://conversation/x) \nb")

    def test_selected_text_becomes_the_link(self):
        result = self.insert("read this now", 5, 9, label="this")
        self.assertEqual(result["source"], "read [this](chv://conversation/x) now")

    def test_selection_inside_formatting_splits_it_instead_of_nesting(self):
        result = self.insert("**bold words**", 7, 12, label="words")
        self.assertEqual(result["source"], "**bold** [words](chv://conversation/x) ")
        result = self.insert("==mark this==", 7, 11, label="this")
        self.assertEqual(result["source"], "==mark== [this](chv://conversation/x) ")

    def test_caret_inside_a_link_adds_the_new_link_after_it(self):
        source = "[old](https://example.com) tail"
        result = self.insert(source, 2, 2)
        self.assertEqual(result["source"], "[old](https://example.com)[L](chv://conversation/x) tail")

    def test_list_and_heading_markers_survive(self):
        self.assertEqual(self.insert("- item", 6, 6)["source"], "- item[L](chv://conversation/x) ")
        self.assertEqual(self.insert("## Head", 3, 7, label="Head")["source"], "## [Head](chv://conversation/x) ")

    def test_remove_and_retarget_keep_the_visible_text(self):
        source = "a [label](chv://conversation/1) b"
        token = "c.linkTokenAt(s, 4, 4)"
        removed = run_node(f"const s={json.dumps(source)}; out(c.removeLink(s, {token}));")
        self.assertEqual(removed, "a label b")
        moved = run_node(f"const s={json.dumps(source)}; out(c.replaceLinkTarget(s, {token}, 'chv://conversation/2'));")
        self.assertEqual(moved, "a [label](chv://conversation/2) b")

    def test_deleting_all_link_text_removes_the_whole_link(self):
        source = "a [x](chv://conversation/1) b"
        result = run_node(f"out(c.safeReplaceVisibleRange({json.dumps(source)}, 3, 4, ''));")
        self.assertEqual(result, "a  b")

    def test_visible_text_strips_markdown(self):
        result = run_node("out(c.visibleText('a **b** [c](chv://conversation/1)', 0, 40));")
        self.assertEqual(result, "a b c")

    def test_append_block_matches_the_server(self):
        import scratchpads
        for content in ("", "  \n", "text", "text\n\n\n", "## H\n- i"):
            js = run_node(f"out(c.appendBlock({json.dumps(content)}, '[L](chv://conversation/1)'));")
            self.assertEqual(js, scratchpads.appended_content(content, "[L](chv://conversation/1)"), content)


class LineEditingTests(unittest.TestCase):
    """Backspace / Delete at a line edge, shared by Summary and Scratch Pads."""

    def join(self, source, position, direction):
        return run_node(f"out(c.deleteLineBreak({json.dumps(source)}, {position}, {json.dumps(direction)}));")

    def test_backspace_joins_lines_and_removes_blank_lines(self):
        self.assertEqual(self.join("abc\ndef", 4, "backward"), {"source": "abcdef", "caret": 3})
        self.assertEqual(self.join("abc\n\ndef", 4, "backward"), {"source": "abc\ndef", "caret": 3})
        self.assertEqual(self.join("abc\n", 4, "backward"), {"source": "abc", "caret": 3})

    def test_backspace_drops_a_list_or_heading_marker_first(self):
        self.assertEqual(self.join("a\n- item", 4, "backward"), {"source": "a\nitem", "caret": 2})
        self.assertEqual(self.join("## Head", 3, "backward"), {"source": "Head", "caret": 0})

    def test_delete_at_line_end_joins_the_next_line(self):
        self.assertEqual(self.join("abc\n- def", 3, "forward"), {"source": "abcdef", "caret": 3})

    def test_formatting_and_links_at_the_edge_still_join(self):
        # Caret before "b" (inside the bold markers) / after "a" (before them).
        self.assertEqual(self.join("a\n**b**", 4, "backward"), {"source": "a**b**", "caret": 1})
        self.assertEqual(self.join("**a**\nb", 3, "forward"), {"source": "**a**b", "caret": 3})
        self.assertEqual(self.join("**a**\nb", 6, "backward"), {"source": "**a**b", "caret": 3})
        self.assertEqual(self.join("x\n- [L](chv://conversation/1)", 5, "backward"),
                         {"source": "x\n[L](chv://conversation/1)", "caret": 3})

    def test_other_positions_use_ordinary_deletion(self):
        self.assertIsNone(self.join("abc\ndef", 5, "backward"))
        self.assertIsNone(self.join("abc", 0, "backward"))
        self.assertIsNone(self.join("abc", 3, "forward"))


class StartupOrderTests(unittest.TestCase):
    def test_message_ids_are_filled_before_the_server_answers(self):
        server = (ROOT / "server.py").read_text()
        body = server[server.index("def serve("):]
        self.assertLess(body.index("message_ids.fill_missing_from_sources"), body.index("_bind_server(port)"))
        self.assertLess(body.index("message_ids.bind_legacy_bookmarks"), body.index("_bind_server(port)"))


class WiringContractTests(unittest.TestCase):
    def test_new_modules_are_valid_javascript(self):
        for filename in ("static/internal_links.js", "static/scratchpads.js", "static/advanced_search.js",
                         "static/bookmarks.js", "static/bookmarks_hub.js", "static/app.js"):
            subprocess.run(["node", "--check", filename], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_scripts_load_in_dependency_order(self):
        order = ["summary_editor_core.js", "internal_links.js", "summary.js", "bookmarks.js",
                 "bookmarks_hub.js", "advanced_search.js", "related.js", "scratchpads.js"]
        positions = [INDEX.index(f'src="/static/{name}"') for name in order]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('href="/static/scratchpads.css"', INDEX)

    def test_scratch_pad_editor_reuses_the_summary_engine(self):
        self.assertIn("createVisualEditor({", SCRATCH)
        self.assertIn("attachVisualEditor(scratchEditor);", SCRATCH)
        self.assertNotIn("beforeinput", SCRATCH)  # editing goes through summary.js only

    def test_link_picking_never_touches_related_links(self):
        start = ADVANCED.index("function pickLinkResult")
        body = ADVANCED[start:ADVANCED.index("function linkChatButton")]
        self.assertNotIn("relatedConversations", body)
        self.assertNotIn("relatedConversations", SCRATCH)

    def test_navigation_hooks_are_in_place(self):
        self.assertIn("scratchPadNavigationGuard({ preview: keepAdvancedSearch })", APP)
        self.assertIn("scratchPadNavigationGuard()", APP[APP.index("async function leaveNotesForSpecialView"):])
        self.assertIn("scratchPadPanelsHidden()", APP)
        # A slower, older pad load never replaces a newer one.
        self.assertIn("if (token !== _spLoadToken) return false;", SCRATCH)
        # Leaving re-checks for edits typed while a save was running.
        self.assertIn("return spIsDirty() ? spConfirmLeavePad() : true;", SCRATCH)
        # A pasted link whose title arrives late only goes into its own pad.
        self.assertIn("if (sp.current?.id !== padId || spMarkdown() !== before) return;", SCRATCH)
        self.assertIn('data-action="scratch-pads"', INDEX)
        self.assertIn('placeholder="Search conversations, bookmarks, or paste a link..."', INDEX)


if __name__ == "__main__":
    unittest.main()
