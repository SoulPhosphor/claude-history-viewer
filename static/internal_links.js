"use strict";

// One internal link format for the whole app (Scratch Pads, Copy Internal
// Link, bookmark menus). A link names its destination by stable ids only, never
// by a visible title, so renaming a chat or a bookmark never breaks it:
//
//   chv://conversation/<conversation id>                          the whole chat
//   chv://conversation/<conversation id>/message/<seq>/<message id>  one message
//
// <message id> is the export's own id for the message; it finds the message
// even if its position moved on a re-import. <seq> (its position, as bookmarks
// store it) is the fallback, and the whole id part is optional for links
// made before ids were kept.
// Pure string helpers, shared with the tests (Node) like summary_editor_core.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.InternalLinks = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const SCHEME = "chv://";
  const PATTERN = /^chv:\/\/conversation\/([^/\s?#]+)(?:\/message\/(\d+)(?:\/([^/\s?#]+))?)?\/?$/i;

  function conversationLink(conversationId) {
    return `${SCHEME}conversation/${encodeURIComponent(conversationId)}`;
  }

  function messageLink(conversationId, seq, messageId = null) {
    const base = `${conversationLink(conversationId)}/message/${Number(seq)}`;
    return messageId ? `${base}/${encodeURIComponent(messageId)}` : base;
  }

  // {conversationId, seq, messageId} for an internal link (seq and messageId
  // are null for a whole chat; messageId is null for an older message link),
  // or null for anything else.
  function parse(text) {
    const match = String(text || "").trim().match(PATTERN);
    if (!match) return null;
    let conversationId;
    let messageId = null;
    try {
      conversationId = decodeURIComponent(match[1]);
      if (match[3] != null) messageId = decodeURIComponent(match[3]);
    } catch (_) {
      return null;
    }
    return { conversationId, seq: match[2] == null ? null : Number(match[2]), messageId };
  }

  // An ordinary web address the user typed or pasted, made safe to sit inside
  // Markdown link parentheses; null when the text is not one.
  function externalUrl(text) {
    let value = String(text || "").trim();
    if (!value || /\s/.test(value)) return null;
    if (/^www\.[^.]+\./i.test(value)) value = `https://${value}`;
    if (!/^(https?:\/\/|mailto:)/i.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "mailto:" && !url.hostname) return null;
    } catch (_) {
      return null;
    }
    return value.replace(/\(/g, "%28").replace(/\)/g, "%29");
  }

  // Visible link text that cannot break the Markdown around it: one line, and
  // no square brackets (they would end the link early).
  function cleanLabel(text, fallback = "Link") {
    const label = String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\[/g, "(")
      .replace(/\]/g, ")")
      .trim();
    return label || fallback;
  }

  function markdown(label, target) {
    return `[${cleanLabel(label)}](${target})`;
  }

  // What another window added to a pad since `saved`, when that is only what
  // Add to Scratch Pad writes: whole links, each its own paragraph at the end
  // (the server's append rule). Returns the added links ("" for no change),
  // or null for any other change, which must not be merged automatically.
  function appendedLinks(saved, current) {
    const base = String(saved || "").replace(/\n+$/, "");
    current = String(current || "");
    if (!current.startsWith(base)) return null;
    let rest = current.slice(base.length);
    if (base && rest) {
      if (!rest.startsWith("\n\n")) return null;
      rest = rest.slice(2);
    }
    if (!rest) return "";
    const blocks = rest.split("\n\n");
    return blocks.every((block) => /^\[[^\]\n]+\]\([^)\s]+\)$/.test(block)) ? blocks.join("\n\n") : null;
  }

  return { SCHEME, conversationLink, messageLink, parse, externalUrl, cleanLabel, markdown, appendedLinks };
});
