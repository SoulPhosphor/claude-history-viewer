"use strict";

// ── Global Bookmarks ─────────────────────────────────────────────────────────
// A provider-scoped view of every conversation that carries bookmarks. Each
// conversation shows its full title with a chevron; expanding it reveals an
// indented, undecorated list of that conversation's bookmarks. Clicking a title
// opens the conversation; clicking a bookmark opens it scrolled to that message.
//
// The list loads 25 conversations at a time and auto-loads more as the user
// scrolls (bookmarks are not counted toward the page size). A sort control
// orders conversations by the last message the user sent (newest first by
// default), a "Collapse Bookmarks" toggle hides every bookmark list at once,
// and a search box narrows by title, bookmark name, or both.
//
// Opening a conversation from here pushes a browser-history entry, so the Back
// button returns to this table at the same scroll position.
//
// Leans on globals from app.js: `state`, `$`, `openConversation`,
// `resolveConversationSidebarEl`, `hideAllPanels`, `rememberReturnTab`,
// `ensureSpecialTab`, `returnFromSpecialView`, `renderTabs`. Loaded after app.js.

const GB_PAGE = 25;

const GB_CHEVRON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const gbState = {
  sort: "newest",
  scope: "both",
  q: "",
  collapse: false, // "Collapse Bookmarks" toggle — default off (expanded)
  offset: 0,
  total: 0,
  loading: false,
  done: false,
  epoch: 0, // bumped on every reset so stale fetches are ignored
  items: [],
  expandedIds: new Set(),
};

const gbPanel = $("global-bookmarks-panel");
const gbScroll = $("global-bookmarks-scroll");
const gbList = $("global-bookmarks-list");
const gbSentinel = $("gb-sentinel");
const gbMeta = $("global-bookmarks-meta");
const gbSearchEl = $("gb-search");
const gbScopeEl = $("gb-search-scope");
const gbSortEl = $("gb-sort");
const gbCollapseEl = $("gb-collapse-toggle");

// ── View lifecycle ────────────────────────────────────────────────────────────
function showGlobalBookmarksPanel() {
  rememberReturnTab();
  state.activeSpecialView = "global_bookmarks";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  if (typeof ensureSpecialTab === "function") {
    ensureSpecialTab("global_bookmarks", "Global Bookmarks");
  }
  hideAllPanels();
  if (gbPanel) gbPanel.hidden = false;
}

async function openGlobalBookmarks(fromButton = false) {
  if (
    typeof summaryHasUnsavedChanges === "function" &&
    summaryHasUnsavedChanges()
  ) {
    const r = await openSummaryUnsavedModal();
    if (r === "cancel") return;
    if (r === "save") await saveAllUnsaved();
  }
  if (typeof closeSummaryPanel === "function") closeSummaryPanel();
  if (typeof leaveNotesForSpecialView === "function" && !(await leaveNotesForSpecialView())) return;
  if (fromButton && state.activeSpecialView === "global_bookmarks") {
    await returnFromSpecialView();
    return;
  }
  showGlobalBookmarksPanel();
  gbReload();
}

// Reload for the current provider without leaving the view (provider toggle).
function gbReloadForProvider() {
  if (state.activeSpecialView !== "global_bookmarks") return;
  gbReload();
}

// ── Loading ───────────────────────────────────────────────────────────────────
function gbReset() {
  gbState.epoch++;
  gbState.items = [];
  gbState.offset = 0;
  gbState.total = 0;
  gbState.done = false;
  gbState.loading = false;
  gbState.expandedIds.clear();
  if (gbList) gbList.innerHTML = "";
  if (gbScroll) gbScroll.scrollTop = 0;
}

function gbReload() {
  gbReset();
  gbLoadMore();
}

function gbShowLoading(on) {
  if (!gbSentinel) return;
  gbSentinel.innerHTML = on ? '<div class="gb-loading">Loading…</div>' : "";
}

function gbShowError() {
  if (!gbSentinel) return;
  gbSentinel.innerHTML = "";
  const error = document.createElement("div");
  error.className = "gb-load-error";
  const message = document.createElement("span");
  message.textContent = "Bookmarks could not be loaded.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "gb-retry";
  retry.textContent = "Try Again";
  retry.addEventListener("click", () => gbLoadMore());
  error.append(message, retry);
  gbSentinel.appendChild(error);
}

async function gbLoadMore(allowAutoFill = true) {
  if (gbState.loading || gbState.done) return false;
  gbState.loading = true;
  const epoch = gbState.epoch;
  gbShowLoading(true);

  const params = new URLSearchParams({
    provider: state.providerSide,
    sort: gbState.sort,
    scope: gbState.scope,
    q: gbState.q,
    limit: String(GB_PAGE),
    offset: String(gbState.offset),
  });

  let data;
  try {
    const response = await fetch(`/api/global-bookmarks?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    if (!data || !Array.isArray(data.conversations)) {
      throw new Error("Invalid bookmark response");
    }
  } catch (_) {
    if (epoch === gbState.epoch) {
      gbState.loading = false;
      gbShowError();
    }
    return false;
  }
  // A newer reset happened while this was in flight — drop the stale page.
  if (epoch !== gbState.epoch) return;

  gbState.total = data.total || 0;
  const convs = data.conversations || [];
  gbState.offset += convs.length;
  if (convs.length < GB_PAGE || gbState.offset >= gbState.total) {
    gbState.done = true;
  }

  for (const c of convs) {
    gbState.items.push(c);
    if (!gbState.collapse) gbState.expandedIds.add(c.id);
    gbList.appendChild(gbRenderConv(c));
  }

  if (!gbState.items.length) {
    gbList.innerHTML = `<div class="gb-empty">${
      gbState.q
        ? "No conversations or bookmarks match your search."
        : "No bookmarked conversations on this side yet."
    }</div>`;
  }

  gbUpdateMeta();
  gbState.loading = false;
  gbShowLoading(false);
  if (allowAutoFill) gbMaybeAutoFill();
  return true;
}

// Keep loading until the list overflows its container, so the scroll-triggered
// observer has something to react to. Never runs while the panel is hidden
// (its container has no height then, which would load every page at once).
function gbMaybeAutoFill() {
  if (gbState.done || gbState.loading) return;
  if (!gbPanel || gbPanel.hidden) return;
  if (!gbScroll) return;
  if (gbScroll.scrollHeight <= gbScroll.clientHeight + 4) {
    gbLoadMore();
  }
}

function gbUpdateMeta() {
  if (!gbMeta) return;
  const n = gbState.total;
  gbMeta.textContent =
    n === 0
      ? ""
      : `${n.toLocaleString()} conversation${n !== 1 ? "s" : ""} with bookmarks`;
}

// ── Rendering one conversation group ──────────────────────────────────────────
function gbRenderConv(c) {
  const expanded = gbState.expandedIds.has(c.id);

  const wrap = document.createElement("div");
  wrap.className = "gb-conv" + (expanded ? " expanded" : "");
  wrap.dataset.id = c.id;

  const head = document.createElement("div");
  head.className = "gb-conv-head";

  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "gb-title";
  const title = c.title || "Untitled";
  titleBtn.textContent = title;
  titleBtn.title = title;
  titleBtn.addEventListener("click", () => gbOpenConversation(c.id, null));

  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "gb-chevron";
  chevron.innerHTML = GB_CHEVRON_SVG;
  gbSetChevronState(chevron, expanded);
  chevron.addEventListener("click", () => gbToggleConv(c.id, wrap, chevron));

  head.append(titleBtn, chevron);
  wrap.appendChild(head);

  const bmWrap = document.createElement("div");
  bmWrap.className = "gb-bookmarks";
  for (const bm of c.bookmarks || []) {
    const name = (bm.name || "").trim();
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gb-bookmark" + (name ? "" : " gb-unnamed");
    b.textContent = name || "Untitled bookmark";
    b.title = b.textContent;
    b.addEventListener("click", () => gbOpenConversation(c.id, bm.seq));
    bmWrap.appendChild(b);
  }
  wrap.appendChild(bmWrap);
  return wrap;
}

function gbSetChevronState(chevron, expanded) {
  chevron.setAttribute("aria-expanded", String(expanded));
  chevron.setAttribute(
    "aria-label",
    expanded ? "Collapse bookmarks" : "Expand bookmarks",
  );
}

function gbToggleConv(id, wrap, chevron) {
  const expanded = !gbState.expandedIds.has(id);
  if (expanded) gbState.expandedIds.add(id);
  else gbState.expandedIds.delete(id);
  wrap.classList.toggle("expanded", expanded);
  gbSetChevronState(chevron, expanded);
}

// ── Navigation (Back returns to this table, same scroll position) ─────────────
function gbOpenConversation(convId, seq) {
  history.replaceState(
    {
      gbNav: true,
      view: "gb-list",
      scrollTop: gbScroll ? gbScroll.scrollTop : 0,
      loadedCount: gbState.offset,
    },
    "",
  );
  history.pushState({ gbNav: true, view: "conversation", convId, seq }, "");
  const el =
    typeof resolveConversationSidebarEl === "function"
      ? resolveConversationSidebarEl(convId)
      : null;
  openConversation(convId, el, seq != null ? seq : null);
}

async function gbRestoreHistoryList(scrollTop, loadedCount) {
  // Bookmark names and membership may have changed while the conversation was
  // open. Reload from the database instead of revealing the stale cached DOM,
  // then rebuild enough pages to restore the previous scroll position.
  gbReset();
  const target = Math.max(GB_PAGE, Number(loadedCount) || 0);
  while (!gbState.done && gbState.offset < target) {
    const loaded = await gbLoadMore(false);
    if (!loaded) return;
  }
  if (typeof scrollTop === "number") {
    requestAnimationFrame(() => {
      if (gbScroll) gbScroll.scrollTop = scrollTop;
    });
  }
}

window.addEventListener("popstate", async (e) => {
  const st = e.state;
  if (!st || !st.gbNav) return;
  if (st.view === "gb-list") {
    if (typeof leaveNotesForSpecialView === "function" && !(await leaveNotesForSpecialView())) return;
    showGlobalBookmarksPanel();
    if (typeof renderTabs === "function") renderTabs();
    gbRestoreHistoryList(st.scrollTop, st.loadedCount);
  } else if (st.view === "conversation") {
    const el =
      typeof resolveConversationSidebarEl === "function"
        ? resolveConversationSidebarEl(st.convId)
        : null;
    openConversation(st.convId, el, st.seq != null ? st.seq : null);
  }
});

// ── Controls ──────────────────────────────────────────────────────────────────
let _gbSearchTimer = null;
gbSearchEl?.addEventListener("input", () => {
  clearTimeout(_gbSearchTimer);
  _gbSearchTimer = setTimeout(() => {
    const v = gbSearchEl.value.trim();
    if (v === gbState.q) return;
    gbState.q = v;
    gbReload();
  }, 220);
});

gbScopeEl?.addEventListener("change", () => {
  gbState.scope = gbScopeEl.value;
  if (gbState.q) gbReload();
});

gbSortEl?.addEventListener("change", () => {
  gbState.sort = gbSortEl.value;
  gbReload();
});

gbCollapseEl?.addEventListener("change", () => {
  gbState.collapse = gbCollapseEl.checked;
  if (gbState.collapse) gbState.expandedIds.clear();
  else gbState.items.forEach((c) => gbState.expandedIds.add(c.id));
  gbList?.querySelectorAll(".gb-conv").forEach((el) => {
    const exp = gbState.expandedIds.has(el.dataset.id);
    el.classList.toggle("expanded", exp);
    const ch = el.querySelector(".gb-chevron");
    if (ch) gbSetChevronState(ch, exp);
  });
});

// ── Auto-load on scroll ───────────────────────────────────────────────────────
if (gbSentinel && "IntersectionObserver" in window) {
  const gbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) gbLoadMore();
      }
    },
    { root: gbScroll || null, rootMargin: "300px 0px" },
  );
  gbObserver.observe(gbSentinel);
}

// ── Briefcase footer menu (Global Bookmarks / Projects / Memories / Media Hub) ─
const bookmarksHubBtn = $("bookmarks-hub-btn");
const bookmarksHubMenu = $("bookmarks-hub-menu");

function positionBookmarksHubMenu() {
  const r = bookmarksHubBtn.getBoundingClientRect();
  bookmarksHubMenu.hidden = false;
  const mw = bookmarksHubMenu.offsetWidth;
  const mh = bookmarksHubMenu.offsetHeight;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  let top = r.top - mh - 6;
  if (top < 8) top = r.bottom + 6;
  bookmarksHubMenu.style.left = `${left}px`;
  bookmarksHubMenu.style.top = `${top}px`;
}

function openBookmarksHubMenu() {
  positionBookmarksHubMenu();
  bookmarksHubBtn.setAttribute("aria-expanded", "true");
  document.addEventListener("mousedown", onBookmarksHubOutside, true);
  document.addEventListener("keydown", onBookmarksHubKey, true);
}

function closeBookmarksHubMenu() {
  if (!bookmarksHubMenu) return;
  bookmarksHubMenu.hidden = true;
  bookmarksHubBtn?.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", onBookmarksHubOutside, true);
  document.removeEventListener("keydown", onBookmarksHubKey, true);
}

function onBookmarksHubOutside(e) {
  if (!bookmarksHubMenu.contains(e.target) && e.target !== bookmarksHubBtn) {
    closeBookmarksHubMenu();
  }
}

function onBookmarksHubKey(e) {
  if (e.key === "Escape") closeBookmarksHubMenu();
}

bookmarksHubBtn?.addEventListener("click", () => {
  if (bookmarksHubMenu.hidden) openBookmarksHubMenu();
  else closeBookmarksHubMenu();
});

bookmarksHubMenu?.querySelectorAll(".sidebar-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    const action = item.dataset.action;
    closeBookmarksHubMenu();
    if (action === "global-bookmarks") openGlobalBookmarks(true);
    else if (action === "projects") openProjects(true);
    else if (action === "memories") openMemories(true);
    else if (action === "media-hub") openGallery(true);
  });
});
