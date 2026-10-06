import test from 'node:test';
import assert from 'node:assert/strict';
import {seedFirstStep} from './first-step-fixtures.js';
import {runResearch} from '../server/research/controller.js';
import {claimLiteralTermIssue,claimAuthorialIssue} from '../shared/research-depth.js';
import {renderJson,renderMarkdown} from '../shared/canonical.js';
import {renderReportHtml} from '../shared/report-html.js';
import type {ResearchCheckpoint} from '../server/research/research-store.js';

test('only a leading citation to this exact bound source is excluded from named fact terms',()=>{
  const claim={sourceKey:'S13',quote:'I wrote a parser.',quoteLexicalPolicy:'literal_terms/v1' as const};
  for(const statement of ['S13 帖中，本人称编写了解析器。','[S13]：该帖介绍解析器。',' S13帖中介绍解析器。'])assert.equal(claimLiteralTermIssue({...claim,statement}),null);
  for(const statement of ['S12 帖中，本人称编写了解析器。','S13Company介绍解析器。','该帖S13介绍解析器。','S13 帖中介绍Nimbus解析器。'])assert.ok(claimLiteralTermIssue({...claim,statement}));
  assert.ok(claimLiteralTermIssue({quote:claim.quote,statement:'S13 帖中介绍解析器。',quoteLexicalPolicy:'literal_terms/v1'}),'no source binding cannot exempt an ID');
  assert.ok(claimAuthorialIssue({quote:'I built this ~week ago.',statement:'本人称在一周前构建。',authorialBasis:'quote_first_person'}));
  assert.equal(claimAuthorialIssue({quote:'I built this ~week ago.',statement:'本人称在约一周前构建。',authorialBasis:'quote_first_person'}),null);
  assert.ok(claimAuthorialIssue({quote:'Sometimes I am jokingly referred to as the reference human.',statement:'主页自述常被开玩笑称为参考人类。',authorialBasis:'quote_first_person'}));
  assert.equal(claimAuthorialIssue({quote:'Sometimes I am jokingly referred to as the reference human.',statement:'主页自述有时被开玩笑称为参考人类。',authorialBasis:'quote_first_person'}),null);
  assert.equal(claimAuthorialIssue({quote:'Sometimes I am jokingly referred to as the reference human.',statement:'主页自述常被开玩笑称为参考人类。'}),null,'legacy without attribution policy unchanged');
  const migration='I have three blogs. I then briefly and sadly switched to my second blog on Medium. I now have a Bear blog.';
  assert.ok(claimAuthorialIssue({quote:migration,statement:'主页自述共经营三个博客。',authorialBasis:'quote_first_person'}));
  assert.equal(claimAuthorialIssue({quote:migration,statement:'主页自述先后有三个博客，目前使用 Bear。',authorialBasis:'quote_first_person'}),null);
});

test('real controller preserves independent excerpts outside claims; canonical renderers enforce quote, source and current scope dependencies',async()=>{
  const url='https://independent-fixture.dev/',original='<p>I wrote a parser.</p>',quote='I wrote a parser.';
  const f=seedFirstStep({accounts:[{url}]});
  try{
    const discovered=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;assert.equal(discovered.mode,'first_step');if(discovered.mode!=='first_step')throw Error('wrong mode');
    f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,{expectedRunRevision:f.store.getRun(f.run.id)!.revision,expectedScopeVersion:discovered.view.selection.scopeVersion,discoveryRevision:discovered.view.discoveryRevision,clusterId:discovered.view.clusters[0]!.clusterId,accounts:[{accountId:f.accountIdFor(0),selection:'only_this_account',excluded:false}]},'independent-materials');
    const binding=f.firstStep.selectionBinding(f.run.id)!;
    const cp:ResearchCheckpoint={phase:'planning',steps:0,startedAt:Date.now(),elapsedMs:0,anchorUrl:url,identity:{displayName:'Synthetic account',handle:null,profileUrl:url,status:'resolved',note:null,candidates:[]},candidates:[],pages:[],claims:[],unknowns:[],stopReason:null,firstStep:binding};
    f.store.research.save(f.run.id,cp);
    const result=await runResearch({store:f.store,run:f.store.getRun(f.run.id)!,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set([discovered.view.accounts[0]!.accountKey]),independentAccountKeys:new Set([discovered.view.accounts[0]!.accountKey]),accountKeyOf:()=>discovered.view.accounts[0]!.accountKey},tools:{async execute(){return {pages:[{url,title:'Synthetic account',text:original,kind:'profile',retrieval:'read',publishedAt:null,links:[],limitations:[]}],requests:1,bytes:original.length,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[],rejected:[]}:input.checkpoint.pages.length===0?{action:'read',url}:{action:'finish',claims:[{sourceKey:'S1',quote,statement:quote,kind:'page_statement',section:'work'}],unknowns:['A model-proposed question']};}}});
    const saved=f.store.research.checkpoint(f.run.id)!;
    assert.deepEqual(saved.modelGapHistory,[{step:2,text:'A model-proposed question'}]);
    assert.ok(result.limitations.some(text=>text.includes('不代表当前读取状态')&&text.includes('A model-proposed question')));
    assert.equal(saved.claims.length,0);assert.equal(result.observations.length,0);assert.equal(result.answer.length,0);assert.equal(saved.independentMaterials!.length,1);
    assert.ok(result.limitations.every(item=>!item.includes(quote)),'raw excerpt is not a limitation');
    f.store.updateRun(f.run.id,{state:'partial',identity_json:JSON.stringify(result.identity)});
    const current=()=>f.store.buildCanonicalView(f.store.getRun(f.run.id)!);
    const view=current();assert.equal(view.research!.accountMaterials!.length,1);assert.equal(view.personObject?.claims.length??0,0);
    for(const text of [renderJson(view),renderMarkdown(view),renderReportHtml(view)])assert.ok(text.includes(quote));
    for(const text of [renderMarkdown(view),renderReportHtml(view)]){assert.ok(text.includes('未并入人物结论'));assert.ok(text.includes('S1'));}
    const material=saved.independentMaterials![0]!;
    for(const change of [{quoteOffset:material.quoteOffset+1},{sourceContentHash:'0'.repeat(64)},{sourceUrl:'https://other-fixture.dev/'}]){
      f.db.prepare('update research_checkpoints set data_json=? where run_id=?').run(JSON.stringify({...saved,independentMaterials:[{...material,...change}]}),f.run.id);assert.equal(current().research!.accountMaterials!.length,0);
    }
    f.db.prepare('update research_checkpoints set data_json=? where run_id=?').run(JSON.stringify(saved),f.run.id);
    const sourceDraft={key:'S1',url,title:'Synthetic account',kind:'profile' as const,publishedAt:null,excerpt:original,excerptLocator:'公开页面文本',identityLabel:'独立账号',identityConfirmed:false,limits:[],fetchStatus:'ok' as const};
    for(const replacement of [{url:'https://other-fixture.dev/'},{excerpt:'<p>A different body.</p>'},{excerpt:`${original} Changed outside the quote.`}]){
      f.store.replaceSources(f.run.id,[{...sourceDraft,...replacement}]);
      assert.equal(current().research!.accountMaterials!.length,0,'current source URL and full original hash must still bind');
      assert.deepEqual(f.store.research.checkpoint(f.run.id)!.independentMaterials,saved.independentMaterials,'replacement never rewrites historical material');
    }
    f.store.replaceSources(f.run.id,[sourceDraft]);assert.equal(current().research!.accountMaterials!.length,1);
    const history={...saved,unknowns:['X 帖文未读取'],modelGapHistory:[{step:1,text:'X 帖文未读取'}]};
    f.db.prepare('update research_checkpoints set data_json=? where run_id=?').run(JSON.stringify(history),f.run.id);
    const {buildResearchReport}=await import('../server/research/controller.js');
    const historicalReport=buildResearchReport({store:f.store,run:f.store.getRun(f.run.id)!,checkpoint:history,limits:saved.limits!},'limited_evidence','partial');
    assert.ok(historicalReport.limitations.some(text=>text.includes('步骤 1')&&text.includes('不代表当前读取状态')&&text.includes('X 帖文未读取')));
    assert.ok(!historicalReport.limitations.includes('X 帖文未读取'));
    assert.deepEqual(f.store.research.checkpoint(f.run.id)!.unknowns,['X 帖文未读取'],'historical model question is not rewritten');
    f.store.setSourceExcluded(f.run.id,'S1',true);assert.equal(current().research!.accountMaterials!.length,0);assert.equal(f.store.research.checkpoint(f.run.id)!.independentMaterials!.length,1,'historical material stays intact');
  }finally{f.close();}
});
