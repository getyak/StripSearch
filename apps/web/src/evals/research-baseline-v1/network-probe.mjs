/**
 * Network guard probe for the research-baseline test suite.
 *
 * Spawned with `--import ./network-guard.mjs`, it attempts every guarded
 * outbound path (fetch, http, https, net, tls, child_process, worker_threads)
 * against a listener owned by the parent test process plus two marker files.
 * If any underlying connector actually ran, the parent would observe a TCP
 * connection or a marker file. The probe writes a JSON verdict and exits 0 only
 * when every attempt was denied by the guard.
 *
 * Env: PROBE_HOST, PROBE_PORT, MARKER_SPAWN, MARKER_WORKER, PROBE_RESULT.
 */

import { writeFileSync } from 'node:fs';

const host = process.env.PROBE_HOST ?? '127.0.0.1';
const port = Number(process.env.PROBE_PORT ?? '0');
const markerSpawn = process.env.MARKER_SPAWN ?? '';
const markerWorker = process.env.MARKER_WORKER ?? '';
const resultPath = process.env.PROBE_RESULT ?? '';

const attempts = [];

async function attempt(api, run) {
  let denied = false;
  let message = '';
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    denied = message.includes('network guard blocked');
  }
  attempts.push({ api, denied, message });
}

await attempt('fetch', () => fetch(`http://${host}:${port}/probe`));
await attempt('http.request', async () => {
  const http = await import('node:http');
  await new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: '/probe' }, resolve);
    request.on('error', reject);
    request.end();
  });
});
await attempt('https.request', async () => {
  const https = await import('node:https');
  await new Promise((resolve, reject) => {
    const request = https.request({ host, port, path: '/probe', servername: host }, resolve);
    request.on('error', reject);
    request.end();
  });
});
await attempt('net.connect', async () => {
  const net = await import('node:net');
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, host, resolve);
    socket.on('error', reject);
  });
});
await attempt('net.Socket.prototype.connect', async () => {
  const net = await import('node:net');
  await new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(port, host, resolve);
    socket.on('error', reject);
  });
});
await attempt('tls.connect', async () => {
  const tls = await import('node:tls');
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, resolve);
    socket.on('error', reject);
  });
});
await attempt('child_process.execFile', async () => {
  const childProcess = await import('node:child_process');
  await new Promise((resolve, reject) => {
    childProcess.execFile('sh', ['-c', `echo escaped > ${markerSpawn}`], (error) => (error ? reject(error) : resolve()));
  });
});
await attempt('worker_threads.Worker', async () => {
  const workerThreads = await import('node:worker_threads');
  const worker = new workerThreads.Worker(`require('fs').writeFileSync(${JSON.stringify(markerWorker)}, 'escaped')`, { eval: true });
  await new Promise((resolve, reject) => {
    worker.on('exit', resolve);
    worker.on('error', reject);
  });
});

const verdict = { host, port, attempts, allDenied: attempts.every((entry) => entry.denied) };
if (resultPath) writeFileSync(resultPath, JSON.stringify(verdict, null, 2), 'utf8');
process.exit(verdict.allDenied ? 0 : 1);
