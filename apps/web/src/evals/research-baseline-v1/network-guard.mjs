/**
 * Process-level network API guard for the research-baseline-v1 replay.
 *
 * Preloaded via `node --import ./network-guard.mjs` BEFORE any production
 * module import, it removes every declared outbound path: fetch, http, https,
 * net, tls, plus subprocess escapes (child_process, worker_threads, the global
 * WebSocket client). Each blocked attempt is appended to an independent
 * violation log file (STRIPSEARCH_GUARD_LOG) at the moment it happens, so a
 * controller that swallows the thrown error cannot hide the attempt.
 *
 * Boundary honesty: this is a process-level API guard, NOT OS network
 * isolation. It does not cover native addons, dgram, dns or a debugger
 * rewriting the process. No claim of OS-level isolation is made anywhere.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

export const GUARDED_APIS = [
  'fetch',
  'WebSocket',
  'http.request',
  'http.get',
  'https.request',
  'https.get',
  'net.connect',
  'net.createConnection',
  'net.Socket.prototype.connect',
  'tls.connect',
  'child_process.spawn',
  'child_process.spawnSync',
  'child_process.exec',
  'child_process.execSync',
  'child_process.execFile',
  'child_process.execFileSync',
  'child_process.fork',
  'worker_threads.Worker'
];

const state = {
  installed: false,
  violations: /** @type {{at: string, api: string, target: string, message: string}[]} */ ([])
};

// The exit verdict is independent of the file sink and of callers catching
// blocked API errors. Preserve other failures, but never exit successfully
// after a violation (including an explicit process.exit(0) from a caller).
process.on('exit', () => {
  if (state.violations.length > 0 && Number(process.exitCode ?? 0) === 0) process.exitCode = 1;
});

function logPath() {
  const configured = process.env.STRIPSEARCH_GUARD_LOG;
  return typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : null;
}

function recordViolation(api, target) {
  const entry = { at: new Date().toISOString(), api, target: String(target).slice(0, 400), message: `network guard blocked ${api}` };
  state.violations.push(entry);
  globalThis.__stripsearchNetworkGuardViolations = state.violations;
  const path = logPath();
  try {
    if (!path) throw new Error('missing guard log');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // A pre-created empty file is not proof of a clean replay. If the durable
    // sink fails, stop the process rather than throwing a swallowable error.
    console.error('network guard could not persist a violation; terminating replay');
    process.exit(1);
  }
  return new Error(`network guard blocked ${api} ${entry.target}`);
}

function blockApi(api) {
  return function blockedGuardedApi(...args) {
    const target = args.find((value) => typeof value === 'string' || (value && typeof value === 'object' && 'href' in value));
    throw recordViolation(api, target ? String(/** @type {any} */ (target).href ?? target) : '');
  };
}

function patchExports(moduleName, names, label) {
  const mod = require(moduleName);
  for (const name of names) {
    if (typeof mod[name] === 'function') {
      mod[name] = blockApi(`${label}.${name}`);
    }
  }
}

export function installNetworkGuard() {
  if (state.installed) return state.violations;
  state.installed = true;
  for (const name of ['fetch', 'WebSocket']) {
    const original = globalThis[name];
    if (typeof original === 'function') {
      globalThis[name] = blockApi(name);
    }
  }
  patchExports('node:http', ['request', 'get'], 'http');
  patchExports('node:https', ['request', 'get'], 'https');
  patchExports('node:net', ['connect', 'createConnection'], 'net');
  patchExports('node:tls', ['connect'], 'tls');
  patchExports('node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'child_process');
  patchExports('node:worker_threads', ['Worker'], 'worker_threads');
  const net = require('node:net');
  if (net.Socket && net.Socket.prototype) {
    net.Socket.prototype.connect = blockApi('net.Socket.prototype.connect');
  }
  globalThis.__stripsearchNetworkGuardViolations = state.violations;
  globalThis.__stripsearchNetworkGuardInstalled = true;
  return state.violations;
}

installNetworkGuard();
