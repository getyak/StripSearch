"""Offline regression tests for ownership, restart, Tailnet and data rollback."""
import json
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from local_service import Service, matches_install, snapshot_data, unrelated_routes
from restore import restore_snapshot


class LocalServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        with sqlite3.connect(self.data / 'stripsearch.sqlite') as db:
            db.execute('CREATE TABLE record(value TEXT)')
            db.execute("INSERT INTO record VALUES ('before')")
        (self.data / 'auth-secret').write_text('synthetic-secret')
        self.exe = self.root / 'executable'
        self.exe.touch()
        self.config = {'stateDir': str(self.root / 'state'), 'dataDir': str(self.data), 'origin': 'https://synthetic.synthetic.ts.net:14443', 'node': str(self.exe), 'npm': str(self.exe), 'tailscale': str(self.exe), 'envFile': str(self.exe)}
        self.service = Service(self.config, self.root / 'config.json')
        self.service.plist = self.root / 'web.plist'
        self.release = self.service.state / 'releases' / ('a' * 40)
        self.release.mkdir(parents=True)
        (self.release / 'complete').touch()
        self.service.select(self.release)

    def test_foreign_listener_is_not_stopped(self):
        with patch.object(self.service, 'listeners', return_value=[4321]), patch.object(self.service, 'owned_pid', return_value=False), patch.object(self.service, 'command') as command, patch('local_service.os.kill') as kill:
            with self.assertRaisesRegex(RuntimeError, 'foreign listener'):
                self.service.stop()
            command.assert_not_called()
            kill.assert_not_called()

    def test_start_is_idempotent_for_owned_listener(self):
        with patch.object(self.service, 'listeners', return_value=[4321]), patch.object(self.service, 'owned_pid', return_value=True), patch.object(self.service, 'command') as command:
            self.service.start()
            command.assert_not_called()

    def test_start_reuses_loaded_job_during_restart_backoff(self):
        self.service.plist.write_bytes(plistlib.dumps({'WorkingDirectory': str(self.release / 'apps/web')}))
        with patch.object(self.service, 'listeners', return_value=[]), patch.object(self.service, 'command', return_value=subprocess.CompletedProcess([], 0, 'state = waiting', '')) as command:
            self.service.start()
            self.assertEqual(command.call_args_list[-1].args[0], ['launchctl', 'kickstart', self.service.job])
            self.assertEqual(command.call_count, 2)

    def test_default_https_origin_uses_explicit_serve_port_key(self):
        self.config['origin'] = 'https://synthetic.synthetic.ts.net'
        service = Service(self.config, self.root / 'config.json')
        self.assertEqual(service.authority, 'synthetic.synthetic.ts.net:443')

    def test_repeated_update_still_verifies_tailnet_without_restart(self):
        with patch.object(self.service, 'build', return_value=self.release), patch.object(self.service, 'listeners', return_value=[4321]), patch.object(self.service, 'verify', return_value={'verified': True}) as verify, patch.object(self.service, 'stop') as stop:
            self.assertEqual(self.service.update(self.root, self.release.name), {'verified': True})
            verify.assert_called_once()
            stop.assert_not_called()

    def test_backup_failure_restarts_old_version_without_restoring_data(self):
        new = self.service.state / 'releases' / ('b' * 40)
        with patch.object(self.service, 'build', return_value=new), patch.object(self.service, 'rollback_release', return_value=self.release), patch.object(self.service, 'stop'), patch('local_service.snapshot_data', side_effect=OSError('disk full')), patch.object(self.service, 'start') as start, patch.object(self.service, 'ready'), patch.object(self.service, 'verify'), patch('local_service.restore_snapshot') as restore:
            with self.assertRaisesRegex(OSError, 'disk full'):
                self.service.update(self.root, new.name)
            start.assert_called_once()
            restore.assert_not_called()
            self.assertEqual(self.service.current(), self.release)

    def test_external_legacy_release_is_rejected_before_stopping(self):
        self.config['legacy'] = {'releaseDir': str(self.root / 'external')}
        (self.service.state / 'current').unlink()
        new = self.service.state / 'releases' / ('b' * 40)
        with patch.object(self.service, 'build', return_value=new), patch.object(self.service, 'stop') as stop:
            with self.assertRaisesRegex(RuntimeError, 'owned releases'):
                self.service.update(self.root, new.name)
            stop.assert_not_called()

    def test_failed_upgrade_preserves_failed_data_and_restores_old_secret(self):
        backup = self.root / 'backup'
        snapshot_data(self.data, backup)
        with sqlite3.connect(self.data / 'stripsearch.sqlite') as db:
            db.execute("UPDATE record SET value='failed-release'")
        (self.data / 'auth-secret').write_text('failed-secret')
        failed = restore_snapshot(backup, self.data, self.root / 'backups', 'a' * 40)
        with sqlite3.connect(self.data / 'stripsearch.sqlite') as db:
            self.assertEqual(db.execute('SELECT value FROM record').fetchone()[0], 'before')
        with sqlite3.connect(failed / 'data/stripsearch.sqlite') as db:
            self.assertEqual(db.execute('SELECT value FROM record').fetchone()[0], 'failed-release')
        self.assertEqual((self.data / 'auth-secret').read_text(), 'synthetic-secret')
        self.assertEqual((failed / 'data/auth-secret').read_text(), 'failed-secret')

    def test_unverified_snapshot_cannot_overwrite_data(self):
        incomplete = self.root / 'incomplete'
        incomplete.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'not complete'):
            restore_snapshot(incomplete, self.data, self.root / 'backups', 'b' * 40)
        self.assertEqual((self.data / 'auth-secret').read_text(), 'synthetic-secret')

    def test_tailnet_change_preserves_unrelated_routes(self):
        own = self.service.authority
        other = 'other.synthetic.ts.net:443'
        before = {'Web': {own: {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:4392'}}}, other: {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:1234'}}}}, 'TCP': {'14443': {'HTTPS': True}, '443': {'HTTPS': True}}}
        after = json.loads(json.dumps(before))
        def command(argv, check=True):
            return subprocess.CompletedProcess(argv, 0, json.dumps(before if argv[-1] == '--json' else {}), '')
        with patch.object(self.service, 'command', side_effect=command):
            self.service.reconcile_tailnet()
        self.assertEqual(unrelated_routes(before, own, 14443), unrelated_routes(after, own, 14443))
        self.assertEqual(json.loads((self.service.state / 'tailscale-verified.json').read_text())['Web'][other], before['Web'][other])

    def test_conflicting_tailnet_handler_is_not_overwritten(self):
        before = {'Web': {self.service.authority: {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:9999'}}}}}
        with patch.object(self.service, 'command', return_value=subprocess.CompletedProcess([], 0, json.dumps(before), '')) as command:
            with self.assertRaisesRegex(RuntimeError, 'conflicting handlers'):
                self.service.reconcile_tailnet()
            self.assertEqual(command.call_count, 1)

    def test_current_release_cannot_escape_owned_root(self):
        (self.service.state / 'current').unlink()
        (self.service.state / 'current').symlink_to(self.root)
        with self.assertRaisesRegex(RuntimeError, 'outside owned releases'):
            self.service.current()

    def test_on_demand_jobs_are_explicitly_kickstarted(self):
        tool = self.root / 'tool.plist'
        tool.write_bytes(plistlib.dumps({'Label': 'synthetic.tool', 'RunAtLoad': False, 'KeepAlive': False, 'WorkingDirectory': str(self.root)}))
        self.config['tools'] = {'annotation': {'jobs': [{'plist': str(tool), 'label': 'synthetic.tool'}], 'ports': [4501], 'httpsPort': 17443, 'proxy': 'http://127.0.0.1:4501'}}
        calls = []
        serve_calls = 0
        def command(argv, check=True):
            nonlocal serve_calls
            calls.append(argv)
            if argv[-1] == '--json':
                serve_calls += 1
                route = {} if serve_calls == 1 else {'Web': {'synthetic.synthetic.ts.net:17443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:4501'}}}}}
                return subprocess.CompletedProcess(argv, 0, json.dumps(route), '')
            return subprocess.CompletedProcess(argv, 3 if argv[:2] == ['launchctl', 'print'] else 0, '1234' if argv[0] == 'lsof' else '', '')
        with patch.object(self.service, 'command', side_effect=command), patch.object(self.service, 'tool_state', return_value=(False, None)), patch.object(self.service, 'tool_listener', return_value=[]), patch.object(self.service, 'tool_owned', return_value=True):
            self.service.tools('start', 'annotation')
        self.assertIn(['launchctl', 'kickstart', self.service.domain + '/synthetic.tool'], calls)

    def test_restore_failure_disables_restart_and_blocks_explicit_start(self):
        new = self.service.state / 'releases' / ('b' * 40)
        with patch.object(self.service, 'build', return_value=new), patch.object(self.service, 'rollback_release', return_value=self.release), patch.object(self.service, 'stop'), patch.object(self.service, 'start'), patch.object(self.service, 'ready', side_effect=RuntimeError('failed new version')), patch.object(self.service, 'command') as command, patch('local_service.restore_snapshot', side_effect=OSError('restore disk full')):
            with self.assertRaisesRegex(OSError, 'restore disk full'):
                self.service.update(self.root, new.name)
            command.assert_any_call(['launchctl', 'disable', self.service.job])
        self.assertTrue((self.service.state / 'recovery-required.json').is_file())
        with self.assertRaisesRegex(RuntimeError, 'recovery required'):
            self.service.start()

    def test_modified_hidden_install_lock_is_rejected(self):
        lock = self.root / 'lock.json'
        modules = self.root / 'modules'
        modules.mkdir()
        lock.write_text(json.dumps({'packages': {'': {}, 'node_modules/synthetic': {'version': '1.0.0', 'integrity': 'one'}}}))
        (modules / '.package-lock.json').write_text(json.dumps({'packages': {'node_modules/synthetic': {'version': '2.0.0', 'integrity': 'two'}}}))
        self.assertFalse(matches_install(lock, modules))

    def test_missing_actual_module_is_rejected_even_with_matching_lock(self):
        lock = self.root / 'lock.json'
        modules = self.root / 'modules'
        modules.mkdir()
        data = {'packages': {'node_modules/synthetic': {'version': '1.0.0'}}}
        lock.write_text(json.dumps(data))
        (modules / '.package-lock.json').write_text(json.dumps(data))
        self.assertFalse(matches_install(lock, modules))

    def configure_tool(self, name='synthetic.tool'):
        tool = self.root / (name + '.plist')
        tool.write_bytes(plistlib.dumps({'Label': name, 'RunAtLoad': False, 'KeepAlive': False, 'WorkingDirectory': str(self.root)}))
        return {'plist': str(tool), 'label': name}

    def test_foreign_auxiliary_listener_is_never_exposed(self):
        job = self.configure_tool()
        self.config['tools'] = {'annotation': {'jobs': [job], 'ports': [4501], 'httpsPort': 17443, 'proxy': 'http://127.0.0.1:4501'}}
        with patch.object(self.service, 'command', return_value=subprocess.CompletedProcess([], 0, '{}', '')) as command, patch.object(self.service, 'tool_state', return_value=(False, None)), patch.object(self.service, 'tool_listener', return_value=[9999]):
            with self.assertRaisesRegex(RuntimeError, 'foreign listener'):
                self.service.tools('start', 'annotation')
            self.assertEqual(command.call_count, 1)  # Only read Serve; no mutation.

    def test_second_tool_failure_compensates_first_started_job(self):
        first = self.configure_tool('synthetic.first')
        second = self.configure_tool('synthetic.second')
        self.config['tools'] = {'annotation': {'jobs': [first, second], 'ports': [4500, 4501], 'httpsPort': 17443, 'proxy': 'http://127.0.0.1:4501'}}
        calls = []
        def command(argv, check=True):
            calls.append(argv)
            if argv[:2] == ['launchctl', 'bootstrap'] and argv[-1] == second['plist']:
                raise RuntimeError('synthetic bootstrap failure')
            return subprocess.CompletedProcess(argv, 0, '{}', '')
        with patch.object(self.service, 'command', side_effect=command), patch.object(self.service, 'tool_state', return_value=(False, None)), patch.object(self.service, 'tool_listener', return_value=[]):
            with self.assertRaisesRegex(RuntimeError, 'bootstrap failure'):
                self.service.tools('start', 'annotation')
        self.assertIn(['launchctl', 'bootout', self.service.domain + '/synthetic.first'], calls)
        self.assertNotIn(['launchctl', 'bootout', self.service.domain + '/synthetic.second'], calls)

    def test_route_cleanup_failure_still_attempts_every_job_cleanup(self):
        first = self.configure_tool('synthetic.first')
        second = self.configure_tool('synthetic.second')
        self.config['tools'] = {'annotation': {'jobs': [first, second], 'ports': [4500, 4501], 'httpsPort': 17443, 'proxy': 'http://127.0.0.1:4501'}}
        calls = []
        def command(argv, check=True):
            calls.append(argv)
            if argv[-1] == 'off':
                raise RuntimeError('synthetic route cleanup failure')
            return subprocess.CompletedProcess(argv, 0, '{}', '')
        with patch.object(self.service, 'command', side_effect=command), patch.object(self.service, 'tool_state', return_value=(False, None)), patch.object(self.service, 'tool_listener', return_value=[]), patch.object(self.service, 'tool_owned', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'cleanup needs attention'):
                self.service.tools('start', 'annotation')
        for job in (first, second):
            self.assertIn(['launchctl', 'bootout', self.service.domain + '/' + job['label']], calls)
        self.assertTrue((self.service.state / 'tool-cleanup-required.json').exists())


if __name__ == '__main__':
    unittest.main()
