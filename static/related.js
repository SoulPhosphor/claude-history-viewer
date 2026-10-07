"use strict";

// ── Related Conversations ─────────────────────────────────────────────────────
// Reciprocal links between two conversations (related.py). The Hub button in
// the chat title bar opens a temporary panel over the sidebar, like Notes. It
// lists the open chat's links as sidebar rows, plus Location\Title for chats in
// a folder, Archived or Deleted.
//
// "Find Related Conversations" opens Advanced Search in its Related mode
// (advanced_search.js: ui.related). This panel stays over the sidebar for the
// whole search and is fixed to the chat the search is for, so the links stay in
// view while results are previewed in the chat area. Clicking the Hub button
// while previewing another chat switches the job to that chat. Clicking the
// chat's title at the top of the panel (or closing the search) returns to it
// and closes the panel; the search itself is kept for next time, as Advanced
// Search always is.
//
// Shared with other screens — change them together:
//   • Rows reuse the sidebar row (app.js appendListItems): .conv-item,
//     .conv-top-row, .conv-title, .conv-snippet, .conv-footer, label squares,
//     summary hint and the ⋮ button.
//   • The ⋮ items mirror the sidebar's openConvItemMenu(), with "Remove Link"
//     on top, and pick Archive/Restore/Delete from where each chat lives.
//   • Location\Title matches Advanced Search's result titles (resultLocation).
//
// Loaded after app.js and advanced_search.js; leans on app.js globals.

const relatedPanel = $("related-panel");
const relatedListEl = $("related-list");
const relatedTitleEl = $("related-panel-title");
const relatedForBtn = $("related-panel-for");
const relatedSortRow = $("related-sort-row");
const relatedSortEl = $("related-sort");
const relatedFindWrap = $("related-find-wrap");
const relatedToggleBtn = $("related-toggle-btn");
const unlinkModal = $("unlink-modal");
const unlinkSkip = $("unlink-modal-skip");

// The Sort By row appears once the list has this many conversations.
const RELATED_SORT_MIN = 5;
// "Do not show this warning anymore for this session": kept in sessionStorage,
// so it lasts across conversations and reloads but not a browser restart.
const UNLINK_SKIP_KEY = "relatedUnlinkNoWarning";

// Google Material Symbols, inlined (never hot-linked).
const RELATED_HUB_PATH =
  "M240-40q-50 0-85-35t-35-85q0-50 35-85t85-35q14 0 26 3t23 8l57-71q-28-31-39-70t-5-78l-81-27q-17 25-43 40t-58 15q-50 0-85-35T0-580q0-50 35-85t85-35q50 0 85 35t35 85v8l81 28q20-36 53.5-61t75.5-32v-87q-39-11-64.5-42.5T360-840q0-50 35-85t85-35q50 0 85 35t35 85q0 42-26 73.5T510-724v87q42 7 75.5 32t53.5 61l81-28v-8q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-32 0-58.5-15T739-515l-81 27q6 39-5 77.5T614-340l57 70q11-5 23-7.5t26-2.5q50 0 85 35t35 85q0 50-35 85t-85 35q-50 0-85-35t-35-85q0-20 6.5-38.5T624-232l-57-71q-41 23-87.5 23T392-303l-56 71q11 15 17.5 33.5T360-160q0 50-35 85t-85 35ZM120-540q17 0 28.5-11.5T160-580q0-17-11.5-28.5T120-620q-17 0-28.5 11.5T80-580q0 17 11.5 28.5T120-540Zm120 420q17 0 28.5-11.5T280-160q0-17-11.5-28.5T240-200q-17 0-28.5 11.5T200-160q0 17 11.5 28.5T240-120Zm240-680q17 0 28.5-11.5T520-840q0-17-11.5-28.5T480-880q-17 0-28.5 11.5T440-840q0 17 11.5 28.5T480-800Zm0 440q42 0 71-29t29-71q0-42-29-71t-71-29q-42 0-71 29t-29 71q0 42 29 71t71 29Zm240 240q17 0 28.5-11.5T760-160q0-17-11.5-28.5T720-200q-17 0-28.5 11.5T680-160q0 17 11.5 28.5T720-120Zm120-420q17 0 28.5-11.5T880-580q0-17-11.5-28.5T840-620q-17 0-28.5 11.5T800-580q0 17 11.5 28.5T840-540ZM480-840ZM120-580Zm360 120Zm360-120ZM240-160Zm480 0Z";
const RELATED_ADD_CIRCLE_PATH =
  "M440-280h80v-160h160v-80H520v-160h-80v160H280v80h160v160Zm40 200q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z";

function relatedIconSvg(name) {
  const path = name === "add" ? RELATED_ADD_CIRCLE_PATH : RELATED_HUB_PATH;
  return (
    '<svg class="related-icon" viewBox="0 -960 960 960" fill="currentColor" ' +
    `aria-hidden="true"><path d="${path}"/></svg>`
  );
}

const _related = {
  // The chat whose links the panel lists, and its title.
  convId: null,
  title: "",
  rows: [],
  ids: new Set(),
  // {id, title} while Find Related Conversations is open; null otherwise.
  searching: null,
  sort: "newest",
  loadToken: 0,
  // True while a different chat's list is loading (rows are cleared).
  loading: false,
  // True when that load failed; the panel says so until a load succeeds.
  loadFailed: false,
};
let _relatedMenuEl = null;
let _unlinkResolve = null;
let _unlinkSkipFallback = false;

// ── API ───────────────────────────────────────────────────────────────────────
async function apiRelatedList(convId) {
  const r = await fetch(`/api/related/${encodeURIComponent(convId)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data.related || [];
}
async function apiLinkConversations(a, b) {
  const r = await fetch("/api/related", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a, b }),
  });
  return r.ok;
}
async function apiUnlinkConversations(a, b) {
  const r = await fetch(`/api/related?${new URLSearchParams({ a, b })}`, {
    method: "DELETE",
  });
  return r.ok;
}

// ── Linking ───────────────────────────────────────────────────────────────────
function relatedIsLinked(convId) {
  return _related.ids.has(convId);
}

function unlinkWarningSkipped() {
  try {
    return sessionStorage.getItem(UNLINK_SKIP_KEY) === "1";
  } catch (_) {
    return _unlinkSkipFallback;
  }
}
function skipUnlinkWarning() {
  _unlinkSkipFallback = true;
  try {
    sessionStorage.setItem(UNLINK_SKIP_KEY, "1");
  } catch (_) {
    /* private mode: the in-memory fallback covers this page */
  }
}

// "Permanently Remove this link?" — resolves true for Okay.
function confirmUnlink() {
  if (unlinkWarningSkipped()) return Promise.resolve(true);
  unlinkSkip.checked = false;
  unlinkModal.hidden = false;
  return new Promise((resolve) => {
    _unlinkResolve = resolve;
  });
}
function closeUnlinkModal(ok) {
  if (ok && unlinkSkip.checked) skipUnlinkWarning();
  unlinkModal.hidden = true;
  const resolve = _unlinkResolve;
  _unlinkResolve = null;
  if (resolve) resolve(ok);
}
$("unlink-modal-cancel")?.addEventListener("click", () => closeUnlinkModal(false));
$("unlink-modal-ok")?.addEventListener("click", () => closeUnlinkModal(true));
unlinkModal?.addEventListener("mousedown", (e) => {
  if (e.target === unlinkModal) closeUnlinkModal(false);
});

// Link the panel's chat to another one. No warning: adding is undone by Remove Link.
async function relatedAdd(otherId) {
  const subject = _related.convId;
  if (!subject || !otherId || subject === otherId) return false;
  if (!(await apiLinkConversations(subject, otherId))) return false;
  _related.ids.add(otherId);
  await reloadRelated();
  return true;
}

// Remove a link after the warning (unless skipped for this session).
async function relatedRemove(otherId, subject = _related.convId) {
  if (!subject || !otherId) return false;
  if (!(await confirmUnlink())) return false;
  if (!(await apiUnlinkConversations(subject, otherId))) return false;
  _related.ids.delete(otherId);
  await reloadRelated();
  return true;
}

// ── Loading / rendering ───────────────────────────────────────────────────────
async function loadRelatedFor(convId, title) {
  _related.convId = convId;
  _related.title = title || "";
  _related.rows = [];
  _related.ids = new Set();
  // Clear the old chat's rows at once, so none of their menus act on the new
  // chat while its list loads.
  _related.loading = true;
  _related.loadFailed = false;
  closeRelatedRowMenu();
  renderRelatedPanel();
  await reloadRelated();
}

async function reloadRelated() {
  const convId = _related.convId;
  if (!convId) return;
  const token = ++_related.loadToken;
  let rows;
  try {
    rows = await apiRelatedList(convId);
  } catch (_) {
    // A new chat's list that fails to load says so instead of staying blank.
    // A failed refresh of the same chat keeps the rows it already shows.
    if (token === _related.loadToken && convId === _related.convId && _related.loading) {
      _related.loading = false;
      _related.loadFailed = true;
      renderRelatedPanel();
    }
    return;
  }
  if (token !== _related.loadToken || convId !== _related.convId) return;
  _related.rows = rows;
  _related.ids = new Set(rows.map((r) => r.id));
  _related.loading = false;
  _related.loadFailed = false;
  renderRelatedPanel();
  window.advancedSearchController?.refreshRelated?.();
}

function relatedSortedRows() {
  const rows = [..._related.rows];
  const when = (c) => Number(c.update_time || c.create_time || 0);
  const name = (c) => c.title || "Untitled";
  switch (_related.sort) {
    case "oldest":
      return rows.sort((a, b) => when(a) - when(b));
    case "az":
      return rows.sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }));
    case "za":
      return rows.sort((a, b) => name(b).localeCompare(name(a), undefined, { sensitivity: "base" }));
    default:
      return rows.sort((a, b) => when(b) - when(a));
  }
}

// Deleted, Archived or the folder's name; null when it is in the main list.
function relatedLocationName(c) {
  if (c.deleted) return "Deleted";
  if (c.archived) return "Archived";
  if (c.folder) return c.folder.name || "";
  return null;
}

function renderRelatedPanel() {
  if (!relatedPanel) return;
  const searching = !!_related.searching;
  relatedTitleEl.textContent = searching
    ? "Related Conversations for"
    : "Related Conversations";
  relatedForBtn.hidden = !searching;
  if (searching) {
    const title = _related.searching.title || "Untitled";
    relatedForBtn.textContent = title;
    relatedForBtn.title = `Back to ${title}`;
  }
  relatedFindWrap.hidden = searching;
  relatedSortRow.hidden = _related.rows.length < RELATED_SORT_MIN;
  relatedSortEl.value = _related.sort;

  relatedListEl.innerHTML = "";
  if (_related.loading) return;
  if (_related.loadFailed) {
    const failed = document.createElement("div");
    failed.className = "related-empty";
    failed.setAttribute("role", "alert");
    failed.textContent = "Could not load related conversations.";
    relatedListEl.appendChild(failed);
    return;
  }
  if (!_related.rows.length) {
    const empty = document.createElement("div");
    empty.className = "related-empty";
    empty.textContent = "No related conversations.";
    relatedListEl.appendChild(empty);
    return;
  }
  for (const c of relatedSortedRows()) {
    relatedListEl.appendChild(buildRelatedRow(c));
  }
}

// One related chat, drawn as a sidebar row (see app.js appendListItems).
function buildRelatedRow(c) {
  const el = document.createElement("div");
  el.className = "conv-item" + (c.id === state.activeId ? " active" : "");
  el.dataset.id = c.id;

  const top = document.createElement("div");
  top.className = "conv-top-row";
  const titleEl = document.createElement("div");
  titleEl.className = "conv-title";
  titleEl.innerHTML = warningIconsHtml(c);
  const location = relatedLocationName(c);
  if (location !== null) {
    const loc = document.createElement("span");
    loc.className = "related-location";
    loc.textContent = location;
    const sep = document.createElement("span");
    sep.className = "related-location-sep";
    sep.textContent = "\\";
    titleEl.append(loc, sep);
  }
  titleEl.append(c.title || "Untitled");
  makeKeyboardAction(titleEl, `Open ${c.title || "Untitled"}`);
  top.appendChild(titleEl);

  const actions = document.createElement("div");
  actions.className = "conv-actions";
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "conv-menu-btn";
  menuBtn.title = "More";
  menuBtn.setAttribute("aria-label", "More");
  menuBtn.setAttribute("aria-haspopup", "true");
  menuBtn.innerHTML =
    '<svg viewBox="0 0 4 16" width="4" height="16" aria-hidden="true">' +
    '<circle cx="2" cy="2" r="1.7"/><circle cx="2" cy="8" r="1.7"/>' +
    '<circle cx="2" cy="14" r="1.7"/></svg>';
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openRelatedRowMenu(c, menuBtn);
  });
  actions.appendChild(menuBtn);
  top.appendChild(actions);
  el.appendChild(top);

  const snippet = (c.preview || "").trim();
  if (snippet && state.preferences.showChatSnippet) {
    const sn = document.createElement("div");
    sn.className = "conv-snippet";
    sn.textContent = snippet;
    el.appendChild(sn);
  }
  const footer = document.createElement("div");
  footer.className = "conv-footer";
  const date = document.createElement("span");
  date.textContent = formatDate(c.update_time || c.create_time);
  const count = document.createElement("span");
  count.textContent = `${c.message_count} msg${c.message_count !== 1 ? "s" : ""}`;
  footer.append(date, count);
  el.appendChild(footer);
  paintRowLabels(el, c.id, c.labels || [], ".conv-title", footer);

  if (state.preferences.showSummaryHints && c.has_condensed_summary) {
    const hintEl = document.createElement("span");
    hintEl.className = "conv-summary-hint";
    hintEl.textContent = "Summary";
    hintEl.dataset.convId = c.id;
    prepareSummaryHint(hintEl);
    top.after(hintEl);
  }

  el.addEventListener("click", () => {
    // While finding links, a row previews in the chat area and the search stays.
    openConversation(c.id, null, null, { keepAdvancedSearch: !!_related.searching });
  });
  return el;
}

// ── Row ⋮ menu ────────────────────────────────────────────────────────────────
function closeRelatedRowMenu() {
  if (!_relatedMenuEl) return;
  restoreActionMenuFocus(_relatedMenuEl);
  _relatedMenuEl.remove();
  _relatedMenuEl = null;
  document.removeEventListener("mousedown", onRelatedMenuOutside, true);
  window.removeEventListener("scroll", closeRelatedRowMenu, true);
}
function onRelatedMenuOutside(e) {
  if (_relatedMenuEl && !_relatedMenuEl.contains(e.target)) closeRelatedRowMenu();
}

// After a row action: refresh this list and the sidebar lists it can touch.
async function afterRelatedRowChange() {
  await reloadRelated();
  loadConversations(false);
  refreshPinnedList();
  loadFolders();
}

function openRelatedRowMenu(c, anchorBtn) {
  const wasForThis = _relatedMenuEl && _relatedMenuEl.dataset.convId === c.id;
  closeRelatedRowMenu();
  if (wasForThis) return; // clicking the same ⋮ again closes it

  const menu = document.createElement("div");
  menu.className = "sidebar-menu conv-item-menu";
  menu.dataset.convId = c.id;
  menu.setAttribute("role", "menu");

  const restoreMode = c.archived || c.deleted;
  // The chat this row is linked to, fixed when the menu opens.
  const subject = _related.convId;
  const items = [
    { label: "Remove Link", fn: () => relatedRemove(c.id, subject) },
    {
      label: "Rename",
      fn: async () => {
        await renameConversation(c);
        await reloadRelated();
      },
    },
    {
      label: compareTabForConv(c.id) ? "Remove from Compare" : "Compare",
      fn: () => {
        const existing = compareTabForConv(c.id);
        if (existing) removeFromCompare(existing.id);
        else addToCompare(c.id, c.title, c.provider);
      },
    },
    {
      label: c.pinned ? "Unpin" : "Pin",
      fn: async () => {
        // A foldered chat pins within its folder; any other uses the pin list.
        if (c.folder) await apiFolderPin(c.id, !c.pinned);
        else if (c.pinned) await apiUnpinConversation(c.id);
        else await apiPinConversation(c.id);
        await afterRelatedRowChange();
      },
    },
    { label: "Summary", fn: () => openSummaryForConversation(c.id) },
    {
      label: restoreMode ? "Restore" : "Archive",
      fn: async () => {
        if (c.deleted) await apiUpdateConversationMeta(c.id, { deleted: false });
        else await apiUpdateConversationMeta(c.id, { archived: !c.archived });
        await afterRelatedRowChange();
      },
    },
  ];
  // As in the sidebar: no Delete for a chat already in the Recycle Bin.
  if (!c.deleted) {
    items.push({
      label: "Delete",
      fn: async () => {
        await apiUpdateConversationMeta(c.id, { deleted: true });
        await afterRelatedRowChange();
      },
    });
  }
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sidebar-menu-item";
    b.setAttribute("role", "menuitem");
    const text = document.createElement("span");
    text.className = "sidebar-menu-item-label";
    text.textContent = it.label;
    b.appendChild(text);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeRelatedRowMenu();
      it.fn();
    });
    menu.appendChild(b);
  }

  $("workspace-controls").appendChild(menu);
  _relatedMenuEl = menu;
  // Under the button, right-aligned, kept on screen (as the sidebar menu).
  const inset = themePixels("--popover-safe-inset");
  const gap = themePixels("--popover-gap");
  const r = anchorBtn.getBoundingClientRect();
  const left = Math.max(inset, r.right - menu.offsetWidth);
  let top = r.bottom + gap;
  if (top + menu.offsetHeight > window.innerHeight - inset) {
    top = r.top - menu.offsetHeight - gap;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  prepareActionMenu(menu, anchorBtn, closeRelatedRowMenu);
  document.addEventListener("mousedown", onRelatedMenuOutside, true);
  window.addEventListener("scroll", closeRelatedRowMenu, true);
}

// ── Panel open / close ────────────────────────────────────────────────────────
function relatedPanelIsOpen() {
  return !!relatedPanel && !relatedPanel.hidden;
}

function updateRelatedToggle(isOpen) {
  if (!relatedToggleBtn) return;
  relatedToggleBtn.setAttribute("aria-pressed", String(isOpen));
  relatedToggleBtn.setAttribute(
    "aria-label",
    isOpen ? "Close related conversations" : "Open related conversations",
  );
}

function openRelatedPanel() {
  const convId = state.activeId;
  if (!convId || !relatedPanel) return;
  // Like Notes: a collapsed sidebar opens while the panel is up (app.js).
  expandSidebarForOverlay();
  if (typeof raiseSidebarOverlay === "function") raiseSidebarOverlay(relatedPanel);
  relatedPanel.hidden = false;
  updateRelatedToggle(true);
  if (_related.convId !== convId) {
    loadRelatedFor(convId, $("thread-title")?.textContent || "");
  } else {
    renderRelatedPanel();
    reloadRelated();
  }
}

function closeRelatedPanel() {
  if (!relatedPanel || relatedPanel.hidden) return;
  closeRelatedRowMenu();
  relatedPanel.hidden = true;
  updateRelatedToggle(false);
  restoreSidebarAfterOverlay();
}

// ── Find Related Conversations (Advanced Search, Related mode) ───────────────
function findRelatedConversations() {
  const controller = window.advancedSearchController;
  if (!_related.convId || !controller?.openRelated) return;
  if (_related.convId === state.activeId) {
    _related.title = $("thread-title")?.textContent || _related.title;
  }
  _related.searching = { id: _related.convId, title: _related.title };
  renderRelatedPanel();
  controller.openRelated({ ..._related.searching });
}

// Hub clicked on a chat being previewed during Find: that chat becomes the one
// links are found for. The search stays open and its results re-run for it.
async function retargetRelatedSearch() {
  const id = state.activeId;
  if (!id || !_related.searching) return;
  const title = $("thread-title")?.textContent || "";
  _related.searching = { id, title };
  window.advancedSearchController?.openRelated({ id, title });
  await loadRelatedFor(id, title);
}

// Advanced Search closed while it was in Related mode: the panel goes with it.
function relatedSearchEnded() {
  if (!_related.searching) return;
  _related.searching = null;
  closeRelatedPanel();
  renderRelatedPanel();
}

// Back to the chat the search was for, in the normal view.
function exitRelatedSearch() {
  const target = _related.searching;
  if (!target) return;
  window.advancedSearchController?.close();
  relatedSearchEnded();
  if (state.activeId !== target.id) openConversation(target.id);
}

// app.js openConversation calls this once the chat's details have loaded.
function relatedConversationOpened(conv) {
  if (_related.searching) {
    renderRelatedPanel(); // only the highlighted row changes
    return;
  }
  if (_related.convId === conv.id) {
    _related.title = conv.title || "";
  }
  if (relatedPanelIsOpen() && _related.convId !== conv.id) {
    loadRelatedFor(conv.id, conv.title);
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────
relatedToggleBtn?.addEventListener("click", () => {
  if (!relatedPanelIsOpen()) openRelatedPanel();
  else if (!_related.searching) closeRelatedPanel();
  else if (state.activeId !== _related.searching.id) retargetRelatedSearch();
  else exitRelatedSearch();
});
$("related-panel-close")?.addEventListener("click", () => {
  if (_related.searching) exitRelatedSearch();
  else closeRelatedPanel();
});
relatedForBtn?.addEventListener("click", exitRelatedSearch);
$("related-find-btn")?.addEventListener("click", findRelatedConversations);
relatedSortEl?.addEventListener("change", () => {
  _related.sort = relatedSortEl.value;
  renderRelatedPanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && _relatedMenuEl) closeRelatedRowMenu();
});

window.relatedConversations = {
  icon: relatedIconSvg,
  isLinked: relatedIsLinked,
  add: relatedAdd,
  remove: relatedRemove,
  searchEnded: relatedSearchEnded,
  exitSearch: exitRelatedSearch,
  isSearching: () => !!_related.searching,
  menuOpen: () => !!_relatedMenuEl,
};
