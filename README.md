# Claude History Viewer

A fully local web app for browsing and searching your own Claude conversation history.

Core runtime has **no required third-party dependencies**: Python 3.9+ and SQLite only.

This public starter contains only the code and placeholder folders needed to run the app. Add your own export data before launching it.

---

## Setup

1. **Prepare your export**
  Go to Claude > Settings > Privacy > Export Data.

  Unzip the archive and place `conversations.json` inside `source/`:

  ```text
  claude-history/
  ├── source/
  │   └── conversations.json   <- your Claude export
  ├── app.py
  └── ...
   ```

1. **Run**

   ```bash
   python3 app.py
   ```

  On first run, the app builds a local SQLite full-text search index (`history.db`).
  For large exports this may take 20-40 seconds; subsequent starts are fast.

1. The browser opens automatically at **[http://127.0.0.1:5174](http://127.0.0.1:5174)**

If you want to keep the starter completely clean, leave the placeholder `source/README.md` in place and add only your own export files.

---

## Features

- **Fast, meaningful search** - FTS5 + Porter stemming across conversation text and attachment text, so relevant threads surface quickly.
- **Conversation views that match your workflow** - Recent / Pinned / Archived / Deleted / All, with smooth pagination for large exports.
- **Pinning with manual ordering** - Keep long-lived threads at the top in the order you choose.
- **Workspace tabs**
  - Top tabs are **content tabs only** (conversation + artifact)
  - Bottom-left quick buttons open **transient views** (they do not create top tabs)
  - Re-clicking a quick view exits cleanly back to your previous content context
- **Rich message rendering**
  - Markdown: headings, bold/italic, lists, blockquotes, horizontal rules, strikethrough
  - Fenced code blocks with language labels and one-click **copy button**
  - Tables with horizontal scroll for wide content blocks
  - Math via KaTeX (`$...$`, `$$...$$`, `\\(...\\)`, `\\[...\\]`)
  - Inline code, links, images
- **Media Hub (`/api/gallery`)**
  - Grouped by conversation to preserve context
  - Three sections: conversation images / attachments / artifacts
  - One-click jump-back to the source conversation or message position
- **Attachment Report**
  - Detects unresolved attachments (no extracted content and no local file)
  - Supports one-click upload into `source/files/` for targeted repair
- **Claude model tagging** (Claude exports only)
  - Tag each conversation with the model(s) it was written with, from the header line
  - Only models that claude.ai actually offered during the conversation are listed
  - **Add Claude Models** (ⓘ menu) edits that availability list — add a model, change dates, delete a row
  - Two black icons flag a tagging that no longer matches those dates:
    a caution sign when a tagged model was never available during the conversation,
    a report icon when the tagged models don't cover it end to end
  - Either can be dismissed per conversation, and returns if the tagging goes wrong again
  - **Unverified Models** joins the sidebar filter while any conversation is flagged
- **Memories / Projects panels**
  - Quick side views for workspace-level memory and project browsing
- **Artifact viewer**
  - Open by artifact id
  - Includes a visible source-conversation return link
- **Keyboard navigation** - `/` to focus search, `Esc` to clear search, plus list navigation shortcuts

---

## Optional dependency

DOCX text preview in `/api/file-content` uses `python-docx` when available:

```bash
pip install python-docx
```

If it is not installed, only DOCX preview is unavailable; all other features continue to work.

## Included data layout

The starter keeps the directory structure expected by the app, but it does not ship with private data. Add only your own files in these locations:

- `source/conversations.json` - required Claude export
- `source/files/` - optional local attachments and uploaded replacements
- `source/projects/` - optional project export data
- `source/memories.json` - optional memory data, if your export includes it
- `source/users.json` - optional user metadata, if your export includes it

---

## Where model data is stored

Model availability, per-conversation model tags, and dismissed warnings all live
in `userdata.db`, a sibling of `history.db`. `claude_models.json` seeds that
database the first time the app runs and is never read again, so edits made on
the **Add Claude Models** screen are permanent and are not overwritten by the
shipped file.

`userdata.db` survives `history.db` being rebuilt or deleted, and carries this
data between browsers and machines — copy it alongside your export and your
tags, dates, and dismissals come with it.

---

## Rebuilding the index

If you receive a new export or want to rebuild from scratch:

```bash
rm -f history.db && python3 app.py
```

---

## Workspace cleanup (local)

```bash
find . -type d -name '__pycache__' -prune -exec rm -rf {} +
find . -type f -name '*.pyc' -delete
rm -rf .venv
rm -f history.db
find . -name '.DS_Store' -delete
```

---

## Quick troubleshooting

1. **`source/conversations.json` not found**
  Ensure the export file exists at `source/conversations.json`.

1. **First launch is slow**
  Expected behavior on large exports while `history.db` is being built.

1. **Attachment cannot be displayed**
  Open Attachment Report and upload the matching file into `source/files/`.

1. **DOCX preview unavailable**
  Install `python-docx` (`pip install python-docx`) or download/open the file externally.

1. **UI state looks stale after data changes**
  Rebuild index: `rm -f history.db && python3 app.py`.

---

## File overview

| File                | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `app.py`            | Entry point - builds index if needed, starts server, opens browser |
| `claude_models.json`| Starting list of Claude models and the dates they were offered     |
| `build_db.py`       | Parses `conversations.json` -> SQLite + FTS5 index                 |
| `server.py`         | stdlib HTTP server with JSON APIs                                  |
| `static/index.html` | App shell                                                          |
| `static/style.css`  | UI styles                                                          |
| `static/app.js`     | Frontend state, rendering, tabs, quick views, interactions         |

---

## API

Main endpoints consumed by the frontend:

```text
GET    /api/conversations?q=<query>&limit=50&offset=0&view=recent
GET    /api/conversation/<id>
GET    /api/search?q=<query>
GET    /api/search-in-conversation?conv_id=<id>&q=<query>
GET    /api/gallery
GET    /api/attachment-report
GET    /api/memories
GET    /api/projects
GET    /api/project/<id>
GET    /api/artifact/<id>
GET    /api/claude-models
GET    /api/conversation-models?conv_id=<id>
GET    /api/preferences
GET    /api/pinned
GET    /api/tabs
GET    /api/files-manifest
GET    /api/file-content?name=<filename>
GET    /files/<filename>
GET    /chatfiles/<filename>
GET    /source/<file_id>

POST   /api/upload-file
POST   /api/pinned
POST   /api/pinned/reorder
POST   /api/claude-models
POST   /api/conversation-models
POST   /api/conversation-models/dismiss
POST   /api/tabs
PATCH  /api/preferences
PATCH  /api/conversation/<id>
PATCH  /api/tabs/<id>
PATCH  /api/claude-models/<period_id>
DELETE /api/pinned/<conversation_id>
DELETE /api/tabs/<id>
DELETE /api/claude-models/<period_id>
DELETE /api/conversation-models/<conv_id>/<model_id>
```

---

## Claude export format notes

The parser in `build_db.py` targets Claude export structures centered on:

- conversation metadata (`uuid`, `name`, `created_at`, `updated_at`)
- `chat_messages`
- message `content` blocks (primarily text content)
- attachments and artifact tool operations

Non-display/system-style blocks (for example `thinking`, `tool_use`, `tool_result`) are filtered from normal rendering/indexing paths where appropriate.
