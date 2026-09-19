"use strict";

// Source-aware helpers shared by the Summary editor and its tests. The normal
// conversation renderer remains unchanged; these rules intentionally cover the
// same portable inline syntax that Summary exposes in its toolbar.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SummaryEditorCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const INLINE_RE = /\*\*[^*\n]+\*\*|~~[^~\n]+~~|\+\+[^+\n]+\+\+|==(?:\{#[0-9a-fA-F]{6}\})?[^=\n]+==|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\((?:https?:|mailto:|\/|#|\.\.?\/)[^)]+\)/g;

  function inlineSegments(source, offset = 0) {
    const segments = [];
    let cursor = 0;
    let match;
    while ((match = INLINE_RE.exec(source))) {
      if (match.index > cursor) {
        segments.push({ text: source.slice(cursor, match.index), sourceStart: offset + cursor, sourceEnd: offset + match.index, kind: "plain" });
      }
      const raw = match[0];
      let text = raw;
      let contentStart = 0;
      let contentEnd = raw.length;
      let kind = "plain";
      let color = null;
      if (raw.startsWith("**")) { kind = "bold"; contentStart = 2; contentEnd = raw.length - 2; }
      else if (raw.startsWith("~~")) { kind = "strike"; contentStart = 2; contentEnd = raw.length - 2; }
      else if (raw.startsWith("++")) { kind = "underline"; contentStart = 2; contentEnd = raw.length - 2; }
      else if (raw.startsWith("==")) {
        kind = "highlight";
        const colorMatch = raw.match(/^==\{(#[0-9a-fA-F]{6})\}/);
        color = colorMatch ? colorMatch[1].toLowerCase() : null;
        contentStart = colorMatch ? colorMatch[0].length : 2;
        contentEnd = raw.length - 2;
      } else if (raw.startsWith("*") && raw.endsWith("*")) { kind = "italic"; contentStart = 1; contentEnd = raw.length - 1; }
      else if (raw.startsWith("`") && raw.endsWith("`")) { kind = "code"; contentStart = 1; contentEnd = raw.length - 1; }
      else if (raw.startsWith("[")) {
        kind = "link";
        contentStart = 1;
        contentEnd = raw.indexOf("](");
      }
      text = raw.slice(contentStart, contentEnd);
      segments.push({ text, sourceStart: offset + match.index + contentStart, sourceEnd: offset + match.index + contentEnd, tokenStart: offset + match.index, tokenEnd: offset + match.index + raw.length, kind, color });
      cursor = match.index + raw.length;
    }
    if (cursor < source.length) segments.push({ text: source.slice(cursor), sourceStart: offset + cursor, sourceEnd: offset + source.length, kind: "plain" });
    return segments;
  }

  function sourceLines(source) {
    const lines = [];
    let start = 0;
    for (let i = 0; i <= source.length; i++) {
      if (i === source.length || source[i] === "\n") {
        lines.push({ text: source.slice(start, i), start, end: i, newlineStart: i, newlineEnd: i < source.length ? i + 1 : i });
        start = i + 1;
      }
    }
    return lines;
  }

  function visibleContent(line) {
    const heading = line.text.match(/^(#{1,3})\s+(.*)$/);
    if (heading) return { text: heading[2], start: line.start + heading[1].length + 1, block: "heading", level: heading[1].length };
    const bullet = line.text.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bullet) return { text: bullet[3], start: line.start + bullet[1].length + bullet[2].length + 1, block: "bullet" };
    const numbered = line.text.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (numbered) return { text: numbered[2], start: line.start + numbered[1].length + numbered[0].indexOf(numbered[2]), block: "numbered" };
    return { text: line.text, start: line.start, block: "paragraph" };
  }

  function rangesForLines(source, start, end) {
    return sourceLines(source).filter((line) => line.end >= start && line.start <= end);
  }

  function applyBlockFormat(source, start, end, type) {
    const lines = rangesForLines(source, start, end);
    if (!lines.length) return source;
    const edits = lines.map((line) => {
      const content = visibleContent(line);
      let text = content.text;
      if (type === "normal") return { start: line.start, end: line.end, value: text };
      if (type === "heading1" || type === "heading2" || type === "heading3") return { start: line.start, end: line.end, value: `${"#".repeat(Number(type.slice(-1)))} ${text.replace(/^#{1,6}\s+/, "")}` };
      if (type === "bullet") return { start: line.start, end: line.end, value: `- ${text}` };
      if (type === "numbered") return { start: line.start, end: line.end, value: `${lines.indexOf(line) + 1}. ${text}` };
      return { start: line.start, end: line.end, value: line.text };
    });
    let result = source;
    for (let i = edits.length - 1; i >= 0; i--) result = result.slice(0, edits[i].start) + edits[i].value + result.slice(edits[i].end);
    return result;
  }

  function visibleSegments(source) {
    const result = [];
    for (const line of sourceLines(source)) {
      const content = visibleContent(line);
      result.push(...inlineSegments(content.text, content.start));
      if (line.newlineEnd > line.newlineStart) result.push({ text: "\n", sourceStart: line.newlineStart, sourceEnd: line.newlineEnd, kind: "newline" });
    }
    return result;
  }

  function visibleRangeToSource(source, visibleStart, visibleEnd) {
    const segments = visibleSegments(source);
    const point = (position) => {
      let cursor = 0;
      for (const segment of segments) {
        const next = cursor + segment.text.length;
        if (position <= next) return segment.sourceStart + Math.max(0, position - cursor);
        cursor = next;
      }
      return source.length;
    };
    return { start: point(visibleStart), end: point(visibleEnd) };
  }

  function replaceRange(source, start, end, value) {
    return source.slice(0, start) + value + source.slice(end);
  }

  function inlineTokenForRange(source, start, end) {
    return inlineSegments(source).find((segment) => segment.tokenStart != null && segment.tokenStart <= start && segment.tokenEnd >= end && segment.kind !== "plain") || null;
  }

  function isSupportedVisualInputType(inputType) {
    return [
      "insertText", "insertReplacementText", "insertParagraph", "insertLineBreak",
      "insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop",
      "deleteContentBackward", "deleteContentForward", "deleteWordBackward",
      "deleteWordForward", "deleteByCut", "deleteByDrag", "historyUndo", "historyRedo",
    ].includes(inputType);
  }

  function toggleInlineFormat(source, start, end, kind) {
    const markers = { bold: ["**", "**"], italic: ["*", "*"], underline: ["++", "++"], strike: ["~~", "~~"] }[kind];
    if (!markers) return source;
    const token = inlineTokenForRange(source, start, end);
    if (token && token.kind === kind && token.sourceStart === start && token.sourceEnd === end) {
      return replaceRange(source, token.tokenStart, token.tokenEnd, source.slice(start, end));
    }
    return replaceRange(source, start, end, markers[0] + source.slice(start, end) + markers[1]);
  }

  function removeHighlightRange(source, start, end) {
    const token = inlineTokenForRange(source, start, end);
    if (token && token.kind === "highlight" && token.sourceStart === start && token.sourceEnd === end) {
      return replaceRange(source, token.tokenStart, token.tokenEnd, source.slice(start, end));
    }
    return source;
  }

  function deleteVisibleCharacter(source, sourcePosition, direction) {
    const segments = visibleSegments(source).filter((segment) => segment.kind !== "newline");
    const index = segments.findIndex((segment) => sourcePosition >= segment.sourceStart && sourcePosition <= segment.sourceEnd);
    if (index < 0) return source;
    const segment = segments[index];
    if (direction === "backward" && sourcePosition > segment.sourceStart) return replaceRange(source, sourcePosition - 1, sourcePosition, "");
    if (direction === "forward" && sourcePosition < segment.sourceEnd) return replaceRange(source, sourcePosition, sourcePosition + 1, "");
    return source;
  }

  return { inlineSegments, inlineTokenForRange, isSupportedVisualInputType, toggleInlineFormat, removeHighlightRange, sourceLines, visibleContent, visibleSegments, visibleRangeToSource, replaceRange, applyBlockFormat, deleteVisibleCharacter };
});
