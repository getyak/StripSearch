'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const D = require('./state.js');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const snap = D.snapshot;
const act = D.transition;
const byId = (items, id) => items.find(item => item.id === id);
test('unread material cannot leak into claims, dates, answers or Markdown', () => {
  let s = D.create(1);
  assert.equal(byId(snap(s).sources, 'S3').validity, 'unread');
  assert.equal(byId(snap(s).claims, 'C3'), undefined);
  assert.equal(snap(s).coverage.history.latest, '2024-11-08');
  s = act(s, { type: 'question', question: '作者回应' });
  assert.match(s.chats[0].answer, /没有足够证据/);
  assert.deepEqual(s.chats[0].refs, []);
  assert.doesNotMatch(D.markdown(snap(s)), /Mira：|linzhou-lab：/);
  assert.doesNotMatch(JSON.stringify(snap(s)), /Mira：|linzhou-lab：|一次有上下文的公开讨论/);
  s = act(s, { type: 'withdraw', id: 'S3' });
  assert.doesNotMatch(JSON.stringify(snap(s)), /Mira：|linzhou-lab：/);
});
test('account selection and explicit read permission stay separate', () => {
  let s = act(D.create(), { type: 'draft' });
  s = act(s, { type: 'select', id: 'x', choice: 'research' });
  assert.ok(s.draft.selected.includes('x'));
  assert.ok(!s.draft.allowed.includes('x'));
  assert.ok(!snap(s).scope.selectedAccounts.includes('x'));
  s = act(s, { type: 'authorize', id: 'x', value: true });
  s = act(s, { type: 'save' });
  assert.ok(s.allowed.includes('x'));
  assert.equal(D.identity(s, 'x').state, '归属未证实');
  assert.ok(!snap(s).claims.some(c => c.account === 'x'));
});
test('discarding scope changes does not expand the committed scope', () => {
  const original = D.create();
  let s = act(original, { type: 'draft' });
  s = act(s, { type: 'select', id: 'gh', choice: 'reject' });
  s = act(s, { type: 'discard' });
  assert.deepEqual(snap(s).scope, snap(original).scope);
  assert.equal(original.draft, null);
});
test('new scope clears old answers and recalculates date coverage per account', () => {
  let s = act(D.create(), { type: 'question', question: '做过什么' });
  s = act(s, { type: 'draft' });
  s = act(s, { type: 'select', id: 'gh', choice: 'defer' });
  s = act(s, { type: 'save' });
  assert.equal(s.scopeVersion, 2);
  assert.equal(s.chats.length, 0);
  assert.deepEqual(snap(s).claims.map(c => c.id), ['C1']);
  assert.equal(snap(s).coverage.body.read, 1);
  assert.equal(snap(s).coverage.history.latest, '2024-09-12');
  assert.equal(snap(s).coverage.comments.read, 0);
  assert.doesNotMatch(snap(s).coverage.comments.parentChain, /父链已读/);
  assert.equal(snap(s).coverage.questions[1][1], '待取证');
});
test('a GitHub-only scope cannot carry website-derived analysis into a new report', () => {
  let s = act(D.create(), { type: 'draft' });
  s = act(s, { type: 'select', id: 'web', choice: 'defer' });
  s = act(s, { type: 'save' });
  assert.deepEqual(snap(s).claims.map(c => c.id), ['C2']);
  assert.equal(snap(s).coverage.history.earliest, '2024-11-08');
  assert.ok(snap(s).claims.every(c => c.refs.every(id => snap(s).sources.some(source => source.id === id))));
  assert.equal(snap(s).updatedAt, s.updatedAt);
  assert.match(D.markdown(snap(s)), new RegExp(s.updatedAt.replace(/[.]/g, '\\.')));
});
test('revocation updates dependencies but retains independent identity support', () => {
  let s = act(D.create(), { type: 'question', question: '做过什么' });
  s = act(s, { type: 'withdraw', id: 'S2' });
  const p = snap(s);
  assert.equal(byId(p.claims, 'C2').validity, 'review');
  assert.equal(byId(p.claims, 'C4').validity, 'review');
  assert.equal(byId(p.claims, 'C3').validity, 'valid');
  assert.deepEqual(D.identity(s, 'gh').validSupport, ['S1']);
  assert.equal(p.chats[0].stale, true);
  assert.match(D.markdown(p), /待复核/);
  assert.match(D.markdown(p), /原回答依赖已变化/);
  s = act(s, { type: 'question', question: '个人贡献' });
  assert.deepEqual(s.chats.at(-1).refs, []);
  s = act(s, { type: 'restore', id: 'S2' });
  assert.equal(byId(snap(s).claims, 'C2').validity, 'valid');
  assert.equal(snap(s).revision, 3);
});
test('loss of both identity links invalidates attribution without deleting the source', () => {
  let s = act(D.create(), { type: 'question', question: '作者回应' });
  s = act(s, { type: 'withdraw', id: 'S1' });
  assert.equal(snap(s).chats[0].stale, false);
  s = act(s, { type: 'withdraw', id: 'S2' });
  assert.equal(byId(snap(s).sources, 'S3').validity, 'valid');
  assert.equal(byId(snap(s).claims, 'C3').validity, 'review');
  assert.equal(D.identity(s, 'gh').state, '归属未证实');
  assert.equal(snap(s).chats[0].stale, true);
  assert.equal(snap(s).coverage.questions[3][1], '归属待复核');
  assert.match(D.markdown(snap(s)), /原回答依赖已变化/);
  s = act(s, { type: 'question', question: '作者回应' });
  assert.deepEqual(s.chats.at(-1).refs, []);
});
test('pause and stop freeze batches; resume keeps prior receipts', () => {
  let s = act(D.create(1), { type: 'continue' });
  s = act(s, { type: 'pause' });
  assert.equal(act(s, { type: 'batch' }).batch, 1);
  s = act(s, { type: 'continue' });
  s = act(s, { type: 'stop' });
  assert.equal(act(s, { type: 'batch' }).batch, 1);
  s = act(s, { type: 'continue' });
  s = act(s, { type: 'batch' });
  assert.equal(snap(s).coverage.body.read, 3);
  assert.equal(byId(snap(s).claims, 'C3').validity, 'valid');
  assert.equal(snap(s).completion, 'partial');
  assert.equal(snap(s).coverage.history.exhaustive, false);
});
test('empty authorized scope yields no material or invented coverage', () => {
  let s = act(D.create(), { type: 'draft' });
  for (const id of ['web', 'gh']) s = act(s, { type: 'select', id, choice: 'defer' });
  s = act(s, { type: 'save' });
  assert.equal(snap(s).claims.length, 0);
  assert.equal(snap(s).sources.length, 0);
  assert.equal(snap(s).coverage.history.earliest, null);
  assert.equal(act(s, { type: 'continue' }).phase, 'partial');
});
test('full history, media and contribution remain unknown; no free-form fabrication', () => {
  const s = D.create();
  assert.equal(snap(s).coverage.media.state, 'unsupported');
  assert.equal(snap(s).coverage.body.unknownHistoryTotal, true);
  assert.equal(act(s, { type: 'question', question: '编造一个故事' }).chats.length, 0);
  const a = act(s, { type: 'question', question: '个人贡献' });
  assert.match(a.chats[0].answer, /不能确认个人贡献/);
  const b = act(s, { type: 'question', question: '观点变化' });
  assert.match(b.chats[0].answer, /无法判断/);
});
// jsdom validates rendered interactions only. Native dialog, layout and downloads
// require the separately recorded browser checks; no resource loader is enabled.
const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost/' });
const w = dom.window, doc = w.document;
const errors = [];
w.addEventListener('error', e => errors.push(e.error));
w.fetch = () => { throw Error('External requests are forbidden in this test'); };
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('button')?.focus(); };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.eval(fs.readFileSync(path.join(__dirname, 'state.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'));
const click = selector => { const el = doc.querySelector(selector); assert.ok(el, selector); el.click(); };
const view = value => click(`[data-view="${value}"]`);
const setValue = (selector, value, type = 'input') => { const el = doc.querySelector(selector); el.value = value; el.dispatchEvent(new w.Event(type, { bubbles: true })); };
test('chat draft survives source inspection and returning to conversation', () => {
  setValue('#chat-input', '待核对贡献');
  click('#document [data-action="source"][data-id="S2"]');
  click('[data-action="context-back"]');
  assert.equal(doc.querySelector('#chat-input').value, '待核对贡献');
});
test('all report views and export reflect the same withdrawn source', () => {
  click('[data-question="做过什么"]');
  click('#document [data-action="source"][data-id="S2"]');
  click('[data-action="withdraw-confirm"]');
  assert.match(doc.querySelector('#dialog-content').textContent, /项目文档|可能关注/);
  click('[data-action="withdraw"]');
  assert.equal(doc.querySelector('#document [data-claim="C2"] .review').textContent.includes('S2'), true);
  view('works');
  assert.match(doc.querySelector('#document').textContent, /待复核/);
  view('timeline');
  assert.match(doc.querySelector('#document').textContent, /待复核/);
  click('[data-action="export"]');
  assert.match(doc.querySelector('.export-preview').textContent, /S2.*revoked/);
  assert.match(doc.querySelector('.export-preview').textContent, /原回答依赖已变化/);
  click('[data-action="close-dialog"]');
});
test('saved scope removes old chat and refreshes coverage; draft is isolated', () => {
  view('coverage');
  click('[data-action="scope"]');
  setValue('#choice-gh', 'defer', 'change');
  click('[data-action="save-scope"]');
  assert.match(doc.querySelector('#document').textContent, /2024-09-12 至 2024-09-12/);
  assert.equal(doc.querySelectorAll('.chat-turn').length, 0);
  assert.equal(doc.querySelector('#chat-input').value, '');
  view('summary');
  assert.equal(doc.querySelector('[data-claim="C2"]'), null);
});
test('new research does not fabricate results for a real user input', () => {
  click('[data-action="new"]');
  setValue('#new-input', '<script>alert(1)</script>');
  doc.querySelector('#new-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(doc.querySelector('#new-error').textContent, /未外发/);
  assert.equal(doc.querySelector('#action-dialog').open, true);
  setValue('#new-input', '林舟');
  doc.querySelector('#new-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector('#action-dialog').open, false);
  assert.match(doc.querySelector('#document').textContent, /账号是候选/);
  view('summary');
  assert.equal(doc.querySelector('[data-claim="C3"]'), null);
  view('interaction');
  assert.doesNotMatch(doc.querySelector('#document').textContent, /Mira|linzhou-lab|作者的承诺/);
  view('summary');
});
test('mobile modal moves one actual panel and restores the recreated citation focus', () => {
  w.innerWidth = 375;
  click('#document [data-action="source"][data-id="S1"]');
  assert.equal(doc.querySelector('#mobile-panel').open, true);
  assert.ok(doc.querySelector('#mobile-content #context'));
  assert.equal(doc.querySelectorAll('#context').length, 1);
  click('[data-action="close-mobile"]');
  assert.ok(doc.querySelector('.workspace > #context'));
  assert.equal(doc.activeElement.dataset.id, 'S1');
  click('[data-action="mobile-context"]');
  click('[data-action="context-back"]');
  assert.equal(doc.querySelectorAll('#chat-input').length, 1);
  click('[data-action="close-mobile"]');
});
test('a follow-up initiated in mobile reading opens the answer panel', () => {
  view('works');
  click('[data-action="question"][data-question="个人贡献"]');
  assert.equal(doc.querySelector('#mobile-panel').open, true);
  assert.match(doc.querySelector('#mobile-content').textContent, /不能确认个人贡献/);
  assert.equal(doc.querySelectorAll('#chat-input').length, 1);
  click('[data-action="close-mobile"]');
});
test('controls that change after a batch transition have a stable focus fallback', () => {
  view('progress');
  doc.querySelector('[data-action="continue"]').focus();
  click('[data-action="continue"]');
  assert.equal(doc.activeElement.id, 'document');
  doc.querySelector('[data-action="pause"]').focus();
  click('[data-action="pause"]');
  assert.equal(doc.activeElement.id, 'document');
});
test('keyboard submission retains focus on the stable chat submit button', () => {
  click('[data-action="mobile-context"]');
  setValue('#chat-input', '个人贡献');
  doc.querySelector('#chat-send').focus();
  doc.querySelector('#chat-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement.id, 'chat-send');
  assert.equal(doc.querySelector('#chat-input').value, '');
  click('[data-action="close-mobile"]');
});
test('all local icons resolve and no remote resource is included', () => {
  for (const el of doc.querySelectorAll('[src],link[href]')) {
    const target = el.getAttribute('src') || el.getAttribute('href');
    if (target.startsWith('data:')) continue;
    assert.doesNotMatch(target, /https?:|example\.org/);
    assert.ok(fs.existsSync(path.join(__dirname, target.split('?')[0])), target);
  }
  assert.deepEqual(errors, []);
});
dom.window.close();
console.log(`${passed} offline checks passed; browser-only checks are not implied.`);
