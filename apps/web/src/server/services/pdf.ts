import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { HttpError } from '../http/errors.js';

let busy = false;
export function chromiumExecutable(): string | null {
  const explicit = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync) ?? null;
}

/** Render only our escaped local template, with all browsing and JS disabled. */
export async function renderReportPdf(html: string): Promise<Buffer> {
  const executablePath = chromiumExecutable();
  if (!executablePath) throw new HttpError(503, 'pdf_unavailable', 'PDF 导出暂不可用，请先下载 HTML。');
  if (busy) throw new HttpError(429, 'pdf_busy', '正在生成其他 PDF，请稍后再试。');
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new HttpError(413, 'report_too_large', '报告超出 PDF 大小限制，请下载 JSON。');
  busy = true;
  let browser: Browser | undefined;
  let browserHome: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Chromium's crash handler needs a writable home even when its profile is in /tmp.
    browserHome = await mkdtemp(join(tmpdir(), 'stripsearch-pdf-'));
    const browserEnv = Object.fromEntries(['PATH', 'LANG', 'TZ', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!] ]));
    browser = await chromium.launch({ env: { ...browserEnv, HOME: browserHome, XDG_CONFIG_HOME: browserHome, XDG_CACHE_HOME: browserHome }, executablePath, headless: true, timeout: 10_000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking'] });
    timer = setTimeout(() => { void browser?.close().catch(() => undefined); }, 15_000);
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } catch {
    throw new HttpError(503, 'pdf_unavailable', 'PDF 生成失败，请重试或下载 HTML。');
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await browser?.close().catch(() => undefined);
      if (browserHome) await rm(browserHome, { recursive: true, force: true }).catch(() => undefined);
    } finally { busy = false; }
  }
}
