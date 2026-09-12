"use strict";

// ── Labels screen ─────────────────────────────────────────────────────────────
// Configure user-defined conversation labels: the on/off + display settings,
// and the label definitions (add / rename / recolour / reorder / delete). The
// bulk-label and snapshot sections of this screen live in bulk_labels.js and
// snapshots.js. The runtime label indicators/assignment/filter helpers this
// screen leans on stay centralised in app.js.
// Feature module (classic script, no bundler): shares the global `state`
// object and helpers ($, apiModelState, escHtml, openConfirm, _validHexColor,
// saveUiPreferences, loadConversations, loadFolders, and the runtime label
// helpers) defined in app.js. Loaded after app.js in index.html; every
// cross-file reference resolves at call time (user interaction / init), so
// load order among the feature modules does not matter.

const labelsEnabledToggle = $("labels-enabled-toggle");
const labelsDisplaySelect = $("labels-display-select");
const labelAddForm = $("label-add-form");
const labelAddName = $("label-add-name");
const labelAddColor = $("label-add-color");
const labelAddError = $("label-add-error");
const labelListEl = $("label-list");

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
  loadFolders(); // show/hide squares in the folder tree too
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
