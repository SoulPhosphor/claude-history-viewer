"use strict";

// Source-aware helpers shared by the Summary editor and its tests. The normal
// conversation renderer remains unchanged; these rules intentionally cover the
// same portable inline syntax that Summary exposes in its toolbar.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SummaryEditorCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const INLINE_RE = /\*\*~~[^*~\n]+~~\*\*|~~\*\*[^*~\n]+\*\*~~|\*~~[^*~\n]+~~\*|~~\*[^*~\n]+\*~~|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\+\+[^+\n]+\+\+|==(?:\{#[0-9a-fA-F]{6}\})?[^=\n]+==|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\((?:https?:|mailto:|chv:|\/|#|\.\.?\/)[^)]+\)/g;

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
      if (raw.startsWith("**~~")) { kind = "boldStrike"; contentStart = 4; contentEnd = raw.length - 4; }
      else if (raw.startsWith("~~**")) { kind = "boldStrike"; contentStart = 4; contentEnd = raw.length - 4; }
      else if (raw.startsWith("*~~")) { kind = "italicStrike"; contentStart = 3; contentEnd = raw.length - 3; }
      else if (raw.startsWith("~~*")) { kind = "italicStrike"; contentStart = 3; contentEnd = raw.length - 3; }
      else if (raw.startsWith("***")) { kind = "boldItalic"; contentStart = 3; contentEnd = raw.length - 3; }
      else if (raw.startsWith("**")) { kind = "bold"; contentStart = 2; contentEnd = raw.length - 2; }
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
      segments.push({ text, raw, sourceStart: offset + match.index + contentStart, sourceEnd: offset + match.index + contentEnd, tokenStart: offset + match.index, tokenEnd: offset + match.index + raw.length, kind, color });
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
    // Each block's visible text is the trailing capture group, so its source
    // offset is always the line end minus that text's length. This stays correct
    // for indented lists and extra spacing after a marker, where counting marker
    // lengths by hand would drift and mis-map edits back into the source.
    const heading = line.text.match(/^(#{1,3})\s+(.*)$/);
    if (heading) return { text: heading[2], start: line.start + line.text.length - heading[2].length, block: "heading", level: heading[1].length };
    const bullet = line.text.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bullet) return { text: bullet[3], start: line.start + line.text.length - bullet[3].length, block: "bullet" };
    const numbered = line.text.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (numbered) return { text: numbered[2], start: line.start + line.text.length - numbered[2].length, block: "numbered" };
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

  function mapElementBoundary(children, offset, ownStart = 0, ownEnd = 0) {
    if (!children.length || offset <= 0) return children[0]?.start ?? ownStart;
    if (offset >= children.length) return children[children.length - 1]?.end ?? ownEnd;
    return children[offset - 1]?.end ?? children[offset]?.start ?? ownStart;
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

  function formatTokenContent(token, content) {
    if (token.kind === "bold") return `**${content}**`;
    if (token.kind === "italic") return `*${content}*`;
    if (token.kind === "boldItalic") return `***${content}***`;
    if (token.kind === "boldStrike") return `**~~${content}~~**`;
    if (token.kind === "italicStrike") return `*~~${content}~~*`;
    if (token.kind === "underline") return `++${content}++`;
    if (token.kind === "strike") return `~~${content}~~`;
    if (token.kind === "highlight") return `==${token.color ? `{${token.color}}` : ""}${content}==`;
    if (token.kind === "code") return `\`${content}\``;
    if (token.kind === "link") {
      const raw = sourceForToken(token);
      const target = raw.slice(raw.indexOf("](") + 2, -1);
      return `[${content}](${target})`;
    }
    return content;
  }

  function sourceForToken(token) {
    return token.raw || "";
  }

  function safeReplaceVisibleRange(source, start, end, replacement) {
    return safeReplaceVisibleRangeAt(source, start, end, replacement).source;
  }

  // Same edit, also reporting where the replacement text landed (`at`), which
  // can differ from `start` when a partly selected token is split around it.
  function safeReplaceVisibleRangeAt(source, start, end, replacement) {
    const tokens = inlineSegments(source).filter((segment) => segment.tokenStart != null);
    const contained = tokens.find((token) =>
      token.sourceStart <= start && end <= token.sourceEnd
    );

    // A normal edit inside one visible token must patch only its content. This
    // keeps the token's delimiters, link target, or highlight metadata intact
    // and makes inserted text inherit the token's formatting. Deleting every
    // visible character removes the token, so no bare delimiters are left.
    if (contained) {
      if (!replacement && start === contained.sourceStart && end === contained.sourceEnd) {
        return { source: replaceRange(source, contained.tokenStart, contained.tokenEnd, ""), at: contained.tokenStart };
      }
      return { source: replaceRange(source, start, end, replacement), at: start };
    }

    const overlapping = tokens.filter((token) =>
      token.sourceStart < end && token.sourceEnd > start
    );
    if (!overlapping.length) return { source: replaceRange(source, start, end, replacement), at: start };

    const first = overlapping[0];
    const last = overlapping[overlapping.length - 1];
    const left = start > first.sourceStart
      ? formatTokenContent(first, source.slice(first.sourceStart, Math.min(start, first.sourceEnd)))
      : "";
    const right = end < last.sourceEnd
      ? formatTokenContent(last, source.slice(Math.max(end, last.sourceStart), last.sourceEnd))
      : "";
    const prefix = source.slice(0, Math.min(start, first.tokenStart));
    const suffix = source.slice(Math.max(end, last.tokenEnd));
    return { source: prefix + left + replacement + right + suffix, at: prefix.length + left.length };
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

  function isToolbarFormatRangeSafe(source, start, end, kind) {
    if (start === end) return false;
    const tokens = inlineSegments(source).filter((segment) => segment.tokenStart != null && segment.sourceStart < end && segment.sourceEnd > start);
    if (!tokens.length) return true;
    if (tokens.length !== 1) return false;
    const token = tokens[0];
    if (kind === "highlight") return token.kind === "highlight";
    if (token.kind === kind) return start >= token.sourceStart && end <= token.sourceEnd;
    if (token.sourceStart !== start || token.sourceEnd !== end) return false;
    const pairs = {
      bold: ["italic", "strike", "boldItalic", "boldStrike"],
      italic: ["bold", "strike", "boldItalic", "italicStrike"],
      strike: ["bold", "italic", "boldStrike", "italicStrike"],
    };
    return pairs[kind]?.includes(token.kind) || false;
  }

  function toggleInlineFormat(source, start, end, kind) {
    const markers = { bold: ["**", "**"], italic: ["*", "*"], underline: ["++", "++"], strike: ["~~", "~~"] }[kind];
    if (!markers || !isToolbarFormatRangeSafe(source, start, end, kind)) return source;
    const token = inlineTokenForRange(source, start, end);
    if (token && token.kind === kind && start >= token.sourceStart && end <= token.sourceEnd) {
      return removeTokenFormatting(source, token, start, end);
    }
    if (token && token.sourceStart === start && token.sourceEnd === end) {
      if (["link", "code", "highlight"].includes(token.kind) && token.kind !== kind) return source;
      if (["bold", "italic", "strike"].includes(token.kind) && ["bold", "italic", "strike"].includes(kind)) {
        const nested = markers[0] + source.slice(start, end) + markers[1];
        return replaceRange(source, token.tokenStart, token.tokenEnd, formatTokenContent(token, nested));
      }
      if (token.kind === "boldItalic" && kind === "bold") return replaceRange(source, token.tokenStart, token.tokenEnd, `*${source.slice(start, end)}*`);
      if (token.kind === "boldItalic" && kind === "italic") return replaceRange(source, token.tokenStart, token.tokenEnd, `**${source.slice(start, end)}**`);
      if (token.kind === "boldStrike" && kind === "bold") return replaceRange(source, token.tokenStart, token.tokenEnd, `~~${source.slice(start, end)}~~`);
      if (token.kind === "boldStrike" && kind === "strike") return replaceRange(source, token.tokenStart, token.tokenEnd, `**${source.slice(start, end)}**`);
      if (token.kind === "italicStrike" && kind === "italic") return replaceRange(source, token.tokenStart, token.tokenEnd, `~~${source.slice(start, end)}~~`);
      if (token.kind === "italicStrike" && kind === "strike") return replaceRange(source, token.tokenStart, token.tokenEnd, `*${source.slice(start, end)}*`);
    }
    // Do not create nested syntax unless the parser has an explicit combined
    // token for it. The toolbar must never create source it cannot render.
    if (token) return source;
    return safeReplaceVisibleRange(source, start, end, markers[0] + source.slice(start, end) + markers[1]);
  }

  function formatWithWhitespace(token, content) {
    const leading = content.match(/^\s*/)[0];
    const trailing = content.match(/\s*$/)[0];
    const first = leading.length;
    const last = content.length - trailing.length;
    if (first >= last) return content;
    return leading + formatTokenContent(token, content.slice(first, last)) + trailing;
  }

  function removeTokenFormatting(source, token, start, end) {
    const content = source.slice(token.sourceStart, token.sourceEnd);
    const relativeStart = Math.max(0, start - token.sourceStart);
    const relativeEnd = Math.min(content.length, end - token.sourceStart);
    if (relativeStart <= 0 && relativeEnd >= content.length) return replaceRange(source, token.tokenStart, token.tokenEnd, content);
    const before = formatWithWhitespace(token, content.slice(0, relativeStart));
    const selected = content.slice(relativeStart, relativeEnd);
    const after = formatWithWhitespace(token, content.slice(relativeEnd));
    return replaceRange(source, token.tokenStart, token.tokenEnd, before + selected + after);
  }

  function removeHighlightRange(source, start, end) {
    if (start === end) return source;
    const token = inlineTokenForRange(source, start, end);
    if (token && token.kind === "highlight") return removeTokenFormatting(source, token, start, end);
    return source;
  }

  function replaceHighlightRange(source, start, end, color) {
    if (!isToolbarFormatRangeSafe(source, start, end, "highlight")) return source;
    const token = inlineTokenForRange(source, start, end);
    if (token && token.kind !== "highlight") return source;
    if (token && token.kind === "highlight" && start >= token.sourceStart && end <= token.sourceEnd) {
      const updated = { ...token, color: color || null };
      if (start === token.sourceStart && end === token.sourceEnd) {
        return replaceRange(source, token.tokenStart, token.tokenEnd, formatTokenContent(updated, source.slice(start, end)));
      }
      const content = source.slice(token.sourceStart, token.sourceEnd);
      const before = formatWithWhitespace(token, content.slice(0, start - token.sourceStart));
      const selected = formatTokenContent(updated, content.slice(start - token.sourceStart, end - token.sourceStart));
      const after = formatWithWhitespace(token, content.slice(end - token.sourceStart));
      return replaceRange(source, token.tokenStart, token.tokenEnd, before + selected + after);
    }
    const replacement = `==${color ? `{${color}}` : ""}${source.slice(start, end)}==`;
    return safeReplaceVisibleRange(source, start, end, replacement);
  }

  function insertParagraph(source, start, end) {
    const token = inlineTokenForRange(source, start, end);
    if (token && start >= token.sourceStart && end <= token.sourceEnd) {
      const content = source.slice(token.sourceStart, token.sourceEnd);
      const beforeContent = content.slice(0, start - token.sourceStart);
      const afterContent = content.slice(end - token.sourceStart);
      const before = beforeContent ? formatTokenContent(token, beforeContent) : "";
      const after = afterContent ? formatTokenContent(token, afterContent) : "";
      const visibleOpeningLength = after ? formatTokenContent(token, "x").indexOf("x") : 0;
      return {
        source: replaceRange(source, token.tokenStart, token.tokenEnd, `${before}\n${after}`),
        caret: token.tokenStart + before.length + 1 + visibleOpeningLength,
      };
    }
    return { source: safeReplaceVisibleRange(source, start, end, "\n"), caret: start + 1 };
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  function linkTarget(token) {
    const raw = sourceForToken(token);
    return raw.slice(raw.indexOf("](") + 2, -1);
  }

  // The link whose visible text holds this range (its edges included).
  function linkTokenAt(source, start, end = start) {
    return inlineSegments(source).find((segment) =>
      segment.kind === "link" && segment.sourceStart <= start && end <= segment.sourceEnd
    ) || null;
  }

  // Insert `[label](target)` at a visible range, replacing any selected text.
  // A link is never nested inside other formatting (the parser could not draw
  // it), so a token holding the range is split around the new link. A caret
  // inside an existing link puts the new one right after it. When the link
  // would end a line or touch the next token, a space follows it so the caret
  // has plain text to land in. Returns the new source and the caret after it.
  function insertLink(source, start, end, label, target) {
    const link = `[${label}](${target})`;
    let next;
    let at;
    const tokens = inlineSegments(source).filter((segment) => segment.tokenStart != null);
    const holder = tokens.find((token) => token.sourceStart <= start && end <= token.sourceEnd);
    if (holder && holder.kind === "link") {
      if (start === end) {
        at = holder.tokenEnd;
        next = replaceRange(source, at, at, link);
      } else {
        at = holder.tokenStart;
        next = replaceRange(source, holder.tokenStart, holder.tokenEnd, link);
      }
    } else if (holder) {
      const content = source.slice(holder.sourceStart, holder.sourceEnd);
      const before = formatWithWhitespace(holder, content.slice(0, start - holder.sourceStart));
      const after = formatWithWhitespace(holder, content.slice(end - holder.sourceStart));
      at = holder.tokenStart + before.length;
      next = replaceRange(source, holder.tokenStart, holder.tokenEnd, before + link + after);
    } else {
      const placed = safeReplaceVisibleRangeAt(source, start, end, link);
      next = placed.source;
      at = placed.at;
    }
    let caret = at + link.length;
    const following = next[caret];
    const touchesToken = inlineSegments(next).some((segment) => segment.tokenStart === caret);
    if (following === undefined || following === "\n" || touchesToken) {
      next = replaceRange(next, caret, caret, " ");
      caret += 1;
    }
    return { source: next, start: at, end: at + link.length, caret };
  }

  // The text a reader sees between two source positions (no Markdown marks).
  function visibleText(source, start, end) {
    let text = "";
    for (const segment of visibleSegments(source)) {
      const from = Math.max(start, segment.sourceStart);
      const to = Math.min(end, segment.sourceEnd);
      if (to > from) text += segment.text.slice(from - segment.sourceStart, to - segment.sourceStart);
    }
    return text;
  }

  // Keep a link's visible text and drop its destination.
  function removeLink(source, token) {
    return replaceRange(source, token.tokenStart, token.tokenEnd, source.slice(token.sourceStart, token.sourceEnd));
  }

  // Point an existing link somewhere else, keeping its visible text.
  function replaceLinkTarget(source, token, target) {
    return replaceRange(source, token.tokenStart, token.tokenEnd, `[${source.slice(token.sourceStart, token.sourceEnd)}](${target})`);
  }

  // A Markdown block added as its own paragraph at the end of a document.
  // Mirrors scratchpads.appended_content on the server.
  function appendBlock(source, block) {
    if (!String(source || "").trim()) return block;
    return String(source).replace(/\n+$/, "") + "\n\n" + block;
  }

  // Backspace at the start of a line's text, or Delete at the end of a line.
  // Backspace first drops a heading / list marker (the line becomes normal
  // text), then joins the line to the one above. Delete joins the next line
  // on, dropping that line's marker. Returns null when the caret is not at
  // such an edge, so ordinary deletion applies.
  function deleteLineBreak(source, position, direction) {
    const lines = sourceLines(source);
    const index = lines.findIndex((line) => position >= line.start && position <= line.end);
    if (index < 0) return null;
    const line = lines[index];
    const content = visibleContent(line);
    // Where the visible text starts and ends; formatting or a link at the
    // edge puts these inside its markers.
    const edges = (row, text) => {
      const segments = inlineSegments(text.text, text.start);
      return segments.length
        ? { first: segments[0].sourceStart, last: segments[segments.length - 1].sourceEnd }
        : { first: text.start, last: row.end };
    };
    const own = edges(line, content);
    if (direction === "backward") {
      if (position !== content.start && position !== own.first) return null;
      const marker = content.start - line.start;
      if (marker > 0) return { source: replaceRange(source, line.start, content.start, ""), caret: own.first - marker };
      if (index === 0) return null;
      const previous = lines[index - 1];
      const caret = edges(previous, visibleContent(previous)).last;
      return { source: replaceRange(source, line.start - 1, line.start, ""), caret };
    }
    if ((position !== line.end && position !== own.last) || index === lines.length - 1) return null;
    const next = visibleContent(lines[index + 1]);
    return { source: replaceRange(source, line.end, next.start, ""), caret: position };
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

  return { deleteLineBreak, visibleText, linkTarget, linkTokenAt, insertLink, removeLink, replaceLinkTarget, appendBlock, safeReplaceVisibleRangeAt, inlineSegments, inlineTokenForRange, isSupportedVisualInputType, isToolbarFormatRangeSafe, toggleInlineFormat, removeHighlightRange, replaceHighlightRange, insertParagraph, safeReplaceVisibleRange, mapElementBoundary, sourceLines, visibleContent, visibleSegments, visibleRangeToSource, replaceRange, applyBlockFormat, deleteVisibleCharacter };
});
