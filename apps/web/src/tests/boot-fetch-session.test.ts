import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, installFetch, jsonResponse } from './dom-env.js';
import { deferred } from './fakes.js';
import { waitFor } from './harness.js';

const env = installDom();
env.window.location.hash = '#/fetch';
const session = deferred<Response>();
const requests: string[] = [];
installFetch(url => {
  requests.push(url);
  return url.includes('/api/auth/get-session') ? session.promise :
    jsonResponse(url.includes('/api/runs') || url.includes('/api/fetch/runs') ? { runs: [] } : { capabilities: { github: true, fetchGithub: true } });
});
const main = await import('../client/main.js');

test('Fetch bookmark restores its owner session before listing jobs or presenting login', async () => {
  assert.equal(env.document.getElementById('view-home')!.hidden, true);
  assert.ok(env.document.querySelector('.app-opening'));
  assert.equal(env.document.querySelector('dialog[open]'), null);
  assert.equal(requests.some(url => url.includes('/api/fetch/runs')), false);
  session.resolve(jsonResponse({ user: { id: 'fetch-boot-owner', email: 'fetch-boot@example.test', name: 'Synthetic Fetch owner' }, session: { id: 'fetch-boot-session' } }));
  await waitFor(() => main.__test.state.user?.id === 'fetch-boot-owner' && requests.some(url => url.includes('/api/fetch/runs')));
  assert.equal(env.document.getElementById('view-fetch')!.hidden, false);
  assert.equal(env.document.getElementById('view-home')!.hidden, true);
  assert.equal(env.document.querySelector('.app-opening'), null);
  assert.equal(env.document.querySelector('dialog[open]'), null);
  assert.equal(env.window.location.hash, '#/fetch');
});
