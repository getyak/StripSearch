#!/usr/bin/env python3
"""Own one macOS Web job; release from committed source and verify Tailnet bytes."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import sqlite3
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request

from restore import restore_snapshot


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix('.new')
    tmp.write_text(json.dumps(data, indent=2) + '\n')
    tmp.chmod(0o600)
    os.replace(tmp, path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def matches_install(lockfile, modules, omit_dev=False):
    """Verify installed versions/integrities, allowing omitted optional platforms."""
    try:
        wanted = json.loads(Path(lockfile).read_text())['packages']
        installed = json.loads((Path(modules) / '.package-lock.json').read_text())['packages']
        fields = ('version', 'resolved', 'integrity', 'link')
        for key, value in installed.items():
            if key not in wanted or any(value.get(field) != wanted[key].get(field) for field in fields):
                return False
            if not key.startswith('node_modules/'):
                return False
            package = Path(modules) / key.removeprefix('node_modules/') / 'package.json'
            metadata = json.loads(package.read_text())
            if value.get('version') is not None and metadata.get('version') != value['version']:
                return False
        for key, value in wanted.items():
            if key and not (omit_dev and value.get('dev')) and not value.get('optional') and not value.get('inBundle') and key not in installed:
                return False
        return True
    except (OSError, ValueError, KeyError):
        return False


def snapshot_data(source, target):
    source, target = Path(source), Path(target)
    target.mkdir(mode=0o700, parents=True)
    database = source / 'stripsearch.sqlite'
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as src:
        with sqlite3.connect(target / database.name) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('database snapshot integrity failed')
    if (source / 'auth-secret').exists():
        shutil.copyfile(source / 'auth-secret', target / 'auth-secret')
    (target / 'complete').touch(mode=0o600)


def unrelated_routes(config, authority, port):
    result = json.loads(json.dumps(config))
    result.setdefault('Web', {}).pop(authority, None)
    result.setdefault('TCP', {}).pop(str(port), None)
    return result


class Service:
    def __init__(self, config, config_file):
        self.config = config
        self.config_file = Path(config_file).resolve()
        self.state = Path(config['stateDir']).resolve()
        self.data = Path(config['dataDir']).resolve()
        self.origin = config['origin'].rstrip('/')
        origin = urllib.parse.urlsplit(self.origin)
        if origin.scheme != 'https' or not origin.hostname or not origin.hostname.endswith('.ts.net') or origin.path or origin.query or origin.fragment or origin.username or origin.password:
            raise ValueError('origin must be a Tailnet HTTPS origin')
        self.https_port = origin.port or 443
        self.authority = f'{origin.hostname}:{self.https_port}'
        self.port = int(config.get('port', 4392))
        if not 1024 <= self.port <= 65535:
            raise ValueError('expected an unprivileged loopback port')
        self.label = config.get('label', 'com.getyak.stripsearch.web')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', self.label):
            raise ValueError('invalid launchd label')
        self.domain = f'gui/{os.getuid()}'
        self.job = self.domain + '/' + self.label
        self.plist = Path.home() / 'Library/LaunchAgents' / (self.label + '.plist')
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for name in ('node', 'npm', 'tailscale', 'envFile'):
            if not Path(config[name]).is_absolute() or not Path(config[name]).is_file():
                raise ValueError(f'{name} must be an existing absolute file')
        if self.data.is_symlink() or not self.data.is_dir():
            raise ValueError('dataDir must be an existing regular directory')
        self.env = {k: os.environ[k] for k in ('HOME', 'LANG', 'LC_ALL', 'TMPDIR') if k in os.environ}
        self.env['PATH'] = str(Path(config['node']).parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin')

    @contextlib.contextmanager
    def locked(self):
        with (self.state / 'operation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def command(self, args, check=True):
        result = subprocess.run(args, env=self.env, capture_output=True, text=True)
        if check and result.returncode:
            # Keep potentially credential-bearing subprocess output private.
            with (self.state / 'operations.log').open('a') as out:
                out.write(result.stdout + result.stderr)
            raise RuntimeError(f'operation failed: {Path(args[0]).name} (see private operations.log)')
        return result

    def listeners(self):
        r = self.command(['lsof', '-nP', f'-iTCP:{self.port}', '-sTCP:LISTEN', '-t'], check=False)
        return sorted(set(int(x) for x in r.stdout.split()))

    def owned_pid(self, pid, release):
        cwd = self.command(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], check=False).stdout
        expected = str((Path(release) / 'apps/web').resolve())
        return '\nn' + expected + '\n' in cwd

    def current(self):
        p = self.state / 'current'
        if not p.is_symlink():
            return None
        resolved = p.resolve()
        if resolved.parent != self.state / 'releases' or not re.fullmatch(r'[0-9a-f]{40}', resolved.name):
            raise RuntimeError('current release points outside owned releases')
        return resolved

    def rollback_release(self, release):
        release = Path(release).resolve()
        if release.parent != self.state / 'releases' or not re.fullmatch(r'[0-9a-f]{40}', release.name):
            raise RuntimeError('rollback release must belong to owned releases')
        if not (release / 'complete').is_file() or not (release / 'apps/web/dist/server/index.js').is_file() or not (release / 'apps/web/node_modules').is_dir():
            raise RuntimeError('rollback release is incomplete')
        metadata = json.loads((release / 'apps/web/dist/client/release.json').read_text())
        if (metadata.get('revision') or metadata.get('commit')) != release.name:
            raise RuntimeError('rollback release revision mismatch')
        return release

    def stop(self):
        current = self.current()
        legacy = self.config.get('legacy', {})
        for pid in self.listeners():
            valid = current and self.owned_pid(pid, current)
            if not valid and pid == legacy.get('pid'):
                valid = self.owned_pid(pid, Path(legacy['cwd']).parent.parent)
            if not valid:
                raise RuntimeError('foreign listener: refusing to stop another application')
        result = self.command(['launchctl', 'bootout', self.job], check=False)
        if result.returncode and result.returncode != 3:
            loaded = self.command(['launchctl', 'print', self.job], check=False)
            if loaded.returncode == 0:
                raise RuntimeError('could not unload owned launchd job')
        for pid in self.listeners():
            # Revalidate after bootout, including PID reuse / another listener.
            valid = current and self.owned_pid(pid, current)
            valid = valid or (pid == legacy.get('pid') and self.owned_pid(pid, Path(legacy['cwd']).parent.parent))
            if not valid:
                raise RuntimeError('listener changed during stop; refusing signal')
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 30
        while self.listeners():
            if time.monotonic() > deadline:
                raise RuntimeError('owned service did not stop; no database restore attempted')
            time.sleep(.2)

    def start(self, allow_recovery=False):
        if (self.state / 'recovery-required.json').exists() and not allow_recovery:
            raise RuntimeError('recovery required: restore and validate data before starting')
        release = self.current()
        if not release or not (release / 'complete').is_file():
            raise RuntimeError('no complete current release')
        pids = self.listeners()
        if pids:
            if len(pids) != 1 or not self.owned_pid(pids[0], release):
                raise RuntimeError('foreign or duplicate listener')
            return
        loaded = self.command(['launchctl', 'print', self.job], check=False)
        if loaded.returncode == 0:
            if not self.plist.is_file() or plistlib.loads(self.plist.read_bytes()).get('WorkingDirectory') != str(release / 'apps/web'):
                raise RuntimeError('loaded job differs from current release; use update instead')
            match = re.search(r'\bpid = ([1-9][0-9]*)', loaded.stdout)
            if match and not self.owned_pid(int(match.group(1)), release):
                raise RuntimeError('loaded job process belongs to a different release')
            if not match:
                self.command(['launchctl', 'kickstart', self.job])
            return
        self.plist.parent.mkdir(parents=True, exist_ok=True)
        job = {
            'Label': self.label,
            'ProgramArguments': [self.config['node'], '--use-env-proxy', '--env-file=' + self.config['envFile'], 'dist/server/index.js'],
            'WorkingDirectory': str(release / 'apps/web'),
            'EnvironmentVariables': dict(self.env, NODE_ENV='production', PORT=str(self.port), STRIPSEARCH_HOST='127.0.0.1', STRIPSEARCH_DEPLOYMENT='hosted', STRIPSEARCH_PUBLIC_ORIGIN=self.origin, STRIPSEARCH_DATA_DIR=str(self.data), STRIPSEARCH_SIGNUP_MODE=self.config.get('signupMode', 'open')),
            'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
            'StandardOutPath': str(self.state / 'server.log'),
            'StandardErrorPath': str(self.state / 'server.log'),
        }
        self.plist.write_bytes(plistlib.dumps(job))
        self.plist.chmod(0o600)
        self.command(['launchctl', 'enable', self.job])
        self.command(['launchctl', 'bootstrap', self.domain, str(self.plist)])

    def get(self, url):
        with self.opener.open(url, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError('readback status is not 200')
            return response.read(16 * 1024 * 1024)

    def ready(self, revision):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                health = json.loads(self.get(f'http://127.0.0.1:{self.port}/api/health'))
                served = json.loads(self.get(f'http://127.0.0.1:{self.port}/release.json'))
                if health.get('status') == 'ok' and (served.get('revision') or served.get('commit')) == revision:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(.3)
        raise RuntimeError('loopback readiness or revision verification failed')

    def reconcile_tailnet(self):
        cli = self.config['tailscale']
        before = json.loads(self.command([cli, 'serve', 'status', '--json']).stdout)
        proxy = f'http://127.0.0.1:{self.port}'
        handlers = before.get('Web', {}).get(self.authority, {}).get('Handlers', {})
        if handlers and handlers != {'/': {'Proxy': proxy}}:
            raise RuntimeError('owned HTTPS port has conflicting handlers; refusing overwrite')
        if before.get('AllowFunnel', {}).get(self.authority):
            raise RuntimeError('Funnel must be disabled for the private Tailnet endpoint')
        self.command([cli, 'serve', '--bg', f'--https={self.https_port}', '--yes', proxy])
        after = json.loads(self.command([cli, 'serve', 'status', '--json']).stdout)
        if after.get('Web', {}).get(self.authority, {}).get('Handlers', {}) != {'/': {'Proxy': proxy}}:
            raise RuntimeError('Tailnet proxy readback mismatch')
        if unrelated_routes(before, self.authority, self.https_port) != unrelated_routes(after, self.authority, self.https_port):
            raise RuntimeError('unrelated Tailnet routes changed; inspect concurrent operator activity')
        write_json(self.state / 'tailscale-verified.json', after)

    def verify(self, reconcile=True):
        release = self.current()
        if not release:
            raise RuntimeError('no current release')
        revision = release.name
        pids = self.listeners()
        if len(pids) != 1 or not self.owned_pid(pids[0], release):
            raise RuntimeError('expected exactly one owned Web listener')
        self.ready(revision)
        if reconcile:
            self.reconcile_tailnet()
        client = release / 'apps/web/dist/client'
        health = json.loads(self.get(self.origin + '/api/health'))
        metadata = json.loads(self.get(self.origin + '/release.json'))
        if health.get('status') != 'ok' or (metadata.get('revision') or metadata.get('commit')) != revision:
            raise RuntimeError('Tailnet health/revision mismatch')
        html = self.get(self.origin + '/')
        if hashlib.sha256(html).hexdigest() != digest(client / 'index.html'):
            raise RuntimeError('Tailnet homepage bytes differ from the current release')
        assets = sorted(set(re.findall(r'(?:src|href)=["\'](/assets/[^"\']+)["\']', html.decode())))
        if not assets:
            raise RuntimeError('no production entry assets found')
        for asset in assets:
            if '..' in asset or hashlib.sha256(self.get(self.origin + asset)).hexdigest() != digest(client / asset.lstrip('/')):
                raise RuntimeError('Tailnet entry asset mismatch')
        receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commit': revision, 'revision': revision, 'pid': pids[0], 'port': self.port, 'origin': self.origin, 'dataDir': str(self.data), 'releaseDir': str(release), 'signupMode': self.config.get('signupMode', 'open'), 'verifiedAssets': len(assets), 'tailscaleVerified': True}
        write_json(self.state / 'runtime.json', receipt)
        (self.state / 'server.pid').write_text(str(pids[0]) + '\n')
        return receipt

    def select(self, release):
        tmp = self.state / 'current.new'
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(release)
        os.replace(tmp, self.state / 'current')

    def build(self, repo, revision):
        if not re.fullmatch(r'[0-9a-f]{40}', revision):
            raise ValueError('expected a full commit SHA')
        resolved = self.command(['git', '-C', str(repo), 'rev-parse', revision + '^{commit}']).stdout.strip()
        if resolved != revision:
            raise RuntimeError('source commit does not match requested revision')
        release = self.state / 'releases' / revision
        if (release / 'complete').is_file():
            return release
        build_root = self.state / 'builds'
        build_root.mkdir(mode=0o700, exist_ok=True)
        build = build_root / revision
        if build.exists():
            raise RuntimeError('incomplete previous build exists; inspect before retry')
        build.mkdir(mode=0o700)
        archive = build / 'source.tar'
        self.command(['git', '-C', str(repo), 'archive', '--format=tar', '-o', str(archive), revision])
        with tarfile.open(archive) as files:
            files.extractall(build, filter='data')
        archive.unlink()
        web = build / 'apps/web'
        lock_hash = digest(web / 'package-lock.json')
        node_version = self.command([self.config['node'], '--version']).stdout.strip()
        if node_version != 'v22.23.2':
            raise RuntimeError('Node version does not match the pinned runtime')
        deps = Path(self.config.get('buildDependencies', ''))
        if deps.is_dir() and self.config.get('buildLockHash') == lock_hash and matches_install(web / 'package-lock.json', deps):
            (web / 'node_modules').symlink_to(deps.resolve())
        else:
            self.run_in(web, [self.config['npm'], 'ci', '--no-audit', '--no-fund'])
        self.run_in(web, [self.config['npm'], 'run', 'build'])
        policy = re.search(r"FIRST_STEP_POLICY_VERSION = '([^']+)'", (web / 'src/shared/first-step-discovery.ts').read_text())
        assets = {str(p.relative_to(web / 'dist')): digest(p) for p in sorted((web / 'dist/client/assets').iterdir()) if p.is_file()}
        write_json(web / 'dist/client/release.json', {'revision': revision, 'commit': revision, 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'node': node_version.lstrip('v'), 'firstStepPolicy': policy.group(1) if policy else None, 'assets': assets})
        cache = self.state / 'dependencies' / (lock_hash + '-' + node_version)
        if not (cache / 'complete').is_file():
            if cache.exists():
                raise RuntimeError('incomplete dependency cache exists; inspect before retry')
            cache.mkdir(mode=0o700, parents=True)
            for name in ('package.json', 'package-lock.json'):
                shutil.copy2(web / name, cache / name)
            self.run_in(cache, [self.config['npm'], 'ci', '--omit=dev', '--no-audit', '--no-fund'])
            (cache / 'complete').touch(mode=0o600)
        if digest(cache / 'package-lock.json') != lock_hash or not matches_install(web / 'package-lock.json', cache / 'node_modules', omit_dev=True):
            raise RuntimeError('production dependency cache differs from requested lock')
        target = release / 'apps/web'
        target.mkdir(mode=0o700, parents=True)
        shutil.copytree(web / 'dist', target / 'dist')
        for name in ('package.json', 'package-lock.json'):
            shutil.copy2(web / name, target / name)
        (target / 'node_modules').symlink_to(cache / 'node_modules')
        write_json(release / 'manifest.json', {'revision': revision, 'dependencyKey': cache.name, 'lockHash': lock_hash, 'nodeVersion': node_version})
        (release / 'complete').touch(mode=0o600)
        shutil.rmtree(build)
        return release

    def run_in(self, cwd, args):
        with (self.state / 'build.log').open('ab') as output:
            result = subprocess.run(args, cwd=cwd, env=self.env, stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError('build/dependency command failed; inspect private build.log')

    def update(self, repo, revision):
        if (self.state / 'recovery-required.json').exists():
            raise RuntimeError('recovery required: refusing a new update')
        release = self.build(repo, revision)
        previous = self.current()
        if previous == release and self.listeners():
            return self.verify()
        # Legacy service is a real rollback target, including its previous code.
        if not previous and self.config.get('legacy'):
            previous = Path(self.config['legacy']['releaseDir']).resolve()
        if previous:
            previous = self.rollback_release(previous)
        self.stop()
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        backup = self.state / 'backups' / stamp
        try:
            snapshot_data(self.data, backup)
        except BaseException:
            # No new writer has started, so live data remains the old state.
            if previous:
                self.select(previous)
                self.start()
                self.ready(previous.name)
                self.verify()
            raise
        try:
            self.select(release)
            self.start()
            self.ready(revision)
            receipt = self.verify()
        except BaseException:
            write_json(self.state / 'recovery-required.json', {'failedRevision': revision, 'previous': previous.name if previous else None, 'snapshot': str(backup)})
            self.command(['launchctl', 'disable', self.job])
            self.stop()
            restore_snapshot(backup, self.data, self.state / 'backups', revision)
            if previous:
                # Legacy release uses the same layout; adoption must mark it complete.
                self.select(previous)
                try:
                    self.start(allow_recovery=True)
                    self.ready(previous.name)
                    self.verify()
                except BaseException:
                    self.command(['launchctl', 'disable', self.job])
                    self.stop()
                    raise
                (self.state / 'recovery-required.json').unlink()
            raise
        write_json(self.state / 'accepted.json', {'current': revision, 'previous': previous.name if previous else None, 'backup': str(backup)})
        return receipt

    def tool_state(self, job):
        target = self.domain + '/' + job['label']
        result = self.command(['launchctl', 'print', target], check=False)
        match = re.search(r'\bpid = ([1-9][0-9]*)', result.stdout) if result.returncode == 0 else None
        return result.returncode == 0, int(match.group(1)) if match else None

    def tool_listener(self, port):
        result = self.command(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-t'], check=False)
        return sorted(set(int(x) for x in result.stdout.split()))

    def tool_owned(self, job, port):
        loaded, pid = self.tool_state(job)
        listeners = self.tool_listener(port)
        if not pid or listeners != [pid]:
            return False
        cwd = self.command(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], check=False).stdout
        expected = str(Path(job['cwd']).resolve())
        return '\nn' + expected + '\n' in cwd

    def tools(self, action, group):
        spec = self.config.get('tools', {}).get(group)
        if not spec:
            raise ValueError('tool group is not configured')
        jobs = spec['jobs']
        if len(jobs) != len(spec['ports']):
            raise ValueError('each auxiliary job must own exactly one configured port')
        cli = self.config['tailscale']
        authority = urllib.parse.urlsplit(self.origin).hostname + ':' + str(spec['httpsPort'])
        before = json.loads(self.command([cli, 'serve', 'status', '--json']).stdout)
        handlers = before.get('Web', {}).get(authority, {}).get('Handlers', {})
        expected = {'/': {'Proxy': spec['proxy']}}
        if handlers and handlers != expected:
            raise RuntimeError('auxiliary HTTPS port has conflicting handlers')
        if before.get('AllowFunnel', {}).get(authority):
            raise RuntimeError('auxiliary tools must remain Tailnet-only')
        prior = []
        # Validate every component before starting or stopping any of them.
        for job, port in zip(jobs, spec['ports']):
            data = plistlib.loads(Path(job['plist']).read_bytes())
            if data['Label'] != job['label'] or data.get('RunAtLoad') or data.get('KeepAlive'):
                raise RuntimeError('auxiliary job must be explicit and not always on')
            if not data.get('WorkingDirectory'):
                raise RuntimeError('auxiliary job requires an explicit working directory')
            job = dict(job, cwd=data['WorkingDirectory'])
            loaded, pid = self.tool_state(job)
            if self.tool_listener(port) and not self.tool_owned(job, port):
                raise RuntimeError('foreign listener on auxiliary port; refusing operation')
            prior.append((job, port, loaded, pid))
        created = []
        route_changed = False
        try:
            for job, port, loaded, pid in (prior if action == 'start' else reversed(prior)):
                target = self.domain + '/' + job['label']
                if action == 'start':
                    if not loaded:
                        self.command(['launchctl', 'enable', target])
                        self.command(['launchctl', 'bootstrap', self.domain, job['plist']])
                        created.append((job, port, False))
                    elif not pid:
                        created.append((job, port, True))
                    if not pid:
                        self.command(['launchctl', 'kickstart', target])
                else:
                    if loaded:
                        self.command(['launchctl', 'bootout', target])
                    self.command(['launchctl', 'disable', target])
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                ready = all(self.tool_owned(job, port) for job, port, _, _ in prior) if action == 'start' else all(not self.tool_listener(port) for _, port, _, _ in prior)
                if ready:
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('auxiliary readiness/stop timed out; inspect private tool logs')
            if action == 'start':
                self.command([cli, 'serve', '--bg', f'--https={spec["httpsPort"]}', '--yes', spec['proxy']])
            else:
                self.command([cli, 'serve', f'--https={spec["httpsPort"]}', 'off'])
            route_changed = True
            after = json.loads(self.command([cli, 'serve', 'status', '--json']).stdout)
            wanted = expected if action == 'start' else {}
            if after.get('Web', {}).get(authority, {}).get('Handlers', {}) != wanted:
                raise RuntimeError('auxiliary Tailnet readback mismatch')
            if unrelated_routes(before, authority, spec['httpsPort']) != unrelated_routes(after, authority, spec['httpsPort']):
                raise RuntimeError('unrelated Tailnet routes changed during auxiliary operation')
        except BaseException as failure:
            if action == 'start':
                cleanup_errors = []
                if route_changed and not handlers:
                    try:
                        self.command([cli, 'serve', f'--https={spec["httpsPort"]}', 'off'])
                    except Exception:
                        cleanup_errors.append('tailnet route')
                for job, port, was_loaded in reversed(created):
                    target = self.domain + '/' + job['label']
                    operations = [['launchctl', 'kill', 'SIGTERM', target]] if was_loaded else [['launchctl', 'bootout', target], ['launchctl', 'disable', target]]
                    for operation in operations:
                        try:
                            result = self.command(operation, check=False)
                            if result.returncode not in (0, 3):
                                cleanup_errors.append(job['label'])
                        except Exception:
                            cleanup_errors.append(job['label'])
                if cleanup_errors:
                    write_json(self.state / 'tool-cleanup-required.json', {'group': group, 'failedCleanup': cleanup_errors})
                    raise RuntimeError('auxiliary startup failed and cleanup needs attention; see private tool-cleanup-required.json') from failure
            raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('start', 'stop', 'status', 'verify'):
        commands.add_parser(name)
    update = commands.add_parser('update')
    update.add_argument('--repo', type=Path, required=True)
    update.add_argument('--revision', required=True)
    tools = commands.add_parser('tools')
    tools.add_argument('action', choices=('start', 'stop'))
    tools.add_argument('group', choices=('annotation', 'evaluation'))
    args = parser.parse_args()
    service = Service(json.loads(args.config.read_text()), args.config)
    with service.locked():
        if args.command == 'update':
            result = service.update(args.repo, args.revision)
        elif args.command == 'verify':
            result = service.verify()
        elif args.command == 'status':
            result = {'current': str(service.current()), 'listeners': service.listeners(), 'origin': service.origin}
        elif args.command == 'start':
            service.start()
            service.ready(service.current().name)
            result = service.verify()
        elif args.command == 'stop':
            service.stop()
            result = {'stopped': True}
        else:
            service.tools(args.action, args.group)
            result = {'group': args.group, 'state': args.action}
        print(json.dumps(result))


if __name__ == '__main__':
    main()
