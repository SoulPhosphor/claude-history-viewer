import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import updater


def make_archive(files):
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        for name, data in files.items():
            archive.writestr(f"repo-version/{name}", data)
    return zipfile.ZipFile(io.BytesIO(payload.getvalue()))


class UpdaterTests(unittest.TestCase):
    def test_runtime_data_is_never_managed(self):
        self.assertFalse(updater._is_managed_file("source/conversations.json"))
        self.assertFalse(updater._is_managed_file("source/files/photo.png"))
        self.assertFalse(updater._is_managed_file("history.db"))
        self.assertFalse(updater._is_managed_file("userdata.db"))
        self.assertTrue(updater._is_managed_file("server.py"))
        self.assertTrue(updater._is_managed_file("static/app.js"))

    def test_no_update_does_not_download_or_write(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            content = b"current"
            (root / "server.py").write_bytes(content)
            remote = {"server.py": updater._git_blob_sha(content)}
            with mock.patch.object(updater, "_remote_tree", return_value=("abc123", remote)), \
                 mock.patch.object(updater, "_download_archive") as download:
                result = updater.check_and_update(root)
            self.assertEqual(result["status"], "no_update")
            self.assertEqual(result["message"], "No updates available.")
            download.assert_not_called()

    def test_remote_tree_resolves_branch_to_commit_before_archive(self):
        blob_sha = "1" * 40
        with mock.patch.object(
            updater,
            "_fetch_json",
            side_effect=[
                {"sha": "commit-sha"},
                {
                    "sha": "tree-sha",
                    "truncated": False,
                    "tree": [
                        {
                            "path": "server.py",
                            "type": "blob",
                            "sha": blob_sha,
                        }
                    ],
                },
            ],
        ) as fetch:
            commit_sha, files = updater._remote_tree()

        self.assertEqual(commit_sha, "commit-sha")
        self.assertEqual(files, {"server.py": blob_sha})
        self.assertEqual(fetch.call_args_list[0].args[0], f"{updater.API_ROOT}/commits/main")
        self.assertEqual(
            fetch.call_args_list[1].args[0],
            f"{updater.API_ROOT}/git/trees/commit-sha?recursive=1",
        )

    def test_update_replaces_code_and_preserves_data(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "server.py").write_bytes(b"old code")
            (root / "history.db").write_bytes(b"database")
            source = root / "source"
            source.mkdir()
            (source / "conversations.json").write_bytes(b"private chats")

            new_code = b"new code"
            remote = {"server.py": updater._git_blob_sha(new_code)}
            with mock.patch.object(updater, "_remote_tree", return_value=("abcdef123456", remote)), \
                 mock.patch.object(updater, "_download_archive", return_value=make_archive({"server.py": new_code})):
                result = updater.check_and_update(root)

            self.assertEqual(result["status"], "updated")
            self.assertEqual(result["message"], "Update successful!")
            self.assertEqual((root / "server.py").read_bytes(), new_code)
            self.assertEqual((root / "history.db").read_bytes(), b"database")
            self.assertEqual((source / "conversations.json").read_bytes(), b"private chats")


if __name__ == "__main__":
    unittest.main()
