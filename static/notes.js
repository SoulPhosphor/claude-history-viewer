"use strict";

// Per-conversation Notes. The full screen deliberately follows Summary's
// explicit Save/Revert pattern. The sidebar editor writes the same three API
// fields with debounced autosave and keeps an independent first-open baseline
// for each conversation visit.
const NOTE_FIELDS = ["user_notes", "notes_to_ai", "notes_from_ai"];

let _notesConvId = null;
let _savedNotes = emptyNotes();
let _notesVisit = {
  convId: null,
  baseline: null,
  current: emptyNotes(),
  manuallyDismissed: false,
};
let _notesSideLoadToken = 0;
let _notesSideSaveQueue = Promise.resolve();
let _notesAutosaveTimers = new Map();
let _sidebarWasCollapsed = null;
let _sideWasOpenBeforeFullNotes = false;
let _notesUnsavedResolve = null;

const notesBodyEl = $("notes-body");
const notesSidePanel = $("notes-side-panel");
const notesUnsavedModal = $("notes-unsaved-modal");

function emptyNotes() {
  return { user_notes: "", notes_to_ai: "", notes_from_ai: "" };
}

function noteValues(data) {
  const out = emptyNotes();
  for (const field of NOTE_FIELDS) out[field] = String(data?.[field] || "");
  return out;
}

function fullNotesInput(field) {
  return notesBodyEl?.querySelector(`textarea[data-note-field="${field}"]`) || null;
}

function sideNotesInput(field) {
  return notesSidePanel?.querySelector(`textarea[data-note-field="${field}"]`) || null;
}

async function apiGetNotes(convId) {
  const response = await fetch(`/api/notes/${encodeURIComponent(convId)}`);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Unable to load Notes");
  return data;
}

async function apiSaveNotes(convId, fields) {
  const response = await fetch(`/api/notes/${encodeURIComponent(convId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Unable to save Notes");
  return data;
}

function notesIsOpen() {
  return !!notesBodyEl && !notesBodyEl.hidden;
}

function notesSidePanelIsOpen() {
  return !!notesSidePanel && !notesSidePanel.hidden;
}

function notesHasUnsavedChanges() {
  if (!_notesConvId) return false;
  return NOTE_FIELDS.some((field) => fullNotesInput(field)?.value !== _savedNotes[field]);
}

function updateFullNotesButtons(field = null) {
  const fields = field ? [field] : NOTE_FIELDS;
  for (const key of fields) {
    const input = fullNotesInput(key);
    const dirty = !!input && input.value !== _savedNotes[key];
    notesBodyEl?.querySelector(`.notes-full-revert[data-note-field="${key}"]`)?.toggleAttribute("disabled", !dirty);
    notesBodyEl?.querySelector(`.notes-full-save[data-note-field="${key}"]`)?.toggleAttribute("disabled", !dirty);
  }
}

function updateNotesScreenIcon(isOpen) {
  const assignment = $("notes-icon-assignment");
  const forum = $("notes-icon-forum");
  const button = $("notes-toggle-btn");
  if (!assignment || !forum || !button) return;
  assignment.toggleAttribute("hidden", isOpen);
  forum.toggleAttribute("hidden", !isOpen);
  button.title = isOpen ? "Back to chat" : "Notes";
  button.setAttribute("aria-label", isOpen ? "Back to chat" : "Open notes");
}

function updateNotesSideIcon(isOpen) {
  const openIcon = $("notes-side-icon-open");
  const closeIcon = $("notes-side-icon-close");
  const button = $("notes-side-toggle-btn");
  if (!openIcon || !closeIcon || !button) return;
  openIcon.toggleAttribute("hidden", isOpen);
  closeIcon.toggleAttribute("hidden", !isOpen);
  button.title = isOpen ? "Close notes panel" : "Open notes panel";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(isOpen));
}

function setFullNotesValues(values) {
  _savedNotes = noteValues(values);
  for (const field of NOTE_FIELDS) {
    const input = fullNotesInput(field);
    if (input) input.value = _savedNotes[field];
  }
  updateFullNotesButtons();
}

function setSideNotesValues(values) {
  _notesVisit.current = noteValues(values);
  for (const field of NOTE_FIELDS) {
    const input = sideNotesInput(field);
    if (input) input.value = _notesVisit.current[field];
  }
}

function queueSideSave(field, value) {
  const convId = _notesVisit.convId;
  if (!convId) return _notesSideSaveQueue;
  _notesVisit.current[field] = value;
  _notesSideSaveQueue = _notesSideSaveQueue
    .catch(() => {})
    .then(async () => {
      const result = await apiSaveNotes(convId, { [field]: value });
      // Keep the full screen in sync when it is not holding its own unsaved edit.
      if (_notesConvId === convId) {
        const input = fullNotesInput(field);
        if (input && input.value === _savedNotes[field]) input.value = value;
        _savedNotes[field] = value;
        updateFullNotesButtons(field);
      }
      return result;
    });
  return _notesSideSaveQueue;
}

function scheduleSideAutosave(field, value) {
  const old = _notesAutosaveTimers.get(field);
  if (old) clearTimeout(old);
  _notesAutosaveTimers.set(field, setTimeout(() => {
    _notesAutosaveTimers.delete(field);
    queueSideSave(field, value);
  }, 350));
}

async function flushNotesSideAutosaves() {
  for (const [field, timer] of _notesAutosaveTimers.entries()) {
    clearTimeout(timer);
    _notesAutosaveTimers.delete(field);
    const input = sideNotesInput(field);
    if (input) queueSideSave(field, input.value);
  }
  await _notesSideSaveQueue.catch(() => {});
}

function restoreSidebarCollapsedState() {
  if (_sidebarWasCollapsed === null) return;
  document.body.classList.toggle("sidebar-collapsed", _sidebarWasCollapsed);
  _sidebarWasCollapsed = null;
}

async function hideNotesSidePanel({ manual = false, restoreSidebar = true } = {}) {
  if (manual && _notesVisit.convId === state.activeId) {
    _notesVisit.manuallyDismissed = true;
  }
  await flushNotesSideAutosaves();
  if (notesSidePanel) notesSidePanel.hidden = true;
  updateNotesSideIcon(false);
  if (restoreSidebar) restoreSidebarCollapsedState();
}

async function openNotesSidePanel() {
  const convId = state.activeId;
  if (!convId) return;
  if (_notesVisit.convId !== convId) await beginNotesConversationVisit(convId);
  if (_sidebarWasCollapsed === null) {
    _sidebarWasCollapsed = document.body.classList.contains("sidebar-collapsed");
  }
  document.body.classList.remove("sidebar-collapsed");
  if (typeof raiseSidebarOverlay === "function") raiseSidebarOverlay(notesSidePanel);
  notesSidePanel.hidden = false;
  updateNotesSideIcon(true);

  if (_notesVisit.baseline === null) {
    const token = ++_notesSideLoadToken;
    let data;
    try {
      data = await apiGetNotes(convId);
    } catch (_) {
      if (token === _notesSideLoadToken) {
        notesSidePanel.hidden = true;
        updateNotesSideIcon(false);
        restoreSidebarCollapsedState();
      }
      return;
    }
    if (token !== _notesSideLoadToken || _notesVisit.convId !== convId) return;
    const values = noteValues(data);
    _notesVisit.baseline = { ...values };
    setSideNotesValues(values);
  } else {
    setSideNotesValues(_notesVisit.current);
  }
}

async function beginNotesConversationVisit(convId) {
  if (_notesVisit.convId === convId) return;
  _notesSideLoadToken += 1;
  await hideNotesSidePanel({ manual: false });
  _notesVisit = {
    convId,
    baseline: null,
    current: emptyNotes(),
    manuallyDismissed: false,
  };
  _sideWasOpenBeforeFullNotes = false;
}

async function finishOpeningNotesConversationVisit(convId) {
  if (_notesVisit.convId !== convId) return;
  if (state.preferences.autoOpenNotesPanel && !_notesVisit.manuallyDismissed) {
    await openNotesSidePanel();
  }
}

async function saveFullNote(field) {
  if (!_notesConvId || !NOTE_FIELDS.includes(field)) return;
  const input = fullNotesInput(field);
  if (!input) return;
  const value = input.value;
  await apiSaveNotes(_notesConvId, { [field]: value });
  _savedNotes[field] = value;
  if (_notesVisit.convId === _notesConvId) {
    const timer = _notesAutosaveTimers.get(field);
    if (timer) clearTimeout(timer);
    _notesAutosaveTimers.delete(field);
    _notesVisit.current[field] = value;
    const sideInput = sideNotesInput(field);
    if (sideInput) sideInput.value = value;
  }
  updateFullNotesButtons(field);
}

async function saveAllUnsavedNotes() {
  if (!_notesConvId) return;
  const fields = {};
  for (const field of NOTE_FIELDS) {
    const input = fullNotesInput(field);
    if (input && input.value !== _savedNotes[field]) fields[field] = input.value;
  }
  if (!Object.keys(fields).length) return;
  await apiSaveNotes(_notesConvId, fields);
  for (const [field, value] of Object.entries(fields)) {
    _savedNotes[field] = value;
    if (_notesVisit.convId === _notesConvId) {
      _notesVisit.current[field] = value;
      const sideInput = sideNotesInput(field);
      if (sideInput) sideInput.value = value;
    }
  }
  updateFullNotesButtons();
}

function revertFullNote(field) {
  const input = fullNotesInput(field);
  if (!input || !NOTE_FIELDS.includes(field)) return;
  input.value = _savedNotes[field];
  updateFullNotesButtons(field);
}

async function revertSideNote(field) {
  if (!_notesVisit.baseline || !NOTE_FIELDS.includes(field)) return;
  const value = _notesVisit.baseline[field];
  const timer = _notesAutosaveTimers.get(field);
  if (timer) clearTimeout(timer);
  _notesAutosaveTimers.delete(field);
  const input = sideNotesInput(field);
  if (input) input.value = value;
  await queueSideSave(field, value);
}

async function openNotesForConversation(convId) {
  if (!convId) return;
  if (typeof summaryHasUnsavedChanges === "function" && summaryHasUnsavedChanges()) {
    const result = await openSummaryUnsavedModal();
    if (result === "cancel") return;
    if (result === "save") await saveAllUnsaved();
  }
  if (typeof closeSummaryPanel === "function") closeSummaryPanel();
  if (state.activeId !== convId) await openConversation(convId, findConvItemEl(convId));
  if (state.activeId !== convId) return;
  _notesConvId = convId;
  _sideWasOpenBeforeFullNotes = notesSidePanelIsOpen();
  if (_sideWasOpenBeforeFullNotes) {
    await hideNotesSidePanel({ manual: false, restoreSidebar: false });
  }
  if (messagesEl) messagesEl.hidden = true;
  if (notesBodyEl) notesBodyEl.hidden = false;
  updateNotesScreenIcon(true);
  try {
    const data = await apiGetNotes(convId);
    setFullNotesValues(data);
  } catch (_) {
    await closeNotesScreen();
  }
}

async function closeNotesScreen({ restoreSide = true } = {}) {
  _notesConvId = null;
  if (notesBodyEl) notesBodyEl.hidden = true;
  if (messagesEl) messagesEl.hidden = false;
  updateNotesScreenIcon(false);
  if (restoreSide && _sideWasOpenBeforeFullNotes && !_notesVisit.manuallyDismissed) {
    _sideWasOpenBeforeFullNotes = false;
    await openNotesSidePanel();
  } else {
    _sideWasOpenBeforeFullNotes = false;
    restoreSidebarCollapsedState();
  }
}

async function endNotesConversationVisit() {
  _notesSideLoadToken += 1;
  await hideNotesSidePanel({ manual: false });
  _notesVisit = {
    convId: null,
    baseline: null,
    current: emptyNotes(),
    manuallyDismissed: false,
  };
  _sideWasOpenBeforeFullNotes = false;
}

async function notesNavigationGuard({ endVisit = false } = {}) {
  if (notesHasUnsavedChanges()) {
    const result = await openNotesUnsavedModal();
    if (result === "cancel") return false;
    if (result === "save") await saveAllUnsavedNotes();
  }
  if (notesIsOpen()) await closeNotesScreen({ restoreSide: !endVisit });
  if (endVisit) await endNotesConversationVisit();
  return true;
}

function openNotesUnsavedModal() {
  return new Promise((resolve) => {
    _notesUnsavedResolve = resolve;
    if (notesUnsavedModal) notesUnsavedModal.hidden = false;
  });
}

function closeNotesUnsavedModal(result) {
  if (notesUnsavedModal) notesUnsavedModal.hidden = true;
  if (_notesUnsavedResolve) {
    _notesUnsavedResolve(result);
    _notesUnsavedResolve = null;
  }
}

notesBodyEl?.addEventListener("input", (event) => {
  const input = event.target.closest("textarea[data-note-field]");
  if (input) updateFullNotesButtons(input.dataset.noteField);
});
notesBodyEl?.addEventListener("click", (event) => {
  const save = event.target.closest(".notes-full-save[data-note-field]");
  const revert = event.target.closest(".notes-full-revert[data-note-field]");
  if (save) saveFullNote(save.dataset.noteField);
  else if (revert) revertFullNote(revert.dataset.noteField);
});

notesSidePanel?.addEventListener("input", (event) => {
  const input = event.target.closest("textarea[data-note-field]");
  if (!input) return;
  _notesVisit.current[input.dataset.noteField] = input.value;
  scheduleSideAutosave(input.dataset.noteField, input.value);
});
notesSidePanel?.addEventListener("click", (event) => {
  const button = event.target.closest(".notes-side-revert[data-note-field]");
  if (button) revertSideNote(button.dataset.noteField);
});

$("notes-side-toggle-btn")?.addEventListener("click", () => {
  if (notesSidePanelIsOpen()) hideNotesSidePanel({ manual: true });
  else openNotesSidePanel();
});
$("notes-side-panel-close")?.addEventListener("click", () => hideNotesSidePanel({ manual: true }));

$("notes-toggle-btn")?.addEventListener("click", async () => {
  if (notesIsOpen()) {
    if (notesHasUnsavedChanges()) {
      const result = await openNotesUnsavedModal();
      if (result === "cancel") return;
      if (result === "save") await saveAllUnsavedNotes();
    }
    await closeNotesScreen();
  } else if (state.activeId) {
    await openNotesForConversation(state.activeId);
  }
});

$("notes-unsaved-cancel")?.addEventListener("click", () => closeNotesUnsavedModal("cancel"));
$("notes-unsaved-save")?.addEventListener("click", () => closeNotesUnsavedModal("save"));
notesUnsavedModal?.addEventListener("click", (event) => {
  if (event.target === notesUnsavedModal) closeNotesUnsavedModal("cancel");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && notesUnsavedModal && !notesUnsavedModal.hidden) {
    closeNotesUnsavedModal("cancel");
  }
});

window.addEventListener("beforeunload", (event) => {
  if (notesHasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
  flushNotesSideAutosaves();
});
