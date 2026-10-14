"use strict";

// ── Scratch Pads ──────────────────────────────────────────────────────────────
// Free-standing Markdown documents (scratchpads.py) that belong to no chat and
// to neither provider. The briefcase menu opens the Scratch Pads workspace: a
// sidebar of pads covers the conversation sidebar (which keeps its width,
// scroll position and collapse state underneath) and the main area shows the
// open pad in the Summary editor's engine (summary.js createVisualEditor /
// attachVisualEditor), plus a link tool.
//
// Links use the one internal format in internal_links.js. They are inserted
// from a small Insert Link popup (search titles and named bookmarks, or paste
// a link), or from Advanced Search in its link-picking mode (Link Chat on a
// result, Link Message on a previewed message). Following a link leaves the
// pad in memory, unsaved edits and all, and a Back button returns to it.
//
// The same module serves "Add to Scratch Pad" (conversation header link
// button, bookmark ⋮ menus): a destination picker that appends a link to a
// pad without opening it.
//
// Loaded last; leans on globals from app.js, summary.js and bookmarks.js.

const spCore = window.SummaryEditorCore;
const spLinks = window.InternalLinks;

const spSidebar = $("scratchpad-sidebar");
const spList = $("scratchpad-list");
const spSearch = $("scratchpad-search");
const spPanel = $("scratchpad-panel");
const spScroll = $("scratchpad-scroll");
const spEmpty = $("scratchpad-empty");
const spEmptyText = $("scratchpad-empty-text");
const spEditorEl = $("scratchpad-editor");
const spTitleInput = $("scratchpad-title-input");
const spSaveBtn = $("scratchpad-save-btn");
const spRevertBtn = $("scratchpad-revert-btn");
const spStatus = $("scratchpad-status");
const spVisual = $("scratchpad-visual");
const spInput = $("scratchpad-input");
const spLinkButton = $("scratchpad-link-button");
const spBubble = $("scratchpad-link-bubble");
const spBubbleText = $("scratchpad-link-bubble-text");
const spPopup = $("scratchpad-link-popup");
const spPopupInput = $("scratchpad-link-input");
const spPopupOptions = $("scratchpad-link-options");
const spPopupNote = $("scratchpad-link-note");
const spPicker = $("scratchpad-picker");
const spPickerChoose = $("scratchpad-picker-choose");
const spPickerInput = $("scratchpad-picker-input");
const spPickerOptions = $("scratchpad-picker-options");
const spPickerCreate = $("scratchpad-picker-create");
const spPickerNewTitle = $("scratchpad-picker-new-title");
const spPickerNote = $("scratchpad-picker-note");
const spToast = $("scratchpad-toast");
const spToastText = $("scratchpad-toast-text");
const spToastAction = $("scratchpad-toast-action");
const spReturnBtn = $("scratchpad-return-btn");
const spReturnLabel = $("scratchpad-return-label");

const sp = {
  // The workspace is showing (its sidebar covers the conversation sidebar).
  active: false,
  pads: [],
  q: "",
  listToken: 0,
  // The open pad {id, title, created_at, updated_at} and its last saved text.
  current: null,
  saved: "",
  saving: null,
  // While Advanced Search picks a link: {range, selectedText, padId}.
  linkMode: null,
  // After following a link out of a pad: {padId, title, scrollTop}.
  returnTo: null,
  // Set while this module itself clears the main area, so that clearing is
  // not mistaken for leaving the workspace.
  ownNavigation: false,
};

// ── Icons (Google Material Symbols, inlined) ─────────────────────────────────
const SP_ICON_PATHS = {
  chat: "M80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z",
  bookmark: "M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z",
  link: "M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z",
  public: "M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-40-82v-78q-33 0-56.5-23.5T360-320v-40L168-552q-3 18-5.5 36t-2.5 36q0 121 79.5 212T440-162Zm276-102q41-45 62.5-100.5T800-480q0-98-54.5-179T600-776v16q0 33-23.5 56.5T520-680h-80v80q0 17-11.5 28.5T400-560h-80v80h240q17 0 28.5 11.5T600-440v120h40q26 0 47 15.5t29 40.5Z",
  note: "M160-400v-80h280v80H160Zm0-160v-80h440v80H160Zm0-160v-80h440v80H160Zm360 560v-123l221-220q9-9 20-13t22-4q12 0 23 4.5t20 13.5l37 37q8 9 12.5 20t4.5 22q0 11-4 22.5T863-380L643-160H520Zm300-263-37-37 37 37ZM580-220h38l121-122-18-19-19-18-122 121v38Zm141-141-19-18 37 37-18-19Z",
  add: "M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z",
};

function spIcon(name, className = "scratchpad-icon") {
  return `<svg class="${className}" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="${SP_ICON_PATHS[name]}"/></svg>`;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function spRequest(url, options = {}) {
  const init = { ...options };
  if (init.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(url, init);
  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    /* an empty or broken body still reports the status below */
  }
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const spApi = {
  list: (q = "") => spRequest(`/api/scratchpads?${new URLSearchParams({ q })}`),
  get: (id) => spRequest(`/api/scratchpads/${encodeURIComponent(id)}`),
  create: (fields) => spRequest("/api/scratchpads", { method: "POST", body: fields }),
  update: (id, fields) => spRequest(`/api/scratchpads/${encodeURIComponent(id)}`, { method: "PATCH", body: fields }),
  remove: (id) => spRequest(`/api/scratchpads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  append: (id, markdown) => spRequest(`/api/scratchpads/${encodeURIComponent(id)}/append`, { method: "POST", body: { markdown } }),
  suggest: (q) => spRequest(`/api/link-suggestions?${new URLSearchParams({ q })}`),
  resolve: (conversationId, seq = null, messageId = null) => spRequest(`/api/link-resolve?${new URLSearchParams({
    conversation: conversationId,
    seq: seq == null ? "" : String(seq),
    message: messageId || "",
  })}`),
};

function spPadTitle(pad) {
  return (pad?.title || "").trim() || "Untitled Scratch Pad";
}

// ── The editor ────────────────────────────────────────────────────────────────
const scratchEditor = createVisualEditor({
  visual: spVisual,
  input: spInput,
  toolbar: $("scratchpad-toolbar"),
  highlightMenu: $("scratchpad-highlight-menu"),
  highlightButton: $("scratchpad-highlight-button"),
  modeVisual: $("scratchpad-mode-visual"),
  modeMarkdown: $("scratchpad-mode-markdown"),
  onChange: () => spSyncButtons(),
  isOpen: () => sp.active && !spPanel.hidden && !!sp.current,
  onPaste: (text, range) => spPasteLink(text, range),
  onLinkCommand: (button) => openInsertLinkPopup(button),
});
attachVisualEditor(scratchEditor);

function spMarkdown() {
  return spInput.value;
}

function spIsDirty() {
  return !!sp.current && spMarkdown() !== sp.saved;
}

function spSyncButtons() {
  const dirty = spIsDirty();
  spSaveBtn.disabled = !dirty || !!sp.saving;
  spRevertBtn.disabled = !dirty || !!sp.saving;
  if (dirty && spStatus.dataset.kind !== "error") spSetStatus("Unsaved changes");
  else if (!dirty && spStatus.dataset.kind === "unsaved") spSetStatus("");
}

function spSetStatus(text, kind = text === "Unsaved changes" ? "unsaved" : "") {
  spStatus.textContent = text;
  spStatus.dataset.kind = kind;
  spStatus.setAttribute("role", kind === "error" ? "alert" : "status");
}

// Make the Scratch Pad editor the one toolbar commands act on.
function spUseEditor() {
  _editor = scratchEditor;
}

function spLoadIntoEditor(pad) {
  _spLoadToken += 1;
  sp.current = { id: pad.id, title: pad.title, created_at: pad.created_at, updated_at: pad.updated_at };
  sp.saved = pad.content || "";
  spInput.value = sp.saved;
  clearEditorHistory(scratchEditor);
  spSetStatus("");
  spShowEditor();
  setEditorMode(scratchEditor, "visual");
  refreshPaletteControls(scratchEditor);
  spSyncButtons();
  spScroll.scrollTop = 0;
}

function spShowEditor() {
  const open = !!sp.current;
  spEditorEl.hidden = !open;
  spEmpty.hidden = open;
  spTitleInput.hidden = !open;
  spSaveBtn.hidden = !open;
  spRevertBtn.hidden = !open;
  if (open) spTitleInput.value = sp.current.title;
  else {
    spEmptyText.textContent = sp.pads.length
      ? "Choose a Scratch Pad from the list, or start a new one."
      : "No Scratch Pads yet. A Scratch Pad is a document of your own for notes and links to conversations or messages.";
  }
  hideLinkBubble();
}

async function spSave() {
  if (!sp.current) return true;
  if (sp.saving) return sp.saving;
  const id = sp.current.id;
  const text = spMarkdown();
  sp.saving = (async () => {
    spSetStatus("Saving…");
    try {
      const data = await spApi.update(id, { content: text });
      if (sp.current?.id === id) {
        sp.saved = text;
        sp.current.updated_at = data.scratch_pad.updated_at;
        spSetStatus(spIsDirty() ? "Unsaved changes" : "Saved");
      }
      spUpsertListRow(data.scratch_pad);
      return true;
    } catch (error) {
      // The text stays in the editor, still marked unsaved.
      spSetStatus(error.status === 404
        ? "This Scratch Pad was deleted elsewhere. Copy your text before leaving."
        : "Could not save. Your changes are still here; try Save again.", "error");
      return false;
    } finally {
      sp.saving = null;
      spSyncButtons();
    }
  })();
  return sp.saving;
}

function spRevert() {
  if (!sp.current) return;
  clearEditorHistory(scratchEditor);
  spInput.value = sp.saved;
  renderVisual(scratchEditor);
  spSetStatus("");
  spSyncButtons();
}

// Ask about unsaved edits before they would be replaced or left behind.
// Resolves false when the user cancels (nothing changes).
async function spConfirmLeavePad() {
  if (!spIsDirty()) return true;
  const result = await openSummaryUnsavedModal();
  if (result === "cancel") return false;
  return spSave();
}

// ── Sidebar list ──────────────────────────────────────────────────────────────
async function spLoadList() {
  const token = ++sp.listToken;
  try {
    const data = await spApi.list(sp.q);
    if (token !== sp.listToken) return;
    sp.pads = data.scratch_pads || [];
    spRenderList();
  } catch (_) {
    if (token !== sp.listToken) return;
    spList.innerHTML = "";
    const failed = document.createElement("div");
    failed.className = "scratchpad-list-note";
    failed.setAttribute("role", "alert");
    failed.textContent = "Scratch Pads could not be loaded.";
    spList.appendChild(failed);
  }
}

function spRenderList() {
  spList.innerHTML = "";
  if (!sp.pads.length) {
    const empty = document.createElement("div");
    empty.className = "scratchpad-list-note";
    empty.textContent = sp.q ? "No Scratch Pads match that title." : "No Scratch Pads yet.";
    spList.appendChild(empty);
    if (!sp.current) spShowEditor();
    return;
  }
  for (const pad of sp.pads) {
    const row = document.createElement("div");
    row.className = "scratchpad-row" + (pad.id === sp.current?.id ? " active" : "");
    row.setAttribute("role", "listitem");
    row.dataset.id = pad.id;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "scratchpad-row-open";
    if (pad.id === sp.current?.id) open.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "scratchpad-row-title";
    title.textContent = spPadTitle(pad);
    const meta = document.createElement("span");
    meta.className = "scratchpad-row-meta";
    meta.textContent = `Edited ${formatDate(pad.updated_at)}`;
    open.append(title, meta);
    open.addEventListener("click", () => spOpenPad(pad.id));
    row.appendChild(open);
    const actions = buildConvActions({ id: `scratchpad:${pad.id}`, title: pad.title }, (_, btn) => spOpenRowMenu(pad, btn));
    const menuBtn = actions.querySelector("button");
    menuBtn.title = `More for ${spPadTitle(pad)}`;
    menuBtn.setAttribute("aria-label", `More actions for ${spPadTitle(pad)}`);
    row.appendChild(actions);
    spList.appendChild(row);
  }
}

// Keep one row in step after a save, rename or append, newest first.
function spUpsertListRow(pad) {
  const row = { id: pad.id, title: pad.title, created_at: pad.created_at, updated_at: pad.updated_at };
  sp.pads = [row, ...sp.pads.filter((p) => p.id !== pad.id)];
  if (sp.q && !spPadTitle(pad).toLowerCase().includes(sp.q.toLowerCase())) {
    sp.pads = sp.pads.filter((p) => p.id !== pad.id);
  }
  if (sp.active) spRenderList();
}

function spOpenRowMenu(pad, btn) {
  showConvItemMenu({ id: `scratchpad:${pad.id}` }, btn, [
    { label: "Rename", fn: () => spRename(pad) },
    { label: "Delete", fn: () => spDelete(pad) },
  ]);
}

async function spRename(pad) {
  const next = await openNameModal({ title: "Rename Scratch Pad", value: spPadTitle(pad), okLabel: "Rename" });
  if (!next || next === pad.title) return;
  await spSaveTitle(pad.id, next);
}

async function spSaveTitle(id, title) {
  try {
    const data = await spApi.update(id, { title });
    if (sp.current?.id === id) {
      sp.current.title = data.scratch_pad.title;
      spTitleInput.value = data.scratch_pad.title;
    }
    spUpsertListRow(data.scratch_pad);
    if (sp.returnTo?.padId === id) spSyncReturnButton();
    return true;
  } catch (_) {
    spSetStatus("Could not rename the Scratch Pad.", "error");
    if (sp.current?.id === id) spTitleInput.value = sp.current.title;
    return false;
  }
}

async function spDelete(pad) {
  if (!(await spLeaveLinkSearch())) return;
  const ok = await openConfirm({
    title: "Delete this Scratch Pad?",
    text: `“${spPadTitle(pad)}” and everything in it will be permanently deleted.`,
    okLabel: "Delete",
  });
  if (!ok) return;
  try {
    await spApi.remove(pad.id);
  } catch (error) {
    if (error.status !== 404) {
      spSetStatus("Could not delete the Scratch Pad.", "error");
      return;
    }
  }
  sp.pads = sp.pads.filter((p) => p.id !== pad.id);
  if (sp.returnTo?.padId === pad.id) spClearReturn();
  if (sp.current?.id === pad.id) {
    sp.current = null;
    sp.saved = "";
    spInput.value = "";
    clearEditorHistory(scratchEditor);
    spSetStatus("");
    const next = sp.pads[0];
    if (next) await spLoadPad(next.id);
    else spShowEditor();
  }
  spRenderList();
}

// ── Opening, creating, switching pads ─────────────────────────────────────────
let _spLoadToken = 0;

async function spLoadPad(id) {
  // Only the newest request may fill the editor: a slower, older response
  // must not replace a pad chosen after it.
  const token = ++_spLoadToken;
  try {
    const data = await spApi.get(id);
    if (token !== _spLoadToken) return false;
    spLoadIntoEditor(data.scratch_pad);
    spRenderList();
    return true;
  } catch (error) {
    if (token !== _spLoadToken) return false;
    if (error.status === 404) {
      sp.pads = sp.pads.filter((p) => p.id !== id);
      spRenderList();
      spSetStatus("That Scratch Pad no longer exists.", "error");
    } else {
      spSetStatus("Could not open the Scratch Pad.", "error");
    }
    return false;
  }
}

async function spOpenPad(id) {
  if (!(await spLeaveLinkSearch())) return;
  if (sp.current?.id === id) {
    spVisual.focus();
    return;
  }
  if (!(await spConfirmLeavePad())) return;
  await spLoadPad(id);
}

async function spCreatePad() {
  if (!(await spLeaveLinkSearch())) return;
  if (!(await spConfirmLeavePad())) return;
  let data;
  try {
    data = await spApi.create({});
  } catch (_) {
    spSetStatus("Could not create a Scratch Pad.", "error");
    return;
  }
  if (sp.q) {
    sp.q = "";
    spSearch.value = "";
  }
  spUpsertListRow(data.scratch_pad);
  spLoadIntoEditor(data.scratch_pad);
  spRenderList();
  // A new pad opens ready to be named.
  spTitleInput.focus();
  spTitleInput.select();
}

// ── Workspace open / close ────────────────────────────────────────────────────
function scratchPadSidebarIsOpen() {
  return !!spSidebar && !spSidebar.hidden;
}

// A collapsed sidebar opens while the workspace is up (app.js), and goes back
// to collapsed when it closes.
function spShowSidebar() {
  expandSidebarForOverlay();
  closeSimpleSearch();
  document.body.classList.add("scratchpads-open");
  spSidebar.hidden = false;
}

function spHideSidebar() {
  if (spSidebar.hidden) return;
  closeConvItemMenu();
  spSidebar.hidden = true;
  document.body.classList.remove("scratchpads-open");
  restoreSidebarAfterOverlay();
}

// Clear the main area for the pad without that counting as leaving.
function spClearMain() {
  sp.ownNavigation = true;
  try {
    hideAllPanels();
  } finally {
    sp.ownNavigation = false;
  }
}

function spShowWorkspace() {
  rememberReturnTab();
  state.activeSpecialView = "scratch_pads";
  state.activeTabId = null;
  document
    .querySelectorAll(".conv-item.active, .folder-conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  spClearMain();
  spPanel.hidden = false;
  if (!sp.active) spShowSidebar();
  sp.active = true;
  renderTabs();
}

// The workspace is gone from view. Any open pad, unsaved edits included, stays
// in memory and is what the workspace shows when it opens again.
function exitScratchWorkspace() {
  if (!sp.active) return;
  sp.active = false;
  closeInsertLinkPopup(false);
  hideLinkBubble();
  spHideSidebar();
  spPanel.hidden = true;
  if (state.activeSpecialView === "scratch_pads") state.activeSpecialView = null;
}

async function openScratchPads(fromButton = false, { padId = null } = {}) {
  if (fromButton && sp.active) {
    await closeScratchPads();
    return;
  }
  if (!sp.active) {
    if (typeof summaryHasUnsavedChanges === "function" && summaryHasUnsavedChanges()) {
      const r = await openSummaryUnsavedModal();
      if (r === "cancel") return;
      if (r === "save") await saveAllUnsaved();
    }
    if (typeof closeSummaryPanel === "function") closeSummaryPanel();
    if (!(await leaveNotesForSpecialView())) return;
    if (window.advancedSearchController?.isOpen()) window.advancedSearchController.close();
    clearSimpleSearchForSection();
  }
  const returning = sp.returnTo;
  spClearReturn();
  spShowWorkspace();
  try {
    const prefs = await apiPreferences();
    _summaryPalette = normalizePalette(prefs.preferences?.summaryHighlightPalette);
  } catch (_) {
    /* keep the palette already loaded */
  }
  await spLoadList();
  const wanted = padId || returning?.padId || sp.current?.id || sp.pads[0]?.id || null;
  if (wanted && sp.current?.id === wanted) {
    // Still in memory (unsaved edits included): show it as it was left.
    spShowEditor();
    setEditorMode(scratchEditor, scratchEditor.mode);
    refreshPaletteControls(scratchEditor);
    spSyncButtons();
    spRenderList();
    if (returning?.padId === wanted) {
      requestAnimationFrame(() => { spScroll.scrollTop = returning.scrollTop || 0; });
    }
  } else if (wanted) {
    if (!(await spConfirmLeavePad())) {
      spShowEditor();
      return;
    }
    await spLoadPad(wanted);
  } else {
    sp.current = null;
    spShowEditor();
  }
}

// The workspace's own Close: check for unsaved changes, then back to chats.
async function closeScratchPads() {
  if (!sp.active) return;
  if (!(await spConfirmLeavePad())) return;
  exitScratchWorkspace();
  await returnFromSpecialView();
}

// app.js asks this before any other screen or chat replaces the workspace.
// `preview` is a chat previewed while Advanced Search picks a link here.
async function scratchPadNavigationGuard({ preview = false } = {}) {
  if (!sp.active) return true;
  if (preview && sp.linkMode) return true;
  if (!(await spConfirmLeavePad())) return false;
  exitScratchWorkspace();
  return true;
}

// app.js hideAllPanels calls this whenever the main area is cleared.
function scratchPadPanelsHidden() {
  if (spPanel) spPanel.hidden = true;
  hideLinkBubble();
  if (sp.ownNavigation || !sp.active || sp.linkMode) return;
  // Something replaced the workspace without asking first; the pad stays in
  // memory, so nothing is lost.
  exitScratchWorkspace();
}

// ── Returning from a followed link ────────────────────────────────────────────
function spSyncReturnButton() {
  if (!spReturnBtn) return;
  const target = sp.returnTo;
  spReturnBtn.hidden = !target;
  if (!target) return;
  const title = sp.current?.id === target.padId ? spPadTitle(sp.current) : target.title;
  spReturnLabel.textContent = `Back to ${title}`;
  spReturnBtn.title = `Back to the Scratch Pad “${title}”`;
}

function spClearReturn() {
  sp.returnTo = null;
  spSyncReturnButton();
}

spReturnBtn?.addEventListener("click", () => {
  const target = sp.returnTo;
  if (target) openScratchPads(false, { padId: target.padId });
});

// ── Following links ───────────────────────────────────────────────────────────
async function followInternalLink(target, { fromPad = false } = {}) {
  const external = spLinks.parse(target) ? null : spLinks.externalUrl(target);
  if (external) {
    window.open(external, "_blank", "noopener,noreferrer");
    return;
  }
  const link = spLinks.parse(target);
  if (!link) {
    showScratchToast("That link cannot be opened.");
    return;
  }
  let info;
  try {
    info = await spApi.resolve(link.conversationId, link.seq, link.messageId);
  } catch (_) {
    showScratchToast("Could not check where that link points. Try again.");
    return;
  }
  if (!info.exists) {
    showScratchToast("That conversation is no longer in your history, so the link cannot be opened.");
    return;
  }
  // The server found the message by its id; go where it is now.
  let seq = info.seq ?? link.seq;
  if (seq != null && !info.message_exists) {
    showScratchToast("That message is no longer in the conversation. Opening the conversation instead.");
    seq = null;
  }
  if (fromPad && sp.active && sp.current) {
    // Leave the pad as it is (unsaved edits too) and offer a way back.
    sp.returnTo = { padId: sp.current.id, title: spPadTitle(sp.current), scrollTop: spScroll.scrollTop };
    exitScratchWorkspace();
  }
  await openConversation(link.conversationId, resolveConversationSidebarEl(link.conversationId), seq);
  spSyncReturnButton();
}

// ── Link bubble (caret in a link: Open / Change / Remove) ─────────────────────
let _spBubbleToken = null;

function spLinkTokenAtCaret() {
  if (scratchEditor.mode !== "visual") return null;
  const range = sourceRangeFromSelection(scratchEditor);
  if (!range) return null;
  return spCore.linkTokenAt(spMarkdown(), range.start, range.end);
}

function spLinkLeafFor(token) {
  return [...spVisual.querySelectorAll(".visual-link")].find(
    (el) => Number(el.dataset.tokenStart) === token.tokenStart,
  ) || null;
}

async function showLinkBubble(token) {
  const leaf = spLinkLeafFor(token);
  if (!leaf) return hideLinkBubble();
  const target = spCore.linkTarget(token);
  const sameLink = _spBubbleToken && _spBubbleToken.tokenStart === token.tokenStart && _spBubbleToken.raw === token.raw;
  _spBubbleToken = token;
  spBubble.hidden = false;
  // Under the link, inside the editor's own box.
  const box = spEditorEl.getBoundingClientRect();
  const r = leaf.getBoundingClientRect();
  const gap = themePixels("--popover-gap");
  const left = Math.max(0, Math.min(r.left - box.left, box.width - spBubble.offsetWidth));
  spBubble.style.left = `${left}px`;
  spBubble.style.top = `${r.bottom - box.top + gap}px`;
  if (sameLink) return;
  const link = spLinks.parse(target);
  if (!link) {
    spBubbleText.textContent = target;
    spBubbleText.title = target;
    return;
  }
  spBubbleText.textContent = link.seq == null ? "Conversation link" : "Message link";
  spBubbleText.title = target;
  try {
    const info = await spApi.resolve(link.conversationId, link.seq, link.messageId);
    if (_spBubbleToken !== token) return;
    if (!info.exists) spBubbleText.textContent = "Conversation no longer exists";
    else if (link.seq == null) spBubbleText.textContent = `Conversation: ${info.title || "Untitled"}`;
    else if (!info.message_exists) spBubbleText.textContent = `Missing message in ${info.title || "Untitled"}`;
    else spBubbleText.textContent = `${info.bookmark_name ? `“${info.bookmark_name}”` : "Message"} in ${info.title || "Untitled"}`;
  } catch (_) {
    /* keep the generic description */
  }
}

function hideLinkBubble() {
  _spBubbleToken = null;
  if (spBubble) spBubble.hidden = true;
}

function spSyncLinkBubble() {
  if (!scratchEditor.isOpen()) return hideLinkBubble();
  const token = spLinkTokenAtCaret();
  if (token) showLinkBubble(token);
  else if (!spBubble.contains(document.activeElement)) hideLinkBubble();
}

document.addEventListener("selectionchange", () => {
  if (sp.active && !spPanel.hidden) spSyncLinkBubble();
});

spVisual.addEventListener("click", (event) => {
  const leaf = event.target.closest(".visual-link");
  if (!leaf) return;
  // Ctrl / Cmd + click follows the link at once, as in other editors.
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    followInternalLink(leaf.dataset.href, { fromPad: true });
  }
});

spBubble.addEventListener("mousedown", (event) => event.preventDefault());
spBubble.addEventListener("click", (event) => {
  const action = event.target.closest("[data-link-action]")?.dataset.linkAction;
  const token = _spBubbleToken;
  if (!action || !token) return;
  spUseEditor();
  if (action === "open") {
    followInternalLink(spCore.linkTarget(token), { fromPad: true });
  } else if (action === "remove") {
    hideLinkBubble();
    spVisual.focus();
    commitVisualSource(spCore.removeLink(spMarkdown(), token), token.tokenStart + (token.sourceEnd - token.sourceStart));
  } else if (action === "change") {
    openInsertLinkPopup(spLinkButton, { replace: token });
  }
});

spBubble.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    hideLinkBubble();
    spVisual.focus();
  }
});

// ── Inserting links into the pad ──────────────────────────────────────────────
// Every way of adding a link ends here: the popup, Advanced Search, pasting.
function spInsertLink(range, label, target) {
  if (!sp.current) return;
  spUseEditor();
  if (scratchEditor.mode !== "visual") setEditorMode(scratchEditor, "visual");
  spVisual.focus();
  const source = spMarkdown();
  const start = Math.max(0, Math.min(range?.start ?? source.length, source.length));
  const end = Math.max(start, Math.min(range?.end ?? start, source.length));
  const result = spCore.insertLink(source, start, end, spLinks.cleanLabel(label), target);
  commitVisualSource(result.source, result.caret);
}

function spSelectedText(range) {
  if (!range || range.start === range.end) return "";
  return spCore.visibleText(spMarkdown(), range.start, range.end).replace(/\s+/g, " ").trim();
}

// Label for a link to a whole chat or one message, read from the server.
async function spLabelForInternal(link) {
  try {
    const info = await spApi.resolve(link.conversationId, link.seq, link.messageId);
    if (!info.exists) return null;
    if (link.seq == null) return info.title || "Untitled";
    return info.bookmark_name || `Message in ${info.title || "Untitled"}`;
  } catch (_) {
    return link.seq == null ? "Conversation" : "Message";
  }
}

// A pasted internal link becomes a formatted link (its title, or the
// selected text, as the visible label). Anything else pastes as text.
function spPasteLink(text, range) {
  const link = spLinks.parse(text);
  if (!link) return false;
  const selected = spSelectedText(range);
  const before = spMarkdown();
  (async () => {
    const label = selected || (await spLabelForInternal(link)) || "Missing conversation";
    // Only insert if nothing changed while the title was looked up.
    if (spMarkdown() !== before) return;
    spInsertLink(range, label, text.trim());
  })();
  return true;
}

// ── Insert Link popup ─────────────────────────────────────────────────────────
const _spPopup = {
  open: false,
  range: null,
  selectedText: "",
  replace: null, // a link token whose destination is being changed
  options: [],
  active: -1,
  token: 0,
  timer: null,
};

function spPlacePopup(popup, anchor) {
  const inset = themePixels("--popover-safe-inset");
  const gap = themePixels("--popover-gap");
  const r = anchor.getBoundingClientRect();
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - width - inset);
  left = Math.max(inset, left);
  let top = r.bottom + gap;
  if (top + height > window.innerHeight - inset && r.top - gap - height >= inset) top = r.top - gap - height;
  top = Math.max(inset, Math.min(top, window.innerHeight - height - inset));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function openInsertLinkPopup(anchor, { replace = null } = {}) {
  if (!sp.current) return;
  spUseEditor();
  // Keep the caret / selection from before focus moves into the popup.
  const range = replace
    ? { start: replace.sourceStart, end: replace.sourceEnd }
    : (visualCommandRange() || { start: spMarkdown().length, end: spMarkdown().length });
  _spPopup.range = range;
  _spPopup.replace = replace;
  _spPopup.selectedText = replace ? "" : spSelectedText(range);
  _spPopup.open = true;
  hideLinkBubble();
  spPopupInput.value = "";
  spPopupNote.textContent = replace
    ? "Choose a new destination. The link text stays the same."
    : (_spPopup.selectedText ? `The selected text “${_spPopup.selectedText}” becomes the link.` : "");
  spRenderOptions(spPopupOptions, [], spPopupInput);
  spPopup.hidden = false;
  spLinkButton.setAttribute("aria-expanded", "true");
  spPlacePopup(spPopup, anchor);
  spPopupInput.focus();
  document.addEventListener("mousedown", spPopupOutside, true);
}

function closeInsertLinkPopup(restoreFocus = true) {
  if (!_spPopup.open) return;
  _spPopup.open = false;
  _spPopup.token += 1;
  clearTimeout(_spPopup.timer);
  spPopup.hidden = true;
  spLinkButton.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", spPopupOutside, true);
  if (restoreFocus && scratchEditor.isOpen()) {
    // Cancel: the document is untouched; the caret goes back where it was.
    spUseEditor();
    spVisual.focus();
    if (_spPopup.range) setVisualCaret(_spPopup.range.end, scratchEditor);
  }
}

function spPopupOutside(event) {
  if (!spPopup.contains(event.target) && !spLinkButton.contains(event.target)) closeInsertLinkPopup(false);
}

// Options are {kind, title, detail, icon, run}. One listbox drawer serves the
// Insert Link popup and the destination picker.
function spRenderOptions(listbox, options, input, emptyText = "") {
  listbox.innerHTML = "";
  listbox._options = options;
  listbox._active = options.length ? 0 : -1;
  options.forEach((option, index) => {
    const el = document.createElement("div");
    el.className = "scratchpad-option";
    el.id = `${listbox.id}-${index}`;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(index === listbox._active));
    el.innerHTML = option.icon ? spIcon(option.icon, "scratchpad-option-icon") : "";
    const text = document.createElement("span");
    text.className = "scratchpad-option-text";
    const title = document.createElement("span");
    title.className = "scratchpad-option-title";
    title.textContent = option.title;
    text.appendChild(title);
    if (option.detail) {
      const detail = document.createElement("span");
      detail.className = "scratchpad-option-detail";
      detail.textContent = option.detail;
      text.appendChild(detail);
    }
    el.appendChild(text);
    if (option.trailing) {
      const trailing = document.createElement("span");
      trailing.className = "scratchpad-option-trailing";
      trailing.innerHTML = spIcon(option.trailing, "scratchpad-option-icon");
      el.appendChild(trailing);
    }
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", () => option.run());
    el.addEventListener("mousemove", () => spSetActiveOption(listbox, input, index));
    listbox.appendChild(el);
  });
  if (!options.length && emptyText) {
    const empty = document.createElement("div");
    empty.className = "scratchpad-options-empty";
    empty.textContent = emptyText;
    listbox.appendChild(empty);
  }
  input.setAttribute("aria-expanded", String(options.length > 0));
  spSetActiveOption(listbox, input, listbox._active);
}

function spSetActiveOption(listbox, input, index) {
  listbox._active = index;
  [...listbox.querySelectorAll(".scratchpad-option")].forEach((el, i) => {
    el.setAttribute("aria-selected", String(i === index));
    el.classList.toggle("active", i === index);
  });
  const active = listbox.querySelector(`#${CSS.escape(`${listbox.id}-${index}`)}`);
  if (active) {
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

// ↑ / ↓ / Home / End move through the options, Enter picks one.
function spOptionKeys(event, listbox, input) {
  const options = listbox._options || [];
  if (["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    spSetActiveOption(listbox, input, (listbox._active + step + options.length) % options.length);
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    options[listbox._active]?.run();
    return true;
  }
  return false;
}

function spPickLink(label, target) {
  const { range, selectedText, replace } = _spPopup;
  closeInsertLinkPopup(false);
  if (replace) {
    spUseEditor();
    spVisual.focus();
    const source = spMarkdown();
    const token = spCore.linkTokenAt(source, replace.sourceStart, replace.sourceEnd);
    if (!token || token.raw !== replace.raw) return; // the link changed meanwhile
    commitVisualSource(spCore.replaceLinkTarget(source, token, target), token.sourceEnd);
    return;
  }
  spInsertLink(range, selectedText || label, target);
}

async function spRefreshPopupOptions() {
  const text = spPopupInput.value.trim();
  const token = ++_spPopup.token;
  if (!text) {
    spRenderOptions(spPopupOptions, [], spPopupInput);
    return;
  }
  const internal = spLinks.parse(text);
  if (internal) {
    const label = await spLabelForInternal(internal);
    if (token !== _spPopup.token) return;
    spRenderOptions(spPopupOptions, label ? [{
      icon: internal.seq == null ? "chat" : "bookmark",
      title: label,
      detail: internal.seq == null ? "Internal link · Conversation" : "Internal link · Message",
      trailing: "add",
      run: () => spPickLink(label, text),
    }] : [], spPopupInput, "That link points to a conversation that is no longer in your history.");
    return;
  }
  const url = spLinks.externalUrl(text);
  if (url) {
    spRenderOptions(spPopupOptions, [{
      icon: "public",
      title: text,
      detail: "Web link",
      trailing: "add",
      run: () => spPickLink(text, url),
    }], spPopupInput);
    return;
  }
  let data;
  try {
    data = await spApi.suggest(text);
  } catch (_) {
    if (token === _spPopup.token) spRenderOptions(spPopupOptions, [], spPopupInput, "Search failed. Try again.");
    return;
  }
  if (token !== _spPopup.token) return;
  const provider = (p) => (p === "chatgpt" ? "ChatGPT" : p === "claude" ? "Claude" : "");
  const options = [
    ...(data.conversations || []).map((c) => ({
      icon: "chat",
      title: c.title || "Untitled",
      detail: ["Conversation", provider(c.provider)].filter(Boolean).join(" · "),
      trailing: "add",
      run: () => spPickLink(c.title || "Untitled", spLinks.conversationLink(c.id)),
    })),
    ...(data.bookmarks || []).map((b) => ({
      icon: "bookmark",
      title: b.name,
      detail: `Bookmark · In: ${b.conversation_title || "Untitled"}`,
      trailing: "add",
      run: () => spPickLink(b.name, spLinks.messageLink(b.conversation_id, b.seq, b.message_uuid)),
    })),
  ];
  spRenderOptions(spPopupOptions, options, spPopupInput, "No conversations or named bookmarks match.");
}

spPopupInput.addEventListener("input", () => {
  clearTimeout(_spPopup.timer);
  _spPopup.timer = setTimeout(spRefreshPopupOptions, 150);
});
spPopupInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !(spPopupOptions._options || []).length) {
    // Enter on a pasted link before its option has been drawn.
    event.preventDefault();
    clearTimeout(_spPopup.timer);
    spRefreshPopupOptions().then(() => spPopupOptions._options?.[0]?.run());
    return;
  }
  spOptionKeys(event, spPopupOptions, spPopupInput);
});
spPopup.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeInsertLinkPopup(true);
  }
});
$("scratchpad-link-popup-close").addEventListener("click", () => closeInsertLinkPopup(true));
$("scratchpad-link-advanced").addEventListener("click", () => {
  const { range, selectedText, replace } = _spPopup;
  closeInsertLinkPopup(false);
  startLinkSearch(range, replace ? "" : selectedText, replace);
});

// ── Advanced Search in link-picking mode ──────────────────────────────────────
// The search stays open while results are previewed. Link Chat on a result, or
// Link Message on a previewed message, puts the link in the pad and returns
// to it. Closing the search returns to the pad unchanged.
function startLinkSearch(range, selectedText, replace = null) {
  const controller = window.advancedSearchController;
  if (!controller?.openLinkPicker || !sp.current) return;
  sp.linkMode = { range, selectedText, replace, padId: sp.current.id };
  hideLinkBubble();
  controller.openLinkPicker({
    title: "Insert Conversation Link",
    pickConversation: (result) => finishLinkSearch({
      label: result.title || "Untitled",
      target: spLinks.conversationLink(result.id),
    }),
    ended: (returnToPad) => spLinkSearchEnded(returnToPad),
  });
}

// Back to the pad that started the search, as it was.
async function spReturnToPadFromSearch() {
  if (!sp.active) return false;
  if (typeof notesNavigationGuard === "function" && !(await notesNavigationGuard({ endVisit: true }))) return false;
  if (state.activeSpecialView !== "scratch_pads" || spPanel.hidden) spShowWorkspace();
  return true;
}

async function finishLinkSearch({ label, target }) {
  const mode = sp.linkMode;
  if (!mode) return;
  sp.linkMode = null;
  spRemoveLinkPickButtons();
  window.advancedSearchController?.close();
  if (!(await spReturnToPadFromSearch()) || sp.current?.id !== mode.padId) return;
  if (mode.replace) {
    _spPopup.replace = mode.replace;
    _spPopup.range = mode.range;
    _spPopup.selectedText = "";
    spPickLink(label, target);
    return;
  }
  spInsertLink(mode.range, mode.selectedText || label, target);
}

async function spLinkSearchEnded(returnToPad) {
  const mode = sp.linkMode;
  if (!mode) return;
  sp.linkMode = null;
  spRemoveLinkPickButtons();
  if (!returnToPad) {
    // Something else closed the search (another chat or screen was chosen).
    if (sp.active && spPanel.hidden && state.activeSpecialView !== "scratch_pads") exitScratchWorkspace();
    return;
  }
  if (!(await spReturnToPadFromSearch())) return;
  spUseEditor();
  spVisual.focus();
  setVisualCaret(mode.range?.end ?? 0, scratchEditor);
}

// Choosing another pad (or New, or Delete) while Advanced Search picks a link
// for this one ends that search without inserting anything.
async function spLeaveLinkSearch() {
  if (!sp.linkMode) return true;
  sp.linkMode = null;
  spRemoveLinkPickButtons();
  window.advancedSearchController?.close();
  return spReturnToPadFromSearch();
}

function spRemoveLinkPickButtons() {
  document.querySelectorAll(".message-link-pick").forEach((el) => el.remove());
}

// app.js openConversation: a "Link Message" button on each message of a chat
// previewed while Advanced Search picks a link.
function decorateMessageLinkPick({ metaRow, seq, messageId = null }) {
  if (!sp.linkMode) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "message-link-pick";
  btn.innerHTML = `${spIcon("link", "message-link-pick-icon")}<span>Link Message</span>`;
  btn.title = "Insert a link to this message";
  btn.addEventListener("click", async () => {
    const conversationId = state.activeId;
    if (!conversationId) return;
    const label = (await spLabelForInternal({ conversationId, seq, messageId })) || "Message";
    finishLinkSearch({ label, target: spLinks.messageLink(conversationId, seq, messageId) });
  });
  metaRow.appendChild(btn);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _spToastTimer = null;

function showScratchToast(text, { padId = null } = {}) {
  clearTimeout(_spToastTimer);
  spToastText.textContent = text;
  spToastAction.hidden = !padId;
  spToastAction.onclick = padId ? () => {
    hideScratchToast();
    openScratchPads(false, { padId });
  } : null;
  spToast.hidden = false;
  _spToastTimer = setTimeout(hideScratchToast, padId ? 8000 : 5000);
}

function hideScratchToast() {
  clearTimeout(_spToastTimer);
  spToast.hidden = true;
}

spToast.addEventListener("mouseenter", () => clearTimeout(_spToastTimer));
spToast.addEventListener("focusin", () => clearTimeout(_spToastTimer));
spToast.addEventListener("mouseleave", () => {
  _spToastTimer = setTimeout(hideScratchToast, 3000);
});
$("scratchpad-toast-close").addEventListener("click", hideScratchToast);

// ── Copy Internal Link ────────────────────────────────────────────────────────
async function copyInternalLink(target) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(target);
    copied = true;
  } catch (_) {
    // Older or locked-down browsers: copy through a temporary field.
    const field = document.createElement("textarea");
    field.value = target;
    field.className = "sr-only";
    document.body.appendChild(field);
    field.select();
    try {
      copied = document.execCommand("copy");
    } catch (__) {
      copied = false;
    }
    field.remove();
  }
  showScratchToast(copied ? "Internal link copied" : `Copy this link: ${target}`);
}

// ── Add to Scratch Pad (destination picker) ───────────────────────────────────
const _spPick = { open: false, item: null, anchor: null, busy: false, token: 0 };

// item: {label, target}. Adds "[label](target)" to the end of a chosen pad.
function openScratchPadPicker(anchor, item) {
  closeScratchPadPicker(false);
  _spPick.open = true;
  _spPick.item = item;
  _spPick.anchor = anchor;
  _spPick.busy = false;
  spPickerNote.textContent = "";
  spPickerInput.value = "";
  spPickerChoose.hidden = false;
  spPickerCreate.hidden = true;
  spPicker.hidden = false;
  spRenderPickerOptions([]);
  spPlacePopup(spPicker, anchor);
  spPickerInput.focus();
  document.addEventListener("mousedown", spPickerOutside, true);
  spRefreshPickerOptions();
}

function closeScratchPadPicker(restoreFocus = true) {
  if (!_spPick.open) return;
  _spPick.open = false;
  _spPick.token += 1;
  spPicker.hidden = true;
  document.removeEventListener("mousedown", spPickerOutside, true);
  if (restoreFocus && _spPick.anchor?.isConnected) _spPick.anchor.focus();
}

function spPickerOutside(event) {
  if (!spPicker.contains(event.target)) closeScratchPadPicker(false);
}

function spRenderPickerOptions(pads, failed = false) {
  const options = pads.map((pad) => ({
    icon: "note",
    title: spPadTitle(pad),
    detail: `Edited ${formatDate(pad.updated_at)}`,
    run: () => spAddToPad(pad),
  }));
  options.push({
    icon: "add",
    title: "Create New Scratch Pad",
    detail: "",
    run: () => spShowPickerCreate(),
  });
  spRenderOptions(spPickerOptions, options, spPickerInput);
  if (failed) spPickerNote.textContent = "Scratch Pads could not be loaded.";
}

async function spRefreshPickerOptions() {
  const token = ++_spPick.token;
  try {
    const data = await spApi.list(spPickerInput.value.trim());
    if (token !== _spPick.token) return;
    spRenderPickerOptions(data.scratch_pads || []);
  } catch (_) {
    if (token === _spPick.token) spRenderPickerOptions([], true);
  }
}

function spShowPickerCreate() {
  spPickerChoose.hidden = true;
  spPickerCreate.hidden = false;
  spPickerNewTitle.value = spPickerInput.value.trim();
  spPickerNote.textContent = "";
  spPickerNewTitle.focus();
}

function spPickerLine() {
  const { label, target } = _spPick.item;
  return spLinks.markdown(label, target);
}

// Merge an addition into the pad open in the editor without losing edits:
// the saved copy becomes the server's, and the same line joins the draft.
function spMergeAppended(pad, line) {
  if (sp.current?.id !== pad.id) return;
  const dirty = spIsDirty();
  const draft = spMarkdown();
  sp.saved = pad.content;
  sp.current.updated_at = pad.updated_at;
  const next = dirty ? spCore.appendBlock(draft, line) : pad.content;
  if (next !== draft) {
    scratchEditor.undo.push(draft);
    scratchEditor.redo = [];
    spInput.value = next;
    renderVisual(scratchEditor);
  }
  spSyncButtons();
}

async function spAddToPad(pad) {
  if (_spPick.busy) return;
  _spPick.busy = true;
  spPickerNote.textContent = "Adding…";
  const line = spPickerLine();
  try {
    const data = await spApi.append(pad.id, line);
    spMergeAppended(data.scratch_pad, line);
    spUpsertListRow(data.scratch_pad);
    closeScratchPadPicker();
    showScratchToast(`Added to ${spPadTitle(data.scratch_pad)}`, { padId: pad.id });
  } catch (error) {
    spPickerNote.textContent = error.status === 404
      ? "That Scratch Pad no longer exists."
      : "Could not add the link. Try again.";
    if (error.status === 404) spRefreshPickerOptions();
  } finally {
    _spPick.busy = false;
  }
}

async function spCreateFromPicker() {
  if (_spPick.busy) return;
  _spPick.busy = true;
  spPickerNote.textContent = "Creating…";
  try {
    const data = await spApi.create({
      title: spPickerNewTitle.value.trim() || "Untitled Scratch Pad",
      content: spPickerLine(),
    });
    spUpsertListRow(data.scratch_pad);
    closeScratchPadPicker();
    showScratchToast(`Added to ${spPadTitle(data.scratch_pad)}`, { padId: data.scratch_pad.id });
  } catch (_) {
    spPickerNote.textContent = "Could not create the Scratch Pad. Try again.";
  } finally {
    _spPick.busy = false;
  }
}

let _spPickerTimer = null;
spPickerInput.addEventListener("input", () => {
  clearTimeout(_spPickerTimer);
  _spPickerTimer = setTimeout(spRefreshPickerOptions, 150);
});
spPickerInput.addEventListener("keydown", (event) => spOptionKeys(event, spPickerOptions, spPickerInput));
spPickerCreate.addEventListener("submit", (event) => {
  event.preventDefault();
  spCreateFromPicker();
});
$("scratchpad-picker-create-cancel").addEventListener("click", () => {
  spPickerCreate.hidden = true;
  spPickerChoose.hidden = false;
  spPickerNote.textContent = "";
  spPickerInput.focus();
});
spPicker.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeScratchPadPicker();
  }
});
$("scratchpad-picker-close").addEventListener("click", () => closeScratchPadPicker());

// ── Conversation header link button ───────────────────────────────────────────
const convLinkBtn = $("conv-link-btn");
convLinkBtn?.addEventListener("click", () => {
  const id = state.activeId;
  if (!id) return;
  const title = $("thread-title")?.textContent || "Untitled";
  const target = spLinks.conversationLink(id);
  showConvItemMenu({ id: `conv-link:${id}` }, convLinkBtn, [
    { label: "Copy Internal Link", fn: () => copyInternalLink(target) },
    { label: "Add to Scratch Pad", fn: () => openScratchPadPicker(convLinkBtn, { label: title, target }) },
  ]);
});

// ── Workspace controls ────────────────────────────────────────────────────────
$("scratchpad-close-btn").addEventListener("click", closeScratchPads);
$("scratchpad-new-btn").addEventListener("click", spCreatePad);
$("scratchpad-empty-new").addEventListener("click", spCreatePad);
spSaveBtn.addEventListener("click", () => spSave());
spRevertBtn.addEventListener("click", spRevert);

let _spSearchTimer = null;
spSearch.addEventListener("input", () => {
  clearTimeout(_spSearchTimer);
  _spSearchTimer = setTimeout(() => {
    sp.q = spSearch.value.trim();
    spLoadList();
  }, 150);
});

spTitleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    spVisual.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    spTitleInput.value = sp.current?.title || "";
    spVisual.focus();
  }
});
spTitleInput.addEventListener("change", () => {
  if (!sp.current) return;
  const next = spTitleInput.value.trim();
  if (!next) {
    spTitleInput.value = sp.current.title;
    return;
  }
  if (next !== sp.current.title) spSaveTitle(sp.current.id, next);
});

// Ctrl / Cmd + S saves the open pad.
spPanel.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (spIsDirty()) spSave();
  }
});

spScroll.addEventListener("scroll", hideLinkBubble, { passive: true });

window.addEventListener("beforeunload", (event) => {
  if (spIsDirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.scratchPads = {
  open: openScratchPads,
  follow: followInternalLink,
  copyLink: copyInternalLink,
  addToPad: openScratchPadPicker,
  isLinkPicking: () => !!sp.linkMode,
};
