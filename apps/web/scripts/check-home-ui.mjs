/** Offline homepage acceptance against an already-running loopback server. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const origin = new URL(process.argv[2] ?? 'http://localhost:4437');
const output = process.argv[3];
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('UI acceptance requires a loopback server.');
if (!output) throw new Error('Pass an evidence output directory as the second argument.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true });
const checks = [];
const errors = [];
const researchRequests = [];
const externalRequests = [];
async function context(options = {}) {
  const result = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await result.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      externalRequests.push(url.origin); return route.abort();
    }
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') {
      researchRequests.push(`${request.method()} ${url.pathname}`); return route.abort();
    }
    return route.continue();
  });
  result.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return result;
}
const ctx = await context();
const page = await ctx.newPage();
const navigate = async () => { await page.goto(origin.href); await page.locator('#open-auth').waitFor({ state: 'visible' }); };
const stage = async n => {
  await page.locator(`[data-journey-step="${n}"]`).scrollIntoViewIfNeeded();
  await page.waitForFunction(value => document.getElementById('home-artifact').dataset.stage === String(value), n);
  await page.waitForTimeout(650);
};
const save = async name => page.screenshot({ path: path.join(output, name) });
try {
  await navigate();
  assert.equal(await page.locator('#home-artifact').getAttribute('data-stage'), '1');
  await save('desktop.png');
  for (const n of [2, 3, 2, 1]) {
    await stage(n); checks.push(`scroll stage ${n}`);
    if (n === 2 || n === 3) await save(`stage-${n}.png`);
  }
  await stage(3);
  await page.locator('#home-citation').click();
  assert.equal(await page.locator('#home-source').evaluate(e => e.open), true);
  assert.equal(await page.locator('#home-source summary').evaluate(e => e === document.activeElement), true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#home-artifact').getAttribute('data-stage'), '3');
  await page.locator('#research-question').focus();
  await page.waitForFunction(() => document.getElementById('home-artifact').dataset.stage === '1');
  checks.push('focused source stays available; focus exit resumes reading position');

  await stage(3);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('.home-journey').dataset.layout === 'static');
  assert.equal(await page.locator('[data-journey-panel]:visible').count(), 3);
  assert.equal(await page.locator('#home-source').evaluate(e => e.open), true);
  await save('reduced-motion.png');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.querySelector('.home-journey').dataset.layout === 'scroll');
  checks.push('dynamic reduced motion keeps all panels and inspected details');
  await page.emulateMedia({ colorScheme: 'dark' });
  await stage(3); await save('dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('.nav-links a[href="#pricing"]').click();
  await page.waitForTimeout(700); await save('pricing.png');
  assert.equal(await page.locator('body').getAttribute('data-view'), 'home');
  await page.locator('.plan-details summary').first().click();
  assert.equal(await page.locator('.plan-details').first().evaluate(e => e.open), true);
  await page.locator('.nav-links a[href="#boundaries"]').click();
  await page.locator('.faq-list summary').first().click();
  assert.equal(await page.locator('.faq-list details').first().evaluate(e => e.open), true);
  checks.push('pricing/navigation/FAQ expand locally without research');

  for (const [width, height] of [[320, 844], [390, 844], [768, 1024], [999, 900], [1000, 900], [1024, 900], [1440, 900], [1440, 650]]) {
    await page.setViewportSize({ width, height });
    await navigate();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} overflow`);
    const submit = await page.locator('#submit-research').boundingBox();
    assert.ok(submit && submit.y + submit.height <= height, `${width}×${height} CTA outside viewport`);
    assert.ok(submit.height >= 44 && submit.height <= 64, `${width} unexpected CTA height`);
    if (width < 1000 || height < 720) assert.equal(await page.locator('[data-journey-panel]:visible').count(), 3);
    checks.push(`${width}×${height}: no overflow, visible CTA, correct static/scroll layout`);
    if (width === 390) {
      await save('mobile.png'); await page.screenshot({ path: path.join(output, 'mobile-full.png'), fullPage: true });
      // Start in the static mobile mode, then promote a focused source into the sticky host.
      await page.locator('#home-source summary').focus();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => document.querySelector('.home-journey').dataset.layout === 'scroll');
      assert.equal(await page.locator('#home-source summary').evaluate(e => e === document.activeElement), true);
      assert.equal(await page.locator('#home-artifact').getAttribute('data-stage'), '3');
      await page.locator('#research-question').focus();
      checks.push('initial mobile source focus survives desktop promotion');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigate();
  await page.locator('#submit-research').click();
  assert.match(await page.locator('#question-error').innerText(), /输入|填写|至少/);
  await page.locator('#research-question').fill('合成研究对象');
  await page.locator('#clear-question').click();
  assert.equal(await page.locator('#research-question').inputValue(), '');
  await page.locator('#research-question').fill('合成研究对象');
  await page.locator('#submit-research').click();
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth-dialog').evaluate(e => e.open), true);
  await page.locator('#auth-dialog [data-close-auth]').first().click();
  assert.equal(await page.locator('#auth-dialog').evaluate(e => e.open), false);
  checks.push('real blank validation, clear control and sign-in handoff; no research submitted');

  for (const mode of ['no-js', 'no-observer']) {
    const fallback = await context(mode === 'no-js' ? { javaScriptEnabled: false } : {});
    if (mode === 'no-observer') await fallback.addInitScript(() => { window.IntersectionObserver = undefined; });
    const p = await fallback.newPage(); await p.goto(origin.href);
    assert.equal(await p.locator('[data-journey-panel]:visible').count(), 3);
    assert.equal(await p.locator('#journey-visual').isVisible(), false);
    await p.locator('#home-source summary').click();
    assert.equal(await p.locator('#home-source').evaluate(e => e.open), true);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.screenshot({ path: path.join(output, `${mode}.png`), fullPage: true });
    checks.push(`${mode}: all panels and native source details readable`);
    await fallback.close();
  }
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(researchRequests, [], 'unexpected API write');
  assert.deepEqual(externalRequests, [], 'unexpected external request');
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ passed: true, checks, browserErrors: errors, researchRequests, externalRequests }, null, 2));
  console.log(`PASS: ${checks.length} browser acceptance checks; no API writes or external requests.`);
} finally {
  await browser.close();
}
