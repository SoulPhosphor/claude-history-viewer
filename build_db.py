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
    ordered = sorted(
        enumerate(raw_msgs),
        key=lambda pair: (_iso_to_ts(pair[1].get("created_at") or ""), pair[0]),
    )
    for _idx, m in ordered:
        if not isinstance(m, dict):
            continue
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
        "source":        "claude",
        # Preserve the original Claude UUID exactly (None only for synthetic IDs).
        "source_conversation_id": (str(conv.get("uuid")).strip() or None) if conv.get("uuid") else None,
        # Claude has no Custom-GPT concept.
        "gizmo_id":   None,
        "gizmo_type": None,
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

    # Distinct models used, if the Claude export records them anywhere. Claude
    # exports do not always include a per-message model; when none is present
    # this stays empty (the models line simply shows nothing for that chat).
    models: list[str] = []
    seen_models: set = set()

    def _note_claude_model(m):
        if m and isinstance(m, str) and m not in seen_models:
            seen_models.add(m)
            models.append(m)

    _note_claude_model(conv.get("model"))
    for m in raw_msgs:
        if not isinstance(m, dict):
            continue
        _note_claude_model(m.get("model"))

    meta = _claude_meta(conv, cid, msgs, status)
    meta["models"] = json.dumps(models, ensure_ascii=False)
    return {
        "meta":      meta,
        "msgs":      msgs,
        "artifacts": artifacts,
        "status":    status,
        "synthetic": synthetic,
        "error":     error,
        "index":     index,
    }


# ── ChatGPT mapping-graph parser ──────────────────────────────────────────────
#
# ChatGPT exports store every message as a node in `mapping`, a tree linked by
# `parent`/`children`, with `current_node` pointing at the leaf of the active
# path. The tree preserves *all* branches:
#
#   • assistant rerolls  → a USER node with several assistant-child chains
#   • edited user turns  → an assistant-final (or root) node with several USER
#                          children
#
# A single assistant answer can itself be a *chain* of nodes
# (thoughts → tool/commentary → reasoning_recap → final text). We treat that
# whole chain as one response variant: the visible final text becomes the body,
# the thoughts/recap become the collapsible "Thinking" content, and the model /
# timestamp come from the visible answer node.
#
# We keep the active branch as the initially-displayed one and expose the
# alternatives through `siblings`, so the viewer can navigate rerolls and edits
# without the database throwing any branch away.

# Content types that carry user-presentable reasoning ("Thinking").
CHATGPT_THINKING_TYPES = frozenset({"thoughts", "reasoning_recap"})

# Roles that continue an assistant response chain (never shown on their own, but
# walked so a chain like thoughts → tool → final stays connected).
CHATGPT_CHAIN_ROLES = frozenset({"assistant", "tool", "system"})


def _cg_role(mapping: dict, node_id: str) -> str:
    node = mapping.get(node_id) or {}
    msg = node.get("message") or {}
    return ((msg.get("author") or {}).get("role") or "")


def _cg_hidden(msg: dict) -> bool:
    md = msg.get("metadata") or {}
    return bool(md.get("is_visually_hidden_from_conversation"))


def _cg_thinking_text(content: dict) -> str:
    """Extract displayable reasoning text from a thoughts/reasoning_recap block."""
    ct = (content or {}).get("content_type")
    if ct == "thoughts":
        chunks = []
        for t in content.get("thoughts") or []:
            if not isinstance(t, dict):
                continue
            summary = (t.get("summary") or "").strip()
            body = (t.get("content") or "").strip()
            if summary and body:
                chunks.append(f"**{summary}**\n\n{body}")
            elif summary or body:
                chunks.append(summary or body)
        return "\n\n".join(chunks).strip()
    if ct == "reasoning_recap":
        return (content.get("content") or "").strip()
    return ""


def _cg_attachments(msg: dict) -> list:
    """
    Preserve image/file references attached to a ChatGPT message.

    We keep the exported asset ID and the original filename so a media directory
    can be attached later. Missing physical files never abort the import; the
    reference is stored regardless of whether it currently resolves.
    """
    md = msg.get("metadata") or {}
    out = []
    for a in md.get("attachments") or []:
        if not isinstance(a, dict):
            continue
        name = (a.get("name") or "").strip()
        asset_id = (a.get("id") or "").strip()
        mime = (a.get("mime_type") or a.get("mimeType") or "").strip()
        if "." in name:
            ext = name.rsplit(".", 1)[-1].lower()
        elif "/" in mime:
            ext = mime.split("/")[-1].lower()
        else:
            ext = ""
        out.append({
            "name": name or asset_id or "file",
            "type": ext or "file",
            "content": "",
            "uuid": asset_id,   # exported asset id → future /source/<id> lookup
        })
    return out


def _cg_pick_active(active_ids: set, child_ids: list) -> str | None:
    """Return the child on the active path, else the last child (newest)."""
    for c in child_ids:
        if c in active_ids:
            return c
    return child_ids[-1] if child_ids else None


def _cg_collect_variant(mapping: dict, active_ids: set, root_id: str) -> dict:
    """
    Walk one assistant response chain starting at `root_id`.

    Returns a variant dict:
        {content, thinking, model, create_time, attachments, tail}
    where `tail` is the last node of the chain (whose children are the next
    user turn). Non-active chains follow their own newest child.
    """
    body_parts: list[str] = []
    think_parts: list[str] = []
    attachments: list = []
    model = None
    create_time = None
    visited: list[str] = []

    nid = root_id
    guard = 0
    while nid and nid in mapping and guard < 500:
        guard += 1
        visited.append(nid)
        msg = mapping[nid].get("message") or {}
        role = (msg.get("author") or {}).get("role") or ""
        content = msg.get("content") or {}
        ct = content.get("content_type")

        if role == "assistant":
            if ct in CHATGPT_THINKING_TYPES:
                tt = _cg_thinking_text(content)
                if tt:
                    think_parts.append(tt)
            elif ct in ("text", "multimodal_text") and not _cg_hidden(msg):
                bt = message_text(content)
                if bt:
                    body_parts.append(bt)
                m = (msg.get("metadata") or {}).get("model_slug")
                if m:
                    model = m          # last visible answer wins
                if msg.get("create_time"):
                    create_time = msg.get("create_time")
                attachments.extend(_cg_attachments(msg))
            # code / tool-plumbing content types are intentionally dropped here.

        # Advance along the chain: only assistant/tool/system children continue
        # this response. Any user children mark the next turn and stop the chain.
        kids = mapping[nid].get("children") or []
        chain_kids = [k for k in kids if _cg_role(mapping, k) in CHATGPT_CHAIN_ROLES]
        if not chain_kids:
            break
        nxt = _cg_pick_active(active_ids, chain_kids)
        if nxt is None or nxt in visited:
            break
        nid = nxt

    # Backfill model / timestamp from any node in the chain if the visible answer
    # did not carry them (e.g. an interrupted or unusual response).
    if model is None or create_time is None:
        for pid in visited:
            pm = mapping[pid].get("message") or {}
            if model is None:
                mm = (pm.get("metadata") or {}).get("model_slug")
                if mm:
                    model = mm
            if create_time is None and pm.get("create_time"):
                create_time = pm.get("create_time")

    return {
        "content": "\n\n".join(body_parts).strip(),
        "thinking": "\n\n".join(think_parts).strip(),
        "model": model,
        "create_time": create_time,
        "attachments": attachments,
        "tail": visited[-1] if visited else root_id,
    }


def _cg_user_parts(mapping: dict, node_id: str) -> tuple[str, list]:
    msg = mapping[node_id].get("message") or {}
    content = msg.get("content") or {}
    return message_text(content), _cg_attachments(msg)


def parse_chatgpt_conversation(conv: dict, cid: str) -> list:
    """
    Parse one ChatGPT conversation's mapping graph into ordered display rows,
    preserving assistant rerolls and edited-user-message branches.
    """
    mapping = conv.get("mapping") or {}
    current_node = conv.get("current_node")
    if not mapping or not current_node or current_node not in mapping:
        return []

    # Active-path node IDs (current_node → root).
    active_ids: set = set()
    nid = current_node
    guard = 0
    while nid and nid in mapping and nid not in active_ids and guard < 20000:
        guard += 1
        active_ids.add(nid)
        nid = mapping[nid].get("parent")

    # Topmost node (root) of the active path.
    root_id = current_node
    guard = 0
    while guard < 20000:
        guard += 1
        p = mapping[root_id].get("parent")
        if p and p in mapping:
            root_id = p
        else:
            break

    rows: list = []
    seq = 0

    def add_row(role, content, create_time, *, attachments=None, siblings=None,
                branch_index=1, meta=None):
        nonlocal seq
        rows.append({
            "conversation_id": cid,
            "role":            role,
            "content":         content,
            "attachments":     json.dumps(attachments, ensure_ascii=False) if attachments else None,
            "artifact_ids":    None,
            "siblings":        json.dumps(siblings, ensure_ascii=False) if siblings else None,
            "branch_index":    branch_index,
            "create_time":     create_time or 0,
            "seq":             seq,
            "meta":            json.dumps(meta, ensure_ascii=False) if meta else None,
        })
        seq += 1

    cursor = root_id
    seen_cursors: set = set()
    guard = 0
    while cursor is not None and guard < 10000:
        guard += 1
        if cursor in seen_cursors:
            break
        seen_cursors.add(cursor)

        node = mapping.get(cursor)
        if not node:
            break
        kids = node.get("children") or []
        user_kids = [k for k in kids if _cg_role(mapping, k) == "user"]

        if not user_kids:
            # No further user turn on this path — the conversation ends here.
            break

        active_user = _cg_pick_active(active_ids, user_kids)
        u_idx = user_kids.index(active_user) if active_user in user_kids else 0

        # ── User turn (with edited-message branches) ─────────────────────────
        u_text, u_atts = _cg_user_parts(mapping, active_user)
        u_meta = {"source": "chatgpt"}
        u_siblings = None
        if len(user_kids) > 1:
            u_siblings = []
            for uid in user_kids:
                st, sa = _cg_user_parts(mapping, uid)
                # Paired assistant answer for this user edit (its active reroll).
                a_kids = [k for k in (mapping[uid].get("children") or [])
                          if _cg_role(mapping, k) in CHATGPT_CHAIN_ROLES]
                asst_content = ""
                asst_meta = None
                if a_kids:
                    av = _cg_collect_variant(
                        mapping, active_ids, _cg_pick_active(active_ids, a_kids))
                    asst_content = av["content"]
                    asst_meta = {"source": "chatgpt", "model": av["model"],
                                 "create_time": av["create_time"],
                                 "thinking": av["thinking"]}
                u_siblings.append({
                    "content": st,
                    "attachments": sa,
                    "asst_content": asst_content,
                    "asst_meta": asst_meta,
                })
        if u_text or u_atts or u_siblings:
            add_row("user", u_text,
                    (mapping[active_user].get("message") or {}).get("create_time"),
                    attachments=u_atts or None, siblings=u_siblings,
                    branch_index=u_idx + 1, meta=u_meta)

        # ── Assistant turn (with rerolls) ────────────────────────────────────
        asst_kids = [k for k in (mapping[active_user].get("children") or [])
                     if _cg_role(mapping, k) in CHATGPT_CHAIN_ROLES]
        if not asst_kids:
            # User turn with no answer (e.g. last message). Advance to any user
            # continuation directly beneath it, else stop.
            cursor = active_user
            continue

        variants = [_cg_collect_variant(mapping, active_ids, k) for k in asst_kids]
        a_idx = 0
        for i, k in enumerate(asst_kids):
            if k in active_ids:
                a_idx = i
                break
        active_variant = variants[a_idx]

        a_meta = {
            "source": "chatgpt",
            "model": active_variant["model"],
            "thinking": active_variant["thinking"],
        }
        a_siblings = None
        if len(variants) > 1:
            a_siblings = [{
                "content": v["content"],
                "model": v["model"],
                "create_time": v["create_time"],
                "thinking": v["thinking"],
                "attachments": v["attachments"],
            } for v in variants]

        if active_variant["content"] or active_variant["attachments"] or active_variant["thinking"]:
            add_row("assistant", active_variant["content"],
                    active_variant["create_time"],
                    attachments=active_variant["attachments"] or None,
                    siblings=a_siblings, branch_index=a_idx + 1, meta=a_meta)

        cursor = active_variant["tail"]

    return rows


def import_chatgpt_conversation(conv: dict, index: int) -> dict:
    """
    Import one ChatGPT conversation with the same never-drop accounting used for
    Claude, so the audit totals are consistent regardless of source format.

    status is one of: normal | metadata_only | parse_error
    """
    raw_id = conv.get("id") or conv.get("conversation_id")
    if raw_id and str(raw_id).strip():
        cid = str(raw_id).strip()          # preserve the real ChatGPT ID exactly
        synthetic = False
    else:
        cid = _synthetic_id(conv)
        synthetic = True

    error = None
    msgs = []
    try:
        parsed = parse_chatgpt_conversation(conv, cid)
        if parsed:
            msgs, status = parsed, "normal"
        else:
            status = "metadata_only"
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        msgs, status = [], "parse_error"

    # Distinct models used across the conversation, including every reroll
    # variant, in first-appearance order.
    models: list[str] = []
    seen_models: set = set()

    def _note_model(m):
        if m and m not in seen_models:
            seen_models.add(m)
            models.append(m)

    for row in msgs:
        if row.get("role") != "assistant":
            continue
        try:
            meta = json.loads(row["meta"]) if row.get("meta") else {}
        except Exception:
            meta = {}
        _note_model(meta.get("model"))
        if row.get("siblings"):
            try:
                for v in json.loads(row["siblings"]):
                    _note_model(v.get("model"))
            except Exception:
                pass

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
        "source":        "chatgpt",
        # Preserve the original ChatGPT conversation ID exactly (None only when a
        # malformed record forced a synthetic fallback ID).
        "source_conversation_id": (str(raw_id).strip() or None) if raw_id else None,
        # Custom GPT identity, preserved exactly. gizmo_type distinguishes user
        # GPTs ('gpt') from OpenAI's built-in personalities ('snorlax').
        "gizmo_id":   (str(conv.get("gizmo_id")).strip() or None) if conv.get("gizmo_id") else None,
        "gizmo_type": (str(conv.get("gizmo_type")).strip() or None) if conv.get("gizmo_type") else None,
        "models":     json.dumps(models, ensure_ascii=False),
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
    -- 'claude' or 'chatgpt'. The two histories stay clearly separated in the UI;
    -- (source, source_conversation_id) is the real conversation identity.
    source        TEXT DEFAULT 'claude',
    -- The original conversation ID exactly as it appeared in the source export,
    -- preserved unchanged even when `id` had to be a synthetic fallback.
    source_conversation_id TEXT,
    -- ChatGPT Custom GPT ("gizmo") identity, preserved exactly from the export.
    -- One persona per conversation. Human-readable names are NOT stored here —
    -- they live in userdata.db keyed by gizmo_id so they survive rebuilds and a
    -- single rename applies to every conversation with the same gizmo.
    gizmo_id      TEXT,
    gizmo_type    TEXT,
    -- Distinct models used across the whole conversation (all assistant turns
    -- and rerolls), first-appearance order, as a JSON array.
    models        TEXT
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
    closed         INTEGER DEFAULT 0
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
    seq             INTEGER,
    -- Per-message extra display metadata as JSON. For ChatGPT assistant
    -- responses this carries {source:'chatgpt', model, thinking}; for reroll
    -- variants the same fields are repeated inside `siblings`. NULL for plain
    -- Claude messages.
    meta            TEXT
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
"""


# ── Build ─────────────────────────────────────────────────────────────────────


def discover_sources(primary: Path) -> list[Path]:
    """
    Return every conversation-export file to import, so one database can hold
    both a Claude and a ChatGPT history.

    Always includes `primary` (usually source/conversations.json) when it
    exists, plus conventional secondary locations for the *other* provider:

        source/chatgpt/conversations.json   source/chatgpt.json
        source/claude/conversations.json    source/claude.json

    The format of each file is detected from its contents, so it does not matter
    which provider a given file holds.
    """
    found: list[Path] = []
    seen: set = set()

    def add(p: Path) -> None:
        try:
            rp = p.resolve()
        except OSError:
            return
        if p.exists() and p.is_file() and rp not in seen:
            seen.add(rp)
            found.append(p)

    add(primary)
    base = primary.parent if primary.parent.name else Path("source")
    for extra in (
        base / "chatgpt" / "conversations.json",
        base / "chatgpt.json",
        base / "chatgpt_conversations.json",
        base / "claude" / "conversations.json",
        base / "claude.json",
        base / "claude_conversations.json",
    ):
        add(extra)
    return found


def build(source, db_path: Path) -> None:
    # `source` may be a single Path (back-compat) or an explicit list of Paths.
    if isinstance(source, (list, tuple)):
        sources = [Path(s) for s in source]
    else:
        sources = discover_sources(Path(source))
    if not sources:
        sources = [Path(source)]

    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)

    # ── Pass 1: import every top-level conversation from every source ──────────
    # A single global index keeps source_index unique across files so the audit
    # can trace any DB row back to its exact source entry.
    records: list[dict] = []
    total = 0
    gi = 0  # global running index across all source files
    for src in sources:
        print(f"Loading {src} …", flush=True)
        with open(src, encoding="utf-8") as f:
            data = json.load(f)
        fmt = detect_format(data)
        n = len(data)
        total += n
        print(f"  {n} conversations found ({fmt} format). Indexing…", flush=True)

        for j, conv in enumerate(data):
            if j % 100 == 0:
                sys.stderr.write(f"\r  {j:>5}/{n}")
                sys.stderr.flush()
            i = gi
            gi += 1

            if not isinstance(conv, dict):
                # Even a malformed top-level entry is accounted for, not dropped.
                records.append({
                    "meta": {
                        "id": _synthetic_id({"__raw__": repr(conv), "__index__": i}),
                        "title": "Untitled", "create_time": 0, "update_time": 0,
                        "message_count": 0, "preview": "", "import_status": "parse_error",
                        "source": fmt, "source_conversation_id": None,
                        "gizmo_id": None, "gizmo_type": None, "models": "[]",
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

        sys.stderr.write(f"\r  {n}/{n}\n")

    # ── Pass 2: collapse only genuine exact-duplicate IDs, keeping the record
    #            with the most recovered messages (tie → earliest source index).
    by_id: dict[str, list] = defaultdict(list)
    for rec in records:
        by_id[rec["meta"]["id"]].append(rec)

    duplicates = {cid: recs for cid, recs in by_id.items() if len(recs) > 1}

    conv_rows, msg_rows, fts_rows = [], [], []
    artifact_rows: list[dict] = []
    for cid, recs in by_id.items():
        best = sorted(recs, key=lambda r: (-len(r["msgs"]), r["index"]))[0]
        meta, msgs, artifacts = best["meta"], best["msgs"], best["artifacts"]
        # Record which top-level object in conversations.json this row came from,
        # so an audit view can trace a DB record back to the exact source entry.
        meta["source_index"] = best["index"]
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
        "(id, title, create_time, update_time, message_count, preview, import_status, source_index, source, source_conversation_id, gizmo_id, gizmo_type, models) "
        "VALUES (:id, :title, :create_time, :update_time, :message_count, :preview, :import_status, :source_index, :source, :source_conversation_id, :gizmo_id, :gizmo_type, :models)",
        conv_rows,
    )
    db.executemany(
        "INSERT INTO messages (conversation_id, role, content, attachments, artifact_ids, siblings, branch_index, create_time, seq, meta) "
        "VALUES (:conversation_id, :role, :content, :attachments, :artifact_ids, :siblings, :branch_index, :create_time, :seq, :meta)",
        [{**m, "artifact_ids": m.get("artifact_ids"), "meta": m.get("meta")} for m in msg_rows],
    )
    db.executemany("INSERT INTO search_index VALUES (?, ?, ?)", fts_rows)

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
    # Memories/projects live beside the primary export (the first source file).
    base_dir = sources[0].parent
    memories_path = base_dir / "memories.json"
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


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Build ChatGPT history search database")
    ap.add_argument("--source", default="source/conversations.json",
                    help="Path to conversations.json  (default: source/conversations.json)")
    ap.add_argument("--db",     default="history.db",
                    help="Output SQLite database path  (default: history.db)")
    args = ap.parse_args()
    build(Path(args.source), Path(args.db))
