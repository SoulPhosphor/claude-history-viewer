# Source Data Placeholder

Put your own export(s) here before running the app. Both Claude and ChatGPT
histories are supported and stay clearly separated in the viewer (switch between
them with the Claude / ChatGPT selector at the top of the sidebar).

Expected layout:

- source/conversations.json (your Claude export — or a ChatGPT export; the
  format is auto-detected)
- source/files/ (optional local file uploads)
- source/projects/ (optional project exports)
- source/memories.json (if present in your export)
- source/users.json (if present in your export)

## Adding a ChatGPT export alongside Claude

To view both histories in one app, keep your Claude `conversations.json` at
`source/conversations.json` and place your ChatGPT export's `conversations.json`
at any of these auto-discovered locations:

- source/chatgpt/conversations.json  (recommended)
- source/chatgpt.json
- source/chatgpt_conversations.json

(If your primary `source/conversations.json` is the ChatGPT export instead, put
the Claude one at `source/claude/conversations.json`.)

The ChatGPT export file can be large (hundreds of MB). It is git-ignored and
never needs to be committed. Re-running the build with a newer export refreshes
existing conversations in place — matched by their original ChatGPT
conversation ID — without duplicating them, and without discarding local state
such as pins, folders, or custom titles (those live in a separate
`userdata.db`).

## Custom GPTs (personas)

ChatGPT conversations started with a Custom GPT carry a stable `gizmo_id`, but
the export does **not** include a reliable human-readable name for it. The
viewer preserves the `gizmo_id` and lets you name each Custom GPT yourself:

- Open the ⋮ menu in the sidebar → **Custom GPTs** to see every Custom GPT in
  your history, name it, and optionally move all of its conversations into a
  folder in one click.
- You can also click the persona chip at the top of any Custom GPT conversation
  to name it inline.

A name applies to **every** conversation with that same `gizmo_id`, and — like
pins and folders — it is stored in `userdata.db`, so it survives rebuilds and
future re-imports. Names are never guessed from conversation titles.

## Preserving originals (future work)

ChatGPT has been known to alter or delete older messages. This viewer never
mutates imported message content — but a plain rebuild replaces old data with
whatever the current export contains. Until versioned/snapshot import exists,
**keep your original export file**: it is your source of record. A future
enhancement can snapshot each export immutably and diff a newer one against it
to flag altered or deleted assistant messages before you accept the change.
