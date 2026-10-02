/* Original synthetic data. A UI experiment, never a production domain/API. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const sources = [
    { id: 'S1', account: 'web', title: '个人网站 · About', date: '2024-09-12', kind: '本人自述', locator: 'About 第 2 段', quote: '我是林舟，正在设计 Lantern。我的代码账号是 linzhou-lab。', supports: '页面自述参与 Lantern，明确链接到代码账号。', limit: '不独立证明履历、实际贡献或产品效果。', available: true },
    { id: 'S2', account: 'gh', title: 'Lantern · README', date: '2024-11-08', kind: '来源页面表述', locator: 'README / Interface 第 3 段', quote: '界面包含事实、推断、未知三个区域，引用紧邻对应结论。维护者 linzhou-lab 的主页指向林舟个人网站。', supports: '项目文档描述界面结构；回链增加归属依据。', limit: '项目归属不证明个人贡献；界面描述不证明使用效果。', available: true },
    { id: 'S3', account: 'gh', title: 'Lantern · 讨论 #14', date: '2025-02-14', kind: '原文支持的事实', locator: '讨论 #14 第 2–3 条回复', quote: 'Mira：能否保留被撤回的来源状态？linzhou-lab：可以，将在来源面板展示待复核标记。', supports: '一次有上下文的公开讨论，以及作者当时的回应。', limit: '承诺不证明已经交付；一次讨论不证明私交或长期合作。', available: true },
    { id: 'S4', account: 'web', title: '旧版项目日志', date: '2023-08-30', kind: '不可访问', locator: '已下线日志', quote: '正文不可用。', supports: '没有可用正文，不支持任何结论。', limit: '无法补写早期观点，也不能由缺失推断观点未变化。', available: false }
  ];
  const accounts = [
    { id: 'web', platform: '个人网站', handle: '林舟 / Lantern', support: ['S1'], description: '本次研究的公开起始主页', linked: true },
    { id: 'gh', platform: 'GitHub', handle: '@linzhou-lab', support: ['S1', 'S2'], description: '起始主页明确链接；项目主页回链', linked: true },
    { id: 'gh-other', platform: 'GitHub', handle: '@linzhou-studio', support: [], description: '同名，缺少可核查的交叉链接', linked: false },
    { id: 'x', platform: 'X', handle: '@linzhou', support: [], description: '用户名相同，仅是独立候选', linked: false }
  ];
  const directory = [
    { id: 'web', name: '个人网站', status: 'candidates', reason: '公开锚点，已读 About', accounts: ['web'] },
    { id: 'github', name: 'GitHub', status: 'candidates', reason: '明确自链与一个同名候选', accounts: ['gh', 'gh-other'] },
    { id: 'x', name: 'X', status: 'candidates', reason: '用户名命中，归属未证实', accounts: ['x'] },
    { id: 'zhihu', name: '知乎', status: 'inaccessible', reason: '示例路线访问受限，不能记作无账号', accounts: [] },
    { id: 'linkedin', name: 'LinkedIn', status: 'needs_input', reason: '只有公开入口，需补充公开主页', accounts: [] },
    { id: 'red', name: '小红书', status: 'checked_no_match', reason: '本轮示例规则检查无匹配；不代表没有账号', accounts: [] },
    { id: 'douyin', name: '抖音', status: 'unsupported', reason: '演示没有可用读取路线', accounts: [] },
    { id: 'bili', name: 'Bilibili', status: 'deferred', reason: '尚未检查，保留目录义务', accounts: [] }
  ];
  const claims = [
    { id: 'C1', section: 'identity', kind: '本人自述', title: '林舟自述正在设计 Lantern。', text: '这说明他如何介绍自己的公开工作。实际职责、成果与影响仍需作品证据。', refs: ['S1'], account: 'web', date: '2024-09-12' },
    { id: 'C2', section: 'works', kind: '来源页面表述', title: '项目文档把事实、推断与未知分开。', text: 'README 描述三个界面区域及相邻引用。这里能读到设计表达，还不能判断实际交付质量。', refs: ['S2'], account: 'gh', date: '2024-11-08' },
    { id: 'C3', section: 'interaction', kind: '原文支持的事实', title: '他回应过一次关于来源撤回的公开问题。', text: 'Mira 提问，linzhou-lab 回应会展示待复核标记。保留问题和作者回应；不把承诺写成已实现。', refs: ['S3'], account: 'gh', date: '2025-02-14' },
    { id: 'C4', section: 'analysis', kind: '分析推断', title: '他可能关注证据与产品交互的关系。', text: '这是对自述与界面描述的解释。替代解释是项目阶段的文档表达；没有长期实践或效果数据。', refs: ['S1', 'S2'], account: 'gh', date: null }
  ];
  const statusLabels = { candidates: '有候选', inaccessible: '访问受限', needs_input: '需补充', checked_no_match: '本轮无匹配', unsupported: '不支持', deferred: '尚未检查' };
  function create(batch = 2) {
    return { revision: 1, scopeVersion: 1, updatedAt: new Date().toISOString(), selected: ['web', 'gh'], allowed: ['web', 'gh'], choices: {}, revoked: [], phase: 'partial', batch, draft: null, history: [], chats: [] };
  }
  function identity(state, id) {
    const account = accounts.find(a => a.id === id);
    if (!account) return null;
    const valid = account.support.filter(ref => !state.revoked.includes(ref));
    return { ...copy(account), validSupport: valid, state: valid.length ? '有归属依据' : '归属未证实', userSelected: state.selected.includes(id), allowed: state.allowed.includes(id), userChoice: state.choices[id] || null };
  }
  function snapshot(state) {
    const visibleSources = sources.filter(s => state.allowed.includes(s.account)).map(s => {
      const validity = !s.available ? 'inaccessible' : s.id === 'S3' && state.batch < 2 ? 'unread' : state.revoked.includes(s.id) ? 'revoked' : 'valid';
      return { ...copy(s), ...(validity === 'unread' ? { quote: '尚未读取，不提供正文。', supports: '没有阅读回执，不采用结论。' } : {}), validity };
    });
    const items = claims.filter(c => state.allowed.includes(c.account) && c.refs.every(ref => visibleSources.some(s => s.id === ref && s.validity !== 'unread'))).map(c => {
      const invalid = c.refs.filter(ref => !visibleSources.some(s => s.id === ref && s.validity === 'valid'));
      // S3 attribution survives S2 withdrawal while the S1 explicit selflink remains valid.
      const attribution = identity(state, c.account);
      const unlinked = c.account !== 'web' && !attribution.validSupport.length;
      return { ...copy(c), validity: invalid.length || unlinked ? 'review' : 'valid', reason: invalid.length ? `${invalid.join('、')} 已撤回、未读或不在有效范围` : unlinked ? '账号归属依据待复核' : '' };
    });
    return { synthetic: true, schema: 'stripsearch/ux-demo/v1', person: '林舟', updatedAt: state.updatedAt, revision: state.revision, scopeVersion: state.scopeVersion, state: state.phase, completion: 'partial', scope: { selectedAccounts: [...state.selected], authorizedAccounts: [...state.allowed], userChoices: copy(state.choices), time: '2023-08 至 2025-02 · 合成材料', body: '约定范围内分批阅读', comments: '每帖一页首层，关键讨论保留父链', budget: '演示不调用服务；真实总额与批次预算待配置' }, sources: visibleSources, claims: items, accounts: accounts.map(a => identity(state, a.id)), directory: copy(directory), coverage: coverage(state), chats: copy(state.chats).map(c => ({ ...c, stale: c.scopeVersion !== state.scopeVersion || c.refs.some(ref => !visibleSources.some(s => s.id === ref && s.validity === 'valid')) || c.claimIds.some(id => !items.some(item => item.id === id && item.validity === 'valid')) })), history: copy(state.history) };
  }
  function coverage(state) {
    const body = sources.filter(s => state.allowed.includes(s.account) && s.available);
    const read = body.filter(s => s.id !== 'S3' || state.batch >= 2);
    const dates = read.map(s => s.date).sort();
    const has = id => read.some(s => s.id === id) && !state.revoked.includes(id);
    return { directory: { checked: directory.filter(p => p.status !== 'deferred').length, total: directory.length, candidateAccounts: accounts.length }, body: { read: read.length, enumerated: body.length, unknownHistoryTotal: true }, history: { earliest: dates[0] || null, latest: dates.at(-1) || null, exhaustive: false }, comments: { read: read.some(s => s.id === 'S3') ? 1 : 0, required: state.allowed.includes('gh') ? 1 : 0, parentChain: has('S3') ? '示例 #14 父链已读' : state.revoked.includes('S3') ? '示例 #14 已撤回，不能用于回答' : '尚无有效父链回执' }, media: { state: 'unsupported', reason: '示例没有媒体转写或 OCR' }, questions: [
      ['经历', '受阻', state.allowed.includes('web') ? '旧日志正文不可访问，不能补写早期经历。' : '当前范围缺少可读取的经历材料。'],
      ['作品与个人贡献', has('S2') ? '有材料，未闭合' : '待取证', has('S2') ? '项目文档已读；个人贡献记录未取得。' : '当前没有有效项目文档；不能判断个人贡献。'],
      ['公开观点', has('S1') || has('S2') ? '有材料，未闭合' : '待取证', '需要当时表达与持续历史，不能由缺失补写观点。'],
      ['表达与互动', has('S3') ? identity(state, 'gh').validSupport.length ? '有原文支持' : '归属待复核' : '待取证', has('S3') ? identity(state, 'gh').validSupport.length ? '一段公开问题与作者回应，不证明长期关系。' : '讨论正文仍在，但缺少账号归属依据；不能写成人物互动。' : '当前没有有效公开问题与作者回应。'],
      ['变化与修正', '受阻', '时间链不连续，尚不能判断观点变化。'],
      ['反例与认识边界', '保留限制', '没有效果数据；承诺不等于结果。']
    ] };
  }
  function transition(state, action) {
    const next = copy(state);
    next.updatedAt = new Date().toISOString();
    const revision = description => { next.revision++; next.history.push({ revision: next.revision, scopeVersion: next.scopeVersion, description }); };
    switch (action.type) {
      case 'draft': next.draft = { selected: [...next.selected], allowed: [...next.allowed], choices: copy(next.choices) }; break;
      case 'select': {
        if (!next.draft || !accounts.some(a => a.id === action.id)) return next;
        next.draft.selected = next.draft.selected.filter(id => id !== action.id);
        next.draft.allowed = next.draft.allowed.filter(id => id !== action.id);
        next.draft.choices[action.id] = action.choice;
        if (action.choice === 'research') next.draft.selected.push(action.id);
        break;
      }
      case 'authorize': {
        if (!next.draft || !next.draft.selected.includes(action.id)) return next;
        next.draft.allowed = next.draft.allowed.filter(id => id !== action.id);
        if (action.value) next.draft.allowed.push(action.id);
        break;
      }
      case 'save': {
        if (!next.draft) return next;
        next.selected = [...next.draft.selected]; next.allowed = [...next.draft.allowed]; next.choices = copy(next.draft.choices);
        next.draft = null; next.scopeVersion++; next.phase = 'partial'; next.chats = []; next.batch = 1;
        revision('保存新的账号选择与读取范围'); break;
      }
      case 'discard': next.draft = null; break;
      case 'withdraw': case 'restore': {
        if (!sources.some(s => s.id === action.id && s.available)) return next;
        if (action.type === 'withdraw' && !next.revoked.includes(action.id)) next.revoked.push(action.id);
        if (action.type === 'restore') next.revoked = next.revoked.filter(id => id !== action.id);
        revision(`${action.type === 'withdraw' ? '撤回' : '恢复'} ${action.id}`); break;
      }
      case 'pause': if (next.phase === 'reading') next.phase = 'paused'; break;
      case 'stop': next.phase = 'stopped'; break;
      case 'continue': if (next.allowed.length) next.phase = 'reading'; break;
      case 'batch': if (next.phase === 'reading') { next.batch = Math.min(next.batch + 1, 2); next.phase = 'partial'; revision('提交下一批示例正文与评论回执；历史仍未穷尽'); } break;
      case 'question': {
        const allowedQuestions = ['做过什么', '个人贡献', '观点变化', '作者回应'];
        if (!allowedQuestions.includes(action.question)) return next;
        const snap = snapshot(next);
        const sections = { '做过什么': ['identity', 'works'], '个人贡献': ['works'], '观点变化': ['analysis'], '作者回应': ['interaction'] };
        const candidates = snap.claims.filter(c => sections[action.question].includes(c.section) && c.validity === 'valid' && (!action.claim || c.id === action.claim));
        let answer = candidates.map(c => `${c.title} ${c.text}`).join('\n');
        if (action.question === '个人贡献') answer = candidates.length ? '现有项目文档不能确认个人贡献。需要提交、作者角色与后续维护记录；不把仓库归属当贡献。' : '';
        if (action.question === '观点变化') answer = '目前没有连续历史和早期原文，无法判断观点怎样变化。';
        if (!answer) answer = '当前有效范围内没有足够证据回答；可以检查缺口或制定增量取证计划。';
        next.chats.push({ question: action.question, answer, refs: [...new Set(candidates.flatMap(c => c.refs))], claimIds: candidates.map(c => c.id), scopeVersion: next.scopeVersion, revision: next.revision }); break;
      }
      case 'new': return create(1);
    }
    return next;
  }
  function markdown(snap) {
    const lines = ['# 林舟 · 合成研究', '', `修订 ${snap.revision} · 范围 ${snap.scopeVersion} · 部分完成`, `合成状态截至 ${snap.updatedAt}`, '合成设计演示；没有真实检索、模型回答或质量评估。', '', '## 研究范围', `允许账号：${snap.scope.authorizedAccounts.join('、') || '无'}`, snap.scope.time, snap.scope.budget, '', '## 发现与判断'];
    for (const c of snap.claims) lines.push(`- ${c.validity === 'review' ? `[待复核：${c.reason}] ` : ''}${c.kind}：${c.title} ${c.text} ${c.refs.map(id => `[${id}]`).join(' ')}`);
    lines.push('', '## 证据');
    for (const s of snap.sources) lines.push(`- ${s.id} · ${s.title} · ${s.date} · ${s.validity} · ${s.locator}`, `  ${s.validity === 'unread' ? '尚未读取，不提供正文或采用结论。' : s.quote}`, `  限制：${s.limit}`);
    lines.push('', '## 覆盖与未完成', `目录 ${snap.coverage.directory.checked}/${snap.coverage.directory.total}（演示目录，非生产目录）`, `已读正文 ${snap.coverage.body.read}；历史总量未知`, `首层评论 ${snap.coverage.comments.read}/${snap.coverage.comments.required}；${snap.coverage.comments.parentChain}`, `媒体：${snap.coverage.media.reason}`);
    snap.coverage.questions.forEach(q => lines.push(`- ${q[0]}：${q[1]}；${q[2]}`));
    lines.push('', '## 追问');
    snap.chats.forEach(c => lines.push(`- ${c.question}：${c.stale ? '原回答依赖已变化，请重新核查。' : c.answer} ${c.refs.map(id => `[${id}]`).join(' ')}`));
    return lines.join('\n');
  }
  const api = { create, transition, snapshot, identity, coverage, markdown, sources, accounts, directory, statusLabels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ResearchDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
