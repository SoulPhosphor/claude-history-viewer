"use strict";

// Main Summary editor. Markdown is the only document state. Visual mode renders
// source-mapped text leaves; edits patch only the changed source range instead of
// serializing the rendered DOM back to Markdown.
let _summaryConvId = null;
let _savedCondensed = "";
let _savedSummary = "";
let _condensedAuthor = "";
let _summaryAuthor = "";
let _summaryMode = "visual";
let _summaryVisualBeforeEdit = "";
let _summaryPalette = ["#fff3a3", "#c9f7c5", "#c9e7ff", "#f5c9ff"];

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

function refreshPaletteControls() {
  if (!summaryHighlightMenu) return;
  summaryHighlightMenu.querySelectorAll(".summary-palette-swatch").forEach((el) => el.remove());
  for (const color of _summaryPalette) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "summary-palette-swatch";
    button.dataset.color = color;
    button.style.setProperty("--summary-swatch-color", color);
    button.title = `Highlight ${color}`;
    button.setAttribute("aria-label", `Highlight with ${color}`);
    button.addEventListener("click", () => applyHighlight(color));
    summaryHighlightMenu.insertBefore(button, summaryHighlightMenu.querySelector(".summary-palette-custom"));
  }
}

function updatePaletteFromPicker(input) {
  const color = String(input.value || "").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) return;
  if (!_summaryPalette.includes(color)) _summaryPalette = [..._summaryPalette, color].slice(0, 32);
  refreshPaletteControls();
  saveSummaryPalette();
  applyHighlight(color);
}

function sourceRangeFromSelection() {
  if (!summaryVisual || !window.getSelection) return null;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!summaryVisual.contains(range.startContainer) || !summaryVisual.contains(range.endContainer)) return null;
  const point = (node, offset) => {
    const leaf = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const span = leaf?.closest?.("[data-source-start]");
    if (!span) return null;
    const textOffset = node.nodeType === Node.TEXT_NODE ? offset : 0;
    return Number(span.dataset.sourceStart) + textOffset;
  };
  const start = point(range.startContainer, range.startOffset);
  const end = point(range.endContainer, range.endOffset);
  if (start == null || end == null || start === end) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function replaceSourceRange(start, end, replacement) {
  const source = summaryMarkdown();
  summaryInput.value = source.slice(0, start) + replacement + source.slice(end);
  renderVisual();
  updateSummaryButtons();
}

function wrapSelected(prefix, suffix, removePattern) {
  const range = sourceRangeFromSelection();
  if (!range) return;
  const source = summaryMarkdown();
  const selected = source.slice(range.start, range.end);
  const clean = removePattern ? selected.replace(removePattern, "$1") : selected;
  if (clean !== selected) replaceSourceRange(range.start, range.end, clean);
  else replaceSourceRange(range.start, range.end, prefix + selected + suffix);
}

function applyInlineFormat(type) {
  const formats = {
    bold: ["**", "**", /^\*\*(.*)\*\*$/s],
    italic: ["*", "*", /^\*(.*)\*$/s],
    underline: ["++", "++", /^\+\+(.*)\+\+$/s],
    strike: ["~~", "~~", /^~~(.*)~~$/s],
  };
  const format = formats[type];
  if (format) wrapSelected(format[0], format[1], format[2]);
}

function applyHighlight(color) {
  const range = sourceRangeFromSelection();
  if (!range) return;
  const source = summaryMarkdown();
  const selected = source.slice(range.start, range.end);
  const escaped = color.toLowerCase() === "#fff3a3" ? selected : `{${color}}${selected}`;
  replaceSourceRange(range.start, range.end, `==${escaped}==`);
  if (summaryHighlightMenu) summaryHighlightMenu.hidden = true;
}

function removeHighlight() {
  const range = sourceRangeFromSelection();
  if (!range) return;
  const selected = summaryMarkdown().slice(range.start, range.end);
  const clean = selected.replace(/^==(?:\{#[0-9a-f]{6}\})?(.*?)==$/is, "$1");
  replaceSourceRange(range.start, range.end, clean);
  if (summaryHighlightMenu) summaryHighlightMenu.hidden = true;
}

function applyBlockFormat(type) {
  const range = sourceRangeFromSelection();
  if (!range) return;
  const source = summaryMarkdown();
  const blockStart = source.lastIndexOf("\n", range.start - 1) + 1;
  const blockEndAt = source.indexOf("\n", range.end);
  const blockEnd = blockEndAt < 0 ? source.length : blockEndAt;
  const block = source.slice(blockStart, blockEnd);
  let replacement = block;
  if (type === "normal") replacement = block.replace(/^#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+[.)]\s+/, "");
  if (type === "heading1") replacement = `# ${block.replace(/^#{1,6}\s+/, "")}`;
  if (type === "heading2") replacement = `## ${block.replace(/^#{1,6}\s+/, "")}`;
  if (type === "heading3") replacement = `### ${block.replace(/^#{1,6}\s+/, "")}`;
  if (type === "bullet") replacement = block.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "- ");
  if (type === "numbered") replacement = block.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "1. ");
  replaceSourceRange(blockStart, blockEnd, replacement);
}

function visibleText(source) {
  const root = document.createElement("div");
  renderMarkdownSource(source, root);
  return root.textContent || "";
}

function sourcePositionForVisibleOffset(root, visibleOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = visibleOffset;
  let node;
  while ((node = walker.nextNode())) {
    if (remaining <= node.nodeValue.length) {
      const span = node.parentElement.closest("[data-source-start]");
      return Number(span.dataset.sourceStart) + remaining;
    }
    remaining -= node.nodeValue.length;
  }
  const leaves = root.querySelectorAll("[data-source-end]");
  return leaves.length ? Number(leaves[leaves.length - 1].dataset.sourceEnd) : 0;
}

function patchVisualText() {
  if (!summaryVisual) return;
  const before = _summaryVisualBeforeEdit;
  const after = summaryVisual.textContent || "";
  if (before === after) return;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const source = summaryMarkdown();
  const sourceStart = sourcePositionForVisibleOffset(summaryVisual, start);
  const sourceEnd = sourcePositionForVisibleOffset(summaryVisual, beforeEnd);
  replaceSourceRange(sourceStart, sourceEnd, after.slice(start, afterEnd));
}

function appendLeaf(root, text, start, end, tag = "span") {
  const el = document.createElement(tag);
  el.dataset.sourceStart = String(start);
  el.dataset.sourceEnd = String(end);
  el.textContent = text;
  root.appendChild(el);
  return el;
}

function renderInline(source, root, offset) {
  const pattern = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|\+\+[^+\n]+\+\+|==(?:\{#[0-9a-fA-F]{6}\})?[^=\n]+==|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\((?:https?:|mailto:|\/|#|\.\.?\/)[^)]+\))/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) appendLeaf(root, source.slice(cursor, match.index), offset + cursor, offset + match.index);
    const raw = match[0];
    let tag = "span";
    let text = raw;
    if (raw.startsWith("**")) { tag = "strong"; text = raw.slice(2, -2); }
    else if (raw.startsWith("~~")) { tag = "del"; text = raw.slice(2, -2); }
    else if (raw.startsWith("++")) { tag = "u"; text = raw.slice(2, -2); }
    else if (raw.startsWith("==")) {
      tag = "mark";
      const color = raw.match(/^==\{(#[0-9a-fA-F]{6})\}/)?.[1];
      text = raw.replace(/^==(?:\{#[0-9a-fA-F]{6}\})?/, "").slice(0, -2);
    } else if (raw.startsWith("*") && raw.endsWith("*")) { tag = "em"; text = raw.slice(1, -1); }
    else if (raw.startsWith("`") && raw.endsWith("`")) { tag = "code"; text = raw.slice(1, -1); }
    else if (raw.startsWith("[")) { tag = "span"; text = raw.slice(1, raw.indexOf("](")); }
    const el = appendLeaf(root, text, offset + match.index, offset + match.index + raw.length, tag);
    if (colorFromHighlight(raw)) el.style.setProperty("--summary-inline-highlight-color", colorFromHighlight(raw));
    cursor = match.index + raw.length;
  }
  if (cursor < source.length) appendLeaf(root, source.slice(cursor), offset + cursor, offset + source.length);
}

function colorFromHighlight(raw) {
  return raw.match(/^==\{(#[0-9a-fA-F]{6})\}/)?.[1] || "";
}

function renderMarkdownSource(source, root) {
  root.replaceChildren();
  const lines = source.split("\n");
  let offset = 0;
  for (const line of lines) {
    const block = document.createElement("div");
    block.className = "summary-visual-line";
    block.dataset.sourceStart = String(offset);
    block.dataset.sourceEnd = String(offset + line.length);
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`);
      h.dataset.sourceStart = String(offset + heading[1].length + 1);
      h.dataset.sourceEnd = String(offset + line.length);
      renderInline(heading[2], h, offset + heading[1].length + 1);
      block.appendChild(h);
    } else if (bullet || numbered) {
      const list = document.createElement(numbered ? "ol" : "ul");
      const item = document.createElement("li");
      const content = (bullet || numbered)[numbered ? 2 : 3];
      const contentStart = offset + line.indexOf(content);
      item.dataset.sourceStart = String(contentStart);
      item.dataset.sourceEnd = String(offset + line.length);
      renderInline(content, item, contentStart);
      list.appendChild(item);
      block.appendChild(list);
    } else if (line) {
      const p = document.createElement("p");
      renderInline(line, p, offset);
      block.appendChild(p);
    } else {
      block.appendChild(document.createElement("br"));
    }
    root.appendChild(block);
    offset += line.length + 1;
  }
}

function renderVisual() {
  if (!summaryVisual) return;
  renderMarkdownSource(summaryMarkdown(), summaryVisual);
  _summaryVisualBeforeEdit = summaryVisual.textContent || "";
}

function setSummaryMode(mode) {
  _summaryMode = mode;
  const visual = mode === "visual";
  if (summaryVisual) summaryVisual.hidden = !visual;
  if (summaryInput) summaryInput.hidden = visual;
  if (summaryToolbar) summaryToolbar.hidden = !visual;
  if (summaryModeVisual) summaryModeVisual.setAttribute("aria-pressed", String(visual));
  if (summaryModeMarkdown) summaryModeMarkdown.setAttribute("aria-pressed", String(!visual));
  if (visual) renderVisual();
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
        const anchor = row.querySelector(".conv-top-row") || row.querySelector(".folder-conv-title");
        if (anchor) anchor.after(hintEl); else row.appendChild(hintEl);
      }
    });
  }
}

async function openSummaryForConversation(convId) {
  if (!convId) return;
  if (_summaryConvId && _summaryConvId !== convId && summaryHasUnsavedChanges()) {
    const result = await openSummaryUnsavedModal();
    if (result === "cancel") return;
    if (result === "save") await saveAllUnsaved();
  }
  if (state.activeId !== convId) await openConversation(convId, findConvItemEl(convId));
  _summaryConvId = convId;
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
  refreshPaletteControls();
  setSummaryMode("visual");
  updateCondensedButtons();
  updateSummaryButtons();
  updateSummaryAuthorLabels();
}

function closeSummaryPanel() {
  _summaryConvId = null;
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
// never asked to serialize a contenteditable DOM back into Markdown.
const summaryCore = window.SummaryEditorCore;

function summarySourcePoint(node, offset) {
  const leaf = node.nodeType === Node.TEXT_NODE ? node.parentElement?.closest("[data-source-start]") : node.closest?.("[data-source-start]");
  if (leaf) {
    if (leaf.tagName === "BR") return Number(offset ? leaf.dataset.sourceEnd : leaf.dataset.sourceStart);
    return Number(leaf.dataset.sourceStart) + Math.min(offset, (node.textContent || "").length);
  }
  const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const children = [...(parent?.childNodes || [])];
  const child = children[offset] || children[offset - 1];
  const mapped = child?.nodeType === Node.TEXT_NODE ? child.parentElement?.closest("[data-source-start]") : child?.closest?.("[data-source-start]");
  if (mapped) return Number(mapped.dataset.sourceStart) + (child === children[offset - 1] ? Number(mapped.dataset.sourceEnd) - Number(mapped.dataset.sourceStart) : 0);
  return 0;
}

function sourceRangeFromSelection() {
  const selection = window.getSelection?.();
  if (!summaryVisual || !selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!summaryVisual.contains(range.startContainer) || !summaryVisual.contains(range.endContainer)) return null;
  const start = summarySourcePoint(range.startContainer, range.startOffset);
  const end = summarySourcePoint(range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function appendMappedSegment(parent, segment) {
  if (segment.kind === "newline") {
    const br = document.createElement("br");
    br.dataset.sourceStart = String(segment.sourceStart);
    br.dataset.sourceEnd = String(segment.sourceEnd);
    parent.appendChild(br);
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
  if (segment.kind === "link") element.title = "Markdown link";
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
    }
    root.appendChild(block);
  }
}

function setVisualCaret(sourcePosition) {
  if (!summaryVisual) return;
  const walker = document.createTreeWalker(summaryVisual, NodeFilter.SHOW_TEXT);
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
}

function commitVisualSource(source, caret) {
  summaryInput.value = source;
  renderVisual();
  updateSummaryButtons();
  setVisualCaret(caret);
}

function handleVisualBeforeInput(event) {
  if (!summaryVisual || !summaryInput) return;
  const range = sourceRangeFromSelection();
  if (!range) return;
  const source = summaryMarkdown();
  let start = range.start;
  let end = range.end;
  let replacement = event.data || "";
  if (event.inputType === "insertParagraph") replacement = "\n";
  else if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward") {
    if (start === end) {
      const segments = summaryCore.visibleSegments(source).filter((segment) => segment.kind !== "newline");
      const segment = segments.find((item) => start >= item.sourceStart && start <= item.sourceEnd);
      if (!segment) return;
      if (event.inputType === "deleteContentBackward" && start > segment.sourceStart) { start -= 1; }
      else if (event.inputType === "deleteContentForward" && start < segment.sourceEnd) { end += 1; }
      else return;
    }
    replacement = "";
  } else if (!["insertText", "insertReplacementText", "deleteByCut"].includes(event.inputType)) return;
  event.preventDefault();
  commitVisualSource(summaryCore.replaceRange(source, start, end, replacement), start + replacement.length);
}

function applyBlockFormat(type) {
  const range = sourceRangeFromSelection();
  if (!range) return;
  const next = summaryCore.applyBlockFormat(summaryMarkdown(), range.start, range.end, type);
  commitVisualSource(next, range.start);
}

function refreshPaletteControls() {
  const palette = summaryHighlightMenu?.querySelector(".summary-palette");
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
      refreshPaletteControls();
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
      refreshPaletteControls();
      saveSummaryPalette();
    });
    item.append(use, edit, remove);
    palette.appendChild(item);
  }
}

summaryVisual?.addEventListener("beforeinput", handleVisualBeforeInput);
summaryVisual?.addEventListener("input", (event) => event.preventDefault());

condensedInput?.addEventListener("input", updateCondensedButtons);
summaryInput?.addEventListener("input", () => { updateSummaryButtons(); if (_summaryMode === "markdown") renderVisual(); });
summaryVisual?.addEventListener("focus", () => { _summaryVisualBeforeEdit = summaryVisual.textContent || ""; });
summaryVisual?.addEventListener("input", patchVisualText);
summaryRevertBtn?.addEventListener("click", () => { summaryInput.value = _savedSummary; renderVisual(); updateSummaryButtons(); });
condensedRevertBtn?.addEventListener("click", () => { condensedInput.value = _savedCondensed; updateCondensedButtons(); });
condensedSaveBtn?.addEventListener("click", () => saveCondensedSummary());
summarySaveBtn?.addEventListener("click", () => saveMainSummary());
summaryModeVisual?.addEventListener("click", () => setSummaryMode("visual"));
summaryModeMarkdown?.addEventListener("click", () => setSummaryMode("markdown"));

summaryToolbar?.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-format]");
  if (!button) return;
  e.preventDefault();
  const format = button.dataset.format;
  if (["bold", "italic", "underline", "strike"].includes(format)) applyInlineFormat(format);
  else applyBlockFormat(format);
});
summaryToolbar?.querySelector("select[data-format]")?.addEventListener("change", (e) => {
  applyBlockFormat(e.target.value);
  e.target.value = "normal";
});

summaryHighlightMenu?.querySelector(".summary-palette-picker")?.addEventListener("input", (e) => updatePaletteFromPicker(e.target));
summaryHighlightMenu?.querySelector(".summary-palette-remove")?.addEventListener("click", removeHighlight);
$("summary-highlight-button")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (summaryHighlightMenu) summaryHighlightMenu.hidden = !summaryHighlightMenu.hidden;
  refreshPaletteControls();
});

document.addEventListener("click", (e) => {
  if (summaryHighlightMenu && !summaryHighlightMenu.hidden && !summaryHighlightMenu.contains(e.target) && e.target.id !== "summary-highlight-button") summaryHighlightMenu.hidden = true;
});

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
function createSummaryPopup() {
  const popup = document.createElement("div");
  popup.className = "summary-hint-popup";
  popup.hidden = true;
  document.body.appendChild(popup);
  popup.addEventListener("mouseenter", () => clearTimeout(_hintHideTimer));
  popup.addEventListener("mouseleave", hideSummaryPopup);
  return popup;
}
function showSummaryPopup(anchorEl, text) {
  if (!_hintPopup) _hintPopup = createSummaryPopup();
  _hintPopup.textContent = text;
  _hintPopup.hidden = false;
  clearTimeout(_hintHideTimer);
  const r = anchorEl.getBoundingClientRect();
  const pw = _hintPopup.offsetWidth;
  const ph = _hintPopup.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 8);
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 4;
  _hintPopup.style.left = `${Math.max(8, left)}px`;
  _hintPopup.style.top = `${Math.max(8, top)}px`;
}
function hideSummaryPopup() {
  clearTimeout(_hintHideTimer);
  _hintHideTimer = setTimeout(() => { if (_hintPopup) _hintPopup.hidden = true; if (_hintLoadAbort) { _hintLoadAbort.abort(); _hintLoadAbort = null; } }, 200);
}
document.addEventListener("mouseover", async (e) => {
  const hint = e.target.closest(".conv-summary-hint");
  if (!hint || !hint.dataset.convId) return;
  clearTimeout(_hintHideTimer);
  if (_hintLoadAbort) _hintLoadAbort.abort();
  _hintLoadAbort = new AbortController();
  try {
    const data = await apiGetSummary(hint.dataset.convId);
    if (_hintLoadAbort?.signal.aborted) return;
    const text = (data.condensed_summary || "").trim();
    if (text) showSummaryPopup(hint, text);
  } catch (_) {}
});
document.addEventListener("mouseout", (e) => { if (e.target.closest(".conv-summary-hint")) hideSummaryPopup(); });
