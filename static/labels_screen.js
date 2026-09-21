"use strict";

// ── Labels screen ─────────────────────────────────────────────────────────────
// Configure user-defined conversation labels: the on/off + display settings,
// and the label definitions (add / rename / recolour / reorder / delete). The
// bulk-label and snapshot sections of this screen live in bulk_labels.js and
// snapshots.js. The runtime label indicators/assignment/filter helpers this
// screen leans on stay centralised in app.js.
// Feature module (classic script, no bundler): shares the global `state`
// object and the helpers defined in app.js ($, apiModelState, escHtml,
// openConfirm, saveUiPreferences, loadConversations, loadFolders, and the
// runtime label helpers). Loaded after app.js in index.html; every cross-file
// reference resolves at call time (user interaction / init), so load order
// among the feature modules does not matter.

const labelsEnabledToggle = $("labels-enabled-toggle");
const labelsDisplaySelect = $("labels-display-select");
const labelAddForm = $("label-add-form");
const labelAddName = $("label-add-name");
const labelAddColor = $("label-add-color");
const labelAddError = $("label-add-error");
const labelListEl = $("label-list");


async function openLabels() {
  if (typeof summaryHasUnsavedChanges === "function" && summaryHasUnsavedChanges()) {
    const r = await openSummaryUnsavedModal();
    if (r === "cancel") return;
    if (r === "save") await saveAllUnsaved();
  }
  if (typeof closeSummaryPanel === "function") closeSummaryPanel();
  if (typeof leaveNotesForSpecialView === "function" && !(await leaveNotesForSpecialView())) return;
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
  // Open with a colour that is not already in use, for the same reason.
  refreshLabelAddColor();
  await populateBulkForm();
  loadBulkHistory();
  loadBulkRuns();
  loadSnapshots();
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
    syncLabelNameWarning();
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
    color.setAttribute("aria-label", `Colour for ${labelDisplayName(label)}`);
    color.addEventListener("change", () =>
      saveLabel(label, { color: color.value }, color),
    );

    const name = document.createElement("input");
    name.type = "text";
    name.className = "label-row-name";
    name.value = label.name || "";
    name.spellcheck = false;
    name.maxLength = 60;
    name.placeholder = "Label name (optional)";
    name.setAttribute("aria-label", "Label name");
    // Typing (or clearing) a name updates the reminder live, before the
    // change is even committed, so the user is never left guessing.
    name.addEventListener("input", () => syncLabelNameWarning());
    const commitName = () => {
      const next = name.value.trim();
      // An empty name is allowed: the label stays as a colour-only square.
      if (next === (label.name || "")) return;
      saveLabel(label, { name: next }, name);
    };
    name.addEventListener("blur", commitName);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      else if (e.key === "Escape") {
        name.value = label.name || "";
        name.blur();
      }
    });

    const count = document.createElement("span");
    count.className = "label-row-count";
    count.textContent = `${label.count} conv${label.count === 1 ? "" : "s"}`;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "label-row-btn label-row-delete";
    del.textContent = "✕";
    del.title = `Delete ${labelDisplayName(label)}`;
    del.setAttribute("aria-label", `Delete ${labelDisplayName(label)}`);
    del.addEventListener("click", () => deleteLabel(label));

    li.append(color, name, count, del, labelDragHandle(label, i));
    attachLabelRowReorder(li, label, i);
    labelListEl.appendChild(li);
  });
  syncLabelNameWarning();
  restoreLabelGrab();
}

// A label with no name still needs something to call it in menus and tooltips.
function labelDisplayName(label) {
  return String(label?.name || "").trim() || "unnamed label";
}

// The same, for a row the user picks from a list — a marker, not a sentence, so
// an unnamed label is never an empty-looking option.
function labelPickName(label) {
  return String(label?.name || "").trim() || "(unnamed)";
}

// Same idea, but for a picker where "(unnamed)" tells the user nothing useful
// to tell that square apart from another — show its colour instead.
function labelPickNameOrColor(label) {
  const name = String(label?.name || "").trim();
  return name || String(label?.color || "").trim() || "(unnamed)";
}

// "Enter labels below or no labels will be applied." — shown by the display
// dropdown whenever Square + Label is selected and at least one square still
// has no name to show. It clears itself the moment every square has a name, and
// comes back if a name is later emptied. With focus:true (a fresh switch to
// Square + Label) the cursor also lands in the topmost empty name box.
function syncLabelNameWarning(opts = {}) {
  const warn = $("labels-name-warning");
  if (!warn) return;
  const squareLabelMode =
    (labelsDisplaySelect
      ? labelsDisplaySelect.value
      : state.preferences.labelDisplay) === "square_label";
  const boxes = Array.from(labelListEl?.querySelectorAll(".label-row-name") || []);
  const empties = boxes.filter((b) => !b.value.trim());
  const show = squareLabelMode && boxes.length > 0 && empties.length > 0;
  warn.hidden = !show;
  if (show && opts.focus && empties.length === boxes.length) {
    empties[0].focus();
  }
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
    if (inputEl && "name" in patch) inputEl.value = label.name || "";
    if (inputEl && "color" in patch)
      inputEl.value = _validHexColor(label.color) ? label.color : "#888888";
    showLabelError(e.message);
  }
}

// ── Reordering the label list ────────────────────────────────────────────────
// Three ways to do the same thing, so nobody is locked out:
//   • drag the handle on the right edge of a row,
//   • click that handle to pick the row up, then click where it should go,
//   • focus the handle and use the arrow keys (Enter/Space picks up and drops,
//     Escape puts it back).
// Every move writes the new order straight away, so there is no separate
// "save" step to lose.

// The row currently picked up (by click or keyboard), by label id.
let _labelGrabbedId = null;

// Move a label to a new index and persist the order.
async function reorderLabels(fromIndex, toIndex) {
  const n = state.labelRows.length;
  if (fromIndex < 0 || fromIndex >= n) return;
  toIndex = Math.max(0, Math.min(n - 1, toIndex));
  if (toIndex === fromIndex) return;
  const rows = [...state.labelRows];
  const [moved] = rows.splice(fromIndex, 1);
  rows.splice(toIndex, 0, moved);
  const ids = rows.map((l) => l.id);
  // Show the new order at once; the server call only confirms it.
  state.labelRows = rows;
  renderLabelList();
  announceLabelOrder(moved, toIndex, n);
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
    await refreshLabelList(); // put the list back the way the server has it
  }
}

function labelIndexById(id) {
  return state.labelRows.findIndex((l) => l.id === id);
}

// Spoken feedback for a move, for anyone reordering without seeing the list.
function announceLabelOrder(label, index, total) {
  const live = $("label-reorder-live");
  if (live) {
    live.textContent = `${labelDisplayName(label)} moved to position ${index + 1} of ${total}.`;
  }
}

// The grab handle at the right edge of a row.
function labelDragHandle(label, index) {
  const h = document.createElement("button");
  h.type = "button";
  h.className = "label-row-handle";
  h.dataset.id = label.id;
  h.setAttribute("aria-pressed", _labelGrabbedId === label.id ? "true" : "false");
  h.title = "Drag to reorder — or click to pick up, then arrow keys / click a row";
  h.setAttribute(
    "aria-label",
    `Reorder ${labelDisplayName(label)}, position ${index + 1} of ${state.labelRows.length}. ` +
      "Press Enter to pick up, arrow keys to move, Enter to drop, Escape to cancel.",
  );
  // The six-dot grip that says "this drags".
  h.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<circle cx="6" cy="3.5" r="1.5"/><circle cx="10" cy="3.5" r="1.5"/>' +
    '<circle cx="6" cy="8" r="1.5"/><circle cx="10" cy="8" r="1.5"/>' +
    '<circle cx="6" cy="12.5" r="1.5"/><circle cx="10" cy="12.5" r="1.5"/></svg>';
  return h;
}

// Pick a row up / put it down (the pointer path that needs no dragging).
function toggleLabelGrab(id) {
  _labelGrabbedId = _labelGrabbedId === id ? null : id;
  paintLabelGrab();
}

function paintLabelGrab() {
  labelListEl?.querySelectorAll(".label-row").forEach((row) => {
    const on = row.dataset.id === _labelGrabbedId;
    row.classList.toggle("label-row-grabbed", on);
    row
      .querySelector(".label-row-handle")
      ?.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// After a re-render, put the picked-up state — and the keyboard focus — back on
// the row the user is moving.
function restoreLabelGrab() {
  if (!_labelGrabbedId) return;
  if (labelIndexById(_labelGrabbedId) === -1) {
    _labelGrabbedId = null;
    return;
  }
  paintLabelGrab();
  const handle = labelListEl?.querySelector(
    `.label-row.label-row-grabbed .label-row-handle`,
  );
  if (handle && document.activeElement !== handle) handle.focus();
}

// Wire one row: native drag, click-to-place, and keyboard moves.
function attachLabelRowReorder(li, label, index) {
  const handle = li.querySelector(".label-row-handle");

  // ── Native drag, started from the handle only, so the name field still
  //    behaves like a text field.
  // Only the handle arms the drag, so the name field still behaves like a text
  // field; anything that ends the gesture disarms it again.
  handle.addEventListener("pointerdown", () => (li.draggable = true));
  handle.addEventListener("pointerup", () => (li.draggable = false));
  handle.addEventListener("pointercancel", () => (li.draggable = false));
  li.addEventListener("dragend", () => {
    li.draggable = false;
    li.classList.remove("label-row-dragging");
    clearLabelDropMarks();
  });
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", label.id);
    li.classList.add("label-row-dragging");
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearLabelDropMarks();
    li.classList.add(after ? "label-drop-after" : "label-drop-before");
  });
  li.addEventListener("dragleave", () => clearLabelDropMarks());
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData("text/plain");
    clearLabelDropMarks();
    li.draggable = false;
    const from = labelIndexById(fromId);
    if (from === -1 || fromId === label.id) return;
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    let to = labelIndexById(label.id) + (after ? 1 : 0);
    if (from < to) to -= 1;
    reorderLabels(from, to);
  });

  // ── Click to pick up, then click the row it should sit at.
  handle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (_labelGrabbedId && _labelGrabbedId !== label.id) {
      const from = labelIndexById(_labelGrabbedId);
      _labelGrabbedId = null;
      reorderLabels(from, index);
      return;
    }
    toggleLabelGrab(label.id);
  });
  li.addEventListener("click", () => {
    if (!_labelGrabbedId || _labelGrabbedId === label.id) return;
    const from = labelIndexById(_labelGrabbedId);
    _labelGrabbedId = null;
    reorderLabels(from, index);
  });

  // ── Keyboard: arrows move, Enter/Space picks up and drops, Escape cancels.
  handle.addEventListener("keydown", (e) => {
    const at = labelIndexById(label.id);
    // The app-wide shortcuts also claim the arrow keys (they step through the
    // conversation list), so anything handled here is stopped here.
    if (["ArrowUp", "ArrowDown", "Enter", " ", "Escape", "Home", "End"].includes(e.key)) {
      e.stopPropagation();
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      _labelGrabbedId = label.id;
      reorderLabels(at, at + (e.key === "ArrowUp" ? -1 : 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleLabelGrab(label.id);
    } else if (e.key === "Escape" && _labelGrabbedId) {
      e.preventDefault();
      _labelGrabbedId = null;
      paintLabelGrab();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      _labelGrabbedId = label.id;
      reorderLabels(at, e.key === "Home" ? 0 : state.labelRows.length - 1);
    }
  });
}

function clearLabelDropMarks() {
  labelListEl
    ?.querySelectorAll(".label-drop-before, .label-drop-after")
    .forEach((n) => n.classList.remove("label-drop-before", "label-drop-after"));
}

async function deleteLabel(label) {
  const used = label.count > 0;
  const msg = used
    ? `Delete the label “${labelPickName(label)}”? ${label.count} conversation${
        label.count === 1 ? "" : "s"
      } currently use it and will be cleared back to blank.`
    : `Delete the label “${labelPickName(label)}”?`;
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

// ── Picking a colour for the next label ──────────────────────────────────────
// After each add, the colour box jumps to a fresh colour so someone who does
// not care about colours never has to choose one — and never gets a repeat.
// The pick is random among the candidates that sit furthest from the colours
// already in use, measured in CIE Lab, so the first few labels land in
// different colour families rather than five shades of orange.

function _hexToRgb(hex) {
  let h = String(hex || "").trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function _rgbToHex(r, g, b) {
  const p = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

function _hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// sRGB → CIE Lab (D65). Lab distance tracks how different two colours *look*,
// which plain RGB distance does not.
function _rgbToLab([r, g, b]) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function _labDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// A spread of candidate colours: 24 hues across the wheel, each at a few
// lightnesses and saturations, so "light orange" is available when plain orange
// is taken.
function _labelColorCandidates() {
  const out = [];
  for (let h = 0; h < 360; h += 15) {
    for (const [s, l] of [[0.72, 0.45], [0.62, 0.62], [0.55, 0.76], [0.85, 0.35]]) {
      out.push(_rgbToHex(..._hslToRgb(h, s, l)));
    }
  }
  return out;
}

// The next colour: furthest from everything already used, picked at random from
// the best handful so repeat adds don't march through the wheel in lockstep.
function pickDistinctLabelColor(usedHexes) {
  const used = (usedHexes || state.labelRows.map((l) => l.color))
    .map(_hexToRgb)
    .filter(Boolean)
    .map(_rgbToLab);
  const scored = _labelColorCandidates()
    .map((hex) => {
      const lab = _rgbToLab(_hexToRgb(hex));
      const nearest = used.length
        ? Math.min(...used.map((u) => _labDist(lab, u)))
        : Infinity;
      return { hex, nearest };
    })
    .sort((a, b) => b.nearest - a.nearest);
  if (!scored.length) return "#4169e1";
  // Among the roughly-equally-distant best candidates, choose at random.
  const best = scored[0].nearest;
  const pool = used.length
    ? scored.filter((c) => c.nearest >= best * 0.82)
    : scored;
  return pool[Math.floor(Math.random() * pool.length)].hex;
}

// Put a fresh, unused colour in the add form's colour box.
function refreshLabelAddColor() {
  if (labelAddColor) labelAddColor.value = pickDistinctLabelColor();
}

labelAddForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showLabelError("");
  // The name is optional — a label with none is a colour-only square.
  const name = labelAddName.value.trim();
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
    // Ready for the next one: a new name box and a colour nobody has used.
    refreshLabelAddColor();
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
  loadFolders(); // show/hide squares in the folder tree too
  if (state.activeId) renderHeaderLabel(state.activeId, state.activeLabels);
  syncLabelNameWarning();
});

labelsDisplaySelect?.addEventListener("change", () => {
  const val =
    labelsDisplaySelect.value === "square_label" ? "square_label" : "square";
  saveUiPreferences({ labelDisplay: val });
  // The display mode changes how every square renders.
  if (labelsFeatureOn()) {
    loadConversations(false);
    loadFolders();
    if (state.activeId) renderHeaderLabel(state.activeId, state.activeLabels);
  }
  // Switching to Square + Label with unnamed squares raises the reminder, and
  // puts the cursor in the first empty name box.
  syncLabelNameWarning({ focus: true });
});
