"use strict";

// ── Manual safety snapshots (Labels screen · section D) ───────────────────────
// Feature module (classic script, no bundler): shares the global `state`
// object and helpers ($, apiModelState, escHtml, openConfirm, _validHexColor,
// saveUiPreferences, loadConversations, loadFolders, and the runtime label
// helpers) defined in app.js. Loaded after app.js in index.html; every
// cross-file reference resolves at call time (user interaction / init), so
// load order among the feature modules does not matter.

const snapshotNameInput = $("snapshot-name");
const snapshotCreateBtn = $("snapshot-create-btn");
const snapshotErrorEl = $("snapshot-error");
const snapshotTableBody = $("snapshot-table-body");

// ── Manual safety snapshots (Labels screen · section D) ───────────────────────
// Snapshots capture user-owned metadata only and are made solely by pressing
// Create Snapshot. Restore is category-selectable and reversible; there is a
// hard cap of 10 (the user deletes one to make room — never auto-removed).

// Category keys ↔ labels, in the order the restore dialog shows them.
const SNAPSHOT_CATS = [
  ["labels", "Labels"],
  ["folders", "Folders"],
  ["tags", "Tags"],
  ["titles", "Titles"],
  ["meta_state", "Archive/Delete state"],
  ["pins", "Pins"],
];
// Map the per-category counts in a snapshot's summary to a readable Contents cell.
const SNAPSHOT_CONTENT_PARTS = [
  ["labels", "label", "labels"],
  ["label_assignments", "assignment", "assignments"],
  ["folders", "folder", "folders"],
  ["folder_items", "folder item", "folder items"],
  ["tags", "tag", "tags"],
  ["titles", "title", "titles"],
  ["meta_state", "archive/delete", "archive/delete"],
  ["pins", "pin", "pins"],
];
let _snapshotMax = 10;

function showSnapshotError(msg) {
  if (!snapshotErrorEl) return;
  snapshotErrorEl.textContent = msg || "";
  snapshotErrorEl.hidden = !msg;
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function snapshotContents(summary) {
  const parts = [];
  for (const [key, one, many] of SNAPSHOT_CONTENT_PARTS) {
    const c = Number(summary?.[key]) || 0;
    if (c > 0) parts.push(`${c} ${c === 1 ? one : many}`);
  }
  return parts.length ? parts.join(", ") : "Nothing captured";
}

async function loadSnapshots() {
  if (!snapshotTableBody) return;
  let data = { snapshots: [], max: 10 };
  try {
    data = await apiModelState("/api/snapshots");
  } catch (_) {}
  _snapshotMax = data.max || 10;
  const snaps = data.snapshots || [];
  // At the cap, explain why Create is disabled (we never auto-delete the oldest).
  const atMax = snaps.length >= _snapshotMax;
  if (snapshotCreateBtn) snapshotCreateBtn.disabled = atMax;
  showSnapshotError(
    atMax
      ? `Maximum of ${_snapshotMax} snapshots reached. Delete a snapshot before creating another.`
      : "",
  );
  snapshotTableBody.innerHTML = "";
  if (!snaps.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="no-results">No snapshots yet.</td>';
    snapshotTableBody.appendChild(tr);
    return;
  }
  for (const s of snaps) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "snapshot-name-cell";
    name.textContent = s.name || "(unnamed)";
    const created = document.createElement("td");
    created.textContent = s.created_at
      ? new Date(s.created_at * 1000).toLocaleString([], {
          month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit",
        })
      : "";
    const contents = document.createElement("td");
    contents.className = "snapshot-contents-cell";
    contents.textContent = snapshotContents(s.summary);
    const size = document.createElement("td");
    size.textContent = `${(s.item_count ?? 0).toLocaleString()} · ${formatBytes(s.payload_size)}`;
    const actions = document.createElement("td");
    actions.className = "snapshot-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "snapshot-btn";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => openRestoreDialog(s));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "snapshot-btn snapshot-btn-danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteSnapshot(s));
    actions.append(restore, del);
    tr.append(name, created, contents, size, actions);
    snapshotTableBody.appendChild(tr);
  }
}

async function createSnapshot() {
  showSnapshotError("");
  const name = (snapshotNameInput?.value || "").trim();
  try {
    await apiModelState("/api/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (snapshotNameInput) snapshotNameInput.value = "";
  } catch (e) {
    showSnapshotError(e.message);
  }
  loadSnapshots();
}

async function deleteSnapshot(s) {
  const ok = await openConfirm({
    title: "Delete snapshot?",
    text: `Delete the snapshot “${s.name || "(unnamed)"}”? This cannot be undone.`,
    okLabel: "Delete snapshot",
  });
  if (!ok) return;
  try {
    await apiModelState(`/api/snapshots/${encodeURIComponent(s.id)}`, { method: "DELETE" });
  } catch (e) {
    showSnapshotError(e.message);
  }
  loadSnapshots();
}

// ── Restore category dialog ───────────────────────────────────────────────────
const snapshotRestoreModal = $("snapshot-restore-modal");
const snapshotRestoreCats = $("snapshot-restore-cats");
const snapshotRestoreOk = $("snapshot-restore-ok");
const snapshotRestoreCancel = $("snapshot-restore-cancel");
let _restoreTarget = null;

function openRestoreDialog(s) {
  _restoreTarget = s;
  if (!snapshotRestoreModal || !snapshotRestoreCats) return;
  snapshotRestoreCats.innerHTML = "";
  for (const [key, label] of SNAPSHOT_CATS) {
    const row = document.createElement("label");
    row.className = "snapshot-cat";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = key;
    cb.checked = true; // default: all supported categories checked
    const span = document.createElement("span");
    span.textContent = label;
    row.append(cb, span);
    snapshotRestoreCats.appendChild(row);
  }
  snapshotRestoreModal.hidden = false;
}

function closeRestoreDialog() {
  if (snapshotRestoreModal) snapshotRestoreModal.hidden = true;
  _restoreTarget = null;
}

async function confirmRestore() {
  if (!_restoreTarget) return;
  const s = _restoreTarget;
  const selected = [...snapshotRestoreCats.querySelectorAll("input:checked")].map(
    (c) => c.value,
  );
  if (!selected.length) {
    showSnapshotError("Select at least one category to restore.");
    return;
  }
  closeRestoreDialog();
  showSnapshotError("");
  let res;
  try {
    res = await apiModelState(`/api/snapshots/${encodeURIComponent(s.id)}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories: selected }),
    });
  } catch (e) {
    showSnapshotError(e.message);
    return;
  }
  const skippedNote =
    res.skipped > 0
      ? ` ${res.skipped} record${res.skipped === 1 ? "" : "s"} skipped (conversation no longer present).`
      : "";
  showSnapshotError(""); // clear any cap message; show a transient success below
  if (snapshotErrorEl) {
    snapshotErrorEl.textContent = `Restored ${selected.length} categor${selected.length === 1 ? "y" : "ies"} from “${s.name}”.${skippedNote}`;
    snapshotErrorEl.hidden = false;
    snapshotErrorEl.classList.add("snapshot-ok");
    setTimeout(() => {
      if (snapshotErrorEl) {
        snapshotErrorEl.classList.remove("snapshot-ok");
        snapshotErrorEl.hidden = true;
      }
    }, 6000);
  }
  // A restore can change everything the sidebar shows — reload it all.
  await loadLabelDefs();
  renderLabelList();
  onLabelDefsChanged();
  await refreshPinnedList();
  loadBulkHistory();
  loadSnapshots();
  // A restore can change the open conversation's assignment outright — re-read
  // it from the server rather than guessing from the label definitions.
  refreshActiveHeaderLabel();
}

snapshotCreateBtn?.addEventListener("click", createSnapshot);
snapshotRestoreCancel?.addEventListener("click", closeRestoreDialog);
snapshotRestoreOk?.addEventListener("click", confirmRestore);
snapshotRestoreModal?.addEventListener("mousedown", (e) => {
  if (e.target === snapshotRestoreModal) closeRestoreDialog();
});
