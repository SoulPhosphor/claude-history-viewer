"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  q: "",
  offset: 0,
  total: 0,
  activeId: null,
  // Which history is shown: 'claude' or 'chatgpt'. Set from /api/sources on load
  // (and remembered in preferences). The two histories never mix in the list.
  source: "claude",
  sourceCounts: { claude: 0, chatgpt: 0 },
  // The Custom GPT of the currently-open conversation (or null). `label` is the
  // display name, or "Custom GPT" when the gizmo has not been named yet.
  activeGizmo: null,
  view: "recent",
  activeSpecialView: null,
  mediaHub: {
    data: null,
    activeSectionKey: "images",
  },
  specialReturnTabId: null,
  pinnedIds: new Set(),
  folders: [],
  folderOf: new Map(), // conversation_id -> folder_id (for chats inside folders)
  tabs: [],
  activeTabId: null,
  preferences: {
    sidebarCollapsed: false,
    sidebarWidth: 300,
    conversationView: "recent",
    searchHistory: [],
  },
  scrollByConversation: {},
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const searchEl = $("search");
const searchHistoryListEl = $("search-history-list");
const sourceSwitcher = $("source-switcher");
const viewFilterEl = $("view-filter");
const resultCount = $("result-count");
const convList = $("conv-list");
const listSectionTitle = $("list-section-title");
const foldersToggle = $("folders-toggle");
const foldersTree = $("folders-tree");
const pinnedSection = $("pinned-section");
const pinnedList = $("pinned-list");
const loadMoreWrap = $("load-more-wrap");
const loadMoreBtn = $("load-more");
const pinnedRefreshBtn = $("pinned-refresh");
const pinnedTitleEl = $("pinned-title");
const pinnedHintEl = $("pinned-hint");
const sidebarToggleBtn = $("sidebar-toggle");
const sidebarResizeHandle = $("sidebar-resize");
const tabsList = $("tabs-list");
const emptyState = $("empty-state");
const thread = $("thread");
const threadTitle = $("thread-title");
const threadMeta = $("thread-meta");
const messagesEl = $("messages");
const galleryPanel = $("gallery");
const galleryGrid = $("gallery-grid");
const memoriesPanel = $("memories-panel");
const memoriesContent = $("memories-content");
const memoriesMeta = $("memories-meta");
const projectsPanel = $("projects-panel");
const projectsContent = $("projects-content");
const projectsMeta = $("projects-meta");
const attReportPanel = $("att-report-panel");
const attReportContent = $("att-report-content");
const attReportMeta = $("att-report-meta");
const importAuditPanel = $("import-audit-panel");
const importAuditContent = $("import-audit-content");
const gizmosPanel = $("gizmos-panel");
const gizmosContent = $("gizmos-content");
const artifactPanel = $("artifact-panel");
const artifactPanelTitle = $("artifact-panel-title");
const artifactPanelBody = $("artifact-panel-body");

// ── Available local files (source/files/) ────────────────────────────────────
// Maps normalizedName → realFilename. Normalized = lowercase + spaces→underscores.
const _normName = (s) => s.toLowerCase().replace(/\s+/g, "_");
let _localFilesMap = new Map(); // normName → realFilename
async function loadFilesManifest() {
  try {
    const r = await fetch("/api/files-manifest");
    const d = await r.json();
    _localFilesMap = new Map((d.files || []).map((f) => [_normName(f), f]));
  } catch (_) {}
}
// Called once at startup (non-blocking)
loadFilesManifest();

// ── Citation / artifact stripping ────────────────────────────────────────────
// ChatGPT embeds inline citation markers that its UI renders as numbered
// superscripts but are meaningless noise in raw text.
function sanitize(text) {
  return (
    text
      // Private-use citation group: \ue200cite\ue202turn0search0\ue202turn0search1\ue201
      .replace(/\ue200[\s\S]*?\ue201/g, "")
      // Orphaned private-use citation chars (\ue200 open, \ue201 close, \ue202 sep)
      .replace(/[\ue200-\ue202]/g, "")
      // 【4†source】 style Unicode bracket citations (older export format)
      .replace(/\u3010[^\u3011]*\u3011/g, "")
      // Clean up any double spaces left behind
      .replace(/  +/g, " ")
      .replace(/ ([.,;!?])/g, "$1")
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
// Lightweight renderer — no external deps, works offline.

const md = (() => {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function sanitizeHref(rawHref) {
    const href = String(rawHref || "").trim();
    if (!href) return "";
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (/^(\/|#|\.\.?\/)/.test(href)) return href;
    return "";
  }

  // Inline formatting applied after HTML-escaping the raw text
  function inline(raw) {
    let s = esc(raw);
    // Double backtick before single to handle ``code``
    s = s.replace(/``([^`\n]+?)``/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/`([^`\n]+?)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
    // Only trigger _italic_ at non-word boundaries to avoid mangling variable_names
    s = s.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<em>$1</em>");
    s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
    s = s.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_, alt, src) => `<img src="${src}" alt="${esc(alt)}">`,
    );
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      const safeHref = sanitizeHref(href);
      if (!safeHref) return text;
      return `<a href="${esc(safeHref)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    return s;
  }

  // ── Nested list parser ──────────────────────────────────────────────────────
  // Returns [htmlString, nextLineIndex]. Handles arbitrary nesting depth,
  // task-list checkboxes, and mixed ordered/unordered sub-lists.
  function parseListItems(lines, startIdx) {
    const baseIndent = lines[startIdx].search(/\S/);
    const items = [];
    let i = startIdx;

    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim()) {
        i++;
        continue;
      } // skip blank lines within a list

      const indent = raw.search(/\S/);
      if (indent < baseIndent) break; // de-dented past our level → stop
      if (indent > baseIndent) {
        i++;
        continue;
      } // deeper line already consumed

      const ulM = raw.match(/^[ \t]*[*\-+] (.*)/);
      const olM = raw.match(/^[ \t]*\d+[.)]\s+(.*)/);
      if (!ulM && !olM) break; // not a list item at this indent → stop

      let content = (ulM || olM)[1];

      // Task-list checkbox
      let prefix = "";
      const tm = content.match(/^\[([ xX])\] (.*)/);
      if (tm) {
        const checked = tm[1].toLowerCase() === "x";
        prefix = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
        content = tm[2];
      }

      i++;

      // Look ahead: if next non-empty line is a deeper list item, recurse
      let subHtml = "";
      if (i < lines.length && lines[i].trim()) {
        const nextIndent = lines[i].search(/\S/);
        const isNestedList =
          /^[ \t]*[*\-+] /.test(lines[i]) || /^[ \t]*\d+[.)]\s/.test(lines[i]);
        if (isNestedList && nextIndent > baseIndent) {
          const isSubOl = /^[ \t]*\d+[.)]\s/.test(lines[i]);
          const [subItems, newI] = parseListItems(lines, i);
          subHtml = `<${isSubOl ? "ol" : "ul"}>${subItems}</${isSubOl ? "ol" : "ul"}>`;
          i = newI;
        }
      }

      items.push(`<li>${prefix}${inline(content)}${subHtml}</li>`);
    }

    return [items.join(""), i];
  }

  function processBlock(src) {
    if (!src.trim()) return "";
    const html = [];
    const lines = src.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Blank line
      if (!line.trim()) {
        html.push("");
        i++;
        continue;
      }

      // ATX heading
      const hm = line.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        html.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^[-*_]{3,}\s*$/.test(line)) {
        html.push("<hr>");
        i++;
        continue;
      }

      // Blockquote (with or without space after >)
      if (/^> ?/.test(line)) {
        const lines2 = [];
        while (i < lines.length && /^> ?/.test(lines[i])) {
          lines2.push(inline(lines[i].replace(/^> ?/, "")));
          i++;
        }
        html.push(`<blockquote><p>${lines2.join("<br>")}</p></blockquote>`);
        continue;
      }

      // Unordered list
      if (/^[*\-+] /.test(line)) {
        const [items, newI] = parseListItems(lines, i);
        html.push(`<ul>${items}</ul>`);
        i = newI;
        continue;
      }

      // Ordered list — preserve start number for lists that begin at non-1
      if (/^\d+[.)]\s/.test(line)) {
        const startNum = parseInt(line.match(/^(\d+)/)[1], 10);
        const [items, newI] = parseListItems(lines, i);
        const startAttr = startNum !== 1 ? ` start="${startNum}"` : "";
        html.push(`<ol${startAttr}>${items}</ol>`);
        i = newI;
        continue;
      }

      // GFM table: header row followed by separator row (| :--- | --- | ---: |)
      if (
        line.startsWith("|") &&
        i + 1 < lines.length &&
        /^\|[\s\-:|]+\|/.test(lines[i + 1])
      ) {
        const parseCells = (ln) => {
          const parts = ln.split("|");
          if (parts[0].trim() === "") parts.shift();
          if (parts.length && parts[parts.length - 1].trim() === "")
            parts.pop();
          return parts.map((c) => c.trim());
        };
        const headers = parseCells(line);
        i++; // skip to separator
        const aligns = parseCells(lines[i]).map((s) => {
          if (s.startsWith(":") && s.endsWith(":")) return "center";
          if (s.endsWith(":")) return "right";
          return "left";
        });
        i++; // skip to first data row
        const rows = [];
        while (
          i < lines.length &&
          lines[i].trim() &&
          lines[i].startsWith("|")
        ) {
          rows.push(parseCells(lines[i]));
          i++;
        }
        const thCells = headers
          .map(
            (h, j) =>
              `<th style="text-align:${aligns[j] || "left"}">${inline(h)}</th>`,
          )
          .join("");
        const bodyRows = rows
          .map(
            (r) =>
              `<tr>${r.map((c, j) => `<td style="text-align:${aligns[j] || "left"}">${inline(c)}</td>`).join("")}</tr>`,
          )
          .join("");
        html.push(
          `<div class="table-wrap"><table><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`,
        );
        continue;
      }

      // Paragraph — collect consecutive "normal" lines
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith("|") &&
        !/^[*\-+] /.test(lines[i]) &&
        !/^\d+[.)]\s/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^> ?/.test(lines[i]) &&
        !/^[-*_]{3,}\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        // If the paragraph contains box-drawing or 2+ arrow/diagram chars,
        // render as <pre> (monospace) to preserve alignment.
        const combined = para.join("\n");
        const isPreformatted =
          /[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/.test(
            combined,
          ) ||
          // Only treat as diagram if arrows have whitespace around them (diagram style)
          // e.g. "A → B" matches but an arrow inside prose does not
          (combined.match(/(?:^|[ \t])[←→↑↓↔↕⇐⇒⇑⇓⇔⇕⟵⟶⟷](?=[ \t]|$)/gm) || [])
            .length >= 2;
        if (isPreformatted) {
          html.push(`<pre class="plaintext">${esc(combined)}</pre>`);
        } else {
          html.push(`<p>${para.map((l) => inline(l)).join("<br>")}</p>`);
        }
      } else {
        // Fallback: line matched no block rule (e.g. orphan | line from a
        // multiline table cell). Render as text and advance to prevent an
        // infinite loop.
        html.push(`<p>${inline(lines[i])}</p>`);
        i++;
      }
    }
    return html.join("\n");
  }

  // Protect math from markdown mangling (applied per text segment, not code)
  function protectMath(text, protect) {
    return (
      text
        // Bare LaTeX environments: \begin{align}...\end{align} etc.
        .replace(/\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}/g, (raw) =>
          protect(raw),
        )
        // Display math: $$ and \[
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => protect(`$$${m}$$`))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => protect(`\\[${m}\\]`))
        // Inline math: \( and single $
        .replace(/\\\([\s\S]*?\\\)/g, (raw) => protect(raw))
        .replace(/(?<![\\$])\$([^$\n]+?)\$(?!\$)/g, (_, m) => protect(`$${m}$`))
    );
  }

  return function render(src) {
    if (!src) return "";

    // Stash for math placeholders — restored after markdown processing
    const stash = [];
    const protect = (raw) => {
      stash.push(raw);
      return `\x02${stash.length - 1}\x03`;
    };

    const out = [];
    // Language names can include +, #, -, . (e.g. c++, c#, html+css, .env)
    const FENCE = /^```([^\n`]*)\n([\s\S]*?)^```/gm;
    let last = 0,
      m;

    // Extract code fences FIRST so math inside code is never stashed
    while ((m = FENCE.exec(src)) !== null) {
      out.push(processBlock(protectMath(src.slice(last, m.index), protect)));
      const lang = m[1].trim();
      const code = m[2].replace(/\n$/, ""); // strip trailing newline before closing ```
      const copyBtn = `<button class="copy-btn" title="Copy code" aria-label="Copy code">
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
          <rect x="4" y="4" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
          <path d="M3 3H2a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.3"/>
        </svg>
      </button>`;
      out.push(
        `<pre${lang ? ` data-lang="${esc(lang)}"` : ""}>${copyBtn}<code>${esc(code)}</code></pre>`,
      );
      last = m.index + m[0].length;
    }
    out.push(processBlock(protectMath(src.slice(last), protect)));

    // Restore math placeholders — KaTeX will render them via renderMathInElement
    return out.join("\n").replace(/\x02(\d+)\x03/g, (_, i) => stash[+i]);
  };
})();

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = diffMs / 86_400_000;

  if (diffDays < 1)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7)
    return d.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  if (diffDays < 365)
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── ChatGPT assistant metadata helpers ───────────────────────────────────────

// Full local date + time for a ChatGPT assistant response header, e.g.
// "May 27, 2025 3:22 AM". Returns "Unknown" when no timestamp was exported.
function formatFullDateTime(ts) {
  if (!ts) return "Unknown";
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return "Unknown";
  const date = d.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

// Friendly display name for a ChatGPT model slug. Falls back to the raw slug so
// unknown/future models still show something meaningful; null → "Unknown".
const MODEL_DISPLAY_NAMES = {
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4-1": "GPT-4.1",
  "gpt-4-1-mini": "GPT-4.1 mini",
  "gpt-4-5": "GPT-4.5",
  "gpt-5": "GPT-5",
  "gpt-5-thinking": "GPT-5 Thinking",
  "gpt-5-t-mini": "GPT-5 Thinking mini",
  "gpt-5-auto-thinking": "GPT-5 Thinking",
  "o1": "o1",
  "o3": "o3",
  "o3-mini": "o3-mini",
  "o3-mini-high": "o3-mini-high",
  "o4-mini": "o4-mini",
  "o4-mini-high": "o4-mini-high",
  "research": "Deep Research",
  "text-davinci-002-render-sha": "GPT-3.5",
};

function modelDisplayName(slug) {
  if (!slug) return "Unknown";
  return MODEL_DISPLAY_NAMES[slug] || slug;
}

// Build the assistant header for a ChatGPT message. When the conversation
// belongs to a Custom GPT, `persona` (its name, or "Custom GPT" when unnamed) is
// shown first and prominently — replacing the generic "Assistant" identity —
// with the model and date kept as secondary context:
//   "Nyx · GPT-4o · May 27, 2025 3:22 AM"
function buildGptHeader(model, ts, persona) {
  const header = document.createElement("div");
  header.className = "message-role gpt-header";
  if (persona) {
    const personaEl = document.createElement("span");
    personaEl.className = "gpt-persona";
    personaEl.textContent = persona;
    header.appendChild(personaEl);
  }
  const modelEl = document.createElement("span");
  modelEl.className = "gpt-model";
  modelEl.textContent = modelDisplayName(model);
  const dateEl = document.createElement("span");
  dateEl.className = "gpt-date";
  dateEl.textContent = formatFullDateTime(ts);
  header.append(modelEl, dateEl);
  return header;
}

function updateGptHeader(header, model, ts) {
  if (!header) return;
  const modelEl = header.querySelector(".gpt-model");
  const dateEl = header.querySelector(".gpt-date");
  if (modelEl) modelEl.textContent = modelDisplayName(model);
  if (dateEl) dateEl.textContent = formatFullDateTime(ts);
}

// Build a collapsible "Thinking" accordion holding exported reasoning content.
// Returns null when there is no displayable reasoning (no empty accordions).
function buildThinkingAccordion(thinkingText) {
  const text = (thinkingText || "").trim();
  if (!text) return null;
  const wrap = document.createElement("div");
  wrap.className = "thinking-accordion";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "thinking-toggle";
  toggle.innerHTML =
    '<span class="thinking-caret">▸</span><span class="thinking-label">Thinking</span>';

  const content = document.createElement("div");
  content.className = "thinking-content message-body";
  content.hidden = true;
  content.innerHTML = md(sanitize(text));
  wireCodeCopy(content);

  toggle.addEventListener("click", () => {
    const open = wrap.classList.toggle("open");
    content.hidden = !open;
  });

  wrap.append(toggle, content);
  return wrap;
}

// The far-right Custom GPT label on the thread meta line: shows the gizmo ID
// until it is named, then the name. Double-click to rename it inline.
function buildGizmoLabelEl() {
  const g = state.activeGizmo;
  const el = document.createElement("span");
  el.className = "thread-meta-gizmo";
  el.textContent = g.name || g.id;
  el.title = g.name
    ? "Double-click to rename this Custom GPT"
    : "Double-click to name this Custom GPT";
  el.addEventListener("dblclick", () =>
    beginInlineGizmoRename(el, {
      gizmoId: g.id,
      currentName: g.name,
      count: g.count,
      rebuild: buildGizmoLabelEl,
      onSaved: async (newName) => {
        g.name = newName;
        if (state.activeId) await openConversation(state.activeId, null);
        if (state.activeSpecialView === "gizmos") await renderGizmosPanel();
      },
    }),
  );
  return el;
}

// The one warning shown before a Custom GPT name is saved, everywhere a rename
// happens. Resolves true on Okay.
function confirmGizmoRename(count) {
  return openConfirmDialog({
    message:
      "This will apply this Custom GPT's name to all conversations with the same ID.\n\n" +
      `There are currently ${count} conversations that have this Custom GPT ID.`,
    okLabel: "Okay",
    cancelLabel: "Cancel",
  });
}

// Shared inline rename: replace `labelEl` with a text box, type the name, and on
// commit show the warning before saving. Used by both the conversation header
// and the Custom GPTs manager so there is only one rename experience.
//   rebuild()      → returns a fresh label element to restore on cancel/no-change
//   onSaved(name)  → called after a successful save
function beginInlineGizmoRename(labelEl, { gizmoId, currentName, count, rebuild, onSaved }) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "thread-meta-gizmo-input";
  input.value = currentName || "";
  input.placeholder = "Name this Custom GPT";
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false; // guards Enter + blur both firing
  const restore = () => input.replaceWith(rebuild());

  async function commit() {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    restore();
    if (!newName || newName === (currentName || "")) return;
    const ok = await confirmGizmoRename(count);
    if (!ok) return;
    await apiRenameGizmo(gizmoId, newName);
    if (onSaved) await onSaved(newName);
  }
  function cancel() {
    if (finished) return;
    finished = true;
    restore();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", commit);
}

// A modal warning dialog (Cancel / Okay). Resolves true on Okay, false on
// Cancel or dismiss. `message` honors line breaks.
function openConfirmDialog({ message, okLabel = "Okay", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const msg = document.createElement("div");
    msg.className = "modal-message";
    msg.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement("button");
    okBtn.className = "modal-btn modal-btn-primary";
    okBtn.textContent = okLabel;
    buttons.append(cancelBtn, okBtn);
    modal.append(msg, buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let settled = false;
    const close = (val) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(val);
    };
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close(false);
      }
    });
    okBtn.focus();
  });
}

// Swap a message's Thinking accordion for one holding `text` (or remove it when
// there is nothing to show). Inserts before `bodyEl` so it stays above the
// answer. Returns the new accordion element (or null).
function replaceThinkingAccordion(container, bodyEl, existingEl, text) {
  const next = buildThinkingAccordion(text);
  if (existingEl) {
    if (next) existingEl.replaceWith(next);
    else existingEl.remove();
  } else if (next && bodyEl) {
    container.insertBefore(next, bodyEl);
  }
  return next;
}

// Re-run KaTeX over an element after its markdown was replaced.
function renderMathIn(el) {
  if (typeof renderMathInElement !== "function") return;
  renderMathInElement(el, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
    ],
    throwOnError: false,
  });
}

// ── File icon helper ──────────────────────────────────────────────────────────

function fileIcon(typeOrName) {
  const t = (typeOrName || "").toLowerCase();
  if (t.includes("pdf")) return "📄";
  if (t.match(/jpe?g|png|gif|webp|bmp|svg|heic/)) return "🖼️";
  if (t.match(/docx?|doc/)) return "📝";
  if (t.match(/xlsx?|csv/)) return "📊";
  if (t.match(/zip|tar|gz/)) return "🗜️";
  if (t.match(/mp[34]|mov|avi/)) return "🎬";
  return "📎";
}

// ── File content side panel ───────────────────────────────────────────────────

let _filePanelEl = null;

// ── In-thread search navigation state ────────────────────────────────────────
let _searchMatches = []; // [{seq, role}, ...]
let _searchMatchIdx = 0;

// Remove search nav bar and all in-thread highlights — call whenever search ends.
function clearSearchNav() {
  const bar = document.getElementById("search-nav-bar");
  if (bar) bar.remove();
  _searchMatches = [];
  _searchMatchIdx = 0;
  messagesEl
    .querySelectorAll(".msg-search-match, .msg-search-current")
    .forEach((el) =>
      el.classList.remove("msg-search-match", "msg-search-current"),
    );
  messagesEl.querySelectorAll("mark.search-term-highlight").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
}

async function buildSearchNavBar(convId, q) {
  clearSearchNav();
  if (!q) return;

  let matches = [];
  try {
    const r = await fetch(
      `/api/search-in-conversation?conv_id=${encodeURIComponent(convId)}&q=${encodeURIComponent(q)}`,
    );
    const data = await r.json();
    matches = data.matches || [];
  } catch (_) {}

  _searchMatches = matches;
  _searchMatchIdx = 0;
  if (!matches.length) return;

  // Highlight all matching message divs
  for (const m of matches) {
    const el = messagesEl.querySelector(`[data-seq="${m.seq}"]`);
    if (el) el.classList.add("msg-search-match");
  }

  // Build nav bar and insert above #messages inside #thread
  const navBar = document.createElement("div");
  navBar.id = "search-nav-bar";
  navBar.innerHTML = `
    <span id="search-nav-term">"${escHtml(q)}"</span>
    <span id="search-nav-count">${matches.length} messages matched</span>
    <button id="search-nav-prev" title="Previous">↑</button>
    <span id="search-nav-pos">1/${matches.length}</span>
    <button id="search-nav-next" title="Next">↓</button>
    <button id="search-nav-close" title="Close search navigation">✕</button>`;
  thread.insertBefore(navBar, messagesEl);

  navBar.querySelector("#search-nav-prev").addEventListener("click", () => {
    _searchMatchIdx =
      (_searchMatchIdx - 1 + _searchMatches.length) % _searchMatches.length;
    scrollToSearchMatch(_searchMatchIdx);
  });
  navBar.querySelector("#search-nav-next").addEventListener("click", () => {
    _searchMatchIdx = (_searchMatchIdx + 1) % _searchMatches.length;
    scrollToSearchMatch(_searchMatchIdx);
  });
  navBar.querySelector("#search-nav-close").addEventListener("click", () => {
    clearSearchNav();
  });

  // Scroll to first match
  scrollToSearchMatch(0);
}

// Highlight all occurrences of `term` inside a DOM element using text-node walking.
// Returns an array of <mark> elements added (for later cleanup).
function highlightTextInEl(el, term) {
  if (!term) return [];
  const marks = [];
  const lower = term.toLowerCase();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const nodesToProcess = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.toLowerCase().includes(lower)) nodesToProcess.push(node);
  }
  for (const textNode of nodesToProcess) {
    const text = textNode.nodeValue;
    const ltext = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let last = 0,
      pos;
    while ((pos = ltext.indexOf(lower, last)) !== -1) {
      if (pos > last)
        frag.appendChild(document.createTextNode(text.slice(last, pos)));
      const mark = document.createElement("mark");
      mark.className = "search-term-highlight";
      mark.textContent = text.slice(pos, pos + term.length);
      frag.appendChild(mark);
      marks.push(mark);
      last = pos + term.length;
    }
    if (last < text.length)
      frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return marks;
}

function scrollToSearchMatch(idx) {
  if (!_searchMatches.length) return;
  const posEl = document.getElementById("search-nav-pos");
  if (posEl) posEl.textContent = `${idx + 1}/${_searchMatches.length}`;

  const prevBtn = document.getElementById("search-nav-prev");
  const nextBtn = document.getElementById("search-nav-next");
  if (prevBtn) prevBtn.disabled = idx === 0;
  if (nextBtn) nextBtn.disabled = idx === _searchMatches.length - 1;

  // Remove current-message highlight
  messagesEl
    .querySelectorAll(".msg-search-current")
    .forEach((el) => el.classList.remove("msg-search-current"));

  // Remove previous inline text highlights (unwrap <mark> nodes)
  messagesEl.querySelectorAll("mark.search-term-highlight").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });

  const m = _searchMatches[idx];
  const el = messagesEl.querySelector(`[data-seq="${m.seq}"]`);
  if (!el) return;

  el.classList.add("msg-search-current");

  // Highlight matching text inside this message body
  const bodyEl = el.querySelector(".message-body");
  if (bodyEl && state.q) {
    const marks = highlightTextInEl(bodyEl, state.q);
    // Update count label to show occurrences in this message
    const countEl = document.getElementById("search-nav-count");
    if (countEl && marks.length > 0) {
      countEl.textContent = `${_searchMatches.length} messages · ${marks.length} here`;
    } else if (countEl) {
      countEl.textContent = `${_searchMatches.length} messages matched`;
    }
    // Scroll first <mark> into view after the container scroll
    if (marks.length) {
      setTimeout(() => {
        marks[0].scrollIntoView({ block: "nearest" });
      }, 350);
    }
  }

  // getBoundingClientRect: works regardless of position/sticky/offsetParent
  const cRect = messagesEl.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const absTop = eRect.top - cRect.top + messagesEl.scrollTop;
  const target = absTop - (messagesEl.clientHeight - el.offsetHeight) / 2;
  messagesEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

function _ensureFilePanel() {
  if (_filePanelEl) return _filePanelEl;
  const panel = document.createElement("div");
  panel.id = "file-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div id="file-panel-resize"></div>
    <div id="file-panel-header">
      <span id="file-panel-name"></span>
      <button id="file-panel-close" title="Close">✕</button>
    </div>
    <div id="file-panel-body"></div>`;
  document.getElementById("main").appendChild(panel);
  panel
    .querySelector("#file-panel-close")
    .addEventListener("click", closeFilePanel);

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  const handle = panel.querySelector("#file-panel-resize");
  let dragging = false,
    startX = 0,
    startW = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX; // moving left → wider
    const w = Math.max(240, Math.min(700, startW + delta));
    panel.style.width = w + "px";
    const thread = document.getElementById("thread");
    if (thread.classList.contains("with-file-panel")) {
      thread.querySelector("#messages").style.paddingRight = w + 20 + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  _filePanelEl = panel;
  return panel;
}

function openFilePanel(att) {
  closeArtifactPanel(); // mutual exclusion — only one side panel at a time
  const panel = _ensureFilePanel();
  panel.querySelector("#file-panel-name").textContent = att.name;
  const body = panel.querySelector("#file-panel-body");
  body.innerHTML = md(att.content);
  panel.hidden = false;
  document.getElementById("thread").classList.add("with-file-panel");
  // Sync padding-right to actual panel width (may have been custom-resized)
  messagesEl.style.paddingRight = panel.offsetWidth + 20 + "px";
}

function closeFilePanel() {
  if (_filePanelEl) _filePanelEl.hidden = true;
  document.getElementById("thread").classList.remove("with-file-panel");
  messagesEl.style.paddingRight = ""; // clear any inline override from drag
}

// ── Month grouping tracking ───────────────────────────────────────────────────
let _lastSeenMonth = null;

function _monthLabel(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

// ── File chip helpers ─────────────────────────────────────────────────────────

function wireCodeCopy(root) {
  root.querySelectorAll("pre .copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.closest("pre").querySelector("code");
      navigator.clipboard.writeText(code.innerText).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1800);
      });
    });
  });
}

const _IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
  "heif",
]);

function _fileUrl(att) {
  if (!att.name) return null;
  // Normalize: lowercase + spaces→underscores to match downloaded filenames
  const norm = _normName(att.name);
  const realName = _localFilesMap.get(norm);
  if (realName) return "/files/" + encodeURIComponent(realName);
  return null;
}

// Returns an <img> element if the attachment is an image available locally,
// otherwise null.
function tryInlineImage(att) {
  const ext = (att.type || "").toLowerCase().replace(/^\./, "");
  if (!_IMAGE_EXTS.has(ext)) return null;
  const url = _fileUrl(att);
  if (!url) return null;
  const img = document.createElement("img");
  img.src = url;
  img.alt = att.name;
  img.className = "inline-image";
  img.loading = "lazy";
  // Open lightbox on click
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    openImageLightbox(url, att.name);
  });
  return img;
}

function openImageLightbox(url, name) {
  let lb = document.getElementById("img-lightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "img-lightbox";
    lb.innerHTML = `<div id="img-lightbox-bg"></div>
      <div id="img-lightbox-content">
        <button id="img-lightbox-close">✕</button>
        <img id="img-lightbox-img" src="" alt="">
        <div id="img-lightbox-name"></div>
      </div>`;
    document.body.appendChild(lb);
    lb.querySelector("#img-lightbox-bg").addEventListener("click", () => {
      lb.hidden = true;
    });
    lb.querySelector("#img-lightbox-close").addEventListener("click", () => {
      lb.hidden = true;
    });
  }
  lb.querySelector("#img-lightbox-img").src = url;
  lb.querySelector("#img-lightbox-img").alt = name;
  lb.querySelector("#img-lightbox-name").textContent = name;
  lb.hidden = false;
}

function createChipsEl(attachments) {
  const chipsEl = document.createElement("div");
  chipsEl.className = "file-chips";
  for (const att of attachments) {
    const ext = (att.type || "").toLowerCase().replace(/^\./, "");
    const isImage = _IMAGE_EXTS.has(ext);
    const localUrl = _fileUrl(att);

    if (att.content) {
      // Text / extracted content → open in side panel
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "file-chip";
      chip.innerHTML = `<span class="chip-icon">${fileIcon(att.type || att.name)}</span><span class="chip-name">${escHtml(att.name)}</span>`;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openFilePanel(att);
      });
      chipsEl.appendChild(chip);
    } else if (isImage && localUrl) {
      // Image available locally → don't show chip (shown inline already), skip
      // (chip is only shown when inline rendering fails, handled by caller)
      continue;
    } else if (localUrl) {
      // Non-image file available locally → open in side panel
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "file-chip file-chip-download";
      chip.title = "Click to view file contents";
      chip.innerHTML = `<span class="chip-icon">${fileIcon(att.type || att.name)}</span><span class="chip-name">${escHtml(att.name)}</span>`;
      chip.addEventListener("click", async (e) => {
        e.stopPropagation();
        chip.disabled = true;
        try {
          const realName = _localFilesMap.get(_normName(att.name)) || att.name;
          const r = await fetch(
            "/api/file-content?name=" + encodeURIComponent(realName),
          );
          const data = await r.json();
          if (data.error) {
            alert(data.error);
            return;
          }
          openFilePanel({
            name: att.name,
            content: data.content || "",
            type: att.type,
          });
        } finally {
          chip.disabled = false;
        }
      });
      chipsEl.appendChild(chip);
    } else {
      // Not available — show unavailable chip with tooltip
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "file-chip file-chip-no-content";
      const tooltip = isImage
        ? "Image not included in the Claude export (original file cannot be recovered)"
        : "File content not included in the Claude export (original file cannot be recovered)";
      chip.title = tooltip;
      chip.innerHTML = `<span class="chip-icon">${fileIcon(att.type || att.name)}</span><span class="chip-name">${escHtml(att.name)}</span><span class="chip-unavail">⚠</span>`;
      chipsEl.appendChild(chip);
    }
  }
  return chipsEl;
}

// Render inline images for a message's attachments, returns a fragment (may be empty)
function createInlineImagesEl(attachments) {
  const wrap = document.createDocumentFragment();
  for (const att of attachments) {
    const img = tryInlineImage(att);
    if (img) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "inline-image-wrap";
      imgWrap.appendChild(img);
      wrap.appendChild(imgWrap);
    }
  }
  return wrap;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function apiConversations(q, offset, signal) {
  const p = new URLSearchParams({
    limit: 50,
    offset,
    view: state.view,
    pinned_first: state.view === "recent" ? "1" : "0",
  });
  if (q) p.set("q", q);
  if (state.source) p.set("source", state.source);
  const r = await fetch(`/api/conversations?${p}`, { signal });
  return r.json();
}

async function apiPreferences() {
  const r = await fetch("/api/preferences");
  return r.json();
}

async function apiUpdatePreferences(preferences) {
  const r = await fetch("/api/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences }),
  });
  return r.json();
}

async function apiPinnedList() {
  const r = await fetch("/api/pinned");
  return r.json();
}

async function apiPinConversation(conversationId) {
  const r = await fetch("/api/pinned", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId }),
  });
  return r.json();
}

async function apiUnpinConversation(conversationId) {
  const r = await fetch(`/api/pinned/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  });
  return r.json();
}

async function apiReorderPinned(ids) {
  const r = await fetch("/api/pinned/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return r.json();
}

async function apiUpdateConversationMeta(conversationId, payload) {
  const r = await fetch(
    `/api/conversation/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return r.json();
}

async function apiTabs() {
  const r = await fetch("/api/tabs");
  return r.json();
}

async function apiCreateTab(payload) {
  const r = await fetch("/api/tabs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function apiUpdateTab(id, payload) {
  const r = await fetch(`/api/tabs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function apiDeleteTab(id) {
  const r = await fetch(`/api/tabs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return r.json();
}

async function apiSearch(q) {
  const p = new URLSearchParams({ q, limit: 40 });
  if (state.source) p.set("source", state.source);
  const r = await fetch(`/api/search?${p}`);
  return r.json();
}

async function apiConversation(id) {
  const r = await fetch(`/api/conversation/${encodeURIComponent(id)}`);
  return r.json();
}

async function apiGizmos() {
  const r = await fetch("/api/gizmos");
  return r.json();
}

async function apiRenameGizmo(gizmoId, name) {
  const r = await fetch(`/api/gizmos/${encodeURIComponent(gizmoId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return r.json();
}

async function apiGizmoMoveToFolder(gizmoId, { folderId, folderName }) {
  const r = await fetch(`/api/gizmos/${encodeURIComponent(gizmoId)}/folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder_id: folderId, folder_name: folderName }),
  });
  return r.json();
}

// ── Highlight query terms in a text snippet ───────────────────────────────────
function highlightSnippet(text, q) {
  if (!q || !text) return escHtml(text || "");
  const safe = escHtml(text);
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(escaped, "gi"), (m) => `<mark>${m}</mark>`);
}

// ── Render full-text search results in sidebar ───────────────────────────────
function renderSearchResults(results, q) {
  convList.innerHTML = "";
  if (!results.length) {
    convList.innerHTML = '<div class="no-results">No matches</div>';
    return;
  }
  // Group by conv_id
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.conv_id))
      groups.set(r.conv_id, { title: r.conv_title, hits: [] });
    groups.get(r.conv_id).hits.push(r);
  }
  for (const [convId, { title, hits }] of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "search-group";
    const titleEl = document.createElement("div");
    titleEl.className = "search-group-title";
    titleEl.textContent = title;
    groupEl.appendChild(titleEl);
    for (const hit of hits) {
      const hitEl = document.createElement("div");
      hitEl.className =
        "search-hit" + (hit.role === "user" ? " search-hit-user" : "");
      const roleLabel = hit.role === "user" ? "You" : "Claude";
      hitEl.innerHTML = `<span class="search-hit-role">${roleLabel}</span><span class="search-hit-snippet">${highlightSnippet(hit.snippet, q)}</span>`;
      hitEl.addEventListener("click", () =>
        openConversation(convId, resolveConversationSidebarEl(convId), hit.seq),
      );
      groupEl.appendChild(hitEl);
    }
    convList.appendChild(groupEl);
  }
}

// ── Render conversation list items ────────────────────────────────────────────

function buildConvActions(c) {
  const wrap = document.createElement("div");
  wrap.className = "conv-actions";

  const isPinned = state.pinnedIds.has(c.id);
  const pinBtn = document.createElement("button");
  pinBtn.className = "conv-action-btn";
  pinBtn.title = isPinned ? "Unpin" : "Pin";
  pinBtn.textContent = isPinned ? "★" : "☆";
  pinBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (state.pinnedIds.has(c.id)) await apiUnpinConversation(c.id);
    else await apiPinConversation(c.id);
    await refreshPinnedList();
    loadConversations(false);
  });

  const renameBtn = document.createElement("button");
  renameBtn.className = "conv-action-btn";
  renameBtn.title = "Rename";
  renameBtn.textContent = "✎";
  renameBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = await openNameModal({
      title: "Rename conversation",
      value: c.title || "",
    });
    if (!next || next === c.title) return;
    await apiUpdateConversationMeta(c.id, { title: next });
    loadConversations(false);
    refreshPinnedList();
    loadFolders();
  });

  const archiveBtn = document.createElement("button");
  archiveBtn.className = "conv-action-btn";
  const archivedView = state.view === "archived";
  const deletedView = state.view === "deleted";
  const restoreMode = archivedView || deletedView;
  archiveBtn.title = restoreMode ? "Restore" : "Archive";
  archiveBtn.textContent = restoreMode ? "↺" : "🗄";
  archiveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (deletedView) {
      await apiUpdateConversationMeta(c.id, { deleted: false });
    } else {
      await apiUpdateConversationMeta(c.id, { archived: !archivedView });
    }
    // Does this action remove the row from the CURRENT view? recent+archive,
    // archived+unarchive and deleted+undelete all do; "all" view keeps it.
    const leavesView =
      (state.view === "recent" && !restoreMode) || archivedView || deletedView;
    const wasPinned = state.pinnedIds.has(c.id);
    const itemEl = findConvItemEl(c.id);
    if (leavesView && itemEl && !state.q) {
      removeConvItemFromList(itemEl); // fast path: drop just this row
    } else {
      loadConversations(false); // fallback preserves prior behavior
    }
    if (wasPinned) refreshPinnedList();
  });

  wrap.append(pinBtn, renameBtn, archiveBtn);
  return wrap;
}

function appendListItems(convs, targetEl = convList) {
  for (const c of convs) {
    // ── Month section header ──────────────────────────────────────────────────
    const month = _monthLabel(c.update_time || c.create_time);
    if (month && month !== _lastSeenMonth) {
      _lastSeenMonth = month;
      const headerEl = document.createElement("div");
      headerEl.className = "month-header";
      headerEl.innerHTML = `<span class="month-label">${escHtml(month)}</span><span class="month-chevron">▾</span>`;
      headerEl.addEventListener("click", () => {
        const section = headerEl.nextElementSibling;
        if (!section?.classList.contains("month-section")) return;
        const collapsed = section.classList.toggle("month-collapsed");
        headerEl.querySelector(".month-chevron").textContent = collapsed
          ? "▸"
          : "▾";
      });
      targetEl.appendChild(headerEl);
      const sectionEl = document.createElement("div");
      sectionEl.className = "month-section";
      targetEl.appendChild(sectionEl);
    }

    const el = document.createElement("div");
    el.className = "conv-item" + (c.id === state.activeId ? " active" : "");
    el.dataset.id = c.id;
    el.draggable = true; // drag into a folder
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", c.id);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));

    const snippet = (c.preview || c.snippet || "").trim();
    const top = document.createElement("div");
    top.className = "conv-top-row";
    top.innerHTML = `<div class="conv-title">${escHtml(c.title)}</div>`;
    top.appendChild(buildConvActions(c));

    el.innerHTML = `
      ${snippet ? `<div class="conv-snippet">${snippet}</div>` : ""}
      <div class="conv-footer">
        <span>${formatDate(c.update_time || c.create_time)}</span>
        <span>${c.message_count} msg${c.message_count !== 1 ? "s" : ""}</span>
      </div>`;
    el.insertBefore(top, el.firstChild);

    el.addEventListener("click", () => openConversation(c.id, el));

    // Append inside the current month section if one exists
    const lastChild = targetEl.lastElementChild;
    if (lastChild?.classList.contains("month-section")) {
      lastChild.appendChild(el);
    } else {
      targetEl.appendChild(el);
    }
  }
}

// ── Load / refresh conversation list ─────────────────────────────────────────

let _convListAbort = null;

// Find a conversation row in the main list by id (no querySelector escaping games).
function findConvItemEl(id) {
  return (
    Array.from(convList.querySelectorAll(".conv-item")).find(
      (el) => el.dataset.id === id,
    ) || null
  );
}

// Remove a single row from the list in place and keep the count/"Load more" in
// sync — used after archive/delete/restore so we don't tear down and refetch the
// entire list just to drop one row (that full rebuild is what felt like a freeze).
function removeConvItemFromList(el) {
  const section = el.parentElement;
  el.remove();
  if (
    section &&
    section.classList.contains("month-section") &&
    !section.children.length
  ) {
    const header = section.previousElementSibling;
    section.remove();
    if (header && header.classList.contains("month-header")) header.remove();
  }
  if (typeof state.total === "number" && state.total > 0) state.total -= 1;
  if (state.offset > 0) state.offset -= 1;
  if (!convList.querySelector(".conv-item")) {
    convList.innerHTML = '<div class="no-results">No conversations found.</div>';
  }
  if (!state.q) {
    const n = (state.total || 0).toLocaleString();
    resultCount.textContent = `${n} conversation${state.total !== 1 ? "s" : ""}`;
  }
  loadMoreWrap.hidden = state.offset >= state.total;
}

async function refreshPinnedList() {
  const data = await apiPinnedList();
  const pinned = data.pinned || [];
  state.pinnedIds = new Set(pinned.map((x) => x.conversation_id));
  if (pinnedTitleEl) pinnedTitleEl.textContent = `Pinned (${pinned.length})`;
  // The pinned conversations now live in the "Pinned" filter view, not a
  // separate top section. We still refresh state.pinnedIds above so the pin/
  // unpin stars stay correct; there's no dedicated pinned list to render.
  if (!pinnedList) return;
  pinnedList.innerHTML = "";
  for (const p of pinned) {
    const el = document.createElement("div");
    el.className =
      "conv-item" + (p.conversation_id === state.activeId ? " active" : "");
    el.dataset.id = p.conversation_id;
    el.draggable = true;
    const snippet = (p.preview || "").trim();
    const c = {
      id: p.conversation_id,
      title: p.title,
      update_time: p.update_time,
      create_time: p.update_time,
      message_count: p.message_count,
    };
    const top = document.createElement("div");
    top.className = "conv-top-row";
    top.innerHTML = `<div class="conv-title">${escHtml(p.title)}</div>`;
    top.appendChild(buildConvActions(c));
    el.appendChild(top);
    if (snippet) {
      const sn = document.createElement("div");
      sn.className = "conv-snippet";
      sn.textContent = snippet;
      el.appendChild(sn);
    }
    const ft = document.createElement("div");
    ft.className = "conv-footer";
    ft.innerHTML = `<span>${formatDate(p.update_time)}</span><span>${p.message_count} msgs</span>`;
    el.appendChild(ft);

    el.addEventListener("click", () => openConversation(p.conversation_id, el));

    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", p.conversation_id);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData("text/plain");
      const toId = p.conversation_id;
      if (!fromId || fromId === toId) return;
      const ids = [...pinnedList.querySelectorAll(".conv-item")].map(
        (n) => n.dataset.id,
      );
      const fromIdx = ids.indexOf(fromId);
      const toIdx = ids.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, fromId);
      await apiReorderPinned(ids);
      refreshPinnedList();
    });

    pinnedList.appendChild(el);
  }
}

function syncPinnedSectionVisibility() {
  if (!pinnedSection) return;
  // Keep pinned list focused on the default browsing mode to avoid duplicate
  // entries in archived/deleted/all views and during search-result browsing.
  const shouldShow = state.view === "recent" && !state.q;
  pinnedSection.hidden = !shouldShow;
  if (pinnedHintEl) pinnedHintEl.hidden = !shouldShow;
}

const VIEW_LABELS = {
  recent: "Recent",
  pinned: "Pinned",
  archived: "Archived",
  all: "All",
};

// The one list header reflects whichever view the dropdown has selected, so it
// never says "Recent" while showing Pinned/Archived/All results.
function updateListSectionTitle() {
  if (!listSectionTitle) return;
  listSectionTitle.textContent = state.q
    ? "Search results"
    : VIEW_LABELS[state.view] || "Recent";
}

async function loadUiPreferences() {
  const data = await apiPreferences();
  const p = data.preferences || {};
  state.preferences.sidebarCollapsed = Boolean(p.sidebarCollapsed);
  state.preferences.sidebarWidth = Number(p.sidebarWidth || 300);
  const savedView = String(p.conversationView || "recent");
  state.preferences.conversationView = [
    "recent",
    "pinned",
    "archived",
    "all",
  ].includes(savedView)
    ? savedView
    : "recent";
  state.preferences.searchHistory = Array.isArray(p.searchHistory)
    ? p.searchHistory.slice(0, 20)
    : [];
  if (p.source === "claude" || p.source === "chatgpt") {
    state.preferences.source = p.source;
  }
  state.scrollByConversation =
    p.scrollByConversation && typeof p.scrollByConversation === "object"
      ? p.scrollByConversation
      : {};
  state.view = state.preferences.conversationView;
  if (viewFilterEl) viewFilterEl.value = state.view;
  updateListSectionTitle();
  document.documentElement.style.setProperty(
    "--sidebar-w",
    `${Math.max(220, Math.min(520, state.preferences.sidebarWidth))}px`,
  );
  document.body.classList.toggle(
    "sidebar-collapsed",
    state.preferences.sidebarCollapsed,
  );
  syncPinnedSectionVisibility();
}

function renderSearchHistory() {
  if (!searchHistoryListEl) return;
  searchHistoryListEl.innerHTML = "";
  for (const q of state.preferences.searchHistory || []) {
    const opt = document.createElement("option");
    opt.value = q;
    searchHistoryListEl.appendChild(opt);
  }
}

function rememberSearchQuery(q) {
  const query = String(q || "").trim();
  if (!query) return;
  const old = state.preferences.searchHistory || [];
  state.preferences.searchHistory = [
    query,
    ...old.filter((x) => x !== query),
  ].slice(0, 20);
  renderSearchHistory();
}

async function saveUiPreferences(partial) {
  state.preferences = { ...state.preferences, ...partial };
  await apiUpdatePreferences(state.preferences);
}

function getTabById(tabId) {
  return state.tabs.find((tab) => tab.id === tabId) || null;
}

function isSpecialTab(tab) {
  return false;
}

function isTopTab(tab) {
  return (
    !!tab && (tab.tab_type === "conversation" || tab.tab_type === "artifact")
  );
}

function rememberReturnTab(tabId = state.activeTabId) {
  const tab = getTabById(tabId);
  if (isTopTab(tab)) {
    state.specialReturnTabId = tab.id;
  }
}

function resolveReturnTabId(excludeTabId = null) {
  const remembered = getTabById(state.specialReturnTabId);
  if (remembered && remembered.id !== excludeTabId) return remembered.id;
  const fallback = state.tabs.find(
    (tab) => isTopTab(tab) && tab.id !== excludeTabId,
  );
  return fallback?.id || null;
}

async function closeTabAndFocusFallback(tabId) {
  const tab = getTabById(tabId);
  if (!tab) return;
  const wasActive = state.activeTabId === tabId;
  const fallbackId = isSpecialTab(tab)
    ? resolveReturnTabId(tabId)
    : state.tabs.find((candidate) => candidate.id !== tabId)?.id || null;

  await apiDeleteTab(tabId);
  state.tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
  if (state.specialReturnTabId === tabId) {
    state.specialReturnTabId = null;
  }

  if (wasActive) {
    state.activeTabId = fallbackId;
    if (fallbackId) {
      await activateActiveTab();
    } else {
      hideAllPanels();
      emptyState.hidden = false;
    }
  }
  renderTabs();
}

async function activateTab(tabId) {
  state.activeTabId = tabId;
  rememberReturnTab(tabId);
  await apiUpdateTab(tabId, { last_active_at: Date.now() / 1000 });
  await activateActiveTab();
  renderTabs();
}

function renderTabs() {
  tabsList.innerHTML = "";
  const tabsToRender = state.tabs.filter(isTopTab);
  for (const t of tabsToRender) {
    const tab = document.createElement("div");
    tab.className = "top-tab" + (t.id === state.activeTabId ? " active" : "");
    tab.setAttribute("role", "button");
    tab.setAttribute("tabindex", "0");
    tab.innerHTML = `<span class="tab-label">${escHtml(t.title || "Untitled")}</span><button type="button" class="tab-pin" title="Pin tab">${t.pinned ? "📌" : "📍"}</button><button type="button" class="tab-close" title="Close">×</button>`;
    tab.querySelector(".tab-pin").addEventListener("click", async (e) => {
      e.stopPropagation();
      t.pinned = t.pinned ? 0 : 1;
      await apiUpdateTab(t.id, { pinned: Boolean(t.pinned) });
      renderTabs();
    });
    tab.querySelector(".tab-close").addEventListener("click", async (e) => {
      e.stopPropagation();
      await closeTabAndFocusFallback(t.id);
    });
    tab.addEventListener("click", async () => {
      await activateTab(t.id);
    });
    tab.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      await activateTab(t.id);
    });
    tabsList.appendChild(tab);
  }
}

async function loadTabs() {
  const data = await apiTabs();
  state.tabs = (data.tabs || []).filter(isTopTab);
  if (!state.tabs.length) {
    state.activeTabId = null;
    renderTabs();
    return;
  }
  if (!state.activeTabId || !getTabById(state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
  }
  renderTabs();
}

async function ensureConversationTab(convId, title) {
  let tab = state.tabs.find(
    (t) => t.tab_type === "conversation" && t.conversation_id === convId,
  );
  if (!tab) {
    const created = await apiCreateTab({
      tab_type: "conversation",
      conversation_id: convId,
      title: title || "Conversation",
    });
    tab = {
      id: created.id,
      tab_type: "conversation",
      conversation_id: convId,
      title: title || "Conversation",
    };
    state.tabs.push(tab);
  }
  state.activeTabId = tab.id;
  rememberReturnTab(tab.id);
  renderTabs();
}

async function ensureSpecialTab(tabType, title) {
  state.activeSpecialView = tabType;
  if (!isTopTab(getTabById(state.activeTabId))) {
    state.specialReturnTabId = resolveReturnTabId();
  }
  state.activeTabId = null;
  renderTabs();
}

async function openArtifactTab(artifactId, title) {
  state.activeSpecialView = null;
  let tab = state.tabs.find(
    (t) => t.tab_type === "artifact" && t.artifact_id === artifactId,
  );
  if (!tab) {
    const created = await apiCreateTab({
      tab_type: "artifact",
      artifact_id: artifactId,
      title: title || "Artifact",
    });
    tab = {
      id: created.id,
      tab_type: "artifact",
      artifact_id: artifactId,
      title: title || "Artifact",
    };
    state.tabs.push(tab);
  }
  state.activeTabId = tab.id;
  rememberReturnTab(tab.id);
  renderTabs();
  await activateActiveTab();
}

async function renderArtifactTabContent(artifactId, title) {
  hideAllPanels();
  thread.hidden = false;
  closeArtifactPanel();
  state.activeSpecialView = null;
  threadTitle.textContent = title || artifactId;
  threadMeta.textContent = "Artifact tab";
  messagesEl.innerHTML = '<div class="loading">Loading…</div>';
  const data = await fetch(
    `/api/artifact/${encodeURIComponent(artifactId)}`,
  ).then((r) => r.json());
  messagesEl.innerHTML = "";
  if (!data || !data.content) {
    messagesEl.innerHTML = '<div class="no-results">No content</div>';
    return;
  }
  if (data.conv_id) {
    const sourceEl = resolveConversationSidebarEl(data.conv_id);
    document
      .querySelectorAll(".conv-item.active")
      .forEach((el) => el.classList.remove("active"));
    if (sourceEl) sourceEl.classList.add("active");
    state.activeId = data.conv_id;

    const sourceTitle =
      sourceEl?.querySelector(".conv-title")?.textContent || data.conv_id;
    threadMeta.innerHTML = "";
    const metaLabel = document.createElement("span");
    metaLabel.textContent = "Artifact tab";
    const sourceBtn = document.createElement("button");
    sourceBtn.type = "button";
    sourceBtn.className = "artifact-source-link";
    sourceBtn.textContent = `Source: ${sourceTitle}${data.msg_seq != null ? ` · msg #${data.msg_seq}` : ""}`;
    sourceBtn.addEventListener("click", () => {
      openConversation(
        data.conv_id,
        resolveConversationSidebarEl(data.conv_id),
        data.msg_seq != null ? data.msg_seq : null,
      );
    });
    threadMeta.append(metaLabel, sourceBtn);
  }
  const wrap = document.createElement("div");
  wrap.className = "message assistant";
  const roleEl = document.createElement("div");
  roleEl.className = "message-role";
  roleEl.textContent = "Code";
  const bodyEl = document.createElement("div");
  bodyEl.className = "message-body";
  if (data.type === "application/vnd.ant.code" || data.lang) {
    bodyEl.innerHTML = md(`\`\`\`${data.lang || ""}\n${data.content}\n\`\`\``);
  } else {
    bodyEl.innerHTML = md(sanitize(data.content));
  }
  wireCodeCopy(bodyEl);
  if (typeof renderMathInElement === "function") {
    renderMathInElement(bodyEl, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  }
  wrap.append(roleEl, bodyEl);
  messagesEl.appendChild(wrap);
}

async function activateActiveTab() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) {
    if (state.activeSpecialView === "gallery") return openGallery(false);
    if (state.activeSpecialView === "memories") return openMemories(false);
    if (state.activeSpecialView === "projects") return openProjects(false);
    if (state.activeSpecialView === "attachment_report")
      return openAttReport(false, false);
    if (state.activeSpecialView === "import_audit")
      return openImportAudit(false);
    if (state.activeSpecialView === "gizmos") return openGizmos(false);
    hideAllPanels();
    emptyState.hidden = false;
    return;
  }
  if (tab.tab_type === "conversation" && tab.conversation_id) {
    openConversation(
      tab.conversation_id,
      resolveConversationSidebarEl(tab.conversation_id),
    );
    return;
  }
  if (tab.tab_type === "artifact" && tab.artifact_id) {
    rememberReturnTab(tab.id);
    await renderArtifactTabContent(
      tab.artifact_id,
      tab.title || tab.artifact_id,
    );
    return;
  }
}

async function loadConversations(append = false) {
  // Cancel any in-flight request
  if (_convListAbort) {
    _convListAbort.abort();
  }
  _convListAbort = new AbortController();
  const { signal } = _convListAbort;

  if (!append) {
    convList.innerHTML = '<div class="loading">Loading…</div>';
    state.offset = 0;
    _lastSeenMonth = null;
  }

  try {
    const data = await apiConversations(state.q, state.offset, signal);
    state.total = data.total;
    state.offset += (data.conversations || []).length;

    if (!append) convList.innerHTML = "";

    if (!data.conversations?.length && !append) {
      convList.innerHTML =
        '<div class="no-results">No conversations found.</div>';
    } else {
      appendListItems(data.conversations || []);
    }

    if (state.q) {
      const n = (data.total || 0).toLocaleString();
      resultCount.textContent = `${n} matches`;
    } else {
      const n = state.total.toLocaleString();
      resultCount.textContent = `${n} conversation${state.total !== 1 ? "s" : ""}`;
    }

    loadMoreWrap.hidden = state.offset >= state.total;
  } catch (e) {
    if (e.name === "AbortError") return; // cancelled — ignore silently
    convList.innerHTML = '<div class="no-results">Failed to load. Please try again.</div>';
  }
}

// ── Helper: hide all main panels ─────────────────────────────────────────────

function hideAllPanels() {
  emptyState.hidden = true;
  thread.hidden = true;
  galleryPanel.hidden = true;
  memoriesPanel.hidden = true;
  projectsPanel.hidden = true;
  attReportPanel.hidden = true;
  importAuditPanel.hidden = true;
  if (gizmosPanel) gizmosPanel.hidden = true;
  closeArtifactPanel();
  closeFilePanel();
  clearSearchNav();
}

// ── Artifact side panel ───────────────────────────────────────────────────────

function closeArtifactPanel() {
  artifactPanel.hidden = true;
  thread.classList.remove("with-artifact");
  messagesEl.style.paddingRight = "";
}

async function openArtifactPanel(artifactId, title) {
  closeFilePanel(); // mutual exclusion — only one side panel at a time
  artifactPanelTitle.textContent = title || artifactId;
  artifactPanelBody.innerHTML = '<div class="loading">Loading…</div>';
  artifactPanel.hidden = false;
  thread.classList.add("with-artifact");

  const data = await fetch(
    `/api/artifact/${encodeURIComponent(artifactId)}`,
  ).then((r) => r.json());
  artifactPanelBody.innerHTML = "";

  if (!data || !data.content) {
    artifactPanelBody.innerHTML = '<div class="no-results">No content</div>';
    return;
  }

  const isCode = data.type === "application/vnd.ant.code" || data.lang;
  const bodyEl = document.createElement("div");
  bodyEl.className = "message-body artifact-panel-content";

  if (isCode) {
    const lang = data.lang || "";
    bodyEl.innerHTML = md("```" + lang + "\n" + data.content + "\n```");
  } else if (data.type === "text/html") {
    // Show source, don't execute
    bodyEl.innerHTML = md("```html\n" + data.content + "\n```");
  } else {
    bodyEl.innerHTML = md(sanitize(data.content));
  }

  wireCodeCopy(bodyEl);
  if (typeof renderMathInElement === "function") {
    renderMathInElement(bodyEl, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  }
  artifactPanelBody.appendChild(bodyEl);
}

$("artifact-panel-close").addEventListener("click", closeArtifactPanel);

// ── Artifact panel drag-to-resize ─────────────────────────────────────────────
{
  const panel = artifactPanel;
  const handle = $("artifact-panel-resize");
  let dragging = false,
    startX = 0,
    startW = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX; // drag left → wider
    const w = Math.max(280, Math.min(700, startW + delta));
    panel.style.width = w + "px";
    if (thread.classList.contains("with-artifact")) {
      messagesEl.style.paddingRight = w + 20 + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ── Artifact chips for assistant messages ─────────────────────────────────────

function createArtifactChips(artifactIds, artifactsMeta) {
  if (!artifactIds?.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "artifact-chips";
  for (const id of artifactIds) {
    const meta = artifactsMeta?.[id];
    if (!meta) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "artifact-chip";
    const icon =
      meta.type === "application/vnd.ant.code"
        ? "⚙️"
        : meta.type === "text/html"
          ? "🌐"
          : meta.type === "image/svg+xml"
            ? "🖼️"
            : "📄";
    chip.innerHTML = `<span class="chip-icon">${icon}</span><span class="chip-name">${escHtml(meta.title || id)}</span>`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openArtifactTab(id, meta.title || id);
    });
    wrap.appendChild(chip);
  }
  return wrap.childElementCount ? wrap : null;
}

// ── Open a conversation ───────────────────────────────────────────────────────

async function openConversation(id, clickedEl, targetSeq = null) {
  state.activeSpecialView = null;
  // Update sidebar selection (main list and folder tree)
  document
    .querySelectorAll(".conv-item.active, .folder-conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  if (clickedEl) clickedEl.classList.add("active");
  state.activeId = id;

  // Show thread panel, clear previous content
  hideAllPanels();
  if (!state.q) clearSearchNav(); // remove stale nav bar when no search active
  thread.hidden = false;
  messagesEl.innerHTML = '<div class="loading">Loading…</div>';
  threadTitle.textContent = "";
  threadMeta.textContent = "";

  const data = await apiConversation(id);
  if (data.error) {
    messagesEl.innerHTML = `<div class="no-results">Error: ${escHtml(data.error)}</div>`;
    return;
  }

  const { conversation: conv, messages, artifacts: artifactsMeta = {} } = data;

  threadTitle.textContent = conv.title;
  const ts = formatDate(conv.update_time || conv.create_time);

  // Meta line: date · N messages · every model used in the conversation. The
  // models stretch across; the Custom GPT id/name sits at the far right.
  threadMeta.innerHTML = "";
  const metaLeft = document.createElement("span");
  metaLeft.className = "thread-meta-left";
  let metaText = `${ts} · ${conv.message_count} messages`;
  const models = Array.isArray(conv.models) ? conv.models : [];
  const modelLabels = models.map((m) =>
    conv.source === "chatgpt" ? modelDisplayName(m) : m,
  );
  if (modelLabels.length) metaText += ` · ${modelLabels.join(", ")}`;
  metaLeft.textContent = metaText;
  threadMeta.appendChild(metaLeft);

  // Custom GPT identity for this conversation. Until the gizmo is named, the
  // far-right label shows its ID; once named it shows the name. Double-click to
  // rename it (applies to every conversation with the same gizmo).
  if (conv.gizmo_id) {
    state.activeGizmo = {
      id: conv.gizmo_id,
      name: conv.gizmo_name || "",
      type: conv.gizmo_type || "",
      count: conv.gizmo_conversation_count || 0,
    };
    threadMeta.appendChild(buildGizmoLabelEl());
  } else {
    state.activeGizmo = null;
  }

  messagesEl.innerHTML = "";
  if (!messages.length) {
    // Metadata-only import: the record was kept for the audit, but the export
    // had no displayable human/assistant messages to show here.
    const note = document.createElement("div");
    note.className = "no-results";
    note.textContent =
      "This conversation has no displayable messages (metadata-only import).";
    messagesEl.appendChild(note);
  }
  for (const msg of messages) {
    const div = document.createElement("div");
    div.className = `message ${msg.role}`;
    if (msg.seq != null) div.dataset.seq = msg.seq;

    // ChatGPT messages carry per-message metadata (model, thinking) in msg.meta.
    const isCg = msg.meta && msg.meta.source === "chatgpt";
    const label =
      msg.role === "user"
        ? "You"
        : msg.role === "assistant"
          ? isCg
            ? "ChatGPT"
            : "Claude"
          : msg.role;

    // ── User file chips appear BEFORE message body ───────────────────────────
    let chipsEl = null;
    if (msg.role === "user" && msg.attachments?.length) {
      // Inline images first
      const inlineImgs = createInlineImagesEl(msg.attachments);
      if (inlineImgs.childNodes.length) div.appendChild(inlineImgs);
      chipsEl = createChipsEl(msg.attachments);
      if (chipsEl.children.length) div.appendChild(chipsEl);
      else chipsEl = null;
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "message-body";
    bodyEl.innerHTML = md(sanitize(msg.content || ""));
    wireCodeCopy(bodyEl);

    // Render math with KaTeX if available
    if (typeof renderMathInElement === "function") {
      renderMathInElement(bodyEl, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    }

    // ── Assistant metadata header ────────────────────────────────────────────
    // ChatGPT assistant responses get a rich header: "GPT-4o · <date time>".
    // Everything else keeps the plain role label.
    let roleEl;
    if (isCg && msg.role === "assistant") {
      // Only show a persona name once the user has named this Custom GPT.
      // Until then the assistant keeps its normal header (model + date) — the
      // gizmo is never labeled "Custom GPT" on the message itself.
      roleEl = buildGptHeader(
        msg.meta.model,
        msg.create_time,
        state.activeGizmo?.name || null,
      );
    } else {
      roleEl = document.createElement("div");
      roleEl.className = "message-role";
      roleEl.textContent = label;
    }
    div.insertBefore(roleEl, div.firstChild);

    // ── Thinking accordion (ChatGPT reasoning responses) ─────────────────────
    let thinkingEl = null;
    if (isCg && msg.role === "assistant") {
      thinkingEl = buildThinkingAccordion(msg.meta.thinking);
      if (thinkingEl) div.appendChild(thinkingEl);
    }

    div.appendChild(bodyEl);

    // ── Assistant-generated file chips appear AFTER body (like Claude's UI) ──
    if (msg.role === "assistant" && msg.attachments?.length) {
      const assistChips = createChipsEl(msg.attachments);
      if (assistChips.children.length) div.appendChild(assistChips);
    }

    // ── Artifact chips (assistant messages) ───────────────────────────────────
    if (msg.role === "assistant" && msg.artifact_ids?.length) {
      const artChips = createArtifactChips(msg.artifact_ids, artifactsMeta);
      if (artChips) div.appendChild(artChips);
    }

    // ── Branch / retry navigation (← N/M →) ─────────────────────────────────
    if (msg.siblings?.length > 1) {
      const total = msg.siblings.length;
      let curIdx = Math.max(
        0,
        Math.min((msg.branch_index || total) - 1, total - 1),
      );
      // Save original active branch so we can restore downstream visibility
      div._origBranchIdx = curIdx;

      const navEl = document.createElement("div");
      navEl.className = "branch-nav";

      const prevBtn = document.createElement("button");
      prevBtn.className = "branch-btn";
      prevBtn.type = "button";
      prevBtn.title = "Previous version";
      prevBtn.textContent = "←";

      const counterEl = document.createElement("span");
      counterEl.className = "branch-counter";
      counterEl.textContent = `${curIdx + 1} / ${total}`;

      const nextBtn = document.createElement("button");
      nextBtn.className = "branch-btn";
      nextBtn.type = "button";
      nextBtn.title = "Next version";
      nextBtn.textContent = "→";

      const updateBranch = (newIdx) => {
        curIdx = ((newIdx % total) + total) % total;
        counterEl.textContent = `${curIdx + 1} / ${total}`;
        const sib = msg.siblings[curIdx];

        // Update this message bubble (user text, or the ChatGPT assistant
        // variant's final answer)
        bodyEl.innerHTML = md(sanitize(sib.content || ""));
        wireCodeCopy(bodyEl);
        if (isCg) renderMathIn(bodyEl);

        // ChatGPT assistant reroll: refresh this variant's model/date header and
        // its Thinking accordion so each variant shows its own metadata.
        if (isCg && msg.role === "assistant") {
          updateGptHeader(roleEl, sib.model, sib.create_time);
          thinkingEl = replaceThinkingAccordion(div, bodyEl, thinkingEl, sib.thinking);
        }

        // Update the adjacent assistant response (for user-branch switching)
        if ("asst_content" in sib) {
          const nextMsgEl = div.nextElementSibling;
          if (nextMsgEl?.classList.contains("assistant")) {
            // Scoped to direct child so a Thinking accordion (also .message-body)
            // is never mistaken for the answer body.
            const nextBody = nextMsgEl.querySelector(":scope > .message-body");
            if (nextBody) {
              const ac = sib.asst_content || "";
              const noReply = isCg
                ? "(ChatGPT did not respond in this branch)"
                : "(Claude did not respond in this branch)";
              nextBody.innerHTML = ac
                ? md(sanitize(ac))
                : `<p class="branch-no-response">${noReply}</p>`;
              wireCodeCopy(nextBody);
              if (isCg) renderMathIn(nextBody);
            }
            // ChatGPT edited-user branch: refresh the paired assistant's header
            // and Thinking accordion from the sibling's assistant metadata.
            if (sib.asst_meta && sib.asst_meta.source === "chatgpt") {
              updateGptHeader(
                nextMsgEl.querySelector(".gpt-header"),
                sib.asst_meta.model,
                sib.asst_meta.create_time,
              );
              const existThink = nextMsgEl.querySelector(".thinking-accordion");
              replaceThinkingAccordion(
                nextMsgEl,
                nextBody,
                existThink,
                sib.asst_meta.thinking,
              );
            }
            // Update assistant artifact chips when user branch changes
            const newArtIds = sib.asst_artifact_ids || [];
            let existingArtChips = nextMsgEl.querySelector(".artifact-chips");
            if (newArtIds.length) {
              const newArtChips = createArtifactChips(newArtIds, artifactsMeta);
              if (existingArtChips && newArtChips)
                existingArtChips.replaceWith(newArtChips);
              else if (newArtChips) nextMsgEl.appendChild(newArtChips);
            } else if (existingArtChips) {
              existingArtChips.remove();
            }
          }
        }

        // For assistant-branch switching: update artifact chips on this div
        if (msg.role === "assistant") {
          const newArtIds = sib.artifact_ids || [];
          let existingArtChips = div.querySelector(".artifact-chips");
          if (newArtIds.length) {
            const newArtChips = createArtifactChips(newArtIds, artifactsMeta);
            if (existingArtChips && newArtChips)
              existingArtChips.replaceWith(newArtChips);
            else if (newArtChips) div.insertBefore(newArtChips, navEl);
          } else if (existingArtChips) {
            existingArtChips.remove();
          }
        }

        // Show downstream messages only when on the original active branch
        div._toggleDownstream?.(curIdx === div._origBranchIdx);

        // Update chips for user message branches
        if (msg.role === "user") {
          const newAtts = sib.attachments || [];
          if (chipsEl) {
            if (newAtts.length) {
              const newChips = createChipsEl(newAtts);
              chipsEl.replaceWith(newChips);
              chipsEl = newChips;
            } else {
              chipsEl.remove();
              chipsEl = null;
            }
          } else if (newAtts.length) {
            chipsEl = createChipsEl(newAtts);
            div.insertBefore(chipsEl, bodyEl);
          }
        }
        prevBtn.disabled = curIdx === 0;
        nextBtn.disabled = curIdx === total - 1;
      };

      prevBtn.addEventListener("click", () => updateBranch(curIdx - 1));
      nextBtn.addEventListener("click", () => updateBranch(curIdx + 1));
      prevBtn.disabled = curIdx === 0;
      nextBtn.disabled = curIdx === total - 1;

      navEl.append(prevBtn, counterEl, nextBtn);
      div.appendChild(navEl);
    }

    messagesEl.appendChild(div);
  }

  // Post-process: wire each branched USER div to hide/show its downstream messages.
  // Assistant branches only swap content — they never hide downstream.
  {
    const allDivs = Array.from(messagesEl.children);
    for (let i = 0; i < allDivs.length; i++) {
      const d = allDivs[i];
      if (d._origBranchIdx === undefined) continue;
      if (!d.classList.contains("user")) continue; // assistant branches: skip
      // Downstream = every sibling div after the immediate next assistant (i+2 onward)
      const downstream = allDivs.slice(i + 2);
      if (!downstream.length) continue;
      d._toggleDownstream = (show) => {
        downstream.forEach((el) => {
          el.style.display = show ? "" : "none";
        });
      };
    }
  }

  // Scroll thread to top (or to a target message)
  if (targetSeq != null) {
    const targetEl = messagesEl.querySelector(`[data-seq="${targetSeq}"]`);
    if (targetEl) {
      const cRect = messagesEl.getBoundingClientRect();
      const eRect = targetEl.getBoundingClientRect();
      const absTop = eRect.top - cRect.top + messagesEl.scrollTop;
      const target =
        absTop - (messagesEl.clientHeight - targetEl.offsetHeight) / 2;
      messagesEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      targetEl.classList.add("search-highlight");
      setTimeout(() => targetEl.classList.remove("search-highlight"), 2500);
    }
  } else {
    const saved = Number(state.scrollByConversation[id] || 0);
    messagesEl.scrollTop = saved > 0 ? saved : 0;
  }

  // ── Search nav bar: show in-thread match navigation when search is active ──
  if (state.q) {
    buildSearchNavBar(id, state.q);
  }

  // Tab bookkeeping runs AFTER the conversation is on screen so it never delays
  // rendering. Only persist the tab title when it actually changed (e.g. after a
  // rename) — the previous code re-wrote the same title on every open. The write
  // is fire-and-forget; ensureConversationTab already refreshes the tab strip.
  await ensureConversationTab(id, conv.title);
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  if (activeTab && activeTab.title !== conv.title) {
    activeTab.title = conv.title;
    renderTabs();
    apiUpdateTab(activeTab.id, {
      title: conv.title,
      conversation_id: id,
      tab_type: "conversation",
    });
  }
}

// ── Search (debounced) ────────────────────────────────────────────────────────

let debounce;
searchEl.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.q = searchEl.value.trim();
    syncPinnedSectionVisibility();
    updateListSectionTitle();
    if (!state.q) {
      clearSearchNav();
    } else if (state.activeId) {
      // Search term changed while a conversation is open — rebuild nav bar
      buildSearchNavBar(state.activeId, state.q);
    }
    loadConversations(false);
  }, 280);
});

searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchEl.value = "";
    state.q = "";
    clearSearchNav();
    updateListSectionTitle();
    loadConversations(false);
    searchEl.blur();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const first = convList.querySelector(".conv-item");
    if (first) {
      first.click();
      first.scrollIntoView({ block: "nearest" });
    }
  }
  if (e.key === "Enter" && searchEl.value.trim()) {
    rememberSearchQuery(searchEl.value.trim());
    saveUiPreferences({ searchHistory: state.preferences.searchHistory });
  }
});

viewFilterEl?.addEventListener("change", () => {
  state.view = viewFilterEl.value || "recent";
  state.offset = 0;
  syncPinnedSectionVisibility();
  updateListSectionTitle();
  saveUiPreferences({ conversationView: state.view });
  loadConversations(false);
});

// ── Load more ─────────────────────────────────────────────────────────────────

loadMoreBtn.addEventListener("click", () => loadConversations(true));

pinnedRefreshBtn?.addEventListener("click", () => refreshPinnedList());

sidebarToggleBtn?.addEventListener("click", async () => {
  const next = !document.body.classList.contains("sidebar-collapsed");
  document.body.classList.toggle("sidebar-collapsed", next);
  await saveUiPreferences({ sidebarCollapsed: next });
});

if (sidebarResizeHandle) {
  let dragging = false;
  sidebarResizeHandle.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging || document.body.classList.contains("sidebar-collapsed"))
      return;
    const next = Math.max(220, Math.min(520, e.clientX));
    document.documentElement.style.setProperty("--sidebar-w", `${next}px`);
    state.preferences.sidebarWidth = next;
  });
  document.addEventListener("mouseup", async () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    await saveUiPreferences({ sidebarWidth: state.preferences.sidebarWidth });
  });
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  // Don't intercept when typing in the search box
  if (e.target === searchEl) return;

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    sidebarToggleBtn?.click();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "Tab") {
    e.preventDefault();
    if (!state.tabs.length) return;
    const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
    const next = state.tabs[(idx + 1) % state.tabs.length];
    state.activeTabId = next.id;
    activateActiveTab();
    renderTabs();
    return;
  }

  if (e.key === "/") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...convList.querySelectorAll(".conv-item")];
    const idx = items.findIndex((el) => el.classList.contains("active"));
    const next = e.key === "ArrowDown" ? items[idx + 1] : items[idx - 1];
    if (next) {
      next.click();
      next.scrollIntoView({ block: "nearest" });
    }
  }
});

// ── Media hub ────────────────────────────────────────────────────────────────

function resolveConversationSidebarEl(convId) {
  return (
    [...document.querySelectorAll(".conv-item[data-id]")].find(
      (el) => el.dataset.id === convId,
    ) || null
  );
}

function mediaHubJumpToConversation(convId, seq = null) {
  return openConversation(convId, resolveConversationSidebarEl(convId), seq);
}

function mediaHubItemMeta(item) {
  const bits = [];
  if (item.kind === "artifact") {
    bits.push("Artifact");
  }
  if (item.kind === "image") {
    bits.push("Image");
  } else if (item.kind === "attachment") {
    bits.push("Attachment");
  }
  if (item.type) bits.push(item.type);
  if (item.lang) bits.push(item.lang);
  if (item.role) bits.push(item.role);
  if (item.seq != null) bits.push(`msg #${item.seq}`);
  return bits.filter(Boolean).join(" · ");
}

function renderMediaHubItem(item) {
  const row = document.createElement("div");
  row.className = "media-hub-item";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "media-hub-item-main";

  const iconWrap = document.createElement("span");
  iconWrap.className = "media-hub-item-icon";
  const previewUrl =
    item.kind === "image" ? _fileUrl({ name: item.name }) : null;
  if (previewUrl) {
    iconWrap.innerHTML = `<img src="${previewUrl}" alt="${escHtml(item.name)}">`;
  } else {
    iconWrap.textContent = fileIcon(item.type || item.name);
  }

  const textWrap = document.createElement("span");
  textWrap.className = "media-hub-item-text";
  const titleEl = document.createElement("span");
  titleEl.className = "media-hub-item-title";
  titleEl.textContent =
    item.name || item.title || item.artifact_id || "Media item";
  const metaEl = document.createElement("span");
  metaEl.className = "media-hub-item-meta";
  metaEl.textContent = mediaHubItemMeta(item);
  textWrap.append(titleEl, metaEl);
  if (item.context) {
    const ctxEl = document.createElement("span");
    ctxEl.className = "media-hub-item-context";
    ctxEl.textContent = item.context + (item.context.length >= 120 ? "…" : "");
    textWrap.appendChild(ctxEl);
  }

  main.append(iconWrap, textWrap);
  main.addEventListener("click", (e) => {
    e.stopPropagation();
    mediaHubJumpToConversation(item.conv_id, item.seq ?? item.msg_seq ?? null);
  });

  const actions = document.createElement("div");
  actions.className = "media-hub-item-actions";

  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.className = "media-hub-item-action";
  jumpBtn.textContent = "Jump";
  jumpBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    mediaHubJumpToConversation(item.conv_id, item.seq ?? item.msg_seq ?? null);
  });
  actions.appendChild(jumpBtn);

  if (item.kind === "artifact" && item.artifact_id) {
    const artifactBtn = document.createElement("button");
    artifactBtn.type = "button";
    artifactBtn.className = "media-hub-item-action";
    artifactBtn.textContent = "Artifact";
    artifactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openArtifactTab(item.artifact_id, item.name || item.artifact_id);
    });
    actions.appendChild(artifactBtn);
  }

  row.append(main, actions);
  return row;
}

function renderMediaHubGroup(group) {
  const groupEl = document.createElement("div");
  groupEl.className = "media-hub-group";

  const titleBar = document.createElement("div");
  titleBar.className = "media-hub-group-title";

  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "media-hub-conv-link";
  titleBtn.textContent = group.conv_title;
  titleBtn.addEventListener("click", () => {
    const firstSeq = group.items.find((item) => item.seq != null)?.seq ?? null;
    mediaHubJumpToConversation(group.conv_id, firstSeq);
  });

  const summary = document.createElement("span");
  summary.className = "media-hub-group-summary";
  const count = group.items.length;
  summary.textContent = `${count} item${count === 1 ? "" : "s"} · ${formatDate(group.update_time)}`;

  titleBar.append(titleBtn, summary);
  groupEl.appendChild(titleBar);

  const preview = document.createElement("div");
  preview.className = "media-hub-group-preview";
  if (group.preview) preview.textContent = group.preview;
  groupEl.appendChild(preview);

  const itemsWrap = document.createElement("div");
  itemsWrap.className = "media-hub-items";
  for (const item of group.items) {
    itemsWrap.appendChild(renderMediaHubItem(item));
  }
  groupEl.appendChild(itemsWrap);
  return groupEl;
}

function renderMediaHubSection(section, data) {
  const sectionEl = document.createElement("section");
  sectionEl.className = "media-hub-section";

  const header = document.createElement("div");
  header.className = "media-hub-section-header";

  const headingWrap = document.createElement("div");
  headingWrap.className = "media-hub-section-heading-wrap";
  const heading = document.createElement("div");
  heading.className = "media-hub-section-heading";
  heading.textContent = `${section.title} (${section.count || 0})`;
  const meta = document.createElement("div");
  meta.className = "media-hub-section-meta";
  meta.textContent = section.meta || "";
  headingWrap.append(heading, meta);

  header.appendChild(headingWrap);
  sectionEl.appendChild(header);

  if (section.groups?.length) {
    for (const group of section.groups) {
      sectionEl.appendChild(renderMediaHubGroup(group));
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "no-results media-hub-empty";
    empty.textContent = `No ${section.title.toLowerCase()} found.`;
    sectionEl.appendChild(empty);
  }

  return sectionEl;
}

function renderMediaHubSwitcher(data) {
  const switcher = document.createElement("div");
  switcher.className = "media-hub-switcher";

  const sections = data.sections || [];
  const unlinked = data.unlinked_images || [];
  const buttons = sections.map((section) => ({
    key: section.key,
    label: `${section.title} (${section.count || 0})`,
  }));
  buttons.push({
    key: "unlinked",
    label: `Unlinked Images (${unlinked.length || 0})`,
  });

  for (const btnSpec of buttons) {
    if (btnSpec.key === "unlinked" && !unlinked.length) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "media-hub-switcher-btn" +
      (state.mediaHub.activeSectionKey === btnSpec.key ? " active" : "");
    btn.textContent = btnSpec.label;
    btn.addEventListener("click", () => {
      state.mediaHub.activeSectionKey = btnSpec.key;
      renderMediaHub(data);
    });
    switcher.appendChild(btn);
  }

  return switcher;
}

function renderMediaHub(data) {
  const sections = data.sections || [];
  const unlinked = data.unlinked_images || [];
  galleryGrid.innerHTML = "";

  galleryGrid.appendChild(renderMediaHubSwitcher(data));

  const activeKey = state.mediaHub.activeSectionKey || "images";
  const section = sections.find((s) => s.key === activeKey);

  if (activeKey === "unlinked") {
    const rawSection = document.createElement("section");
    rawSection.className = "media-hub-section";
    const header = document.createElement("div");
    header.className = "media-hub-section-header";
    const headingWrap = document.createElement("div");
    headingWrap.className = "media-hub-section-heading-wrap";
    const heading = document.createElement("div");
    heading.className = "media-hub-section-heading";
    heading.textContent = `Unlinked Images (${unlinked.length})`;
    const meta = document.createElement("div");
    meta.className = "media-hub-section-meta";
    meta.textContent =
      "Images found on disk without a traced source conversation.";
    headingWrap.append(heading, meta);
    header.appendChild(headingWrap);
    rawSection.appendChild(header);

    const rawGrid = document.createElement("div");
    rawGrid.className = "media-hub-raw-grid";
    for (const img of unlinked) {
      const a = document.createElement("a");
      a.href = img.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "gallery-thumb media-hub-raw-thumb";
      a.innerHTML = `<img src="${img.url}" alt="${escHtml(img.filename)}"><span>${escHtml(img.filename)}</span>`;
      rawGrid.appendChild(a);
    }
    rawSection.appendChild(rawGrid);
    galleryGrid.appendChild(rawSection);
    return;
  }

  if (!section) {
    galleryGrid.innerHTML =
      '<div class="no-results media-hub-empty">No media found for this category.</div>';
    return;
  }

  galleryGrid.appendChild(renderMediaHubSection(section, data));
}

async function openGallery(fromButton = false) {
  if (fromButton && state.activeSpecialView === "gallery") {
    state.activeSpecialView = null;
    state.activeTabId = resolveReturnTabId();
    if (state.activeTabId) {
      await activateActiveTab();
    } else {
      hideAllPanels();
      emptyState.hidden = false;
    }
    renderTabs();
    return;
  }
  rememberReturnTab();
  state.activeSpecialView = "gallery";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("gallery", "Media Hub");

  hideAllPanels();
  galleryPanel.hidden = false;

  galleryGrid.innerHTML = '<div class="loading">Loading…</div>';
  const data = await fetch("/api/gallery").then((r) => r.json());
  state.mediaHub.data = data;

  const sections = data.sections || [];
  const unlinked = data.unlinked_images || [];
  if (!sections.length && !unlinked.length) {
    galleryGrid.innerHTML =
      '<div class="no-results">No conversation-linked media found.</div>';
    return;
  }

  if (
    !sections.some((section) => section.key === state.mediaHub.activeSectionKey)
  ) {
    state.mediaHub.activeSectionKey =
      sections[0]?.key || (unlinked.length ? "unlinked" : "images");
  }

  renderMediaHub(data);
}

$("gallery-btn").addEventListener("click", () => openGallery(true));

// ── Attachment Report ─────────────────────────────────────────────────────────

async function openAttReport(forceRefresh, fromButton = false) {
  if (fromButton && state.activeSpecialView === "attachment_report") {
    state.activeSpecialView = null;
    state.activeTabId = resolveReturnTabId();
    if (state.activeTabId) {
      await activateActiveTab();
    } else {
      hideAllPanels();
      emptyState.hidden = false;
    }
    renderTabs();
    return;
  }
  rememberReturnTab();
  state.activeSpecialView = "attachment_report";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("attachment_report", "Attachment Report");
  hideAllPanels();
  attReportPanel.hidden = false;

  if (!forceRefresh && attReportContent.dataset.loaded) return;

  attReportContent.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try {
    const resp = await fetch("/api/attachment-report");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    attReportContent.innerHTML = `<div class="no-results">Could not load the attachment report: ${escHtml(e.message)}. Please try Refresh.</div>`;
    attReportMeta.textContent = "Failed to load report.";
    return; // never leave the panel stuck on "Loading…"
  }
  attReportContent.innerHTML = "";

  const items = data.missing || [];
  attReportMeta.textContent = items.length
    ? `${items.length} attachment(s) cannot be displayed (no exported content and not found in source/files/)`
    : "✅ All attachments resolved — none missing.";

  if (!items.length) {
    attReportContent.dataset.loaded = "1";
    return;
  }

  // Group by conversation
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.conv_id))
      groups.set(it.conv_id, { title: it.conv_title, items: [] });
    groups.get(it.conv_id).items.push(it);
  }

  for (const [convId, { title, items: convItems }] of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "att-report-group";

    const titleEl = document.createElement("div");
    titleEl.className = "att-report-conv-title";
    titleEl.innerHTML = `<button class="att-report-conv-link" data-id="${escHtml(convId)}">${escHtml(title)}</button>`;
    groupEl.appendChild(titleEl);

    for (const it of convItems) {
      const row = document.createElement("div");
      row.className = "att-report-row";
      const typeLabel = it.file_type ? `(${it.file_type})` : "";
      row.innerHTML = `
        <span class="att-report-icon">${fileIcon(it.file_type || it.file_name)}</span>
        <span class="att-report-name">${escHtml(it.file_name)} <span class="att-report-type">${escHtml(typeLabel)}</span></span>
        ${it.context ? `<span class="att-report-ctx">${escHtml(it.context)}…</span>` : ""}
        <button class="att-upload-btn" title="Upload this file to source/files/">📎 Upload</button>`;

      row.querySelector(".att-report-name").addEventListener("click", () => {
        openConversation(convId, resolveConversationSidebarEl(convId), it.seq);
      });

      // Upload button: trigger hidden file input
      row.querySelector(".att-upload-btn").addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "*/*";
        inp.addEventListener("change", async () => {
          const file = inp.files[0];
          if (!file) return;
          const fd = new FormData();
          fd.append("file", file, it.file_name);
          fd.append("name", it.file_name);
          const btn = row.querySelector(".att-upload-btn");
          btn.disabled = true;
          btn.textContent = "Uploading…";
          try {
            const res = await fetch("/api/upload-file", {
              method: "POST",
              body: fd,
            }).then((r) => r.json());
            if (res.ok) {
              row.classList.add("att-row-resolved");
              btn.textContent = "✅ Uploaded";
              // Invalidate cache so next open re-fetches fresh data
              delete attReportContent.dataset.loaded;
            } else {
              btn.disabled = false;
              btn.textContent = "📎 Upload";
              alert("Upload failed: " + (res.error || "unknown error"));
            }
          } catch (e) {
            btn.disabled = false;
            btn.textContent = "📎 Upload";
            alert("Upload error: " + e.message);
          }
        });
        inp.click();
      });

      groupEl.appendChild(row);
    }
    attReportContent.appendChild(groupEl);
  }

  // Wire conversation title click → open conversation
  attReportContent.querySelectorAll(".att-report-conv-link").forEach((btn) => {
    btn.addEventListener("click", () =>
      openConversation(
        btn.dataset.id,
        resolveConversationSidebarEl(btn.dataset.id),
        null,
      ),
    );
  });

  attReportContent.dataset.loaded = "1";
}

$("att-report-refresh-btn").addEventListener("click", () =>
  openAttReport(true),
);

// ── Import Audit ────────────────────────────────────────────────────────────────
// An inspection view: shows how every conversation in conversations.json was
// imported, and lets you drill into each status to see (and open) the records
// that came in as fallback / metadata_only / parse_error.

async function openImportAudit() {
  rememberReturnTab();
  state.activeSpecialView = "import_audit";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("import_audit", "Import Audit");
  hideAllPanels();
  importAuditPanel.hidden = false;
  renderImportAuditSummary();
}

async function renderImportAuditSummary() {
  importAuditContent.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try {
    const resp = await fetch("/api/import-audit");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    importAuditContent.innerHTML = `<div class="no-results">Could not load the import audit: ${escHtml(e.message)}.</div>`;
    return;
  }
  if (data.error) {
    importAuditContent.innerHTML = `<div class="no-results">${escHtml(data.error)}</div>`;
    return;
  }

  const rows = [
    { key: null, label: "Total conversations", n: data.total },
    { key: "normal", label: "Normal", n: data.normal },
    { key: "fallback", label: "Fallback", n: data.fallback },
    { key: "metadata_only", label: "Metadata only", n: data.metadata_only },
    { key: "parse_error", label: "Parse errors", n: data.parse_error },
  ];

  importAuditContent.innerHTML = "";
  const listEl = document.createElement("div");
  listEl.className = "audit-summary";
  for (const r of rows) {
    const clickable = r.key !== null;
    const row = document.createElement(clickable ? "button" : "div");
    row.className =
      "audit-row" +
      (clickable ? " audit-row-clickable" : " audit-row-total");
    row.innerHTML = `<span class="audit-row-label">${escHtml(r.label)}</span><span class="audit-row-count">${(r.n || 0).toLocaleString()}</span>`;
    if (clickable) {
      row.title = `Browse the "${r.label}" conversations`;
      row.addEventListener("click", () =>
        renderImportAuditList(r.key, r.label),
      );
    }
    listEl.appendChild(row);
  }
  importAuditContent.appendChild(listEl);

  if (data.synthetic) {
    const note = document.createElement("div");
    note.className = "audit-note";
    note.textContent = `${data.synthetic.toLocaleString()} of these have synthetic IDs (no original Claude UUID).`;
    importAuditContent.appendChild(note);
  }
}

async function renderImportAuditList(status, label) {
  importAuditContent.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try {
    const resp = await fetch(
      `/api/import-audit?status=${encodeURIComponent(status)}`,
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    importAuditContent.innerHTML = `<div class="no-results">Could not load this category: ${escHtml(e.message)}.</div>`;
    return;
  }

  importAuditContent.innerHTML = "";

  const header = document.createElement("div");
  header.className = "audit-list-header";
  const back = document.createElement("button");
  back.className = "audit-back-btn";
  back.textContent = "← Back to summary";
  back.addEventListener("click", () => renderImportAuditSummary());
  header.appendChild(back);
  const title = document.createElement("div");
  title.className = "audit-list-title";
  const n = (data.total || 0).toLocaleString();
  title.textContent = `${label} — ${n} conversation${data.total !== 1 ? "s" : ""}`;
  header.appendChild(title);
  importAuditContent.appendChild(header);

  const convs = data.conversations || [];
  if (!convs.length) {
    const empty = document.createElement("div");
    empty.className = "no-results";
    empty.textContent = "No conversations in this category.";
    importAuditContent.appendChild(empty);
    return;
  }

  const listEl = document.createElement("div");
  listEl.className = "audit-conv-list";
  for (const c of convs) {
    const item = document.createElement("button");
    item.className = "audit-conv-item";
    const date = formatDate(c.update_time || c.create_time);
    const srcIdx =
      c.source_index != null ? `source #${c.source_index}` : "source index n/a";
    item.innerHTML = `
      <div class="audit-conv-title">${escHtml(c.title || "Untitled")}</div>
      <div class="audit-conv-meta">
        <span>${escHtml(date)}</span>
        <span>${c.message_count} msg${c.message_count !== 1 ? "s" : ""}</span>
        <span>${escHtml(srcIdx)}</span>
      </div>
      <div class="audit-conv-id">${escHtml(c.id)}</div>`;
    item.addEventListener("click", () => openConversation(c.id, null));
    listEl.appendChild(item);
  }
  importAuditContent.appendChild(listEl);
}

// ── Custom GPTs (gizmos) panel ─────────────────────────────────────────────────

async function openGizmos() {
  rememberReturnTab();
  state.activeSpecialView = "gizmos";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("gizmos", "Custom GPTs");
  hideAllPanels();
  if (gizmosPanel) gizmosPanel.hidden = false;
  await renderGizmosPanel();
}

async function apiGizmoConversations(gizmoId) {
  const r = await fetch(
    `/api/gizmo-conversations?gizmo_id=${encodeURIComponent(gizmoId)}`,
  );
  return r.json();
}

async function renderGizmosPanel() {
  await renderGizmosList();
}

// The inline-renamable name element for a gizmo card.
function makeGizmoNameEl(g) {
  const named = Boolean(g.display_name);
  const nameEl = document.createElement("div");
  nameEl.className = "gizmo-name";
  nameEl.textContent = named ? g.display_name : "Custom GPT (unnamed)";
  nameEl.title = named
    ? "Double-click to rename this Custom GPT"
    : "Double-click to name this Custom GPT";
  nameEl.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startGizmoCardRename(nameEl, g);
  });
  return nameEl;
}

function startGizmoCardRename(nameEl, g) {
  beginInlineGizmoRename(nameEl, {
    gizmoId: g.gizmo_id,
    currentName: g.display_name,
    count: g.conversation_count,
    rebuild: () => makeGizmoNameEl(g),
    onSaved: async (newName) => {
      g.display_name = newName;
      await renderGizmosList();
      // Keep an open conversation with this gizmo in sync.
      if (state.activeGizmo && state.activeGizmo.id === g.gizmo_id) {
        state.activeGizmo.name = newName;
        if (state.activeId) await openConversation(state.activeId, null);
      }
    },
  });
}

async function renderGizmosList() {
  if (!gizmosContent) return;
  gizmosContent.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try {
    data = await apiGizmos();
  } catch (e) {
    gizmosContent.innerHTML = `<div class="no-results">Could not load Custom GPTs: ${escHtml(e.message)}.</div>`;
    return;
  }
  const gizmos = data.gizmos || [];
  gizmosContent.innerHTML = "";
  if (!gizmos.length) {
    gizmosContent.innerHTML =
      '<div class="no-results">No ChatGPT Custom GPTs found in your history.</div>';
    return;
  }

  for (const g of gizmos) {
    const named = Boolean(g.display_name);
    const count = g.conversation_count;
    const card = document.createElement("div");
    card.className = "gizmo-card" + (named ? "" : " unnamed");

    const head = document.createElement("div");
    head.className = "gizmo-card-head";
    head.append(makeGizmoNameEl(g));
    const typeBadge = document.createElement("span");
    typeBadge.className = "gizmo-type";
    typeBadge.textContent = g.gizmo_type || "gpt";
    head.append(typeBadge);

    const meta = document.createElement("div");
    meta.className = "gizmo-meta";
    meta.textContent =
      `${count} conversation${count !== 1 ? "s" : ""} · ${g.gizmo_id}`;

    const samples = document.createElement("div");
    samples.className = "gizmo-samples";
    samples.textContent = (g.sample_titles || []).join(" · ");

    const actions = document.createElement("div");
    actions.className = "gizmo-actions";
    const viewBtn = document.createElement("button");
    viewBtn.className = "gizmo-btn";
    viewBtn.textContent = `View ${count} conversation${count !== 1 ? "s" : ""}`;
    viewBtn.addEventListener("click", () => renderGizmoConversations(g));
    const renameBtn = document.createElement("button");
    renameBtn.className = "gizmo-btn";
    renameBtn.textContent = named ? "Rename" : "Name this GPT";
    renameBtn.addEventListener("click", () => {
      const nameEl = head.querySelector(".gizmo-name");
      if (nameEl) startGizmoCardRename(nameEl, g);
    });
    const moveBtn = document.createElement("button");
    moveBtn.className = "gizmo-btn";
    moveBtn.textContent = `Move all ${count} to folder`;
    moveBtn.addEventListener("click", () => moveGizmoToFolderFlow(g));
    actions.append(viewBtn, renameBtn, moveBtn);

    card.append(head, meta, samples, actions);
    gizmosContent.appendChild(card);
  }
}

// The per-Custom-GPT screen: every conversation for one gizmo on one screen,
// each opening the conversation when clicked.
async function renderGizmoConversations(g) {
  if (!gizmosContent) return;
  gizmosContent.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try {
    data = await apiGizmoConversations(g.gizmo_id);
  } catch (e) {
    gizmosContent.innerHTML = `<div class="no-results">Could not load conversations: ${escHtml(e.message)}.</div>`;
    return;
  }

  gizmosContent.innerHTML = "";
  const back = document.createElement("button");
  back.className = "gizmo-back";
  back.textContent = "← All Custom GPTs";
  back.addEventListener("click", () => renderGizmosList());
  gizmosContent.appendChild(back);

  const title = document.createElement("div");
  title.className = "gizmo-detail-title";
  title.textContent = data.display_name || "Custom GPT";
  gizmosContent.appendChild(title);

  const convs = data.conversations || [];
  const sub = document.createElement("div");
  sub.className = "gizmo-detail-sub";
  sub.textContent =
    `${convs.length} conversation${convs.length !== 1 ? "s" : ""} · ${g.gizmo_id}`;
  gizmosContent.appendChild(sub);

  const list = document.createElement("div");
  list.className = "gizmo-conv-list";
  for (const c of convs) {
    const item = document.createElement("button");
    item.className = "gizmo-conv-item";
    const date = formatDate(c.update_time || c.create_time);
    item.innerHTML =
      `<div class="gizmo-conv-title">${escHtml(c.title || "Untitled")}</div>` +
      `<div class="gizmo-conv-meta"><span>${escHtml(date)}</span><span>${c.message_count} msg${c.message_count !== 1 ? "s" : ""}</span></div>`;
    item.addEventListener("click", () => openConversation(c.id, null));
    list.appendChild(item);
  }
  if (!convs.length) {
    list.innerHTML = '<div class="no-results">No conversations.</div>';
  }
  gizmosContent.appendChild(list);
}

// Move every conversation of a gizmo into a folder. Offers existing folders and
// a "new folder" option; a new folder defaults to the gizmo's name.
async function moveGizmoToFolderFlow(g) {
  const defaultName = g.display_name || "Custom GPT";
  const folderName = await openNameModal({
    title: `Move ${g.conversation_count} chats to folder`,
    value: defaultName,
    okLabel: "Move",
  });
  if (folderName === null) return;
  const res = await apiGizmoMoveToFolder(g.gizmo_id, { folderName });
  if (res && res.ok) {
    await loadFolders();
    await loadConversations(false);
    await renderGizmosPanel();
  }
}

// ── Sidebar popup menu ("More" button) ─────────────────────────────────────────
// The "More" button opens a small menu anchored to it instead of jumping
// straight to a screen. Add future entries as .sidebar-menu-item buttons in
// index.html with a unique data-action, then handle that action below.

const sidebarMenuBtn = $("sidebar-menu-btn");
const sidebarMenu = $("sidebar-menu");

function positionSidebarMenu() {
  const r = sidebarMenuBtn.getBoundingClientRect();
  // Show the menu first so its size can be measured, then place it above the
  // button, right-aligned to it (the button sits at the bottom of the sidebar).
  sidebarMenu.hidden = false;
  const mw = sidebarMenu.offsetWidth;
  const mh = sidebarMenu.offsetHeight;
  let left = r.right - mw;
  if (left < 8) left = 8;
  let top = r.top - mh - 6;
  if (top < 8) top = r.bottom + 6; // fall back to below if no room above
  sidebarMenu.style.left = `${left}px`;
  sidebarMenu.style.top = `${top}px`;
}

function openSidebarMenu() {
  positionSidebarMenu();
  sidebarMenuBtn.setAttribute("aria-expanded", "true");
  document.addEventListener("mousedown", onSidebarMenuOutside, true);
  document.addEventListener("keydown", onSidebarMenuKey, true);
}

function closeSidebarMenu() {
  sidebarMenu.hidden = true;
  sidebarMenuBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", onSidebarMenuOutside, true);
  document.removeEventListener("keydown", onSidebarMenuKey, true);
}

function onSidebarMenuOutside(e) {
  if (!sidebarMenu.contains(e.target) && e.target !== sidebarMenuBtn) {
    closeSidebarMenu();
  }
}

function onSidebarMenuKey(e) {
  if (e.key === "Escape") closeSidebarMenu();
}

sidebarMenuBtn.addEventListener("click", () => {
  if (sidebarMenu.hidden) openSidebarMenu();
  else closeSidebarMenu();
});

sidebarMenu.querySelectorAll(".sidebar-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    const action = item.dataset.action;
    closeSidebarMenu();
    if (action === "attachment-report") openAttReport(false);
    else if (action === "import-audit") openImportAudit(false);
    else if (action === "gizmos") openGizmos(false);
  });
});

// ── Memories ──────────────────────────────────────────────────────────────────

async function openMemories(fromButton = false) {
  if (fromButton && state.activeSpecialView === "memories") {
    state.activeSpecialView = null;
    state.activeTabId = resolveReturnTabId();
    if (state.activeTabId) {
      await activateActiveTab();
    } else {
      hideAllPanels();
      emptyState.hidden = false;
    }
    renderTabs();
    return;
  }
  rememberReturnTab();
  state.activeSpecialView = "memories";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("memories", "Memories");

  hideAllPanels();
  memoriesPanel.hidden = false;

  if (memoriesContent.dataset.loaded) return;

  memoriesContent.innerHTML = '<div class="loading">Loading…</div>';
  const data = await fetch("/api/memories").then((r) => r.json());
  memoriesContent.innerHTML = "";

  if (!data.memories?.length) {
    memoriesContent.innerHTML =
      '<div class="no-results">No memories found.</div>';
    return;
  }

  memoriesMeta.textContent = `${data.memories.length} memory record${data.memories.length !== 1 ? "s" : ""}`;

  for (const mem of data.memories) {
    const div = document.createElement("div");
    div.className = "memory-block";
    const bodyEl = document.createElement("div");
    bodyEl.className = "message-body";
    bodyEl.innerHTML = md(mem.content);
    div.appendChild(bodyEl);
    memoriesContent.appendChild(div);
  }

  memoriesContent.dataset.loaded = "1";
}

$("memories-btn").addEventListener("click", () => openMemories(true));

// ── Projects ──────────────────────────────────────────────────────────────────

async function openProjects(fromButton = false) {
  if (fromButton && state.activeSpecialView === "projects") {
    state.activeSpecialView = null;
    state.activeTabId = resolveReturnTabId();
    if (state.activeTabId) {
      await activateActiveTab();
    } else {
      hideAllPanels();
      emptyState.hidden = false;
    }
    renderTabs();
    return;
  }
  rememberReturnTab();
  state.activeSpecialView = "projects";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("projects", "Projects");

  hideAllPanels();
  projectsPanel.hidden = false;

  if (projectsContent.dataset.loaded) return;

  projectsContent.innerHTML = '<div class="loading">Loading…</div>';
  const data = await fetch("/api/projects").then((r) => r.json());
  projectsContent.innerHTML = "";

  if (!data.projects?.length) {
    projectsContent.innerHTML =
      '<div class="no-results">No projects found.</div>';
    return;
  }

  projectsMeta.textContent = `${data.projects.length} project${data.projects.length !== 1 ? "s" : ""}`;

  for (const proj of data.projects) {
    const card = document.createElement("div");
    card.className = "project-card";
    card.innerHTML = `
      <div class="project-header">
        <div class="project-name">${escHtml(proj.name)}</div>
        ${proj.description ? `<div class="project-desc">${escHtml(proj.description)}</div>` : ""}
        <div class="project-meta">${proj.doc_count} document${proj.doc_count !== 1 ? "s" : ""}</div>
      </div>
      <div class="project-docs" data-proj-id="${escHtml(proj.id)}"></div>`;
    projectsContent.appendChild(card);

    // Load this project's docs immediately
    const docsEl = card.querySelector(".project-docs");
    docsEl.innerHTML =
      '<div class="loading" style="padding:12px 0">Loading docs…</div>';
    fetch(`/api/project/${encodeURIComponent(proj.id)}`)
      .then((r) => r.json())
      .then((d) => {
        docsEl.innerHTML = "";
        if (!d.docs?.length) {
          docsEl.innerHTML =
            '<div class="no-results" style="padding:8px 0">No documents.</div>';
          return;
        }
        for (const doc of d.docs) {
          const docDiv = document.createElement("div");
          docDiv.className = "project-doc";
          const bodyEl = document.createElement("div");
          bodyEl.className = "message-body";
          bodyEl.innerHTML = md(doc.content);
          docDiv.innerHTML = `<div class="project-doc-name">📄 ${escHtml(doc.filename)}</div>`;
          docDiv.appendChild(bodyEl);
          docsEl.appendChild(docDiv);
        }
      });
  }

  projectsContent.dataset.loaded = "1";
}

$("projects-btn").addEventListener("click", () => openProjects(true));

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Naming modal (create folder, rename chat, rename folder) ────────────────────
const nameModal = $("name-modal");
const nameModalTitle = $("name-modal-title");
const nameModalInput = $("name-modal-input");
const nameModalCancel = $("name-modal-cancel");
const nameModalOk = $("name-modal-ok");
let _nameModalResolve = null;

function openNameModal({ title = "Rename", value = "", okLabel = "Okay" } = {}) {
  nameModalTitle.textContent = title;
  nameModalInput.value = value;
  nameModalOk.textContent = okLabel;
  nameModal.hidden = false;
  setTimeout(() => {
    nameModalInput.focus();
    nameModalInput.select();
  }, 0);
  return new Promise((resolve) => {
    _nameModalResolve = resolve;
  });
}
function closeNameModal(result) {
  nameModal.hidden = true;
  const r = _nameModalResolve;
  _nameModalResolve = null;
  if (r) r(result);
}
nameModalCancel?.addEventListener("click", () => closeNameModal(null));
nameModalOk?.addEventListener("click", () =>
  closeNameModal(nameModalInput.value.trim() || null),
);
nameModalInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    closeNameModal(nameModalInput.value.trim() || null);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeNameModal(null);
  }
});
nameModal?.addEventListener("mousedown", (e) => {
  if (e.target === nameModal) closeNameModal(null);
});

// ── Folders ─────────────────────────────────────────────────────────────────
async function apiFolders() {
  const p = state.source ? `?source=${encodeURIComponent(state.source)}` : "";
  return fetch(`/api/folders${p}`).then((r) => r.json());
}
async function apiCreateFolder(name) {
  return fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => r.json());
}
async function apiRenameFolder(id, name) {
  return fetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => r.json());
}
async function apiMoveToFolder(folderId, conversationId) {
  return fetch("/api/folder-items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder_id: folderId, conversation_id: conversationId }),
  }).then((r) => r.json());
}
async function apiRemoveFromFolder(conversationId) {
  return fetch(`/api/folder-items/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  }).then((r) => r.json());
}
async function apiFolderPin(conversationId, pinned) {
  return fetch(`/api/folder-items/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  }).then((r) => r.json());
}

function _lsGet(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function _lsSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}
let _expandedFolders = (() => {
  try {
    return new Set(JSON.parse(_lsGet("expandedFolders", "[]")));
  } catch {
    return new Set();
  }
})();
const foldersSectionOpen = () => _lsGet("foldersOpen", "0") === "1";

function folderIconSvg(open) {
  const d = open
    ? "M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"
    : "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z";
  return `<svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

async function loadFolders() {
  let data;
  try {
    data = await apiFolders();
  } catch {
    data = { folders: [] };
  }
  state.folders = data.folders || [];
  state.folderOf = new Map();
  for (const f of state.folders)
    for (const c of f.conversations || []) state.folderOf.set(c.id, f.id);
  renderFolders();
}

function renderFolders() {
  if (!foldersTree || !foldersToggle) return;
  const open = foldersSectionOpen();
  foldersToggle.setAttribute("aria-expanded", open ? "true" : "false");
  foldersTree.hidden = !open;
  if (!open) return;

  foldersTree.innerHTML = "";
  if (!state.folders.length) {
    const empty = document.createElement("div");
    empty.className = "folders-empty";
    empty.textContent = 'None yet — use "Move to" in a conversation to make one.';
    foldersTree.appendChild(empty);
    return;
  }

  for (const f of state.folders) {
    const expanded = _expandedFolders.has(f.id);

    const row = document.createElement("div");
    row.className = "folder-row";
    row.dataset.folderId = f.id;
    row.innerHTML =
      folderIconSvg(expanded) +
      `<span class="folder-name">${escHtml(f.name)}</span>` +
      `<span class="folder-count">${(f.conversations || []).length}</span>` +
      `<button class="folder-rename-btn" title="Rename folder">✎</button>`;

    row.addEventListener("click", (e) => {
      if (e.target.closest(".folder-rename-btn")) return;
      if (_expandedFolders.has(f.id)) _expandedFolders.delete(f.id);
      else _expandedFolders.add(f.id);
      _lsSet("expandedFolders", JSON.stringify([..._expandedFolders]));
      renderFolders();
    });
    row
      .querySelector(".folder-rename-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = await openNameModal({
          title: "Rename folder",
          value: f.name,
        });
        if (name && name !== f.name) {
          await apiRenameFolder(f.id, name);
          await loadFolders();
        }
      });

    // Drop target: move a dragged conversation into this folder.
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("folder-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("folder-drop"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("folder-drop");
      const cid = e.dataTransfer.getData("text/plain");
      if (cid) {
        await apiMoveToFolder(f.id, cid);
        await afterFolderChange();
      }
    });

    foldersTree.appendChild(row);

    if (expanded) {
      const kids = document.createElement("div");
      kids.className = "folder-children";
      const convs = f.conversations || [];
      if (!convs.length) {
        const none = document.createElement("div");
        none.className = "folder-children-empty";
        none.textContent = "Empty";
        kids.appendChild(none);
      }
      for (const c of convs) {
        const item = document.createElement("div");
        item.className =
          "folder-conv-item" + (c.id === state.activeId ? " active" : "");
        item.dataset.id = c.id;
        item.draggable = true;
        item.innerHTML =
          (c.pinned ? '<span class="folder-pin-dot" title="Pinned">★</span>' : "") +
          `<span class="folder-conv-title">${escHtml(c.title || "Untitled")}</span>`;
        item.addEventListener("click", () => openConversation(c.id, item));
        item.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", c.id);
          item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => item.classList.remove("dragging"));
        kids.appendChild(item);
      }
      foldersTree.appendChild(kids);
    }
  }
}

// After a folder-membership change: refresh folders + the main list (a chat may
// have entered/left it) and the open conversation's Move-to menu state.
async function afterFolderChange() {
  await loadFolders();
  await loadConversations(false);
}

foldersToggle?.addEventListener("click", () => {
  _lsSet("foldersOpen", foldersSectionOpen() ? "0" : "1");
  renderFolders();
});

// Drag a conversation OUT of a folder by dropping it on the main list.
function wireFolderDropOut(el) {
  if (!el) return;
  el.addEventListener("dragover", (e) => {
    const cid = e.dataTransfer.getData("text/plain");
    // types check (getData is empty during dragover in some browsers)
    if ([...e.dataTransfer.types].includes("text/plain")) e.preventDefault();
  });
  el.addEventListener("drop", async (e) => {
    const cid = e.dataTransfer.getData("text/plain");
    if (cid && state.folderOf.has(cid)) {
      e.preventDefault();
      await apiRemoveFromFolder(cid);
      await afterFolderChange();
    }
  });
}
wireFolderDropOut(convList);

// ── Thread header actions (Move to / ⋮) ─────────────────────────────────────────
const moveToBtn = $("move-to-btn");
const moveToMenu = $("move-to-menu");
const threadMoreBtn = $("thread-more-btn");
const threadMoreMenu = $("thread-more-menu");

function closeThreadMenus() {
  if (moveToMenu) moveToMenu.hidden = true;
  if (threadMoreMenu) threadMoreMenu.hidden = true;
  document.removeEventListener("mousedown", onThreadMenuOutside, true);
}
function onThreadMenuOutside(e) {
  if (
    moveToMenu.contains(e.target) ||
    moveToBtn.contains(e.target) ||
    threadMoreMenu.contains(e.target) ||
    threadMoreBtn.contains(e.target)
  )
    return;
  closeThreadMenus();
}

function buildMoveToMenu() {
  const cid = state.activeId;
  moveToMenu.innerHTML = "";

  const addNew = document.createElement("button");
  addNew.className = "thread-dropdown-item";
  addNew.textContent = "Add New Folder";
  addNew.addEventListener("click", async () => {
    closeThreadMenus();
    const name = await openNameModal({ title: "New folder", value: "" });
    if (!name) return;
    const res = await apiCreateFolder(name);
    if (res && res.id) {
      await apiMoveToFolder(res.id, cid);
      await afterFolderChange();
    }
  });
  moveToMenu.appendChild(addNew);

  if (state.folderOf.has(cid)) {
    const remove = document.createElement("button");
    remove.className = "thread-dropdown-item";
    remove.textContent = "Remove from Folder";
    remove.addEventListener("click", async () => {
      closeThreadMenus();
      await apiRemoveFromFolder(cid);
      await afterFolderChange();
    });
    moveToMenu.appendChild(remove);
  }

  if (state.folders.length) {
    const sep = document.createElement("div");
    sep.className = "thread-dropdown-sep";
    moveToMenu.appendChild(sep);
  }
  for (const f of state.folders) {
    const b = document.createElement("button");
    b.className = "thread-dropdown-item";
    if (state.folderOf.get(cid) === f.id) b.classList.add("current");
    b.textContent = f.name;
    b.addEventListener("click", async () => {
      closeThreadMenus();
      await apiMoveToFolder(f.id, cid);
      await afterFolderChange();
    });
    moveToMenu.appendChild(b);
  }
}

moveToBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.activeId) return;
  const wasOpen = !moveToMenu.hidden;
  closeThreadMenus();
  if (wasOpen) return;
  buildMoveToMenu();
  moveToMenu.hidden = false;
  document.addEventListener("mousedown", onThreadMenuOutside, true);
});

threadMoreBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.activeId) return;
  const wasOpen = !threadMoreMenu.hidden;
  closeThreadMenus();
  if (wasOpen) return;
  const pinItem = threadMoreMenu.querySelector('[data-action="pin"]');
  if (pinItem) {
    if (state.folderOf.has(state.activeId)) {
      const fid = state.folderOf.get(state.activeId);
      const folder = state.folders.find((f) => f.id === fid);
      const conv = folder?.conversations.find((c) => c.id === state.activeId);
      pinItem.textContent = conv && conv.pinned ? "Unpin" : "Pin";
    } else {
      pinItem.textContent = state.pinnedIds.has(state.activeId) ? "Unpin" : "Pin";
    }
  }
  threadMoreMenu.hidden = false;
  document.addEventListener("mousedown", onThreadMenuOutside, true);
});

threadMoreMenu?.querySelectorAll(".thread-dropdown-item").forEach((item) => {
  item.addEventListener("click", async () => {
    const action = item.dataset.action;
    const cid = state.activeId;
    closeThreadMenus();
    if (!cid) return;
    if (action === "rename") {
      const cur = threadTitle.textContent || "";
      const name = await openNameModal({
        title: "Rename conversation",
        value: cur,
      });
      if (!name || name === cur) return;
      await apiUpdateConversationMeta(cid, { title: name });
      threadTitle.textContent = name;
      await loadConversations(false);
      await refreshPinnedList();
      await loadFolders();
      const tab = state.tabs.find((t) => t.conversation_id === cid);
      if (tab) {
        tab.title = name;
        renderTabs();
        apiUpdateTab(tab.id, {
          title: name,
          conversation_id: cid,
          tab_type: "conversation",
        });
      }
    } else if (action === "pin") {
      if (state.folderOf.has(cid)) {
        const fid = state.folderOf.get(cid);
        const folder = state.folders.find((f) => f.id === fid);
        const conv = folder?.conversations.find((c) => c.id === cid);
        await apiFolderPin(cid, !(conv && conv.pinned));
        await loadFolders();
      } else if (state.pinnedIds.has(cid)) {
        await apiUnpinConversation(cid);
        await refreshPinnedList();
        await loadConversations(false);
      } else {
        await apiPinConversation(cid);
        await refreshPinnedList();
        await loadConversations(false);
      }
    } else if (action === "archive") {
      await apiUpdateConversationMeta(cid, { archived: true });
      await refreshPinnedList();
      await afterFolderChange();
    }
  });
});

// ── Source switcher (Claude / ChatGPT) ───────────────────────────────────────

function updateSourceSwitcherUI() {
  if (!sourceSwitcher) return;
  sourceSwitcher.querySelectorAll(".source-tab").forEach((btn) => {
    const active = btn.dataset.source === state.source;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

async function initSourceSwitcher() {
  let data;
  try {
    data = await fetch("/api/sources").then((r) => r.json());
  } catch {
    data = { counts: { claude: 0, chatgpt: 0 }, default: "claude" };
  }
  state.sourceCounts = data.counts || { claude: 0, chatgpt: 0 };
  const both = state.sourceCounts.claude > 0 && state.sourceCounts.chatgpt > 0;

  // Prefer a remembered choice, but only when that source actually has data;
  // otherwise fall back to the server's default.
  const saved = state.preferences.source;
  if (saved && state.sourceCounts[saved] > 0) {
    state.source = saved;
  } else {
    state.source = data.default || "claude";
  }

  // The switcher only appears when there are genuinely two histories to switch
  // between. With a single source it stays hidden and the app behaves as before.
  if (sourceSwitcher) sourceSwitcher.hidden = !both;
  updateSourceSwitcherUI();

  sourceSwitcher?.querySelectorAll(".source-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchSource(btn.dataset.source));
  });
}

async function switchSource(newSource) {
  if (!newSource || newSource === state.source) return;
  if (!["claude", "chatgpt"].includes(newSource)) return;
  state.source = newSource;
  state.preferences.source = newSource;
  updateSourceSwitcherUI();
  saveUiPreferences({ source: newSource });

  // Reset the browsing state so we never show the other source's content.
  state.activeId = null;
  state.offset = 0;
  hideAllPanels();
  emptyState.hidden = false;

  await Promise.all([refreshPinnedList(), loadFolders()]);
  await loadConversations(false);
}

async function initApp() {
  await loadUiPreferences();
  await initSourceSwitcher();
  renderSearchHistory();
  await refreshPinnedList();
  await loadFolders();
  await loadTabs();
  await loadConversations(false);
  if (state.activeTabId) {
    await activateActiveTab();
  }
}

initApp();

messagesEl?.addEventListener("scroll", () => {
  if (!state.activeId) return;
  state.scrollByConversation[state.activeId] = messagesEl.scrollTop;
});

window.addEventListener("beforeunload", () => {
  apiUpdatePreferences({
    ...state.preferences,
    conversationView: state.view,
    scrollByConversation: state.scrollByConversation,
  });
});
