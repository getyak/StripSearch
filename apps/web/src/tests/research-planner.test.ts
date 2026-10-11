import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessagesUsage } from '../server/research/planner.js';
test('Messages cumulative usage snapshots are counted once',()=>{
 const body='data: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:380,output_tokens:0}}})+'\n\ndata: '+JSON.stringify({type:'message_delta',usage:{input_tokens:380,output_tokens:52}})+'\ndata: '+JSON.stringify({type:'message_stop'})+'\n';
 assert.deepEqual(parseMessagesUsage(body),{inputTokens:380,outputTokens:52,known:true});
});

test('cost estimates use the selected route and unknown models are not silently priced as Flash',async()=>{
 const {estimateModelUsd}=await import('../server/research/planner.js');
 assert.equal(estimateModelUsd('deepseek-flash',1e6,1e6),1.5);
 assert.equal(estimateModelUsd('deepseek-pro',1e6,1e6),5.28);
 assert.equal(estimateModelUsd('unknown-route',10,10),null);
});


test('truncated Messages streams retain unknown usage instead of settling output to zero',()=>{
 const body='data: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:380,output_tokens:0}}})+'\n';
 assert.equal(parseMessagesUsage(body).known,false);
});


test('planning exposes research questions, retrieval provenance and independent batch reading',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:'https://github.com/fixture',identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null};
 const data=JSON.parse(buildResearchPrompt({question:'fixture',checkpoint,remainingModels:5,remainingTools:6}));
 assert.equal(data.researchQuestions.length,5);assert.match(data.contract,/batch/);assert.match(data.contract,/retrieval=search/);assert.match(data.task,/identity JSON.*untrusted/);
});


test('source/link/unknown catalog windows keep the model context bounded without losing corpus',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const pages=Array.from({length:200},(_,i)=>({sourceKey:`S${i}`,url:`https://synthetic-author.dev/${i}`,title:'Synthetic',text:'x'.repeat(50000),kind:'work' as const,publishedAt:null,links:Array.from({length:1000},(_,j)=>`https://synthetic-author.dev/${i}/${j}`),limitations:[]}));
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:null,identity:null,candidates:[],pages,claims:[],unknowns:Array.from({length:300},(_,i)=>`gap ${i}`),stopReason:null,catalog:{offset:30,linkOffset:100,unknownOffset:60}};
 const data=JSON.parse(buildResearchPrompt({question:'fixture',checkpoint,remainingTools:null,remainingModels:null}));assert.equal(data.sources.length,12);assert.equal(data.sourceCatalog.total,200);assert.equal(data.sources[0].sourceKey,'S30');assert.equal(data.sources[0].links.length,20);assert.equal(data.sources[0].links[0],pages[30]!.links[100]);assert.equal(data.unknowns[0],'gap 60');assert.equal(data.unknownsTotal,300);assert.ok(JSON.stringify(data).length<40000);assert.equal(pages[30]!.text.length,50000);
});
test('legacy inspect cache is reconstructed from active pages and never trusted as text',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');const base={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:null,identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null,inspect:{sourceKey:'S2',offset:0,text:'REVOKED_SYNTHETIC_TEXT'}};
 assert.doesNotMatch(buildResearchPrompt({question:'fixture',checkpoint:base,remainingTools:null,remainingModels:null}),/REVOKED_SYNTHETIC_TEXT/);
});

test('oversized provider metadata is previewed without changing the stored source',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const page={sourceKey:'S1',url:'https://synthetic-author.dev/work',title:'Synthetic',text:'Dated original.',kind:'work' as const,author:'a'.repeat(600000),publishedAt:'d'.repeat(600000),retrievedAt:'r'.repeat(600000),links:[],limitations:[],retrieval:'read' as const};
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:null,identity:null,candidates:[],pages:[page],claims:[],unknowns:[],stopReason:null};
 const claim={statement:'Dated original.',facet:'work' as const,kind:'page_statement' as const,section:'work' as const,sourceKey:'S1',quote:'Dated original.'};
 for(const mode of ['plan','verify'] as const){const prompt=buildResearchPrompt({question:'fixture',mode,claims:[claim],checkpoint,remainingTools:null,remainingModels:null});const data=JSON.parse(prompt);assert.ok(prompt.length<16000);assert.equal(data.sources[0].author.length,1000);assert.equal(data.sources[0].publishedAt.length,100);assert.equal(data.sources[0].metadataWindow.author,600000);}
 assert.equal(page.author.length,600000);assert.equal(page.publishedAt.length,600000);
});

test('catalog selection is clamped when active sources shrink after revocation',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const page={sourceKey:'S1',url:'https://synthetic-author.dev/work',title:'Synthetic',text:'Still active.',kind:'work' as const,publishedAt:null,links:[],limitations:[]};
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:null,identity:null,candidates:[],pages:[page],claims:[],unknowns:[],stopReason:null,catalog:{offset:90,linkOffset:0,unknownOffset:0}};
 const data=JSON.parse(buildResearchPrompt({question:'fixture',checkpoint,remainingTools:null,remainingModels:null}));assert.equal(data.sourceCatalog.offset,0);assert.equal(data.sources[0].sourceKey,'S1');assert.equal(checkpoint.catalog.offset,90);
});


test('scoped HTML previews skip styling and navigation while retaining exact original offsets', async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const text='<html><head><style>'+ 'x'.repeat(12000)+'</style></head><body><nav>'+ 'navigation '.repeat(90)+'</nav><p>Lin Zhou creates public compiler lessons and publishes dated release notes so others can inspect the work.</p></body></html>';
 const page={sourceKey:'S1',url:'https://fixture-linzhou.org/',title:'Lin Zhou',text,kind:'profile' as const,publishedAt:null,links:[],limitations:[]};
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:page.url,identity:null,candidates:[],pages:[page],claims:[],unknowns:[],stopReason:null,firstStep:{caseId:'case',scopeVersion:1,discoveryRevision:1,selectedAccountIds:[],independentAccountIds:[],clusterId:'cluster',displayName:'Lin Zhou',anchorUrl:page.url,accountKeys:{},accounts:[]}};
 const data=JSON.parse(buildResearchPrompt({question:'Lin Zhou',checkpoint,remainingTools:5,remainingModels:5}));
 assert.match(data.sources[0].preview,/Lin Zhou creates/);
 assert.equal(data.sources[0].preview,text.slice(data.sources[0].window.offset,data.sources[0].window.offset+600));
 assert.ok(data.sources[0].window.offset>12000);assert.equal(page.text,text);
});

test('a timeline cannot push other selected accounts out of default context and explicit catalog still pages exactly',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');const {classifyFirstStepUrl}=await import('../shared/first-step-discovery.js');
 const urls=['https://fixture-context-author.org/','https://github.com/fixture-context-author','https://x.com/fixturewriter'];
 const pages=urls.map((url,i)=>({sourceKey:`S${i+1}`,url,title:'Original',text:`Exact original ${i}`,kind:'profile' as const,publishedAt:null,links:[],limitations:[],retrieval:'read' as const}));
 for(let i=4;i<104;i++)pages.push({...pages[2]!,sourceKey:`S${i}`,url:`https://x.com/fixturewriter/status/${i}`,text:`Exact post ${i}`});
 const accountKeys=Object.fromEntries(urls.map((url,i)=>{const c=classifyFirstStepUrl(url);assert.ok(c.ok);return [c.ref.accountKey,`acc${i}`];}));
 const checkpoint={phase:'planning',steps:2,startedAt:0,elapsedMs:0,anchorUrl:urls[0]!,identity:null,candidates:[],pages,claims:[],unknowns:[],stopReason:null,firstStep:{caseId:'case',scopeVersion:1,discoveryRevision:1,selectedAccountIds:[],independentAccountIds:[],clusterId:'cluster',displayName:'Fixture',anchorUrl:urls[0]!,accountKeys,accounts:[]}};
 const original=JSON.stringify(checkpoint);const data=JSON.parse(buildResearchPrompt({question:'Fixture',checkpoint,remainingTools:8,remainingModels:8}));
 assert.equal(data.sources.length,12);assert.ok(urls.every(url=>data.sources.some((p:{url:string})=>p.url===url)));
 assert.equal(data.sourceCatalog.mode,'selected_accounts_and_recent');assert.equal(data.sourceCatalog.offset,null);assert.deepEqual(data.sourceCatalog.sourceKeys,data.sources.map((p:{sourceKey:string})=>p.sourceKey));assert.equal(JSON.stringify(checkpoint),original);
 const requested=JSON.parse(buildResearchPrompt({question:'Fixture',checkpoint:{...checkpoint,catalog:{offset:50,linkOffset:0,unknownOffset:0}},remainingTools:8,remainingModels:8}));assert.equal(requested.sources[0].sourceKey,pages[50]!.sourceKey);assert.equal(requested.sourceCatalog.offset,50);assert.equal(requested.sourceCatalog.mode,undefined);
});


test('batch descriptor text is rebuilt and scoped instead of trusting cached or outside text',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');const {classifyFirstStepUrl}=await import('../shared/first-step-discovery.js');
 const url='https://fixture-window-author.dev/';const ref=classifyFirstStepUrl(url);assert.ok(ref.ok);
 const page={sourceKey:'S1',url,title:'Fixture',text:'EXACT_WINDOW',kind:'profile' as const,publishedAt:null,links:[],limitations:[]};
 const checkpoint={phase:'planning',steps:2,startedAt:0,elapsedMs:0,anchorUrl:url,identity:null,candidates:[],pages:[page,{...page,sourceKey:'S2',url:'https://other-window-author.dev/',text:'OUTSIDE_SCOPE'}],claims:[],unknowns:[],stopReason:null,
 inspectWindows:[{sourceKey:'S1',offset:0,text:'FAKE_CACHE'},{sourceKey:'S2',offset:0},{sourceKey:'REVOKED',offset:0},{sourceKey:'S1',offset:-1}],firstStep:{caseId:'case',scopeVersion:1,discoveryRevision:1,selectedAccountIds:['a'],independentAccountIds:[],clusterId:'c',displayName:'Fixture',anchorUrl:url,accountKeys:{[ref.ref.accountKey]:'a'},accounts:[{accountId:'a',accountKey:ref.ref.accountKey,profileUrl:url,allowedScope:'public_history' as const,independent:false,accessCoverage:'read'}]}};
 const data=JSON.parse(buildResearchPrompt({question:'Fixture',checkpoint,remainingTools:5,remainingModels:5}));
 assert.equal(data.inspects.length,1);assert.equal(data.inspects[0].text,page.text);assert.equal(data.inspects[0].offset,0);assert.equal(data.inspects[0].excerpt,true);assert.equal(data.inspect.text,page.text);assert.doesNotMatch(JSON.stringify(data.inspects),/FAKE_CACHE|OUTSIDE_SCOPE/);
 assert.doesNotMatch(data.firstStepScope.planningInstruction,/at most6 planning steps/);
});


test('scoped verification cannot borrow dates, roles or other entries from adjacent source text',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const quote='I completed my MSc research.';
 const text='In 2011 I began a PhD with Prof Other. '+quote+' Other article: bitcoin and compiler recipes.';
 const page={sourceKey:'S1',url:'https://fixture-quote-support.dev/',title:'Fixture',text,kind:'profile' as const,publishedAt:'2026-01-02T00:00:00Z',links:[],limitations:[],retrieval:'read' as const};
 const checkpoint={phase:'verifying',steps:1,startedAt:0,elapsedMs:0,anchorUrl:page.url,identity:null,candidates:[],pages:[page],claims:[],unknowns:[],stopReason:null};
 const claim={sourceKey:'S1',quote,statement:'In 2011 I began a PhD and completed an MSc.',kind:'attributed_statement' as const,section:'background' as const};
 const legacy=JSON.parse(buildResearchPrompt({mode:'verify',question:'Fixture',claims:[claim],checkpoint,remainingTools:null,remainingModels:null}));
 assert.equal(legacy.claims[0].sourceContext.text,text);assert.equal(legacy.evidencePolicy,undefined);
 const scoped=JSON.parse(buildResearchPrompt({mode:'verify',question:'Fixture',claims:[claim],checkpoint:{...checkpoint,quoteSupportPolicy:'exact_quote/v1'},remainingTools:null,remainingModels:null}));
 assert.equal(scoped.claims[0].sourceContext.text,quote);assert.equal(scoped.claims[0].sourceContext.offset,text.indexOf(quote));assert.equal(scoped.claims[0].sourceContext.textLength,text.length);
 assert.equal(scoped.evidencePolicy,'exact_quote/v1');assert.match(scoped.quotedSupportInstruction,/every clause.*only this claim exact quote/);assert.match(scoped.quotedSupportInstruction,/publication timestamp/);
 assert.equal(page.text,text);assert.equal(page.publishedAt,'2026-01-02T00:00:00Z');
});


test('synthesis-repair feedback cannot reproduce missing, outside-scope or forged original quotes',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');const {classifyFirstStepUrl}=await import('../shared/first-step-discovery.js');
 const url='https://fixture-repair-author.dev/',classified=classifyFirstStepUrl(url);assert.ok(classified.ok);
 const page={sourceKey:'S1',url,title:'Fixture',text:'I wrote this parser.',kind:'profile' as const,publishedAt:null,links:[],limitations:[],retrieval:'read' as const};
 const own={sourceKey:'S1',quote:page.text,statement:'Unsupported 2020 invention.',kind:'attributed_statement' as const,section:'work' as const};
 const absent={...own,sourceKey:'REVOKED',quote:'REVOKED_PRIVATE_TEXT'};
 const outside={...own,sourceKey:'S2',quote:'OUTSIDE_PRIVATE_TEXT'};
 const forged={...own,quote:'FORGED_QUOTE_TEXT'};
 const cp={phase:'planning',steps:2,startedAt:0,elapsedMs:0,anchorUrl:url,identity:null,candidates:[],pages:[page,{...page,sourceKey:'S2',url:'https://other-repair-author.dev/',text:outside.quote}],claims:[{...own,verified:true},{...absent,verified:true},{...outside,verified:true},{...forged,verified:true}],unknowns:[],stopReason:null,claimRepairRounds:1,verificationFeedback:[own,absent,outside,forged].map(claim=>({claim,reason:'Unsupported.'})),firstStep:{caseId:'case',scopeVersion:1,discoveryRevision:1,selectedAccountIds:['a'],independentAccountIds:[],clusterId:'c',displayName:'Fixture',anchorUrl:url,accountKeys:{[classified.ref.accountKey]:'a'},accounts:[{accountId:'a',accountKey:classified.ref.accountKey,profileUrl:url,allowedScope:'public_history' as const,independent:false,accessCoverage:'read'}]}};
 const data=JSON.parse(buildResearchPrompt({question:'Fixture',checkpoint:cp,remainingTools:5,remainingModels:5}));
 assert.equal(data.firstStepScope.synthesisRepair.rejected.length,1);assert.equal(data.firstStepScope.synthesisRepair.alreadyVerified.length,1);assert.doesNotMatch(JSON.stringify(data.firstStepScope.synthesisRepair),/REVOKED_PRIVATE_TEXT|OUTSIDE_PRIVATE_TEXT|FORGED_QUOTE_TEXT/);assert.equal(cp.verificationFeedback.length,4);
});

test('scoped planning prioritizes stored person originals over recent independent posts and labels both',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');const {classifyFirstStepUrl}=await import('../shared/first-step-discovery.js');
 const own='https://fixture-person-role.org/',independent='https://x.com/fixture_role';const ownRef=classifyFirstStepUrl(own),independentRef=classifyFirstStepUrl(independent);assert.ok(ownRef.ok&&independentRef.ok);
 const base={sourceKey:'S1',url:own,title:'Person',text:'I wrote this compiler.',kind:'profile' as const,publishedAt:null,links:[],limitations:[],retrieval:'read' as const};
 const pages=[base,...Array.from({length:5},(_,i)=>({...base,sourceKey:`WORK${i}`,url:own+'article-'+i})),{...base,sourceKey:'INDEPENDENT',url:independent},...Array.from({length:20},(_,i)=>({...base,sourceKey:`POST${i}`,url:independent+'/status/'+(1322934897290096640n+BigInt(i))}))];
 const checkpoint={phase:'planning',steps:2,startedAt:0,elapsedMs:0,anchorUrl:own,identity:null,candidates:[],pages,claims:[],unknowns:[],stopReason:null,inspectWindows:[{sourceKey:'WORK0',offset:0},{sourceKey:'POST0',offset:0}],firstStep:{caseId:'case',scopeVersion:1,discoveryRevision:1,selectedAccountIds:['own','independent'],independentAccountIds:['independent'],clusterId:'cluster',displayName:'Fixture',anchorUrl:own,accountKeys:{[ownRef.ref.accountKey]:'own',[independentRef.ref.accountKey]:'independent'},accounts:[{accountId:'own',accountKey:ownRef.ref.accountKey,profileUrl:own,allowedScope:'public_history' as const,independent:false,accessCoverage:'read'},{accountId:'independent',accountKey:independentRef.ref.accountKey,profileUrl:independent,allowedScope:'public_history' as const,independent:true,accessCoverage:'read'}]}};
 const data=JSON.parse(buildResearchPrompt({question:'Fixture',checkpoint,remainingTools:5,remainingModels:5}));assert.equal(data.sources.length,12);assert.equal(data.sources.filter((s:{sourceRole:string})=>s.sourceRole==='person_candidate').length,6);assert.equal(data.sources.find((s:{sourceKey:string})=>s.sourceKey==='INDEPENDENT').sourceRole,'independent_account_material_only');assert.deepEqual(data.inspects.map((s:{sourceRole:string})=>s.sourceRole),['person_candidate','independent_account_material_only']);assert.match(data.firstStepScope.sourceRoleInstruction,/cannot fill any person facet/);assert.match(data.firstStepScope.sourceRoleInstruction,/never cut a word/);
});
