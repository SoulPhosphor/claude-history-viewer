"use strict";

// Main Summary editor. Markdown is the only document state. Visual mode renders
// source-mapped text leaves; edits patch only the changed source range instead of
// serializing the rendered DOM back to Markdown.
let _summaryConvId = null;
let _savedCondensed = "";
let _savedSummary = "";
let _condensedAuthor = "";
let _summaryAuthor = "";
// Starting swatches are centralized; edited swatches are saved author data.
// One palette serves every visual editor (Summary and Scratch Pads).
let _summaryPalette = ["default", "green", "blue", "purple"].map(
  (name) => themeValue(`--summary-palette-${name}`),
);

// ── Visual editors ──────────────────────────────────────────────────────────
// The engine below drives any number of visual Markdown editors with the same
// code: the Summary editor here and the Scratch Pad editor (scratchpads.js).
// Each editor is one of these records; `_editor` is the one the user is
// working in, set by every event that reaches an editor.
function createVisualEditor(parts) {
  return {
    visual: null,
    input: null,
    toolbar: null,
    highlightMenu: null,
    highlightButton: null,
    modeVisual: null,
    modeMarkdown: null,
    onChange: () => {},
    isOpen: () => false,
    onPaste: null,
    onLinkCommand: null,
    ...parts,
    mode: "visual",
    undo: [],
    redo: [],
    savedSelection: null,
  };
}
const _visualEditors = [];
let _editor = null;

function clearEditorHistory(ed) {
  ed.undo = [];
  ed.redo = [];
  ed.savedSelection = null;
}

function clearVisualHistory() {
  clearEditorHistory(summaryEditor);
}

const summaryBodyEl = $("summary-body");
const condensedSection = $("summary-condensed-section");
const condensedInput = $("condensed-summary-input");
const condensedRevertBtn = $("condensed-revert-btn");
const condensedSaveBtn = $("condensed-save-btn");
const summaryInput = $("summary-input");
const summaryRevertBtn = $("summary-revert-btn");
const summarySaveBtn = $("summary-save-btn");
const condensedAuthorRow = $("condensed-author-row");
const condensedAuthorLabel = $("condensed-author-label");
const summaryAuthorRow = $("summary-author-row");
const summaryAuthorLabel = $("summary-author-label");
const summaryUnsavedModal = $("summary-unsaved-modal");
const summaryUnsavedCancel = $("summary-unsaved-cancel");
const summaryUnsavedSave = $("summary-unsaved-save");
const summaryVisual = $("summary-visual");
const summaryToolbar = $("summary-toolbar");
const summaryModeVisual = $("summary-mode-visual");
const summaryModeMarkdown = $("summary-mode-markdown");
const summaryHighlightMenu = $("summary-highlight-menu");

const summaryEditor = createVisualEditor({
  visual: summaryVisual,
  input: summaryInput,
  toolbar: summaryToolbar,
  highlightMenu: summaryHighlightMenu,
  highlightButton: $("summary-highlight-button"),
  modeVisual: summaryModeVisual,
  modeMarkdown: summaryModeMarkdown,
  onChange: () => updateSummaryButtons(),
  isOpen: () => summaryIsOpen(),
});
_editor = summaryEditor;

function summaryIsOpen() {
  return summaryBodyEl && !summaryBodyEl.hidden;
}

function summaryMarkdown() {
  return summaryInput ? summaryInput.value : "";
}

function summaryHasUnsavedChanges() {
  if (!_summaryConvId) return false;
  const cDirty = condensedInput && !condensedSection.hidden && condensedInput.value !== _savedCondensed;
  return !!(cDirty || summaryMarkdown() !== _savedSummary);
}

function updateCondensedButtons() {
  if (!condensedRevertBtn || !condensedSaveBtn) return;
  const dirty = condensedInput.value !== _savedCondensed;
  condensedRevertBtn.disabled = !dirty;
  condensedSaveBtn.disabled = !dirty;
}

function updateSummaryButtons() {
  if (!summaryRevertBtn || !summarySaveBtn) return;
  const dirty = summaryMarkdown() !== _savedSummary;
  summaryRevertBtn.disabled = !dirty;
  summarySaveBtn.disabled = !dirty;
}

function updateSummaryCondensedVisibility() {
  if (condensedSection) condensedSection.hidden = !state.preferences.includeCondensedSummary;
}

function authorDisplayText(val) {
  if (val === "personal") return "Personal";
  if (val === "ai") return "AI";
  if (val === "collaborative") return "Collaborative";
  return "";
}

function updateSummaryAuthorLabels() {
  const show = state.preferences.showSummaryAuthor;
  for (const [row, label, value] of [[condensedAuthorRow, condensedAuthorLabel, _condensedAuthor], [summaryAuthorRow, summaryAuthorLabel, _summaryAuthor]]) {
    if (!row) continue;
    const text = authorDisplayText(value);
    row.hidden = !show || !text;
    if (label) {
      label.textContent = text;
      label.className = "summary-author-label";
      if (value) label.classList.add(`summary-author-${value}`);
    }
  }
}

function updateSummaryToggleIcon(isOpen) {
  const book = $("summary-icon-book");
  const forum = $("summary-icon-forum");
  const button = $("summary-toggle-btn");
  if (!book || !forum || !button) return;
  if (isOpen) {
    book.setAttribute("hidden", "");
    forum.removeAttribute("hidden");
    button.title = "Back to chat";
    button.setAttribute("aria-label", "Back to chat");
  } else {
    book.removeAttribute("hidden");
    forum.setAttribute("hidden", "");
    button.title = "Summary";
    button.setAttribute("aria-label", "Open summary");
  }
}

async function apiGetSummary(convId) {
  const r = await fetch(`/api/summaries/${encodeURIComponent(convId)}`);
  return r.json();
}

async function apiSaveSummary(convId, fields) {
  const r = await fetch(`/api/summaries/${encodeURIComponent(convId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return r.json();
}

function normalizePalette(value) {
  if (!Array.isArray(value)) return _summaryPalette;
  const colors = value.filter((x) => /^#[0-9a-f]{6}$/i.test(String(x))).map((x) => String(x).toLowerCase());
  return colors.length ? [...new Set(colors)].slice(0, 32) : _summaryPalette;
}

async function saveSummaryPalette() {
  state.preferences.summaryHighlightPalette = _summaryPalette;
  await saveUiPreferences({ summaryHighlightPalette: _summaryPalette });
}

function updatePaletteFromPicker(input) {
  const color = String(input.value || "").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) return;
  if (!_summaryPalette.includes(color)) _summaryPalette = [..._summaryPalette, color].slice(0, 32);
  refreshPaletteControls();
  saveSummaryPalette();
  applyHighlight(color);
}

// The Markdown of the editor being worked in.
function editorMarkdown() {
  return _editor?.input ? _editor.input.value : "";
}

function applyInlineFormat(type) {
  const range = visualCommandRange();
  if (!range || range.start === range.end) return;
  commitVisualSource(summaryCore.toggleInlineFormat(editorMarkdown(), range.start, range.end, type), range.start);
}

function applyHighlight(color) {
  const range = visualCommandRange();
  if (!range || range.start === range.end) return;
  const source = editorMarkdown();
  const token = summaryCore.inlineTokenForRange(source, range.start, range.end);
  if (token && token.kind !== "highlight") return;
  const next = summaryCore.replaceHighlightRange(source, range.start, range.end, color.toLowerCase() === "#fff3a3" /* persisted shorthand sentinel */ ? "" : color.toLowerCase());
  commitVisualSource(next, range.start);
  if (_editor.highlightMenu) _editor.highlightMenu.hidden = true;
}

function removeHighlight() {
  const range = visualCommandRange();
  if (!range || range.start === range.end) return;
  commitVisualSource(summaryCore.removeHighlightRange(editorMarkdown(), range.start, range.end), range.start);
  if (_editor.highlightMenu) _editor.highlightMenu.hidden = true;
}

function renderVisual(ed = _editor) {
  if (!ed?.visual) return;
  renderMarkdownSource(ed.input.value, ed.visual);
}

function setEditorMode(ed, mode) {
  ed.mode = mode;
  const visual = mode === "visual";
  if (ed.visual) ed.visual.hidden = !visual;
  if (ed.input) ed.input.hidden = visual;
  if (ed.toolbar) ed.toolbar.hidden = !visual;
  if (ed.modeVisual) ed.modeVisual.setAttribute("aria-pressed", String(visual));
  if (ed.modeMarkdown) ed.modeMarkdown.setAttribute("aria-pressed", String(!visual));
  if (visual) renderVisual(ed);
}

function setSummaryMode(mode) {
  setEditorMode(summaryEditor, mode);
}

async function saveCondensedSummary() {
  if (!_summaryConvId) return;
  const text = condensedInput.value;
  const res = await apiSaveSummary(_summaryConvId, { condensed_summary: text, author: "personal" });
  _savedCondensed = text;
  if (res.condensed_author) _condensedAuthor = res.condensed_author;
  updateCondensedButtons();
  updateSummaryAuthorLabels();
  refreshSummaryHintForConv(_summaryConvId);
}

async function saveMainSummary() {
  if (!_summaryConvId) return;
  const text = summaryMarkdown();
  const res = await apiSaveSummary(_summaryConvId, { summary: text, author: "personal" });
  _savedSummary = text;
  if (res.summary_author) _summaryAuthor = res.summary_author;
  updateSummaryButtons();
  updateSummaryAuthorLabels();
}

async function saveAllUnsaved() {
  if (!_summaryConvId) return;
  const fields = {};
  if (condensedInput && !condensedSection.hidden && condensedInput.value !== _savedCondensed) {
    fields.condensed_summary = condensedInput.value;
    _savedCondensed = condensedInput.value;
  }
  if (summaryMarkdown() !== _savedSummary) {
    fields.summary = summaryMarkdown();
    _savedSummary = summaryMarkdown();
  }
  if (Object.keys(fields).length) {
    fields.author = "personal";
    const res = await apiSaveSummary(_summaryConvId, fields);
    if (res.condensed_author) _condensedAuthor = res.condensed_author;
    if (res.summary_author) _summaryAuthor = res.summary_author;
  }
  updateCondensedButtons();
  updateSummaryButtons();
  updateSummaryAuthorLabels();
  refreshSummaryHintForConv(_summaryConvId);
}

function refreshSummaryHintForConv(convId) {
  const hasContent = !!(_savedCondensed && _savedCondensed.trim());
  document.querySelectorAll(`.conv-summary-hint[data-conv-id="${CSS.escape(convId)}"]`).forEach((el) => {
    if (!hasContent || !state.preferences.showSummaryHints) el.remove();
  });
  if (hasContent && state.preferences.showSummaryHints) {
    document.querySelectorAll(`.conv-item[data-id="${CSS.escape(convId)}"], .folder-conv-item[data-id="${CSS.escape(convId)}"]`).forEach((row) => {
      if (!row.querySelector(".conv-summary-hint")) {
        const hintEl = document.createElement("span");
        hintEl.className = "conv-summary-hint";
        hintEl.textContent = "Summary";
        hintEl.dataset.convId = convId;
        prepareSummaryHint(hintEl);
        const anchor = row.querySelector(".conv-top-row") || row.querySelector(".folder-conv-title");
        if (anchor) anchor.after(hintEl); else row.appendChild(hintEl);
      }
    });
  }
}

async function openSummaryForConversation(convId) {
  if (!convId) return;
  if (typeof notesNavigationGuard === "function") {
    const canLeaveNotes = await notesNavigationGuard({ endVisit: false });
    if (!canLeaveNotes) return;
  }
  if (_summaryConvId && _summaryConvId !== convId && summaryHasUnsavedChanges()) {
    const result = await openSummaryUnsavedModal();
    if (result === "cancel") return;
    if (result === "save") await saveAllUnsaved();
  }
  if (state.activeId !== convId) await openConversation(convId, findConvItemEl(convId));
  _summaryConvId = convId;
  clearVisualHistory();
  if (messagesEl) messagesEl.hidden = true;
  if (summaryBodyEl) summaryBodyEl.hidden = false;
  updateSummaryCondensedVisibility();
  updateSummaryToggleIcon(true);
  const data = await apiGetSummary(convId);
  _savedCondensed = data.condensed_summary || "";
  _savedSummary = data.summary || "";
  _condensedAuthor = data.condensed_author || "";
  _summaryAuthor = data.summary_author || "";
  if (condensedInput) condensedInput.value = _savedCondensed;
  if (summaryInput) summaryInput.value = _savedSummary;
  try {
    const prefs = await apiPreferences();
    _summaryPalette = normalizePalette(prefs.preferences?.summaryHighlightPalette);
  } catch (_) {
    _summaryPalette = normalizePalette(_summaryPalette);
  }
  refreshPaletteControls(summaryEditor);
  setSummaryMode("visual");
  updateCondensedButtons();
  updateSummaryButtons();
  updateSummaryAuthorLabels();
}

function closeSummaryPanel() {
  _summaryConvId = null;
  clearVisualHistory();
  if (summaryBodyEl) summaryBodyEl.hidden = true;
  if (messagesEl) messagesEl.hidden = false;
  updateSummaryToggleIcon(false);
}

function returnFromSummaryToChat() {
  closeSummaryPanel();
}

let _unsavedResolve = null;
function openSummaryUnsavedModal() {
  return new Promise((resolve) => {
    _unsavedResolve = resolve;
    if (summaryUnsavedModal) summaryUnsavedModal.hidden = false;
  });
}
function closeSummaryUnsavedModal(result) {
  if (summaryUnsavedModal) summaryUnsavedModal.hidden = true;
  if (_unsavedResolve) { _unsavedResolve(result); _unsavedResolve = null; }
}
summaryUnsavedCancel?.addEventListener("click", () => closeSummaryUnsavedModal("cancel"));
summaryUnsavedSave?.addEventListener("click", () => closeSummaryUnsavedModal("save"));
summaryUnsavedModal?.addEventListener("click", (e) => { if (e.target === summaryUnsavedModal) closeSummaryUnsavedModal("cancel"); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && summaryUnsavedModal && !summaryUnsavedModal.hidden) closeSummaryUnsavedModal("cancel");
});

async function summaryNavigationGuard(proceedFn) {
  if (summaryHasUnsavedChanges()) {
    const result = await openSummaryUnsavedModal();
    if (result === "cancel") return false;
    if (result === "save") await saveAllUnsaved();
  }
  closeSummaryPanel();
  await proceedFn();
  return true;
}

window.addEventListener("beforeunload", (e) => {
  if (summaryHasUnsavedChanges()) { e.preventDefault(); e.returnValue = ""; }
});

// ── Safe source-mapped visual editing overrides ─────────────────────────────
// These helpers use explicit source segments and beforeinput. The browser is
// never asked to serialize a contenteditable DOM back into Markdown. They act
// on `_editor`, the editor the current event belongs to.
const summaryCore = window.SummaryEditorCore;

function mappedSourceRange(node) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element?.dataset?.sourceStart) return null;
  return { start: Number(element.dataset.sourceStart), end: Number(element.dataset.sourceEnd) };
}

function summarySourceBoundary(node, offset) {
  if (node.nodeType === Node.TEXT_NODE) {
    const range = mappedSourceRange(node);
    return range ? range.start + Math.min(offset, node.nodeValue.length) : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const own = mappedSourceRange(node);
  const children = [...node.childNodes];
  if (!children.length) return offset ? own?.end ?? null : own?.start ?? null;
  if (offset <= 0) return summarySourceBoundary(children[0], 0) ?? own?.start ?? null;
  if (offset >= children.length) {
    const last = children[children.length - 1];
    return summarySourceBoundary(last, last.nodeType === Node.TEXT_NODE ? last.nodeValue.length : last.childNodes.length) ?? own?.end ?? null;
  }
  const before = children[offset - 1];
  const after = children[offset];
  return summarySourceBoundary(before, before.nodeType === Node.TEXT_NODE ? before.nodeValue.length : before.childNodes.length)
    ?? summarySourceBoundary(after, 0)
    ?? own?.start
    ?? null;
}

function summarySourcePoint(node, offset) {
  const point = summarySourceBoundary(node, offset);
  return point == null ? 0 : point;
}

function sourceRangeFromSelection(ed = _editor) {
  const selection = window.getSelection?.();
  if (!ed?.visual || !selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!ed.visual.contains(range.startContainer) || !ed.visual.contains(range.endContainer)) return null;
  const start = summarySourcePoint(range.startContainer, range.startOffset);
  const end = summarySourcePoint(range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function rememberVisualSelection() {
  const range = sourceRangeFromSelection();
  if (range) _editor.savedSelection = range;
  return range;
}

function visualCommandRange() {
  return sourceRangeFromSelection() || _editor.savedSelection;
}

function appendMappedSegment(parent, segment) {
  if (segment.kind === "newline") {
    const br = document.createElement("br");
    br.dataset.sourceStart = String(segment.sourceStart);
    br.dataset.sourceEnd = String(segment.sourceEnd);
    parent.appendChild(br);
    return;
  }
  if (["boldItalic", "boldStrike", "italicStrike"].includes(segment.kind)) {
    const outer = document.createElement(segment.kind.startsWith("italic") ? "em" : segment.kind.startsWith("bold") ? "strong" : "del");
    const inner = document.createElement(segment.kind.endsWith("Strike") ? "del" : segment.kind === "boldItalic" ? "em" : "strong");
    for (const element of [outer, inner]) {
      element.dataset.sourceStart = String(segment.sourceStart);
      element.dataset.sourceEnd = String(segment.sourceEnd);
    }
    inner.textContent = segment.text;
    outer.appendChild(inner);
    parent.appendChild(outer);
    return;
  }
  const tags = { bold: "strong", italic: "em", underline: "u", strike: "del", highlight: "mark", code: "code", link: "span" };
  const element = document.createElement(tags[segment.kind] || "span");
  // Map the visible leaf to its content range, not the surrounding Markdown
  // delimiters. Token boundaries remain available for diagnostics/future use.
  element.dataset.sourceStart = String(segment.sourceStart);
  element.dataset.sourceEnd = String(segment.sourceEnd);
  element.dataset.tokenStart = String(segment.tokenStart ?? segment.sourceStart);
  element.dataset.tokenEnd = String(segment.tokenEnd ?? segment.sourceEnd);
  element.textContent = segment.text;
  if (segment.kind === "highlight" && segment.color) element.style.setProperty("--summary-inline-highlight-color", segment.color);
  if (segment.kind === "link") {
    // The destination rides on the leaf so a click can follow or edit it.
    // Scratch Pads draw these as links; Summary keeps its plain appearance.
    element.className = "visual-link";
    element.dataset.href = summaryCore.linkTarget(segment);
    element.title = "Markdown link";
  }
  parent.appendChild(element);
}

function renderMarkdownSource(source, root) {
  root.replaceChildren();
  for (const line of summaryCore.sourceLines(source)) {
    const block = document.createElement("div");
    block.className = "summary-visual-line";
    const content = summaryCore.visibleContent(line);
    block.dataset.sourceStart = String(line.start);
    block.dataset.sourceEnd = String(line.end);
    const wrapper = document.createElement(content.block === "heading" ? `h${content.level}` : content.block === "bullet" ? "li" : content.block === "numbered" ? "li" : "p");
    if (content.block === "bullet" || content.block === "numbered") {
      const list = document.createElement(content.block === "bullet" ? "ul" : "ol");
      wrapper.dataset.sourceStart = String(content.start);
      wrapper.dataset.sourceEnd = String(line.end);
      for (const segment of summaryCore.inlineSegments(content.text, content.start)) appendMappedSegment(wrapper, segment);
      list.appendChild(wrapper);
      block.appendChild(list);
    } else {
      wrapper.dataset.sourceStart = String(content.start);
      wrapper.dataset.sourceEnd = String(line.end);
      for (const segment of summaryCore.inlineSegments(content.text, content.start)) appendMappedSegment(wrapper, segment);
      block.appendChild(wrapper);
    }
    if (line.newlineEnd > line.newlineStart) {
      const br = document.createElement("br");
      br.dataset.sourceStart = String(line.newlineStart);
      br.dataset.sourceEnd = String(line.newlineEnd);
      block.appendChild(br);
    } else if (!content.text) {
      // An empty last line still needs a line box for the caret to sit in.
      wrapper.appendChild(document.createElement("br"));
    }
    root.appendChild(block);
  }
}

function setVisualCaret(sourcePosition, ed = _editor) {
  if (!ed?.visual) return;
  const walker = document.createTreeWalker(ed.visual, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const leaf = node.parentElement.closest("[data-source-start]");
    if (!leaf) continue;
    const start = Number(leaf.dataset.sourceStart);
    const end = Number(leaf.dataset.sourceEnd);
    if (sourcePosition >= start && sourcePosition <= end) {
      const range = document.createRange();
      range.setStart(node, Math.min(node.nodeValue.length, sourcePosition - start));
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }
  // An empty line has no text to hold the caret. Put it on that line: before
  // the line's own break, or inside the last line's placeholder.
  for (const block of ed.visual.querySelectorAll(".summary-visual-line")) {
    const wrapper = block.querySelector("p, li, h1, h2, h3");
    if (!wrapper || wrapper.textContent) continue;
    if (sourcePosition < Number(wrapper.dataset.sourceStart) || sourcePosition > Number(wrapper.dataset.sourceEnd)) continue;
    const range = document.createRange();
    const lineBreak = [...block.children].find((child) => child.tagName === "BR");
    if (lineBreak) range.setStartBefore(lineBreak);
    else range.setStart(wrapper, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
}

function commitVisualSource(source, caret, recordHistory = true) {
  const ed = _editor;
  const previous = ed.input.value;
  if (source === previous) return;
  if (recordHistory) ed.undo.push(previous);
  ed.redo = [];
  ed.input.value = source;
  renderVisual(ed);
  ed.onChange();
  setVisualCaret(caret, ed);
  ed.savedSelection = { start: caret, end: caret };
}

function restoreVisualSource(source) {
  const ed = _editor;
  ed.savedSelection = null;
  ed.input.value = source;
  renderVisual(ed);
  ed.onChange();
}

function stepVisualHistory(inputType) {
  const ed = _editor;
  const from = inputType === "historyUndo" ? ed.undo : ed.redo;
  const to = inputType === "historyUndo" ? ed.redo : ed.undo;
  if (!from.length) return;
  to.push(ed.input.value);
  restoreVisualSource(from.pop());
}

function handleVisualBeforeInput(event) {
  if (!_editor?.visual || !_editor.input) return;
  const inputType = event.inputType || "";
  if (!summaryCore.isSupportedVisualInputType(inputType)) {
    event.preventDefault();
    return;
  }
  const source = editorMarkdown();
  if (inputType === "historyUndo" || inputType === "historyRedo") {
    event.preventDefault();
    stepVisualHistory(inputType);
    return;
  }
  const range = sourceRangeFromSelection();
  if (!range) { event.preventDefault(); return; }
  let start = range.start;
  let end = range.end;
  let replacement = event.data || "";
  if (inputType === "insertFromPaste" || inputType === "insertFromPasteAsQuotation" || inputType === "insertFromDrop") {
    replacement = event.data || event.dataTransfer?.getData("text/plain") || "";
    // An editor may turn a pasted link into a formatted one (Scratch Pads).
    if (_editor.onPaste && _editor.onPaste(replacement, { start, end })) {
      event.preventDefault();
      return;
    }
  } else if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
    event.preventDefault();
    const paragraph = summaryCore.insertParagraph(source, start, end);
    commitVisualSource(paragraph.source, paragraph.caret);
    return;
  } else if (inputType.startsWith("delete")) {
    if (start === end) {
      const backward = inputType === "deleteContentBackward" || inputType === "deleteWordBackward";
      const forward = inputType === "deleteContentForward" || inputType === "deleteWordForward";
      const joined = (backward || forward) && summaryCore.deleteLineBreak(source, start, backward ? "backward" : "forward");
      if (joined) {
        event.preventDefault();
        commitVisualSource(joined.source, joined.caret);
        return;
      }
      const segments = summaryCore.visibleSegments(source).filter((segment) => segment.kind !== "newline");
      const segment = segments.find((item) => start >= item.sourceStart && start <= item.sourceEnd);
      if (!segment) { event.preventDefault(); return; }
      if (inputType === "deleteContentBackward" || inputType === "deleteWordBackward") {
        if (start <= segment.sourceStart) { event.preventDefault(); return; }
        start = inputType === "deleteWordBackward" ? Math.max(segment.sourceStart, source.lastIndexOf(" ", start - 1) + 1) : start - 1;
      } else if (inputType === "deleteContentForward" || inputType === "deleteWordForward") {
        if (start >= segment.sourceEnd) { event.preventDefault(); return; }
        end = inputType === "deleteWordForward" ? Math.min(segment.sourceEnd, source.indexOf(" ", start) < 0 ? segment.sourceEnd : source.indexOf(" ", start)) : start + 1;
      }
    }
    replacement = "";
  }

  event.preventDefault();
  const placed = summaryCore.safeReplaceVisibleRangeAt(source, start, end, replacement);
  commitVisualSource(placed.source, placed.at + replacement.length);
}

function applyBlockFormat(type) {
  const range = visualCommandRange();
  if (!range) return;
  const next = summaryCore.applyBlockFormat(editorMarkdown(), range.start, range.end, type);
  commitVisualSource(next, range.start);
}

function refreshPaletteControls(ed = _editor) {
  const palette = ed?.highlightMenu?.querySelector(".summary-palette");
  if (!palette) return;
  palette.replaceChildren();
  for (const color of _summaryPalette) {
    const item = document.createElement("span");
    item.className = "summary-palette-item";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "summary-palette-swatch";
    use.style.setProperty("--summary-swatch-color", color);
    use.title = `Use highlight ${color}`;
    use.setAttribute("aria-label", `Use highlight ${color}`);
    use.addEventListener("click", () => applyHighlight(color));
    const edit = document.createElement("input");
    edit.type = "color";
    edit.value = color;
    edit.className = "summary-palette-edit";
    edit.title = `Change palette color ${color}`;
    edit.setAttribute("aria-label", `Change palette color ${color}`);
    edit.addEventListener("input", () => {
      const next = edit.value.toLowerCase();
      _summaryPalette = _summaryPalette.map((entry) => entry === color ? next : entry);
      _summaryPalette = [...new Set(_summaryPalette)].slice(0, 32);
      refreshPaletteControls(ed);
      saveSummaryPalette();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "summary-palette-remove-one";
    remove.textContent = "×";
    remove.title = `Remove ${color} from palette`;
    remove.setAttribute("aria-label", `Remove ${color} from palette`);
    remove.addEventListener("click", () => {
      _summaryPalette = _summaryPalette.filter((entry) => entry !== color);
      refreshPaletteControls(ed);
      saveSummaryPalette();
    });
    item.append(use, edit, remove);
    palette.appendChild(item);
  }
}

// Wire one visual editor's own elements to the shared engine. Every handler
// first makes this editor the active one, so commands always act on the
// editor the user is working in.
function attachVisualEditor(ed) {
  _visualEditors.push(ed);
  const use = (fn) => (event) => { _editor = ed; return fn(event); };
  const preserveSelection = use(() => { rememberVisualSelection(); });

  ed.visual?.addEventListener("beforeinput", use(handleVisualBeforeInput));
  // Undo / Redo keys always reach this editor's own history, also when the
  // browser has no native history to report through beforeinput.
  ed.visual?.addEventListener("keydown", use((event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" || key === "y") {
      event.preventDefault();
      stepVisualHistory(key === "y" || event.shiftKey ? "historyRedo" : "historyUndo");
    }
  }));
  ed.toolbar?.addEventListener("mousedown", preserveSelection);
  ed.highlightMenu?.addEventListener("mousedown", preserveSelection);

  ed.input?.addEventListener("input", use(() => {
    clearEditorHistory(ed);
    ed.onChange();
    if (ed.mode === "markdown") renderVisual(ed);
  }));
  ed.modeVisual?.addEventListener("click", () => setEditorMode(ed, "visual"));
  ed.modeMarkdown?.addEventListener("click", () => setEditorMode(ed, "markdown"));

  ed.toolbar?.addEventListener("click", use((e) => {
    const button = e.target.closest("button[data-format]");
    if (!button) return;
    e.preventDefault();
    const format = button.dataset.format;
    if (["bold", "italic", "underline", "strike"].includes(format)) applyInlineFormat(format);
    else if (format === "link") ed.onLinkCommand?.(button);
    else applyBlockFormat(format);
  }));
  ed.toolbar?.querySelector("select[data-format]")?.addEventListener("change", use((e) => {
    applyBlockFormat(e.target.value);
    e.target.value = "normal";
  }));

  const customPicker = ed.highlightMenu?.querySelector(".summary-palette-picker");
  if (customPicker) customPicker.value = themeValue("--summary-palette-default");
  customPicker?.addEventListener("input", use((e) => updatePaletteFromPicker(e.target)));
  ed.highlightMenu?.querySelector(".summary-palette-remove")?.addEventListener("click", use(removeHighlight));
  ed.highlightButton?.addEventListener("click", use((e) => {
    e.preventDefault();
    if (ed.highlightMenu) ed.highlightMenu.hidden = !ed.highlightMenu.hidden;
    refreshPaletteControls(ed);
  }));
}

// The selection is remembered for whichever open editor holds it, so a
// toolbar command still knows its range after focus moves to the toolbar.
document.addEventListener("selectionchange", () => {
  for (const ed of _visualEditors) {
    if (!ed.isOpen() || !sourceRangeFromSelection(ed)) continue;
    _editor = ed;
    rememberVisualSelection();
    return;
  }
});

document.addEventListener("click", (e) => {
  for (const ed of _visualEditors) {
    const menu = ed.highlightMenu;
    if (menu && !menu.hidden && !menu.contains(e.target) && !ed.highlightButton?.contains(e.target)) menu.hidden = true;
  }
});

attachVisualEditor(summaryEditor);

summaryRevertBtn?.addEventListener("click", () => {
  clearVisualHistory();
  summaryInput.value = _savedSummary;
  renderVisual(summaryEditor);
  updateSummaryButtons();
});
condensedInput?.addEventListener("input", updateCondensedButtons);
condensedRevertBtn?.addEventListener("click", () => { condensedInput.value = _savedCondensed; updateCondensedButtons(); });
condensedSaveBtn?.addEventListener("click", () => saveCondensedSummary());
summarySaveBtn?.addEventListener("click", () => saveMainSummary());


$("summary-toggle-btn")?.addEventListener("click", async () => {
  if (summaryIsOpen()) {
    if (summaryHasUnsavedChanges()) {
      const result = await openSummaryUnsavedModal();
      if (result === "cancel") return;
      if (result === "save") await saveAllUnsaved();
    }
    returnFromSummaryToChat();
  } else if (state.activeId) openSummaryForConversation(state.activeId);
});

let _hintPopup = null;
let _hintHideTimer = null;
let _hintLoadAbort = null;
let _hintAnchor = null;
function createSummaryPopup() {
  const popup = document.createElement("div");
  popup.className = "summary-hint-popup";
  popup.id = "summary-hint-popup";
  popup.setAttribute("role", "tooltip");
  popup.hidden = true;
  document.body.appendChild(popup);
  popup.addEventListener("mouseenter", () => clearTimeout(_hintHideTimer));
  popup.addEventListener("mouseleave", hideSummaryPopup);
  return popup;
}
function showSummaryPopup(anchorEl, text) {
  if (!_hintPopup) _hintPopup = createSummaryPopup();
  _hintPopup.textContent = text;
  if (_hintAnchor !== anchorEl) _hintAnchor?.removeAttribute("aria-describedby");
  _hintAnchor = anchorEl;
  anchorEl.setAttribute("aria-describedby", _hintPopup.id);
  _hintPopup.hidden = false;
  clearTimeout(_hintHideTimer);
  const inset = themePixels("--popover-safe-inset");
  const gap = themePixels("--popover-gap");
  const r = anchorEl.getBoundingClientRect();
  const pw = _hintPopup.offsetWidth;
  const ph = _hintPopup.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - inset);
  let top = r.bottom + gap;
  if (top + ph > window.innerHeight - inset) top = r.top - ph - gap;
  _hintPopup.style.left = `${Math.max(inset, left)}px`;
  _hintPopup.style.top = `${Math.max(inset, top)}px`;
}
function hideSummaryPopup() {
  clearTimeout(_hintHideTimer);
  _hintHideTimer = setTimeout(() => {
    if (_hintPopup) _hintPopup.hidden = true;
    _hintAnchor?.removeAttribute("aria-describedby");
    _hintAnchor = null;
    if (_hintLoadAbort) { _hintLoadAbort.abort(); _hintLoadAbort = null; }
  }, 200);
}
async function previewSummaryHint(e) {
  const hint = e.target.closest(".conv-summary-hint");
  if (!hint || !hint.dataset.convId) return;
  clearTimeout(_hintHideTimer);
  if (_hintLoadAbort) _hintLoadAbort.abort();
  const controller = new AbortController();
  _hintLoadAbort = controller;
  try {
    const data = await apiGetSummary(hint.dataset.convId);
    if (_hintLoadAbort !== controller || controller.signal.aborted) return;
    const text = (data.condensed_summary || "").trim();
    if (text) showSummaryPopup(hint, text);
  } catch (_) {}
}
document.addEventListener("mouseover", previewSummaryHint);
document.addEventListener("focusin", previewSummaryHint);
document.addEventListener("focusout", (e) => { if (e.target.closest(".conv-summary-hint")) hideSummaryPopup(); });
document.addEventListener("mouseout", (e) => {
  const hint = e.target.closest(".conv-summary-hint");
  if (hint && document.activeElement !== hint) hideSummaryPopup();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && _hintPopup && !_hintPopup.hidden) {
    e.preventDefault();
    e.stopImmediatePropagation();
    hideSummaryPopup();
  }
}, true);
