#!/usr/bin/env python3
"""Restore a verified pre-release snapshot after this app's writers are stopped."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


def restore_snapshot(snapshot, data, backups, revision, owner=None):
    snapshot, data, backups = map(Path, (snapshot, data, backups))
    if snapshot.is_symlink() or not (snapshot / 'complete').is_file():
        raise RuntimeError('snapshot is not complete')
    database = snapshot / 'stripsearch.sqlite'
    secret = snapshot / 'auth-secret'
    if not database.is_file() or database.is_symlink() or secret.is_symlink():
        raise RuntimeError('snapshot files must be regular files')
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('snapshot integrity check failed')
    if not data.is_dir() or data.is_symlink():
        raise RuntimeError('persistent data directory must be a regular directory')
    os.umask(0o077)
    failed_root = backups / 'failed-releases'
    failed_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    failed = failed_root / f'{revision}-{stamp}'
    # Stage the verified old state before touching live paths. Any failure leaves
    # the application stopped; callers must never start an old image on new data.
    with tempfile.TemporaryDirectory(prefix='.stripsearch-restore-', dir=data.parent) as tmp:
        stage = Path(tmp)
        shutil.copyfile(database, stage / 'stripsearch.sqlite')
        if secret.exists():
            shutil.copyfile(secret, stage / 'auth-secret')
        for file in stage.iterdir():
            file.chmod(0o600)
            if owner is not None:
                os.chown(file, owner, owner)
        # Preserve the complete stopped failure scene, including its WAL and
        # auth secret. This directory is outside the daily snapshot prune policy.
        failed.mkdir(mode=0o700)
        shutil.copytree(data, failed / 'data', symlinks=True)
        (failed / 'receipt.json').write_text(json.dumps({
            'failedRevision': revision, 'restoredSnapshot': snapshot.name,
            'status': 'preserved_before_restore'
        }) + '\n')
        for suffix in ('-wal', '-shm', '-journal'):
            (data / f'stripsearch.sqlite{suffix}').unlink(missing_ok=True)
        os.replace(stage / 'stripsearch.sqlite', data / 'stripsearch.sqlite')
        if secret.exists():
            os.replace(stage / 'auth-secret', data / 'auth-secret')
        else:
            # An env-supplied secret remains in runtime.env, which is untouched.
            (data / 'auth-secret').unlink(missing_ok=True)
        data.chmod(0o700)
        if owner is not None:
            os.chown(data, owner, owner)
        (failed / 'receipt.json').write_text(json.dumps({
            'failedRevision': revision, 'restoredSnapshot': snapshot.name,
            'status': 'restored'
        }) + '\n')
    return failed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('revision')
    args = parser.parse_args()
    if len(args.revision) != 40 or any(c not in '0123456789abcdef' for c in args.revision):
        parser.error('expected a full Git revision')
    preserved = restore_snapshot(args.snapshot, '/var/lib/stripsearch',
                                 '/var/backups/stripsearch', args.revision, owner=1000)
    print(f'Restored verified snapshot; failed release preserved: {preserved}')
