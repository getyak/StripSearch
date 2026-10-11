"""Offline rollback regression: old runtimes must never receive new scope data."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_restore', Path(__file__).with_name('restore.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def seed(path, value):
    with sqlite3.connect(path) as db:
        db.execute('create table runs(id text, state text)')
        db.execute('insert into runs values(?, ?)', (value, 'queued'))


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.data, self.backups = root / 'data', root / 'backups'
        self.data.mkdir()
        self.snapshot = root / 'snapshot'
        self.snapshot.mkdir()
        seed(self.snapshot / 'stripsearch.sqlite', 'pre-upgrade')
        (self.snapshot / 'auth-secret').write_text('synthetic-old-secret')
        (self.snapshot / 'complete').touch()
        seed(self.data / 'stripsearch.sqlite', 'new-scope-run')
        (self.data / 'auth-secret').write_text('synthetic-new-secret')
        (self.data / 'operator-note').write_text('preserve unrelated state')

    def restore(self):
        return restore.restore_snapshot(self.snapshot, self.data, self.backups, 'a' * 40)

    def test_restores_old_state_and_preserves_failed_database_secret_and_journals(self):
        for suffix in ('-wal', '-shm', '-journal'):
            (self.data / f'stripsearch.sqlite{suffix}').write_bytes(b'synthetic failed-release journal')
        failed = self.restore()
        with sqlite3.connect(self.data / 'stripsearch.sqlite') as db:
            self.assertEqual(db.execute('select id from runs').fetchall(), [('pre-upgrade',)])
        self.assertEqual((self.data / 'auth-secret').read_text(), 'synthetic-old-secret')
        self.assertEqual((failed / 'data' / 'auth-secret').read_text(), 'synthetic-new-secret')
        self.assertEqual((self.data / 'operator-note').read_text(), 'preserve unrelated state')
        for suffix in ('-wal', '-shm', '-journal'):
            self.assertFalse((self.data / f'stripsearch.sqlite{suffix}').exists())
            self.assertTrue((failed / 'data' / f'stripsearch.sqlite{suffix}').exists())
        with sqlite3.connect(failed / 'data' / 'stripsearch.sqlite') as db:
            self.assertEqual(db.execute('select id from runs').fetchall(), [('new-scope-run',)])
        self.assertEqual(failed.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.data / 'stripsearch.sqlite').stat().st_mode & 0o777, 0o600)

    def test_incomplete_or_corrupt_snapshot_never_changes_live_data(self):
        before = (self.data / 'stripsearch.sqlite').read_bytes()
        (self.snapshot / 'complete').unlink()
        with self.assertRaises(RuntimeError):
            self.restore()
        (self.snapshot / 'complete').touch()
        (self.snapshot / 'stripsearch.sqlite').write_bytes(b'not sqlite')
        with self.assertRaises(sqlite3.DatabaseError):
            self.restore()
        self.assertEqual((self.data / 'stripsearch.sqlite').read_bytes(), before)
        self.assertEqual((self.data / 'auth-secret').read_text(), 'synthetic-new-secret')

    def test_failed_preservation_never_changes_live_data(self):
        before = (self.data / 'stripsearch.sqlite').read_bytes()
        with patch.object(restore.shutil, 'copytree', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                self.restore()
        self.assertEqual((self.data / 'stripsearch.sqlite').read_bytes(), before)
        self.assertEqual((self.data / 'auth-secret').read_text(), 'synthetic-new-secret')

    def test_env_secret_snapshot_removes_generated_new_file(self):
        (self.snapshot / 'auth-secret').unlink()
        failed = self.restore()
        self.assertFalse((self.data / 'auth-secret').exists())
        self.assertTrue((failed / 'data' / 'auth-secret').exists())

    def test_symlink_snapshot_database_is_refused(self):
        (self.snapshot / 'stripsearch.sqlite').unlink()
        (self.snapshot / 'stripsearch.sqlite').symlink_to(self.data / 'stripsearch.sqlite')
        with self.assertRaises(RuntimeError):
            self.restore()


if __name__ == '__main__':
    unittest.main()
