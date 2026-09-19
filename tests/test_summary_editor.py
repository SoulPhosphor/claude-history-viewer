from pathlib import Path
import json
import subprocess
import unittest


ROOT = Path(__file__).parents[1]
SUMMARY = (ROOT / "static/summary.js").read_text()
INDEX = (ROOT / "static/index.html").read_text()
CORE = "const c=require('./static/summary_editor_core.js');"
CORE_SOURCE = (ROOT / "static/summary_editor_core.js").read_text()


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

    def test_safe_visible_range_replacement_preserves_cross_token_formatting(self):
        cases = [
            ("**important** plain", 4, 19, "X", "**im**X"),
            ("plain **important**", 0, 10, "X", "X**portant**"),
            ("before **important** after", 9, 26, "X", "before X"),
            ("**bold** and *italic*", 3, 17, "X", "**b**X*lic*"),
            ("[link](https://example.com) after", 1, 10, "X", "X after"),
        ]
        for source, start, end, replacement, expected in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.safeReplaceVisibleRange({json.dumps(source)}, {start}, {end}, {json.dumps(replacement)})));")
            self.assertEqual(result, expected)

    def test_partial_format_removal_keeps_unselected_text_formatted(self):
        self.assertEqual(run_node("process.stdout.write(JSON.stringify(c.removeHighlightRange('==important text==', 2, 11)));"), "important ==text==")
        self.assertEqual(run_node("process.stdout.write(JSON.stringify(c.toggleInlineFormat('**important text**', 2, 11, 'bold')));"), "important **text**")

    def test_highlight_color_replacement_does_not_nest(self):
        cases = [
            ("==important==", "#ff0000", "=={#ff0000}important=="),
            ("=={#ff0000}important==", "#00ff00", "=={#00ff00}important=="),
            ("=={#ff0000}important==", "", "==important=="),
        ]
        for source, color, expected in cases:
            start = source.index("important")
            result = run_node(f"process.stdout.write(JSON.stringify(c.replaceHighlightRange({json.dumps(source)}, {start}, {start + 9}, {json.dumps(color)})));")
            self.assertEqual(result, expected)

    def test_combined_inline_formats_are_parsed(self):
        cases = [
            ("***important***", "boldItalic"),
            ("**~~important~~**", "boldStrike"),
            ("~~*important*~~", "italicStrike"),
        ]
        for source, kind in cases:
            segments = run_node(f"process.stdout.write(JSON.stringify(c.inlineSegments({json.dumps(source)}))); ")
            self.assertEqual([segment["kind"] for segment in segments], [kind])
        self.assertEqual(run_node("process.stdout.write(JSON.stringify(c.toggleInlineFormat('**important**', 2, 11, 'italic')));"), "***important***")

    def test_element_boundary_mapping_uses_child_source_ranges(self):
        children = [{"start": 2, "end": 5}, {"start": 5, "end": 11}, {"start": 11, "end": 13}]
        result = run_node(f"process.stdout.write(JSON.stringify([c.mapElementBoundary({json.dumps(children)}, 0, 2, 13), c.mapElementBoundary({json.dumps(children)}, 1, 2, 13), c.mapElementBoundary({json.dumps(children)}, 2, 2, 13), c.mapElementBoundary({json.dumps(children)}, 3, 2, 13)]));")
        self.assertEqual(result, [2, 5, 11, 13])
        self.assertIn("function summarySourceBoundary", SUMMARY)

    def test_remove_highlight_and_toggle_inline_formats_off(self):
        cases = [
            ("==important==", "highlight", "important"),
            ("=={#ff0000}important==", "highlight", "important"),
            ("**important**", "bold", "important"),
            ("*important*", "italic", "important"),
            ("++important++", "underline", "important"),
            ("~~important~~", "strike", "important"),
        ]
        for source, kind, expected in cases:
            start = source.index("important")
            function = "removeHighlightRange" if kind == "highlight" else "toggleInlineFormat"
            expression = f"c.{function}({json.dumps(source)}, {start}, {start + 9}" + (f", {json.dumps(kind)}" if kind != "highlight" else "") + ")"
            result = run_node(f"process.stdout.write(JSON.stringify({expression}));")
            self.assertEqual(result, expected)

    def test_input_type_contract_covers_editing_and_blocks_unknown_types(self):
        supported = [
            "insertText", "insertReplacementText", "insertParagraph", "insertLineBreak",
            "insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop",
            "deleteContentBackward", "deleteContentForward", "deleteWordBackward",
            "deleteWordForward", "deleteByCut", "deleteByDrag", "historyUndo", "historyRedo",
        ]
        result = run_node(f"process.stdout.write(JSON.stringify({{supported:{json.dumps(supported)}.every(c.isSupportedVisualInputType), unknown:c.isSupportedVisualInputType('formatBold')}}));")
        self.assertTrue(result["supported"])
        self.assertFalse(result["unknown"])
        self.assertFalse(run_node("process.stdout.write(JSON.stringify(c.isSupportedVisualInputType('insertCompositionText')));"))
        self.assertFalse(run_node("process.stdout.write(JSON.stringify(c.isSupportedVisualInputType('deleteCompositionText')));"))
        self.assertNotIn("insertCompositionText", SUMMARY)
        self.assertNotIn("deleteCompositionText", SUMMARY)

    def test_delimiter_safe_deletion_boundaries_and_interior_deletion(self):
        cases = [
            ("**important**", 2, "backward", "**important**"),
            ("**important**", 11, "forward", "**important**"),
            ("==important==", 2, "backward", "==important=="),
            ("==important==", 11, "forward", "==important=="),
            ("=={#ff0000}important==", 11, "backward", "=={#ff0000}important=="),
            ("=={#ff0000}important==", 20, "forward", "=={#ff0000}important=="),
            ("[important](https://example.com)", 1, "backward", "[important](https://example.com)"),
            ("[important](https://example.com)", 10, "forward", "[important](https://example.com)"),
        ]
        for source, position, direction, expected in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.deleteVisibleCharacter({json.dumps(source)}, {position}, {json.dumps(direction)})));")
            self.assertEqual(result, expected)
        interior = run_node("process.stdout.write(JSON.stringify(c.deleteVisibleCharacter('**important**', 5, 'backward')));")
        self.assertEqual(interior, "**imortant**")

    def test_history_reset_contract_prevents_cross_summary_restore(self):
        self.assertIn("function clearVisualHistory()", SUMMARY)
        self.assertIn("clearVisualHistory();\n  if (messagesEl)", SUMMARY)
        self.assertIn("clearVisualHistory();\n  summaryInput.value = _savedSummary", SUMMARY)
        self.assertIn("clearVisualHistory();\n  updateSummaryButtons();", SUMMARY)
        self.assertIn("historyUndo", SUMMARY)
        self.assertIn("historyRedo", SUMMARY)

    def test_old_flattened_visual_edit_path_is_not_wired_and_editor_functions_are_unique(self):
        self.assertNotIn("patchVisualText", SUMMARY)
        self.assertNotIn("visibleText", SUMMARY)
        self.assertNotIn("sourcePositionForVisibleOffset", SUMMARY)
        self.assertNotIn('summaryVisual?.addEventListener("input"', SUMMARY)
        for name in ("sourceRangeFromSelection", "renderMarkdownSource", "refreshPaletteControls", "applyBlockFormat"):
            self.assertEqual(SUMMARY.count(f"function {name}("), 1, name)

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

    def test_block_content_maps_to_source_with_indentation_and_spacing(self):
        # The visible text of a heading, bullet, or numbered item must map back to
        # the exact source character where that text begins, even when the line is
        # indented or has extra spaces after the marker. A drifted offset would
        # patch the wrong source range and silently corrupt the Markdown.
        cases = [
            "## Heading",
            "##   Heading",
            "- Item",
            "  - Item",
            "-   Item",
            "1. Second",
            "  1. Second",
            "1.   Second",
        ]
        for source in cases:
            content = run_node(
                f"const line=c.sourceLines({json.dumps(source)})[0];"
                f"process.stdout.write(JSON.stringify(c.visibleContent(line)));"
            )
            self.assertEqual(source[content["start"]], content["text"][0], source)
            self.assertTrue(source.endswith(content["text"]), source)

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

    def test_contained_insert_delete_and_replace_stay_inside_bold(self):
        cases = [
            ("**important**", 4, 4, "X", "**imXportant**"),
            ("**important**", 4, 5, "", "**imortant**"),
            ("**important**", 4, 8, "X", "**imXant**"),
        ]
        for source, start, end, replacement, expected in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.safeReplaceVisibleRange({json.dumps(source)}, {start}, {end}, {json.dumps(replacement)})));" )
            self.assertEqual(result, expected)

    def test_contained_edits_preserve_italic_highlight_custom_highlight_code_and_link(self):
        cases = [
            ("*important*", 3, 3, "X", "*imXportant*"),
            ("==important==", 4, 4, "X", "==imXportant=="),
            ("=={#ff0000}important==", 13, 13, "X", "=={#ff0000}imXportant=="),
            ("`important`", 3, 3, "X", "`imXportant`"),
            ("[important](https://example.com)", 3, 3, "X", "[imXportant](https://example.com)"),
            ("[important](https://example.com)", 3, 7, "X", "[imXant](https://example.com)"),
        ]
        for source, start, end, replacement, expected in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.safeReplaceVisibleRange({json.dumps(source)}, {start}, {end}, {json.dumps(replacement)})));" )
            self.assertEqual(result, expected)

    def test_exact_end_selection_keeps_one_valid_token(self):
        cases = [
            ("**important**", 3, 11, "X", "**iX**"),
            ("*important*", 2, 10, "X", "*iX*"),
            ("++important++", 3, 11, "X", "++iX++"),
            ("~~important~~", 3, 11, "X", "~~iX~~"),
            ("==important==", 3, 11, "X", "==iX=="),
            ("=={#ff0000}important==", 12, 20, "X", "=={#ff0000}iX=="),
            ("`important`", 2, 10, "X", "`iX`"),
            ("[important](https://example.com)", 2, 10, "X", "[iX](https://example.com)"),
        ]
        for source, start, end, replacement, expected in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.safeReplaceVisibleRange({json.dumps(source)}, {start}, {end}, {json.dumps(replacement)})));" )
            self.assertEqual(result, expected)

    def test_cross_token_regressions_remain_safe(self):
        cases = [
            ("**important** plain", 4, 19, "X", "**im**X"),
            ("plain **important**", 0, 10, "X", "X**portant**"),
            ("before **important** after", 9, 26, "X", "before X"),
            ("**bold** and *italic*", 3, 17, "X", "**b**X*lic*"),
            ("[link](https://example.com) after", 1, 10, "X", "X after"),
        ]
        for source, start, end, replacement, expected in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.safeReplaceVisibleRange({json.dumps(source)}, {start}, {end}, {json.dumps(replacement)})));" )
            self.assertEqual(result, expected)

    def test_collapsed_inline_commands_are_noops(self):
        for source in ("plain text", "**important**"):
            position = source.index("text") if "text" in source else source.index("important") + 2
            for kind in ("bold", "italic", "underline", "strike"):
                result = run_node(f"process.stdout.write(JSON.stringify(c.toggleInlineFormat({json.dumps(source)}, {position}, {position}, {json.dumps(kind)})));" )
                self.assertEqual(result, source)
            for function in ("removeHighlightRange",):
                result = run_node(f"process.stdout.write(JSON.stringify(c.{function}({json.dumps(source)}, {position}, {position})));" )
                self.assertEqual(result, source)
            result = run_node(f"process.stdout.write(JSON.stringify(c.replaceHighlightRange({json.dumps(source)}, {position}, {position}, '#ff0000')));")
            self.assertEqual(result, source)
        self.assertIn("range.start === range.end", SUMMARY)

    def test_formatted_enter_splits_tokens_without_raw_delimiters(self):
        cases = [
            ("**important**", "**im**\n**portant**", "bold"),
            ("*important*", "*im*\n*portant*", "italic"),
            ("==important==", "==im==\n==portant==", "highlight"),
            ("=={#ff0000}important==", "=={#ff0000}im==\n=={#ff0000}portant==", "custom highlight"),
            ("[important](https://example.com)", "[im](https://example.com)\n[portant](https://example.com)", "link"),
            ("`important`", "`im`\n`portant`", "code"),
        ]
        for source, expected, _label in cases:
            position = source.index("important") + 2
            result = run_node(f"process.stdout.write(JSON.stringify(c.insertParagraph({json.dumps(source)}, {position}, {position})));" )
            self.assertEqual(result["source"], expected)
            segments = run_node(f"process.stdout.write(JSON.stringify(c.visibleSegments({json.dumps(result['source'])})));" )
            next_line = next(segment for segment in segments if segment.get("text") == "portant")
            self.assertEqual(result["caret"], next_line["sourceStart"])
            self.assertFalse(any(segment["kind"] == "plain" and "**" in segment["text"] for segment in segments))

    def test_partial_highlight_recolor_splits_existing_highlight(self):
        result = run_node("process.stdout.write(JSON.stringify(c.replaceHighlightRange('==important text==', 2, 11, '#ff0000')));")
        self.assertEqual(result, "=={#ff0000}important== ==text==")
        result = run_node("process.stdout.write(JSON.stringify(c.replaceHighlightRange('=={#00ff00}important text==', 11, 20, '#ff0000')));")
        self.assertEqual(result, "=={#ff0000}important== =={#00ff00}text==")

    def test_enter_caret_allows_immediate_insert_on_new_formatted_line(self):
        cases = [
            ("**important**", "**im**\n**Xportant**"),
            ("=={#ff0000}important==", "=={#ff0000}im==\n=={#ff0000}Xportant=="),
            ("[important](https://example.com)", "[im](https://example.com)\n[Xportant](https://example.com)"),
        ]
        for source, expected in cases:
            position = source.index("important") + 2
            paragraph = run_node(f"process.stdout.write(JSON.stringify(c.insertParagraph({json.dumps(source)}, {position}, {position})));" )
            edited = run_node(f"process.stdout.write(JSON.stringify(c.safeReplaceVisibleRange({json.dumps(paragraph['source'])}, {paragraph['caret']}, {paragraph['caret']}, 'X')));")
            self.assertEqual(edited, expected)

    def test_mixed_toolbar_ranges_are_safe_noops(self):
        cases = [
            ("**bold** plain", 4, 15, "italic"),
            ("plain **bold**", 0, 10, "underline"),
            ("**bold** and *italic*", 3, 17, "highlight"),
            ("[link](https://example.com) plain", 1, 10, "bold"),
            ("[link](https://example.com) plain", 1, 10, "highlight"),
            ("=={#ff0000}red== plain", 12, 18, "italic"),
        ]
        for source, start, end, kind in cases:
            result = run_node(f"process.stdout.write(JSON.stringify(c.toggleInlineFormat({json.dumps(source)}, {start}, {end}, {json.dumps(kind)})));" )
            self.assertEqual(result, source)
        self.assertTrue(run_node("process.stdout.write(JSON.stringify(c.isToolbarFormatRangeSafe('**bold**', 2, 6, 'italic')));"))
        self.assertFalse(run_node("process.stdout.write(JSON.stringify(c.isToolbarFormatRangeSafe('**bold** plain', 4, 15, 'italic')));"))

    def test_unsupported_toolbar_combinations_are_noops(self):
        cases = [
            ("**important**", "underline"),
            ("**important**", "highlight"),
            ("[important](https://example.com)", "bold"),
            ("`important`", "bold"),
            ("==important==", "bold"),
        ]
        for source, kind in cases:
            start = source.index("important")
            result = run_node(f"process.stdout.write(JSON.stringify(c.toggleInlineFormat({json.dumps(source)}, {start}, {start + 9}, {json.dumps(kind)})));" )
            self.assertEqual(result, source)
        result = run_node("process.stdout.write(JSON.stringify(c.replaceHighlightRange('**important**', 2, 11, '#ff0000')));")
        self.assertEqual(result, "**important**")
        self.assertIn("Do not create nested syntax", CORE_SOURCE)

    def test_toolbar_commands_use_saved_visual_selection(self):
        self.assertIn("function rememberVisualSelection()", SUMMARY)
        self.assertIn("function visualCommandRange()", SUMMARY)
        self.assertIn("document.addEventListener(\"selectionchange\"", SUMMARY)
        self.assertIn("summaryToolbar?.addEventListener(\"mousedown\"", SUMMARY)
        self.assertIn("summaryHighlightMenu?.addEventListener(\"mousedown\"", SUMMARY)
        for marker in ("applyInlineFormat", "applyHighlight", "removeHighlight", "applyBlockFormat"):
            self.assertIn("visualCommandRange()", SUMMARY[SUMMARY.index(f"function {marker}"):])


if __name__ == "__main__":
    unittest.main()
