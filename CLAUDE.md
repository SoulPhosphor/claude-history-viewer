# Working notes for Claude

## Interaction

- **Never use the AskUserQuestion multiple-choice popup in this repo.** It blocks
  the user from sending normal messages (including screenshots) while it is open,
  which is disruptive. If something is unclear, state your understanding in plain
  chat, ask in plain prose if you truly must, and let the user reply normally — or
  just make a reasonable call, implement it, and explain what you did so they can
  redirect.

## Project layout

- Static single-page frontend lives in `static/` (`index.html`, `app.js`,
  `style.css`). No build step — plain JS/CSS.
- `server.py` is the Python HTTP server + SQLite-backed API (`/api/...`).
- `build_db.py` imports a Claude export into the SQLite DB.

## Domain vocabulary (easy to confuse)

- **Tabs** = the chips across the **top of the screen** (`#tabs-wrap` / `#tabs-list`
  in `index.html`, `renderTabs()` in `app.js`). This is what the user means by
  "the top of the screen."
- **Compare** = attach a conversation to the top bar as a chip (title + ×, no pin
  icon) so it can be browsed quickly. Membership lives **only** in `localStorage`
  (`state.compare`, key `compareConversations`) and is fully decoupled from the
  server-backed tab store — never write it there or restore it from there. The
  server tab store still exists for internal navigation/restore and for artifact
  tabs (which do still render in the top bar).
- **Pinning** (the sidebar star ☆/★, the "Pinned" filter, folder pins) is a
  separate feature and stays as-is.
