import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLATFORM_COVERAGE_NOTE,
  historyPreviewLabel,
  platformCoverageFromSources,
  sourceFetchStatusLabel,
  sourceKindLabel,
  sourcePlatformFromUrl,
  sourcePresentation
} from '../shared/source-presentation.js';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalSource, CanonicalView } from '../shared/types.js';
import { installDom } from './dom-env.js';

const env = installDom();
const { renderReport, renderSourceDetail, renderSourceList } = await import('../client/render.js');
const { createCitationReturn } = await import('../client/citation-return.js');

function sourceWith(overrides: Partial<CanonicalSource> = {}): CanonicalSource {
  return {
    sourceKey: 'S1',
    url: 'https://github.com/example/repo',
    title: '合成来源',
    kind: 'profile',
    publishedAt: '2024-01-01T00:00:00.000Z',
    retrievedAt: '2024-01-01T00:00:00.000Z',
    fetchStatus: 'ok',
    excerpt: '公开简介片段',
    excerptLocator: '公开简介',
    identityLabel: '种子账号',
    identityConfirmed: true,
    limits: [],
    excluded: false,
    excludedAt: null,
    ...overrides
  };
}

function viewWith(overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run_presentation',
    state: 'completed',
    revision: 1,
    question: '合成问题',
    seedUrl: 'https://github.com/example/repo',
    provider: 'github',
    parentRunId: null,
    retryOf: null,
    followup: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    interrupted: false,
    stopReason: 'test',
    identity: {
      displayName: 'Example',
      handle: 'example',
      profileUrl: 'https://github.com/example/repo',
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [sourceWith()],
    observations: [],
    answer: [
      {
        id: 'identity',
        heading: '这个人是谁',
        body: '公开资料。',
        bullets: [
          { text: '合成结论', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null }
        ]
      }
    ],
    limitations: [],
    usage: { provider: 'github', requests: 1, bytes: 10, elapsedMs: 1, measurement: 'observed' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

function detailHandlers(): Parameters<typeof renderSourceDetail>[3] {
  return { onSelect: () => undefined, onExclude: () => undefined, onRestore: () => undefined, onUndo: () => undefined };
}

// ---------- conservative platform host matching ----------

test('known platform hosts match conservatively with a presentation-only label', () => {
  const cases: Array<[string, string, string | null]> = [
    ['https://github.com/simonw/datasette', 'github', '仓库页面'],
    ['https://gist.github.com/user/abc', 'github', '代码片段页面'],
    ['https://github.com./simonw', 'github', '账号页面'],
    ['https://x.com/handle/status/123', 'x', '帖子页面'],
    ['https://twitter.com/handle', 'x', '账号页面'],
    ['https://bsky.app/profile/handle.com/post/3k', 'bluesky', '帖子页面'],
    ['https://www.threads.net/@handle/post/abc', 'threads', '帖子页面'],
    ['https://www.reddit.com/r/programming/comments/abc/title', 'reddit', '帖子页面'],
    ['https://www.youtube.com/watch?v=abc123', 'youtube', '视频页面'],
    ['https://youtu.be/abc123', 'youtube', null],
    ['https://space.bilibili.com/12345', 'bilibili', '账号页面'],
    ['https://www.bilibili.com/video/BV1', 'bilibili', '视频页面'],
    ['https://www.xiaohongshu.com/explore/64abc', 'xiaohongshu', '笔记页面'],
    ['https://www.douyin.com/@handle/video/123', 'douyin', '视频页面'],
    ['https://www.tiktok.com/@handle/video/123', 'tiktok', '视频页面'],
    ['https://www.instagram.com/p/abc/', 'instagram', '帖子页面'],
    ['https://www.facebook.com/watch/?v=1', 'facebook', '视频页面'],
    ['https://www.zhihu.com/question/123', 'zhihu', '问题页面'],
    ['https://zhuanlan.zhihu.com/p/123', 'zhihu', '文章页面'],
    ['https://mp.weixin.qq.com/s/abc', 'wechat', '文章页面']
  ];
  for (const [url, id, form] of cases) {
    const presentation = sourcePlatformFromUrl(url);
    assert.equal(presentation.matched, true, `${url} should match`);
    assert.equal(presentation.id, id, url);
    assert.equal(presentation.safeHref, url, url);
    assert.equal(presentation.contentFormLabel, form, url);
    assert.ok(presentation.hostLabel.length > 0, url);
    assert.ok(presentation.limits.join('').includes('不是身份归属'), url);
  }
  const video = sourcePlatformFromUrl('https://www.youtube.com/watch?v=abc123');
  assert.ok((video.contentFormNote ?? '').includes('未读取'));
  assert.ok((video.contentFormNote ?? '').includes('不代表已观看'));
});

test('confusing suffix hosts never claim a platform and fall back to a website', () => {
  for (const url of [
    'https://github.com.evil.example/simonw',
    'https://fakegithub.com/simonw',
    'https://mygithub.com/simonw',
    'https://x.com.malicious.example/handle',
    'https://notx.com/handle',
    'https://twitter.com.example.org/handle',
    'https://tiktok.com.attacker.net/@handle',
    'https://myxiaohongshu.com/explore/1',
    'https://example.org/github.com',
    'https://weixin.qq.com.evil.example/s/abc',
    'https://x.com.cn/handle'
  ]) {
    const presentation = sourcePlatformFromUrl(url);
    assert.equal(presentation.matched, false, url);
    assert.equal(presentation.id, 'website', url);
    assert.equal(presentation.label, '网站', url);
    assert.equal(presentation.contentFormLabel, null, url);
  }
});

test('malformed or unsafe URLs refuse links and fall back safely', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd', 'vbscript:x']) {
    const presentation = sourcePlatformFromUrl(url);
    assert.equal(presentation.matched, false, url);
    assert.equal(presentation.safeHref, null, url);
  }
  for (const url of ['not a url', 'https://', 'http://', 'https:///path', 'http://myserver/read']) {
    const presentation = sourcePlatformFromUrl(url);
    assert.equal(presentation.matched, false, url);
    assert.equal(presentation.safeHref, null, url);
    assert.ok(presentation.limits.join('').length > 0, url);
  }
  for (const value of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(sourcePlatformFromUrl(value).hostLabel, '未提供链接');
    assert.equal(sourcePlatformFromUrl(value).safeHref, null);
  }
  const credentialed = sourcePlatformFromUrl('https://user:pass@github.com/simonw');
  assert.equal(credentialed.matched, false);
  assert.equal(credentialed.safeHref, null);
  assert.ok(credentialed.limits.join('').includes('凭据'));
  // A valid but unknown host is still a plain website, never a guessed platform.
  const generic = sourcePlatformFromUrl('https://blog.example.net/post/1');
  assert.equal(generic.id, 'website');
  assert.equal(generic.hostLabel, 'blog.example.net');
  assert.equal(generic.safeHref, 'https://blog.example.net/post/1');
});

// ---------- unsupported / unknown fields ----------

test('unknown historical fields fall back without claiming material or platform', () => {
  const presentation = sourcePresentation({ url: 'https://github.com/a/b', kind: 'mystery', fetchStatus: 'mystery', excluded: false });
  assert.equal(presentation.kindLabel, '类型未知');
  assert.equal(presentation.statusLabel, '状态未知');
  assert.equal(presentation.obtainedMaterial, false);
  assert.equal(sourceFetchStatusLabel(undefined), '状态未知');
  assert.equal(sourceKindLabel('work'), '作品');
  assert.equal(sourceKindLabel(undefined), '类型未知');
  const truncated = sourcePresentation({ url: 'https://x.com/a/status/1', fetchStatus: 'truncated' });
  assert.equal(truncated.obtainedMaterial, false);
  assert.equal(truncated.statusLabel, '被截断');
  assert.ok(truncated.materialNote.includes('未确认已取得材料'));
  const excluded = sourcePresentation({ url: 'https://x.com/a/status/1', fetchStatus: 'ok', excluded: true });
  assert.equal(excluded.obtainedMaterial, false);
  assert.ok(excluded.materialNote.includes('不作为已采用材料'));
});

test('obtained material is claimed only for fetchStatus ok and never as complete history', () => {
  const obtained = sourcePresentation({ url: 'https://github.com/a/b', kind: 'work', fetchStatus: 'ok', excluded: false });
  assert.equal(obtained.obtainedMaterial, true);
  assert.ok(obtained.materialNote.includes('。已取得材料，'));
  assert.ok(obtained.materialNote.includes('不代表该来源或该平台的全部历史已读完'));
  // Old canonical sources (only the historical fields) work unchanged.
  const legacy = sourcePresentation({ url: 'https://example.org/a', kind: 'third_party', fetchStatus: 'inaccessible' });
  assert.equal(legacy.obtainedMaterial, false);
  assert.equal(legacy.statusLabel, '未能读取');
  assert.ok(legacy.materialNote.includes('未确认已取得材料'));
});

// ---------- real source-platform coverage summary ----------

test('coverage summary counts actual run sources only and stays honest about gaps', () => {
  const summary = platformCoverageFromSources([
    { url: 'https://github.com/a/b', fetchStatus: 'ok', excluded: false },
    { url: 'https://github.com/a/c', fetchStatus: 'ok', excluded: false },
    { url: 'https://github.com/a/d', fetchStatus: 'inaccessible', excluded: false },
    { url: 'https://x.com/a/status/1', fetchStatus: 'ok', excluded: false },
    { url: 'https://www.youtube.com/watch?v=1', fetchStatus: 'ok', excluded: true },
    { url: 'javascript:alert(1)', fetchStatus: 'ok', excluded: false }
  ]);
  assert.equal(summary.totalSources, 6);
  assert.equal(summary.obtainedSources, 4);
  const github = summary.entries.find((entry) => entry.id === 'github');
  assert.deepEqual(github, { id: 'github', label: 'GitHub', total: 3, obtained: 2, excluded: 0 });
  const youtube = summary.entries.find((entry) => entry.id === 'youtube');
  assert.deepEqual(youtube, { id: 'youtube', label: 'YouTube', total: 1, obtained: 0, excluded: 1 });
  const website = summary.entries.find((entry) => entry.id === 'website');
  assert.deepEqual(website, { id: 'website', label: '网站', total: 1, obtained: 1, excluded: 0 });
  assert.equal(summary.note, PLATFORM_COVERAGE_NOTE);
  assert.ok(summary.note.includes('未列出的平台不代表被搜索过'));
  assert.ok(summary.note.includes('不代表全部历史已读完'));
  const empty = platformCoverageFromSources([]);
  assert.equal(empty.totalSources, 0);
  assert.deepEqual(empty.entries, []);
});

// ---------- history preview URL compression ----------

test('history previews compress URLs so URL plus prose never renders an enormous path', () => {
  const question = 'https://docs.google.com/document/d/1a%2Fb%2Fc%2Fd%2Fe%2Ff%2Fg%2Fh%2Fi%2Fj%2Fk%2Fl/edit?usp=sharing 这份采访提纲需要核对';
  const label = historyPreviewLabel(question);
  assert.ok(label.includes('docs.google.com'), label);
  assert.ok(label.includes('这份采访提纲需要核对'), label);
  assert.ok(!label.includes('%2F'), label);
  assert.ok(!label.includes('usp=sharing'), label);
  assert.ok(label.length < question.length, label);
  assert.ok(label.length <= 121, label);
  assert.equal(historyPreviewLabel('https://www.example.org/people/lin'), 'example.org/people/lin');
  assert.equal(historyPreviewLabel('林舟的公开作品'), '林舟的公开作品');
  assert.equal(historyPreviewLabel(''), '未命名研究');
  assert.equal(historyPreviewLabel('https://github.com/simonw/datasette看看这个仓库'), 'github.com/simonw/datasette看看这个仓库');
  assert.equal(historyPreviewLabel('看看 https://example.org/a/b。'), '看看 example.org/a/b。');
});

// ---------- safe rendering ----------

test('source detail shows quiet platform/domain/status context and loads no third-party resources', () => {
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const view = viewWith({
    sources: [sourceWith({ url: 'https://www.youtube.com/watch?v=abc', kind: 'third_party', fetchStatus: 'inaccessible', limits: ['旧报告限制'] })]
  });
  renderSourceDetail(container, view, 'S1', detailHandlers());
  assert.equal(container.querySelectorAll('img,iframe,script,link,object,embed,video,audio,source,track').length, 0);
  const text = container.textContent ?? '';
  assert.ok(text.includes('YouTube'));
  assert.ok(text.includes('youtube.com'));
  assert.ok(text.includes('视频页面'));
  assert.ok(text.includes('不代表已观看'));
  assert.ok(text.includes('未能读取'));
  assert.ok(text.includes('旧报告限制'));
  assert.ok(!text.includes('。已取得材料'));
  const anchor = container.querySelector('a');
  assert.equal(anchor?.getAttribute('href'), 'https://www.youtube.com/watch?v=abc');
  assert.match(anchor?.getAttribute('rel') ?? '', /noopener/);
  container.remove();
});

test('unsafe source URLs render as plain text with visible limits, never as links', () => {
  const container = env.document.createElement('div');
  const view = viewWith({ sources: [sourceWith({ url: 'javascript:alert(1)', excerpt: null })] });
  renderSourceDetail(container, view, 'S1', detailHandlers());
  assert.equal(container.querySelectorAll('a').length, 0);
  const text = container.textContent ?? '';
  assert.ok(text.includes('javascript:alert(1)'));
  assert.ok(text.includes('不生成可点击链接'));
  assert.ok(text.includes('这份来源没有可用于展示的短摘录'));
});

test('source rows carry platform/domain/status context and the coverage ignores the active filter', () => {
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const view = viewWith({
    sources: [
      sourceWith(),
      sourceWith({ sourceKey: 'S2', url: 'https://x.com/a/status/1', kind: 'work', fetchStatus: 'truncated' }),
      sourceWith({ sourceKey: 'S3', url: 'javascript:alert(1)', kind: 'third_party', fetchStatus: 'inaccessible' }),
      sourceWith({ sourceKey: 'S4', url: 'https://github.com/a/c', excluded: true })
    ]
  });
  renderSourceList(container, view, null, 'all', () => undefined);
  const rows = [...container.querySelectorAll<HTMLElement>('button.source-row')];
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.dataset.platform, 'github');
  assert.ok(rows[0]?.textContent?.includes('GitHub · github.com · 主页'));
  assert.ok(rows[0]?.textContent?.includes('已读取'));
  assert.ok(rows[1]?.textContent?.includes('X（Twitter） · x.com · 作品'));
  assert.ok(rows[1]?.textContent?.includes('被截断'));
  assert.ok(rows[2]?.textContent?.includes('第三方'));
  assert.ok(rows[2]?.textContent?.includes('未能读取'));
  const text = container.textContent ?? '';
  assert.ok(text.includes('来源平台覆盖（按本次实际来源）'));
  assert.ok(text.includes('共 4 条来源，1 条已取得材料'), text);
  assert.ok(text.includes(PLATFORM_COVERAGE_NOTE.slice(0, 12)));
  // The summary is derived from all run sources, not from the active filter.
  renderSourceList(container, view, null, 'work', () => undefined);
  const filtered = container.textContent ?? '';
  assert.ok(filtered.includes('共 4 条来源，1 条已取得材料'), filtered);
  assert.equal(container.querySelectorAll('button.source-row').length, 1);
  assert.equal(container.querySelectorAll('img,iframe,script,link').length, 0);
  container.remove();
});

test('source pagination and exact citation return survive platform rendering and filtering', () => {
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const base = viewWith();
  const view = viewWith({
    sources: Array.from({ length: 150 }, (_, index) =>
      sourceWith({
        sourceKey: `S${index + 1}`,
        url: index % 2 === 0 ? 'https://github.com/a/b' : 'https://www.reddit.com/r/test/comments/1/t',
        title: `合成来源 ${index + 1}`
      })
    )
  });
  const select = (): void => undefined;
  renderSourceList(container, view, null, 'all', select);
  assert.ok(container.textContent?.includes('1–100 / 150'));
  assert.ok(container.textContent?.includes('来源平台覆盖'));
  container.querySelector<HTMLButtonElement>('[data-source-page="next"]')!.click();
  assert.ok(container.textContent?.includes('101–150 / 150'));
  assert.ok(container.textContent?.includes('来源平台覆盖'));
  assert.ok(container.textContent?.includes('共 150 条来源'));

  const report = env.document.createElement('div');
  const scroller = env.document.createElement('div');
  env.document.body.append(report, scroller);
  renderReport(report, base, { onCitation: () => undefined });
  const button = report.querySelector<HTMLElement>('button.citation')!;
  const controller = createCitationReturn({
    doc: env.document,
    win: env.window as unknown as Window,
    report: () => report,
    scroller: () => scroller,
    runId: () => base.runId,
    reducedMotion: () => true
  });
  controller.enterViaCitation('S1', button.dataset.citationAnchor!, button);
  renderSourceList(container, view, 'S1', 'all', select);
  renderSourceList(container, view, 'S1', 'profile', select);
  renderReport(report, base, { onCitation: () => undefined });
  controller.sync();
  assert.equal(controller.returnToCitation(), true);
  const focused = env.document.activeElement as HTMLElement | null;
  assert.equal(focused?.dataset.source, 'S1');
  assert.equal(focused?.dataset.citationAnchor, button.dataset.citationAnchor);
  container.remove();
  report.remove();
  scroller.remove();
});
test('private and URL-normalized local addresses never become clickable sources', () => {
  for (const host of ['127.0.0.1', '127.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', 'service.local', 'service.internal', 'service.local.']) {
    assert.equal(sourcePlatformFromUrl(`https://${host}/`).safeHref, null, host);
  }
});
