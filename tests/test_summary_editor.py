from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).parents[1]
SUMMARY = (ROOT / "static/summary.js").read_text()
INDEX = (ROOT / "static/index.html").read_text()


class SummaryEditorContractTests(unittest.TestCase):
    def test_summary_module_is_valid_javascript(self):
        subprocess.run(
            ["node", "--check", str(ROOT / "static/summary.js")],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_visual_and_markdown_share_the_summary_textarea_source(self):
        self.assertIn('id="summary-mode-visual"', INDEX)
        self.assertIn('id="summary-mode-markdown"', INDEX)
        self.assertIn('id="summary-visual"', INDEX)
        self.assertIn('id="summary-input"', INDEX)
        self.assertIn('setSummaryMode("visual")', SUMMARY)
        self.assertIn("summaryInput.value", SUMMARY)
        self.assertIn("summaryMarkdown()", SUMMARY)
        self.assertNotIn("innerHTML", SUMMARY)
        self.assertNotIn("HTMLToMarkdown", SUMMARY)

    def test_visual_formatting_uses_portable_or_isolated_markdown_syntax(self):
        for syntax in ("**", "~~", "++", "=="):
            self.assertIn(syntax, SUMMARY)
        for heading in ("heading1", "heading2", "heading3"):
            self.assertIn(heading, SUMMARY)
        self.assertIn('data-format="bullet"', INDEX)
        self.assertIn('data-format="numbered"', INDEX)

    def test_custom_highlights_and_palette_are_persisted_as_preferences(self):
        self.assertIn("summaryHighlightPalette", SUMMARY)
        self.assertIn("saveSummaryPalette", SUMMARY)
        self.assertIn("{${color}}", SUMMARY)
        self.assertIn("slice(0, 32)", SUMMARY)
        self.assertIn("summary-palette-picker", INDEX)
        self.assertIn("summary-palette-remove", INDEX)

    def test_condensed_summary_remains_a_plain_textarea(self):
        self.assertIn('id="condensed-summary-input"', INDEX)
        self.assertIn('class="summary-textarea summary-textarea-condensed"', INDEX)
        self.assertNotIn('id="condensed-summary-input" class="summary-visual"', INDEX)


if __name__ == "__main__":
    unittest.main()
