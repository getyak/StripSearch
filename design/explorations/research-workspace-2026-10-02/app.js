/* Presentations share one synthetic snapshot. All actions stay in this page. */
(() => {
  'use strict';
  const D = window.ResearchDemo;
  let state = D.create();
  let view = 'summary', filter = 'all', context = { type: 'chat' }, contextBack = null, selectedClaim = null, mobileFocus = null, actionFocus = null, chatDraft = '';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const titles = { summary: '研究摘要', discovery: '账号发现', progress: '研究进展', coverage: '覆盖与范围', works: '作品与贡献', timeline: '公开时间线', interaction: '公开互动', scope: '复核研究范围' };
  const phaseLabels = { partial: '部分完成', reading: '演示批次待推进', paused: '已暂停', stopped: '已停止' };
  const button = (label, action, extra = '', cls = '') => `<button class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
  const citation = id => button(`${id} · ${esc(D.sources.find(s => s.id === id)?.title || id)}`, 'source', `data-id="${id}"`, 'cite');
  let noticeTimer;
  function notify(message) { clearTimeout(noticeTimer); $('#notice').textContent = message; noticeTimer = setTimeout(() => { $('#notice').textContent = ''; }, 6000); }
  function dispatch(action) { state = D.transition(state, action); render(); }
  function claimHTML(c) {
    const reviewed = c.validity === 'review';
    return `<article class="claim" data-claim="${c.id}">${reviewed ? `<div class="review">待复核 · ${esc(c.reason)}</div>` : ''}<div class="kind">${esc(c.kind)}</div><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p><div class="citations">${c.refs.map(citation).join('')}${button('围绕这条追问', 'claim', `data-id="${c.id}"`, 'claim-question')}</div></article>`;
  }
  function railHTML(snap) {
    return `<div class="person"><div class="monogram">林</div><div><strong>林舟</strong><p>Lantern · 公开作品</p></div></div><nav aria-label="研究视图">${Object.keys(titles).filter(k => k !== 'scope').map(k => button(titles[k], 'view', `data-view="${k}" aria-current="${view === k ? 'page' : 'false'}"`)).join('')}</nav><div class="rail-label">已允许阅读</div>${snap.scope.authorizedAccounts.map(id => { const a = D.identity(state, id); return button(`<span>${esc(a.platform)}</span><span>${snap.sources.filter(s => s.account === id && !['unread', 'inaccessible'].includes(s.validity)).length}</span>`, 'account', `data-id="${id}"`, 'platform-nav'); }).join('') || '<p class="muted">尚未授权账号</p>'}<div class="rail-note">范围 v${snap.scopeVersion} · 修订 ${snap.revision}<br>资料不全，保持部分完成。<br>8 项合成目录，未连接检索服务。</div>`;
  }
  function intro(eyebrow, title, text) { return `<div class="intro"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${text ? `<p class="lede">${text}</p>` : ''}</div>`; }
  function summaryHTML(snap) {
    return intro('有出处的人物理解', '从作品与行动，理解林舟。', `当前范围已读 ${snap.coverage.body.read} 条正文；事实、表达和解释分别保留。`) +
      `<div class="status-strip"><div><strong>目前有 ${snap.claims.filter(c => c.validity === 'valid').length} 条可核查发现</strong><p>历史未读到底，个人贡献与长期变化仍有缺口。</p></div>${button('查看阅读缺口', 'coverage')}</div>` +
      `<section><div class="section-heading"><h2>先了解什么</h2>${button('检查账号归属', 'view', 'data-view="discovery"')}</div>${snap.claims.filter(c => c.section !== 'analysis').map(claimHTML).join('') || '<p class="empty">当前范围没有可用于人物结论的材料。可先确认一个公开账号。</p>'}</section>` +
      `<section><div class="section-heading"><h2>可能的解释</h2></div>${snap.claims.filter(c => c.section === 'analysis').map(claimHTML).join('') || '<p class="limit">当前范围不足以作出综合解释。</p>'}</section>` +
      `<section><h2>还不能下的判断</h2><p class="limit">没有长期效果数据，不能由项目归属判断个人贡献。一次公开回应不证明持续合作。旧日志不可访问，不能补写早期观点。</p><div class="citations">${snap.sources.filter(s => s.id === 'S4').map(s => citation(s.id)).join('')}${button('制定增量取证计划', 'plan')}</div></section>`;
  }
  function discoveryHTML(snap) {
    const stats = snap.coverage.directory;
    const rows = snap.directory.filter(p => filter === 'all' || filter === 'candidates' && p.accounts.length || filter === 'gaps' && !['candidates', 'checked_no_match'].includes(p.status));
    return intro('先找对公开账号', '账号是候选，依据决定归属。', '用户选择与读取授权分别保存。相同姓名或用户名不会自动合并。') +
      `<div class="stats"><div><b>${stats.checked} / ${stats.total}</b><small>已处理目录项</small></div><div><b>${stats.candidateAccounts}</b><small>候选账号，含公开锚点</small></div><div><b>${snap.scope.authorizedAccounts.length}</b><small>允许读取账号</small></div></div><p class="limit">目录 demo.1 · 8 项合成目录，非生产全目录。已处理包含受限与不支持结果。</p><div class="filters" role="group" aria-label="目录筛选">${[['all', '全部目录'], ['candidates', '有候选'], ['gaps', '受限与待处理']].map(([id, label]) => button(label, 'filter', `data-filter="${id}" aria-pressed="${filter === id}"`)).join('')}</div>${rows.map(p => `<section class="directory-row"><div><strong>${esc(p.name)}</strong><p>${esc(p.reason)}</p>${p.accounts.map(id => { const a = D.identity(state, id); return button(`<span><strong>${esc(a.handle)}</strong><small>${esc(a.description)}</small></span><em>${esc(a.state)}</em>`, 'account', `data-id="${id}"`, 'account-row'); }).join('')}</div><span>${D.statusLabels[p.status]}</span></section>`).join('') || '<p class="empty">没有符合筛选的目录项。切回全部目录查看。</p>'}<div class="scope-actions">${button('一次复核选择与读取范围', 'scope', '', 'primary')}</div>`;
  }
  function scopeHTML(snap) {
    const draft = state.draft;
    if (!draft) return intro('范围已保存', '这份研究有明确的边界。', '更改会生成新范围版本；旧任务不能发布到新版本。') + button('编辑范围', 'scope', '', 'primary');
    return intro('一次复核 · 尚未保存', '研究谁，读到哪里。', `当前范围 v${snap.scopeVersion} 保持不变；只有保存后才采用下面的选择。`) +
      `<section>${D.accounts.map(a => `<div class="scope-account"><label for="choice-${a.id}"><strong>${esc(a.platform)} · ${esc(a.handle)}</strong><select id="choice-${a.id}" data-choice="${a.id}"><option value="research" ${draft.selected.includes(a.id) ? 'selected' : ''}>研究此公开账号</option><option value="defer" ${!draft.selected.includes(a.id) && draft.choices[a.id] !== 'reject' ? 'selected' : ''}>暂不采用</option><option value="reject" ${draft.choices[a.id] === 'reject' ? 'selected' : ''}>不是此人</option></select></label><p>${esc(D.identity(state, a.id).state)} · ${D.identity(state, a.id).validSupport.length ? '有明确主页指向。' : '你的选择只表达研究意图；独立账号，不并入同一人物。'}</p><label class="authorize"><input type="checkbox" data-authorize="${a.id}" ${draft.allowed.includes(a.id) ? 'checked' : ''} ${draft.selected.includes(a.id) ? '' : 'disabled'}>允许读取公开资料与历史</label></div>`).join('')}</section>` +
      `<section class="coverage-row"><h3>时间与阅读深度</h3><p>2023-08 至 2025-02 · 合成材料。约定范围内分批读正文，每帖一页首层评论，关键讨论保留父链。媒体能力缺失单独报告。</p></section><section class="coverage-row"><h3>预算</h3><p>演示不产生费用。接入真实服务前需冻结总额与每批预算；未确认费用不能当作零费用。</p></section><div class="scope-actions">${button('保存范围并查看进展', 'save-scope', '', 'primary')}${button('放弃未保存修改', 'discard-scope', '', 'secondary')}</div>`;
  }
  function coverageHTML(snap, progress = false) {
    const c = snap.coverage;
    return intro(progress ? '可停止，可保留' : '看到读过什么，也看到没读到什么', progress ? '资料已保留，下一批从这里继续。' : '部分完成，边界清楚。', '目录检查、历史、正文、媒体、评论分别计算。没有历史分母，不显示整体百分比。') +
      `<div class="status-strip"><div><strong>${phaseLabels[state.phase]}</strong><p>示例批次 ${state.batch} · 范围 v${state.scopeVersion} · 修订 ${state.revision}</p></div><div>${state.phase === 'reading' ? button('暂停', 'pause') + button('演示下一批', 'batch', '', 'primary') : button('继续阅读演示', 'continue', state.allowed.length ? '' : 'disabled', 'primary')}${button('停止', 'stop')}</div></div>` +
      `<div class="stats"><div><b>${c.body.read}</b><small>已读正文</small></div><div><b>${c.comments.read} / ${c.comments.required}</b><small>示例首层评论</small></div><div><b>未知</b><small>完整历史总量</small></div></div><section><div class="coverage-row"><h3>历史时间</h3><p>${c.history.earliest ? `已读材料日期：${c.history.earliest} 至 ${c.history.latest}。` : '当前没有已读正文。'}${snap.sources.some(s => s.id === 'S4') ? '2023 年日志不可访问。' : ''}历史未穷尽，不能证明中间时段全部覆盖。</p></div><div class="coverage-row"><h3>正文与评论</h3><p>已枚举 ${c.body.enumerated} 条示例可读正文，已处理 ${c.body.read} 条；${esc(c.comments.parentChain)}。未处理、不可访问与撤回分别保留。</p></div><div class="coverage-row"><h3>媒体与能力缺口</h3><p>${c.media.reason}。正文已读不等于媒体已处理。</p></div><div class="coverage-row"><h3>用量与费用</h3><p>0 次外部请求 · 0 次模型调用。这是本地演示；真实路线的总额、批次与费用须单独配置和验收。</p></div></section><section><h2>研究问题</h2><ul class="questions">${c.questions.map(q => `<li><strong>${q[0]}</strong><span>${q[1]}</span><p>${q[2]}</p></li>`).join('')}</ul></section>${state.history.length ? `<section><h2>修订与检查点</h2>${state.history.map(h => `<p class="history-row">v${h.revision} · 范围 ${h.scopeVersion} · ${esc(h.description)}</p>`).join('')}</section>` : ''}<div class="scope-actions">${button('修改账号与范围', 'scope', '', 'secondary')}${button('为缺口制定取证计划', 'plan')}</div>`;
  }
  function readingHTML(snap) {
    if (view === 'discovery') return discoveryHTML(snap);
    if (view === 'scope') return scopeHTML(snap);
    if (view === 'coverage' || view === 'progress') return coverageHTML(snap, view === 'progress');
    if (view === 'works') return intro('作品不等于个人贡献', 'Lantern 的设计表达。', '先读原作，再核对作者、贡献与后续维护。') + `<section>${snap.claims.filter(c => c.section === 'works').map(claimHTML).join('') || '<p class="empty">项目账号未在有效阅读范围内，没有可采用的作品材料。</p>'}</section><section><h2>下一步需要什么</h2><p class="limit">个人提交、作品作者角色、实际发布与后续维护记录；项目拥有者身份不能替代这些证据。</p>${button('围绕个人贡献继续核查', 'question', 'data-question="个人贡献"')}</section>`;
    if (view === 'timeline') return intro('事件与材料日期分开', '目前能定位的公开记录。', '这里只列材料发表日期；实际事件日期未知时不补写。') + `<section class="timeline">${snap.claims.filter(c => c.date).map(c => `<time>${c.date}</time><article>${claimHTML(c)}</article>`).join('') || '<p class="empty">当前范围没有可定位的事件。</p>'}</section><p class="limit">材料间有时间缺口，不能把前后顺序写成因果。</p>`;
    if (view === 'interaction') {
      const items = snap.claims.filter(c => c.section === 'interaction');
      return intro('保留根帖、问题与作者回应', items.length ? '一次公开讨论，说明到哪里。' : '公开互动还需要取证。', items.some(c => c.validity === 'valid') ? '讨论 #14 · Mira 提问 → linzhou-lab 回应。关系与结果分别核查。' : items.length ? '材料与人物归属存在待复核依赖，不能继续采用原判断。' : '当前范围没有已读互动材料；尚不能描述参与者与回应。') + `<section>${items.map(claimHTML).join('') || '<p class="empty">可在已授权范围内推进下一批，保留问题与作者回应的上下文。</p>'}</section><p class="limit">承诺不等于已交付结果；公开讨论不证明私交、长期合作或立场冲突。</p>`;
    }
    return summaryHTML(snap);
  }
  function contextHTML(snap) {
    if (context.type === 'source') {
      const s = snap.sources.find(s => s.id === context.id);
      if (!s) return `<div class="context-header"><strong>出处</strong>${button('返回对话', 'context-back')}</div><div class="context-content"><p class="empty">这条材料不在当前读取范围内。</p></div>`;
      const states = { valid: '有效材料', revoked: '已撤回', inaccessible: '不可访问', unread: '尚未读取' };
      return `<div class="context-header"><strong>出处与支持边界</strong>${button('返回', 'context-back')}</div><div class="context-content"><div class="source-meta">${s.id} · ${s.kind} · ${states[s.validity]}</div><h2>${esc(s.title)}</h2><p class="source-meta">${s.date} · ${s.locator}<br>原创合成材料，没有远程原文链接。</p>${s.validity === 'unread' ? '<p class="review">这条材料尚未进入本批阅读回执，不能支持报告。</p>' : `<blockquote class="source-quote">${esc(s.quote)}</blockquote>`}<h3>能说明什么</h3><p>${s.validity === 'unread' ? '尚未读取，不采用其正文或结论。' : esc(s.supports)}</p><h3>还不能说明什么</h3><p>${esc(s.limit)}</p><h3>影响哪些内容</h3><p class="limit">${snap.claims.filter(c => c.refs.includes(s.id)).map(c => esc(c.title)).join('；') || '当前没有依赖此来源的结论。'}</p><div class="source-actions">${s.available ? button(s.validity === 'revoked' ? '恢复这条来源' : '撤回这条来源', s.validity === 'revoked' ? 'restore' : 'withdraw-confirm', `data-id="${s.id}"`, 'secondary') : ''}${button('查看覆盖缺口', 'coverage')}</div></div>`;
    }
    if (context.type === 'account') {
      const a = D.identity(state, context.id);
      return `<div class="context-header"><strong>账号依据与范围</strong>${button('返回', 'context-back')}</div><div class="context-content"><div class="eyebrow">${a.platform}</div><h2>${esc(a.handle)}</h2><p><span class="tag">${a.state}</span></p><h3>为什么出现在这里</h3><p>${esc(a.description)}</p><p class="limit">${a.linked ? '明确的自链可支持归属；内容真实性仍逐条核查。' : '存在性与用户名相似只产生候选，不能证明同人。'}</p><div class="citations">${a.validSupport.map(citation).join('') || '<p class="limit">尚无可核查的归属证据。</p>'}</div><h3>你的研究选择</h3><p>${a.userSelected ? '已选择研究' : '暂未选择'} · ${a.allowed ? '允许读取公开历史' : '未授权读取'}</p><p class="limit">用户选择不提升证据支持等级；未证实的账号作为独立对象，不自动合并。</p><div class="source-actions">${button('一次复核选择与范围', 'scope', '', 'primary')}</div></div>`;
    }
    const selected = snap.claims.find(c => c.id === selectedClaim);
    return `<div class="context-header"><strong>对话</strong>${button('清空对话', 'clear-chat')}</div><div class="context-content"><div class="chat-intro"><strong>${selected ? '围绕所选结论' : '就当前材料继续理解'}</strong><p>${selected ? esc(selected.title) : '回答仅来自已允许、已读且有效的材料。缺少依据时会保留未知。'}</p>${selected ? button('返回全部已读材料', 'clear-claim') : ''}</div><div class="presets" role="group" aria-label="演示追问">${['做过什么', '个人贡献', '观点变化', '作者回应'].map(q => button(q, 'question', `data-question="${q}"`)).join('')}</div>${snap.chats.length ? snap.chats.map(c => `<article class="chat-turn"><p class="chat-q">${esc(c.question)}</p>${c.stale ? '<p class="review">原回答的依据已变化，请重新核查。</p>' : `<p class="chat-a">${esc(c.answer)}</p>`}<div class="citations">${c.refs.filter(id => snap.sources.some(s => s.id === id)).map(citation).join('')}</div></article>`).join('') : '<p class="limit">可以先追问个人贡献，看看现有材料能支持到哪一步。</p>'}</div><form class="compose" id="chat-form"><label for="chat-input">当前已读材料 · 预设演示追问</label><textarea id="chat-input" placeholder="例如：个人贡献" maxlength="1000"></textarea><div class="compose-actions">${button('继续取证', 'plan')}<button id="chat-send" type="submit" class="primary">发送</button></div><small>自由提问尚未连接模型，不会生成虚构回答。</small></form>`;
  }
  function focusKey(el) {
    if (!el || el === document.body) return null;
    if (el.id) return '#' + el.id;
    if (!el.dataset.action) return null;
    return ['action', 'id', 'view', 'question', 'filter'].filter(k => el.dataset[k]).map(k => `[data-${k}=${JSON.stringify(el.dataset[k])}]`).join('');
  }
  function restoreFocus(key) {
    if (!key) return;
    const modal = $('#action-dialog').open ? $('#action-dialog') : $('#mobile-panel').open ? $('#mobile-panel') : document;
    const target = modal.querySelector(key) || (modal === document ? $('#document') : modal.querySelector('button'));
    target?.focus({ preventScroll: true });
  }
  function render() {
    const focused = focusKey(document.activeElement);
    const snap = D.snapshot(state);
    $('#project-status').textContent = `${phaseLabels[state.phase]} · v${state.revision}`;
    $('#view-title').textContent = titles[view];
    $('#rail').innerHTML = railHTML(snap);
    $('#document').innerHTML = readingHTML(snap);
    $('#context').innerHTML = contextHTML(snap);
    if ($('#chat-input')) $('#chat-input').value = chatDraft;
    const mobile = $('#mobile-panel');
    if (mobile.open) renderMobile(mobile.dataset.kind);
    restoreFocus(focused);
  }
  function renderMobile(kind) {
    $('#mobile-title').textContent = kind === 'nav' ? '人物导航' : '对话与依据';
    // Move the actual panel into the dialog, retaining one input and one focus context.
    const panel = kind === 'nav' ? $('#rail') : $('#context');
    $('#mobile-content').appendChild(panel);
  }
  function closeMobile() {
    const panel = $('#mobile-content').firstElementChild;
    if (panel) { if (panel.id === 'rail') $('.workspace').insertBefore(panel, $('#reading')); else $('.workspace').appendChild(panel); }
    $('#mobile-panel').close();
    restoreFocus(mobileFocus);
  }
  function openMobile(kind, trigger) {
    if ($('#mobile-panel').open) closeMobile();
    mobileFocus = focusKey(trigger); $('#mobile-panel').dataset.kind = kind; renderMobile(kind); $('#mobile-panel').showModal();
  }
  function openContext(next, trigger) {
    contextBack = { ...context }; context = next; render();
    if (window.innerWidth <= 1050 && !$('#mobile-panel').open) openMobile('context', trigger);
  }
  function navigate(next) {
    if ($('#mobile-panel').open) closeMobile();
    const changed = view !== next; view = next; render(); if (changed) $('#document').scrollTop = 0; $('#document').focus({ preventScroll: true });
  }
  function scope() { if (!state.draft) state = D.transition(state, { type: 'draft' }); navigate('scope'); }
  function dialog(title, html, trigger) {
    actionFocus = focusKey(trigger || document.activeElement);
    $('#dialog-title').textContent = title; $('#dialog-content').innerHTML = html; $('#action-dialog').showModal();
  }
  function closeDialog() { $('#action-dialog').close(); restoreFocus(actionFocus); }
  function exportSnapshot() {
    const snap = D.snapshot(state);
    dialog('导出当前研究', `<p>范围 v${snap.scopeVersion} · 修订 ${snap.revision} · 部分完成。所有格式来自同一快照，包含撤回状态和阅读缺口。</p><pre class="export-preview">${esc(D.markdown(snap))}</pre><div class="scope-actions">${button('下载 Markdown', 'download-md', '', 'primary')}${button('下载 JSON', 'download-json', '', 'secondary')}${button('复制报告', 'copy')}</div><p class="desktop-note">已下载的旧文件不能召回；修订后请使用新导出。</p>`);
  }
  function download(format) {
    const snap = D.snapshot(state);
    const text = format === 'json' ? JSON.stringify(snap, null, 2) : D.markdown(snap);
    const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `linzhou-synthetic-v${snap.revision}.${format === 'json' ? 'json' : 'md'}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); notify('已生成当前范围的合成报告。');
  }
  function question(q, trigger) { state = D.transition(state, { type: 'question', question: q, claim: selectedClaim }); context = { type: 'chat' }; render(); if (trigger && window.innerWidth <= 1050 && !$('#mobile-panel').open) openMobile('context', trigger); }
  document.addEventListener('click', async event => {
    const el = event.target.closest('[data-action]'); if (!el) return;
    const action = el.dataset.action;
    if (action === 'view') navigate(el.dataset.view);
    if (action === 'filter') { filter = el.dataset.filter; render(); }
    if (action === 'account') openContext({ type: 'account', id: el.dataset.id }, el);
    if (action === 'source') openContext({ type: 'source', id: el.dataset.id }, el);
    if (action === 'context-back') { context = contextBack && contextBack.type !== 'source' ? contextBack : { type: 'chat' }; contextBack = null; render(); }
    if (action === 'claim') { selectedClaim = el.dataset.id; context = { type: 'chat' }; render(); if (window.innerWidth <= 1050 && !$('#mobile-panel').open) openMobile('context', el); }
    if (action === 'clear-claim') { selectedClaim = null; render(); }
    if (action === 'question') question(el.dataset.question, el);
    if (action === 'clear-chat') { state.chats = []; selectedClaim = null; render(); }
    if (action === 'scope') scope();
    if (action === 'save-scope') { state = D.transition(state, { type: 'save' }); context = { type: 'chat' }; contextBack = null; selectedClaim = null; chatDraft = ''; navigate('progress'); notify('已保存新范围；旧回答不进入新范围。'); }
    if (action === 'discard-scope') { state = D.transition(state, { type: 'discard' }); navigate('coverage'); }
    if (action === 'coverage') navigate('coverage');
    if (['pause', 'continue', 'stop', 'batch'].includes(action)) { dispatch({ type: action }); notify(action === 'batch' ? '已推进一批固定合成材料；完整历史仍未知。' : phaseLabels[state.phase]); }
    if (action === 'withdraw-confirm') {
      const snap = D.snapshot(state); const dependent = snap.claims.filter(c => c.refs.includes(el.dataset.id));
      dialog('撤回来源的影响', `<p>撤回 ${el.dataset.id} 后，以下依赖内容将标为待复核。仍有独立支持的账号关联与结论会保留。</p><ul>${dependent.map(c => `<li>${esc(c.title)}</li>`).join('')}</ul><p>追问、时间线与全部导出同步更新；引用 ID 不会重新编号。</p>${button('确认撤回', 'withdraw', `data-id="${el.dataset.id}"`, 'primary')}`, el);
    }
    if (action === 'withdraw') { const id = el.dataset.id; closeDialog(); dispatch({ type: 'withdraw', id }); notify(`${id} 已撤回，依赖内容与导出同步待复核。`); }
    if (action === 'restore') { dispatch({ type: 'restore', id: el.dataset.id }); notify('来源已恢复，已生成新的修订。'); }
    if (action === 'new') dialog('从一个公开线索开始', `<p>默认目标是了解这个人。这个版本只运行原创林舟合成样例；你的真实输入不会外发或保存。</p><form id="new-form"><label for="new-input">姓名、用户名或公开主页</label><input type="text" id="new-input" placeholder="林舟（合成示例）" maxlength="500" autocomplete="off"><p id="new-error" class="error" role="alert"></p><button type="submit" class="primary">开始林舟合成研究</button></form>`, el);
    if (action === 'plan') dialog('先核对增量取证计划', `<p>围绕当前认识缺口，下一批优先核对个人贡献、时间缺口与作者后续回应。</p><div class="coverage-row"><h3>允许账号</h3><p>${esc(state.allowed.join('、') || '无，请先选择并授权公开账号')}，不会自动加入同名候选。</p></div><div class="coverage-row"><h3>新范围与预算</h3><p>生成新的范围版本，再推进固定示例批次。没有真实外部请求；实际服务费用与总额上限须在生产接入时确认。</p></div><div class="scope-actions">${button('确认演示计划', 'confirm-plan', state.allowed.length ? '' : 'disabled', 'primary')}${button('返回，不扩大范围', 'close-dialog', '', 'secondary')}</div>`, el);
    if (action === 'confirm-plan') { closeDialog(); state = D.transition(state, { type: 'draft' }); state = D.transition(state, { type: 'save' }); state = D.transition(state, { type: 'continue' }); selectedClaim = null; chatDraft = ''; context = { type: 'chat' }; navigate('progress'); notify('已记录新范围；点击“演示下一批”推进。'); }
    if (action === 'export') exportSnapshot();
    if (action === 'download-md' || action === 'download-json') download(action === 'download-json' ? 'json' : 'markdown');
    if (action === 'copy') { try { await navigator.clipboard.writeText(D.markdown(D.snapshot(state))); notify('已复制当前报告。'); } catch { notify('复制未成功，请下载 Markdown。'); } }
    if (action === 'font') { document.body.classList.toggle('comfortable'); el.setAttribute('aria-pressed', String(document.body.classList.contains('comfortable'))); }
    if (action === 'mobile-nav') openMobile('nav', el);
    if (action === 'mobile-context') openMobile('context', el);
    if (action === 'close-mobile') closeMobile();
    if (action === 'close-dialog') closeDialog();
  });
  document.addEventListener('input', event => { if (event.target.id === 'chat-input') chatDraft = event.target.value; });
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-choice]')) { state = D.transition(state, { type: 'select', id: el.dataset.choice, choice: el.value }); render(); const replacement = document.getElementById(el.id); replacement?.focus(); }
    if (el.matches('[data-authorize]')) { state = D.transition(state, { type: 'authorize', id: el.dataset.authorize, value: el.checked }); render(); $('[data-authorize="' + el.dataset.authorize + '"]')?.focus(); }
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'chat-form') { event.preventDefault(); const q = $('#chat-input').value.trim(); if (['做过什么', '个人贡献', '观点变化', '作者回应'].includes(q)) { chatDraft = ''; $('#chat-input').value = ''; question(q); } else notify('自由提问未连接模型。可使用上方四个演示问题；输入没有外发。'); }
    if (event.target.id === 'new-form') { event.preventDefault(); if ($('#new-input').value.trim() !== '林舟') { $('#new-error').textContent = '请输入“林舟”运行合成样例；真实输入未连接搜索，未外发。'; $('#new-input').focus(); return; } closeDialog(); if ($('#mobile-panel').open) closeMobile(); state = D.transition(state, { type: 'new' }); context = { type: 'chat' }; contextBack = null; selectedClaim = null; chatDraft = ''; filter = 'all'; view = 'discovery'; $('#notice').textContent = ''; render(); $('#document').focus(); }
  });
  $('#mobile-panel').addEventListener('cancel', event => { event.preventDefault(); closeMobile(); });
  $('#action-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  render();
})();
