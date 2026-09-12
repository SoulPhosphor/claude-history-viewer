"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  q: "",
  offset: 0,
  total: 0,
  activeId: null,
  view: "recent",
  activeSpecialView: null,
  mediaHub: {
    data: null,
    activeSectionKey: "images",
  },
  pinnedIds: new Set(),
  folders: [],
  folderOf: new Map(), // conversation_id -> folder_id (for chats inside folders)
  tabs: [], // Compare items only
  activeTabId: null,
  lastConversationId: null, // for returning from a special view
  activeProvider: null, // provider of the open conversation
  // The open conversation's own pin/folder state (set on open), authoritative
  // even for a Compare item from the provider not shown in the sidebar.
  activePinned: false,
  activeFolderId: null,
  activeFolderPinned: false,
  preferences: {
    sidebarCollapsed: false,
    sidebarWidth: 300,
    conversationView: "recent",
    searchHistory: [],
    // Conversation labels feature. Off by default; when off no label control
    // renders anywhere, but the underlying label data is left untouched.
    labelsEnabled: false,
    labelDisplay: "square", // "square" | "square_label"
  },
  labelRows: [], // label definitions (shared by the Labels screen and squares)
  activeLabel: null, // the open conversation's current label ({id,name,color}|null)
  scrollByConversation: {},
  // Which side the sidebar toggle shows: "claude" or "chatgpt". Persisted so
  // reopening the app returns to the side last viewed.
  providerSide: "claude",
  // Claude model availability. Everything under here stays inert on a ChatGPT
  // export, where the whole feature is hidden.
  datasetFormat: "claude",
  models: null, // model state for the open conversation
  modelRows: [], // the Add Claude Models table
  unverifiedCount: 0,
  tags: [], // tags on the open conversation
  allTagsCache: null, // every tag in use, for the add-tag autocomplete
  // Compare-tab outline colours, per provider. CSS-driven, editable in Settings.
  compareColors: { chatgpt: "#4169E1", claude: "#2E7D32" },
  importNew: {
    backups: [], // rows for the import-history table
    provider: "all", // filter radio
    sortKey: "imported_at", // default: newest import first
    sortDir: "desc",
    busy: false,
    deletedMode: "skip", // previously-deleted import choice
    reviewNewMessages: false, // "review chats that have new messages" checkbox
    review: [], // conversations held aside for review
    reviewChecked: new Set(), // checked review rows (by conversation id)
  },
  // Conversations checked in the Recycle Bin. Selection is by conversation id
  // and persists as the list is scrolled/loaded-more within the view.
  recycleSelected: new Set(),
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const searchEl = $("search");
const searchHistoryListEl = $("search-history-list");
const viewFilterEl = $("view-filter");
const resultCount = $("result-count");
const recycleControls = $("recycle-controls");
const recycleActionEl = $("recycle-action");
const recycleGoBtn = $("recycle-go");
const convList = $("conv-list");
const listSectionTitle = $("list-section-title");
const foldersSection = $("folders-section");
const foldersToggle = $("folders-toggle");
const foldersTree = $("folders-tree");
const foldersCtxMenu = $("folders-ctx-menu");
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
const tabsWrap = $("tabs-wrap");
const emptyState = $("empty-state");
const thread = $("thread");
const threadTitle = $("thread-title");
const threadHeader = $("thread-header");
const threadTitlebarLabel = $("thread-titlebar-label");
const threadCollapseBtn = $("thread-collapse-btn");
const threadMeta = $("thread-meta");
const threadTags = $("thread-tags");
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
const claudeModelsPanel = $("claude-models-panel");
const claudeModelsMenuItem = $("claude-models-menu-item");
const modelTableBody = $("model-table-body");
const modelAddForm = $("model-add-form");
const modelAddError = $("model-add-error");
const modelReloadBtn = $("model-reload-btn");
const importAuditContent = $("import-audit-content");
const importNewPanel = $("import-new-panel");
const settingsPanel = $("settings-panel");
const labelsPanel = $("labels-panel");
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
    provider: state.providerSide,
  });
  if (q) p.set("q", q);
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
  // Scope pins to the toggled side so the loose Pinned list matches the sidebar.
  const p = new URLSearchParams({ provider: state.providerSide });
  const r = await fetch(`/api/pinned?${p}`);
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

// Bulk Recycle Bin actions. `body` is either { all: true, provider } or
// { ids: [...], provider }; the server scopes "all" to the given provider so it
// matches the count the user sees.
async function apiRecycleRestore(body) {
  const r = await fetch("/api/recycle-bin/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function apiRecyclePurge(body) {
  const r = await fetch("/api/recycle-bin/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  const r = await fetch(`/api/search?${p}`);
  return r.json();
}

async function apiConversation(id) {
  const r = await fetch(`/api/conversation/${encodeURIComponent(id)}`);
  // An error response is HTML, not JSON, so parsing it unconditionally threw
  // and left the thread stuck on "Loading…". Hand back the shape the caller
  // already checks for instead.
  try {
    const data = await r.json();
    if (!r.ok) return { error: data.error || `HTTP ${r.status}` };
    return data;
  } catch {
    return { error: r.ok ? "Malformed response" : `HTTP ${r.status}` };
  }
}

// ── Tags ─────────────────────────────────────────────────────────────────────
async function apiAllTags() {
  const r = await fetch("/api/tags");
  const data = await r.json();
  return data.tags || [];
}

async function apiAddTag(convId, tag) {
  const r = await fetch("/api/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conv_id: convId, tag }),
  });
  return r.json();
}

async function apiRemoveTag(convId, tag) {
  const r = await fetch(
    `/api/tags/${encodeURIComponent(convId)}/${encodeURIComponent(tag)}`,
    { method: "DELETE" },
  );
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

// Each chat row now carries a single right-aligned ⋮ button; its menu holds
// Rename, Compare, Pin, Archive (in that order).
function buildConvActions(c) {
  const wrap = document.createElement("div");
  wrap.className = "conv-actions";
  const btn = document.createElement("button");
  btn.className = "conv-menu-btn";
  btn.title = "More";
  btn.setAttribute("aria-haspopup", "true");
  btn.innerHTML =
    '<svg viewBox="0 0 4 16" width="4" height="16" aria-hidden="true">' +
    '<circle cx="2" cy="2" r="1.7"/><circle cx="2" cy="8" r="1.7"/>' +
    '<circle cx="2" cy="14" r="1.7"/></svg>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openConvItemMenu(c, btn);
  });
  wrap.appendChild(btn);
  return wrap;
}

// ── Chat-row action menu (shared, floating) ───────────────────────────────────
let _convMenuEl = null;

function closeConvItemMenu() {
  if (_convMenuEl) {
    _convMenuEl.remove();
    _convMenuEl = null;
    document.removeEventListener("mousedown", onConvMenuOutside, true);
    document.removeEventListener("keydown", onConvMenuKey, true);
    window.removeEventListener("scroll", closeConvItemMenu, true);
  }
}
function onConvMenuOutside(e) {
  if (_convMenuEl && !_convMenuEl.contains(e.target)) closeConvItemMenu();
}
function onConvMenuKey(e) {
  if (e.key === "Escape") closeConvItemMenu();
}

async function renameConversation(c) {
  const next = await openNameModal({
    title: "Rename conversation",
    value: c.title || "",
  });
  if (!next || next === c.title) return;
  await apiUpdateConversationMeta(c.id, { title: next });
  if (state.activeId === c.id) setThreadTitle(next);
  loadConversations(false);
  refreshPinnedList();
  loadFolders();
  const compareTab = compareTabForConv(c.id);
  if (compareTab) {
    compareTab.title = next;
    renderTabs();
    apiUpdateTab(compareTab.id, {
      title: next,
      conversation_id: c.id,
      tab_type: "conversation",
    });
  }
}

async function togglePinConversation(c) {
  if (state.pinnedIds.has(c.id)) await apiUnpinConversation(c.id);
  else await apiPinConversation(c.id);
  await refreshPinnedList();
  loadConversations(false);
}

async function archiveOrRestoreConversation(c) {
  const archivedView = state.view === "archived";
  const deletedView = state.view === "deleted";
  const restoreMode = archivedView || deletedView;
  if (deletedView) {
    await apiUpdateConversationMeta(c.id, { deleted: false });
  } else {
    await apiUpdateConversationMeta(c.id, { archived: !archivedView });
  }
  const leavesView =
    (state.view === "recent" && !restoreMode) || archivedView || deletedView;
  const wasPinned = state.pinnedIds.has(c.id);
  const itemEl = findConvItemEl(c.id);
  if (leavesView && itemEl && !state.q) {
    removeConvItemFromList(itemEl);
  } else {
    loadConversations(false);
  }
  if (wasPinned) refreshPinnedList();
}

// Delete → Recycle Bin, from any ordinary view (no archiving required). Sets the
// deleted flag only; every other bit of the conversation's state is preserved so
// a later Restore returns it exactly as it was.
async function deleteConversation(c) {
  await apiUpdateConversationMeta(c.id, { deleted: true });
  const wasPinned = state.pinnedIds.has(c.id);
  const itemEl = findConvItemEl(c.id);
  // The conversation leaves every non-Recycle-Bin list once deleted.
  if (itemEl && !state.q) {
    removeConvItemFromList(itemEl);
  } else {
    loadConversations(false);
  }
  if (wasPinned) refreshPinnedList();
  // A foldered chat disappears from its folder (it's now in the Recycle Bin).
  loadFolders();
}

function openConvItemMenu(c, anchorBtn) {
  const wasForThis =
    _convMenuEl && _convMenuEl.dataset.convId === c.id;
  closeConvItemMenu();
  if (wasForThis) return; // clicking the same ⋮ again closes it

  const menu = document.createElement("div");
  menu.className = "sidebar-menu conv-item-menu";
  menu.dataset.convId = c.id;
  menu.setAttribute("role", "menu");

  const archivedView = state.view === "archived";
  const deletedView = state.view === "deleted";
  const pinned = state.pinnedIds.has(c.id);
  const items = [
    { label: "Rename", fn: () => renameConversation(c) },
    {
      label: compareTabForConv(c.id) ? "Remove from Compare" : "Compare",
      fn: () => {
        const existing = compareTabForConv(c.id);
        if (existing) removeFromCompare(existing.id);
        else addToCompare(c.id, c.title, state.providerSide);
      },
    },
    { label: pinned ? "Unpin" : "Pin", fn: () => togglePinConversation(c) },
    {
      label: archivedView || deletedView ? "Restore" : "Archive",
      fn: () => archiveOrRestoreConversation(c),
    },
  ];
  // Delete → Recycle Bin, available from every ordinary view (Archive is not a
  // prerequisite). The Recycle Bin itself uses Restore + the action control.
  if (!deletedView) {
    items.push({ label: "Delete", fn: () => deleteConversation(c) });
  }
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "sidebar-menu-item";
    b.setAttribute("role", "menuitem");
    b.innerHTML = `<span class="sidebar-menu-item-label">${escHtml(it.label)}</span>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeConvItemMenu();
      it.fn();
    });
    menu.appendChild(b);
  }

  // Direct label selection (Blank + configured labels) so someone with several
  // labels need not click-cycle repeatedly. Only when the feature is on.
  if (labelsFeatureOn()) {
    appendSetLabelToMenu(
      menu,
      c.id,
      c.label ? c.label.id : null,
      "sidebar-menu-item",
      () => closeConvItemMenu(),
    );
  }

  document.body.appendChild(menu);
  _convMenuEl = menu;
  // Position under the button, right-aligned, kept on screen.
  const r = anchorBtn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  let left = r.right - mw;
  if (left < 8) left = 8;
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    top = r.top - menu.offsetHeight - 4;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  document.addEventListener("mousedown", onConvMenuOutside, true);
  document.addEventListener("keydown", onConvMenuKey, true);
  window.addEventListener("scroll", closeConvItemMenu, true);
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
    top.innerHTML = `<div class="conv-title">${warningIconsHtml(c)}${escHtml(c.title)}</div>`;
    // Compact label square, immediately before the title. Only when the feature
    // is on; it rides on the title's text line so the row keeps its height.
    if (labelsFeatureOn()) {
      const titleEl = top.querySelector(".conv-title");
      titleEl.insertBefore(labelIndicatorEl(c.id, c.label || null), titleEl.firstChild);
    }
    // Recycle Bin rows carry an always-visible checkbox beside the title. Its
    // presence depends only on the view, never on which action is selected.
    if (state.view === "deleted") {
      el.classList.add("conv-item-recycle");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "conv-select";
      cb.checked = state.recycleSelected.has(c.id);
      cb.setAttribute("aria-label", "Select conversation");
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) state.recycleSelected.add(c.id);
        else state.recycleSelected.delete(c.id);
        renderResultCount();
      });
      top.insertBefore(cb, top.firstChild);
    }
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
  if (!state.q) renderResultCount();
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
  deleted: "Recycle Bin",
  unverified: "Unverified Models",
};

// The one list header reflects whichever view the dropdown has selected, so it
// never says "Recent" while showing Pinned/Archived/All results.
function updateListSectionTitle() {
  if (!listSectionTitle) return;
  listSectionTitle.textContent = state.q
    ? "Search results"
    : labelViewTitle(state.view) || VIEW_LABELS[state.view] || "Recent";
}

// The conversation-count row. In the Recycle Bin it also shows the current
// selection count (e.g. "327 conversations · 12 selected"), extending the one
// existing count row rather than adding a second.
function renderResultCount() {
  if (!resultCount) return;
  if (state.q) {
    const n = (state.total || 0).toLocaleString();
    resultCount.textContent = `${n} matches`;
    return;
  }
  const n = (state.total || 0).toLocaleString();
  let text = `${n} conversation${state.total !== 1 ? "s" : ""}`;
  if (state.view === "deleted") {
    // The Recycle Bin count row carries the selection count alongside the
    // total, rather than adding a second row.
    text += ` · ${state.recycleSelected.size} selected`;
  }
  resultCount.textContent = text;
}

// Show the Recycle Bin action control (action dropdown + Go) only in the
// Recycle Bin view. Its visibility never depends on which action is selected.
function syncRecycleControls() {
  const inRecycle = state.view === "deleted";
  if (recycleControls) recycleControls.hidden = !inRecycle;
  if (!inRecycle) state.recycleSelected.clear();
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
    "deleted",
    "unverified",
  ].includes(savedView)
    ? savedView
    : "recent";
  state.preferences.searchHistory = Array.isArray(p.searchHistory)
    ? p.searchHistory.slice(0, 20)
    : [];
  state.preferences.labelsEnabled = Boolean(p.labelsEnabled);
  state.preferences.labelDisplay =
    p.labelDisplay === "square_label" ? "square_label" : "square";
  state.scrollByConversation =
    p.scrollByConversation && typeof p.scrollByConversation === "object"
      ? p.scrollByConversation
      : {};
  state.lastConversationId =
    typeof p.lastConversationId === "string" ? p.lastConversationId : null;
  const cc = p.compareColors || {};
  state.compareColors = {
    chatgpt: _validHexColor(cc.chatgpt)
      ? cc.chatgpt
      : DEFAULT_COMPARE_COLORS.chatgpt,
    claude: _validHexColor(cc.claude)
      ? cc.claude
      : DEFAULT_COMPARE_COLORS.claude,
  };
  applyCompareColors();
  // Restore the side last viewed. With no saved choice, start on whichever side
  // the dataset itself is (loadDatasetFormat runs before this).
  const savedSide = String(p.providerSide || "");
  state.providerSide = ["claude", "chatgpt"].includes(savedSide)
    ? savedSide
    : state.datasetFormat === "chatgpt"
      ? "chatgpt"
      : "claude";
  state.preferences.providerSide = state.providerSide;
  renderProviderToggle();
  if (claudeModelsMenuItem) claudeModelsMenuItem.hidden = !isClaudeSide();
  state.view = state.preferences.conversationView;
  if (viewFilterEl) viewFilterEl.value = state.view;
  syncRecycleControls();
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

// Every persisted tab is now a Compare item, and Compare holds conversations
// only — artifacts open transiently, and the sidebar switches between chats.
function isTopTab(tab) {
  return !!tab && tab.tab_type === "conversation";
}

function compareCount() {
  return state.tabs.filter(isTopTab).length;
}

function compareTabForConv(convId) {
  return (
    state.tabs.find(
      (t) => t.tab_type === "conversation" && t.conversation_id === convId,
    ) || null
  );
}

// Remember which conversation to return to when a special view (Memories,
// Settings, …) is closed. A Compare item is not "the last thing viewed" unless
// one is actually open, so track the open conversation id directly.
function rememberReturnTab() {
  if (state.activeId) state.lastConversationId = state.activeId;
}

// The conversation a closing special view should return to: the last one
// opened if it still exists, else the first Compare item, else none.
function returnConversationId() {
  if (state.lastConversationId) return state.lastConversationId;
  const first = state.tabs.find(isTopTab);
  return first ? first.conversation_id : null;
}

async function returnFromSpecialView() {
  state.activeSpecialView = null;
  const cid = returnConversationId();
  if (cid) {
    await openConversation(cid, findConvItemEl(cid));
  } else {
    hideAllPanels();
    emptyState.hidden = false;
  }
  renderTabs();
}

// ── Compare (the top strip) ───────────────────────────────────────────────────
// The strip holds up to MAX_COMPARE conversations the user explicitly added via
// the Compare action. They behave like fast pins and, unlike folders / pins /
// the sidebar list, may mix Claude and ChatGPT.
const MAX_COMPARE = 4;

async function addToCompare(convId, title, provider) {
  if (!convId) return;
  if (compareTabForConv(convId)) {
    flashCompareMessage("Already in Compare");
    return;
  }
  if (compareCount() >= MAX_COMPARE) {
    flashCompareMessage(`Compare holds at most ${MAX_COMPARE} chats`);
    return;
  }
  const created = await apiCreateTab({
    tab_type: "conversation",
    conversation_id: convId,
    title: title || "Conversation",
    provider: provider || null,
  });
  state.tabs.push({
    id: created.id,
    tab_type: "conversation",
    conversation_id: convId,
    title: title || "Conversation",
    provider: provider || null,
  });
  renderTabs();
}

async function removeFromCompare(tabId) {
  const tab = getTabById(tabId);
  if (!tab) return;
  await apiDeleteTab(tabId);
  state.tabs = state.tabs.filter((t) => t.id !== tabId);
  renderTabs();
}

// A small, self-clearing note in the strip when Compare can't add a chat.
let _compareMsgTimer = null;
function flashCompareMessage(text) {
  if (!tabsWrap) return;
  tabsWrap.hidden = false;
  let note = document.getElementById("compare-note");
  if (!note) {
    note = document.createElement("div");
    note.id = "compare-note";
    note.className = "compare-note";
    tabsWrap.appendChild(note);
  }
  note.textContent = text;
  clearTimeout(_compareMsgTimer);
  _compareMsgTimer = setTimeout(() => {
    note.remove();
    renderTabs();
  }, 2200);
}

// Closing the last open tab used to leave the pane blank ("Untitled"/empty)
// even though the sidebar is full of conversations. Open the most recent one
// instead, so there is always something in that space.
async function openMostRecentConversation() {
  try {
    const p = new URLSearchParams({
      limit: 1,
      offset: 0,
      view: "recent",
      pinned_first: "0",
    });
    const data = await fetch(`/api/conversations?${p}`).then((r) => r.json());
    const top = (data.conversations || [])[0];
    if (!top) return false;
    await openConversation(top.id, findConvItemEl(top.id));
    return true;
  } catch {
    return false;
  }
}

function renderTabs() {
  if (!tabsList) return;
  tabsList.innerHTML = "";
  const items = state.tabs.filter(isTopTab);
  // The strip appears as soon as there's one Compare item (they're fast pins),
  // or while a transient note is showing.
  const hasNote = !!document.getElementById("compare-note");
  tabsWrap.hidden = items.length === 0 && !hasNote;
  for (const t of items) {
    const tab = document.createElement("div");
    const active = t.conversation_id === state.activeId;
    tab.className = "top-tab" + (active ? " active" : "");
    if (t.provider === "chatgpt" || t.provider === "claude") {
      tab.classList.add(`provider-${t.provider}`);
    }
    tab.setAttribute("role", "button");
    tab.setAttribute("tabindex", "0");
    tab.innerHTML = `<span class="tab-label">${escHtml(t.title || "Untitled")}</span><button type="button" class="tab-close" title="Remove from Compare">×</button>`;
    tab.querySelector(".tab-close").addEventListener("click", async (e) => {
      e.stopPropagation();
      await removeFromCompare(t.id);
    });
    tab.addEventListener("click", () =>
      openConversation(t.conversation_id, findConvItemEl(t.conversation_id)),
    );
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openConversation(t.conversation_id, findConvItemEl(t.conversation_id));
    });
    tabsList.appendChild(tab);
  }
}

async function loadTabs() {
  const data = await apiTabs();
  state.tabs = (data.tabs || []).filter(isTopTab);
  renderTabs();
}

async function ensureSpecialTab(tabType, title) {
  state.activeSpecialView = tabType;
  renderTabs();
}

// Artifacts open transiently in the reading pane — they never join the Compare
// strip. Kept as its own function so existing callers need no changes.
async function openArtifactTab(artifactId, title) {
  state.activeSpecialView = null;
  await renderArtifactTabContent(artifactId, title);
  renderTabs();
}

async function renderArtifactTabContent(artifactId, title) {
  hideAllPanels();
  thread.hidden = false;
  closeArtifactPanel();
  state.activeSpecialView = null;
  setThreadTitle(title || artifactId);
  threadMeta.textContent = "Artifact tab";
  threadTags.innerHTML = "";
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

// Restore whatever the app was showing (a special view, else the last
// conversation, else the empty state). Used on load and by tab cycling.
async function activateActiveTab() {
  if (state.activeSpecialView === "gallery") return openGallery(false);
  if (state.activeSpecialView === "memories") return openMemories(false);
  if (state.activeSpecialView === "projects") return openProjects(false);
  if (state.activeSpecialView === "attachment_report")
    return openAttReport(false, false);
  if (state.activeSpecialView === "claude_models") return openClaudeModels();
  if (state.activeSpecialView === "labels") return openLabels();
  if (state.activeSpecialView === "import_audit") return openImportAudit(false);
  if (state.activeSpecialView === "import_new") return openImportNew();
  if (state.activeSpecialView === "settings") return openSettings();
  const cid = returnConversationId();
  if (cid) {
    await openConversation(cid, findConvItemEl(cid));
    return;
  }
  hideAllPanels();
  emptyState.hidden = false;
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
    state.unverifiedCount = data.unverified_count || 0;
    syncUnverifiedOption();
    state.offset += (data.conversations || []).length;

    if (!append) convList.innerHTML = "";

    if (!data.conversations?.length && !append) {
      convList.innerHTML =
        '<div class="no-results">No conversations found.</div>';
    } else {
      appendListItems(data.conversations || []);
    }

    renderResultCount();

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
  importNewPanel.hidden = true;
  settingsPanel.hidden = true;
  claudeModelsPanel.hidden = true;
  labelsPanel.hidden = true;
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

const EMPTY_CONV_NOTICE = {
  metadata_only:
    "This conversation has no displayable messages (metadata-only import).",
  parse_error:
    "This conversation could not be parsed from the export, and no messages were recovered (parse error).",
  fallback:
    "This conversation was recovered by the fallback parser, but it yielded no displayable messages.",
  default: "This conversation has no displayable messages.",
};

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
  setThreadTitle("");
  renderHeaderLabel(null, null);
  state.activeLabel = null;
  threadMeta.textContent = "";
  threadTags.innerHTML = "";

  const data = await apiConversation(id);
  if (data.error) {
    messagesEl.innerHTML = `<div class="no-results">Error: ${escHtml(data.error)}</div>`;
    return;
  }

  const { conversation: conv, messages, artifacts: artifactsMeta = {} } = data;
  state.activeProvider = conv.provider || null;
  // The open conversation's own pin/folder state, from the server rather than
  // the sidebar-scoped sets — so the thread menu stays correct for a Compare
  // item opened from the opposite provider.
  state.activePinned = !!conv.pinned;
  state.activeFolderId = conv.folder_id || null;
  state.activeFolderPinned = !!conv.folder_pinned;

  setThreadTitle(conv.title);
  state.activeLabel = conv.label || null;
  renderHeaderLabel(conv.id, state.activeLabel);
  const ts = formatDate(conv.update_time || conv.create_time);
  threadMeta.textContent = "";
  const metaText = document.createElement("span");
  metaText.textContent = `${ts} · ${conv.message_count} messages`;
  threadMeta.appendChild(metaText);
  state.models = data.models || null;
  renderModelStrip();
  state.tags = data.tags || [];
  renderThreadTags();

  messagesEl.innerHTML = "";
  if (!messages.length) {
    // The record was kept so the import audit can account for it. Name the
    // status that actually left it empty — calling a parse_error a
    // metadata-only import misreports the very thing the audit exists to show.
    const note = document.createElement("div");
    note.className = "no-results";
    note.textContent = EMPTY_CONV_NOTICE[conv.import_status] || EMPTY_CONV_NOTICE.default;
    messagesEl.appendChild(note);
  }
  for (const msg of messages) {
    const div = document.createElement("div");
    div.className = `message ${msg.role}`;
    if (msg.seq != null) div.dataset.seq = msg.seq;

    const label =
      msg.role === "user"
        ? "You"
        : msg.role === "assistant"
          ? "Claude"
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

    const roleEl = document.createElement("div");
    roleEl.className = "message-role";
    roleEl.textContent = label;
    div.insertBefore(roleEl, div.firstChild);
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

        // Update this user message bubble
        bodyEl.innerHTML = md(sanitize(sib.content || ""));
        wireCodeCopy(bodyEl);

        // Update the adjacent assistant response (for user-branch switching)
        if ("asst_content" in sib) {
          const nextMsgEl = div.nextElementSibling;
          if (nextMsgEl?.classList.contains("assistant")) {
            const nextBody = nextMsgEl.querySelector(".message-body");
            if (nextBody) {
              const ac = sib.asst_content || "";
              nextBody.innerHTML = ac
                ? md(sanitize(ac))
                : '<p class="branch-no-response">(Claude did not respond in this branch)</p>';
              wireCodeCopy(nextBody);
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

  // Opening a chat no longer creates a tab — the top strip is the Compare list
  // only. Just remember this as the conversation to return to, and keep a
  // matching Compare item's title in sync (e.g. after a rename).
  state.lastConversationId = id;
  const compareTab = compareTabForConv(id);
  if (compareTab && compareTab.title !== conv.title) {
    compareTab.title = conv.title;
    if (compareTab.provider == null && conv.provider) {
      compareTab.provider = conv.provider;
    }
    apiUpdateTab(compareTab.id, {
      title: conv.title,
      conversation_id: id,
      tab_type: "conversation",
    });
  }
  renderTabs();
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
  state.recycleSelected.clear();
  syncPinnedSectionVisibility();
  syncRecycleControls();
  updateListSectionTitle();
  // Label views are session-scoped; only base views are remembered across reloads.
  if (!String(state.view).startsWith("label:")) {
    saveUiPreferences({ conversationView: state.view });
  }
  loadConversations(false);
});

// Recycle Bin action control. The dropdown only decides what Go does; it never
// affects whether checkboxes are shown. Both permanent-delete actions require a
// confirmation after Go is pressed.
recycleGoBtn?.addEventListener("click", async () => {
  if (state.view !== "deleted") return;
  const action = recycleActionEl.value;
  const provider = state.providerSide;
  const selectedIds = Array.from(state.recycleSelected);
  const scoped = action.endsWith("-selected");
  if (scoped && selectedIds.length === 0) {
    resultCount.textContent = "No conversations selected";
    setTimeout(renderResultCount, 1600);
    return;
  }
  const isDelete = action.startsWith("delete");
  const body = scoped ? { ids: selectedIds, provider } : { all: true, provider };

  if (isDelete) {
    const count = scoped ? selectedIds.length : state.total;
    const ok = await openConfirm({
      title: "Permanently delete?",
      text:
        `Permanently delete ${count.toLocaleString()} conversation` +
        `${count !== 1 ? "s" : ""} from the Recycle Bin? ` +
        "This removes the conversation content and cannot be undone.",
      okLabel: "Delete permanently",
    });
    if (!ok) return;
    await apiRecyclePurge(body);
  } else {
    await apiRecycleRestore(body);
  }
  state.recycleSelected.clear();
  await loadConversations(false);
  await refreshPinnedList();
  await loadFolders();
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

// True for anything the user types into: the search box, a rename dialog, the
// model form's fields. Shortcuts must not fire from these — bare "/" and the
// arrows would otherwise steal focus mid-word and make text like "React/Vue"
// impossible to type.
function isTextEntryTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  // Buttons and checkboxes are inputs too, but nothing is typed into them.
  return (
    tag === "INPUT" &&
    !["button", "submit", "reset", "checkbox", "radio"].includes(el.type)
  );
}

document.addEventListener("keydown", (e) => {
  // Don't intercept while the user is typing into any field
  if (isTextEntryTarget(e.target)) return;

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
    const items = state.tabs.filter(isTopTab);
    if (!items.length) return;
    const idx = items.findIndex((t) => t.conversation_id === state.activeId);
    const next = items[(idx + 1) % items.length];
    openConversation(next.conversation_id, findConvItemEl(next.conversation_id));
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
    await returnFromSpecialView();
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
    await returnFromSpecialView();
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

// Chrome setup shared by opening the audit panel fresh and restoring it on a
// browser Back/Forward (popstate) — only the content rendered inside differs.
async function showImportAuditPanel() {
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
}

async function openImportAudit() {
  await showImportAuditPanel();
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

  if (data.collapsed) {
    // The totals above count source objects; the database stores one row per
    // distinct ID. Say so, rather than letting the two numbers silently differ.
    const note = document.createElement("div");
    note.className = "audit-note";
    note.textContent =
      `${data.collapsed.toLocaleString()} shared an ID with another record and were ` +
      `collapsed — ${(data.stored || 0).toLocaleString()} conversations are stored.`;
    importAuditContent.appendChild(note);
  }
}

// `push`/`scrollTop` drive the browser-history integration: a forward click
// on a summary row pushes a new history entry for this category so a later
// Back returns to it; restoring that same entry on popstate re-renders it
// without pushing again and puts the scroll position back where it was.
async function renderImportAuditList(
  status,
  label,
  { push = true, scrollTop = null } = {},
) {
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

  if (push) {
    history.pushState(
      { auditNav: true, view: "audit-list", status, label },
      "",
    );
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
    if (scrollTop != null) importAuditContent.scrollTop = scrollTop;
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
    // kept === 0 marks a source object that shares its ID with another and was
    // collapsed at import. It still opens — to the conversation that won the ID.
    const dup =
      c.kept === 0
        ? '<span class="audit-conv-dup">duplicate ID — collapsed</span>'
        : "";
    item.innerHTML = `
      <div class="audit-conv-title">${escHtml(c.title || "Untitled")}</div>
      <div class="audit-conv-meta">
        <span>${escHtml(date)}</span>
        <span>${c.message_count} msg${c.message_count !== 1 ? "s" : ""}</span>
        <span>${escHtml(srcIdx)}</span>
        ${dup}
      </div>
      <div class="audit-conv-id">${escHtml(c.id)}</div>`;
    item.addEventListener("click", () =>
      openConversationFromAudit(c.id, status, label),
    );
    listEl.appendChild(item);
  }
  importAuditContent.appendChild(listEl);
  if (scrollTop != null) importAuditContent.scrollTop = scrollTop;
}

// Opening a conversation from an audit category list snapshots that list's
// scroll position into its (already-pushed) history entry, then pushes a
// second entry for the conversation itself — so browser Back pops straight
// back to the same category, scrolled to the same place.
function openConversationFromAudit(convId, status, label) {
  history.replaceState(
    {
      auditNav: true,
      view: "audit-list",
      status,
      label,
      scrollTop: importAuditContent.scrollTop,
    },
    "",
  );
  history.pushState({ auditNav: true, view: "conversation", convId }, "");
  openConversation(convId, null);
}

// Browser Back/Forward through audit-originated navigation: restore the same
// category list (with scroll position) or reopen the conversation, rather
// than falling through to whatever the SPA happens to have on screen.
window.addEventListener("popstate", (e) => {
  const st = e.state;
  if (!st || !st.auditNav) return;
  if (st.view === "audit-list") {
    showImportAuditPanel().then(() =>
      renderImportAuditList(st.status, st.label, {
        push: false,
        scrollTop: st.scrollTop ?? 0,
      }),
    );
  } else if (st.view === "conversation") {
    openConversation(st.convId, null);
  }
});

// ── Claude model availability ────────────────────────────────────────────────
// Each conversation can be tagged with the model(s) it was written with. Which
// models are offered comes from the availability dates on the Add Claude Models
// screen, and two icons flag a tagging that no longer matches those dates:
//
//   caution sign  a tagged model was never available during the conversation
//   report        the tagged models don't cover the conversation end to end
//
// Both are dismissible per conversation, and both come back if the condition
// clears and then goes wrong again (the server re-arms the dismissal).

const ICON_CAUTION =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
const ICON_REPORT =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 ' +
  '17.3c-.72 0-1.3-.58-1.3-1.3s.58-1.3 1.3-1.3 1.3.58 1.3 1.3-.58 1.3-1.3 ' +
  '1.3zm1-4.3h-2V7h2v6z"/></svg>';

// Which side the UI is currently showing. Claude-only features (model tagging,
// unverified filter) key off this, so switching to ChatGPT hides them.
const isClaudeSide = () => state.providerSide === "claude";

async function apiModelState(path, options) {
  const resp = await fetch(path, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// Load the export format once at boot; it decides whether any of this renders.
async function loadDatasetFormat() {
  try {
    const data = await apiModelState("/api/claude-models");
    state.datasetFormat = data.format === "chatgpt" ? "chatgpt" : "claude";
    state.modelRows = data.models || [];
  } catch {
    state.datasetFormat = "claude";
  }
  if (claudeModelsMenuItem) claudeModelsMenuItem.hidden = !isClaudeSide();
}

// ── Provider toggle (ChatGPT / Claude) ───────────────────────────────────────

function renderProviderToggle() {
  document
    .querySelectorAll("#provider-toggle .provider-seg")
    .forEach((btn) => {
      btn.classList.toggle(
        "active",
        btn.dataset.provider === state.providerSide,
      );
    });
}

async function switchProviderSide(side) {
  if (side !== "claude" && side !== "chatgpt") return;
  if (state.providerSide === side) return;
  state.providerSide = side;
  renderProviderToggle();
  saveUiPreferences({ providerSide: side });
  // Recycle Bin selection is per side; drop it when switching sides.
  state.recycleSelected.clear();
  // Claude-only UI follows the active side.
  if (claudeModelsMenuItem) claudeModelsMenuItem.hidden = !isClaudeSide();
  // A ChatGPT dataset can never be on the Unverified (Claude models) view.
  if (!isClaudeSide() && state.view === "unverified") {
    state.view = "recent";
    if (viewFilterEl) viewFilterEl.value = "recent";
    updateListSectionTitle();
  }
  state.offset = 0;
  await refreshPinnedList();
  await loadFolders();
  await loadConversations(false);
  syncUnverifiedOption();
}

document
  .querySelectorAll("#provider-toggle .provider-seg")
  .forEach((btn) => {
    btn.addEventListener("click", () => switchProviderSide(btn.dataset.provider));
  });

// The "Unverified Models" filter exists only while something is flagged.
function syncUnverifiedOption() {
  const opt = viewFilterEl?.querySelector('option[value="unverified"]');
  if (!opt) return;
  const show = isClaudeSide() && state.unverifiedCount > 0;
  opt.hidden = !show;
  if (!show && state.view === "unverified") {
    // Nothing left to verify — fall back rather than showing an empty list.
    // Deferred so it never reloads on top of the render that called us.
    state.view = "recent";
    viewFilterEl.value = "recent";
    updateListSectionTitle();
    setTimeout(() => loadConversations(false), 0);
  }
}

// The warning icons shown before a conversation's name in the sidebar.
function warningIconsHtml(conv) {
  if (!isClaudeSide()) return "";
  let out = "";
  if (conv.warn_range)
    out += `<span class="warn-icon warn-caution" title="Model outside its reported availability">${ICON_CAUTION}</span>`;
  if (conv.warn_coverage)
    out += `<span class="warn-icon warn-report" title="Model unavailable during entire conversation dates">${ICON_REPORT}</span>`;
  return out;
}

// ── The model strip in the conversation header ───────────────────────────────
// Empty conversation: a single "Select Model" dropdown. Once a model is chosen
// it becomes plain text with an ✕ to drop it, and an unobtrusive [ + ] dropdown
// offers the rest — which disappears when every model available during the
// conversation is already selected.

function renderModelStrip() {
  const existing = threadMeta.querySelector(".model-strip");
  if (existing) existing.remove();
  const data = state.models;
  if (!isClaudeSide() || !data || !state.activeId) return;
  const convId = state.activeId;

  const strip = document.createElement("span");
  strip.className = "model-strip";
  const sep = () => {
    const s = document.createElement("span");
    s.className = "model-sep";
    s.textContent = "·";
    return s;
  };

  for (const m of data.selected) {
    strip.appendChild(sep());
    const chip = document.createElement("span");
    chip.className = "model-chip";
    const name = document.createElement("span");
    name.className = "model-chip-name";
    name.textContent = m.name;
    const x = document.createElement("button");
    x.className = "model-chip-x";
    x.type = "button";
    x.title = `Remove ${m.name}`;
    x.setAttribute("aria-label", `Remove ${m.name}`);
    x.textContent = "✕";
    x.addEventListener("click", () => removeConvModel(convId, m.model_id));
    chip.append(name, x);
    strip.appendChild(chip);
  }

  if (data.available.length) {
    strip.appendChild(sep());
    const sel = document.createElement("select");
    const picked = data.selected.length > 0;
    sel.className = picked ? "model-select model-select-add" : "model-select";
    sel.title = picked ? "Add another model" : "Select the model used";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = picked ? "+" : "Select Model";
    sel.appendChild(placeholder);
    for (const m of data.available) {
      const opt = document.createElement("option");
      opt.value = m.model_id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }
    sel.value = "";
    sel.addEventListener("change", () => {
      if (sel.value) addConvModel(convId, sel.value);
    });
    strip.appendChild(sel);
  }

  if (data.warn_range) {
    const btn = document.createElement("button");
    btn.className = "warn-icon warn-caution warn-btn";
    btn.type = "button";
    btn.title = "Model outside its reported availability";
    btn.setAttribute("aria-label", "Model outside its reported availability");
    btn.innerHTML = ICON_CAUTION;
    btn.addEventListener("click", () => openVerifyModelDialog(convId));
    strip.appendChild(btn);
  }
  if (data.warn_coverage) {
    const btn = document.createElement("button");
    btn.className = "warn-icon warn-report warn-btn";
    btn.type = "button";
    btn.title = "Model unavailable during entire conversation dates";
    btn.setAttribute(
      "aria-label",
      "Model unavailable during entire conversation dates",
    );
    btn.innerHTML = ICON_REPORT;
    btn.addEventListener("click", () => openCoverageDialog(convId));
    strip.appendChild(btn);
  }

  threadMeta.appendChild(strip);
}

// ── Conversation tags ────────────────────────────────────────────────────────
// "Tags: [chip ×] [chip ×] [+]" under the thread meta line. Works the same on
// both a Claude and a ChatGPT export, unlike the model strip above.

function renderThreadTags() {
  threadTags.innerHTML = "";
  if (!state.activeId) return;
  const convId = state.activeId;

  const label = document.createElement("span");
  label.className = "tags-label";
  label.textContent = "Tags:";
  threadTags.appendChild(label);

  for (const tag of state.tags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const name = document.createElement("span");
    name.className = "tag-chip-name";
    name.textContent = tag;
    const x = document.createElement("button");
    x.className = "tag-chip-x";
    x.type = "button";
    x.title = `Remove ${tag}`;
    x.setAttribute("aria-label", `Remove ${tag}`);
    x.textContent = "✕";
    x.addEventListener("click", () => removeThreadTag(convId, tag));
    chip.append(name, x);
    threadTags.appendChild(chip);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "tag-add-btn";
  addBtn.type = "button";
  addBtn.title = "Add tag";
  addBtn.setAttribute("aria-label", "Add tag");
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => showTagInput(convId, addBtn));
  threadTags.appendChild(addBtn);
}

async function showTagInput(convId, addBtn) {
  if (state.allTagsCache === null) {
    state.allTagsCache = await apiAllTags().catch(() => []);
  }
  const form = document.createElement("form");
  form.className = "tag-add-form";
  const input = document.createElement("input");
  input.className = "tag-add-input";
  input.type = "text";
  input.maxLength = 40;
  input.placeholder = "Tag name";
  input.setAttribute("list", "tag-suggestions");
  if (!$("tag-suggestions")) {
    const datalist = document.createElement("datalist");
    datalist.id = "tag-suggestions";
    document.body.appendChild(datalist);
  }
  const datalist = $("tag-suggestions");
  datalist.innerHTML = "";
  for (const t of state.allTagsCache) {
    if (state.tags.includes(t)) continue;
    const opt = document.createElement("option");
    opt.value = t;
    datalist.appendChild(opt);
  }
  form.appendChild(input);
  addBtn.replaceWith(form);
  input.focus();

  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    const tag = input.value.trim();
    if (tag) await addThreadTag(convId, tag);
    else renderThreadTags();
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    finish();
  });
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      settled = true;
      renderThreadTags();
    }
  });
}

async function addThreadTag(convId, tag) {
  try {
    const data = await apiAddTag(convId, tag);
    if (state.activeId !== convId) return;
    state.tags = data.tags || state.tags;
    state.allTagsCache = null; // pick up the new tag next time the list opens
    renderThreadTags();
  } catch {
    renderThreadTags();
  }
}

async function removeThreadTag(convId, tag) {
  try {
    const data = await apiRemoveTag(convId, tag);
    if (state.activeId !== convId) return;
    state.tags = data.tags || state.tags.filter((t) => t !== tag);
    renderThreadTags();
  } catch {
    /* leave the chip as-is if the write failed */
  }
}

// A change to one conversation's models can add or clear its warning icons, so
// the sidebar row and the Unverified count are refreshed alongside the strip.
async function applyModelState(convId, data) {
  if (state.activeId !== convId) return;
  state.models = data;
  renderModelStrip();
  refreshConvWarningIcons(convId, data);
  await refreshModelWarnings();
}

function refreshConvWarningIcons(convId, data) {
  const titleEl = findConvItemEl(convId)?.querySelector(".conv-title");
  if (!titleEl) return;
  setRowWarningIcons(
    titleEl,
    data.warn_range || data.warn_coverage ? data : null,
  );
}

// Editing availability dates can flip the warning state of conversations that
// are already on screen. Their icons were baked into the rendered rows, so the
// whole visible list has to be swept, not just the aggregate count.
const UNVERIFIED_SWEEP_LIMIT = 500;

async function refreshModelWarnings() {
  if (!isClaudeSide()) return;
  let data;
  try {
    data = await fetch(
      `/api/conversations?view=unverified&limit=${UNVERIFIED_SWEEP_LIMIT}`,
    ).then((r) => r.json());
  } catch {
    return; // leave the last known state in place
  }
  state.unverifiedCount = data.unverified_count || 0;
  syncUnverifiedOption();

  const flagged = data.conversations || [];
  // The Unverified view lists exactly the flagged conversations, so a change
  // adds or removes rows rather than just icons — and more flagged rows than
  // one sweep page means the list itself is the only reliable source.
  if (state.view === "unverified" || (data.total || 0) > flagged.length) {
    loadConversations(false);
    return;
  }
  const byId = new Map(flagged.map((c) => [c.id, c]));
  for (const el of convList.querySelectorAll(".conv-item")) {
    const titleEl = el.querySelector(".conv-title");
    if (!titleEl) continue;
    setRowWarningIcons(titleEl, byId.get(el.dataset.id));
  }
}

function setRowWarningIcons(titleEl, conv) {
  titleEl.querySelectorAll(".warn-icon").forEach((el) => el.remove());
  if (conv) titleEl.insertAdjacentHTML("afterbegin", warningIconsHtml(conv));
}

async function addConvModel(convId, modelId) {
  try {
    const data = await apiModelState("/api/conversation-models", {
      method: "POST",
      body: JSON.stringify({ conv_id: convId, model_id: modelId }),
    });
    await applyModelState(convId, data);
  } catch {
    /* leave the strip as-is if the write failed */
  }
}

async function removeConvModel(convId, modelId) {
  try {
    const data = await apiModelState(
      `/api/conversation-models/${encodeURIComponent(convId)}/${encodeURIComponent(modelId)}`,
      { method: "DELETE" },
    );
    await applyModelState(convId, data);
  } catch {
    /* ignore */
  }
}

async function dismissWarning(convId, kind) {
  try {
    const data = await apiModelState("/api/conversation-models/dismiss", {
      method: "POST",
      body: JSON.stringify({ conv_id: convId, kind }),
    });
    await applyModelState(convId, data);
  } catch {
    /* ignore */
  }
}

// ── The two warning dialogs ──────────────────────────────────────────────────

const verifyModelModal = $("verify-model-modal");
const coverageModal = $("coverage-modal");
let _warnDialogConvId = null;

function openVerifyModelDialog(convId) {
  _warnDialogConvId = convId;
  verifyModelModal.hidden = false;
}

function openCoverageDialog(convId) {
  _warnDialogConvId = convId;
  coverageModal.hidden = false;
}

// "No" / "Okay" just close; the warnings stay.
$("verify-model-no")?.addEventListener("click", () => {
  verifyModelModal.hidden = true;
});
$("coverage-okay")?.addEventListener("click", () => {
  coverageModal.hidden = true;
});
$("verify-model-yes")?.addEventListener("click", () => {
  verifyModelModal.hidden = true;
  if (_warnDialogConvId) dismissWarning(_warnDialogConvId, "range");
});
$("coverage-dismiss")?.addEventListener("click", () => {
  coverageModal.hidden = true;
  if (_warnDialogConvId) dismissWarning(_warnDialogConvId, "coverage");
});
for (const modal of [verifyModelModal, coverageModal]) {
  modal?.addEventListener("mousedown", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!verifyModelModal.hidden) verifyModelModal.hidden = true;
  if (!coverageModal.hidden) coverageModal.hidden = true;
});

// ── Settings screen ──────────────────────────────────────────────────────────

const DEFAULT_COMPARE_COLORS = { chatgpt: "#4169E1", claude: "#2E7D32" };

// Push the current compare colours into CSS custom properties. All compare-tab
// colouring is driven by these two variables, so future settings can extend the
// same pattern.
function applyCompareColors() {
  const root = document.documentElement.style;
  root.setProperty("--compare-chatgpt", state.compareColors.chatgpt);
  root.setProperty("--compare-claude", state.compareColors.claude);
}

function _validHexColor(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

async function openSettings() {
  rememberReturnTab();
  state.activeSpecialView = "settings";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("settings", "Settings");
  hideAllPanels();
  settingsPanel.hidden = false;
  const gpt = $("compare-color-chatgpt");
  const claude = $("compare-color-claude");
  if (gpt) gpt.value = state.compareColors.chatgpt;
  if (claude) claude.value = state.compareColors.claude;
}

function saveCompareColors() {
  applyCompareColors();
  renderTabs();
  saveUiPreferences({ compareColors: { ...state.compareColors } });
}

$("compare-color-chatgpt")?.addEventListener("input", (e) => {
  if (_validHexColor(e.target.value)) {
    state.compareColors.chatgpt = e.target.value;
    saveCompareColors();
  }
});
$("compare-color-claude")?.addEventListener("input", (e) => {
  if (_validHexColor(e.target.value)) {
    state.compareColors.claude = e.target.value;
    saveCompareColors();
  }
});
$("compare-color-reset")?.addEventListener("click", () => {
  state.compareColors = { ...DEFAULT_COMPARE_COLORS };
  const gpt = $("compare-color-chatgpt");
  const claude = $("compare-color-claude");
  if (gpt) gpt.value = state.compareColors.chatgpt;
  if (claude) claude.value = state.compareColors.claude;
  saveCompareColors();
});

// ── Labels screen ─────────────────────────────────────────────────────────────
// Configure user-defined conversation labels: the on/off + display settings,
// and the label definitions (add / rename / recolour / reorder / delete). Label
// assignment on conversations and the bulk/snapshot tools arrive in later phases.

const labelsEnabledToggle = $("labels-enabled-toggle");
const labelsDisplaySelect = $("labels-display-select");
const labelAddForm = $("label-add-form");
const labelAddName = $("label-add-name");
const labelAddColor = $("label-add-color");
const labelAddError = $("label-add-error");
const labelListEl = $("label-list");
const bulkResultEl = $("bulk-result");
const bulkErrorEl = $("bulk-error");
const bulkPreviewBtn = $("bulk-preview-btn");
const bulkApplyBtn = $("bulk-apply-btn");
const bulkHistoryList = $("bulk-history-list");

async function openLabels() {
  rememberReturnTab();
  state.activeSpecialView = "labels";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("labels", "Labels");
  hideAllPanels();
  labelsPanel.hidden = false;
  // Reflect the current feature settings into the controls.
  if (labelsEnabledToggle)
    labelsEnabledToggle.checked = Boolean(state.preferences.labelsEnabled);
  if (labelsDisplaySelect)
    labelsDisplaySelect.value =
      state.preferences.labelDisplay === "square_label"
        ? "square_label"
        : "square";
  await refreshLabelList();
  await populateBulkForm();
  loadBulkHistory();
}

function showLabelError(msg) {
  if (!labelAddError) return;
  labelAddError.textContent = msg || "";
  labelAddError.hidden = !msg;
}

async function refreshLabelList() {
  try {
    const data = await apiModelState("/api/labels");
    state.labelRows = data.labels || [];
  } catch {
    labelListEl.innerHTML =
      '<li class="label-list-empty">Could not load labels.</li>';
    return;
  }
  renderLabelList();
}

function renderLabelList() {
  labelListEl.innerHTML = "";
  if (!state.labelRows.length) {
    labelListEl.innerHTML =
      '<li class="label-list-empty">No labels yet. Add one above.</li>';
    return;
  }
  state.labelRows.forEach((label, i) => {
    const li = document.createElement("li");
    li.className = "label-row";
    li.dataset.id = label.id;

    const color = document.createElement("input");
    color.type = "color";
    color.className = "label-row-color";
    color.value = _validHexColor(label.color) ? label.color : "#888888";
    color.title = "Change colour";
    color.setAttribute("aria-label", `Colour for ${label.name}`);
    color.addEventListener("change", () =>
      saveLabel(label, { color: color.value }, color),
    );

    const name = document.createElement("input");
    name.type = "text";
    name.className = "label-row-name";
    name.value = label.name;
    name.spellcheck = false;
    name.maxLength = 60;
    name.setAttribute("aria-label", "Label name");
    const commitName = () => {
      const next = name.value.trim();
      if (next === label.name) return;
      if (!next) {
        name.value = label.name;
        return;
      }
      saveLabel(label, { name: next }, name);
    };
    name.addEventListener("blur", commitName);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      else if (e.key === "Escape") {
        name.value = label.name;
        name.blur();
      }
    });

    const count = document.createElement("span");
    count.className = "label-row-count";
    count.textContent = `${label.count} conv${label.count === 1 ? "" : "s"}`;

    const up = document.createElement("button");
    up.type = "button";
    up.className = "label-row-btn";
    up.textContent = "↑";
    up.title = "Move up";
    up.setAttribute("aria-label", `Move ${label.name} up`);
    up.disabled = i === 0;
    up.addEventListener("click", () => moveLabel(i, -1));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "label-row-btn";
    down.textContent = "↓";
    down.title = "Move down";
    down.setAttribute("aria-label", `Move ${label.name} down`);
    down.disabled = i === state.labelRows.length - 1;
    down.addEventListener("click", () => moveLabel(i, 1));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "label-row-btn label-row-delete";
    del.textContent = "✕";
    del.title = `Delete ${label.name}`;
    del.setAttribute("aria-label", `Delete ${label.name}`);
    del.addEventListener("click", () => deleteLabel(label));

    li.append(color, name, count, up, down, del);
    labelListEl.appendChild(li);
  });
}

async function saveLabel(label, patch, inputEl) {
  showLabelError("");
  try {
    const data = await apiModelState(`/api/labels/${encodeURIComponent(label.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    state.labelRows = data.labels || [];
    renderLabelList();
    onLabelDefsChanged();
  } catch (e) {
    // Put the rejected value back.
    if (inputEl && "name" in patch) inputEl.value = label.name;
    if (inputEl && "color" in patch)
      inputEl.value = _validHexColor(label.color) ? label.color : "#888888";
    showLabelError(e.message);
  }
}

async function moveLabel(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.labelRows.length) return;
  const ids = state.labelRows.map((l) => l.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  showLabelError("");
  try {
    const data = await apiModelState("/api/labels/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ids }),
    });
    state.labelRows = data.labels || [];
    renderLabelList();
    onLabelDefsChanged();
  } catch (e) {
    showLabelError(e.message);
  }
}

async function deleteLabel(label) {
  const used = label.count > 0;
  const msg = used
    ? `Delete the label “${label.name}”? ${label.count} conversation${
        label.count === 1 ? "" : "s"
      } currently use it and will be cleared back to blank.`
    : `Delete the label “${label.name}”?`;
  const ok = await openConfirm({
    title: "Delete label?",
    text: msg,
    okLabel: "Delete label",
  });
  if (!ok) return;
  showLabelError("");
  try {
    const data = await apiModelState(`/api/labels/${encodeURIComponent(label.id)}`, {
      method: "DELETE",
    });
    state.labelRows = data.labels || [];
    renderLabelList();
    onLabelDefsChanged();
  } catch (e) {
    showLabelError(e.message);
  }
}

labelAddForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showLabelError("");
  const name = labelAddName.value.trim();
  if (!name) {
    showLabelError("Enter a name for the label.");
    return;
  }
  try {
    const data = await apiModelState("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: labelAddColor.value }),
    });
    state.labelRows = data.labels || [];
    renderLabelList();
    onLabelDefsChanged();
    labelAddName.value = "";
    labelAddName.focus();
  } catch (err) {
    showLabelError(err.message);
  }
});

labelsEnabledToggle?.addEventListener("change", async () => {
  await saveUiPreferences({ labelsEnabled: labelsEnabledToggle.checked });
  // Make sure the definitions are loaded, then bring the whole UI in line:
  // filter options, sidebar squares, and the open conversation's header.
  await loadLabelDefs();
  syncLabelFilterOptions();
  loadConversations(false);
  if (state.activeId) renderHeaderLabel(state.activeId, state.activeLabel);
});

labelsDisplaySelect?.addEventListener("change", () => {
  const val =
    labelsDisplaySelect.value === "square_label" ? "square_label" : "square";
  saveUiPreferences({ labelDisplay: val });
  // The display mode changes how every square renders.
  if (labelsFeatureOn()) {
    loadConversations(false);
    if (state.activeId) renderHeaderLabel(state.activeId, state.activeLabel);
  }
});

// ── Label indicators + assignment (runtime) ──────────────────────────────────
// The compact square shown before each conversation title. Rendering and every
// interaction here are gated on the feature being enabled; when it is off no
// square, menu entry, or label view appears, and the stored data is untouched.

function labelsFeatureOn() {
  return !!state.preferences.labelsEnabled;
}

// Labels in their user-configured cycle order. The server already returns them
// ordered by sort_index, but sort defensively so cycling never depends on it.
function orderedLabels() {
  return [...state.labelRows].sort(
    (a, b) => (a.sort_index || 0) - (b.sort_index || 0),
  );
}

function labelById(id) {
  return state.labelRows.find((l) => l.id === id) || null;
}

// Load the label definitions once (and after any change) so squares and cycling
// work without opening the Labels screen. Shared with refreshLabelList's data.
async function loadLabelDefs() {
  try {
    const data = await apiModelState("/api/labels");
    state.labelRows = data.labels || [];
  } catch {
    state.labelRows = [];
  }
  return state.labelRows;
}

// Build the indicator element for one conversation. In "square" mode it is just
// the square (name only in tooltip/aria); in "square_label" mode a compact name
// rides beside it. Always keyboard-focusable and clickable.
function labelIndicatorEl(convId, label) {
  const wrap = document.createElement("span");
  wrap.className = "label-indicator";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "label-square" + (label ? "" : " label-square-blank");
  if (label) {
    btn.style.background = _validHexColor(label.color) ? label.color : "#888888";
    btn.title = label.name;
    btn.setAttribute("aria-label", `Label: ${label.name}. Activate to change.`);
  } else {
    btn.title = "No label";
    btn.setAttribute("aria-label", "No label. Activate to set one.");
  }
  // Primary click cycles; it must never also open/select the conversation.
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    cycleConvLabel(convId, label);
  });
  // A right-click offers direct selection without repeated cycling.
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSetLabelPopover(convId, label ? label.id : null, btn);
  });
  wrap.appendChild(btn);

  if (label && state.preferences.labelDisplay === "square_label") {
    const txt = document.createElement("span");
    txt.className = "label-text";
    txt.textContent = label.name;
    wrap.appendChild(txt);
  }
  return wrap;
}

// Blank → label[0] → label[1] → … → last → Blank, in configured order.
async function cycleConvLabel(convId, currentLabel) {
  const order = orderedLabels();
  if (!order.length) return; // no labels configured — nothing to cycle to
  let nextId;
  if (!currentLabel) {
    nextId = order[0].id;
  } else {
    const idx = order.findIndex((l) => l.id === currentLabel.id);
    if (idx === -1) nextId = order[0].id;
    else if (idx >= order.length - 1) nextId = null; // wrap back to blank
    else nextId = order[idx + 1].id;
  }
  await setConvLabel(convId, nextId);
}

async function setConvLabel(convId, labelId) {
  try {
    const data = await apiModelState("/api/conversation-labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conv_id: convId, label_id: labelId || null }),
    });
    applyConvLabelResult(convId, data.label || null);
  } catch (_) {
    /* leave the current square as-is on failure */
  }
}

// Reflect a just-applied label into the UI without a full reload where possible.
function applyConvLabelResult(convId, label) {
  // In a label view the row may now belong (or no longer belong) to the filter,
  // so reload the filtered list rather than leaving a stale row behind.
  if (String(state.view).startsWith("label:")) {
    loadConversations(false);
  } else {
    refreshRowLabel(convId, label);
  }
  if (convId === state.activeId) {
    state.activeLabel = label;
    renderHeaderLabel(convId, label);
  }
  // Keep the Labels screen's usage counts fresh if it happens to be open.
  if (state.activeSpecialView === "labels") {
    loadLabelDefs().then(() => {
      renderLabelList();
    });
  }
}

// Replace (or insert) the indicator on a sidebar row in place.
function refreshRowLabel(convId, label) {
  const item = findConvItemEl(convId);
  const title = item?.querySelector(".conv-title");
  if (!title) return;
  const fresh = labelsFeatureOn() ? labelIndicatorEl(convId, label) : null;
  const old = title.querySelector(":scope > .label-indicator");
  if (fresh) {
    if (old) title.replaceChild(fresh, old);
    else title.insertBefore(fresh, title.firstChild);
  } else if (old) {
    old.remove();
  }
}

// The square shown next to the open conversation's title in the header.
function renderHeaderLabel(convId, label) {
  const holder = $("thread-title-square");
  if (!holder) return;
  holder.innerHTML = "";
  if (!labelsFeatureOn() || !convId) return;
  holder.appendChild(labelIndicatorEl(convId, label));
}

// ── Direct label selection (⋮ menus + right-click popover) ────────────────────

// Add a "Set label" group (Blank + each configured label) to an open menu.
// itemClass matches the menu's own button class so styling stays consistent.
function appendSetLabelToMenu(menu, convId, currentLabelId, itemClass, onSelect) {
  const cap = document.createElement("div");
  cap.className = "menu-section-caption";
  cap.textContent = "Set label";
  menu.appendChild(cap);

  const options = [{ id: null, name: "Blank", color: null }, ...orderedLabels()];
  for (const opt of options) {
    const b = document.createElement("button");
    b.className = `${itemClass} set-label-item`;
    b.setAttribute("role", "menuitem");

    const dot = document.createElement("span");
    dot.className = "menu-label-dot" + (opt.id ? "" : " menu-label-dot-blank");
    if (opt.id) dot.style.background = _validHexColor(opt.color) ? opt.color : "#888888";

    const name = document.createElement("span");
    name.className = "sidebar-menu-item-label";
    name.textContent = opt.name;

    b.append(dot, name);
    if ((opt.id || null) === (currentLabelId || null)) {
      const check = document.createElement("span");
      check.className = "menu-check";
      check.textContent = "✓";
      b.appendChild(check);
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (onSelect) onSelect();
      setConvLabel(convId, opt.id);
    });
    menu.appendChild(b);
  }
}

let _setLabelPopover = null;
function closeSetLabelPopover() {
  if (_setLabelPopover) {
    _setLabelPopover.remove();
    _setLabelPopover = null;
    document.removeEventListener("mousedown", _onSetLabelOutside, true);
    window.removeEventListener("scroll", closeSetLabelPopover, true);
  }
}
function _onSetLabelOutside(e) {
  if (_setLabelPopover && !_setLabelPopover.contains(e.target)) {
    closeSetLabelPopover();
  }
}
// A small standalone menu anchored to a square, for right-click direct-select.
function openSetLabelPopover(convId, currentLabelId, anchorEl) {
  closeSetLabelPopover();
  if (!labelsFeatureOn()) return;
  const menu = document.createElement("div");
  menu.className = "sidebar-menu conv-item-menu";
  menu.setAttribute("role", "menu");
  appendSetLabelToMenu(menu, convId, currentLabelId, "sidebar-menu-item", () =>
    closeSetLabelPopover(),
  );
  document.body.appendChild(menu);
  _setLabelPopover = menu;
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    top = r.top - menu.offsetHeight - 4;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  document.addEventListener("mousedown", _onSetLabelOutside, true);
  window.addEventListener("scroll", closeSetLabelPopover, true);
}

// ── Label filter views in the existing view/filter control ────────────────────

function labelViewTitle(view) {
  if (!view || !String(view).startsWith("label:")) return null;
  const sel = String(view).slice("label:".length);
  if (sel === "__unlabeled__") return "Unlabeled";
  const l = labelById(sel);
  return l ? l.name : "Label";
}

// Rebuild the label options in the filter dropdown to match the current
// definitions and enabled state. Provider selection is unaffected — the server
// applies the provider filter alongside the label filter.
function syncLabelFilterOptions() {
  if (!viewFilterEl) return;
  viewFilterEl
    .querySelectorAll("option.label-view-option")
    .forEach((o) => o.remove());
  if (!labelsFeatureOn()) {
    if (String(state.view).startsWith("label:")) {
      state.view = "recent";
      viewFilterEl.value = "recent";
      updateListSectionTitle();
    }
    return;
  }
  const mk = (val, text) => {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = text;
    o.className = "label-view-option";
    return o;
  };
  const frag = document.createDocumentFragment();
  frag.appendChild(mk("label:__unlabeled__", "Unlabeled"));
  for (const l of orderedLabels()) frag.appendChild(mk("label:" + l.id, l.name));
  viewFilterEl.appendChild(frag);
  // Keep the current selection valid; if its label was deleted, fall back.
  if (String(state.view).startsWith("label:")) {
    viewFilterEl.value = state.view;
    if (viewFilterEl.value !== state.view) {
      state.view = "recent";
      viewFilterEl.value = "recent";
    }
    updateListSectionTitle();
  }
}

// Called after label definitions change (add/rename/recolour/reorder/delete):
// refresh the filter options and any visible squares.
function onLabelDefsChanged() {
  syncLabelFilterOptions();
  // Keep the bulk tool's label/target dropdowns in step while it's on screen.
  if (state.activeSpecialView === "labels") refreshBulkLabelSelects();
  if (labelsFeatureOn()) {
    loadConversations(false);
    if (state.activeId) {
      // The open conversation's label object may have been recoloured/renamed
      // or cleared (its label deleted); re-read it from the label defs.
      if (state.activeLabel) {
        const fresh = labelById(state.activeLabel.id);
        state.activeLabel = fresh
          ? { id: fresh.id, name: fresh.name, color: fresh.color }
          : null;
      }
      renderHeaderLabel(state.activeId, state.activeLabel);
    }
  }
}

// ── Conditional bulk labeling (Labels screen · sections C & D) ────────────────
// A narrow tool: pick conversations by criteria (all ANDed) and Set Label To a
// label or Blank. It never deletes/archives/moves. Preview before Apply; every
// applied change is logged to Recent Bulk Changes for reuse (not undo).

let _bulkPreviewed = null; // {crit, data} captured on a successful preview

function showBulkError(msg) {
  if (!bulkErrorEl) return;
  bulkErrorEl.textContent = msg || "";
  bulkErrorEl.hidden = !msg;
}

function invalidateBulkPreview() {
  _bulkPreviewed = null;
  if (bulkApplyBtn) bulkApplyBtn.disabled = true;
  if (bulkResultEl) bulkResultEl.hidden = true;
}

// Fill the label/target/folder/tag selects from current data, preserving any
// selection that is still valid.
// Rebuild only the label-derived selects (no network) — used when definitions
// change while the screen is open.
function refreshBulkLabelSelects() {
  const fillLabels = (sel, first) => {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = first;
    for (const l of orderedLabels()) {
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.name;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  };
  fillLabels($("bulk-label"), '<option value="any">Any</option><option value="blank">Blank</option>');
  fillLabels($("bulk-target"), '<option value="blank">Blank</option>');
}

async function populateBulkForm() {
  refreshBulkLabelSelects();

  const folderSel = $("bulk-folder");
  if (folderSel) {
    let folders = [];
    try {
      const d = await (await fetch("/api/folders")).json();
      folders = d.folders || [];
    } catch (_) {}
    const cur = folderSel.value;
    folderSel.innerHTML =
      '<option value="any">Any</option><option value="none">No folder</option>';
    for (const f of folders) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.name;
      folderSel.appendChild(o);
    }
    if ([...folderSel.options].some((o) => o.value === cur)) folderSel.value = cur;
  }

  const tagSel = $("bulk-tag");
  if (tagSel) {
    let tags = [];
    try {
      const d = await (await fetch("/api/tags")).json();
      tags = d.tags || [];
    } catch (_) {}
    const cur = tagSel.value;
    tagSel.innerHTML = '<option value="">Any</option>';
    for (const t of tags) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      tagSel.appendChild(o);
    }
    if ([...tagSel.options].some((o) => o.value === cur)) tagSel.value = cur;
  }
}

// Show/hide the date input(s) for one date criterion based on its operator.
function syncBulkDateOp(prefix) {
  const op = $(prefix + "-op")?.value || "any";
  const d1 = $(prefix + "-date");
  const and = $(prefix + "-and");
  const d2 = $(prefix + "-date2");
  const showFirst = op === "before" || op === "after" || op === "between";
  if (d1) d1.hidden = !showFirst;
  if (and) and.hidden = op !== "between";
  if (d2) d2.hidden = op !== "between";
}

function readBulkCriteria() {
  const dateSpec = (prefix) => {
    const op = $(prefix + "-op")?.value || "any";
    const spec = { op };
    if (op === "before" || op === "after") spec.date = $(prefix + "-date")?.value || "";
    if (op === "between") {
      spec.date = $(prefix + "-date")?.value || "";
      spec.date2 = $(prefix + "-date2")?.value || "";
    }
    return spec;
  };
  const limitMode =
    document.querySelector('input[name="bulk-limit"]:checked')?.value || "all";
  return {
    provider: $("bulk-provider")?.value || "all",
    started: dateSpec("bulk-started"),
    ended: dateSpec("bulk-ended"),
    label: $("bulk-label")?.value || "any",
    folder: $("bulk-folder")?.value || "any",
    tag: $("bulk-tag")?.value || "",
    keyword: ($("bulk-keyword")?.value || "").trim(),
    order: $("bulk-order")?.value || "started_asc",
    limit:
      limitMode === "first"
        ? { mode: "first", n: Math.max(1, parseInt($("bulk-limit-n")?.value, 10) || 1) }
        : { mode: "all" },
    target: $("bulk-target")?.value || "blank",
  };
}

function validateBulkCriteria(crit) {
  for (const [spec, name] of [
    [crit.started, "Started"],
    [crit.ended, "Last updated"],
  ]) {
    if ((spec.op === "before" || spec.op === "after") && !spec.date)
      return `${name}: choose a date.`;
    if (spec.op === "between" && (!spec.date || !spec.date2))
      return `${name}: choose both dates.`;
  }
  if (crit.limit.mode === "first" && (!crit.limit.n || crit.limit.n < 1))
    return "Limit: enter a positive number.";
  return null;
}

async function bulkPreview() {
  const crit = readBulkCriteria();
  const err = validateBulkCriteria(crit);
  if (err) {
    showBulkError(err);
    invalidateBulkPreview();
    return;
  }
  showBulkError("");
  let data;
  try {
    data = await apiModelState("/api/labels/bulk-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crit),
    });
  } catch (e) {
    showBulkError(e.message);
    invalidateBulkPreview();
    return;
  }
  const target = data.target_label_name || "Blank";
  bulkResultEl.innerHTML =
    `<strong>${data.eligible.toLocaleString()}</strong> match the criteria · ` +
    `batch of <strong>${data.batch_size.toLocaleString()}</strong> · ` +
    `<strong>${data.changed.toLocaleString()}</strong> would change to “${escHtml(target)}”.`;
  bulkResultEl.hidden = false;
  _bulkPreviewed = { crit, data };
  bulkApplyBtn.disabled = data.batch_size === 0;
}

async function bulkApply() {
  if (!_bulkPreviewed) return;
  const { crit, data } = _bulkPreviewed;
  const target = data.target_label_name || "Blank";
  const ok = await openConfirm({
    title: "Apply label to batch?",
    text:
      `Set label to “${target}” on ${data.changed.toLocaleString()} conversation` +
      `${data.changed === 1 ? "" : "s"} (batch of ${data.batch_size.toLocaleString()}, ` +
      `${data.eligible.toLocaleString()} matched). This is not undoable — ` +
      "make a Safety Snapshot first if you want a recovery point.",
    okLabel: "Apply label",
  });
  if (!ok) return;
  let res;
  try {
    res = await apiModelState("/api/labels/bulk-apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crit),
    });
  } catch (e) {
    showBulkError(e.message);
    return;
  }
  bulkResultEl.innerHTML =
    `Applied: <strong>${res.changed.toLocaleString()}</strong> changed of ` +
    `${res.batch_size.toLocaleString()} in batch (${res.eligible.toLocaleString()} matched).`;
  bulkResultEl.hidden = false;
  invalidateBulkPreview();
  // Refresh label counts, sidebar squares, the filter, and the history list.
  await loadLabelDefs();
  renderLabelList();
  onLabelDefsChanged();
  loadBulkHistory();
}

async function loadBulkHistory() {
  if (!bulkHistoryList) return;
  let hist = [];
  try {
    const d = await apiModelState("/api/labels/bulk-history");
    hist = d.history || [];
  } catch (_) {}
  bulkHistoryList.innerHTML = "";
  if (!hist.length) {
    bulkHistoryList.innerHTML =
      '<li class="bulk-history-empty">No bulk changes yet.</li>';
    return;
  }
  for (const h of hist) {
    const li = document.createElement("li");
    li.className = "bulk-history-row";
    const main = document.createElement("div");
    main.className = "bulk-history-main";
    const desc = document.createElement("div");
    desc.className = "bulk-history-desc";
    desc.textContent = h.description || "(bulk change)";
    const when = document.createElement("div");
    when.className = "bulk-history-when";
    when.textContent = h.created_at
      ? new Date(h.created_at * 1000).toLocaleString()
      : "";
    main.append(desc, when);
    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.className = "bulk-history-reuse";
    reuse.textContent = "Reuse";
    reuse.title = "Load this selection into the tool above";
    reuse.addEventListener("click", () => reuseBulkCriteria(h.criteria || {}));
    li.append(main, reuse);
    bulkHistoryList.appendChild(li);
  }
}

// Load a past operation's criteria back into the form. Ids that no longer exist
// (a deleted label/folder) fall back to Any/Blank rather than an empty select.
function reuseBulkCriteria(crit) {
  const setSel = (id, val, fallback) => {
    const el = $(id);
    if (!el) return;
    el.value = val;
    if (el.value !== val) el.value = fallback;
  };
  setSel("bulk-provider", crit.provider || "all", "all");
  const applyDate = (prefix, spec) => {
    spec = spec || { op: "any" };
    if ($(prefix + "-op")) $(prefix + "-op").value = spec.op || "any";
    if ($(prefix + "-date")) $(prefix + "-date").value = spec.date || "";
    if ($(prefix + "-date2")) $(prefix + "-date2").value = spec.date2 || "";
    syncBulkDateOp(prefix);
  };
  applyDate("bulk-started", crit.started);
  applyDate("bulk-ended", crit.ended);
  setSel("bulk-label", crit.label || "any", "any");
  setSel("bulk-folder", crit.folder || "any", "any");
  setSel("bulk-tag", crit.tag || "", "");
  if ($("bulk-keyword")) $("bulk-keyword").value = crit.keyword || "";
  setSel("bulk-order", crit.order || "started_asc", "started_asc");
  const lim = crit.limit || { mode: "all" };
  const mode = lim.mode === "first" ? "first" : "all";
  document
    .querySelectorAll('input[name="bulk-limit"]')
    .forEach((r) => (r.checked = r.value === mode));
  if ($("bulk-limit-n")) {
    $("bulk-limit-n").disabled = mode !== "first";
    if (mode === "first" && lim.n) $("bulk-limit-n").value = lim.n;
  }
  setSel("bulk-target", crit.target || "blank", "blank");
  invalidateBulkPreview();
  showBulkError("");
  $("bulk-provider")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── Bulk-tool event wiring ────────────────────────────────────────────────────
["bulk-started", "bulk-ended"].forEach((prefix) => {
  $(prefix + "-op")?.addEventListener("change", () => syncBulkDateOp(prefix));
});
document.querySelectorAll('input[name="bulk-limit"]').forEach((r) => {
  r.addEventListener("change", () => {
    const first = r.value === "first" && r.checked;
    const n = $("bulk-limit-n");
    if (n) n.disabled = !first;
  });
});
// Any criteria change invalidates a standing preview so Apply can't act on stale
// numbers. (Buttons emit no input/change events, so Preview/Apply are unaffected.)
document.querySelector(".bulk-form")?.addEventListener("input", invalidateBulkPreview);
document.querySelector(".bulk-form")?.addEventListener("change", invalidateBulkPreview);
bulkPreviewBtn?.addEventListener("click", bulkPreview);
bulkApplyBtn?.addEventListener("click", bulkApply);

// ── Import New Chats screen ──────────────────────────────────────────────────
// Scans the source folder for backup files not yet imported, identifies each as
// a Claude or ChatGPT export, merges it in, and renames the source file. Below
// the import area is the history of every backup already brought in.

const importNewBtn = $("import-new-btn");
const importNewStatus = $("import-new-status");
const importNewSummary = $("import-new-summary");
const importHistoryBody = $("import-history-body");
const importHistoryTable = $("import-history-table");
const importDeletedModeEl = $("import-deleted-mode");
const importReviewNewWrap = $("import-review-new-wrap");
const importReviewNewEl = $("import-review-new");
const importReviewArea = $("import-review-area");
const importReviewBody = $("import-review-body");
const importReviewAllBtn = $("import-review-all");
const importReviewNoneBtn = $("import-review-none");
const importReviewSelectedBtn = $("import-review-selected");

// The "has new messages" checkbox only applies to the skip choice.
function syncImportDeletedSetting() {
  if (importReviewNewWrap) {
    importReviewNewWrap.hidden = state.importNew.deletedMode !== "skip";
  }
}

async function openImportNew() {
  rememberReturnTab();
  state.activeSpecialView = "import_new";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("import_new", "Import New Chats");
  hideAllPanels();
  importNewPanel.hidden = false;
  if (importDeletedModeEl) importDeletedModeEl.value = state.importNew.deletedMode;
  if (importReviewNewEl) importReviewNewEl.checked = state.importNew.reviewNewMessages;
  syncImportDeletedSetting();
  await loadImportHistory();
  await loadReviewArea();
}

// The review area lists previously deleted conversations held aside from an
// import for the user to decide on. It is persisted server-side, so it survives
// reopening the Import screen until every row is imported or dismissed.
async function loadReviewArea() {
  let review = [];
  try {
    const resp = await fetch("/api/import-new/review");
    if (resp.ok) {
      const data = await resp.json();
      review = data.review || [];
    }
  } catch (_) {
    review = [];
  }
  state.importNew.review = review;
  // Drop any checked ids that are no longer present.
  const present = new Set(review.map((r) => r.conversation_id));
  for (const id of Array.from(state.importNew.reviewChecked)) {
    if (!present.has(id)) state.importNew.reviewChecked.delete(id);
  }
  renderReviewArea();
}

function renderReviewArea() {
  if (!importReviewArea) return;
  const review = state.importNew.review || [];
  if (!review.length) {
    importReviewArea.hidden = true;
    importReviewBody.innerHTML = "";
    return;
  }
  importReviewArea.hidden = false;
  importReviewBody.innerHTML = "";
  for (const r of review) {
    const tr = document.createElement("tr");
    const checked = state.importNew.reviewChecked.has(r.conversation_id);
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "import-review-select";
    cb.checked = checked; // checkboxes start unchecked (nothing is pre-checked)
    cb.addEventListener("change", () => {
      if (cb.checked) state.importNew.reviewChecked.add(r.conversation_id);
      else state.importNew.reviewChecked.delete(r.conversation_id);
    });
    const tdCheck = document.createElement("td");
    tdCheck.className = "import-review-check";
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);
    const cells = [
      r.chat_name || "Untitled",
      fmtImportDate(r.first_message),
      fmtImportDate(r.last_message),
      (r.total_messages || 0).toLocaleString(),
    ];
    cells.forEach((val, i) => {
      const td = document.createElement("td");
      if (i === 3) td.className = "import-cell-num";
      td.textContent = val;
      tr.appendChild(td);
    });
    importReviewBody.appendChild(tr);
  }
}

async function apiReviewImport(body) {
  const r = await fetch("/api/import-new/review-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function loadImportHistory() {
  importHistoryBody.innerHTML =
    '<tr><td colspan="5" class="import-history-empty">Loading…</td></tr>';
  try {
    const resp = await fetch("/api/imported-backups");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.importNew.backups = data.backups || [];
  } catch (e) {
    importHistoryBody.innerHTML = `<tr><td colspan="5" class="import-history-empty">Could not load import history: ${escHtml(
      e.message,
    )}.</td></tr>`;
    return;
  }
  renderImportHistory();
}

// A short absolute date for the table cells (the relative formatDate used in the
// sidebar is not what you want when scanning a list of backups).
function fmtImportDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderImportHistory() {
  const { provider, sortKey, sortDir } = state.importNew;
  let rows = state.importNew.backups.slice();
  if (provider === "claude" || provider === "chatgpt") {
    rows = rows.filter((r) => r.provider === provider);
  }

  const numeric = sortKey !== "file_name";
  rows.sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    let cmp;
    if (numeric) {
      cmp = (Number(av) || 0) - (Number(bv) || 0);
    } else {
      cmp = String(av || "").localeCompare(String(bv || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  // Reflect the active sort in the header cells.
  importHistoryTable.querySelectorAll("th[data-sort]").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  if (!rows.length) {
    importHistoryBody.innerHTML =
      '<tr><td colspan="5" class="import-history-empty">No backups imported yet.</td></tr>';
    return;
  }

  importHistoryBody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const label = r.provider === "chatgpt" ? "ChatGPT" : "Claude";
    tr.innerHTML = `
      <td class="import-cell-name">
        <span class="import-provider-tag import-provider-${escHtml(
          r.provider,
        )}">${escHtml(label)}</span>
        <span class="import-file-name">${escHtml(r.file_name || "")}</span>
      </td>
      <td>${escHtml(fmtImportDate(r.first_chat))}</td>
      <td>${escHtml(fmtImportDate(r.last_chat))}</td>
      <td class="import-cell-num">${(r.total_chats || 0).toLocaleString()}</td>
      <td>${escHtml(fmtImportDate(r.imported_at))}</td>`;
    importHistoryBody.appendChild(tr);
  }
}

// Column-heading sort: first click sorts by that column, clicking the same
// column again reverses direction.
importHistoryTable?.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    const s = state.importNew;
    if (s.sortKey === key) {
      s.sortDir = s.sortDir === "asc" ? "desc" : "asc";
    } else {
      s.sortKey = key;
      // Text defaults to A→Z; dates/numbers default to newest/largest first.
      s.sortDir = key === "file_name" ? "asc" : "desc";
    }
    renderImportHistory();
  });
});

document
  .querySelectorAll('input[name="import-provider-filter"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        state.importNew.provider = radio.value;
        renderImportHistory();
      }
    });
  });

async function runImportNew() {
  if (state.importNew.busy) return;
  state.importNew.busy = true;
  importNewBtn.disabled = true;
  importNewSummary.hidden = true;
  importNewStatus.innerHTML =
    '<span class="import-spinner" aria-hidden="true"></span><span>Importing, Please Wait</span>';

  let data;
  try {
    const resp = await fetch("/api/import-new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deleted_mode: state.importNew.deletedMode,
        review_new_messages: state.importNew.reviewNewMessages,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    importNewStatus.innerHTML = "";
    importNewSummary.hidden = false;
    importNewSummary.innerHTML = `<div class="import-summary-error">Import failed: ${escHtml(
      e.message,
    )}.</div>`;
    state.importNew.busy = false;
    importNewBtn.disabled = false;
    return;
  }

  importNewStatus.innerHTML = "";
  renderImportSummary(data);
  await loadImportHistory();
  // Refresh the review area — this import may have held conversations aside.
  await loadReviewArea();
  // New conversations should show up in the sidebar without a reload.
  try {
    await loadConversations(false);
  } catch (_) {}

  state.importNew.busy = false;
  importNewBtn.disabled = false;
}

function renderImportSummary(data) {
  if (data.error) {
    importNewSummary.hidden = false;
    importNewSummary.innerHTML = `<div class="import-summary-error">${escHtml(
      data.error,
    )}</div>`;
    return;
  }
  const stats = [
    { label: "Added", n: data.added || 0 },
    { label: "Updated", n: data.updated || 0 },
    { label: "Unchanged", n: data.unchanged || 0 },
    { label: "Skipped", n: data.skipped || 0 },
    { label: "Errors", n: data.errors || 0, err: (data.errors || 0) > 0 },
  ];
  if (data.review) {
    stats.push({ label: "To review", n: data.review });
  }
  const nFiles = (data.files || []).length;
  const totalConvs = stats.reduce((a, s) => a + s.n, 0);

  let html = '<div class="import-summary-head">';
  if (nFiles === 0 && !(data.notes || []).length) {
    html += "No new backup files found in the source folder.";
  } else if (nFiles === 0) {
    html += "No new conversations were imported.";
  } else {
    html += `Imported ${nFiles} backup file${
      nFiles !== 1 ? "s" : ""
    } (${totalConvs.toLocaleString()} conversation${
      totalConvs !== 1 ? "s" : ""
    } processed).`;
  }
  html += "</div>";

  html += '<div class="import-summary-stats">';
  for (const s of stats) {
    html += `<div class="import-stat${
      s.err ? " import-stat-error" : ""
    }"><span class="import-stat-n">${s.n.toLocaleString()}</span><span class="import-stat-label">${escHtml(
      s.label,
    )}</span></div>`;
  }
  html += "</div>";

  if ((data.notes || []).length) {
    html += '<ul class="import-summary-notes">';
    for (const note of data.notes) {
      html += `<li>${escHtml(note)}</li>`;
    }
    html += "</ul>";
  }

  importNewSummary.hidden = false;
  importNewSummary.innerHTML = html;
}

importNewBtn?.addEventListener("click", runImportNew);

importDeletedModeEl?.addEventListener("change", () => {
  state.importNew.deletedMode = importDeletedModeEl.value || "skip";
  syncImportDeletedSetting();
});
importReviewNewEl?.addEventListener("change", () => {
  state.importNew.reviewNewMessages = importReviewNewEl.checked;
});

// Import All / None / Selected for the review area.
async function resolveReview({ importAll = false, dismissAll = false } = {}) {
  const body = {};
  if (importAll) {
    body.import_all = true;
  } else if (dismissAll) {
    body.dismiss_all = true;
  } else {
    const review = state.importNew.review || [];
    const byId = new Map(review.map((r) => [r.conversation_id, r]));
    body.import_ids = Array.from(state.importNew.reviewChecked)
      .filter((id) => byId.has(id))
      .map((id) => ({ id, provider: byId.get(id).provider }));
    if (!body.import_ids.length) {
      return; // nothing checked — no-op
    }
  }
  await apiReviewImport(body);
  state.importNew.reviewChecked.clear();
  await loadReviewArea();
  await loadImportHistory();
  try {
    await loadConversations(false);
  } catch (_) {}
}

importReviewAllBtn?.addEventListener("click", () =>
  resolveReview({ importAll: true }),
);
importReviewNoneBtn?.addEventListener("click", () =>
  resolveReview({ dismissAll: true }),
);
importReviewSelectedBtn?.addEventListener("click", () => resolveReview({}));

// ── Add Claude Models screen ─────────────────────────────────────────────────

async function openClaudeModels() {
  rememberReturnTab();
  state.activeSpecialView = "claude_models";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("claude_models", "Add Claude Models");
  hideAllPanels();
  claudeModelsPanel.hidden = false;
  await refreshModelTable();
}

async function refreshModelTable() {
  try {
    const data = await apiModelState("/api/claude-models");
    state.modelRows = data.models || [];
  } catch {
    modelTableBody.innerHTML =
      '<tr><td colspan="4" class="no-results">Could not load the model list.</td></tr>';
    return;
  }
  renderModelTable();
}

// Every cell is editable in place. The name belongs to the model rather than to
// one row, so a model with two availability windows shows its name on both and
// editing either renames the model.
function renderModelTable() {
  modelTableBody.innerHTML = "";
  if (!state.modelRows.length) {
    modelTableBody.innerHTML =
      '<tr><td colspan="4" class="no-results">No models yet. Add one above.</td></tr>';
    return;
  }
  let previousModel = null;
  for (const row of state.modelRows) {
    const tr = document.createElement("tr");
    // A model's extra availability windows are tied visually to the first one.
    if (row.model_id === previousModel) tr.classList.add("model-row-continued");
    previousModel = row.model_id;

    tr.appendChild(modelCell(row, "name", "text", row.name));
    tr.appendChild(modelCell(row, "start_date", "date", row.start_date));
    tr.appendChild(modelCell(row, "end_date", "date", row.end_date || ""));

    const actions = document.createElement("td");
    actions.className = "model-cell-actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "model-row-delete";
    del.title = `Delete ${row.name} (${row.start_date})`;
    del.setAttribute("aria-label", `Delete ${row.name}`);
    del.textContent = "✕";
    del.addEventListener("click", () => deleteModelRow(row));
    actions.appendChild(del);
    tr.appendChild(actions);
    modelTableBody.appendChild(tr);
  }
}

function modelCell(row, field, type, value) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  input.className = "model-cell-input";
  if (type === "text") input.spellcheck = false;
  const commit = () => {
    const next = input.value.trim();
    if (next === String(value || "")) return;
    saveModelRow(row, field, next, input, value);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      input.value = value || "";
      input.blur();
    }
  });
  td.appendChild(input);
  return td;
}

async function saveModelRow(row, field, next, input, previous) {
  showModelError("");
  try {
    const data = await apiModelState(
      `/api/claude-models/${encodeURIComponent(row.period_id)}`,
      { method: "PATCH", body: JSON.stringify({ [field]: next }) },
    );
    state.modelRows = data.models || [];
    renderModelTable();
  } catch (e) {
    input.value = previous || ""; // rejected: put the old value back
    showModelError(e.message);
  }
  // Changed dates can move conversations in or out of range.
  await refreshModelWarnings();
}

async function deleteModelRow(row) {
  showModelError("");
  try {
    const data = await apiModelState(
      `/api/claude-models/${encodeURIComponent(row.period_id)}`,
      { method: "DELETE" },
    );
    state.modelRows = data.models || [];
    renderModelTable();
  } catch (e) {
    showModelError(e.message);
  }
  await refreshModelWarnings();
}

function showModelError(msg) {
  if (!modelAddError) return;
  modelAddError.textContent = msg || "";
  modelAddError.hidden = !msg;
}

modelAddForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showModelError("");
  const body = {
    name: $("model-add-name").value.trim(),
    start_date: $("model-add-start").value,
    end_date: $("model-add-end").value,
  };
  try {
    const data = await apiModelState("/api/claude-models", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.modelRows = data.models || [];
    renderModelTable();
    modelAddForm.reset();
    $("model-add-name").focus();
  } catch (err) {
    showModelError(err.message);
    return;
  }
  await refreshModelWarnings();
});

// Re-reads claude_models.json and applies any corrections (e.g. dates that
// were missing on an earlier import) to the models it names, without
// touching models the user added by hand.
modelReloadBtn?.addEventListener("click", async () => {
  showModelError("");
  modelReloadBtn.disabled = true;
  const originalLabel = modelReloadBtn.textContent;
  modelReloadBtn.textContent = "Reloading…";
  try {
    const data = await apiModelState("/api/claude-models/reload", {
      method: "POST",
    });
    state.modelRows = data.models || [];
    renderModelTable();
  } catch (e) {
    showModelError(e.message);
  } finally {
    modelReloadBtn.disabled = false;
    modelReloadBtn.textContent = originalLabel;
  }
  await refreshModelWarnings();
});

// ── Collapsible thread header ────────────────────────────────────────────────
// The header (title, date/messages, Move to, ⋮) folds away behind the chevron
// in the thin bar above it, the way a window rolls up into its title bar.
// Collapsed, that bar also carries the chat's name so the pane still says what
// you are looking at. The choice is remembered per browser.

function setThreadTitle(text) {
  threadTitle.textContent = text;
  threadTitlebarLabel.textContent = text;
}

function threadHeaderCollapsed() {
  return _lsGet("threadHeaderCollapsed", "0") === "1";
}

function applyThreadHeaderCollapsed() {
  const collapsed = threadHeaderCollapsed();
  threadHeader.hidden = collapsed;
  // Only worth naming the chat up here when the heading below is hidden.
  threadTitlebarLabel.hidden = !collapsed;
  thread.classList.toggle("header-collapsed", collapsed);
  threadCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
  threadCollapseBtn.title = collapsed ? "Expand header" : "Collapse header";
  threadCollapseBtn.setAttribute(
    "aria-label",
    collapsed ? "Expand header" : "Collapse header",
  );
}

threadCollapseBtn?.addEventListener("click", () => {
  _lsSet("threadHeaderCollapsed", threadHeaderCollapsed() ? "0" : "1");
  applyThreadHeaderCollapsed();
});

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
    else if (action === "import-new") openImportNew();
    else if (action === "settings") openSettings();
    else if (action === "claude-models") openClaudeModels();
    else if (action === "labels") openLabels();
  });
});

// ── Memories ──────────────────────────────────────────────────────────────────

async function openMemories(fromButton = false) {
  if (fromButton && state.activeSpecialView === "memories") {
    await returnFromSpecialView();
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
    await returnFromSpecialView();
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

// ── Confirmation modal (permanent deletion) ─────────────────────────────────────
const confirmModal = $("confirm-modal");
const confirmModalTitle = $("confirm-modal-title");
const confirmModalText = $("confirm-modal-text");
const confirmModalCancel = $("confirm-modal-cancel");
const confirmModalOk = $("confirm-modal-ok");
let _confirmResolve = null;

function openConfirm({
  title = "Are you sure?",
  text = "",
  okLabel = "Delete",
} = {}) {
  confirmModalTitle.textContent = title;
  confirmModalText.textContent = text;
  confirmModalOk.textContent = okLabel;
  confirmModal.hidden = false;
  setTimeout(() => confirmModalOk.focus(), 0);
  return new Promise((resolve) => {
    _confirmResolve = resolve;
  });
}
function closeConfirm(result) {
  confirmModal.hidden = true;
  const r = _confirmResolve;
  _confirmResolve = null;
  if (r) r(result);
}
confirmModalCancel?.addEventListener("click", () => closeConfirm(false));
confirmModalOk?.addEventListener("click", () => closeConfirm(true));
confirmModal?.addEventListener("mousedown", (e) => {
  if (e.target === confirmModal) closeConfirm(false);
});
document.addEventListener("keydown", (e) => {
  if (!confirmModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeConfirm(false);
  }
});

// ── Folders ─────────────────────────────────────────────────────────────────
async function apiFolders() {
  const p = new URLSearchParams({ provider: state.providerSide });
  return fetch(`/api/folders?${p}`).then((r) => r.json());
}
async function apiCreateFolder(name, provider) {
  return fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Folders belong to a side. Default to the sidebar's, but callers acting on
    // a specific conversation (e.g. a Compare item from the other provider)
    // pass that conversation's provider instead.
    body: JSON.stringify({
      name,
      provider: provider || state.providerSide,
    }),
  }).then((r) => r.json());
}

// Shared "New folder" dialog flow, used by the sidebar's Add New Folder
// button, its right-click context menu, and the Move-to menu's own entry.
// Returns the created folder (with its id) or null if the user cancelled.
async function promptCreateFolder(provider) {
  const name = await openNameModal({ title: "New folder", value: "" });
  if (!name) return null;
  const res = await apiCreateFolder(name, provider);
  return res && res.id ? res : null;
}

// Create a folder from the sidebar (not tied to any conversation): expand it
// so the user sees it landed, then refresh the tree.
async function createFolderFromSidebar() {
  const res = await promptCreateFolder();
  if (!res) return;
  _expandedFolders.add(res.id);
  _lsSet("expandedFolders", JSON.stringify([..._expandedFolders]));
  // Right-clicking a collapsed Folders section still creates the folder;
  // open the section too so the new folder is actually visible afterward.
  _lsSet("foldersOpen", "1");
  await loadFolders();
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
    empty.textContent = "None yet.";
    foldersTree.appendChild(empty);
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
      // Dropping a chat back on the folder it is already in is a no-op, not a
      // move — going through with it would clear its pin-within-folder.
      if (cid && state.folderOf.get(cid) !== f.id) {
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

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "folder-add-btn";
  addBtn.textContent = "+ Add New Folder";
  addBtn.addEventListener("click", createFolderFromSidebar);
  foldersTree.appendChild(addBtn);
}

// After a folder-membership change: refresh folders + the main list (a chat may
// have entered/left it) and the open conversation's Move-to menu state.
async function afterFolderChange() {
  await loadFolders();
  // Moving a conversation into a folder drops its loose pin server-side, so
  // state.pinnedIds goes stale — and a stale entry makes the star render
  // filled and turns the next click into a no-op unpin.
  await refreshPinnedList();
  await loadConversations(false);
}

foldersToggle?.addEventListener("click", () => {
  _lsSet("foldersOpen", foldersSectionOpen() ? "0" : "1");
  renderFolders();
});

// ── Folders right-click menu ─────────────────────────────────────────────────
// Right-clicking anywhere in the Folders section pops up a small menu, at the
// cursor, with the same "New folder" dialog as the sidebar button.

function closeFoldersCtxMenu() {
  if (!foldersCtxMenu) return;
  foldersCtxMenu.hidden = true;
  document.removeEventListener("mousedown", onFoldersCtxMenuOutside, true);
  document.removeEventListener("keydown", onFoldersCtxMenuKey, true);
}

function onFoldersCtxMenuOutside(e) {
  if (!foldersCtxMenu.contains(e.target)) closeFoldersCtxMenu();
}

function onFoldersCtxMenuKey(e) {
  if (e.key === "Escape") closeFoldersCtxMenu();
}

foldersSection?.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  closeFoldersCtxMenu();
  foldersCtxMenu.hidden = false;
  // Clamp to the viewport so a click near the sidebar's edge doesn't hang
  // the menu off-screen.
  const mw = foldersCtxMenu.offsetWidth;
  const mh = foldersCtxMenu.offsetHeight;
  const left = Math.min(e.clientX, window.innerWidth - mw - 8);
  const top = Math.min(e.clientY, window.innerHeight - mh - 8);
  foldersCtxMenu.style.left = `${Math.max(8, left)}px`;
  foldersCtxMenu.style.top = `${Math.max(8, top)}px`;
  document.addEventListener("mousedown", onFoldersCtxMenuOutside, true);
  document.addEventListener("keydown", onFoldersCtxMenuKey, true);
});

foldersCtxMenu?.querySelector('[data-action="add-folder"]')?.addEventListener(
  "click",
  async () => {
    closeFoldersCtxMenu();
    await createFolderFromSidebar();
  },
);

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

// Bumped on every menu open/close so a slow async Move-to build (which fetches
// the opposite provider's folders) can tell it has been superseded and must not
// pop open a menu wired to a conversation the user has since navigated away from.
let _moveMenuSeq = 0;

function closeThreadMenus() {
  _moveMenuSeq++;
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

async function buildMoveToMenu(cid = state.activeId) {
  // The open conversation may be a Compare item from the opposite provider.
  // Folders are provider-scoped, so offer the folders of the conversation's own
  // provider — placing a chat in another provider's folder would hide it from
  // both sidebars. Reuse the already-loaded set when the sides match.
  const convProvider = state.activeProvider || state.providerSide;
  let folders = state.folders;
  let folderOf = state.folderOf;
  if (convProvider !== state.providerSide) {
    try {
      const p = new URLSearchParams({ provider: convProvider });
      const data = await fetch(`/api/folders?${p}`).then((r) => r.json());
      folders = data.folders || [];
      folderOf = new Map();
      for (const f of folders)
        for (const c of f.conversations || []) folderOf.set(c.id, f.id);
    } catch {
      folders = [];
      folderOf = new Map();
    }
  }
  moveToMenu.innerHTML = "";

  const addNew = document.createElement("button");
  addNew.className = "thread-dropdown-item";
  addNew.textContent = "Add New Folder";
  addNew.addEventListener("click", async () => {
    closeThreadMenus();
    // Create the folder on the conversation's own side, not the sidebar's.
    const res = await promptCreateFolder(convProvider);
    if (res) {
      await apiMoveToFolder(res.id, cid);
      _syncActiveFolderState(cid, res.id);
      await afterFolderChange();
    }
  });
  moveToMenu.appendChild(addNew);

  if (folderOf.has(cid)) {
    const remove = document.createElement("button");
    remove.className = "thread-dropdown-item";
    remove.textContent = "Remove from Folder";
    remove.addEventListener("click", async () => {
      closeThreadMenus();
      await apiRemoveFromFolder(cid);
      _syncActiveFolderState(cid, null);
      await afterFolderChange();
    });
    moveToMenu.appendChild(remove);
  }

  if (folders.length) {
    const sep = document.createElement("div");
    sep.className = "thread-dropdown-sep";
    moveToMenu.appendChild(sep);
  }
  for (const f of folders) {
    const b = document.createElement("button");
    b.className = "thread-dropdown-item";
    const isCurrent = folderOf.get(cid) === f.id;
    if (isCurrent) b.classList.add("current");
    b.textContent = f.name;
    b.addEventListener("click", async () => {
      closeThreadMenus();
      // Already here: moving again would only clear the pin-within-folder.
      if (isCurrent) return;
      await apiMoveToFolder(f.id, cid);
      _syncActiveFolderState(cid, f.id);
      await afterFolderChange();
    });
    moveToMenu.appendChild(b);
  }
}

// Keep the active conversation's tracked folder/pin state in step with a
// Move-to action, so reopening the ⋮ menu shows the right Pin/Unpin label
// without waiting for the conversation to be reopened. Moving into a folder
// clears any loose pin server-side; both operations clear the in-folder pin.
function _syncActiveFolderState(cid, folderId) {
  if (cid !== state.activeId) return;
  state.activeFolderId = folderId;
  state.activeFolderPinned = false;
  if (folderId) state.activePinned = false;
}

moveToBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.activeId) return;
  const wasOpen = !moveToMenu.hidden;
  closeThreadMenus();
  if (wasOpen) return;
  const openForId = state.activeId;
  const seq = ++_moveMenuSeq;
  buildMoveToMenu(openForId).then(() => {
    // The opposite-provider folder fetch is async: bail if the menu was closed,
    // superseded by another open, or the active conversation changed meanwhile —
    // otherwise the menu's folder handlers would act on a stale conversation.
    if (seq !== _moveMenuSeq || state.activeId !== openForId) return;
    moveToMenu.hidden = false;
    document.addEventListener("mousedown", onThreadMenuOutside, true);
  });
});

threadMoreBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.activeId) return;
  const wasOpen = !threadMoreMenu.hidden;
  closeThreadMenus();
  if (wasOpen) return;
  const compareItem = threadMoreMenu.querySelector('[data-action="compare"]');
  if (compareItem) {
    // The menu only ever *adds* to Compare. Removal is exclusively the × on the
    // Compare tab, so a chat already in Compare shows a disabled, no-op entry
    // rather than a "Remove from Compare" action.
    const inCompare = !!compareTabForConv(state.activeId);
    compareItem.textContent = "Compare";
    compareItem.classList.toggle("current", inCompare);
    compareItem.disabled = inCompare;
  }
  const pinItem = threadMoreMenu.querySelector('[data-action="pin"]');
  if (pinItem) {
    // Use the active conversation's own state (set on open) rather than the
    // sidebar-scoped sets, which omit an opposite-provider Compare item.
    if (state.activeFolderId) {
      pinItem.textContent = state.activeFolderPinned ? "Unpin" : "Pin";
    } else {
      pinItem.textContent = state.activePinned ? "Unpin" : "Pin";
    }
  }
  // Rebuild the direct label-selection group each open so it reflects the
  // current definitions and the open conversation's label.
  threadMoreMenu
    .querySelectorAll(".label-menu-injected")
    .forEach((n) => n.remove());
  if (labelsFeatureOn()) {
    const before = threadMoreMenu.childElementCount;
    appendSetLabelToMenu(
      threadMoreMenu,
      state.activeId,
      state.activeLabel ? state.activeLabel.id : null,
      "thread-dropdown-item",
      () => closeThreadMenus(),
    );
    // Tag the just-added nodes so they can be cleared on the next open.
    Array.from(threadMoreMenu.children)
      .slice(before)
      .forEach((n) => n.classList.add("label-menu-injected"));
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
    if (action === "compare") {
      // Add only — never remove. Removing a Compare item is done with the × on
      // its tab. A chat already in Compare is a no-op here.
      if (compareTabForConv(cid)) return;
      addToCompare(
        cid,
        threadTitle.textContent || "Conversation",
        state.activeProvider || state.providerSide,
      );
    } else if (action === "rename") {
      const cur = threadTitle.textContent || "";
      const name = await openNameModal({
        title: "Rename conversation",
        value: cur,
      });
      if (!name || name === cur) return;
      await apiUpdateConversationMeta(cid, { title: name });
      setThreadTitle(name);
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
      // Act on the active conversation's own state (set on open), which is
      // correct even for an opposite-provider Compare item, and keep it in
      // sync so reopening the menu shows the right label.
      if (state.activeFolderId) {
        const next = !state.activeFolderPinned;
        await apiFolderPin(cid, next);
        state.activeFolderPinned = next;
        await loadFolders();
      } else if (state.activePinned) {
        await apiUnpinConversation(cid);
        state.activePinned = false;
        await refreshPinnedList();
        await loadConversations(false);
      } else {
        await apiPinConversation(cid);
        state.activePinned = true;
        await refreshPinnedList();
        await loadConversations(false);
      }
    } else if (action === "archive") {
      await apiUpdateConversationMeta(cid, { archived: true });
      await refreshPinnedList();
      await afterFolderChange();
    } else if (action === "delete") {
      // Same behaviour as the sidebar row menu: straight to the Recycle Bin,
      // no archiving required, other state preserved.
      await apiUpdateConversationMeta(cid, { deleted: true });
      await refreshPinnedList();
      await afterFolderChange();
    }
  });
});

async function initApp() {
  applyThreadHeaderCollapsed();
  await loadDatasetFormat();
  await loadUiPreferences();
  await loadLabelDefs();
  syncLabelFilterOptions();
  renderSearchHistory();
  await refreshPinnedList();
  await loadFolders();
  await loadTabs();
  await loadConversations(false);
  // Restore the last conversation viewed, else open the most recent so the
  // reading pane is never empty on a populated database.
  if (state.activeSpecialView) {
    await activateActiveTab();
  } else if (state.lastConversationId) {
    await openConversation(
      state.lastConversationId,
      findConvItemEl(state.lastConversationId),
    );
  } else {
    await openMostRecentConversation();
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
    // Don't persist a transient label view as the remembered base view.
    conversationView: String(state.view).startsWith("label:")
      ? state.preferences.conversationView || "recent"
      : state.view,
    scrollByConversation: state.scrollByConversation,
    lastConversationId: state.lastConversationId,
  });
});
