#!/usr/bin/env python3
"""
Parse source/conversations.json → SQLite with FTS5.
Supports both ChatGPT and Claude export formats.

Schema
------
conversations(id, title, create_time, update_time, message_count, preview)
messages(id, conversation_id, role, content, create_time, seq)
search_index [fts5](conversation_id UNINDEXED, title, body)

Can also be run directly:
    python3 build_db.py [--source source/conversations.json] [--db history.db]
"""
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ── Content-type handling ──────────────────────────────────────────────────────

# Roles whose messages we never show
SKIP_ROLES = frozenset({"system", "tool"})

# Content types we silently ignore
SKIP_CONTENT_TYPES = frozenset({
    "thoughts",
    "reasoning_recap",
    "user_editable_context",
    "tether_browsing_display",
    "tether_quote",
    "code",           # tool invocation JSON (search, browser, etc.) — not user-facing
})


def message_text(content: dict) -> str:
    """Return displayable markdown text from a message content dict."""
    ct = (content or {}).get("content_type", "")

    if ct == "text":
        parts = content.get("parts", [])
        chunks = []
        for p in parts:
            if isinstance(p, str):
                # Canvas artifact parts arrive as a JSON string:
                # '{"name":"...", "type":"document", "content":"# markdown..."}'
                # Unwrap the inner markdown so it renders properly.
                stripped = p.strip()
                if stripped.startswith('{') and '"type"' in stripped and '"content"' in stripped:
                    try:
                        obj = json.loads(stripped)
                        if obj.get("type") in ("document", "canvas", "artifact") and isinstance(obj.get("content"), str):
                            chunks.append(obj["content"].strip())
                            continue
                    except (json.JSONDecodeError, AttributeError):
                        pass
                chunks.append(p)
            elif isinstance(p, dict):
                # Canvas / document artifacts embedded as dict parts
                doc = p.get("content") or p.get("text") or ""
                if isinstance(doc, str) and doc.strip():
                    chunks.append(doc.strip())
        return "\n\n".join(chunks).strip()

    if ct == "code":
        # Code interpreter / tool output — stored in content["text"] directly
        body = (content.get("text") or "").strip()
        lang = (content.get("language") or "").strip()
        return f"```{lang}\n{body}\n```" if body else ""

    if ct == "multimodal_text":
        chunks = []
        for p in content.get("parts", []):
            if isinstance(p, str):
                chunks.append(p)
            elif isinstance(p, dict):
                if p.get("content_type") == "image_asset_pointer":
                    ptr = p.get("asset_pointer", "")
                    # Strip URI schemes: sediment://file_XXX or file-service://file-XXX
                    file_id = (
                        ptr.replace("file-service://", "")
                           .replace("sediment://", "")
                           .split("#")[0]
                    )
                    if file_id:
                        chunks.append(f"![image](/source/{file_id})")
                elif p.get("type") in ("document", "canvas", "artifact"):
                    # Explicit canvas/document parts
                    doc = p.get("content") or p.get("text") or ""
                    if isinstance(doc, str) and doc.strip():
                        chunks.append(doc.strip())
                else:
                    text = p.get("text") or p.get("content") or ""
                    if isinstance(text, str) and text:
                        chunks.append(text)
        return "\n".join(c for c in chunks if c).strip()

    # Generic fallback: unknown content types that carry text directly
    # (e.g. content_type="document" or missing content_type)
    for key in ("text", "content"):
        val = content.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    return ""


# ── Format detection ──────────────────────────────────────────────────────────


def detect_format(data: list) -> str:
    """Return 'claude' or 'chatgpt' based on the first conversation's keys."""
    if not data:
        return "chatgpt"
    first = data[0]
    if "chat_messages" in first or ("uuid" in first and "name" in first):
        return "claude"
    return "chatgpt"


def detect_provider(data) -> str | None:
    """
    Identify a backup file *by its contents*, not its filename.

    Returns 'claude', 'chatgpt', or None. None means the payload is not a
    positively-recognized Claude or ChatGPT conversation export (for example a
    memories/users/projects file, an empty list, or arbitrary JSON) and must
    not be imported.

    The structural markers are mutually exclusive in practice:
      • Claude conversations carry `chat_messages` (and a `uuid` + `name`).
      • ChatGPT conversations carry a `mapping` tree with a `current_node`.
    A couple of leading dict entries are sampled so one malformed record does
    not defeat detection.
    """
    if not isinstance(data, list) or not data:
        return None
    for conv in data[:5]:
        if not isinstance(conv, dict):
            continue
        if "chat_messages" in conv:
            return "claude"
        if "mapping" in conv and "current_node" in conv:
            return "chatgpt"
        if "uuid" in conv and "name" in conv and "created_at" in conv:
            return "claude"
        if "mapping" in conv and ("title" in conv or "create_time" in conv):
            return "chatgpt"
    return None


# ── Claude format helpers ─────────────────────────────────────────────────────

# Claude content block types to skip
CLAUDE_SKIP_TYPES = frozenset({"thinking", "tool_use", "tool_result", "token_budget"})


def _iso_to_ts(s: str) -> float:
    """Convert ISO 8601 string (with optional Z) to a unix timestamp float."""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


_IMAGE_EXTS = frozenset({"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif"})


def claude_message_parts(msg: dict) -> tuple[str, list]:
    """
    Extract (text, attachments) from a Claude chat message.

    Returns:
        text        – plain message text only (no attachment content embedded)
        attachments – list of {name, type, content} dicts for chips/side-panel
    """
    is_assistant = msg.get("sender", msg.get("role", "")) == "assistant"
    text_chunks = []
    for block in (msg.get("content") or []):
        if not isinstance(block, dict):
            continue
        if block.get("type") in CLAUDE_SKIP_TYPES:
            continue
        if block.get("type") == "text":
            text = (block.get("text") or "").strip()
            if text:
                text_chunks.append(text)
    # NOTE: Never fall back to top-level msg["text"] for assistant messages.
    # That field contains Claude's internal verbalized thinking/planning notes,
    # not the user-facing response. For human messages it's also redundant
    # (human content blocks always have the text).  Drop the fallback entirely.

    # Build attachment list (each has name, type, content for side-panel).
    att_bag: Counter = Counter()
    attachments = []
    for att in (msg.get("attachments") or []):
        extracted = (att.get("extracted_content") or "").strip()
        name  = (att.get("file_name") or "").strip()
        ftype = (att.get("file_type") or "").strip()
        if extracted:
            # Use a friendly display name: prefer file_name, else "Pasted text", else type
            display_name = name or ("Pasted text" if ftype in ("txt", "text") else ftype or "file")
            attachments.append({"name": display_name, "type": ftype, "content": extracted})
            att_bag[name] += 1

    # Images / files without extracted content: chip referencing file by uuid.
    for fi in (msg.get("files") or []):
        fn   = (fi.get("file_name") or "").strip()
        uuid = (fi.get("file_uuid") or "").strip()
        ext  = fn.rsplit(".", 1)[-1].lower() if "." in fn else ""
        if att_bag[fn] > 0:
            att_bag[fn] -= 1
            continue
        display = fn or "Image"
        attachments.append({
            "name": display,
            "type": ext or "image",
            "content": "",
            "uuid": uuid,   # kept so frontend can request /source/files/<uuid>
        })

    # For assistant messages: extract output files from present_files tool_result
    # These are Claude-generated files (docx, etc.) referenced via local_resource blocks.
    if is_assistant:
        for block in (msg.get("content") or []):
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            rc = block.get("content") or []
            if isinstance(rc, str):
                continue
            for item in (rc if isinstance(rc, list) else []):
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "local_resource":
                    fp = item.get("file_path") or ""
                    ext = fp.rsplit(".", 1)[-1].lower() if "." in fp else ""
                    uuid = (item.get("uuid") or "").strip()
                    # Use the human-readable display name from the export
                    display_name = (item.get("name") or "").strip()
                    if not display_name:
                        display_name = fp.split("/")[-1] if fp else ""
                    if display_name:
                        # Append extension if not already present
                        if ext and not display_name.lower().endswith("." + ext):
                            display_name = f"{display_name}.{ext}"
                        attachments.append({
                            "name": display_name,
                            "type": ext,
                            "content": "",
                            "uuid": uuid,
                        })

    return "\n\n".join(text_chunks), attachments


def claude_artifact_ids(msg: dict) -> list[str]:
    """Return list of artifact IDs created in this assistant message."""
    ids = []
    for block in (msg.get("content") or []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use" and block.get("name") == "artifacts":
            inp = block.get("input") or {}
            if inp.get("command") == "create" and inp.get("id"):
                ids.append(inp["id"])
    return ids


def _apply_artifact_ops(msg: dict, msg_seq: int, state: dict):
    """
    Apply artifact operations from one assistant message to the running state dict.
    state: {artifact_id: {title, type, lang, content, msg_seq}}
    Artifacts are created once and updated/rewritten across subsequent messages.
    """
    for block in (msg.get("content") or []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use" and block.get("name") == "artifacts":
            inp = block.get("input") or {}
            aid = inp.get("id")
            if not aid:
                continue
            c = inp.get("command", "")
            if c == "create":
                state[aid] = {
                    "content": inp.get("content") or "",
                    "title":   inp.get("title") or "",
                    "type":    inp.get("type") or "",
                    "lang":    inp.get("language") or "",
                    "msg_seq": msg_seq,
                }
            elif aid in state:
                if c == "rewrite":
                    new_c = inp.get("content") or ""
                    if new_c:
                        state[aid]["content"] = new_c
                    if inp.get("title"):
                        state[aid]["title"] = inp["title"]
                    state[aid]["msg_seq"] = msg_seq
                elif c == "update":
                    old_s = inp.get("old_str", "")
                    new_s = inp.get("new_str", "")
                    content = state[aid]["content"]
                    if old_s in content:
                        state[aid]["content"] = content.replace(old_s, new_s, 1)
                    state[aid]["msg_seq"] = msg_seq


def _claude_active_path(conv: dict, cid: str, raw_msgs: list):
    """
    Parse a single Claude conversation dict using tree traversal.

    Claude's export stores all branch variants flat.  parent_message_uuid forms
    a tree; messages sharing the same UUID are human/assistant pairs in the same
    "turn slot".  Multiple children with the same (parent, sender) are retries.
    We walk the active path (always taking the LAST sibling = most recent edit)
    and record all siblings so the UI can show ← / → navigation.

    Returns (msgs, artifacts).  Returns ([], []) when no active path can be
    recovered — the caller decides how to fall back rather than dropping the
    conversation.
    """
    if not raw_msgs:
        return [], []

    # All message UUIDs in this conversation.
    msg_uuid_set = {m.get("uuid") for m in raw_msgs}

    # Group by (parent_uuid, sender) to detect sibling branches.
    # Messages whose parent is NOT in msg_uuid_set are root-level entries.
    VIRTUAL_ROOT = "__ROOT__"
    by_ps: dict[tuple, list] = {}
    for m in raw_msgs:
        p = m.get("parent_message_uuid") or ""
        p_key = p if p in msg_uuid_set else VIRTUAL_ROOT
        s = m.get("sender", "")
        by_ps.setdefault((p_key, s), []).append(m)

    def get_last(parent_key: str, sender: str):
        group = by_ps.get((parent_key, sender), [])
        return group[-1] if group else None

    def get_all(parent_key: str, sender: str):
        return by_ps.get((parent_key, sender), [])

    # ── Walk the active path ───────────────────────────────────────────────────
    result: list[dict] = []
    artifacts_out: list[dict] = []
    artifact_state: dict = {}   # {artifact_id: {title, type, lang, content, msg_seq}}
    seen: set[str] = set()
    seq = 0

    cur_human = get_last(VIRTUAL_ROOT, "human")
    if not cur_human:
        return [], []

    for _ in range(300):          # hard iteration cap
        h_uuid = cur_human.get("uuid", "")
        if h_uuid in seen:
            break
        seen.add(h_uuid)

        # Siblings at this human-message slot (same parent, sender=human)
        p_of_h = cur_human.get("parent_message_uuid") or ""
        p_key_of_h = p_of_h if p_of_h in msg_uuid_set else VIRTUAL_ROOT
        siblings_h = get_all(p_key_of_h, "human")
        b_idx_h = siblings_h.index(cur_human) + 1
        b_cnt_h = len(siblings_h)

        h_text, h_atts = claude_message_parts(cur_human)

        siblings_h_data = None
        if b_cnt_h > 1:
            sibs = []
            for sib in siblings_h:
                st, sa = claude_message_parts(sib)
                # Include the assistant response that goes with this user message version
                sib_uuid = sib.get("uuid", "")
                sib_asst = get_last(sib_uuid, "assistant")
                asst_text, asst_atts = claude_message_parts(sib_asst) if sib_asst else ("", [])
                asst_artifact_ids = claude_artifact_ids(sib_asst) if sib_asst else []
                sibs.append({
                    "content":          st,
                    "attachments":      sa,
                    "asst_content":     asst_text,
                    "asst_attachments": asst_atts,
                    "asst_artifact_ids": asst_artifact_ids,
                })
            siblings_h_data = json.dumps(sibs, ensure_ascii=False)

        if h_text or h_atts:
            result.append({
                "conversation_id": cid,
                "role":            "user",
                "content":         h_text,
                "attachments":     json.dumps(h_atts, ensure_ascii=False) if h_atts else None,
                "siblings":        siblings_h_data,
                "branch_index":    b_idx_h,
                "create_time":     _iso_to_ts(cur_human.get("created_at") or ""),
                "seq":             seq,
            })
            seq += 1

        # Assistant response to this human message
        # Claude compute-tool chains produce multiple consecutive assistant messages:
        #   human → assistant_1(bash_tool only) → assistant_2(bash_tool + final text)
        # Also, some siblings (retries) are dead-ends; we must find the sibling
        # whose chain actually leads to the next human turn.
        all_direct_siblings = get_all(h_uuid, "assistant")
        first_asst = None
        asst_chain: list = []
        nxt_from_chain = None

        if all_direct_siblings:
            # Try siblings in reverse (most recent first); pick the first one
            # whose chain connects to a human continuation.
            for cand in reversed(all_direct_siblings):
                chain: list = [cand]
                for _d in range(100):  # safety cap on chain depth
                    chain_next = get_last(chain[-1].get("uuid", ""), "assistant")
                    if chain_next is None:
                        break
                    chain.append(chain_next)
                lid = chain[-1].get("uuid", "")
                nxt = get_last(lid, "human")
                if nxt is not None:
                    first_asst = cand
                    asst_chain = chain
                    nxt_from_chain = nxt
                    break
            if first_asst is None:
                # No sibling leads to a continuation — use the last sibling
                first_asst = all_direct_siblings[-1]
                asst_chain = [first_asst]
                for _d in range(100):
                    chain_next = get_last(asst_chain[-1].get("uuid", ""), "assistant")
                    if chain_next is None:
                        break
                    asst_chain.append(chain_next)

        if first_asst:
            leaf_uuid = asst_chain[-1].get("uuid", "")

            # Siblings/retries are always at the first level (direct children of human)
            siblings_a = all_direct_siblings
            b_idx_a = siblings_a.index(first_asst) + 1
            b_cnt_a = len(siblings_a)

            # Collect text, attachments, and artifact IDs from the whole chain
            all_text_chunks: list[str] = []
            all_atts: list = []
            all_artifact_ids: list = []
            for node in asst_chain:
                node_text, node_atts = claude_message_parts(node)
                if node_text:
                    all_text_chunks.append(node_text)
                all_atts.extend(node_atts)
                all_artifact_ids.extend(claude_artifact_ids(node))
                _apply_artifact_ops(node, seq, artifact_state)

            a_text = "\n\n".join(all_text_chunks)
            a_atts = all_atts
            a_artifact_ids = list(dict.fromkeys(all_artifact_ids))  # dedupe, preserve order

            siblings_a_data = None
            if b_cnt_a > 1:
                sibs = []
                for sib in siblings_a:
                    st, sa = claude_message_parts(sib)
                    sibs.append({"content": st, "attachments": sa,
                                 "artifact_ids": claude_artifact_ids(sib)})
                siblings_a_data = json.dumps(sibs, ensure_ascii=False)

            if a_text or a_atts or a_artifact_ids:
                result.append({
                    "conversation_id": cid,
                    "role":            "assistant",
                    "content":         a_text,
                    "attachments":     json.dumps(a_atts, ensure_ascii=False) if a_atts else None,
                    "artifact_ids":    json.dumps(a_artifact_ids, ensure_ascii=False) if a_artifact_ids else None,
                    "siblings":        siblings_a_data,
                    "branch_index":    b_idx_a,
                    "create_time":     _iso_to_ts(first_asst.get("created_at") or ""),
                    "seq":             seq,
                })
                seq += 1

            # Next human: from the leaf's continuation (found during sibling search)
            nxt = nxt_from_chain if nxt_from_chain else get_last(leaf_uuid, "human")
            if nxt is None:
                nxt = get_last(h_uuid, "human")
            cur_human = nxt
        else:
            # No assistant yet; check for chained human (rare)
            cur_human = get_last(h_uuid, "human")

        if cur_human is None:
            break

    # Convert accumulated artifact state → output rows
    for aid, a in artifact_state.items():
        artifacts_out.append({
            "id":      aid,
            "conv_id": cid,
            "msg_seq": a["msg_seq"],
            "title":   a["title"],
            "type":    a["type"],
            "lang":    a["lang"],
            "content": a["content"],
        })

    return result, artifacts_out


# ── Synthetic IDs, fallback parsing, and meta ─────────────────────────────────


def _synthetic_id(conv: dict) -> str:
    """
    Deterministic synthetic ID for a conversation that has no Claude UUID.

    Based on a stable SHA-256 of the raw conversation object, so re-importing
    the same export always produces the same ID.  Two byte-for-byte identical
    raw records intentionally map to the same ID (see duplicate reporting).
    """
    canonical = json.dumps(conv, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"synthetic-{digest}"


def _claude_fallback_messages(conv: dict, cid: str, raw_msgs: list) -> list:
    """
    Recover displayable human/assistant messages when the branch parser cannot
    find an active path.  Ignores tree structure entirely: takes every message
    that yields text or attachments, ordered by timestamp then source order.
    """
    rows = []
    seq = 0
    # Drop non-dict entries before sorting: the sort key reads each entry, so a
    # single malformed one would raise here — inside the handler that is itself
    # the recovery path — and cost the conversation every recoverable message.
    ordered = sorted(
        ((i, m) for i, m in enumerate(raw_msgs) if isinstance(m, dict)),
        key=lambda pair: (_iso_to_ts(pair[1].get("created_at") or ""), pair[0]),
    )
    for _idx, m in ordered:
        sender = m.get("sender", m.get("role", ""))
        if sender not in ("human", "assistant"):
            continue
        text, atts = claude_message_parts(m)
        if not text and not atts:
            continue
        rows.append({
            "conversation_id": cid,
            "role":            "user" if sender == "human" else "assistant",
            "content":         text,
            "attachments":     json.dumps(atts, ensure_ascii=False) if atts else None,
            "artifact_ids":    None,
            "siblings":        None,
            "branch_index":    1,
            "create_time":     _iso_to_ts(m.get("created_at") or ""),
            "seq":             seq,
        })
        seq += 1
    return rows


def _claude_meta(conv: dict, cid: str, msgs: list, status: str) -> dict:
    """Build the conversations-table row for a Claude conversation."""
    preview = next(
        (m["content"][:300] for m in msgs if m["role"] == "user" and m["content"]),
        "",
    )
    if not preview:
        preview = next((m["content"][:300] for m in msgs if m["content"]), "")
    raw_name = (conv.get("name") or "").strip()
    if not raw_name and preview:
        raw_name = preview[:60].replace("\n", " ").strip()
    if not raw_name:
        raw_name = "Untitled"
    return {
        "id":            cid,
        "title":         raw_name,
        "create_time":   _iso_to_ts(conv.get("created_at") or ""),
        "update_time":   _iso_to_ts(conv.get("updated_at") or ""),
        "message_count": len(msgs),
        "preview":       preview,
        "import_status": status,
    }


def import_claude_conversation(conv: dict, index: int) -> dict:
    """
    Import one Claude conversation with full accounting — never drops a record.

    Returns a record dict:
        {meta, msgs, artifacts, status, synthetic, error, index}

    status is one of: normal | fallback | metadata_only | parse_error
    """
    raw_uuid = conv.get("uuid")
    if raw_uuid and str(raw_uuid).strip():
        cid = str(raw_uuid).strip()          # preserve the real Claude UUID exactly
        synthetic = False
    else:
        cid = _synthetic_id(conv)
        synthetic = True

    raw_msgs = conv.get("chat_messages") or []
    error = None

    try:
        active_msgs, active_arts = _claude_active_path(conv, cid, raw_msgs)
        if active_msgs:
            # Branch parser recovered messages (with text and/or attachments).
            msgs, artifacts, status = active_msgs, active_arts, "normal"
        else:
            # Branch parsing failed — try the structure-agnostic fallback.
            fb = _claude_fallback_messages(conv, cid, raw_msgs)
            if fb:
                msgs, artifacts, status = fb, [], "fallback"
            else:
                # Nothing displayable at all — keep as a metadata-only record.
                msgs, artifacts, status = [], [], "metadata_only"
    except Exception as e:  # noqa: BLE001 — must never let one record abort import
        error = f"{type(e).__name__}: {e}"
        try:
            msgs = _claude_fallback_messages(conv, cid, raw_msgs)
        except Exception:
            msgs = []
        artifacts, status = [], "parse_error"

    meta = _claude_meta(conv, cid, msgs, status)
    return {
        "meta":      meta,
        "msgs":      msgs,
        "artifacts": artifacts,
        "status":    status,
        "synthetic": synthetic,
        "error":     error,
        "index":     index,
    }


# ── Thread extraction ─────────────────────────────────────────────────────────


def extract_thread(mapping: dict, current_node: str) -> list:
    """
    Walk from current_node back to root via parent pointers.
    Returns messages in chronological order (root → leaf).
    Handles the branching case: current_node always points to the
    last message of the active branch.
    """
    path, seen = [], set()
    node_id = current_node
    while node_id and node_id in mapping and node_id not in seen:
        seen.add(node_id)
        node = mapping[node_id]
        if node.get("message"):
            path.append(node["message"])
        node_id = node.get("parent")
    path.reverse()
    return path


# ── Per-conversation parser ───────────────────────────────────────────────────


def parse_conversation(conv: dict, cid: str | None = None):
    """
    Returns (meta_dict, message_list) or (None, []) when the
    conversation has no usable messages.

    cid overrides the conversation's own id, which is how the importer hands
    over a synthesized one for a record that shipped without any id at all.
    """
    cid = cid or conv.get("id") or conv.get("conversation_id")
    if not cid:
        return None, []

    mapping     = conv.get("mapping") or {}
    current_node = conv.get("current_node")
    if not current_node:
        return None, []

    thread = extract_thread(mapping, current_node)

    msgs = []
    for seq, msg in enumerate(thread):
        role = (msg.get("author") or {}).get("role", "")
        if role in SKIP_ROLES:
            continue
        content = msg.get("content") or {}
        if content.get("content_type") in SKIP_CONTENT_TYPES:
            continue
        text = message_text(content)
        if not text:
            continue
        msgs.append({
            "conversation_id": cid,
            "role":            role,
            "content":         text,
            "attachments":     None,
            "siblings":        None,
            "branch_index":    1,
            "create_time":     msg.get("create_time") or 0,
            "seq":             seq,
        })

    if not msgs:
        return None, []

    preview = next(
        (m["content"][:300] for m in msgs if m["role"] == "user"), ""
    )
    meta = {
        "id":            cid,
        "title":         (conv.get("title") or "Untitled").strip(),
        "create_time":   conv.get("create_time") or 0,
        "update_time":   conv.get("update_time") or 0,
        "message_count": len(msgs),
        "preview":       preview,
    }
    return meta, msgs


def import_chatgpt_conversation(conv: dict, index: int) -> dict:
    """
    Import one ChatGPT conversation with the same never-drop accounting used for
    Claude, so the audit totals are consistent regardless of source format.

    status is one of: normal | metadata_only | parse_error
    """
    raw_id = conv.get("id") or conv.get("conversation_id")
    if raw_id and str(raw_id).strip():
        cid = str(raw_id).strip()
        synthetic = False
    else:
        cid = _synthetic_id(conv)
        synthetic = True

    error = None
    msgs = []
    try:
        # Pass cid explicitly: for a record with no id of its own the parser
        # would otherwise bail out and lose a perfectly good message tree.
        _meta, parsed = parse_conversation(conv, cid)
        if parsed:
            for m in parsed:
                m["conversation_id"] = cid
            msgs, status = parsed, "normal"
        else:
            status = "metadata_only"
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        msgs, status = [], "parse_error"

    title = (conv.get("title") or "").strip() or "Untitled"
    preview = next((m["content"][:300] for m in msgs if m["role"] == "user" and m["content"]), "")
    if not preview:
        preview = next((m["content"][:300] for m in msgs if m["content"]), "")
    meta = {
        "id":            cid,
        "title":         title,
        "create_time":   conv.get("create_time") or 0,
        "update_time":   conv.get("update_time") or 0,
        "message_count": len(msgs),
        "preview":       preview,
        "import_status": status,
    }
    return {
        "meta":      meta,
        "msgs":      msgs,
        "artifacts": [],
        "status":    status,
        "synthetic": synthetic,
        "error":     error,
        "index":     index,
    }


# ── Schema ────────────────────────────────────────────────────────────────────

SCHEMA = """\
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS search_index;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS project_docs;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS conversation_meta;
DROP TABLE IF EXISTS pinned_conversations;
DROP TABLE IF EXISTS ui_preferences;
DROP TABLE IF EXISTS workspace_tabs;

CREATE TABLE conversations (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    create_time   REAL,
    update_time   REAL,
    message_count INTEGER,
    preview       TEXT,
    import_status TEXT DEFAULT 'normal',
    source_index  INTEGER,
    -- 'claude' | 'chatgpt'. Conversation identity is (id, provider): the
    -- original stable UUID plus the tool it came from.
    provider      TEXT
);

CREATE TABLE conversation_meta (
    conversation_id TEXT PRIMARY KEY,
    custom_title    TEXT,
    archived        INTEGER DEFAULT 0,
    deleted         INTEGER DEFAULT 0,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE pinned_conversations (
    conversation_id TEXT PRIMARY KEY,
    pinned_at       REAL,
    order_index     INTEGER,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE ui_preferences (
    pref_key   TEXT PRIMARY KEY,
    pref_value TEXT
);

CREATE TABLE workspace_tabs (
    id             TEXT PRIMARY KEY,
    tab_type       TEXT NOT NULL,
    conversation_id TEXT,
    artifact_id    TEXT,
    title          TEXT,
    pinned         INTEGER DEFAULT 0,
    sort_index     INTEGER DEFAULT 0,
    last_active_at REAL,
    closed         INTEGER DEFAULT 0,
    -- Compare items cross providers, so each stores its own side for colouring.
    provider       TEXT
);

CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role            TEXT,
    content         TEXT,
    attachments     TEXT,
    artifact_ids    TEXT,
    siblings        TEXT,
    branch_index    INTEGER DEFAULT 1,
    create_time     REAL,
    seq             INTEGER
);

CREATE INDEX idx_msg_conv ON messages (conversation_id, seq);

CREATE VIRTUAL TABLE search_index USING fts5(
    conversation_id UNINDEXED,
    title,
    body,
    tokenize = 'trigram'
);

CREATE TABLE memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_uuid TEXT,
    content      TEXT
);

CREATE TABLE projects (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    create_time  REAL,
    update_time  REAL
);

CREATE TABLE project_docs (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename   TEXT,
    content    TEXT,
    create_time REAL
);

DROP TABLE IF EXISTS artifacts;

CREATE TABLE artifacts (
    id       TEXT PRIMARY KEY,
    conv_id  TEXT NOT NULL,
    msg_seq  INTEGER,
    title    TEXT,
    type     TEXT,
    lang     TEXT,
    content  TEXT
);

DROP TABLE IF EXISTS import_sources;

-- One row per top-level object in conversations.json, including the extras
-- collapsed away when several objects share an ID. `conversations` keeps one
-- row per distinct ID, so counting the audit from there would come out lower
-- than the source file; count it from here instead.
CREATE TABLE import_sources (
    source_index    INTEGER PRIMARY KEY,
    conversation_id TEXT,
    title           TEXT,
    import_status   TEXT,
    synthetic       INTEGER DEFAULT 0,
    kept            INTEGER DEFAULT 1,  -- 0 = collapsed duplicate of this ID
    -- Each source object's own counts and dates. Reading these off the winning
    -- conversations row instead would make a collapsed record report the
    -- winner's message count and dates, which is exactly what the audit is
    -- meant to let you check.
    create_time     REAL,
    update_time     REAL,
    message_count   INTEGER,
    preview         TEXT
);

CREATE INDEX idx_import_sources_status ON import_sources (import_status);

DROP TABLE IF EXISTS imported_backups;

-- One row per backup file brought in through the "Import New Chats" screen.
-- Drives the import-history table. `first_chat`/`last_chat` are unix
-- timestamps spanning every conversation/message in that file; `total_chats`
-- is how many conversations the file contained; the count columns are what
-- that one import did to the database.
CREATE TABLE imported_backups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name    TEXT,
    provider     TEXT,
    file_hash    TEXT,
    first_chat   REAL,
    last_chat    REAL,
    total_chats  INTEGER,
    imported_at  REAL,
    added        INTEGER DEFAULT 0,
    updated      INTEGER DEFAULT 0,
    unchanged    INTEGER DEFAULT 0,
    skipped      INTEGER DEFAULT 0,
    errors       INTEGER DEFAULT 0
);

CREATE INDEX idx_imported_backups_provider ON imported_backups (provider);
"""


# ── Build ─────────────────────────────────────────────────────────────────────


def build(source: Path, db_path: Path) -> None:
    print(f"Loading {source} …", flush=True)
    with open(source, encoding="utf-8") as f:
        data = json.load(f)

    fmt   = detect_format(data)
    total = len(data)
    print(f"{total} conversations found ({fmt} format). Indexing…", flush=True)

    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    # Recorded so the server can tell a Claude export from a ChatGPT one
    # without re-parsing the source file. Claude-only UI keys off this.
    db.execute(
        "INSERT OR REPLACE INTO ui_preferences(pref_key, pref_value) VALUES ('dataset_format', ?)",
        (json.dumps(fmt),),
    )

    # ── Pass 1: import every top-level conversation (never drop) ───────────────
    records: list[dict] = []
    for i, conv in enumerate(data):
        if i % 100 == 0:
            sys.stderr.write(f"\r  {i:>5}/{total}")
            sys.stderr.flush()

        if not isinstance(conv, dict):
            # Even a malformed top-level entry is accounted for, not dropped.
            records.append({
                "meta": {
                    "id": _synthetic_id({"__raw__": repr(conv), "__index__": i}),
                    "title": "Untitled", "create_time": 0, "update_time": 0,
                    "message_count": 0, "preview": "", "import_status": "parse_error",
                },
                "msgs": [], "artifacts": [], "status": "parse_error",
                "synthetic": True,
                "error": f"top-level entry is {type(conv).__name__}, not an object",
                "index": i,
            })
            continue

        if fmt == "claude":
            records.append(import_claude_conversation(conv, i))
        else:
            records.append(import_chatgpt_conversation(conv, i))

    sys.stderr.write(f"\r  {total}/{total}\n")

    # ── Pass 2: collapse only genuine exact-duplicate IDs, keeping the record
    #            with the most recovered messages (tie → earliest source index).
    by_id: dict[str, list] = defaultdict(list)
    for rec in records:
        by_id[rec["meta"]["id"]].append(rec)

    duplicates = {cid: recs for cid, recs in by_id.items() if len(recs) > 1}

    conv_rows, msg_rows, fts_rows = [], [], []
    artifact_rows: list[dict] = []
    source_rows = []
    for cid, recs in by_id.items():
        best = sorted(recs, key=lambda r: (-len(r["msgs"]), r["index"]))[0]
        meta, msgs, artifacts = best["meta"], best["msgs"], best["artifacts"]
        # Keep an audit row for every source object, not just the one that wins
        # the ID, so the audit's totals still match conversations.json and the
        # collapsed indices stay traceable.
        for rec in recs:
            rm = rec["meta"]
            source_rows.append((
                rec["index"], cid, rm["title"], rec["status"],
                1 if rec["synthetic"] else 0, 1 if rec is best else 0,
                rm.get("create_time"), rm.get("update_time"),
                rm.get("message_count"), rm.get("preview"),
            ))
        # Record which top-level object in conversations.json this row came from,
        # so an audit view can trace a DB record back to the exact source entry.
        meta["source_index"] = best["index"]
        # Every conversation in one build shares the file's detected provider.
        meta["provider"] = fmt
        conv_rows.append(meta)
        msg_rows.extend(msgs)
        artifact_rows.extend(artifacts)
        fts_rows.append((
            meta["id"],
            meta["title"],
            "\n".join(m["content"] for m in msgs),
        ))

    db.executemany(
        "INSERT OR REPLACE INTO conversations "
        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, provider) "
        "VALUES (:id, :title, :create_time, :update_time, :message_count, :preview, :import_status, :source_index, :provider)",
        conv_rows,
    )
    db.executemany(
        "INSERT INTO messages (conversation_id, role, content, attachments, artifact_ids, siblings, branch_index, create_time, seq) "
        "VALUES (:conversation_id, :role, :content, :attachments, :artifact_ids, :siblings, :branch_index, :create_time, :seq)",
        [{**m, "artifact_ids": m.get("artifact_ids")} for m in msg_rows],
    )
    db.executemany("INSERT INTO search_index VALUES (?, ?, ?)", fts_rows)
    db.executemany(
        "INSERT OR REPLACE INTO import_sources "
        "(source_index, conversation_id, title, import_status, synthetic, kept, "
        " create_time, update_time, message_count, preview) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        source_rows,
    )

    # Deduplicate artifacts by id (keep last version seen)
    seen_aids: set[str] = set()
    unique_artifacts = []
    for art in reversed(artifact_rows):
        if art["id"] not in seen_aids:
            seen_aids.add(art["id"])
            unique_artifacts.append(art)
    db.executemany(
        "INSERT OR REPLACE INTO artifacts (id, conv_id, msg_seq, title, type, lang, content) "
        "VALUES (:id, :conv_id, :msg_seq, :title, :type, :lang, :content)",
        unique_artifacts,
    )
    print(f"Artifacts indexed: {len(unique_artifacts)}")

    # ── Memories ──────────────────────────────────────────────────────────────
    memories_path = source.parent / "memories.json"
    if memories_path.exists():
        with open(memories_path, encoding="utf-8") as f:
            memories_data = json.load(f)
        if isinstance(memories_data, list):
            for entry in memories_data:
                content = (entry.get("conversations_memory") or "").strip()
                if content:
                    db.execute(
                        "INSERT INTO memories (account_uuid, content) VALUES (?, ?)",
                        (entry.get("account_uuid", ""), content),
                    )
        print(f"Memories indexed.")

    # ── Projects ──────────────────────────────────────────────────────────────
    projects_dir = source.parent / "projects"
    proj_count = 0
    if projects_dir.exists():
        for proj_file in sorted(projects_dir.glob("*.json")):
            with open(proj_file, encoding="utf-8") as f:
                proj = json.load(f)
            pid = proj.get("uuid")
            if not pid:
                continue
            db.execute(
                "INSERT OR REPLACE INTO projects VALUES (?, ?, ?, ?, ?)",
                (
                    pid,
                    (proj.get("name") or "Untitled Project").strip(),
                    (proj.get("description") or "").strip(),
                    _iso_to_ts(proj.get("created_at") or ""),
                    _iso_to_ts(proj.get("updated_at") or ""),
                ),
            )
            for doc in (proj.get("docs") or []):
                doc_id = doc.get("uuid")
                if not doc_id:
                    continue
                db.execute(
                    "INSERT OR REPLACE INTO project_docs VALUES (?, ?, ?, ?, ?)",
                    (
                        doc_id,
                        pid,
                        (doc.get("filename") or "").strip(),
                        (doc.get("content") or "").strip(),
                        _iso_to_ts(doc.get("created_at") or ""),
                    ),
                )
            proj_count += 1
        print(f"{proj_count} project(s) indexed.")

    # ── File index (removed — now handled inline above) ───────────────────────

    db.commit()
    db.close()

    # ── Import audit ───────────────────────────────────────────────────────────
    n_normal   = sum(1 for r in records if r["status"] == "normal")
    n_fallback = sum(1 for r in records if r["status"] == "fallback")
    n_meta     = sum(1 for r in records if r["status"] == "metadata_only")
    n_error    = sum(1 for r in records if r["status"] == "parse_error")
    n_synth    = sum(1 for r in records if r["synthetic"])
    db_total   = len(conv_rows)               # distinct records actually stored
    dup_extra  = sum(len(recs) - 1 for recs in duplicates.values())

    print("\n─── Import audit ───────────────────────────")
    print(f"Raw conversations: {total}")
    print(f"Normal imports:    {n_normal}")
    print(f"Fallback imports:  {n_fallback}")
    print(f"Metadata only:     {n_meta}")
    print(f"Synthetic IDs:     {n_synth}")
    print(f"Parse errors:      {n_error}")
    print(f"Database total:    {db_total}")
    print("────────────────────────────────────────────")

    # Every raw record carries exactly one status — these must sum to the total.
    accounted = n_normal + n_fallback + n_meta + n_error
    if accounted != total:
        print(f"WARNING: status counts ({accounted}) do not sum to raw total ({total}).")

    # Report duplicates explicitly instead of silently removing them.
    if duplicates:
        print(f"\nDuplicate source records: {len(duplicates)} ID(s), "
              f"{dup_extra} extra record(s) collapsed:")
        for cid, recs in duplicates.items():
            idxs = ", ".join(str(r["index"]) for r in recs)
            title = recs[0]["meta"]["title"]
            print(f"  id={cid}  title={title!r}  source indices=[{idxs}]")
        print(f"(Database total {db_total} + {dup_extra} duplicate(s) = {total} raw.)")

    # Any parse error names its source record so it can never disappear silently.
    if n_error:
        print(f"\nParse errors ({n_error}):")
        for r in records:
            if r["status"] != "parse_error":
                continue
            m = r["meta"]
            print(f"  index={r['index']}  id={m['id']}  title={m['title']!r}  "
                  f"error={r['error']}")

    print(f"\nDone — {db_total} conversations indexed → {db_path}")


# ── Incremental import (the "Import New Chats" screen) ─────────────────────────
#
# These reuse the same per-conversation parsers as the full build, but merge one
# backup file at a time into an existing database instead of rebuilding it.


def parse_backup(data: list, provider: str) -> list:
    """Parse every conversation object in one backup into importer records."""
    records: list[dict] = []
    for i, conv in enumerate(data):
        if not isinstance(conv, dict):
            continue
        if provider == "claude":
            records.append(import_claude_conversation(conv, i))
        else:
            records.append(import_chatgpt_conversation(conv, i))
    return records


def dedup_records(records: list) -> list:
    """Collapse exact-duplicate IDs within a single backup, keeping the record
    with the most recovered messages (tie → earliest source index) — the same
    rule the full build uses."""
    by_id: dict[str, list] = defaultdict(list)
    for rec in records:
        by_id[rec["meta"]["id"]].append(rec)
    out = []
    for _cid, recs in by_id.items():
        out.append(sorted(recs, key=lambda r: (-len(r["msgs"]), r["index"]))[0])
    return out


def backup_date_range(records: list) -> tuple[float | None, float | None]:
    """Earliest and latest timestamp across every conversation and message in a
    backup. Used for the import-history First/Last columns and for the date in
    the renamed filename (which is the latest message timestamp)."""
    times: list[float] = []
    for r in records:
        m = r["meta"]
        for t in (m.get("create_time"), m.get("update_time")):
            if t:
                times.append(t)
        for msg in r["msgs"]:
            t = msg.get("create_time")
            if t:
                times.append(t)
    if not times:
        return None, None
    return min(times), max(times)


def _delete_conv_rows(conn, cid: str) -> None:
    """Remove a conversation's derived rows before re-inserting on update. The
    conversations row itself is INSERT OR REPLACEd, so it is left in place."""
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM search_index WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM artifacts WHERE conv_id = ?", (cid,))


def _insert_conv_rows(conn, meta: dict, msgs: list, artifacts: list, provider: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO conversations "
        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, provider) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            meta["id"], meta["title"], meta.get("create_time"), meta.get("update_time"),
            meta.get("message_count"), meta.get("preview"),
            meta.get("import_status", "normal"), meta.get("source_index"), provider,
        ),
    )
    for m in msgs:
        conn.execute(
            "INSERT INTO messages "
            "(conversation_id, role, content, attachments, artifact_ids, siblings, branch_index, create_time, seq) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                m["conversation_id"], m.get("role"), m.get("content"), m.get("attachments"),
                m.get("artifact_ids"), m.get("siblings"), m.get("branch_index", 1),
                m.get("create_time"), m.get("seq"),
            ),
        )
    conn.execute(
        "INSERT INTO search_index (conversation_id, title, body) VALUES (?, ?, ?)",
        (meta["id"], meta["title"], "\n".join(m["content"] for m in msgs)),
    )
    for a in artifacts:
        conn.execute(
            "INSERT OR REPLACE INTO artifacts (id, conv_id, msg_seq, title, type, lang, content) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (a["id"], a["conv_id"], a.get("msg_seq"), a.get("title"),
             a.get("type"), a.get("lang"), a.get("content")),
        )


def _ts_close(a, b) -> bool:
    """Two conversation timestamps that mean the same instant. Exports round to
    the second, so anything under a second apart (and two missing values) is
    treated as equal."""
    if not a and not b:
        return True
    if not a or not b:
        return False
    return abs(float(a) - float(b)) < 1.0


def reconcile_backup(conn, records: list, provider: str) -> dict:
    """
    Merge one backup's records into an existing database, honoring conversation
    identity (id + provider) and the deletion flag.

      • UUID not present            → insert                     (added)
      • present, is_deleted = true  → skip, never resurrect      (skipped)
      • present, is_deleted = false → reconcile if content moved (updated)
                                       otherwise leave it alone   (unchanged)

    A backup that overlaps an older one therefore updates in place and never
    duplicates a conversation, and a conversation the user deleted stays gone.
    """
    counts = {"added": 0, "updated": 0, "unchanged": 0, "skipped": 0, "errors": 0}
    for r in records:
        try:
            meta = r["meta"]
            cid = meta["id"]
            msgs = r["msgs"]
            artifacts = r["artifacts"]
            existing = conn.execute(
                "SELECT title, update_time, message_count FROM conversations WHERE id = ?",
                (cid,),
            ).fetchone()
            if existing is None:
                _insert_conv_rows(conn, meta, msgs, artifacts, provider)
                counts["added"] += 1
                continue
            delrow = conn.execute(
                "SELECT deleted FROM conversation_meta WHERE conversation_id = ?",
                (cid,),
            ).fetchone()
            if delrow is not None and delrow[0]:
                counts["skipped"] += 1
                continue
            same = (
                (existing[0] or "") == (meta["title"] or "")
                and _ts_close(existing[1], meta.get("update_time"))
                and (existing[2] or 0) == (meta.get("message_count") or 0)
            )
            if same:
                counts["unchanged"] += 1
                continue
            _delete_conv_rows(conn, cid)
            _insert_conv_rows(conn, meta, msgs, artifacts, provider)
            counts["updated"] += 1
        except Exception:  # noqa: BLE001 — one bad record must not abort the merge
            counts["errors"] += 1
    return counts


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Build ChatGPT history search database")
    ap.add_argument("--source", default="source/conversations.json",
                    help="Path to conversations.json  (default: source/conversations.json)")
    ap.add_argument("--db",     default="history.db",
                    help="Output SQLite database path  (default: history.db)")
    args = ap.parse_args()
    build(Path(args.source), Path(args.db))
