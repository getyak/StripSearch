"""Run the actual release shell workflow against isolated fake Docker commands."""
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest


class ReleaseTests(unittest.TestCase):
    def test_failed_startup_and_revision_check_restore_before_old_image_starts(self):
        for mode in ('startup', 'revision'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                deploy = root / 'release' / 'deploy'
                deploy.mkdir(parents=True)
                data, backups, ops, settings = (root / name for name in ('data', 'backups', 'ops', 'settings'))
                for directory in (data, backups, ops, settings):
                    directory.mkdir()
                with sqlite3.connect(data / 'stripsearch.sqlite') as db:
                    db.execute('create table runs(id text)')
                    db.execute("insert into runs values('pre-upgrade')")
                (data / 'auth-secret').write_text('synthetic-stable-secret')
                (settings / 'runtime.env').write_text('synthetic-fixed-env')
                (ops / 'image.env').write_text('STRIPSEARCH_IMAGE=stripsearch:old\n')
                (ops / 'compose.yml').write_text('synthetic compose')
                replacements = {'/var/lib/stripsearch': str(data), '/var/backups/stripsearch': str(backups),
                                '/opt/stripsearch': str(ops), '/etc/stripsearch': str(settings),
                                '/etc/systemd/system': str(settings)}
                for name in ('release.sh', 'backup.py', 'restore.py'):
                    text = Path(__file__).with_name(name).read_text()
                    for old, new in replacements.items():
                        text = text.replace(old, new)
                    if name == 'restore.py':
                        text = text.replace('owner=1000)', 'owner=None)')
                    if name == 'backup.py':
                        text = text.replace('os.umask(0o077)',
                            "assert Path(os.environ['TEST_ROOT']).joinpath('service-state').read_text() == 'stopped'\nos.umask(0o077)")
                    (deploy / name).write_text(text)
                for name in ('compose.yml', 'stripsearch-backup.service', 'stripsearch-backup.timer'):
                    shutil.copyfile(Path(__file__).with_name(name), deploy / name)
                commands = root / 'bin'
                commands.mkdir()
                for name in ('chown', 'flock', 'systemctl'):
                    file = commands / name
                    file.write_text('#!/bin/sh\nexit 0\n')
                    file.chmod(0o755)
                docker = commands / 'docker'
                docker.write_text('''#!/usr/bin/env python3
import os,sys,sqlite3
from pathlib import Path
r=Path(os.environ['TEST_ROOT']); args=sys.argv[1:]
with (r/'commands.log').open('a') as f: f.write(' '.join(args)+'\\n')
if args[0]=='build': sys.exit(0)
assert args[0]=='compose'
if 'stop' in args:
    (r/'service-state').write_text('stopped'); sys.exit(0)
if 'exec' in args: sys.exit(1 if os.environ['TEST_FAILURE']=='revision' else 0)
assert 'up' in args
image=(r/'ops'/'image.env').read_text().strip().split('=',1)[1]
assert (r/'service-state').read_text()=='stopped'
with sqlite3.connect(r/'data'/'stripsearch.sqlite') as db:
    if image=='stripsearch:old':
        assert db.execute('select id from runs').fetchall()==[('pre-upgrade',)], 'old image received new scope data'
        assert (r/'data'/'auth-secret').read_text()=='synthetic-stable-secret'
        (r/'service-state').write_text('old-running'); sys.exit(0)
    db.execute("insert into runs values('new-scope-run')")
(r/'data'/'auth-secret').write_text('synthetic-failed-release-secret')
(r/'service-state').write_text('new-running')
sys.exit(1 if os.environ['TEST_FAILURE']=='startup' else 0)
''')
                docker.chmod(0o755)
                (root / 'service-state').write_text('old-running')
                env = dict(os.environ, TEST_ROOT=str(root), TEST_FAILURE=mode,
                           PATH=str(commands) + os.pathsep + os.environ['PATH'])
                result = subprocess.run(['bash', str(deploy / 'release.sh'), 'a' * 40],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual((root / 'service-state').read_text(), 'old-running')
                scenes = list((backups / 'failed-releases').glob('*/data'))
                self.assertEqual(len(scenes), 1)
                with sqlite3.connect(scenes[0] / 'stripsearch.sqlite') as db:
                    self.assertIn(('new-scope-run',), db.execute('select id from runs').fetchall())
                self.assertEqual((settings / 'runtime.env').read_text(), 'synthetic-fixed-env')
                self.assertEqual((ops / 'image.env').read_text(), 'STRIPSEARCH_IMAGE=stripsearch:old\n')


if __name__ == '__main__':
    unittest.main()
