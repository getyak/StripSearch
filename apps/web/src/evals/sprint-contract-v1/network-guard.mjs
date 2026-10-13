/** Process API isolation, not an OS sandbox. Installed before production imports. */
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
export const violations = [];
export const guardedApis = [];
function deny(api) {
  guardedApis.push(api);
  return function denied() {
    const record = { sequence: violations.length + 1, api, message: `offline contract guard blocked ${api}` };
    violations.push(record);
    // Independent durable evidence survives a caught exception or a process crash.
    if (!process.env.STRIPSEARCH_SPRINT_GUARD_LOG) {
      process.stderr.write('missing independent network guard log\n');
      process.exit(1);
    }
    try { appendFileSync(process.env.STRIPSEARCH_SPRINT_GUARD_LOG, JSON.stringify(record) + '\n'); }
    catch { process.stderr.write('cannot persist network guard violation\n'); process.exit(1); }
    throw new Error(record.message);
  };
}
for (const name of ['fetch', 'WebSocket']) if (typeof globalThis[name] === 'function') globalThis[name] = deny(name);
for (const [module, methods] of [
  ['http', ['request', 'get']], ['https', ['request', 'get']], ['http2', ['connect']],
  ['net', ['connect', 'createConnection']], ['tls', ['connect']],
  ['dns', ['lookup', 'resolve', 'resolve4', 'resolve6']], ['dgram', ['createSocket']],
  ['child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['worker_threads', ['Worker']]
]) {
  const object = require(`node:${module}`);
  for (const method of methods) if (typeof object[method] === 'function') object[method] = deny(`${module}.${method}`);
}
for (const module of ['dns', 'dns/promises']) {
  const object = require(`node:${module}`);
  for (const method of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse']) {
    if (typeof object[method] === 'function' && !guardedApis.includes(`${module}.${method}`)) object[method] = deny(`${module}.${method}`);
    if (object.Resolver && typeof object.Resolver.prototype[method] === 'function') object.Resolver.prototype[method] = deny(`${module}.Resolver.${method}`);
  }
}
require('node:net').Socket.prototype.connect = deny('net.Socket.prototype.connect');
syncBuiltinESMExports();
globalThis.__stripsearchSprintGuard = { installed: true, violations, guardedApis };
process.on('exit', () => { if (violations.length && Number(process.exitCode ?? 0) === 0) process.exitCode = 1; });
