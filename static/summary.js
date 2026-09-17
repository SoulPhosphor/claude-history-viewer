"use strict";

// ── Summary feature ──────────────────────────────────────────────────────────
// The summary view lives inside #thread, sharing its titlebar and header.
// Toggling between chat and summary just swaps #messages and #summary-body
// visibility. The only visual change in the titlebar is the book/forum icon.

// ── State ────────────────────────────────────────────────────────────────────
let _summaryConvId = null;
let _savedCondensed = "";
let _savedSummary = "";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const summaryBodyEl = $("summary-body");
const condensedSection = $("summary-condensed-section");
const condensedInput = $("condensed-summary-input");
const condensedRevertBtn = $("condensed-revert-btn");
const condensedSaveBtn = $("condensed-save-btn");
const summaryInput = $("summary-input");
const summaryRevertBtn = $("summary-revert-btn");
const summarySaveBtn = $("summary-save-btn");
const summaryUnsavedModal = $("summary-unsaved-modal");
const summaryUnsavedCancel = $("summary-unsaved-cancel");
const summaryUnsavedSave = $("summary-unsaved-save");

// ── Helpers ──────────────────────────────────────────────────────────────────

function summaryIsOpen() {
  return summaryBodyEl && !summaryBodyEl.hidden;
}

function summaryHasUnsavedChanges() {
  if (!_summaryConvId) return false;
  const cDirty = condensedInput && !condensedSection.hidden &&
    condensedInput.value !== _savedCondensed;
  const sDirty = summaryInput && summaryInput.value !== _savedSummary;
  return !!(cDirty || sDirty);
}

function updateCondensedButtons() {
  if (!condensedRevertBtn || !condensedSaveBtn) return;
  const dirty = condensedInput.value !== _savedCondensed;
  condensedRevertBtn.disabled = !dirty;
  condensedSaveBtn.disabled = !dirty;
}

function updateSummaryButtons() {
  if (!summaryRevertBtn || !summarySaveBtn) return;
  const dirty = summaryInput.value !== _savedSummary;
  summaryRevertBtn.disabled = !dirty;
  summarySaveBtn.disabled = !dirty;
}

function updateSummaryCondensedVisibility() {
  if (!condensedSection) return;
  condensedSection.hidden = !state.preferences.includeCondensedSummary;
}

// ── Toggle icon (book / forum) in the thread titlebar ────────────────────────

function updateSummaryToggleIcon(isSummaryOpen) {
  const bookIcon = $("summary-icon-book");
  const forumIcon = $("summary-icon-forum");
  const toggleBtn = $("summary-toggle-btn");
  if (!bookIcon || !forumIcon || !toggleBtn) return;
  if (isSummaryOpen) {
    bookIcon.hidden = true;
    forumIcon.hidden = false;
    toggleBtn.title = "Back to chat";
    toggleBtn.setAttribute("aria-label", "Back to chat");
  } else {
    bookIcon.hidden = false;
    forumIcon.hidden = true;
    toggleBtn.title = "Summary";
    toggleBtn.setAttribute("aria-label", "Open summary");
  }
}

// ── API ──────────────────────────────────────────────────────────────────────

async function apiGetSummary(convId) {
  const r = await fetch(`/api/summaries/${encodeURIComponent(convId)}`);
  return r.json();
}

async function apiSaveSummary(convId, fields) {
  const r = await fetch(`/api/summaries/${encodeURIComponent(convId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return r.json();
}

// ── Save helpers ─────────────────────────────────────────────────────────────

async function saveCondensedSummary() {
  if (!_summaryConvId) return;
  const text = condensedInput.value;
  await apiSaveSummary(_summaryConvId, { condensed_summary: text });
  _savedCondensed = text;
  updateCondensedButtons();
  refreshSummaryHintForConv(_summaryConvId);
}

async function saveMainSummary() {
  if (!_summaryConvId) return;
  const text = summaryInput.value;
  await apiSaveSummary(_summaryConvId, { summary: text });
  _savedSummary = text;
  updateSummaryButtons();
}

async function saveAllUnsaved() {
  if (!_summaryConvId) return;
  const fields = {};
  if (condensedInput && !condensedSection.hidden &&
      condensedInput.value !== _savedCondensed) {
    fields.condensed_summary = condensedInput.value;
    _savedCondensed = condensedInput.value;
  }
  if (summaryInput && summaryInput.value !== _savedSummary) {
    fields.summary = summaryInput.value;
    _savedSummary = summaryInput.value;
  }
  if (Object.keys(fields).length) {
    await apiSaveSummary(_summaryConvId, fields);
  }
  updateCondensedButtons();
  updateSummaryButtons();
  refreshSummaryHintForConv(_summaryConvId);
}

// ── Refresh the sidebar hint for a conversation after saving ────────────────

function refreshSummaryHintForConv(convId) {
  const hasContent = !!(_savedCondensed && _savedCondensed.trim());
  document.querySelectorAll(`.conv-summary-hint[data-conv-id="${CSS.escape(convId)}"]`).forEach((el) => {
    if (!hasContent || !state.preferences.showSummaryHints) el.remove();
  });
  if (hasContent && state.preferences.showSummaryHints) {
    document.querySelectorAll(`.conv-item[data-id="${CSS.escape(convId)}"], .folder-conv-item[data-id="${CSS.escape(convId)}"]`).forEach((row) => {
      if (!row.querySelector(".conv-summary-hint")) {
        const hintEl = document.createElement("span");
        hintEl.className = "conv-summary-hint";
        hintEl.textContent = "Summary";
        hintEl.dataset.convId = convId;
        const anchor = row.querySelector(".conv-top-row") || row.querySelector(".folder-conv-title");
        if (anchor) anchor.after(hintEl);
        else row.appendChild(hintEl);
      }
    });
  }
}

// ── Open / close summary view ───────────────────────────────────────────────

async function openSummaryForConversation(convId) {
  if (!convId) return;

  if (_summaryConvId && _summaryConvId !== convId && summaryHasUnsavedChanges()) {
    const result = await openSummaryUnsavedModal();
    if (result === "cancel") return;
    if (result === "save") await saveAllUnsaved();
  }

  if (state.activeId !== convId) {
    await openConversation(convId, findConvItemEl(convId));
  }

  _summaryConvId = convId;

  // Swap messages for summary body (both inside #thread).
  if (messagesEl) messagesEl.hidden = true;
  if (summaryBodyEl) summaryBodyEl.hidden = false;

  updateSummaryCondensedVisibility();
  updateSummaryToggleIcon(true);

  const data = await apiGetSummary(convId);
  _savedCondensed = data.condensed_summary || "";
  _savedSummary = data.summary || "";
  if (condensedInput) condensedInput.value = _savedCondensed;
  if (summaryInput) summaryInput.value = _savedSummary;

  updateCondensedButtons();
  updateSummaryButtons();
}

function closeSummaryPanel() {
  _summaryConvId = null;
  if (summaryBodyEl) summaryBodyEl.hidden = true;
  if (messagesEl) messagesEl.hidden = false;
  updateSummaryToggleIcon(false);
}

function returnFromSummaryToChat() {
  _summaryConvId = null;
  if (summaryBodyEl) summaryBodyEl.hidden = true;
  if (messagesEl) messagesEl.hidden = false;
  updateSummaryToggleIcon(false);
}

// ── Unsaved changes modal ────────────────────────────────────────────────────

let _unsavedResolve = null;

function openSummaryUnsavedModal() {
  return new Promise((resolve) => {
    _unsavedResolve = resolve;
    if (summaryUnsavedModal) summaryUnsavedModal.hidden = false;
  });
}

function closeSummaryUnsavedModal(result) {
  if (summaryUnsavedModal) summaryUnsavedModal.hidden = true;
  if (_unsavedResolve) {
    _unsavedResolve(result);
    _unsavedResolve = null;
  }
}

summaryUnsavedCancel?.addEventListener("click", () => closeSummaryUnsavedModal("cancel"));
summaryUnsavedSave?.addEventListener("click", () => closeSummaryUnsavedModal("save"));

summaryUnsavedModal?.addEventListener("click", (e) => {
  if (e.target === summaryUnsavedModal) closeSummaryUnsavedModal("cancel");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && summaryUnsavedModal && !summaryUnsavedModal.hidden) {
    closeSummaryUnsavedModal("cancel");
  }
});

// ── Navigation guard ─────────────────────────────────────────────────────────

async function summaryNavigationGuard(proceedFn) {
  if (summaryHasUnsavedChanges()) {
    const result = await openSummaryUnsavedModal();
    if (result === "cancel") return false;
    if (result === "save") await saveAllUnsaved();
  }
  closeSummaryPanel();
  await proceedFn();
  return true;
}

// ── beforeunload guard ───────────────────────────────────────────────────────

window.addEventListener("beforeunload", (e) => {
  if (summaryHasUnsavedChanges()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ── Button wiring ────────────────────────────────────────────────────────────

condensedInput?.addEventListener("input", updateCondensedButtons);
summaryInput?.addEventListener("input", updateSummaryButtons);

condensedRevertBtn?.addEventListener("click", () => {
  if (condensedInput) condensedInput.value = _savedCondensed;
  updateCondensedButtons();
});
condensedSaveBtn?.addEventListener("click", () => saveCondensedSummary());

summaryRevertBtn?.addEventListener("click", () => {
  if (summaryInput) summaryInput.value = _savedSummary;
  updateSummaryButtons();
});
summarySaveBtn?.addEventListener("click", () => saveMainSummary());

// ── Header icon toggle ──────────────────────────────────────────────────────

$("summary-toggle-btn")?.addEventListener("click", async () => {
  if (summaryIsOpen()) {
    if (summaryHasUnsavedChanges()) {
      const result = await openSummaryUnsavedModal();
      if (result === "cancel") return;
      if (result === "save") await saveAllUnsaved();
    }
    returnFromSummaryToChat();
  } else if (state.activeId) {
    openSummaryForConversation(state.activeId);
  }
});

// ── Sidebar hover popup for condensed summary ───────────────────────────────

let _hintPopup = null;
let _hintHideTimer = null;
let _hintLoadAbort = null;

function createSummaryPopup() {
  const popup = document.createElement("div");
  popup.className = "summary-hint-popup";
  popup.hidden = true;
  document.body.appendChild(popup);
  popup.addEventListener("mouseenter", () => clearTimeout(_hintHideTimer));
  popup.addEventListener("mouseleave", () => hideSummaryPopup());
  return popup;
}

function showSummaryPopup(anchorEl, text) {
  if (!_hintPopup) _hintPopup = createSummaryPopup();
  _hintPopup.textContent = text;
  _hintPopup.hidden = false;
  clearTimeout(_hintHideTimer);

  const r = anchorEl.getBoundingClientRect();
  const pw = _hintPopup.offsetWidth;
  const ph = _hintPopup.offsetHeight;
  let left = r.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 4;
  _hintPopup.style.left = `${left}px`;
  _hintPopup.style.top = `${top}px`;
}

function hideSummaryPopup() {
  clearTimeout(_hintHideTimer);
  _hintHideTimer = setTimeout(() => {
    if (_hintPopup) _hintPopup.hidden = true;
    if (_hintLoadAbort) { _hintLoadAbort.abort(); _hintLoadAbort = null; }
  }, 200);
}

document.addEventListener("mouseover", async (e) => {
  const hint = e.target.closest(".conv-summary-hint");
  if (!hint) return;
  const convId = hint.dataset.convId;
  if (!convId) return;

  clearTimeout(_hintHideTimer);
  if (_hintLoadAbort) _hintLoadAbort.abort();
  _hintLoadAbort = new AbortController();

  try {
    const data = await apiGetSummary(convId);
    if (_hintLoadAbort?.signal.aborted) return;
    const text = (data.condensed_summary || "").trim();
    if (text) showSummaryPopup(hint, text);
  } catch { /* aborted or network error */ }
});

document.addEventListener("mouseout", (e) => {
  const hint = e.target.closest(".conv-summary-hint");
  if (!hint) return;
  hideSummaryPopup();
});
