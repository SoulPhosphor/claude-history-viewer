#!/usr/bin/env python3
"""
Claude History Viewer
=====================
Place your exported conversations.json in a source/ directory, then run:

    python3 app.py

Requires Python 3.9+. No third-party packages needed.
"""
import os
import sys
import threading
import webbrowser
from pathlib import Path

DB_PATH = Path("history.db")
SOURCE  = Path("source") / "conversations.json"
# Preferred port. CHV_PORT lets an auto-restart keep whatever port it ended up
# on (e.g. a fallback port chosen because another copy was still open), so the
# already-open browser tab reconnects to the same URL after the reload.
PORT    = int(os.environ.get("CHV_PORT", "5174"))


def main() -> None:
    # conversations.json is only required for the very first build. Once
    # history.db exists, new backups are brought in through the in-app
    # "Import New Chats" screen — which renames each imported file away from
    # conversations.json — so its absence at startup is normal from then on.
    if not DB_PATH.exists():
        if not SOURCE.exists():
            print(f"Error: {SOURCE} not found.")
            print("Export your Claude history and place conversations.json in source/")
            sys.exit(1)
        print("First run — building search index (may take ~30 s for large exports)…")
        from build_db import build
        build(SOURCE, DB_PATH)

    from server import serve

    print(f"Starting Claude History (preferred port {PORT}) …")

    def on_ready(actual_port: int) -> None:
        # Called once the server socket is bound and listening, so opening the
        # browser can no longer race a not-yet-started server. actual_port may
        # differ from PORT if another copy was still holding the preferred port.
        url = f"http://127.0.0.1:{actual_port}"
        print(f"✓ Ready — {url}  (leave this window open; Ctrl-C to quit)")
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()

    serve(port=PORT, db_path=DB_PATH, on_ready=on_ready)


if __name__ == "__main__":
    main()
