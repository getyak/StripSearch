/** Synthetic browser acceptance. API requests are fulfilled locally; no accounts,
 * provider calls, fixture URLs or persistent writes. Pass: loopback-origin output
 * [client-dist|live] [baseline|verify]. `live` reads only the served entry assets.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [originArg, output, client = 'live', mode = 'verify'] = process.argv.slice(2);
const origin = new URL(originArg);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
assert.ok(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password);
assert.ok(output && path.isAbsolute(output));
assert.ok(client === 'live' || path.isAbsolute(client));
assert.ok(['baseline', 'verify'].includes(mode));
await mkdir(output, { recursive: true });
const receipt = { startedAt: new Date().toISOString(), mode, client, scope: 'Original synthetic report; all APIs mocked, external requests blocked; no real account or paid research.',
  checks: [], layouts: [], screenshots: [], errors: [], httpErrors: [], external: [], apiRequests: [] };
const now = '2026-10-21T06:00:00.000Z';
const source = (key, title, kind, excerpt) => ({ sourceKey: key, title, kind, url: `https://example.org/synthetic/${key}`,
  publishedAt: '2025-06-01', retrievedAt: now, fetchStatus: 'ok', excerpt, excerptLocator: '原创合成更新记录正文',
  identityLabel: '仅为合成材料归属', identityConfirmed: true, limits: ['原创合成，非真实人物材料'], excluded: false, excludedAt: null });
const base = { schemaVersion: 'stripsearch/web-alpha/v1', runId: 'synthetic-get-253', state: 'completed', revision: 37,
  question: '林舟的公开项目记录能支持哪些判断？', seedUrl: null, provider: 'research', parentRunId: null, retryOf: null,
  followup: false, createdAt: now, updatedAt: now, interrupted: false, stopReason: null,
  identity: { displayName: '林舟', handle: 'synthetic-lin', profileUrl: 'https://example.org/synthetic/profile', status: 'resolved', note: null, candidates: [] },
  sources: [source('S1', '林舟 · 原创合成人物页', 'profile', '林舟的原创合成人物资料。'),
    source('S2', 'Lantern · 2025 年 6 月合成更新记录', 'work', '新增离线阅读与本地索引。')],
  observations: [{ observationId: 'O1', statement: '实际使用效果仍未知。', kind: 'inference', sourceKeys: ['S2'], limitations: ['没有独立效果证据'], validity: 'valid', reviewReason: null }],
  answer: [{ id: 'work', heading: '作品与行动', body: '原创合成报告，用于验证阅读与引用，不是实时研究。', bullets: [
    { text: '2025 年 6 月的 Lantern 更新记录宣布了离线阅读与本地索引。', sourceKeys: ['S2'], kind: 'page_statement', validity: 'valid', reviewReason: null },
    { text: '这份更新记录不能证明林舟独立完成了这些功能。', sourceKeys: ['S2'], kind: 'inference', validity: 'valid', reviewReason: null }
  ] }], limitations: ['原创合成示例，不代表真实人物发现。'],
  usage: { provider: 'research', requests: 2, bytes: 100, elapsedMs: 100, measurement: 'observed' }, reviewCount: 0,
  research: { phase: 'done', steps: 2, stopReason: null, unresolved: [], budget: { toolCalls: 2, modelCalls: 0, inputTokens: 0, outputTokens: 0,
    estimatedUsd: 0, firecrawlCredits: 0, unknownCost: true, limits: { toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 } } } };
await writeFile(path.join(output, 'synthetic-report.json'), JSON.stringify(base, null, 2));
let browser;
let page;
async function check(name, action) {
  if (process.env.REPORT_CHECK_FILTER && !name.includes(process.env.REPORT_CHECK_FILTER)) return;
  try { const detail = await action(); receipt.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); }
  catch (error) {
    receipt.checks.push({ name, passed: false, error: error.stack ?? String(error) });
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, `failure-${receipt.checks.length}.png`) }).catch(() => {});
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
async function open(width, colorScheme = 'light', variant = {}, { height = 844, touch = false, empty = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, hasTouch: touch, isMobile: touch,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  context.setDefaultTimeout(6000);
  let run = { ...structuredClone(base), ...variant };
  const summary = () => { const { runId, question, state, provider, revision, createdAt, updatedAt, reviewCount } = run;
    return { runId, question, state, provider, revision, createdAt, updatedAt, reviewCount, sourceCount: run.sources.length }; };
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin.origin) { receipt.external.push(url.origin); return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/api/')) {
      receipt.apiRequests.push({ method: request.method(), path: url.pathname });
      if (request.method() !== 'GET' && !(request.method() === 'POST' && /\/(retry|cancel)$/.test(url.pathname))) {
        receipt.errors.push(`Unexpected mock mutation: ${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 400, json: { error: { message: 'Unexpected synthetic mutation' } } });
      }
      let value;
      if (url.pathname === '/api/health') value = { status: 'ok', capabilities: { github: true, exa: true, research: true } };
      else if (url.pathname === '/api/auth/get-session') value = { user: { id: 'synthetic-get-253-owner', email: 'synthetic@example.test', name: '合成验收' }, session: { id: 'synthetic-session' } };
      else if (url.pathname === '/api/runs') value = { runs: empty ? [] : [summary()] };
      else if (url.pathname.endsWith('/retry') && request.method() === 'POST') {
        run = { ...run, runId: 'synthetic-retry', state: 'completed', stopReason: null, retryOf: run.runId };
        value = { run, idempotent: false };
      } else if (url.pathname.endsWith('/cancel') && request.method() === 'POST') {
        run = { ...run, state: 'cancelled', stopReason: 'cancelled' }; value = { run };
      } else if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic stream\n\n' });
      else if (url.pathname.startsWith('/api/runs/')) value = { run, events: [], latestSeq: 0 };
      else return route.fulfill({ status: 404, json: { error: { message: 'Unexpected synthetic API route' } } });
      return route.fulfill({ status: 200, json: value });
    }
    if (request.method() !== 'GET') return route.abort('blockedbyclient');
    if (client === 'live') return route.continue();
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const file = path.resolve(client, rel);
    if (!file.startsWith(path.resolve(client) + path.sep)) return route.abort('blockedbyclient');
    try {
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      return route.fulfill({ status: 200, contentType, body: await readFile(file) });
    } catch { return route.fulfill({ status: 404, body: 'Missing built asset' }); }
  });
  page = await context.newPage();
  page.on('pageerror', error => receipt.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') receipt.errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) receipt.httpErrors.push({ url: response.url(), status: response.status() }); });
  await page.goto(`${origin.origin}/#/app${empty ? '' : `/${run.runId}`}`, { waitUntil: 'networkidle' });
  await page.locator(empty ? '#report .stage-panel' : ['queued', 'researching'].includes(run.state) ? '#research-live' : '#report .report-header h2').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return context;
}
async function capture(name) {
  await page.screenshot({ path: path.join(output, name) }); receipt.screenshots.push(name);
}
async function geometry() {
  return page.evaluate(() => {
    const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: getComputedStyle(el).fontSize }; };
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
      reportWidth: document.querySelector('#report').scrollWidth, reportClientWidth: document.querySelector('#report').clientWidth,
      name: rect('#report h2'), citation: rect('#report .citation'), finding: rect('#report .finding'),
      metadata: rect('#report .report-meta'), body: rect('#work-body') };
  });
}
async function citationReturn(touch) {
  const cite = page.locator('#report [data-citation-anchor="s0b0c0"]');
  await cite.scrollIntoViewIfNeeded(); await cite.focus();
  const before = await page.locator('#work-body').evaluate(el => el.scrollTop);
  if (touch) await cite.tap(); else await cite.press('Enter');
  const narrow = (page.viewportSize()?.width ?? 1280) <= 1220;
  const detail = page.locator(narrow ? '#drawer-source-detail' : '#inspector-detail');
  await detail.waitFor({ state: 'visible' });
  assert.match(await detail.innerText(), /新增离线阅读与本地索引/);
  const back = detail.locator('.return-citation');
  if (touch) await back.tap(); else await back.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-citation-anchor') === 's0b0c0');
  assert.ok(Math.abs(await page.locator('#work-body').evaluate(el => el.scrollTop) - before) <= 1);
  if (narrow) assert.equal(await page.locator('#source-drawer').evaluate(el => el.open), false);
}
async function doubleTextSize(target) {
  await page.evaluate(() => document.getElementById('reading-text-scale')?.remove());
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  const result = await page.evaluate(target => {
    const selector = el => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el === document.body) return 'body';
      const siblings = [...el.parentElement.children].filter(s => s.tagName === el.tagName);
      return `${selector(el.parentElement)} > ${el.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(el) + 1})`;
    };
    const before = parseFloat(getComputedStyle(document.querySelector(target)).fontSize);
    const rules = [...document.querySelectorAll('body, body *')].filter(el => el instanceof HTMLElement).map(el => {
      const style = getComputedStyle(el);
      return `${selector(el)} {font-size:${parseFloat(style.fontSize) * 2}px!important;${style.lineHeight === 'normal' ? '' : `line-height:${parseFloat(style.lineHeight) * 2}px!important;`}}`;
    });
    const style = document.createElement('style'); style.id = 'reading-text-scale'; style.textContent = rules.join('\n'); document.head.appendChild(style);
    return { before, expected: before * 2, ruleCount: rules.length };
  }, target);
  // Reduced motion still gives CSS properties a .01ms transition. Wait for the
  // computed size rather than sampling its initial frame.
  await page.waitForFunction(({ target, expected }) => parseFloat(getComputedStyle(document.querySelector(target)).fontSize) >= expected, { target, expected: result.expected });
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  return result;
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true });
  receipt.driverPid = process.pid;
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) await check(`report and homepage ${width} ${theme}`, async () => {
    const context = await open(width, theme, {}, { height: width === 1280 ? 900 : 844, touch: width === 390 });
    try {
      const metrics = await geometry(); receipt.layouts.push({ width, theme, ...metrics });
      assert.ok(metrics.scrollWidth <= width + 1, 'no page overflow');
      await capture(`report-${width}-${theme}.png`);
      if (mode === 'verify') {
        assert.ok(metrics.citation.y + metrics.citation.height <= metrics.viewport.height, 'first citation is visible on the first screen');
        assert.ok(metrics.name.y < metrics.finding.y, 'identity precedes the finding');
        assert.ok(parseFloat(metrics.name.fontSize) > parseFloat(await page.locator('#desk-state').evaluate(el => getComputedStyle(el).fontSize)));
        assert.equal(await page.locator('.report-record').evaluate(el => el.open), false);
        assert.equal(await page.locator('#activity-panel').evaluate(el => el.open), false);
        assert.equal(await page.locator('#work-title-text').locator('..').locator('#work-revision').count(), 0);
      }
      await citationReturn(width === 390);
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#report h2').waitFor();
      assert.equal(await page.locator('#report [data-citation-anchor="s0b0c0"]').count(), 1);
      await page.goto(`${origin.origin}/#/`, { waitUntil: 'networkidle' });
      await page.locator('#hero-title').waitFor({ state: 'visible' });
      await capture(`home-${width}-${theme}.png`);
      if (mode === 'verify') {
        const home = await page.evaluate(() => {
          const name = document.querySelector('.paper-person strong').getBoundingClientRect();
          const cite = document.getElementById('home-citation').getBoundingClientRect();
          return { nameY: name.y, citationBottom: cite.bottom, height: innerHeight };
        });
        assert.ok(home.nameY < home.citationBottom && home.citationBottom <= home.height, 'homepage person and first citation are visible');
      }
      await page.locator('#home-citation').click();
      await page.locator('#home-source .citation-return').click();
      assert.equal(await page.locator('#home-citation').evaluate(el => el === document.activeElement), true);
      return metrics;
    } finally { await context.close(); }
  });
  if (mode === 'verify') {
    await check('320px, long names and long findings', async () => {
      const context = await open(320, 'light', { identity: { ...base.identity, displayName: '原创合成人物的很长姓名用于窄屏换行核对' },
        question: '很长的研究问题'.repeat(25), answer: [{ ...base.answer[0], bullets: [{ ...base.answer[0].bullets[0], text: base.answer[0].bullets[0].text.repeat(12) }] }] });
      try { const metrics = await geometry(); assert.ok(metrics.scrollWidth <= 321); assert.ok(metrics.reportWidth <= metrics.reportClientWidth + 1); await citationReturn(false); await capture('long-320.png'); return metrics; }
      finally { await context.close(); }
    });
    await check('200 percent text and reduced motion', async () => {
      const context = await open(390);
      try {
        receipt.textScaling = await doubleTextSize('#report h2');
        const metrics = await geometry(); receipt.textScaling.geometry = metrics; await capture('text-200-390.png');
        assert.ok(metrics.scrollWidth <= 391); assert.ok(metrics.reportWidth <= metrics.reportClientWidth + 1);
        assert.ok(parseFloat(metrics.name.fontSize) >= 60, `actual scaled name size: ${metrics.name.fontSize}`);
        await citationReturn(false); await capture('text-200-390.png');
        assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length), 0);
        await page.goto(`${origin.origin}/#/`, { waitUntil: 'networkidle' });
        receipt.homeTextScaling = await doubleTextSize('.paper-person strong');
        receipt.homeTextScaling.overflow = await page.evaluate(() => [...document.querySelectorAll('#view-home *, .site-nav *')].filter(el => {
          const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
        }).slice(0, 20).map(el => ({ tag: el.tagName, id: el.id, className: el.className, right: el.getBoundingClientRect().right })));
        await capture('home-text-200-390.png');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator('#submit-research').scrollIntoViewIfNeeded();
        await capture('home-text-200-390.png');
        return metrics;
      } finally { await context.close(); }
    });
    await check('partial billing and platform gaps retain reasons and controls', async () => {
      const context = await open(390, 'dark', { state: 'partial', stopReason: 'budget_exhausted', research: { ...base.research,
        stopReason: 'budget_exhausted', unresolved: ['所选账号初始材料未读取成功（provider_billing）：https://x.com/synthetic-get-253；不代表无资料。', '合成平台尚未读取完整历史。'] } });
      try {
        const strip = page.locator('#run-status-summary'); assert.equal(await strip.isVisible(), true); assert.match(await strip.innerText(), /预算/);
        const gaps = strip.locator('details'); assert.equal(await gaps.evaluate(el => el.open), false);
        await gaps.locator('summary').press('Enter'); assert.match(await gaps.innerText(), /计费|额度/);
        await capture('partial-billing-390.png');
        await page.locator('#more-menu > summary').click(); assert.equal(await page.locator('#retry-run').isVisible(), true);
        await page.locator('#more-menu > summary').click();
        await page.locator('#report .report-record > summary').click(); assert.match(await page.locator('.report-record').innerText(), /v37/);
      } finally { await context.close(); }
    });
    await check('failed empty report retains retry and reload', async () => {
      const context = await open(390, 'light', { state: 'failed', answer: [], observations: [], sources: [], stopReason: 'provider_billing' });
      try {
        assert.match(await page.locator('#report').innerText(), /还没有可核对的结论/);
        assert.equal(await page.locator('#report .citation').count(), 0);
        assert.equal(await page.locator('#run-status-summary').isVisible(), true);
        await capture('empty-error-390.png');
        await page.locator('#more-menu > summary').click(); await page.locator('#retry-run').click();
        await page.waitForURL(/synthetic-retry/); await page.reload({ waitUntil: 'networkidle' });
        await page.locator('#report h2').waitFor();
        assert.ok(receipt.apiRequests.some(r => r.method === 'POST' && r.path.endsWith('/retry')));
      } finally { await context.close(); }
    });
    await check('withdrawn evidence stays marked for review', async () => {
      const context = await open(1280, 'light', { reviewCount: 1, sources: base.sources.map(s => s.sourceKey === 'S2' ? { ...s, excluded: true, fetchStatus: 'excluded' } : s),
        answer: [{ ...base.answer[0], bullets: [{ ...base.answer[0].bullets[0], validity: 'review', reviewReason: 'S2 已撤下' }] }] });
      try { assert.match(await page.locator('#report .review-flag').innerText(), /待复核.*S2/); await capture('withdrawn-evidence-1280.png'); }
      finally { await context.close(); }
    });
    await check('processing stays explicit and can be cancelled', async () => {
      const context = await open(390, 'light', { state: 'researching', answer: [], observations: [], sources: [],
        research: { ...base.research, phase: 'reading' } });
      try {
        assert.equal(await page.locator('#research-live').isVisible(), true);
        assert.equal(await page.locator('#stop-run').isVisible(), true);
        assert.equal(await page.locator('#run-status-summary').isVisible(), false);
        await capture('processing-390.png');
        await page.locator('#stop-run').click();
        await page.locator('#report .report-header h2').waitFor();
        assert.match(await page.locator('#desk-state').innerText(), /已取消/);
        assert.equal(await page.locator('#research-live').isVisible(), false);
      } finally { await context.close(); }
    });
    await check('empty history offers a real next action without findings', async () => {
      const context = await open(390, 'light', {}, { empty: true });
      try {
        assert.equal(await page.locator('#report .citation').count(), 0);
        assert.equal(await page.locator('#report .button').isVisible(), true);
        await capture('empty-history-390.png');
      } finally { await context.close(); }
    });
    await check('short viewport keeps citation return reachable', async () => {
      const context = await open(390, 'light', {}, { height: 450, touch: true });
      try { await citationReturn(true); await capture('short-390-450.png'); }
      finally { await context.close(); }
    });
  }
} finally {
  if (browser) await browser.close();
  receipt.browserClosed = true;
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = receipt.checks.every(c => c.passed) && receipt.errors.length === 0 && receipt.httpErrors.length === 0 && receipt.external.length === 0;
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
if (!receipt.passed) process.exitCode = 1;
