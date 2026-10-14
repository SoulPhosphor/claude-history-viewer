"use strict";

// One internal link format for the whole app (Scratch Pads, Copy Internal
// Link, bookmark menus). A link names its destination by stable ids only, never
// by a visible title, so renaming a chat or a bookmark never breaks it:
//
//   chv://conversation/<conversation id>                   the whole chat
//   chv://conversation/<conversation id>/message/<seq>     one message in it
//
// <seq> is the message's sequence number, the same one a bookmark stores.
// Pure string helpers, shared with the tests (Node) like summary_editor_core.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.InternalLinks = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const SCHEME = "chv://";
  const PATTERN = /^chv:\/\/conversation\/([^/\s?#]+)(?:\/message\/(\d+))?\/?$/i;

  function conversationLink(conversationId) {
    return `${SCHEME}conversation/${encodeURIComponent(conversationId)}`;
  }

  function messageLink(conversationId, seq) {
    return `${conversationLink(conversationId)}/message/${Number(seq)}`;
  }

  // {conversationId, seq} for an internal link (seq is null for a whole chat),
  // or null for anything else.
  function parse(text) {
    const match = String(text || "").trim().match(PATTERN);
    if (!match) return null;
    let conversationId;
    try {
      conversationId = decodeURIComponent(match[1]);
    } catch (_) {
      return null;
    }
    return { conversationId, seq: match[2] == null ? null : Number(match[2]) };
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

  return { SCHEME, conversationLink, messageLink, parse, externalUrl, cleanLabel, markdown };
});
