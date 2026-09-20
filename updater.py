"""Safe, dependency-free updates for Claude History Viewer.

Only files that exist in the public GitHub repository are replaced. Runtime
data (the source folder, databases, exports, and local environment files) is
never part of an update.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import socket
import ssl
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


REPOSITORY = "SoulPhosphor/claude-history-viewer"
UPDATE_BRANCH = "main"
API_ROOT = f"https://api.github.com/repos/{REPOSITORY}"
USER_AGENT = "Claude-History-Viewer-Updater"
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

_UPDATE_LOCK = threading.Lock()
_PROTECTED_ROOT_NAMES = {
    "history.db",
    "userdata.db",
    ".env",
    ".env.local",
}
_PROTECTED_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
_PROTECTED_PARTS = {".git", "__pycache__"}


class UpdateError(Exception):
    """An update failure with a message intended for the app screen."""


def _request(url: str, timeout: int = 20):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    return urllib.request.urlopen(request, timeout=timeout)


def _read_limited(response, limit: int = MAX_DOWNLOAD_BYTES) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = response.read(min(1024 * 1024, limit - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise UpdateError("Update Failed: The update download was unexpectedly large.")
        chunks.append(chunk)
    return b"".join(chunks)


def _fetch_json(url: str) -> dict:
    with _request(url) as response:
        try:
            return json.loads(_read_limited(response).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UpdateError("Update Failed: GitHub returned invalid update information.") from exc


def _git_blob_sha(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


def _is_managed_file(path_text: str) -> bool:
    path = PurePosixPath(path_text)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        return False
    if any(part in _PROTECTED_PARTS for part in path.parts):
        return False
    if path.parts[0] == "source":
        return False
    if len(path.parts) == 1 and path.name in _PROTECTED_ROOT_NAMES:
        return False
    if path.suffix.lower() in _PROTECTED_SUFFIXES:
        return False
    return True


def _remote_tree() -> tuple[str, dict[str, str]]:
    data = _fetch_json(f"{API_ROOT}/git/trees/{UPDATE_BRANCH}?recursive=1")
    commit_sha = str(data.get("sha") or "").strip()
    tree = data.get("tree")
    if not commit_sha or not isinstance(tree, list) or data.get("truncated"):
        raise UpdateError("Update Failed: GitHub returned incomplete update information.")

    files = {}
    for entry in tree:
        path = str(entry.get("path") or "")
        sha = str(entry.get("sha") or "")
        if entry.get("type") == "blob" and sha and _is_managed_file(path):
            files[path] = sha
    if not files:
        raise UpdateError("Update Failed: No application files were found on GitHub.")
    return commit_sha, files


def _changed_files(app_root: Path, remote_files: dict[str, str]) -> list[str]:
    changed = []
    for relative, remote_sha in remote_files.items():
        local = app_root.joinpath(*PurePosixPath(relative).parts)
        try:
            local_sha = _git_blob_sha(local.read_bytes())
        except OSError:
            local_sha = ""
        if local_sha != remote_sha:
            changed.append(relative)
    return changed


def _download_archive(commit_sha: str) -> zipfile.ZipFile:
    with _request(f"{API_ROOT}/zipball/{commit_sha}", timeout=45) as response:
        payload = _read_limited(response)
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
        if archive.testzip() is not None:
            raise zipfile.BadZipFile
        return archive
    except zipfile.BadZipFile as exc:
        raise UpdateError("Update Failed: The downloaded update was damaged.") from exc


def _archive_member_map(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    members = {}
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if info.is_dir() or len(path.parts) < 2:
            continue
        relative = PurePosixPath(*path.parts[1:])
        if relative.is_absolute() or ".." in relative.parts:
            raise UpdateError("Update Failed: The downloaded update contained an unsafe path.")
        members[relative.as_posix()] = info
    return members


def _stage_files(
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
    remote_files: dict[str, str],
    changed: list[str],
    stage_root: Path,
) -> None:
    for relative in changed:
        info = members.get(relative)
        if info is None:
            raise UpdateError(f"Update Failed: A required application file was missing ({relative}).")
        data = archive.read(info)
        if _git_blob_sha(data) != remote_files[relative]:
            raise UpdateError("Update Failed: The update changed while it was downloading. Try again.")
        destination = stage_root.joinpath(*PurePosixPath(relative).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


def _apply_staged(app_root: Path, stage_root: Path, changed: list[str]) -> None:
    backup_root = stage_root.parent / "backup"
    replaced = []
    created = []

    # Front-end and support files go first. Backend files go last so the
    # existing auto-reloader cannot restart midway through the update.
    backend = {"server.py", "updater.py", "app.py", "build_db.py"}
    ordered = sorted(changed, key=lambda p: (PurePosixPath(p).name in backend, p == "server.py", p))
    try:
        for relative in ordered:
            parts = PurePosixPath(relative).parts
            source = stage_root.joinpath(*parts)
            destination = app_root.joinpath(*parts)
            destination.parent.mkdir(parents=True, exist_ok=True)

            if destination.exists():
                backup = backup_root.joinpath(*parts)
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(destination, backup)
                replaced.append(relative)
            else:
                created.append(relative)

            incoming = destination.with_name(f".{destination.name}.updating")
            shutil.copy2(source, incoming)
            os.replace(incoming, destination)
    except Exception:
        for relative in reversed(created):
            try:
                app_root.joinpath(*PurePosixPath(relative).parts).unlink(missing_ok=True)
            except OSError:
                pass
        for relative in reversed(replaced):
            try:
                parts = PurePosixPath(relative).parts
                shutil.copy2(backup_root.joinpath(*parts), app_root.joinpath(*parts))
            except OSError:
                pass
        raise


def check_and_update(app_root: Path | None = None) -> dict:
    """Check GitHub main and install changed application files when needed."""
    if not _UPDATE_LOCK.acquire(blocking=False):
        return {"status": "error", "message": "Update Failed: An update is already being checked."}

    try:
        root = (app_root or Path(__file__).resolve().parent).resolve()
        commit_sha, remote_files = _remote_tree()
        changed = _changed_files(root, remote_files)
        if not changed:
            return {"status": "no_update", "message": "No updates available."}

        archive = _download_archive(commit_sha)
        with archive, tempfile.TemporaryDirectory(prefix="chv-update-") as temp_dir:
            stage_root = Path(temp_dir) / "staged"
            stage_root.mkdir()
            members = _archive_member_map(archive)
            _stage_files(archive, members, remote_files, changed, stage_root)
            _apply_staged(root, stage_root, changed)
        return {
            "status": "updated",
            "message": "Update successful!",
            "version": commit_sha[:7],
        }
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            message = "Update Failed: GitHub's update limit was reached. Try again later."
        elif exc.code == 404:
            message = "Update Failed: The update files could not be found."
        else:
            message = "Update Failed: GitHub could not provide the update."
        return {"status": "error", "message": message}
    except (socket.timeout, TimeoutError):
        return {"status": "error", "message": "Update Failed: The connection timed out."}
    except ssl.SSLError:
        return {"status": "error", "message": "Update Failed: A secure connection could not be made."}
    except urllib.error.URLError:
        return {"status": "error", "message": "Update Failed: Internet not available."}
    except PermissionError:
        return {"status": "error", "message": "Update Failed: The app folder could not be changed."}
    except UpdateError as exc:
        return {"status": "error", "message": str(exc)}
    except OSError:
        return {"status": "error", "message": "Update Failed: The app files could not be replaced."}
    except Exception:
        return {"status": "error", "message": "Update Failed: An unexpected error occurred."}
    finally:
        _UPDATE_LOCK.release()
