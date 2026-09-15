"use strict";

// Feature module (classic script, no bundler): shares the global `state`
// object and the helpers defined in app.js ($, apiModelState, escHtml,
// openConfirm, saveUiPreferences, loadConversations, loadFolders, and the
// runtime label helpers). Loaded after app.js in index.html; every cross-file
// reference resolves at call time (user interaction / init), so load order
// among the feature modules does not matter.

const bulkResultEl = $("bulk-result");
const bulkErrorEl = $("bulk-error");
const bulkPreviewBtn = $("bulk-preview-btn");
const bulkApplyBtn = $("bulk-apply-btn");
const bulkHistoryList = $("bulk-history-list");
const bulkRetentionInput = $("bulk-retention");
const bulkRunsTableBody = $("bulk-runs-table-body");
const bulkRunsErrorEl = $("bulk-runs-error");

// ── Conditional bulk labeling (Labels screen · sections C & D) ────────────────
// A narrow tool: pick conversations by criteria (all ANDed) and Add, Remove,
// or Clear a set of labels on them. It never deletes/archives/moves. Preview
// before Apply; every applied change is logged to Recent Bulk Changes for
// reuse (not undo) — or, if a "First N" limit doesn't cover everything
// eligible, saved as an Unfinished Label Run instead (see the run functions
// further down) until it's carried to completion.

let _bulkPreviewed = null; // {crit, data} captured on a successful preview

function showBulkError(msg) {
  if (!bulkErrorEl) return;
  bulkErrorEl.textContent = msg || "";
  bulkErrorEl.hidden = !msg;
}

// A criteria change makes the standing numbers stale. Apply is never gated on
// having previewed — it re-reads the criteria itself — so this only clears the
// readout and drops the temporary list filter.
function invalidateBulkPreview() {
  _bulkPreviewed = null;
  if (bulkResultEl) bulkResultEl.hidden = true;
  exitBulkPreview();
}

// The sidebar banner that says the list is showing a previewed batch.
function syncBulkPreviewBanner() {
  const banner = $("bulk-preview-banner");
  const clearBtn = $("bulk-preview-clear-btn");
  if (clearBtn) clearBtn.hidden = !state.bulkPreview;
  if (!banner) return;
  if (!state.bulkPreview) {
    banner.hidden = true;
    return;
  }
  const n = state.bulkPreview.data?.will_change ?? 0;
  const summary = state.bulkPreview.data?.action_summary || "(bulk change)";
  const txt = $("bulk-preview-banner-text");
  if (txt) {
    txt.textContent =
      `Preview: ${n.toLocaleString()} conversation${n === 1 ? "" : "s"} ` +
      `this run would apply “${summary}” to.`;
  }
  banner.hidden = false;
}

// Leave preview mode and put the normal list back.
function exitBulkPreview(opts = {}) {
  if (!state.bulkPreview) {
    syncBulkPreviewBanner();
    return;
  }
  state.bulkPreview = null;
  syncBulkPreviewBanner();
  updateListSectionTitle();
  if (opts.reload !== false) loadConversations(false);
}

// ── Bulk-criteria chip rows (Current label / Folder / Tag / Keyword) ──────────
// Each row reads "Label [chip ×] [chip ×] [+]" all on one line: multiple chips
// in the same row are OR'd together (different rows still AND). Selecting a
// value adds it as a chip immediately; the "+" then reappears to add another.
// Labels/folders pick from a live dropdown; tags/keywords are free text.

// { value, name } per selected chip. `value` is what the server understands
// (a label/folder id, "blank"/"none", or the raw tag/keyword text); `name` is
// what the chip displays.
const bulkChipState = { labels: [], folders: [], tags: [], keywords: [], targetLabels: [] };

// Element ids for a chip row's container/label don't all follow the plain
// `bulk-${kind}-*` template (targetLabels' HTML ids use a hyphen).
const BULK_CHIP_DOM_KIND = { targetLabels: "target-labels" };
function bulkChipElId(kind, suffix) {
  return `bulk-${BULK_CHIP_DOM_KIND[kind] || kind}-${suffix}`;
}

function bulkChipOptions(kind) {
  if (kind === "labels") {
    return [{ value: "blank", label: "Blank" }].concat(
      orderedLabels().map((l) => ({ value: l.id, label: labelPickName(l) })),
    );
  }
  if (kind === "targetLabels") {
    // "Which labels it should apply to" — always offers "All"; an unnamed
    // label shows its colour (as text, and as a swatch on the option) instead
    // of a blank/placeholder row.
    return [{ value: "all", label: "All" }].concat(
      orderedLabels().map((l) => ({
        value: l.id,
        label: labelPickNameOrColor(l),
        swatch: String(l.name || "").trim() ? null : l.color,
      })),
    );
  }
  if (kind === "folders") {
    return [{ value: "none", label: "No folder" }].concat(
      (state.bulkFolderOptions || []).map((f) => ({ value: f.id, label: f.name })),
    );
  }
  return [];
}

function renderBulkChipRow(kind) {
  const container = $(bulkChipElId(kind, "chips"));
  if (!container) return;
  container.innerHTML = "";
  for (const chip of bulkChipState[kind]) {
    const el = document.createElement("span");
    el.className = "tag-chip";
    const name = document.createElement("span");
    name.className = "tag-chip-name";
    name.textContent = chip.name;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tag-chip-x";
    x.title = `Remove ${chip.name}`;
    x.setAttribute("aria-label", `Remove ${chip.name}`);
    x.textContent = "✕";
    x.addEventListener("click", () => removeBulkChip(kind, chip.value));
    el.append(name, x);
    container.appendChild(el);
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "tag-add-btn";
  addBtn.title = `Add ${kind}`;
  addBtn.setAttribute("aria-label", `Add ${kind}`);
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => showBulkChipPicker(kind, addBtn));
  container.appendChild(addBtn);
}

function addBulkChip(kind, value, name) {
  if (bulkChipState[kind].some((c) => c.value === value)) {
    renderBulkChipRow(kind);
    return;
  }
  bulkChipState[kind].push({ value, name });
  renderBulkChipRow(kind);
  invalidateBulkPreview();
}

function removeBulkChip(kind, value) {
  bulkChipState[kind] = bulkChipState[kind].filter((c) => c.value !== value);
  renderBulkChipRow(kind);
  invalidateBulkPreview();
}

// "+" clicked: for Current label/Folder, swap it for a <select> of the
// remaining options; for Tag/Keyword, swap it for a text input.
function showBulkChipPicker(kind, addBtn) {
  if (kind === "tags" || kind === "keywords") {
    showBulkChipTextPicker(kind, addBtn);
    return;
  }
  const used = new Set(bulkChipState[kind].map((c) => c.value));
  const opts = bulkChipOptions(kind).filter((o) => !used.has(o.value));
  const sel = document.createElement("select");
  sel.className = "bulk-chip-picker";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  placeholder.disabled = true;
  placeholder.selected = true;
  sel.appendChild(placeholder);
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    // An unnamed label's option shows its colour as a swatch too, not just
    // as text, where the browser renders option background colours.
    if (o.swatch) {
      opt.style.backgroundColor = o.swatch;
      opt.style.color = "#fff";
    }
    sel.appendChild(opt);
  }
  addBtn.replaceWith(sel);
  sel.focus();
  if (typeof sel.showPicker === "function") {
    try { sel.showPicker(); } catch (_) {}
  }
  let settled = false;
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    settled = true;
    const chosen = opts.find((o) => o.value === sel.value);
    addBulkChip(kind, sel.value, chosen ? chosen.label : sel.value);
  });
  sel.addEventListener("blur", () => {
    if (settled) return;
    renderBulkChipRow(kind);
  });
}

async function showBulkChipTextPicker(kind, addBtn) {
  const form = document.createElement("form");
  form.className = "tag-add-form";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tag-add-input";
  input.spellcheck = false;
  input.placeholder = kind === "tags" ? "Tag name" : "Keyword";
  if (kind === "tags") {
    input.setAttribute("list", "bulk-tag-suggestions");
    if (!$("bulk-tag-suggestions")) {
      const datalist = document.createElement("datalist");
      datalist.id = "bulk-tag-suggestions";
      document.body.appendChild(datalist);
    }
    const datalist = $("bulk-tag-suggestions");
    datalist.innerHTML = "";
    const used = new Set(bulkChipState.tags.map((c) => c.value));
    for (const t of state.bulkTagOptions || []) {
      if (used.has(t)) continue;
      const opt = document.createElement("option");
      opt.value = t;
      datalist.appendChild(opt);
    }
  }
  form.appendChild(input);
  addBtn.replaceWith(form);
  input.focus();

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    const val = input.value.trim();
    if (val) addBulkChip(kind, val, val);
    else renderBulkChipRow(kind);
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    finish();
  });
  input.addEventListener("blur", finish);
}

// Show/hide "Which labels it should apply to" — irrelevant once Cleared is
// picked, since clearing always wipes every label the batch carries.
function syncBulkTargetLabelsVisibility() {
  const row = $("bulk-target-labels-row");
  if (row) row.hidden = $("bulk-label-action")?.value === "cleared";
}

// Drop/refresh the "Current label" and "Which labels it should apply to"
// chips against live label defs (a deleted label can no longer filter or be
// targeted; a renamed one shows its new name/colour). Rebuild only — no
// network — used when definitions change while the screen is open.
function refreshBulkLabelSelects() {
  const byId = new Map(orderedLabels().map((l) => [l.id, l]));
  bulkChipState.labels = bulkChipState.labels
    .filter((c) => c.value === "blank" || byId.has(c.value))
    .map((c) =>
      c.value === "blank" ? c : { value: c.value, name: labelPickName(byId.get(c.value)) },
    );
  renderBulkChipRow("labels");

  bulkChipState.targetLabels = bulkChipState.targetLabels
    .filter((c) => c.value === "all" || byId.has(c.value))
    .map((c) =>
      c.value === "all"
        ? c
        : { value: c.value, name: labelPickNameOrColor(byId.get(c.value)) },
    );
  renderBulkChipRow("targetLabels");
}

async function populateBulkForm() {
  refreshBulkLabelSelects();

  let folders = [];
  try {
    const d = await (await fetch("/api/folders")).json();
    folders = d.folders || [];
  } catch (_) {}
  state.bulkFolderOptions = folders;
  const folderById = new Map(folders.map((f) => [f.id, f]));
  bulkChipState.folders = bulkChipState.folders
    .filter((c) => c.value === "none" || folderById.has(c.value))
    .map((c) =>
      c.value === "none" ? c : { value: c.value, name: folderById.get(c.value).name },
    );
  renderBulkChipRow("folders");

  let tags = [];
  try {
    const d = await (await fetch("/api/tags")).json();
    tags = d.tags || [];
  } catch (_) {}
  state.bulkTagOptions = tags;
  renderBulkChipRow("tags");
  renderBulkChipRow("keywords");
  syncBulkTargetLabelsVisibility();
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
    labels: bulkChipState.labels.map((c) => c.value),
    folders: bulkChipState.folders.map((c) => c.value),
    tags: bulkChipState.tags.map((c) => c.value),
    keywords: bulkChipState.keywords.map((c) => c.value),
    order: $("bulk-order")?.value || "started_asc",
    limit:
      limitMode === "first"
        ? { mode: "first", n: Math.max(1, parseInt($("bulk-limit-n")?.value, 10) || 1) }
        : { mode: "all" },
    label_action: $("bulk-label-action")?.value || "added",
    label_targets: bulkChipState.targetLabels.map((c) => c.value),
  };
}

function validateBulkCriteria(crit) {
  for (const [spec, name] of [
    [crit.started, "Started"],
    [crit.ended, "Last Message"],
  ]) {
    if ((spec.op === "before" || spec.op === "after") && !spec.date)
      return `${name}: choose a date.`;
    if (spec.op === "between" && (!spec.date || !spec.date2))
      return `${name}: choose both dates.`;
  }
  if (crit.limit.mode === "first" && (!crit.limit.n || crit.limit.n < 1))
    return "Limit: enter a positive number.";
  if (crit.label_action !== "cleared" && crit.label_targets.length === 0)
    return "Which labels it should apply to: choose at least one label, or All.";
  return null;
}

// Read the criteria, validate, and ask the server what this run would do.
// Returns {crit, data} or null (the error is already on screen).
async function readBulkPreview() {
  const crit = readBulkCriteria();
  const err = validateBulkCriteria(crit);
  if (err) {
    showBulkError(err);
    invalidateBulkPreview();
    return null;
  }
  showBulkError("");
  try {
    const data = await apiModelState("/api/labels/bulk-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crit),
    });
    return { crit, data };
  } catch (e) {
    showBulkError(e.message);
    invalidateBulkPreview();
    return null;
  }
}

// Preview does two things: it writes the counts under the form, and it
// temporarily filters the conversation list to the batch itself so the user can
// look through the actual conversations. It never changes anything, and it is
// never required — Apply works on its own.
async function bulkPreview() {
  const got = await readBulkPreview();
  if (!got) return;
  const { crit, data } = got;
  const notAlready =
    `<strong>${data.not_already.toLocaleString()}</strong> would actually change ` +
    `(“${escHtml(data.action_summary)}” applied).`;
  // "the first N" only when a first-N limit actually caps the eligible set —
  // First N takes the next N of everything eligible, in order, regardless of
  // whether some of them already carry the target.
  const capped = data.limit_n != null && data.will_change < data.eligible;
  const willChange = capped
    ? `This operation will change the first <strong>${data.will_change.toLocaleString()}</strong> ` +
      `(the rest will be saved as an Unfinished Label Run to continue later).`
    : `This operation will change <strong>${data.will_change.toLocaleString()}</strong>.`;
  bulkResultEl.innerHTML =
    `<div>${data.eligible.toLocaleString()} conversation${data.eligible === 1 ? "" : "s"} match these conditions.</div>` +
    `<div>${notAlready}</div>` +
    `<div>${willChange}</div>`;
  bulkResultEl.hidden = false;
  _bulkPreviewed = { crit, data };
  // Apply the criteria to the conversation list, temporarily.
  state.bulkPreview = { crit, data };
  syncBulkPreviewBanner();
  updateListSectionTitle();
  await loadConversations(false);
}

async function bulkApply() {
  // Apply never depends on a prior Preview: if the numbers are stale or were
  // never taken, read them now.
  const crit0 = readBulkCriteria();
  const fresh =
    _bulkPreviewed &&
    JSON.stringify(_bulkPreviewed.crit) === JSON.stringify(crit0)
      ? _bulkPreviewed
      : await readBulkPreview();
  if (!fresh) return;
  const { crit, data } = fresh;
  if (data.will_change === 0) {
    showBulkError("Nothing to change — no conversation matches that isn't already set.");
    return;
  }
  // A "First N" that won't cover everything eligible will be saved as an
  // Unfinished Label Run instead of completing outright — say so up front.
  const partial = data.limit_n != null && data.will_change < data.eligible;
  const ok = await openConfirm({
    title: "Apply label change to batch?",
    text:
      `${data.action_summary} on ${data.will_change.toLocaleString()} conversation` +
      `${data.will_change === 1 ? "" : "s"} (${data.eligible.toLocaleString()} matched). ` +
      (partial
        ? "The remaining conversations will be saved as an Unfinished Label Run " +
          "you can continue later. "
        : "") +
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
  _bulkPreviewed = null;
  exitBulkPreview({ reload: false });
  bulkResultEl.innerHTML =
    res.run_complete === false
      ? `Saved as an Unfinished Label Run: <strong>${res.changed.toLocaleString()}</strong> of ` +
        `${res.eligible.toLocaleString()} completed so far. Continue it below.`
      : `Applied: <strong>${res.changed.toLocaleString()}</strong> changed ` +
        `(${res.eligible.toLocaleString()} matched).`;
  bulkResultEl.hidden = false;
  // Refresh label counts, sidebar squares, the filter, and the history list.
  await loadLabelDefs();
  renderLabelList();
  onLabelDefsChanged();
  // The open conversation may have been in the batch — re-read its assignment.
  refreshActiveHeaderLabel();
  loadBulkHistory();
  loadBulkRuns();
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
    // Line 3 — limit → the frozen action summary.
    const action = document.createElement("div");
    action.className = "bulk-history-action";
    const limitText = h.limit_used ? `First ${h.limit_used}` : "All matching";
    action.textContent = `${limitText} → ${h.action_summary}`;
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

// ── Unfinished Label Runs (Labels screen · section C2) ─────────────────────
// A saved bulk-label run whose "First N" limit didn't cover every qualifying
// conversation. The criteria and the qualifying set are frozen at creation;
// Continue only ever advances into that same frozen, ordered list — it never
// re-evaluates the criteria or looks at conversations' current labels. The
// only thing the user can change here is how many to process next.

function showBulkRunsError(msg) {
  if (!bulkRunsErrorEl) return;
  bulkRunsErrorEl.textContent = msg || "";
  bulkRunsErrorEl.hidden = !msg;
}

async function loadBulkRuns() {
  if (!bulkRunsTableBody) return;
  let runs = [];
  try {
    const d = await apiModelState("/api/labels/bulk-runs");
    runs = d.runs || [];
  } catch (_) {}
  bulkRunsTableBody.innerHTML = "";
  if (!runs.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="no-results">No unfinished runs.</td>';
    bulkRunsTableBody.appendChild(tr);
    return;
  }
  for (const run of runs) {
    bulkRunsTableBody.appendChild(renderBulkRunRow(run));
  }
}

function renderBulkRunRow(run) {
  const tr = document.createElement("tr");

  const crit = document.createElement("td");
  // criteria_lines already ends with a "Labels should be" line — the server
  // freezes it alongside the rest at creation time.
  const lines = (run.criteria_lines || [])
    .map(([label, value]) => `${label}: ${value}`);
  const pre = document.createElement("p");
  pre.className = "bulk-run-criteria";
  pre.textContent = lines.join("\n");
  crit.appendChild(pre);

  const total = document.createElement("td");
  total.className = "bulk-run-count";
  total.textContent = (run.total_qualifying ?? 0).toLocaleString();

  const completed = document.createElement("td");
  completed.className = "bulk-run-count";
  const completedN = run.completed_count ?? 0;
  completed.textContent =
    completedN > 0 ? `1-${completedN.toLocaleString()}` : "0";

  const batch = document.createElement("td");
  const batchInput = document.createElement("input");
  batchInput.type = "number";
  batchInput.className = "bulk-run-batch-input";
  batchInput.min = "1";
  batchInput.value = run.batch_size || 1;
  batch.appendChild(batchInput);

  const actions = document.createElement("td");
  actions.className = "snapshot-actions";
  const continueBtn = document.createElement("button");
  continueBtn.type = "button";
  continueBtn.className = "snapshot-btn";
  continueBtn.textContent = "Continue";
  continueBtn.addEventListener("click", () =>
    continueBulkRun(run.id, batchInput, continueBtn),
  );
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "snapshot-btn snapshot-btn-danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => deleteBulkRun(run));
  actions.append(continueBtn, delBtn);

  tr.append(crit, total, completed, batch, actions);
  return tr;
}

async function continueBulkRun(runId, batchInput, continueBtn) {
  showBulkRunsError("");
  const n = Math.max(1, parseInt(batchInput.value, 10) || 1);
  continueBtn.disabled = true;
  try {
    const res = await apiModelState("/api/labels/bulk-runs/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: runId, batch_size: n }),
    });
    if (res.complete) {
      // Refresh label counts, sidebar squares, the filter, and the history list.
      await loadLabelDefs();
      renderLabelList();
      onLabelDefsChanged();
      refreshActiveHeaderLabel();
      loadBulkHistory();
    } else {
      // Same refreshes, minus the history entry that only exists once the
      // whole run finishes.
      await loadLabelDefs();
      renderLabelList();
      onLabelDefsChanged();
      refreshActiveHeaderLabel();
    }
    loadBulkRuns();
  } catch (e) {
    showBulkRunsError(e.message);
  } finally {
    continueBtn.disabled = false;
  }
}

async function deleteBulkRun(run) {
  const ok = await openConfirm({
    title: "Delete unfinished run?",
    text:
      "Delete this saved run and its progress. Conversations it already " +
      "processed keep whatever label they were set to — nothing is undone.",
    okLabel: "Delete run",
  });
  if (!ok) return;
  try {
    await apiModelState(`/api/labels/bulk-runs/${encodeURIComponent(run.id)}`, {
      method: "DELETE",
    });
  } catch (e) {
    showBulkRunsError(e.message);
    return;
  }
  loadBulkRuns();
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

  // Accept both the current array-of-chips fields and the older single-value
  // fields a Recent-Bulk-Changes row from before chips existed still carries.
  const toValues = (arrField, scalarField, emptyVal) => {
    if (Array.isArray(crit[arrField])) return crit[arrField].slice();
    const v = crit[scalarField];
    return v === undefined || v === null || v === emptyVal || v === "" ? [] : [v];
  };

  const byId = new Map(orderedLabels().map((l) => [l.id, l]));
  bulkChipState.labels = toValues("labels", "label", "any")
    .filter((v) => v === "blank" || byId.has(v))
    .map((v) => (v === "blank" ? { value: "blank", name: "Blank" } : { value: v, name: labelPickName(byId.get(v)) }));
  renderBulkChipRow("labels");

  const folderById = new Map((state.bulkFolderOptions || []).map((f) => [f.id, f]));
  bulkChipState.folders = toValues("folders", "folder", "any")
    .filter((v) => v === "none" || folderById.has(v))
    .map((v) => (v === "none" ? { value: "none", name: "No folder" } : { value: v, name: folderById.get(v).name }));
  renderBulkChipRow("folders");

  bulkChipState.tags = toValues("tags", "tag", "")
    .filter(Boolean)
    .map((v) => ({ value: v, name: v }));
  renderBulkChipRow("tags");

  bulkChipState.keywords = toValues("keywords", "keyword", "")
    .filter(Boolean)
    .map((v) => ({ value: v, name: v }));
  renderBulkChipRow("keywords");

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
  // Accept the current label_action/label_targets, or fall back to a
  // pre-chip "target" row (its "blank" meant Cleared; anything else meant
  // Added of that one label — there was no Removed before this model).
  let labelAction = crit.label_action;
  let targetIds = Array.isArray(crit.label_targets) ? crit.label_targets.slice() : null;
  if (!labelAction) {
    const t = crit.target;
    if (!t || t === "blank") {
      labelAction = "cleared";
      targetIds = [];
    } else {
      labelAction = "added";
      targetIds = [t];
    }
  }
  setSel("bulk-label-action", labelAction, "added");
  bulkChipState.targetLabels = (targetIds || [])
    .filter((v) => v === "all" || byId.has(v))
    .map((v) =>
      v === "all" ? { value: "all", name: "All" } : { value: v, name: labelPickNameOrColor(byId.get(v)) },
    );
  renderBulkChipRow("targetLabels");
  syncBulkTargetLabelsVisibility();

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
$("bulk-label-action")?.addEventListener("change", syncBulkTargetLabelsVisibility);
// Any criteria change invalidates a standing preview so Apply can't act on stale
// numbers. (Buttons emit no input/change events, so Preview/Apply are unaffected.)
document.querySelector(".bulk-form")?.addEventListener("input", invalidateBulkPreview);
document.querySelector(".bulk-form")?.addEventListener("change", invalidateBulkPreview);
bulkPreviewBtn?.addEventListener("click", bulkPreview);
bulkApplyBtn?.addEventListener("click", bulkApply);
$("bulk-preview-clear-btn")?.addEventListener("click", () => exitBulkPreview());
$("bulk-preview-exit")?.addEventListener("click", () => exitBulkPreview());
bulkRetentionInput?.addEventListener("change", saveBulkRetention);
