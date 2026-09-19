from pathlib import Path
import json
import subprocess
import unittest


ROOT = Path(__file__).parents[1]
SUMMARY = (ROOT / "static/summary.js").read_text()
INDEX = (ROOT / "static/index.html").read_text()
CORE = "const c=require('./static/summary_editor_core.js');"


def run_node(expression):
    result = subprocess.run(
        ["node", "-e", CORE + expression],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


class SummaryEditorBehaviorTests(unittest.TestCase):
    def test_summary_module_and_core_are_valid_javascript(self):
        for filename in ("static/summary.js", "static/summary_editor_core.js"):
            subprocess.run(["node", "--check", filename], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_noop_source_is_byte_for_byte_unchanged(self):
        source = "## Heading\n\nThis is **bold**, *italic*, ~~strike~~, ++underline++, ==highlight==.\n\n- Item one\n- Item two"
        result = run_node(f"const source={json.dumps(source)}; process.stdout.write(JSON.stringify(source));")
        self.assertEqual(result, source)

    def test_formatted_visible_text_maps_after_markers(self):
        source = "**bold** ==highlight== =={#ff0000}red== `code` [visible](https://example.com)"
        segments = run_node(f"process.stdout.write(JSON.stringify(c.inlineSegments({json.dumps(source)})));")
        by_text = {segment["text"]: segment for segment in segments}
        self.assertEqual(source[by_text["bold"]["sourceStart"]], "b")
        self.assertEqual(source[by_text["highlight"]["sourceStart"]], "h")
        self.assertEqual(source[by_text["red"]["sourceStart"]], "r")
        self.assertEqual(source[by_text["code"]["sourceStart"]], "c")
        self.assertEqual(source[by_text["visible"]["sourceStart"]], "v")
        self.assertEqual(by_text["visible"]["sourceEnd"], source.index("]("))

    def test_newline_and_blank_line_segments_are_explicit(self):
        source = "first\n\nsecond"
        segments = run_node(f"process.stdout.write(JSON.stringify(c.visibleSegments({json.dumps(source)})));")
        newlines = [segment for segment in segments if segment["kind"] == "newline"]
        self.assertEqual([(item["sourceStart"], item["sourceEnd"]) for item in newlines], [(5, 6), (6, 7)])
        self.assertEqual("".join(item["text"] for item in segments), "first\n\nsecond")

    def test_editing_inside_formats_only_replaces_visible_source(self):
        cases = [
            ("This is **important**.", "important", "very important", "This is **very important**."),
            ("This is *important*.", "important", "very important", "This is *very important*."),
            ("This is ++important++.", "important", "very important", "This is ++very important++."),
            ("This is ~~important~~.", "important", "very important", "This is ~~very important~~."),
            ("This is ==important==.", "important", "very important", "This is ==very important==."),
            ("This is =={#ff0000}important==.", "important", "very important", "This is =={#ff0000}very important==."),
            ("This is `important`.", "important", "very important", "This is `very important`."),
        ]
        for source, visible, replacement, expected in cases:
            start = source.index(visible)
            result = run_node(f"process.stdout.write(JSON.stringify(c.replaceRange({json.dumps(source)}, {start}, {start + len(visible)}, {json.dumps(replacement)})));" )
            self.assertEqual(result, expected)

    def test_link_edit_does_not_touch_url(self):
        source = "Read [the documentation](https://example.com)."
        start = source.index("the documentation")
        result = run_node(f"process.stdout.write(JSON.stringify(c.replaceRange({json.dumps(source)}, {start}, {start + len('the documentation')}, 'the guide')));")
        self.assertEqual(result, "Read [the guide](https://example.com).")

    def test_multiline_bullets_and_numbered_lists_are_created(self):
        source = "First\nSecond\nThird"
        bullet = run_node(f"process.stdout.write(JSON.stringify(c.applyBlockFormat({json.dumps(source)}, 0, {len(source)}, 'bullet')));")
        numbered = run_node(f"process.stdout.write(JSON.stringify(c.applyBlockFormat({json.dumps(source)}, 0, {len(source)}, 'numbered')));")
        self.assertEqual(bullet, "- First\n- Second\n- Third")
        self.assertEqual(numbered, "1. First\n2. Second\n3. Third")

    def test_block_conversion_preserves_surrounding_lines(self):
        source = "before\nFirst\nSecond\nafter"
        start = source.index("First")
        end = source.index("after") - 1
        result = run_node(f"process.stdout.write(JSON.stringify(c.applyBlockFormat({json.dumps(source)}, {start}, {end}, 'bullet')));")
        self.assertEqual(result, "before\n- First\n- Second\nafter")

    def test_multiple_highlight_colors_are_segment_local(self):
        source = "=={#ff0000}red== =={#00ff00}green== ==normal=="
        segments = run_node(f"process.stdout.write(JSON.stringify(c.inlineSegments({json.dumps(source)}))); ")
        highlights = [segment for segment in segments if segment["kind"] == "highlight"]
        self.assertEqual([item["color"] for item in highlights], ["#ff0000", "#00ff00", None])
        self.assertNotIn("root.style.setProperty", SUMMARY)

    def test_unsupported_source_can_survive_unrelated_edit(self):
        source = "Before\n::: custom-block\nAfter"
        start = source.index("Before")
        edited = run_node(f"process.stdout.write(JSON.stringify(c.replaceRange({json.dumps(source)}, {start}, {start + 6}, 'Changed')));")
        self.assertIn("::: custom-block", edited)

    def test_editor_contract_and_condensed_summary_scope(self):
        for element in ("summary-mode-visual", "summary-mode-markdown", "summary-visual", "summary-input"):
            self.assertIn(f'id="{element}"', INDEX)
        self.assertIn('src="/static/summary_editor_core.js"', INDEX)
        self.assertIn('setSummaryMode("visual")', SUMMARY)
        self.assertNotIn("HTMLToMarkdown", SUMMARY)
        self.assertIn('id="condensed-summary-input"', INDEX)
        self.assertNotIn('id="condensed-summary-input" class="summary-visual"', INDEX)

    def test_palette_is_editable_and_preference_backed(self):
        for marker in ("summary-palette-edit", "summary-palette-remove-one", "summaryHighlightPalette", "saveSummaryPalette"):
            self.assertIn(marker, SUMMARY)
        self.assertIn("summary-palette-picker", INDEX)
        self.assertIn("slice(0, 32)", SUMMARY)


if __name__ == "__main__":
    unittest.main()
