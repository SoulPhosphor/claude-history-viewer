"use strict";

// ── Bookmarks ─────────────────────────────────────────────────────────────────
// Per-message bookmarks. An icon on each message toggles one on or off, a title
// rides beside the date/time, and a header control surveys them all. How that
// survey appears depends on how many bookmarks the open conversation has:
//   1        → jump straight to it
//   2–4      → a compact bar beneath the chat header
//   5+       → a temporary panel over the sidebar
// Each bookmark keeps a stable id (a UUID from the server) that never changes
// when it is renamed, so later features can reference it steadily. None of the
// open/closed survey state is remembered across sessions: opening another
// conversation always starts closed.
//
// This module leans on globals from app.js: `state`, `$`, `messagesEl`,
// `closeSummaryPanel`. It is loaded after app.js and summary.js.

// Which survey view is open right now: null | "bar" | "panel". Runtime only,
// never persisted.
let _bookmarkView = null;

// ── Data helpers ──────────────────────────────────────────────────────────────
function bookmarkById(id) {
  return state.bookmarks.find((b) => b.id === id) || null;
}
function bookmarkForSeq(seq) {
  return state.bookmarks.find((b) => Number(b.seq) === Number(seq)) || null;
}
function orderedBookmarks() {
  return [...state.bookmarks].sort((a, b) => Number(a.seq) - Number(b.seq));
}
function bookmarkLabel(bm) {
  const name = (bm.name || "").trim();
  return name || "Untitled bookmark";
}
function updateLocalBookmark(nb) {
  const i = state.bookmarks.findIndex((b) => b.id === nb.id);
  if (i >= 0) state.bookmarks[i] = nb;
  else state.bookmarks.push(nb);
}

// ── API ───────────────────────────────────────────────────────────────────────
async function apiCreateBookmark(convId, seq) {
  const r = await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: convId, seq }),
  });
  return r.json();
}
async function apiRenameBookmark(id, name) {
  const r = await fetch(`/api/bookmarks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return r.json();
}
async function apiDeleteBookmark(id) {
  const r = await fetch(`/api/bookmarks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return r.json();
}

// ── Icons ─────────────────────────────────────────────────────────────────────
// Google Material Symbols, inlined (never hot-linked). Kept behind one helper so
// a future bookmark source (e.g. AI-suggested bookmarks) can introduce its own
// glyphs here without touching the call sites.
const _BOOKMARK_PATH =
  "M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z";
const _BOOKMARK_STAR_PATH =
  "m389-400 91-55 91 55-24-104 80-69-105-9-42-98-42 98-105 9 80 69-24 104ZM200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z";

function bookmarkIconSvg(active) {
  const path = active ? _BOOKMARK_STAR_PATH : _BOOKMARK_PATH;
  return (
    '<svg class="bookmark-msg-icon" viewBox="0 -960 960 960" fill="currentColor" ' +
    'aria-hidden="true"><path d="' +
    path +
    '"/></svg>'
  );
}

function setBookmarkBtnState(btn, active) {
  btn.innerHTML = bookmarkIconSvg(active);
  btn.classList.toggle("active", active);
  btn.title = active ? "Remove bookmark" : "Add bookmark";
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(active));
}

// ── Per-message decoration ──────────────────────────────────────────────────
// Called for every rendered message that has a seq. Adds the toggle icon (left
// of the name for the user's own messages, right of it for the assistant's) and
// the title element at the right end of the meta row.
function decorateMessageBookmark({ div, roleEl, nameEl, metaRow, seq, role }) {
  const bm = bookmarkForSeq(seq);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bookmark-msg-btn";
  btn.dataset.seq = seq;
  setBookmarkBtnState(btn, !!bm);
  if (role === "user") roleEl.insertBefore(btn, nameEl);
  else roleEl.appendChild(btn);

  // The title element exists only while the message is bookmarked, so the meta
  // row can collapse (`:empty`) when there is nothing to show.
  if (bm) ensureBookmarkTitleEl(metaRow, seq);

  btn.addEventListener("click", () => toggleBookmark(seq, btn, metaRow));
}

// Find (or create) the title span at the right end of a message's meta row.
function ensureBookmarkTitleEl(metaRow, seq) {
  let titleEl = metaRow.querySelector(`.bookmark-title[data-seq="${seq}"]`);
  if (titleEl) return titleEl;
  titleEl = document.createElement("span");
  titleEl.className = "bookmark-title";
  titleEl.dataset.seq = seq;
  titleEl.addEventListener("click", (e) => {
    if (titleEl.querySelector("input")) return; // already editing
    const cur = bookmarkForSeq(seq);
    if (cur) {
      e.stopPropagation();
      beginInlineRename(titleEl, cur);
    }
  });
  metaRow.appendChild(titleEl);
  renderBookmarkTitle(titleEl, bookmarkForSeq(seq));
  return titleEl;
}

function renderBookmarkTitle(titleEl, bm) {
  if (!titleEl || !bm) return;
  const name = (bm.name || "").trim();
  titleEl.textContent = bookmarkLabel(bm);
  titleEl.classList.toggle("has-name", !!name);
  titleEl.title = name ? name : "Untitled bookmark — click to name";
}

// Re-sync one message's icon + title in the DOM to the current data. Used after
// changes that come from elsewhere (e.g. a rename via the naming dialog).
function syncMessageBookmarkDom(seq) {
  const bm = bookmarkForSeq(seq);
  const btn = messagesEl?.querySelector(`.bookmark-msg-btn[data-seq="${seq}"]`);
  if (btn) setBookmarkBtnState(btn, !!bm);
  const metaRow = btn?.closest(".message")?.querySelector(".message-meta-row");
  if (!metaRow) return;
  const titleEl = metaRow.querySelector(`.bookmark-title[data-seq="${seq}"]`);
  if (bm) {
    const el = titleEl || ensureBookmarkTitleEl(metaRow, seq);
    if (!el.querySelector("input")) renderBookmarkTitle(el, bm);
  } else if (titleEl) {
    titleEl.remove();
  }
}

// ── Toggle on / off ───────────────────────────────────────────────────────────
async function toggleBookmark(seq, btn, metaRow) {
  if (!state.activeId) return;
  const existing = bookmarkForSeq(seq);
  if (existing) {
    // Optimistically clear, then persist.
    state.bookmarks = state.bookmarks.filter((b) => b.id !== existing.id);
    if (btn) setBookmarkBtnState(btn, false);
    const titleEl = metaRow?.querySelector(`.bookmark-title[data-seq="${seq}"]`);
    if (titleEl) titleEl.remove();
    refreshBookmarkSurfaces();
    try {
      await apiDeleteBookmark(existing.id);
    } catch (_) {
      /* best effort; the list is already reflecting the removal */
    }
  } else {
    let res;
    try {
      res = await apiCreateBookmark(state.activeId, seq);
    } catch (_) {
      return;
    }
    if (!res || !res.bookmark) return;
    updateLocalBookmark(res.bookmark);
    if (btn) setBookmarkBtnState(btn, true);
    const titleEl = metaRow ? ensureBookmarkTitleEl(metaRow, seq) : null;
    if (titleEl) renderBookmarkTitle(titleEl, res.bookmark);
    refreshBookmarkSurfaces();
    // Offer the little naming dialog right away.
    openBookmarkNameDialog(res.bookmark, btn, titleEl);
  }
}

// ── "Name this bookmark" dialog ───────────────────────────────────────────────
function closeBookmarkNameDialog() {
  const dlg = $("bookmark-name-dialog");
  if (dlg) dlg.remove();
}

function openBookmarkNameDialog(bm, anchorEl, titleEl) {
  closeBookmarkNameDialog();
  const dlg = document.createElement("div");
  dlg.className = "bookmark-name-dialog";
  dlg.id = "bookmark-name-dialog";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "bookmark-name-input";
  input.placeholder = "Name this bookmark…";
  input.value = bm.name || "";
  dlg.appendChild(input);
  document.body.appendChild(dlg);
  positionBookmarkPopover(dlg, anchorEl);
  input.focus();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    closeBookmarkNameDialog();
    if (save) {
      let nb = { ...bookmarkById(bm.id) || bm, name: val };
      try {
        const res = await apiRenameBookmark(bm.id, val);
        if (res && res.bookmark) nb = res.bookmark;
      } catch (_) {
        /* keep the local value */
      }
      updateLocalBookmark(nb);
      if (titleEl) renderBookmarkTitle(titleEl, nb);
      syncMessageBookmarkDom(nb.seq);
      refreshBookmarkSurfaces();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  // Enter, blur and clicking away all save; only Escape leaves it unnamed.
  input.addEventListener("blur", () => finish(true));
}

function positionBookmarkPopover(dlg, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const margin = 6;
  const w = dlg.offsetWidth || 220;
  let left = r.left;
  if (left + w + margin > window.innerWidth) {
    left = window.innerWidth - w - margin;
  }
  left = Math.max(margin, left);
  let top = r.bottom + margin;
  const h = dlg.offsetHeight || 44;
  if (top + h + margin > window.innerHeight) {
    top = Math.max(margin, r.top - h - margin);
  }
  dlg.style.left = `${left}px`;
  dlg.style.top = `${top}px`;
}

// ── Inline rename of the title beside the date/time ───────────────────────────
function beginInlineRename(titleEl, bm) {
  if (titleEl.querySelector("input")) return;
  const seq = bm.seq;
  const prev = bm.name || "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "bookmark-title-input";
  input.value = prev;
  titleEl.textContent = "";
  titleEl.classList.add("editing");
  titleEl.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener("click", (e) => e.stopPropagation());

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    titleEl.classList.remove("editing");
    if (save) {
      const val = input.value.trim();
      let nb = { ...bookmarkById(bm.id) || bm, name: val };
      try {
        const res = await apiRenameBookmark(bm.id, val);
        if (res && res.bookmark) nb = res.bookmark;
      } catch (_) {
        /* keep the local value */
      }
      updateLocalBookmark(nb);
      renderBookmarkTitle(titleEl, nb);
      refreshBookmarkSurfaces();
    } else {
      // Escape: leave the name exactly as it was.
      renderBookmarkTitle(titleEl, bookmarkForSeq(seq) || bm);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  // Blur (including clicking elsewhere) saves; Escape above cancels first.
  input.addEventListener("blur", () => finish(true));
}

// ── Navigation ────────────────────────────────────────────────────────────────
function scrollToBookmark(bm) {
  if (!bm) return;
  // Bookmarks point at chat messages, so leave the summary view first.
  if (messagesEl && messagesEl.hidden && typeof closeSummaryPanel === "function") {
    closeSummaryPanel();
  }
  const targetEl = messagesEl?.querySelector(`[data-seq="${bm.seq}"]`);
  if (!targetEl) return;
  const cRect = messagesEl.getBoundingClientRect();
  const eRect = targetEl.getBoundingClientRect();
  const absTop = eRect.top - cRect.top + messagesEl.scrollTop;
  const target = absTop - (messagesEl.clientHeight - targetEl.offsetHeight) / 2;
  messagesEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  targetEl.classList.add("search-highlight");
  setTimeout(() => targetEl.classList.remove("search-highlight"), 2500);
}

// ── Survey surfaces (header button, bar, panel) ───────────────────────────────
function hideBookmarkBarEl() {
  const b = $("bookmark-bar");
  if (b) b.hidden = true;
}
function hideBookmarkPanelEl() {
  const p = $("bookmark-panel");
  if (p) p.hidden = true;
}
function closeBookmarkViews() {
  _bookmarkView = null;
  hideBookmarkBarEl();
  hideBookmarkPanelEl();
}

function openBookmarkBar() {
  hideBookmarkPanelEl();
  _bookmarkView = "bar";
  renderBookmarkBar();
  const b = $("bookmark-bar");
  if (b) b.hidden = false;
}
function renderBookmarkBar() {
  const links = $("bookmark-bar-links");
  if (!links) return;
  links.innerHTML = "";
  for (const bm of orderedBookmarks()) {
    const a = document.createElement("button");
    a.type = "button";
    a.className = "bookmark-bar-link";
    a.textContent = bookmarkLabel(bm);
    a.title = bookmarkLabel(bm);
    a.addEventListener("click", () => scrollToBookmark(bm));
    links.appendChild(a);
  }
}

function openBookmarkPanel() {
  hideBookmarkBarEl();
  _bookmarkView = "panel";
  renderBookmarkPanel();
  const p = $("bookmark-panel");
  if (p) p.hidden = false;
}
function renderBookmarkPanel() {
  const list = $("bookmark-panel-list");
  if (!list) return;
  list.innerHTML = "";
  for (const bm of orderedBookmarks()) {
    const a = document.createElement("button");
    a.type = "button";
    a.className = "bookmark-panel-item";
    a.textContent = bookmarkLabel(bm);
    a.title = bookmarkLabel(bm);
    a.addEventListener("click", () => scrollToBookmark(bm));
    list.appendChild(a);
  }
}

// Keep the header control and any open survey in step with the current list.
function refreshBookmarkSurfaces() {
  const btn = $("bookmarks-toggle-btn");
  const count = state.bookmarks.length;
  if (btn) btn.hidden = count === 0 || !state.activeId;

  if (_bookmarkView === "bar") {
    if (count < 2 || count > 4) closeBookmarkViews();
    else renderBookmarkBar();
  } else if (_bookmarkView === "panel") {
    if (count < 5) closeBookmarkViews();
    else renderBookmarkPanel();
  }
}

// The header control's behaviour depends on the count band.
function onBookmarkToggleClick() {
  const count = state.bookmarks.length;
  if (count === 0) return;
  if (count === 1) {
    // Straight to the only bookmark, no persistent surface.
    closeBookmarkViews();
    scrollToBookmark(orderedBookmarks()[0]);
    return;
  }
  if (count <= 4) {
    if (_bookmarkView === "bar") closeBookmarkViews();
    else openBookmarkBar();
    return;
  }
  if (_bookmarkView === "panel") closeBookmarkViews();
  else openBookmarkPanel();
}

// ── Conversation lifecycle ────────────────────────────────────────────────────
// Called when a conversation opens: drop any open survey (never carried across a
// switch) and adopt the new conversation's bookmark list. Message decoration
// happens as messages render, reading state.bookmarks.
function resetBookmarksForConversation(bookmarks) {
  closeBookmarkNameDialog();
  closeBookmarkViews();
  state.bookmarks = Array.isArray(bookmarks) ? bookmarks.slice() : [];
  refreshBookmarkSurfaces();
}

// ── Wiring ────────────────────────────────────────────────────────────────────
$("bookmarks-toggle-btn")?.addEventListener("click", onBookmarkToggleClick);
$("bookmark-bar-close")?.addEventListener("click", closeBookmarkViews);
$("bookmark-panel-close")?.addEventListener("click", closeBookmarkViews);
