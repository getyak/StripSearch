import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView } from '../shared/types.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html?: string, options?: Record<string, unknown>) => { window: Record<string, unknown> };
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
(globalThis as unknown as { window: unknown }).window = jsdomWindow;
(globalThis as unknown as { document: Document }).document = jsdomWindow.document;
(globalThis as unknown as { requestAnimationFrame: (cb: (time: number) => void) => number }).requestAnimationFrame =
  (cb) => setTimeout(() => cb(0), 0) as unknown as number;

const { renderReport, renderSourceDetail, renderSourceList, stagesFromEvents } = await import('../client/render.js');
const { renderActivity } = await import('../client/render.js');

function domContainer(): HTMLElement {
  return jsdomWindow.document.createElement('div');
}

function viewWith(overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run_dom',
    state: 'completed',
    revision: 1,
    question: '问题',
    seedUrl: 'https://github.com/example',
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
      profileUrl: 'https://github.com/example',
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [
      {
        sourceKey: 'S1',
        url: 'https://github.com/example',
        title: 'example · 公开主页',
        kind: 'profile',
        publishedAt: null,
        retrievedAt: '2024-01-01T00:00:00.000Z',
        fetchStatus: 'ok',
        excerpt: '公开简介',
        excerptLocator: '公开简介',
        identityLabel: '种子账号',
        identityConfirmed: true,
        limits: [],
        excluded: false,
        excludedAt: null
      }
    ],
    observations: [],
    answer: [
      {
        id: 'identity',
        heading: '这个人是谁',
        body: '公开资料。',
        bullets: [
          {
            text: '<img src=x onerror="window.__xss=1">',
            sourceKeys: ['S1'],
            kind: 'factual',
            validity: 'valid',
            reviewReason: null
          }
        ]
      }
    ],
    limitations: [],
    usage: { provider: 'github', requests: 1, bytes: 10, elapsedMs: 1, measurement: 'observed' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

test('report rendering treats upstream text as text, never as markup', () => {
  const container = domContainer();
  renderReport(container, viewWith(), { onCitation: () => undefined });
  assert.equal(container.querySelector('img'), null);
  assert.ok(container.textContent?.includes('<img src=x onerror='));
  assert.equal((jsdomWindow as unknown as { __xss?: number }).__xss, undefined);
  assert.equal(container.querySelectorAll('.report-section').length, 1);
  assert.equal(container.querySelectorAll('.citation').length, 1);
});

test('source detail links are safe and carry noopener', () => {
  const container = domContainer();
  renderSourceDetail(container, viewWith(), 'S1', {
    onSelect: () => undefined,
    onExclude: () => undefined,
    onRestore: () => undefined,
    onUndo: () => undefined
  });
  const anchor = container.querySelector('a');
  assert.ok(anchor);
  assert.equal(anchor.getAttribute('target'), '_blank');
  assert.match(anchor.getAttribute('rel') ?? '', /noopener/);
  assert.equal(anchor.getAttribute('href'), 'https://github.com/example');
});

test('source list filters excluded sources and shows an empty state', () => {
  const container = domContainer();
  const view = viewWith({
    sources: [
      { ...viewWith().sources[0]!, excluded: false },
      { ...viewWith().sources[0]!, sourceKey: 'S2', title: '被排除', excluded: true, fetchStatus: 'excluded', kind: 'third_party' }
    ]
  });
  renderSourceList(container, view, null, 'all', () => undefined);
  assert.equal(container.querySelectorAll('.source-row').length, 1);
  renderSourceList(container, view, null, 'excluded', () => undefined);
  assert.equal(container.querySelectorAll('.source-row').length, 1);
  assert.ok(container.textContent?.includes('被排除'));
});

test('activity rendering derives progress from ordered stage events', () => {
  const events = [
    { seq: 1, type: 'stage', payload: { index: 0, total: 2, key: 'a', label: '第一步', status: 'active' }, createdAt: '' },
    { seq: 2, type: 'stage', payload: { index: 0, total: 2, key: 'a', label: '第一步', status: 'done' }, createdAt: '' },
    { seq: 3, type: 'stage', payload: { index: 1, total: 2, key: 'b', label: '第二步', status: 'active' }, createdAt: '' }
  ];
  const stages = stagesFromEvents(events);
  assert.equal(stages.length, 2);
  assert.equal(stages[0]?.status, 'done');
  assert.equal(stages[1]?.status, 'active');

  const list = domContainer();
  const fill = domContainer();
  const bar = domContainer();
  const text = domContainer();
  const stateEl = domContainer();
  const indicator = domContainer();
  renderActivity(list, fill, bar, text, stateEl, indicator, stages, 'researching');
  assert.equal(text.textContent, '1 / 2');
  assert.equal(fill.style.transform, 'scaleX(0.5)');
  assert.equal(indicator.hidden, false);
});

test('open-ended terminal research shows process records without claiming active or completed stages', () => {
 const list=domContainer(), fill=domContainer(), bar=domContainer(), text=domContainer(), stateEl=domContainer(), indicator=domContainer();
 renderActivity(list,fill,bar,text,stateEl,indicator,[{index:0,total:12,key:'reading',label:'读取原文',status:'active',detail:null}],'partial',true);
 assert.equal(text.textContent,'1 条过程记录');assert.equal(stateEl.textContent,'部分完成');assert.equal(indicator.hidden,true);assert.equal(bar.hidden,true);assert.match(list.textContent!,/过程记录/);assert.doesNotMatch(list.textContent!,/正在查看/);
});

test('open-ended progress identifies one current activity without declaring earlier attempts successful',()=>{
 const list=domContainer(),fill=domContainer(),bar=domContainer(),text=domContainer(),stateEl=domContainer(),indicator=domContainer();
 const stages=[{index:0,total:0,key:'read',label:'读取资料',status:'active' as const,detail:null},{index:1,total:0,key:'verify',label:'核验引文',status:'active' as const,detail:null}];
 renderActivity(list,fill,bar,text,stateEl,indicator,stages,'researching',true);
 assert.equal(list.querySelectorAll('.stage-tag')[0]!.textContent,'过程记录');assert.equal(list.querySelectorAll('.stage-tag')[1]!.textContent,'正在查看');assert.doesNotMatch(list.textContent!,/已完成/);assert.equal(stateEl.textContent,'核验引文');assert.equal(bar.hidden,true);assert.equal(list.querySelectorAll('[data-status="active"]').length,1);
 const chronological=stagesFromEvents([{seq:1,type:'stage',payload:{index:8,key:'read',label:'读取资料',status:'active'},createdAt:''},{seq:2,type:'stage',payload:{key:'repair',label:'修正陈述',status:'active'},createdAt:''}]);renderActivity(list,fill,bar,text,stateEl,indicator,chronological,'researching',true);assert.equal(stateEl.textContent,'修正陈述');assert.equal(list.querySelectorAll('[data-status="active"]').length,1);assert.equal(list.querySelector('[data-status="active"] .stage-label')!.textContent,'修正陈述');
});

// Long lists keep one keyboard entry and expose the full corpus through bounded pages.
test('8005 sources render only one page while End and Home still reach the entire list', () => {
 const container=domContainer();jsdomWindow.document.body.appendChild(container);const base=viewWith();const view=viewWith({sources:Array.from({length:8005},(_,i)=>({...base.sources[0]!,sourceKey:`S${i+1}`,title:`合成来源 ${i+1}`}))});let selected:string|null=null;
 renderSourceList(container,view,null,'all',key=>{selected=key;});
 assert.equal(container.querySelectorAll('button.source-row').length,100);assert.match(container.textContent!,/1–100 \/ 8005/);assert.equal(container.querySelectorAll('button.source-row[tabindex="0"]').length,1);
 let row=container.querySelector<HTMLButtonElement>('button.source-row')!;row.focus();row.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));
 assert.equal(container.querySelectorAll('button.source-row').length,5);assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S8005');assert.match(container.textContent!,/8001–8005 \/ 8005/);(jsdomWindow.document.activeElement as HTMLButtonElement).click();assert.equal(selected,'S8005');
 jsdomWindow.document.activeElement!.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S1');assert.equal(view.sources.length,8005);container.remove();
});

test('source paging preserves navigation focus, crosses page boundaries and locates a selected distant citation',()=>{
 const container=domContainer();jsdomWindow.document.body.appendChild(container);const base=viewWith();const view=viewWith({sources:Array.from({length:1005},(_,i)=>({...base.sources[0]!,sourceKey:`S${i+1}`}))});const select=()=>undefined;
 renderSourceList(container,view,null,'all',select);container.querySelector<HTMLButtonElement>('[data-source-page="next"]')!.click();assert.match(container.textContent!,/101–200 \/ 1005/);
 const first=container.querySelector<HTMLButtonElement>('button.source-row')!;first.focus();first.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S100');
 jsdomWindow.document.activeElement!.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S101');
 renderSourceList(container,view,'S999','all',select);assert.match(container.textContent!,/901–1000 \/ 1005/);assert.equal(container.querySelector('[aria-selected="true"]')?.getAttribute('data-source-key'),'S999');
 container.querySelector<HTMLButtonElement>('[data-source-page="previous"]')!.click();renderSourceList(container,{...view,sources:[...view.sources,{...base.sources[0]!,sourceKey:'S1006'}]},'S999','all',select);assert.match(container.textContent!,/801–900 \/ 1006/);
 renderSourceList(container,view,'S999','all',select,{revealSelected:true});assert.match(container.textContent!,/901–1000 \/ 1005/);const selected=container.querySelector<HTMLButtonElement>('[data-source-key="S999"]')!;selected.focus();renderSourceList(container,view,'S999','all',select);assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S999');container.remove();
});

test('source filter and run changes reset paging without hiding remaining sources',()=>{
 const container=domContainer();const base=viewWith();const view=viewWith({sources:Array.from({length:250},(_,i)=>({...base.sources[0]!,sourceKey:`S${i+1}`,kind:i<120?'profile' as const:'work' as const}))});const select=()=>undefined;
 renderSourceList(container,view,'S230','all',select);assert.match(container.textContent!,/201–250 \/ 250/);renderSourceList(container,view,'S230','profile',select);assert.match(container.textContent!,/1–100 \/ 120/);container.querySelector<HTMLButtonElement>('[data-source-page="next"]')!.click();assert.equal(container.querySelectorAll('.source-row').length,20);
 renderSourceList(container,{...view,runId:'other-run'},null,'all',select);assert.match(container.textContent!,/1–100 \/ 250/);assert.equal(container.dataset.runId,'other-run');renderSourceList(container,null,null,'all',select);assert.equal(container.querySelectorAll('.source-row').length,0);assert.equal(container.querySelector('[data-source-page]'),null);
});

test('return refuses a replaced sentence or a different source at the same report slot', async () => {
  const { createCitationReturn } = await import('../client/citation-return.js');
  for (const replacement of ['sentence', 'source']) {
    const report = domContainer();
    const scroller = domContainer();
    jsdomWindow.document.body.append(report, scroller);
    const original = viewWith();
    original.answer[0]!.bullets[0]!.text = '第一行 "原话"\\出处\n第二行';
    renderReport(report, original, { onCitation: () => undefined });
    const button = report.querySelector<HTMLElement>('button.citation')!;
    const controller = createCitationReturn({ doc: jsdomWindow.document, win: jsdomWindow,
      report: () => report, scroller: () => scroller, runId: () => original.runId, reducedMotion: () => true });
    controller.enterViaCitation('S1', button.dataset.citationAnchor!, button);
    renderReport(report, original, { onCitation: () => undefined });
    controller.sync();
    assert.equal(controller.returnToCitation(), true, 'quoted multiline context survives a same-content rerender');
    if (replacement === 'sentence') original.answer[0]!.bullets[0]!.text = '完全不同的结论';
    else original.answer[0]!.bullets[0]!.sourceKeys = ['S2'];
    renderReport(report, original, { onCitation: () => undefined });
    controller.sync();
    assert.equal(controller.entry(), null, `${replacement} replacement invalidates the old target`);
    assert.equal(controller.returnToCitation(), false);
    report.remove(); scroller.remove();
  }
});


test('a terminal empty report explains the gap and opens retained actual sources without creating conclusions', () => {
  const container = domContainer();
  const calls: string[] = [];
  const view = viewWith({ state: 'partial', answer: [], observations: [], limitations: ['公开材料未完成核对。'] });
  const original = JSON.stringify(view);
  renderReport(container, view, { onCitation: key => calls.push(key) });
  assert.match(container.textContent ?? '', /还没有可核对的结论/);
  assert.match(container.textContent ?? '', /已保留 1 个来源/);
  assert.match(container.textContent ?? '', /公开材料未完成核对/);
  container.querySelector<HTMLButtonElement>('.report-incomplete .citation')!.click();
  assert.deepEqual(calls, ['S1']);
  assert.equal(JSON.stringify(view), original);
  assert.equal(container.querySelectorAll('.report-copy').length, 0);
  renderReport(container, viewWith({ state: 'researching', answer: [] }), { onCitation: () => undefined });
  assert.equal(container.querySelector('.report-incomplete'), null);
});

test('source inspector presents readable inert HTML and retains the immutable original',()=>{
 const container=domContainer();const raw='<style>body{color:red}</style><script>window.bad=1</script><nav>Unrelated navigation</nav><p>Actual author: R&amp;D &#39;work&#39;.</p><img src="https://fixture-reader.org/pixel" onerror="window.bad=1">';
 const source={...viewWith({}).sources[0]!,excerpt:raw,identityConfirmed:false,identityLabel:'已选人物账号范围；归属依据见第一步'};const original=JSON.stringify(source);
 renderSourceDetail(container,viewWith({sources:[source]}),source.sourceKey,{onSelect:()=>undefined,onExclude:()=>undefined,onRestore:()=>undefined,onUndo:()=>undefined});
 assert.equal(container.querySelector('.source-quote p')?.textContent,"Actual author: R&D 'work'.");
 assert.equal(container.querySelector('.source-original pre')?.textContent,raw);assert.equal(container.querySelectorAll('script,img,style').length,0);
 assert.match(container.textContent??'',/已选人物账号范围/);assert.equal(JSON.stringify(source),original);
});

test('small source lists keep roving keys and restore selected row focus without paging controls',()=>{
 const container=domContainer();jsdomWindow.document.body.appendChild(container);const base=viewWith();const view=viewWith({sources:Array.from({length:3},(_,i)=>({...base.sources[0]!,sourceKey:`S${i+1}`}))});let selected:string|null='S2';
 const onSelect=(key:string)=>{selected=key;renderSourceList(container,view,selected,'all',onSelect);};renderSourceList(container,view,selected,'all',onSelect);assert.equal(container.querySelector('[data-source-page]'),null);
 const row=container.querySelector<HTMLButtonElement>('[data-source-key="S2"]')!;row.focus();row.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S3');(jsdomWindow.document.activeElement as HTMLButtonElement).click();assert.equal(selected,'S3');assert.equal((jsdomWindow.document.activeElement as HTMLElement).dataset.sourceKey,'S3');assert.equal(container.querySelectorAll('button.source-row[tabindex="0"]').length,1);container.remove();
});

test('source rows and details carry quiet platform/domain/status context with no third-party loads',()=>{
 const list=domContainer();const detail=domContainer();jsdomWindow.document.body.append(list,detail);const base=viewWith();
 const view=viewWith({sources:[
  {...base.sources[0]!,url:'https://www.youtube.com/watch?v=abc',kind:'third_party'},
  {...base.sources[0]!,sourceKey:'S2',url:'javascript:alert(1)',fetchStatus:'inaccessible',excerpt:null}
 ]});
 renderSourceList(list,view,null,'all',()=>undefined);
 assert.ok(list.textContent?.includes('YouTube · www.youtube.com · 第三方'));
 assert.ok(list.textContent?.includes('YouTube 1 条'));
 assert.ok(list.textContent?.includes('不代表被搜索过'));
 assert.ok(list.textContent?.includes('已读取'));
 assert.ok(list.textContent?.includes('未能读取'));
 assert.ok(list.textContent?.includes('来源平台覆盖（按本次实际来源）'));
 assert.ok(list.textContent?.includes('共 2 条来源，1 条已取得材料'));
 assert.equal(list.querySelectorAll('img,iframe,script,link,object,embed,video,audio').length,0);
 renderSourceDetail(detail,view,'S1',{onSelect:()=>undefined,onExclude:()=>undefined,onRestore:()=>undefined,onUndo:()=>undefined});
 const anchor=detail.querySelector('a');assert.equal(anchor?.getAttribute('href'),'https://www.youtube.com/watch?v=abc');assert.match(anchor?.getAttribute('rel')??'',/noopener/);
 const okText=detail.textContent??'';assert.ok(okText.includes('视频页面'));assert.ok(okText.includes('不代表已观看'));assert.ok(okText.includes('。已取得材料，'));assert.ok(okText.includes('不代表该来源或该平台的全部历史已读完'));
 renderSourceDetail(detail,view,'S2',{onSelect:()=>undefined,onExclude:()=>undefined,onRestore:()=>undefined,onUndo:()=>undefined});
 assert.equal(detail.querySelectorAll('a').length,0);
 const blocked=detail.textContent??'';assert.ok(blocked.includes('javascript:alert(1)'));assert.ok(blocked.includes('不生成可点击链接'));assert.ok(blocked.includes('未确认已取得材料'));assert.ok(!blocked.includes('。已取得材料，'));
 list.remove();detail.remove();
});

test('unknown historical source fields render without claiming platform, material or completeness',()=>{
 const container=domContainer();const base=viewWith();
 const weird={...base.sources[0]!,url:'https://fakegithub.com/x',kind:'mystery',fetchStatus:'weird',publishedAt:null} as unknown as typeof base.sources[number];
 renderSourceDetail(container,viewWith({sources:[weird]}),'S1',{onSelect:()=>undefined,onExclude:()=>undefined,onRestore:()=>undefined,onUndo:()=>undefined});
 const text=container.textContent??'';
 assert.ok(text.includes('类型未知'));assert.ok(text.includes('状态未知'));assert.ok(text.includes('fakegithub.com'));assert.ok(text.includes('未匹配已知平台，按网站展示'));
 assert.ok(!text.includes('GitHub（按链接主机推断）'));assert.ok(!text.includes('。已取得材料，'));assert.ok(!text.includes('全部历史已读完'));
});
