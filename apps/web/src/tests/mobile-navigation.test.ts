import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { createMobileNavigation } from '../client/mobile-navigation.js';

const env = installDom();

test('mobile site links share the canonical navigation for signed-out and account menus', () => {
  const controller = createMobileNavigation({ doc: env.document });
  try {
    const original = [...env.document.querySelectorAll('.nav-links a')].map(a => [a.textContent, a.getAttribute('href')]);
    for (const selector of ['.mobile-navigation nav', '.account-site-navigation']) {
      const links = [...env.document.querySelectorAll(`${selector} a`)];
      assert.deepEqual(links.map(a => [a.textContent, a.getAttribute('href')]), original);
      assert.equal(links.some(a => a.id), false);
    }
    assert.equal(env.document.querySelector('.mobile-navigation summary')?.textContent, '导航');
  } finally { controller.dispose(); }
});

test('mobile menus close after a link and Escape restores the summary focus', () => {
  const controller = createMobileNavigation({ doc: env.document });
  try {
    const menu = env.document.querySelector<HTMLDetailsElement>('.mobile-navigation')!;
    menu.open = true;
    menu.querySelector<HTMLAnchorElement>('a')!.click();
    assert.equal(menu.open, false);
    menu.open = true;
    const link = menu.querySelector<HTMLAnchorElement>('a')!;
    link.focus();
    link.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menu.open, false);
    assert.equal(env.document.activeElement, menu.querySelector('summary'));
    const account = env.document.querySelector<HTMLDetailsElement>('.account-options')!;
    account.open = true;
    account.querySelector<HTMLAnchorElement>('.account-site-navigation a')!.click();
    assert.equal(account.open, false);
  } finally { controller.dispose(); }
});

test('leaving the page closes site menus and dispose removes enhancements without removing canonical links', () => {
  const count = env.document.querySelectorAll('.nav-links a').length;
  const controller = createMobileNavigation({ doc: env.document });
  const menu = env.document.querySelector<HTMLDetailsElement>('.mobile-navigation')!;
  menu.open = true;
  env.window.dispatchEvent(new env.window.Event('hashchange'));
  assert.equal(menu.open, false);
  controller.dispose();
  assert.equal(env.document.querySelector('.mobile-navigation'), null);
  assert.equal(env.document.querySelector('.account-site-navigation'), null);
  assert.equal(env.document.querySelectorAll('.nav-links a').length, count);
  controller.dispose();
});
