"use strict";

// ── Conditional bulk labeling (Labels screen · sections C & D) ────────────────
// Feature module (classic script, no bundler): shares the global `state`
// object and helpers ($, apiModelState, escHtml, openConfirm, _validHexColor,
// saveUiPreferences, loadConversations, loadFolders, and the runtime label
// helpers) defined in app.js. Loaded after app.js in index.html; every
// cross-file reference resolves at call time (user interaction / init), so
// load order among the feature modules does not matter.

const bulkResultEl = $("bulk-result");
const bulkErrorEl = $("bulk-error");
const bulkPreviewBtn = $("bulk-preview-btn");
const bulkApplyBtn = $("bulk-apply-btn");
const bulkHistoryList = $("bulk-history-list");
const bulkRetentionInput = $("bulk-retention");

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
  const notAlready = data.target_blank
    ? `<strong>${data.not_already.toLocaleString()}</strong> are not already blank.`
    : `<strong>${data.not_already.toLocaleString()}</strong> are not already set to “${escHtml(target)}”.`;
  // "the first N" only when a first-N limit actually caps the changeable set.
  const capped = data.limit_n != null && data.will_change < data.not_already;
  const willChange = capped
    ? `This operation will change the first <strong>${data.will_change.toLocaleString()}</strong>.`
    : `This operation will change <strong>${data.will_change.toLocaleString()}</strong>.`;
  bulkResultEl.innerHTML =
    `<div>${data.eligible.toLocaleString()} conversation${data.eligible === 1 ? "" : "s"} match these conditions.</div>` +
    `<div>${notAlready}</div>` +
    `<div>${willChange}</div>`;
  bulkResultEl.hidden = false;
  _bulkPreviewed = { crit, data };
  bulkApplyBtn.disabled = data.will_change === 0;
}

async function bulkApply() {
  if (!_bulkPreviewed) return;
  const { crit, data } = _bulkPreviewed;
  const target = data.target_label_name || "Blank";
  const ok = await openConfirm({
    title: "Apply label to batch?",
    text:
      `Set label to “${target}” on ${data.will_change.toLocaleString()} conversation` +
      `${data.will_change === 1 ? "" : "s"} (${data.eligible.toLocaleString()} matched). ` +
      "This is not undoable — make a Safety Snapshot first if you want a recovery point.",
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
    `Applied: <strong>${res.changed.toLocaleString()}</strong> changed ` +
    `(${res.eligible.toLocaleString()} matched).`;
  bulkResultEl.hidden = false;
  invalidateBulkPreview();
  // Refresh label counts, sidebar squares, the filter, and the history list.
  await loadLabelDefs();
  renderLabelList();
  onLabelDefsChanged();
  // The open conversation may have been in the batch — re-read its assignment.
  refreshActiveHeaderLabel();
  loadBulkHistory();
}

async function loadBulkHistory() {
  if (!bulkHistoryList) return;
  let hist = [];
  try {
    const d = await apiModelState("/api/labels/bulk-history");
    hist = d.history || [];
    if (d.retention != null && bulkRetentionInput)
      bulkRetentionInput.value = d.retention;
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

    // Line 1 — when.
    const when = document.createElement("div");
    when.className = "bulk-history-when";
    when.textContent = h.created_at
      ? new Date(h.created_at * 1000).toLocaleString([], {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        })
      : "";
    // Line 2 — the stored execution-time filter/order summary.
    const crit = document.createElement("div");
    crit.className = "bulk-history-crit";
    crit.textContent = h.description || "(bulk change)";
    // Line 3 — limit → target (using the execution-time target name).
    const action = document.createElement("div");
    action.className = "bulk-history-action";
    const limitText = h.limit_used ? `First ${h.limit_used}` : "All matching";
    action.textContent = `${limitText} → ${h.target_label_name || "Blank"}`;
    // Line 4 — how many actually changed.
    const changed = document.createElement("div");
    changed.className = "bulk-history-changed";
    changed.textContent = `${(h.changed_count ?? 0).toLocaleString()} changed`;

    main.append(when, crit, action, changed);

    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.className = "bulk-history-reuse";
    reuse.textContent = "Use Again";
    reuse.title = "Load this selection into the tool above (you still Preview and Apply)";
    reuse.addEventListener("click", () => reuseBulkCriteria(h.criteria || {}));
    li.append(main, reuse);
    bulkHistoryList.appendChild(li);
  }
}

async function saveBulkRetention() {
  if (!bulkRetentionInput) return;
  let n = parseInt(bulkRetentionInput.value, 10);
  if (!Number.isFinite(n)) n = 5;
  n = Math.max(0, Math.min(50, n));
  bulkRetentionInput.value = n;
  try {
    const d = await apiModelState("/api/labels/bulk-history/retention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention: n }),
    });
    if (d.retention != null) bulkRetentionInput.value = d.retention;
    loadBulkHistory();
  } catch (_) {}
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
bulkRetentionInput?.addEventListener("change", saveBulkRetention);
