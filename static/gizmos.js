"use strict";

// Custom GPT manager + thread identity. Loaded before app.js; shared app globals
// are only touched when these functions are called after app.js has initialized.
let _activeGizmo = null;

// The gizmo feature makes #thread-meta flex only when a gizmo identity is
// present. Keep every ordinary/Claude header on main's original block layout so
// the newer Claude model strip is not changed merely by installing this feature.
const _gizmoLayoutGuard = document.createElement("style");
_gizmoLayoutGuard.textContent =
  "#thread-meta:not(.has-gizmo){display:block;width:auto;}";
document.head.appendChild(_gizmoLayoutGuard);

function _gizmoPanel() { return document.getElementById("gizmos-panel"); }
function _gizmoContent() { return document.getElementById("gizmos-content"); }

async function apiGizmos() {
  const r = await fetch("/api/gizmos");
  return r.json();
}
async function apiGizmoConversations(gizmoId) {
  const p = new URLSearchParams({ gizmo_id: gizmoId });
  const r = await fetch(`/api/gizmo-conversations?${p}`);
  return r.json();
}
async function apiRenameGizmo(gizmoId, name) {
  const r = await fetch(`/api/gizmos/${encodeURIComponent(gizmoId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: name }),
  });
  return r.json();
}
async function apiGizmoMoveToFolder(gizmoId, payload) {
  const r = await fetch(`/api/gizmos/${encodeURIComponent(gizmoId)}/folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

function _gizmoConfirmRename(name, count) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Rename Custom GPT?";
    const text = document.createElement("div");
    text.className = "modal-text";
    text.textContent = `This name will apply to all ${count} conversation${count === 1 ? "" : "s"} that have this Custom GPT ID.`;
    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    const cancel = document.createElement("button");
    cancel.className = "modal-btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "modal-btn modal-btn-primary";
    ok.textContent = name ? "Rename" : "Clear name";
    buttons.append(cancel, ok);
    modal.append(title, text, buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const finish = (result) => { overlay.remove(); resolve(result); };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); });
    setTimeout(() => ok.focus(), 0);
  });
}

function _gizmoNameEl(g, onSaved) {
  const el = document.createElement("span");
  el.className = "gizmo-name";
  el.textContent = g.display_name || g.gizmo_id;
  el.title = g.display_name ? "Double-click to rename this Custom GPT" : "Double-click to name this Custom GPT";
  el.addEventListener("dblclick", () => _beginGizmoRename(el, g, onSaved));
  return el;
}

function _beginGizmoRename(el, g, onSaved) {
  if (!el?.parentNode || el.querySelector("input")) return;
  const input = document.createElement("input");
  input.className = "gizmo-name-input";
  input.type = "text";
  input.maxLength = 120;
  input.value = g.display_name || "";
  const parent = el.parentNode;
  parent.replaceChild(input, el);
  input.focus();
  input.select();
  let settled = false;
  let pending = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    if (input.parentNode) input.parentNode.replaceChild(_gizmoNameEl(g, onSaved), input);
  };
  const save = async () => {
    if (settled || pending) return;
    const next = input.value.trim();
    if (next === (g.display_name || "")) { restore(); return; }
    // Focusing the confirmation dialog blurs this input. Mark the save pending
    // first so that blur cannot start a second confirmation/save in parallel.
    pending = true;
    const ok = await _gizmoConfirmRename(next, g.conversation_count || 0);
    if (!ok) { restore(); return; }
    settled = true;
    const result = await apiRenameGizmo(g.gizmo_id, next);
    if (result.error) {
      if (input.parentNode) input.parentNode.replaceChild(_gizmoNameEl(g, onSaved), input);
      return;
    }
    g.display_name = result.display_name || "";
    if (onSaved) await onSaved(g.display_name);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); restore(); }
  });
  input.addEventListener("blur", () => { if (!settled && !pending) save(); });
}

function renderGizmoThreadIdentity(conv) {
  const meta = document.getElementById("thread-meta");
  meta?.querySelector(".thread-meta-gizmo")?.remove();
  meta?.classList.remove("has-gizmo");
  _activeGizmo = null;
  if (!meta || !conv?.gizmo_id) return;
  meta.classList.add("has-gizmo");
  const g = {
    gizmo_id: conv.gizmo_id,
    gizmo_type: conv.gizmo_type || "",
    display_name: conv.gizmo_name || "",
    conversation_count: conv.gizmo_conversation_count || 0,
  };
  _activeGizmo = g;
  const holder = document.createElement("span");
  holder.className = "thread-meta-gizmo";
  const rebuild = () => {
    holder.innerHTML = "";
    holder.appendChild(_gizmoNameEl(g, async () => {
      if (state.activeId) await openConversation(state.activeId, null);
      if (state.activeSpecialView === "gizmos") await renderGizmosList();
    }));
  };
  rebuild();
  meta.appendChild(holder);
}

async function openGizmos() {
  rememberReturnTab();
  state.activeSpecialView = "gizmos";
  state.activeTabId = null;
  document.querySelectorAll(".conv-item.active, .folder-conv-item.active")
    .forEach((el) => el.classList.remove("active"));
  state.activeId = null;
  await ensureSpecialTab("gizmos", "Custom GPTs");
  hideAllPanels();
  const panel = _gizmoPanel();
  if (panel) panel.hidden = false;
  await renderGizmosList();
}

async function renderGizmosList() {
  const root = _gizmoContent();
  if (!root) return;
  root.innerHTML = '<div class="loading">Loading…</div>';
  let data;
  try { data = await apiGizmos(); }
  catch (e) {
    root.innerHTML = `<div class="no-results">Could not load Custom GPTs: ${escHtml(e.message)}</div>`;
    return;
  }
  if (data.error) {
    root.innerHTML = `<div class="no-results">${escHtml(data.error)}</div>`;
    return;
  }
  const rows = data.gizmos || [];
  root.innerHTML = "";
  if (!rows.length) {
    root.innerHTML = '<div class="no-results">No Custom GPT conversations found in the imported ChatGPT history.</div>';
    return;
  }
  const list = document.createElement("div");
  list.className = "gizmo-list";
  for (const g of rows) {
    const card = document.createElement("div");
    card.className = "gizmo-card" + (g.display_name ? "" : " unnamed");
    const head = document.createElement("div");
    head.className = "gizmo-card-head";
    head.appendChild(_gizmoNameEl(g, async () => renderGizmosList()));
    const id = document.createElement("div");
    id.className = "gizmo-id";
    id.textContent = g.gizmo_id;
    const meta = document.createElement("div");
    meta.className = "gizmo-card-meta";
    const typeText = g.gizmo_type ? ` · ${g.gizmo_type}` : "";
    meta.textContent = `${g.conversation_count} conversation${g.conversation_count === 1 ? "" : "s"}${typeText}`;
    const samples = document.createElement("div");
    samples.className = "gizmo-samples";
    samples.textContent = (g.sample_titles || []).join(" · ");
    const actions = document.createElement("div");
    actions.className = "gizmo-actions";
    const view = document.createElement("button");
    view.className = "gizmo-btn";
    view.textContent = `View ${g.conversation_count} conversation${g.conversation_count === 1 ? "" : "s"}`;
    view.addEventListener("click", () => renderGizmoConversations(g));
    const rename = document.createElement("button");
    rename.className = "gizmo-btn";
    rename.textContent = g.display_name ? "Rename" : "Name this GPT";
    rename.addEventListener("click", () => {
      const name = head.querySelector(".gizmo-name");
      if (name) _beginGizmoRename(name, g, async () => renderGizmosList());
    });
    const move = document.createElement("button");
    move.className = "gizmo-btn";
    move.textContent = `Move all ${g.conversation_count} to folder`;
    move.addEventListener("click", () => moveGizmoToFolderFlow(g));
    actions.append(view, rename, move);
    card.append(head, id, meta);
    if (samples.textContent) card.appendChild(samples);
    card.appendChild(actions);
    list.appendChild(card);
  }
  root.appendChild(list);
}

async function renderGizmoConversations(g) {
  const root = _gizmoContent();
  if (!root) return;
  root.innerHTML = '<div class="loading">Loading…</div>';
  const data = await apiGizmoConversations(g.gizmo_id);
  if (data.error) {
    root.innerHTML = `<div class="no-results">${escHtml(data.error)}</div>`;
    return;
  }
  root.innerHTML = "";
  const header = document.createElement("div");
  header.className = "gizmo-detail-head";
  const back = document.createElement("button");
  back.className = "gizmo-btn gizmo-back";
  back.textContent = "← All Custom GPTs";
  back.addEventListener("click", () => renderGizmosList());
  const title = document.createElement("div");
  title.className = "gizmo-detail-title";
  title.textContent = data.display_name || g.display_name || "Custom GPT";
  header.append(back, title);
  root.appendChild(header);
  const list = document.createElement("div");
  list.className = "gizmo-conversation-list";
  for (const c of data.conversations || []) {
    const item = document.createElement("button");
    item.className = "gizmo-conversation";
    const date = formatDate(c.update_time || c.create_time);
    item.innerHTML = `<span class="gizmo-conversation-title">${escHtml(c.title || "Untitled")}</span><span class="gizmo-conversation-meta">${escHtml(date)} · ${c.message_count} messages</span>`;
    item.addEventListener("click", () => openConversation(c.id, resolveConversationSidebarEl(c.id)));
    list.appendChild(item);
  }
  if (!list.childElementCount) {
    list.innerHTML = '<div class="no-results">No conversations found.</div>';
  }
  root.appendChild(list);
}

async function moveGizmoToFolderFlow(g) {
  const defaultName = g.display_name || "Custom GPT";
  const folderName = await openNameModal({
    title: `Move ${g.conversation_count} chats to folder`,
    value: defaultName,
    okLabel: "Move",
  });
  if (folderName === null) return;
  const res = await apiGizmoMoveToFolder(g.gizmo_id, { folder_name: folderName });
  if (!res || res.error) return;
  await loadFolders();
  await refreshPinnedList();
  await loadConversations(false);
  await renderGizmosList();
}