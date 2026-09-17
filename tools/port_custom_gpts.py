#!/usr/bin/env python3
"""Port only the approved Custom GPT/gizmo feature onto current main.

This is intentionally a guarded one-shot integration script. Every edit requires
an exact current-main anchor and aborts if the surrounding code has drifted.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel, text):
    (ROOT / rel).write_text(text, encoding="utf-8")


def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise RuntimeError(f"{label}: expected exactly one anchor, found {n}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# New backend module. It owns only Custom GPT grouping/naming/bulk-folder data
# logic and deliberately knows nothing about the older source-switcher branch.
# ---------------------------------------------------------------------------
gizmos_py = '''"""Custom GPT (ChatGPT gizmo) data operations.

Names are user-owned metadata in userdata.db; imported gizmo identity stays in
history.db. Nothing here changes message content or provider architecture.
"""
from __future__ import annotations

import time
import uuid

from api_common import ApiError


def _clean_id(value) -> str:
    return str(value or "").strip()


def list_gizmos(conn) -> dict:
    rows = conn.execute(
        "SELECT c.gizmo_id, COALESCE(c.gizmo_type, '') AS gizmo_type, "
        "COUNT(*) AS conversation_count, gn.display_name "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "LEFT JOIN udb.gizmo_names gn ON gn.gizmo_id = c.gizmo_id "
        "WHERE c.provider = 'chatgpt' "
        "AND c.gizmo_id IS NOT NULL AND TRIM(c.gizmo_id) <> '' "
        "AND COALESCE(cm.deleted, 0) = 0 "
        "GROUP BY c.gizmo_id, c.gizmo_type, gn.display_name "
        "ORDER BY COALESCE(NULLIF(gn.display_name, ''), c.gizmo_id) COLLATE NOCASE"
    ).fetchall()
    out = []
    for row in rows:
        samples = conn.execute(
            "SELECT COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title "
            "FROM conversations c "
            "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
            "WHERE c.provider = 'chatgpt' AND c.gizmo_id = ? "
            "AND COALESCE(cm.deleted, 0) = 0 "
            "ORDER BY c.update_time DESC, c.create_time DESC LIMIT 3",
            (row["gizmo_id"],),
        ).fetchall()
        out.append({
            "gizmo_id": row["gizmo_id"],
            "gizmo_type": row["gizmo_type"],
            "display_name": row["display_name"] or "",
            "conversation_count": row["conversation_count"],
            "sample_titles": [r["title"] or "Untitled" for r in samples],
        })
    return {"gizmos": out}


def list_conversations(conn, gizmo_id) -> dict:
    gid = _clean_id(gizmo_id)
    if not gid:
        raise ApiError("missing gizmo_id", 400)
    name_row = conn.execute(
        "SELECT display_name FROM udb.gizmo_names WHERE gizmo_id = ?", (gid,)
    ).fetchone()
    rows = conn.execute(
        "SELECT c.id, COALESCE(NULLIF(cm.custom_title, ''), c.title) AS title, "
        "c.create_time, c.update_time, c.message_count, COALESCE(c.gizmo_type, '') AS gizmo_type "
        "FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.provider = 'chatgpt' AND c.gizmo_id = ? "
        "AND COALESCE(cm.deleted, 0) = 0 "
        "ORDER BY c.update_time DESC, c.create_time DESC",
        (gid,),
    ).fetchall()
    return {
        "gizmo_id": gid,
        "display_name": name_row["display_name"] if name_row else "",
        "conversations": [dict(r) for r in rows],
    }


def rename_gizmo(conn, gizmo_id, payload) -> dict:
    gid = _clean_id(gizmo_id)
    if not gid:
        raise ApiError("missing gizmo id", 400)
    exists = conn.execute(
        "SELECT 1 FROM conversations WHERE provider = 'chatgpt' AND gizmo_id = ? LIMIT 1",
        (gid,),
    ).fetchone()
    if not exists:
        raise ApiError("Custom GPT not found", 404)
    raw = payload.get("display_name", payload.get("name", ""))
    name = " ".join(str(raw or "").split())[:120]
    if name:
        conn.execute(
            "INSERT INTO udb.gizmo_names(gizmo_id, display_name, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(gizmo_id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at",
            (gid, name, time.time()),
        )
    else:
        conn.execute("DELETE FROM udb.gizmo_names WHERE gizmo_id = ?", (gid,))
    conn.commit()
    return {"ok": True, "gizmo_id": gid, "display_name": name}


def move_to_folder(conn, gizmo_id, payload) -> dict:
    """Move every non-deleted chat for one gizmo into one ChatGPT folder.

    Mirrors the ordinary folder move: loose pins are cleared and archived chats
    are restored. The manager's UI supplies folder_name; folder_id remains
    supported for parity with the original feature, but is provider-validated.
    """
    gid = _clean_id(gizmo_id)
    if not gid:
        raise ApiError("missing gizmo id", 400)
    cids = [r["id"] for r in conn.execute(
        "SELECT c.id FROM conversations c "
        "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "
        "WHERE c.provider = 'chatgpt' AND c.gizmo_id = ? "
        "AND COALESCE(cm.deleted, 0) = 0",
        (gid,),
    ).fetchall()]
    if not cids:
        raise ApiError("Custom GPT has no conversations", 404)

    fid = _clean_id(payload.get("folder_id"))
    folder_name = " ".join(str(payload.get("folder_name") or "").split())[:120]
    now = time.time()
    if fid:
        folder = conn.execute(
            "SELECT id, provider FROM udb.folders WHERE id = ?", (fid,)
        ).fetchone()
        if not folder:
            raise ApiError("folder not found", 404)
        if (folder["provider"] or "") != "chatgpt":
            raise ApiError("folder belongs to a different provider", 409)
    else:
        if not folder_name:
            raise ApiError("missing folder_id or folder_name", 400)
        fid = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO udb.folders(id, name, created_at, updated_at, provider) VALUES (?, ?, ?, ?, 'chatgpt')",
            (fid, folder_name, now, now),
        )

    for cid in cids:
        conn.execute(
            "INSERT INTO udb.folder_items(conversation_id, folder_id, added_at, pinned) "
            "VALUES (?, ?, ?, 0) "
            "ON CONFLICT(conversation_id) DO UPDATE SET folder_id=excluded.folder_id, added_at=excluded.added_at, pinned=0",
            (cid, fid, now),
        )
        conn.execute("DELETE FROM pinned_conversations WHERE conversation_id = ?", (cid,))
        conn.execute(
            "INSERT INTO conversation_meta(conversation_id, archived, deleted) VALUES (?, 0, 0) "
            "ON CONFLICT(conversation_id) DO UPDATE SET archived=0",
            (cid,),
        )
    conn.execute("UPDATE udb.folders SET updated_at = ? WHERE id = ?", (now, fid))
    conn.commit()
    return {"ok": True, "folder_id": fid, "moved": len(cids)}
'''
write("gizmos.py", gizmos_py)


# ---------------------------------------------------------------------------
# build_db.py: preserve only the two imported gizmo identity fields, for both
# full rebuilds and incremental imports. No older provider/model architecture.
# ---------------------------------------------------------------------------
p = "build_db.py"
s = read(p)
s = replace_once(
    s,
    '        "import_status": status,\n    }\n    return {\n        "meta":      meta,\n        "msgs":      msgs,\n        "artifacts": [],',
    '        "import_status": status,\n        # ChatGPT Custom GPT identity. Keep the raw export values; user-facing\n        # names live separately in userdata.db and survive rebuilds.\n        "gizmo_id": (str(conv.get("gizmo_id")).strip() or None) if conv.get("gizmo_id") else None,\n        "gizmo_type": (str(conv.get("gizmo_type")).strip() or None) if conv.get("gizmo_type") else None,\n    }\n    return {\n        "meta":      meta,\n        "msgs":      msgs,\n        "artifacts": [],',
    "chatgpt meta gizmo fields",
)
s = replace_once(
    s,
    '    provider      TEXT\n);',
    '    provider      TEXT,\n    -- ChatGPT Custom GPT identity from the export (NULL for ordinary chats / Claude).\n    gizmo_id      TEXT,\n    gizmo_type    TEXT\n);',
    "conversations schema gizmo columns",
)
s = replace_once(
    s,
    '        meta["provider"] = fmt\n        conv_rows.append(meta)',
    '        meta["provider"] = fmt\n        meta.setdefault("gizmo_id", None)\n        meta.setdefault("gizmo_type", None)\n        conv_rows.append(meta)',
    "full build defaults",
)
s = replace_once(
    s,
    '        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, provider) "\n        "VALUES (:id, :title, :create_time, :update_time, :message_count, :preview, :import_status, :source_index, :provider)",',
    '        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, provider, gizmo_id, gizmo_type) "\n        "VALUES (:id, :title, :create_time, :update_time, :message_count, :preview, :import_status, :source_index, :provider, :gizmo_id, :gizmo_type)",',
    "full build insert",
)
s = replace_once(
    s,
    '        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, provider) "\n        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",\n        (\n            meta["id"], meta["title"], meta.get("create_time"), meta.get("update_time"),\n            meta.get("message_count"), meta.get("preview"),\n            meta.get("import_status", "normal"), meta.get("source_index"), provider,\n        ),',
    '        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, provider, gizmo_id, gizmo_type) "\n        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",\n        (\n            meta["id"], meta["title"], meta.get("create_time"), meta.get("update_time"),\n            meta.get("message_count"), meta.get("preview"),\n            meta.get("import_status", "normal"), meta.get("source_index"), provider,\n            meta.get("gizmo_id"), meta.get("gizmo_type"),\n        ),',
    "incremental insert",
)
s = replace_once(
    s,
    '                "SELECT title, update_time, message_count, provider FROM conversations WHERE id = ?",',
    '                "SELECT title, update_time, message_count, provider, gizmo_id, gizmo_type FROM conversations WHERE id = ?",',
    "incremental existing select",
)
s = replace_once(
    s,
    '                and (existing[2] or 0) == (meta.get("message_count") or 0)\n            )',
    '                and (existing[2] or 0) == (meta.get("message_count") or 0)\n                and (existing[4] or None) == (meta.get("gizmo_id") or None)\n                and (existing[5] or None) == (meta.get("gizmo_type") or None)\n            )',
    "incremental equality includes gizmo identity",
)
write(p, s)


# ---------------------------------------------------------------------------
# server.py: additive schema migration, persistent names, four API routes, and
# gizmo identity on the existing detail response. Keep every newer field intact.
# ---------------------------------------------------------------------------
p = "server.py"
s = read(p)
s = replace_once(
    s,
    'import labels, bulk_labels, snapshots',
    'import labels, bulk_labels, snapshots, gizmos',
    "server import gizmos",
)
s = replace_once(
    s,
    '                 "labels.py", "bulk_labels.py", "snapshots.py"):',
    '                 "labels.py", "bulk_labels.py", "snapshots.py", "gizmos.py"):',
    "backend signature",
)
s = replace_once(
    s,
    '                 "labels_screen.js", "bulk_labels.js", "snapshots.js"):',
    '                 "labels_screen.js", "bulk_labels.js", "snapshots.js", "gizmos.js"):',
    "static signature",
)
s = replace_once(
    s,
    '            "ALTER TABLE conversations ADD COLUMN provider TEXT",\n            # Compare items carry their own provider for tab colouring.',
    '            "ALTER TABLE conversations ADD COLUMN provider TEXT",\n            # ChatGPT Custom GPT identity. Additive migration only; existing rows\n            # stay NULL until imported/rebuilt from a ChatGPT export.\n            "ALTER TABLE conversations ADD COLUMN gizmo_id TEXT",\n            "ALTER TABLE conversations ADD COLUMN gizmo_type TEXT",\n            # Compare items carry their own provider for tab colouring.',
    "runtime gizmo columns",
)
s = replace_once(
    s,
    '            "CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts (conv_id)",\n        ):',
    '            "CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts (conv_id)",\n            "CREATE INDEX IF NOT EXISTS idx_conv_gizmo ON conversations (gizmo_id)",\n        ):',
    "gizmo index",
)
s = replace_once(
    s,
    '            CREATE INDEX IF NOT EXISTS idx_conv_tags_tag ON conversation_tags (tag);\n\n            -- A lightweight tombstone',
    '            CREATE INDEX IF NOT EXISTS idx_conv_tags_tag ON conversation_tags (tag);\n\n            -- User-assigned names for ChatGPT Custom GPT ids. Kept outside\n            -- history.db so naming survives rebuilds and applies to every chat\n            -- carrying the same imported gizmo id.\n            CREATE TABLE IF NOT EXISTS gizmo_names (\n                gizmo_id     TEXT PRIMARY KEY,\n                display_name TEXT NOT NULL,\n                updated_at   REAL\n            );\n\n            -- A lightweight tombstone',
    "persistent gizmo names",
)
# POST bulk move route, PATCH rename route, GET list + drilldown routes.
s = replace_once(
    s,
    '        elif path == "/api/tags":\n            self._api_tag_add()',
    '        elif path == "/api/tags":\n            self._api_tag_add()\n        elif path.startswith("/api/gizmos/") and path.endswith("/folder"):\n            inner = path[len("/api/gizmos/"):-len("/folder")]\n            gid = urllib.parse.unquote(inner.strip("/"))\n            payload = self._read_json_body()\n            self._handle_db(lambda conn: gizmos.move_to_folder(conn, gid, payload))',
    "POST gizmo folder route",
)
s = replace_once(
    s,
    '        elif path.startswith("/api/labels/"):\n            self._api_label_update(urllib.parse.unquote(path[len("/api/labels/"):]))',
    '        elif path.startswith("/api/gizmos/"):\n            gid = urllib.parse.unquote(path[len("/api/gizmos/"):])\n            payload = self._read_json_body()\n            self._handle_db(lambda conn: gizmos.rename_gizmo(conn, gid, payload))\n        elif path.startswith("/api/labels/"):\n            self._api_label_update(urllib.parse.unquote(path[len("/api/labels/"):]))',
    "PATCH gizmo route",
)
s = replace_once(
    s,
    '        elif path == "/api/tags":\n            self._api_tags_all()\n        elif path == "/api/labels":',
    '        elif path == "/api/tags":\n            self._api_tags_all()\n        elif path == "/api/gizmos":\n            self._handle_db(gizmos.list_gizmos)\n        elif path == "/api/gizmo-conversations":\n            gid = ((qs.get("gizmo_id") or [""])[0]).strip()\n            self._handle_db(lambda conn: gizmos.list_conversations(conn, gid))\n        elif path == "/api/labels":',
    "GET gizmo routes",
)
# Detail: join the persistent name, expose imported identity, then count siblings.
s = replace_once(
    s,
    '                "c.provider AS provider, "\n                "COALESCE(cm.deleted, 0) AS deleted, "',
    '                "c.provider AS provider, c.gizmo_id, c.gizmo_type, "\n                "COALESCE(gn.display_name, \'\') AS gizmo_name, "\n                "COALESCE(cm.deleted, 0) AS deleted, "',
    "detail gizmo fields",
)
s = replace_once(
    s,
    '                "LEFT JOIN udb.folder_items fi ON fi.conversation_id = c.id "\n                # No deleted filter:',
    '                "LEFT JOIN udb.folder_items fi ON fi.conversation_id = c.id "\n                "LEFT JOIN udb.gizmo_names gn ON gn.gizmo_id = c.gizmo_id "\n                # No deleted filter:',
    "detail gizmo name join",
)
s = replace_once(
    s,
    '            conv_dict = dict(conv)\n            # The current label rides along so opening a conversation stays one',
    '            conv_dict = dict(conv)\n            if conv_dict.get("gizmo_id"):\n                conv_dict["gizmo_conversation_count"] = conn.execute(\n                    "SELECT COUNT(*) FROM conversations c "\n                    "LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id "\n                    "WHERE c.provider = \'chatgpt\' AND c.gizmo_id = ? "\n                    "AND COALESCE(cm.deleted, 0) = 0",\n                    (conv_dict["gizmo_id"],),\n                ).fetchone()[0]\n            else:\n                conv_dict["gizmo_conversation_count"] = 0\n            # The current label rides along so opening a conversation stays one',
    "detail gizmo count",
)
write(p, s)


# ---------------------------------------------------------------------------
# Frontend module: old feature semantics, adapted to current main's special-view
# and folder/provider architecture. No source toggle or old message machinery.
# ---------------------------------------------------------------------------
gizmos_js = r'''"use strict";

// Custom GPT manager + thread identity. Loaded before app.js; shared app globals
// are only touched when these functions are called after app.js has initialized.
let _activeGizmo = null;

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
  const restore = () => {
    if (settled) return;
    settled = true;
    if (input.parentNode) input.parentNode.replaceChild(_gizmoNameEl(g, onSaved), input);
  };
  const save = async () => {
    if (settled) return;
    const next = input.value.trim();
    if (next === (g.display_name || "")) { restore(); return; }
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
  input.addEventListener("blur", () => { if (!settled) save(); });
}

function renderGizmoThreadIdentity(conv) {
  const meta = document.getElementById("thread-meta");
  meta?.querySelector(".thread-meta-gizmo")?.remove();
  _activeGizmo = null;
  if (!meta || !conv?.gizmo_id) return;
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
'''
write("static/gizmos.js", gizmos_js)


# ---------------------------------------------------------------------------
# index.html: manager entry/panel + load gizmos module before app.js.
# ---------------------------------------------------------------------------
p = "static/index.html"
s = read(p)
s = replace_once(
    s,
    '        <button\n          class="sidebar-menu-item"\n          role="menuitem"\n          data-action="attachment-report"\n        >',
    '        <button\n          class="sidebar-menu-item"\n          role="menuitem"\n          data-action="gizmos"\n        >\n          <span class="sidebar-menu-item-icon" aria-hidden="true">🤖</span>\n          <span class="sidebar-menu-item-label">Custom GPTs</span>\n        </button>\n        <button\n          class="sidebar-menu-item"\n          role="menuitem"\n          data-action="attachment-report"\n        >',
    "Custom GPT menu item",
)
# Put the manager before the labels panel, without altering any existing panel.
anchor = '        <div id="labels-panel" hidden>'
manager = '''        <div id="gizmos-panel" hidden>
          <div class="thread-header">
            <h2>Custom GPTs</h2>
            <div class="panel-meta">
              Name ChatGPT Custom GPTs, find every conversation that shares an
              imported GPT ID, or move all of one GPT's chats into a folder.
              Names are kept when history is rebuilt or re-imported.
            </div>
          </div>
          <div id="gizmos-content"></div>
        </div>

'''
s = replace_once(s, anchor, manager + anchor, "Custom GPT panel")
s = replace_once(
    s,
    '    <script src="/static/app.js"></script>',
    '    <script src="/static/gizmos.js"></script>\n    <script src="/static/app.js"></script>',
    "gizmos script load",
)
write(p, s)


# ---------------------------------------------------------------------------
# app.js: four narrow integration hooks only.
# ---------------------------------------------------------------------------
p = "static/app.js"
s = read(p)
s = replace_once(
    s,
    'const importAuditPanel = $("import-audit-panel");\nconst claudeModelsPanel = $("claude-models-panel");',
    'const importAuditPanel = $("import-audit-panel");\nconst gizmosPanel = $("gizmos-panel");\nconst claudeModelsPanel = $("claude-models-panel");',
    "gizmo panel ref",
)
s = replace_once(
    s,
    '  if (state.activeSpecialView === "import_audit") return openImportAudit(false);\n  if (state.activeSpecialView === "import_new") return openImportNew();',
    '  if (state.activeSpecialView === "import_audit") return openImportAudit(false);\n  if (state.activeSpecialView === "gizmos") return openGizmos();\n  if (state.activeSpecialView === "import_new") return openImportNew();',
    "restore gizmo special view",
)
s = replace_once(
    s,
    '  importAuditPanel.hidden = true;\n  importNewPanel.hidden = true;',
    '  importAuditPanel.hidden = true;\n  gizmosPanel.hidden = true;\n  importNewPanel.hidden = true;',
    "hide gizmo panel",
)
s = replace_once(
    s,
    '  state.models = data.models || null;\n  renderModelStrip();\n  state.tags = data.tags || [];',
    '  state.models = data.models || null;\n  renderModelStrip();\n  renderGizmoThreadIdentity(conv);\n  state.tags = data.tags || [];',
    "thread gizmo identity hook",
)
s = replace_once(
    s,
    '        : msg.role === "assistant"\n          ? "Claude"\n          : msg.role;',
    '        : msg.role === "assistant"\n          ? (conv.gizmo_name || "Claude")\n          : msg.role;',
    "named GPT assistant label",
)
# Menu action: use the existing handler anchor without moving any other action.
s = replace_once(
    s,
    '    if (action === "attachment-report") openAttReport(false);',
    '    if (action === "gizmos") openGizmos();\n    else if (action === "attachment-report") openAttReport(false);',
    "sidebar gizmo action",
)
write(p, s)


# ---------------------------------------------------------------------------
# style.css: far-right identity + manager. All theme-significant values use the
# repo's existing variables; no old branch global/header CSS is copied over.
# ---------------------------------------------------------------------------
p = "static/style.css"
s = read(p)
s = replace_once(
    s,
    '#thread-meta {\n  font-size: 11.5px;\n  color: var(--muted);\n}',
    '#thread-meta {\n  display: flex;\n  align-items: baseline;\n  gap: 5px;\n  width: 100%;\n  font-size: 11.5px;\n  color: var(--muted);\n}\n\n.thread-meta-gizmo {\n  margin-left: auto;\n  flex-shrink: 0;\n  max-width: 55%;\n  text-align: right;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.thread-meta-gizmo .gizmo-name { cursor: text; }\n.thread-meta-gizmo .gizmo-name:hover { color: var(--text); }',
    "thread meta gizmo layout",
)
# Append isolated manager styles.
s += r'''

/* ── Custom GPT manager ─────────────────────────────────────────────────── */
#gizmos-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#gizmos-panel[hidden] { display: none; }
#gizmos-content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 40px 60px;
}
.gizmo-list,
.gizmo-conversation-list {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gizmo-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--user-bubble);
  padding: 14px 16px;
}
.gizmo-card.unnamed { background: var(--bg); }
.gizmo-card-head {
  display: flex;
  align-items: baseline;
  min-width: 0;
}
.gizmo-name {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}
.gizmo-name:hover { color: var(--accent); }
.gizmo-name-input {
  min-width: 160px;
  max-width: 100%;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 2px 6px;
}
.gizmo-name-input:focus { outline: none; }
.gizmo-id {
  margin-top: 2px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
}
.gizmo-card-meta,
.gizmo-samples,
.gizmo-conversation-meta {
  color: var(--muted);
  font-size: 12px;
}
.gizmo-samples { margin-top: 6px; }
.gizmo-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.gizmo-btn {
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 6px;
  padding: 5px 10px;
  cursor: pointer;
}
.gizmo-btn:hover {
  background: var(--hover);
  border-color: var(--accent);
}
.gizmo-detail-head {
  max-width: 760px;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.gizmo-detail-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.gizmo-conversation {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--user-bubble);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.gizmo-conversation:hover {
  background: var(--hover);
  border-color: var(--accent);
}
.gizmo-conversation-title { font-weight: 500; }
'''
write(p, s)

print("Custom GPT port applied successfully.")
