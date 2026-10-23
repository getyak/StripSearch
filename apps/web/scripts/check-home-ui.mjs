/** Offline homepage acceptance against an already-running loopback server.
 * Usage: node scripts/check-home-ui.mjs http://127.0.0.1:4438 /absolute/evidence/path
 * Reuses installed Chromium; never installs browsers or submits research.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

if (!process.argv[2] || !process.argv[3]) throw new Error('Pass the loopback URL and an absolute evidence output directory.');
const origin = new URL(process.argv[2]);
const output = process.argv[3];
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
  throw new Error('UI acceptance requires an HTTP(S) loopback server without credentials.');
}
if (!path.isAbsolute(output)) throw new Error('The evidence output directory must be absolute.');
await mkdir(output, { recursive: true });
const receipt = {
  startedAt: new Date().toISOString(), origin: origin.origin, passed: false,
  scope: 'Synthetic offline homepage only; no login, persistent account, external service, paid call or real software keyboard.',
  checks: [], layouts: [], relationships: [], citationReturns: [], noJavaScript: [], screenshots: [],
  browserErrors: [], consoleErrors: [], httpErrors: [], blockedRequests: [],
  network: { allowedGet: 0, allowedApiGet: 0, blockedExternal: 0, blockedNonGet: 0 },
};
let browser;
let page;
const contexts = new Set();

async function check(name, action) {
  try {
    const details = await action();
    receipt.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
    console.log(`PASS: ${name}`);
  } catch (error) {
    const failure = { name, passed: false, error: error.stack ?? String(error) };
    receipt.checks.push(failure);
    if (page && !page.isClosed()) {
      try {
        failure.screenshot = `failure-${receipt.checks.length}.png`;
        await save(failure.screenshot);
      } catch (captureError) {
        failure.screenshotError = captureError.message;
      }
    }
    console.error(`FAIL: ${name}: ${error.message}`);
  }
}
async function context(options = {}) {
  const result = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', serviceWorkers: 'block', ...options });
  contexts.add(result);
  result.setDefaultTimeout(5000);
  await result.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const external = url.origin !== origin.origin;
    const nonGet = request.method() !== 'GET';
    if (external || nonGet) {
      receipt.blockedRequests.push({ method: request.method(), url: request.url(), reason: external ? 'external origin' : 'non-GET request' });
      if (external) receipt.network.blockedExternal += 1;
      if (nonGet) receipt.network.blockedNonGet += 1;
      await route.abort('blockedbyclient');
      return;
    }
    receipt.network.allowedGet += 1;
    if (url.pathname.startsWith('/api/')) receipt.network.allowedApiGet += 1;
    await route.continue();
  });
  result.on('page', p => {
    p.on('pageerror', error => receipt.browserErrors.push({ url: p.url(), message: error.message }));
    p.on('response', response => {
      if (response.status() >= 400) receipt.httpErrors.push({ url: response.url(), status: response.status(), retryAfter: response.headers()['retry-after'] ?? null });
    });
    p.on('console', message => {
      if (message.type() === 'error') receipt.consoleErrors.push({ url: p.url(), message: message.text() });
    });
  });
  return result;
}
async function navigate(p = page) {
  await p.goto(origin.href, { waitUntil: 'networkidle' });
  await p.locator('#open-auth').waitFor({ state: 'visible' });
  await p.evaluate(async () => {
    await document.fonts.ready;
    // Wait for the brief entrance only; ambient paper light may run for seconds.
    await Promise.race([Promise.all(document.getAnimations().filter(animation => {
      const timing = animation.effect?.getComputedTiming();
      return animation.playState === 'running' && timing && timing.iterations !== Infinity && timing.endTime <= 1200;
    }).map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 1200))]);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
}
async function save(name, p = page, fullPage = false) {
  // A bounded capture delay covers the 150–200ms reveal/focus feedback. Do not
  // await Animation.finished here: a screenshot may observe a paused animation.
  await p.waitForTimeout(220);
  await p.screenshot({ path: path.join(output, name), fullPage });
  receipt.screenshots.push(name);
}
async function geometry(p = page) {
  return p.evaluate(() => {
    const box = document.getElementById('submit-research').getBoundingClientRect();
    const overflowing = [...document.querySelectorAll('#view-home *')].filter(element => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(element).position !== 'fixed';
    }).slice(0, 12).map(element => ({ tag: element.tagName, id: element.id, class: element.className, right: element.getBoundingClientRect().right }));
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      cta: { x: box.x, y: box.y, width: box.width, height: box.height }, overflowing };
  });
}
function assertLayout(metrics, { firstScreen = false } = {}) {
  assert.ok(metrics.scrollWidth <= metrics.width + 1, `${metrics.width}×${metrics.height} horizontal overflow: ${JSON.stringify(metrics.overflowing)}`);
  assert.ok(metrics.cta.height >= 44 && metrics.cta.width >= 44, `CTA below 44px: ${JSON.stringify(metrics.cta)}`);
  if (firstScreen) assert.ok(metrics.cta.y >= 0 && metrics.cta.y + metrics.cta.height <= metrics.height, `CTA outside first screen: ${JSON.stringify(metrics.cta)}`);
}
async function inspectCitation(citationId, sourceId, method, screenshot = false) {
  await navigate();
  const citation = page.locator(`#${citationId}`);
  const source = page.locator(`#${sourceId}`);
  // Bookmark within the closed document's scroll range; expansion cannot make
  // this position depend on temporary extra document height.
  await citation.scrollIntoViewIfNeeded();
  await citation.focus();
  const before = await page.evaluate(id => {
    const trigger = document.getElementById(id);
    const r = trigger.getBoundingClientRect();
    const max = document.documentElement.scrollHeight - innerHeight;
    const top = Math.max(0, Math.min(max, r.top + scrollY - innerHeight * .45));
    window.scrollTo({ top, behavior: 'instant' });
    return { x: scrollX, y: scrollY, closedMaxScroll: max, triggerId: trigger.id };
  }, citationId);
  await citation.click();
  await page.waitForFunction(id => document.getElementById(id).open, sourceId);
  const result = { citationId, sourceId, method, viewport: page.viewportSize(), before };
  receipt.citationReturns.push(result);
  result.opened = await source.evaluate(element => ({ open: element.open, focusedId: document.activeElement?.id, focusedTag: document.activeElement?.tagName, scrollY }));
  assert.equal(await source.locator('summary').evaluate(element => element === document.activeElement), true, 'source summary receives focus');
  assert.equal(await citation.getAttribute('aria-expanded'), 'true');
  assert.match(await source.innerText(), /新增离线阅读与本地索引/);
  const original = source.locator('blockquote, [data-source-location], p').filter({ hasText: '新增离线阅读与本地索引' }).first();
  assert.equal(await original.isVisible(), true, 'original text is rendered');
  const visibleOriginal = await original.boundingBox();
  result.sourceVisible = visibleOriginal;
  if (screenshot) await save(`${sourceId}-${page.viewportSize().width}-open.png`);
  assert.ok(visibleOriginal && visibleOriginal.y >= -1 && visibleOriginal.y + visibleOriginal.height <= page.viewportSize().height + 1, `original location must be visible after reveal: ${JSON.stringify(visibleOriginal)}`);
  if (method === 'Escape') await page.keyboard.press('Escape');
  else await source.locator('button[data-citation-return]').click();
  try {
    await page.waitForFunction(({ sourceId, citationId, y }) => !document.getElementById(sourceId).open && document.activeElement?.id === citationId && Math.abs(scrollY - y) <= 2, { sourceId, citationId, y: before.y });
  } finally {
    result.after = await page.evaluate(() => ({ x: scrollX, y: scrollY, focusedId: document.activeElement?.id }));
    result.expanded = await citation.getAttribute('aria-expanded');
  }
  const after = await page.evaluate(() => ({ x: scrollX, y: scrollY, focusedId: document.activeElement?.id }));
  assert.equal(result.expanded, 'false');
  assert.equal(after.focusedId, citationId);
  assert.ok(Math.abs(after.y - before.y) <= 2, `reading position changed: ${JSON.stringify(result)}`);
  if (screenshot) await save(`${sourceId}-${page.viewportSize().width}-return.png`);
  return result;
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true });
  receipt.browserVersion = browser.version();
  const ctx = await context();
  page = await ctx.newPage();
  await check('static homepage: synthetic Lantern material, input container, title and 55:45 columns', async () => {
    await navigate();
    assert.equal(await page.locator('[data-journey-panel], #journey-visual').count(), 0, 'no retired scroll narrative');
    const metrics = await page.evaluate(() => {
      const heading = document.getElementById('hero-title');
      const form = document.getElementById('research-form');
      const columns = getComputedStyle(document.querySelector('.home-hero')).gridTemplateColumns.split(/\s+/).map(parseFloat);
      const titleStyle = getComputedStyle(heading);
      return {
        columns, firstColumnRatio: columns[0] / (columns[0] + columns[1]),
        titleColor: titleStyle.color, secondLineColor: getComputedStyle(heading.querySelector('span')).color,
        titleHeight: heading.getBoundingClientRect().height, lineHeight: parseFloat(titleStyle.lineHeight), breaks: heading.querySelectorAll('br').length,
        containedIds: ['research-question', 'question-help', 'question-error', 'submit-research', 'clear-question', 'open-example', 'form-status'].filter(id => form.contains(document.getElementById(id))),
        formText: form.innerText,
        readingSteps: [...document.querySelectorAll('[data-reading-step]')].map(section => ({ step: section.dataset.readingStep, text: section.textContent })),
      };
    });
    assert.equal(metrics.titleColor, metrics.secondLineColor, 'title lines use the same color');
    assert.equal(metrics.breaks, 1, 'title uses two deliberate lines');
    assert.ok(metrics.titleHeight >= metrics.lineHeight * 1.8 && metrics.titleHeight <= metrics.lineHeight * 2.2, 'title renders as two lines');
    assert.ok(Math.abs(metrics.firstColumnRatio - .55) <= .025, `hero ratio: ${metrics.firstColumnRatio}`);
    assert.equal(metrics.containedIds.length, 7, 'input, examples, helper, error, clear and submit belong to one control');
    assert.match(metrics.formText, /保存/);
    assert.deepEqual(metrics.readingSteps.map(section => section.step), ['1', '2', '3'], 'discovery, original and judgment boundary follow the same material');
    assert.match(metrics.readingSteps[0].text, /Lantern/);
    assert.match(metrics.readingSteps[1].text, /Lantern/);
    for (const section of metrics.readingSteps) assert.match(section.text, /离线阅读与本地索引|离线阅读\s*与本地索引/);
    assert.match(metrics.readingSteps[2].text, /\[S1\]/);
    assert.doesNotMatch((await page.locator('#submit-research, button[data-citation]').allTextContents()).join(' '), /↗/, 'internal actions do not imply external navigation');
    for (const selector of ['.hero-object', '.home-compare']) {
      assert.match(await page.locator(selector).innerText(), /原创合成示例/);
      assert.match(await page.locator(selector).innerText(), /Lantern/);
    }
    assert.match(await page.locator('.hero-object').innerText(), /林舟/);
    assert.match(await page.locator('.hero-object').innerText(), /离线阅读与本地索引/);
    await save('desktop.png');
    await save('desktop-full.png', page, true);
    return metrics;
  });
  for (const [width, height] of [[1440, 900], [1440, 650], [850, 900], [390, 844], [320, 740], [390, 450]]) {
    for (const colorScheme of ['light', 'dark']) {
      await check(`${width}×${height} ${colorScheme}: fit, touch target and ${height === 450 ? 'focused/scroll reachable submit (keyboard-size simulation)' : 'readable layout'}`, async () => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme });
        await navigate();
        const metrics = { ...(await geometry()), colorScheme, shortViewportSimulation: height === 450 };
        receipt.layouts.push(metrics);
        assertLayout(metrics, { firstScreen: width === 390 && height === 844 });
        if (height === 450) {
          await page.locator('#research-question').focus();
          await page.locator('#research-question').fill('林舟·用于离线布局检查的合成姓名');
          await page.locator('#submit-research').scrollIntoViewIfNeeded();
          const reachable = await page.locator('#submit-research').boundingBox();
          assert.ok(reachable && reachable.y >= 0 && reachable.y + reachable.height <= height, 'submit reachable after focus and scroll');
          metrics.reachableSubmit = reachable;
        }
        if (width === 390 && height === 844) {
          await save(colorScheme === 'light' ? 'mobile.png' : 'mobile-dark.png');
          if (colorScheme === 'light') await save('mobile-full.png', page, true);
        }
        if (width === 1440 && height === 900 && colorScheme === 'dark') await save('dark.png');
        if (height === 450 && colorScheme === 'light') await save('mobile-short-viewport.png');
        return metrics;
      });
    }
  }
  await check('long synthetic name and long non-fetchable URL fit mobile/desktop input and reading surfaces', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    const longName = '林舟·原创合成且用于长姓名布局验收的研究对象'.repeat(4);
    const longUrl = `https://example.org/${'synthetic-public-page-'.repeat(24)}`;
    const layouts = [];
    for (const viewport of [{ width: 320, height: 740 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await navigate();
      for (const value of [longName, longUrl]) {
        await page.locator('#research-question').fill(value);
        assert.equal(await page.locator('#research-question').inputValue(), value);
        assertLayout(await geometry());
      }
      await page.evaluate(({ longName, longUrl }) => {
        const name = document.querySelector('.paper-person strong');
        const material = document.querySelector('#home-source p');
        if (!name || !material) throw new Error('Cannot locate reading surfaces for synthetic overflow stress.');
        name.textContent = longName;
        // Plain text only: never create a fetchable fixture link.
        material.textContent = longUrl;
        document.getElementById('home-source').open = true;
      }, { longName, longUrl });
      const metrics = await geometry();
      const nameVisible = await page.locator('.paper-person strong').isVisible();
      if (viewport.width === 1440) assert.ok(nameVisible, 'desktop actually renders the stressed long name');
      layouts.push({ ...metrics, nameVisible });
      assertLayout(metrics);
      await save(`${viewport.width === 320 ? 'mobile' : 'desktop'}-long-content.png`);
    }
    await navigate();
    return { nameCharacters: longName.length, urlCharacters: longUrl.length, layouts };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [citationId, sourceId] of [['home-citation', 'home-source'], ['home-citation-2', 'home-source-2']]) {
    for (const method of ['return button', 'Escape']) {
      await check(`${citationId}: visible original, summary focus, accurate aria-expanded and ${method} restores focus/scroll`, () => inspectCitation(citationId, sourceId, method, method === 'return button'));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [citationId, sourceId] of [['home-citation', 'home-source'], ['home-citation-2', 'home-source-2']]) {
    await check(`mobile ${citationId}: original and return remain reachable`, () => inspectCitation(citationId, sourceId, 'return button', true));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await check('native source disclosure synchronizes aria-expanded', async () => {
    await navigate();
    for (const id of ['home-source', 'home-source-2']) {
      const source = page.locator(`#${id}`);
      await source.locator('summary').click();
      await page.waitForFunction(id => [...document.querySelectorAll(`button[data-citation="${id}"]`)].every(button => button.getAttribute('aria-expanded') === 'true'), id);
      assert.equal(await source.evaluate(element => element.open), true);
      await source.locator('summary').click();
      await page.waitForFunction(id => [...document.querySelectorAll(`button[data-citation="${id}"]`)].every(button => button.getAttribute('aria-expanded') === 'false'), id);
    }
  });
  await check('pointer and keyboard highlight matching claim/source within one evidence scope', async () => {
    await navigate();
    const source = page.locator('#home-source');
    const scope = source.locator('xpath=ancestor::*[@data-evidence-scope][1]');
    const key = await source.getAttribute('data-evidence-key');
    assert.ok(key, 'source identifies its evidence relation');
    const group = scope.locator('[data-evidence-key]');
    const memberInfo = await group.evaluateAll(elements => elements.map(element => ({ key: element.dataset.evidenceKey, role: element.dataset.evidenceRole, tag: element.tagName, tabindex: element.getAttribute('tabindex') })));
    const claimIndex = memberInfo.findIndex(element => element.key === key && element.role === 'claim');
    assert.ok(claimIndex >= 0, 'the source connects to a judgment');
    const claim = group.nth(claimIndex);
    // A judgment can expose its relation through an existing citation button;
    // its prose wrapper need not add an extra keyboard stop.
    const focusTarget = claim.locator('button, a[href], [tabindex]').first();
    assert.equal(await focusTarget.count(), 1, 'the judgment has a keyboard-accessible citation');
    await claim.hover();
    let related = await group.evaluateAll(elements => elements.map(element => ({ key: element.dataset.evidenceKey, related: element.dataset.related === 'true' })));
    assert.ok(related.filter(element => element.key === key).every(element => element.related), 'matching evidence highlights together');
    assert.ok(related.filter(element => element.key !== key).every(element => !element.related), 'unrelated keys stay neutral');
    assert.equal(await page.locator('#home-source-2').getAttribute('data-related'), null, 'same key in another section stays neutral');
    await save('related-evidence.png');
    await page.mouse.move(1, 1);
    await focusTarget.focus();
    assert.equal(await source.getAttribute('data-related'), 'true', 'keyboard focus exposes the same relationship');
    await page.locator('#home-citation-2').focus();
    assert.equal(await source.getAttribute('data-related'), null, 'leaving the group clears its relationship');
    related = await group.evaluateAll(elements => elements.map(element => ({ key: element.dataset.evidenceKey, related: element.dataset.related === 'true' })));
    const data = { evidenceKey: key, members: memberInfo, afterExit: related };
    receipt.relationships.push(data);
    return data;
  });
  await check('ambient light can pause and dynamic reduced-motion keeps sources readable', async () => {
    await navigate();
    const toggle = page.locator('[data-motion-toggle]');
    const home = page.locator('#view-home');
    assert.equal(await home.getAttribute('data-ambient-paused'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await home.getAttribute('data-ambient-paused'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await home.getAttribute('data-ambient-paused'), 'false');
    await page.locator('#home-citation').click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.getElementById('view-home').dataset.ambientPaused === 'true');
    assert.equal(await page.locator('#home-source').evaluate(element => element.open), true, 'inspected source remains open');
    // CSS transitions already running before a media change may retain their
    // old duration. Allow those brief feedback transitions to finish, then
    // inspect what remains; never wait for a long ambient effect.
    await page.waitForTimeout(250);
    const durations = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').map(animation => ({ name: animation.animationName, duration: animation.effect?.getComputedTiming().duration, iterations: animation.effect?.getComputedTiming().iterations })));
    assert.ok(durations.every(animation => animation.iterations !== Infinity && Number(animation.duration) <= 1), `reduced-motion running animations: ${JSON.stringify(durations)}`);
    await save('reduced-motion.png');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.getElementById('view-home').dataset.ambientPaused === 'false');
    return { runningReducedMotionAnimations: durations, sourceStayedOpen: true };
  });
  await check('blank validation, clear, example and keyboard submission hand off to guest authentication without writes', async () => {
    await navigate();
    const question = page.locator('#research-question');
    await question.focus();
    await question.press('Control+Enter');
    assert.match(await page.locator('#question-error').innerText(), /输入|填写|至少/);
    await question.fill('合成研究对象');
    await page.locator('#clear-question').click();
    assert.equal(await question.inputValue(), '');
    assert.equal(await question.evaluate(element => element === document.activeElement), true);
    await page.locator('#open-example').click();
    assert.ok((await question.inputValue()).length > 0, 'example fills without submitting');
    assert.equal(await page.locator('#auth-dialog').evaluate(element => element.open), false);
    await question.fill('合成研究对象');
    await question.press('Control+Enter');
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#auth-dialog').evaluate(element => element.open), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#auth-dialog').evaluate(element => element.open), false);
    assert.equal(await page.locator('body').getAttribute('data-view'), 'home');
  });
  await check('current self-hosted version, honest future pricing, local FAQ and no payment entry', async () => {
    await navigate();
    const pricing = page.locator('#pricing');
    assert.equal(await pricing.locator('.plan-current').count(), 1);
    assert.equal(await pricing.locator('article.plan:not(.plan-current)').count(), 0, 'future subscriptions are compact supporting copy');
    const text = await pricing.innerText();
    assert.match(text, /个人/); assert.match(text, /团队/);
    assert.match(text, /尚未开放订阅或收款|付费计费尚未开放/);
    assert.match(text, /定价待公布/);
    assert.match(text, /模型、API 与服务器费用另计/);
    assert.equal(await pricing.locator('button, form, a[href*="checkout"], a[href*="billing"], a[href*="subscribe"]').count(), 0, 'no purchase or subscription control');
    await page.locator('.nav-links a[href="#pricing"]').click();
    await save('pricing.png');
    await page.locator('.nav-links a[href="#boundaries"]').click();
    for (const details of await page.locator('.faq-list details').all()) {
      await details.locator('summary').click();
      assert.equal(await details.evaluate(element => element.open), true);
    }
    assert.equal(await page.locator('body').getAttribute('data-view'), 'home');
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await check(`no JavaScript ${viewport.width}px: native original disclosure and stable readable content`, async () => {
      const fallback = await context({ javaScriptEnabled: false, viewport });
      try {
        const p = await fallback.newPage();
        await p.goto(origin.href, { waitUntil: 'networkidle' });
        assert.equal(await p.locator('.home-hero, .home-compare, .home-identity').count(), 3);
        assertLayout(await geometry(p));
        const data = { viewport, interactions: [] };
        receipt.noJavaScript.push(data);
        const interactions = data.interactions;
        for (const id of ['home-source', 'home-source-2']) {
          const details = p.locator(`#${id}`);
          const summary = details.locator('summary');
          await summary.focus();
          const measure = () => summary.evaluate(element => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const paper = element.closest('.hero-object');
            const paperStyle = paper ? getComputedStyle(paper) : null;
            return { x: box.x, y: box.y, width: box.width, height: box.height,
              transform: style.transform, animation: style.animation, opacity: style.opacity,
              paperTransform: paperStyle?.transform, paperAnimation: paperStyle?.animation,
              viewportHeight: innerHeight, scrollY };
          });
          const beforeScroll = await measure();
          // Use the browser's native instant scroll primitive so a preceding
          // focus scroll or wheel momentum cannot move the physical click.
          // Disclosure activation below still uses real mouse/keyboard input.
          await summary.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await p.waitForTimeout(80);
          const before = await measure();
          const interaction = { sourceId: id, beforeScroll, before };
          interactions.push(interaction);
          // Check a real pointer separately from Locator's stability polling.
          assert.ok(before.y >= 0 && before.y + before.height <= viewport.height, 'native summary has reachable pointer coordinates');
          await p.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
          interaction.afterPointer = await measure();
          interaction.pointerOpened = await details.evaluate(element => element.open);
          assert.equal(interaction.pointerOpened, true, 'physical native pointer opens the source');
          await summary.focus();
          await p.keyboard.press('Enter');
          assert.equal(await details.evaluate(element => element.open), false, 'native keyboard closes the source');
          await p.keyboard.press('Enter');
          interaction.keyboardOpened = await details.evaluate(element => element.open);
          assert.equal(interaction.keyboardOpened, true, 'native keyboard reopens the source');
          assert.match(await details.innerText(), /新增离线阅读与本地索引/);
        }
        await save(`no-js-${viewport.width}.png`, p, true);
        return data;
      } finally {
        await fallback.close(); contexts.delete(fallback);
      }
    });
  }
  await check('zero browser errors, zero console errors, no external request and no non-GET request', () => {
    assert.deepEqual(receipt.browserErrors, [], 'browser errors');
    assert.deepEqual(receipt.consoleErrors, [], 'console errors');
    assert.deepEqual(receipt.httpErrors, [], 'HTTP errors');
    assert.deepEqual(receipt.blockedRequests, [], 'unexpected requests were blocked');
    return receipt.network;
  });
} catch (error) {
  receipt.checks.push({ name: 'acceptance harness', passed: false, error: error.stack ?? String(error) });
  console.error(error);
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  if (browser) await browser.close();
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = receipt.checks.length > 0 && receipt.checks.every(result => result.passed);
  await writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
const passedCount = receipt.checks.filter(result => result.passed).length;
console.log(`${receipt.passed ? 'PASS' : 'FAIL'}: ${passedCount}/${receipt.checks.length} checks. Evidence: ${output}`);
if (!receipt.passed) process.exitCode = 1;
