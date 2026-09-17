#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected exactly {expected} matches, found {count}")
    return text.replace(old, new)


def replace_section(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    if text.count(start_marker) != 1 or text.count(end_marker) != 1:
        raise SystemExit(f"{label}: section markers were not unique")
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    return text[:start] + replacement + text[end:]


# ---------------------------------------------------------------------------
# server.py: transplant only the Mood Tags backend changes onto current main.
# ---------------------------------------------------------------------------
server_path = Path("server.py")
server = server_path.read_text(encoding="utf-8")

schema_anchor = """            CREATE INDEX IF NOT EXISTS idx_conv_tags_tag ON conversation_tags (tag);\n\n            -- User-assigned names for ChatGPT Custom GPT ids. Kept outside\n"""
schema_new = """            CREATE INDEX IF NOT EXISTS idx_conv_tags_tag ON conversation_tags (tag);\n\n            -- Mood tags: a second, independent per-conversation tag set. Same\n            -- persistence model as ordinary tags, but never mixed with them.\n            CREATE TABLE IF NOT EXISTS conversation_mood_tags (\n                conversation_id TEXT NOT NULL,\n                tag             TEXT NOT NULL,\n                added_at        REAL,\n                PRIMARY KEY (conversation_id, tag)\n            );\n            CREATE INDEX IF NOT EXISTS idx_conv_mood_tags_tag\n                ON conversation_mood_tags (tag);\n\n            -- User-assigned names for ChatGPT Custom GPT ids. Kept outside\n"""
server = replace_once(server, schema_anchor, schema_new, "mood tag schema")

server = replace_once(
    server,
    '        "DELETE FROM udb.conversation_tags WHERE conversation_id = ?",\n        "DELETE FROM udb.conversation_models WHERE conversation_id = ?",',
    '        "DELETE FROM udb.conversation_tags WHERE conversation_id = ?",\n        "DELETE FROM udb.conversation_mood_tags WHERE conversation_id = ?",\n        "DELETE FROM udb.conversation_models WHERE conversation_id = ?",',
    "purge mood tags",
)

server = replace_once(
    server,
    '        elif path == "/api/tags":\n            self._api_tag_add()\n        elif path.startswith("/api/gizmos/") and path.endswith("/folder"):',
    '        elif path == "/api/tags":\n            self._api_tag_add()\n        elif path == "/api/mood-tags":\n            self._api_mood_tag_add()\n        elif path.startswith("/api/gizmos/") and path.endswith("/folder"):',
    "POST mood route",
)

server = replace_once(
    server,
    '''        elif path.startswith("/api/tags/"):\n            parts = [urllib.parse.unquote(p) for p\n                     in path[len("/api/tags/"):].split("/") if p]\n            if len(parts) != 2:\n                self.send_error(404); return\n            self._api_tag_remove(parts[0], parts[1])\n        elif path.startswith("/api/labels/bulk-runs/"):''',
    '''        elif path.startswith("/api/tags/"):\n            parts = [urllib.parse.unquote(p) for p\n                     in path[len("/api/tags/"):].split("/") if p]\n            if len(parts) != 2:\n                self.send_error(404); return\n            self._api_tag_remove(parts[0], parts[1])\n        elif path.startswith("/api/mood-tags/"):\n            parts = [urllib.parse.unquote(p) for p\n                     in path[len("/api/mood-tags/"):].split("/") if p]\n            if len(parts) != 2:\n                self.send_error(404); return\n            self._api_mood_tag_remove(parts[0], parts[1])\n        elif path.startswith("/api/labels/bulk-runs/"):''',
    "DELETE mood route",
)

server = replace_once(
    server,
    '        elif path == "/api/tags":\n            self._api_tags_all()\n        elif path == "/api/gizmos":',
    '        elif path == "/api/tags":\n            self._api_tags_all()\n        elif path == "/api/mood-tags":\n            self._api_mood_tags_all()\n        elif path == "/api/gizmos":',
    "GET mood route",
)

# Search parity inside the conversation-list search only.
conv_start = server.index("    def _api_conversations(self, qs):")
conv_end = server.index("    def _api_detail(self, conv_id):", conv_start)
conv = server[conv_start:conv_end]
conv = replace_count(
    conv,
    '                            "  SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?"\n',
    '                            "  SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?"\n                            "  UNION "\n                            "  SELECT conversation_id FROM udb.conversation_mood_tags WHERE tag LIKE ?"\n',
    2,
    "FTS/list mood search union",
)
conv = replace_once(conv, "                            (q, like, like, limit, offset),", "                            (q, like, like, like, limit, offset),", "FTS row params")
conv = replace_once(conv, "                            (q, like, like),", "                            (q, like, like, like),", "FTS count params")
conv = replace_count(
    conv,
    '"OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?)) "',
    '"OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?) "\n                            "OR c.id IN (SELECT conversation_id FROM udb.conversation_mood_tags WHERE tag LIKE ?)) "',
    2,
    "fallback/list mood search rows",
)
conv = replace_count(
    conv,
    '"OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?))",',
    '"OR c.id IN (SELECT conversation_id FROM udb.conversation_tags WHERE tag LIKE ?) "\n                            "OR c.id IN (SELECT conversation_id FROM udb.conversation_mood_tags WHERE tag LIKE ?))",',
    2,
    "fallback/list mood search counts",
)
conv = replace_count(conv, "(like, like, limit, offset),", "(like, like, like, limit, offset),", 2, "fallback row params")
conv = replace_count(conv, "(like, like)\n", "(like, like, like)\n", 2, "fallback count params")
server = server[:conv_start] + conv + server[conv_end:]

# Detail response: retain the current gizmo-aware conversation object and add a
# separate Mood Tags payload beside ordinary tags.
server = replace_once(
    server,
    '                            "models": models,\n                            "tags": self._conv_tags(conn, conv_id)})',
    '                            "models": models,\n                            "tags": self._conv_tags(conn, conv_id),\n                            "mood_tags": self._conv_mood_tags(conn, conv_id)})',
    "conversation detail mood tags",
)

# Global search parity with ordinary Tags.
search_start = server.index("    def _api_search(self, qs):")
search_end = server.index("    def _api_gallery(self):", search_start)
search = server[search_start:search_end]
regular_search = '''            # And tag matches\n            for r in conn.execute(\n                "SELECT DISTINCT conversation_id FROM udb.conversation_tags WHERE tag LIKE ? LIMIT 15",\n                (f"%{q}%",)\n            ).fetchall():\n                if r[0] not in conv_ids_set:\n                    conv_ids.append(r[0]); conv_ids_set.add(r[0])\n'''
mood_search = '''            # And tag matches (ordinary tags and mood tags both count)\n            for r in conn.execute(\n                "SELECT DISTINCT conversation_id FROM udb.conversation_tags WHERE tag LIKE ? LIMIT 15",\n                (f"%{q}%",)\n            ).fetchall():\n                if r[0] not in conv_ids_set:\n                    conv_ids.append(r[0]); conv_ids_set.add(r[0])\n            for r in conn.execute(\n                "SELECT DISTINCT conversation_id FROM udb.conversation_mood_tags WHERE tag LIKE ? LIMIT 15",\n                (f"%{q}%",)\n            ).fetchall():\n                if r[0] not in conv_ids_set:\n                    conv_ids.append(r[0]); conv_ids_set.add(r[0])\n'''
search = replace_once(search, regular_search, mood_search, "global mood search")
server = server[:search_start] + search + server[search_end:]

mood_methods = '''    # ── Mood tags ─────────────────────────────────────────────────────────────\n    # A second, independent per-conversation tag set with the same normalization\n    # and persistence rules as ordinary tags, but its own table and vocabulary.\n\n    def _conv_mood_tags(self, conn, conv_id):\n        rows = conn.execute(\n            "SELECT tag FROM udb.conversation_mood_tags WHERE conversation_id = ? "\n            "ORDER BY added_at", (conv_id,),\n        ).fetchall()\n        return [r["tag"] for r in rows]\n\n    def _api_mood_tags_all(self):\n        """Every distinct mood tag in use, for Mood Tag autocomplete."""\n        conn = open_db(self.db_path)\n        try:\n            rows = conn.execute(\n                "SELECT DISTINCT tag FROM udb.conversation_mood_tags "\n                "ORDER BY tag COLLATE NOCASE"\n            ).fetchall()\n            self.send_json({"tags": [r["tag"] for r in rows]})\n        finally:\n            conn.close()\n\n    def _api_mood_tag_add(self):\n        payload = self._read_json_body()\n        conv_id = str(payload.get("conv_id") or "").strip()\n        tag = " ".join(str(payload.get("tag") or "").split())[:40]\n        if not conv_id or not tag:\n            self.send_json({"error": "conv_id and tag are required"}, 400); return\n        conn = open_db(self.db_path)\n        try:\n            if not conn.execute(\n                "SELECT 1 FROM conversations WHERE id = ?", (conv_id,)\n            ).fetchone():\n                self.send_json({"error": "Unknown conversation"}, 404); return\n            conn.execute(\n                "INSERT OR IGNORE INTO udb.conversation_mood_tags"\n                "(conversation_id, tag, added_at) VALUES (?, ?, ?)",\n                (conv_id, tag, time.time()),\n            )\n            conn.commit()\n            self.send_json({"tags": self._conv_mood_tags(conn, conv_id)})\n        finally:\n            conn.close()\n\n    def _api_mood_tag_remove(self, conv_id, tag):\n        conn = open_db(self.db_path)\n        try:\n            conn.execute(\n                "DELETE FROM udb.conversation_mood_tags "\n                "WHERE conversation_id = ? AND tag = ?",\n                (conv_id, tag),\n            )\n            conn.commit()\n            self.send_json({"tags": self._conv_mood_tags(conn, conv_id)})\n        finally:\n            conn.close()\n\n'''
labels_marker = "    # ── Conversation labels · bulk labeling · snapshots ──────────────────────\n"
if server.count(labels_marker) != 1:
    raise SystemExit("labels marker was not unique")
server = server.replace(labels_marker, mood_methods + labels_marker, 1)

# Critical current-main gizmo invariants must survive the transplant.
for required in (
    "import labels, bulk_labels, snapshots, gizmos",
    'elif path == "/api/gizmos":',
    'elif path == "/api/gizmo-conversations":',
    'c.provider AS provider, c.gizmo_id, c.gizmo_type',
    'conv_dict["gizmo_conversation_count"]',
):
    if required not in server:
        raise SystemExit(f"server gizmo invariant missing: {required}")
server_path.write_text(server, encoding="utf-8")


# ---------------------------------------------------------------------------
# static/app.js: keep gizmo rendering/labels and add independent Mood Tags UI.
# ---------------------------------------------------------------------------
app_path = Path("static/app.js")
app = app_path.read_text(encoding="utf-8")
app = replace_once(
    app,
    '  tags: [], // tags on the open conversation\n  allTagsCache: null, // every tag in use, for the add-tag autocomplete\n',
    '  tags: [], // tags on the open conversation\n  allTagsCache: null, // every tag in use, for the add-tag autocomplete\n  moodTags: [], // mood tags on the open conversation (independent of tags)\n  allMoodTagsCache: null, // every mood tag in use, for mood-tag autocomplete\n',
    "mood frontend state",
)

api_anchor = '''async function apiRemoveTag(convId, tag) {\n  const r = await fetch(\n    `/api/tags/${encodeURIComponent(convId)}/${encodeURIComponent(tag)}`,\n    { method: "DELETE" },\n  );\n  return r.json();\n}\n\n'''
mood_api = api_anchor + '''// Mood tags: a second, independent tag set with its own API and vocabulary.\nasync function apiAllMoodTags() {\n  const r = await fetch("/api/mood-tags");\n  const data = await r.json();\n  return data.tags || [];\n}\n\nasync function apiAddMoodTag(convId, tag) {\n  const r = await fetch("/api/mood-tags", {\n    method: "POST",\n    headers: { "Content-Type": "application/json" },\n    body: JSON.stringify({ conv_id: convId, tag }),\n  });\n  return r.json();\n}\n\nasync function apiRemoveMoodTag(convId, tag) {\n  const r = await fetch(\n    `/api/mood-tags/${encodeURIComponent(convId)}/${encodeURIComponent(tag)}`,\n    { method: "DELETE" },\n  );\n  return r.json();\n}\n\n'''
app = replace_once(app, api_anchor, mood_api, "mood frontend API")

app = replace_once(
    app,
    '  renderModelStrip();\n  renderGizmoThreadIdentity(conv);\n  state.tags = data.tags || [];\n  renderThreadTags();',
    '  renderModelStrip();\n  renderGizmoThreadIdentity(conv);\n  state.tags = data.tags || [];\n  state.moodTags = data.mood_tags || [];\n  renderThreadTags();',
    "load mood tags without disturbing gizmo identity",
)

TAG_START = "// ── Conversation tags ────────────────────────────────────────────────────────\n"
TAG_END = "// A change to one conversation's models can add or clear its warning icons, so\n"
new_tag_block = '''// ── Conversation tags ────────────────────────────────────────────────────────\n// Two independent tag sets share this row. Ordinary Tags occupy the left half;\n// Mood Tags occupy the right half and are anchored at the right edge.\n\nconst TAG_GROUPS = {\n  tag: {\n    chips: () => state.tags,\n    setChips: (v) => { state.tags = v; },\n    cache: () => state.allTagsCache,\n    setCache: (v) => { state.allTagsCache = v; },\n    loadAll: () => apiAllTags(),\n    add: (convId, tag) => apiAddTag(convId, tag),\n    remove: (convId, tag) => apiRemoveTag(convId, tag),\n    datalistId: "tag-suggestions",\n    addTitle: "Add tag",\n    placeholder: "Tag name",\n  },\n  mood: {\n    chips: () => state.moodTags,\n    setChips: (v) => { state.moodTags = v; },\n    cache: () => state.allMoodTagsCache,\n    setCache: (v) => { state.allMoodTagsCache = v; },\n    loadAll: () => apiAllMoodTags(),\n    add: (convId, tag) => apiAddMoodTag(convId, tag),\n    remove: (convId, tag) => apiRemoveMoodTag(convId, tag),\n    datalistId: "mood-tag-suggestions",\n    addTitle: "Add mood tag",\n    placeholder: "Mood tag",\n  },\n};\n\nfunction tagChip(group, convId, tag) {\n  const chip = document.createElement("span");\n  chip.className = "tag-chip";\n  const name = document.createElement("span");\n  name.className = "tag-chip-name";\n  name.textContent = tag;\n  const x = document.createElement("button");\n  x.className = "tag-chip-x";\n  x.type = "button";\n  x.title = `Remove ${tag}`;\n  x.setAttribute("aria-label", `Remove ${tag}`);\n  x.textContent = "✕";\n  x.addEventListener("click", () => removeConvTag(group, convId, tag));\n  chip.append(name, x);\n  return chip;\n}\n\nfunction tagAddButton(group, convId) {\n  const addBtn = document.createElement("button");\n  addBtn.className = "tag-add-btn";\n  addBtn.type = "button";\n  addBtn.title = TAG_GROUPS[group].addTitle;\n  addBtn.setAttribute("aria-label", TAG_GROUPS[group].addTitle);\n  addBtn.textContent = "+";\n  addBtn.addEventListener("click", () => showTagInput(group, convId, addBtn));\n  return addBtn;\n}\n\nfunction renderThreadTags() {\n  threadTags.innerHTML = "";\n  if (!state.activeId) return;\n  const convId = state.activeId;\n\n  const left = document.createElement("div");\n  left.className = "tags-left";\n  const leftLabel = document.createElement("span");\n  leftLabel.className = "tags-label";\n  leftLabel.textContent = "Tags:";\n  left.appendChild(leftLabel);\n  for (const tag of state.tags) left.appendChild(tagChip("tag", convId, tag));\n  left.appendChild(tagAddButton("tag", convId));\n\n  const right = document.createElement("div");\n  right.className = "tags-right";\n  const strip = document.createElement("div");\n  strip.className = "tags-mood";\n  const rightLabel = document.createElement("span");\n  rightLabel.className = "tags-label";\n  rightLabel.textContent = "Mood Tags:";\n  strip.appendChild(rightLabel);\n  for (const tag of state.moodTags)\n    strip.appendChild(tagChip("mood", convId, tag));\n  strip.appendChild(tagAddButton("mood", convId));\n  right.appendChild(strip);\n\n  threadTags.append(left, right);\n}\n\nasync function showTagInput(group, convId, addBtn) {\n  const g = TAG_GROUPS[group];\n  if (g.cache() === null) {\n    g.setCache(await g.loadAll().catch(() => []));\n  }\n  const form = document.createElement("form");\n  form.className = "tag-add-form";\n  const input = document.createElement("input");\n  input.className = "tag-add-input";\n  input.type = "text";\n  input.maxLength = 40;\n  input.placeholder = g.placeholder;\n  input.setAttribute("list", g.datalistId);\n  if (!$(g.datalistId)) {\n    const datalist = document.createElement("datalist");\n    datalist.id = g.datalistId;\n    document.body.appendChild(datalist);\n  }\n  const datalist = $(g.datalistId);\n  datalist.innerHTML = "";\n  for (const t of g.cache()) {\n    if (g.chips().includes(t)) continue;\n    const opt = document.createElement("option");\n    opt.value = t;\n    datalist.appendChild(opt);\n  }\n  form.appendChild(input);\n  addBtn.replaceWith(form);\n  input.focus();\n\n  let settled = false;\n  const finish = async () => {\n    if (settled) return;\n    settled = true;\n    const tag = input.value.trim();\n    if (tag) await addConvTag(group, convId, tag);\n    else renderThreadTags();\n  };\n  form.addEventListener("submit", (e) => {\n    e.preventDefault();\n    finish();\n  });\n  input.addEventListener("blur", finish);\n  input.addEventListener("keydown", (e) => {\n    if (e.key === "Escape") {\n      settled = true;\n      renderThreadTags();\n    }\n  });\n}\n\nasync function addConvTag(group, convId, tag) {\n  const g = TAG_GROUPS[group];\n  try {\n    const data = await g.add(convId, tag);\n    if (state.activeId !== convId) return;\n    g.setChips(data.tags || g.chips());\n    g.setCache(null);\n    renderThreadTags();\n  } catch {\n    renderThreadTags();\n  }\n}\n\nasync function removeConvTag(group, convId, tag) {\n  const g = TAG_GROUPS[group];\n  try {\n    const data = await g.remove(convId, tag);\n    if (state.activeId !== convId) return;\n    g.setChips(data.tags || g.chips().filter((t) => t !== tag));\n    renderThreadTags();\n  } catch {\n    /* leave the chip as-is if the write failed */\n  }\n}\n\n'''
app = replace_section(app, TAG_START, TAG_END, new_tag_block, "tag UI section")

for required in (
    "renderGizmoThreadIdentity(conv);",
    '(conv.gizmo_name || "Claude")',
):
    if required not in app:
        raise SystemExit(f"app gizmo invariant missing: {required}")
app_path.write_text(app, encoding="utf-8")


# ---------------------------------------------------------------------------
# static/style.css: true 50/50 columns plus right-anchored moving Mood group.
# ---------------------------------------------------------------------------
style_path = Path("static/style.css")
style = style_path.read_text(encoding="utf-8")
style = replace_once(
    style,
    "  --message-time-size: 11px;\n  --message-time-color: var(--muted);\n",
    "  --message-time-size: 11px;\n  --message-time-color: var(--muted);\n  --tag-row-font-size: 11.5px;\n  --tag-row-gap: 6px;\n",
    "tag layout variables",
)

STYLE_TAG_START = "/* ── Conversation tags ────────────────────────────────────────────────────── */\n"
STYLE_TAG_END = "/* ── Add Claude Models screen ─────────────────────────────────────────────── */\n"
new_tag_css = '''/* ── Conversation tags ────────────────────────────────────────────────────── */\n/* The grid makes the centre a hard boundary: ordinary Tags own the left half\n   and Mood Tags own the right half. */\n#thread-tags {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);\n  align-items: start;\n  gap: var(--tag-row-gap);\n  margin-top: 4px;\n  font-size: var(--tag-row-font-size);\n}\n\n#thread-tags:empty {\n  display: none;\n}\n\n#thread-tags .tags-left {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: var(--tag-row-gap);\n  min-width: 0;\n}\n\n/* The outer right half anchors the whole Mood Tags group to the right. */\n#thread-tags .tags-right {\n  display: flex;\n  justify-content: flex-end;\n  min-width: 0;\n}\n\n/* Shrink to the actual group width until it reaches its half. Because wrapping\n   happens inside this one left-to-right strip, every wrapped line starts from\n   the same moving left edge instead of independently right-aligning. */\n#thread-tags .tags-mood {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  justify-content: flex-start;\n  gap: var(--tag-row-gap);\n  width: fit-content;\n  max-width: 100%;\n  min-width: 0;\n}\n\n.tags-label {\n  color: var(--muted);\n  white-space: nowrap;\n}\n\n.tag-chip {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  padding: 2px 6px 2px 9px;\n  background: var(--bg);\n  border: 1px solid var(--border);\n  border-radius: 12px;\n  color: var(--text);\n}\n\n.tag-chip-name {\n  max-width: 160px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.tag-chip-x {\n  border: none;\n  background: none;\n  padding: 0 2px;\n  cursor: pointer;\n  color: var(--muted);\n  font-size: 0.85em;\n  line-height: 1;\n}\n\n.tag-chip-x:hover {\n  color: var(--accent);\n}\n\n.tag-add-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 18px;\n  height: 18px;\n  padding: 0;\n  border: 1px dashed var(--border);\n  border-radius: 12px;\n  background: none;\n  color: var(--muted);\n  cursor: pointer;\n  font-size: 12px;\n  line-height: 1;\n}\n\n.tag-add-btn:hover {\n  border-color: var(--accent);\n  color: var(--accent);\n}\n\n.tag-add-form {\n  display: inline-flex;\n}\n\n.tag-add-input {\n  font: inherit;\n  font-size: 11.5px;\n  color: var(--text);\n  background: var(--bg);\n  border: 1px solid var(--accent);\n  border-radius: 12px;\n  padding: 2px 8px;\n  width: 110px;\n}\n\n.tag-add-input:focus {\n  outline: none;\n}\n\n'''
style = replace_section(style, STYLE_TAG_START, STYLE_TAG_END, new_tag_css, "tag CSS section")

for required in (
    ".thread-meta-gizmo",
    "#thread-meta {",
):
    if required not in style:
        raise SystemExit(f"style gizmo invariant missing: {required}")
style_path.write_text(style, encoding="utf-8")

print("Mood Tags reconciled onto the current-main files with gizmo guards intact.")
