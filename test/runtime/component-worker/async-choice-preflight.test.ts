import assert from 'node:assert/strict';
import {test} from 'node:test';
import {preflightAsyncChoice} from '../../../src/runtime/component-worker/async-choice-preflight.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {ownedRequestFailure} from '../../../src/app-server/request-client.ts';
import {asyncChoiceServer as fixture} from '../../helpers/async-choice-server.ts';
const invalid=(e:unknown)=>componentWorkerErrorInfo(e)?.kind==='AsyncQuestion';
test('active original turn returns Steer without history reads; active successor refuses with no RPC',async()=>{
  await fixture({active:'v'},async(server,q,seen)=>{assert.deepEqual(await preflightAsyncChoice(server,q),{mode:'steer',baselineTurnIds:[]});assert.deepEqual(await seen(),[]);});
  await fixture({active:'new'},async(server,q,seen)=>{await assert.rejects(preflightAsyncChoice(server,q),invalid);assert.deepEqual(await seen(),[]);});
});
test('foreign resident and changed or signed-negative generation reject before history queries',async()=>fixture({},async(server,q,seen)=>{
  for(const changed of [{...q,runtimeId:'foreign'},{...q,generation:2n},{...q,generation:-1n}])await assert.rejects(preflightAsyncChoice(server,changed),invalid);assert.deepEqual(await seen(),[]);
}));
test('completed original turn uses exact ordered latest/goal/full-history reads and immutable UTF8 baseline',async()=>fixture({history:{thread:{id:'t',turns:[{id:'😀',status:'failed'},{id:'v',status:'completed'},{id:'\ue000',status:'interrupted'}]}}},async(server,q,seen)=>{
  const result=await preflightAsyncChoice(server,q);assert.deepEqual(result,{mode:'start',baselineTurnIds:['v','\ue000','😀']});assert.ok(Object.isFrozen(result.baselineTurnIds));
  assert.deepEqual(await seen(),[{method:'thread/turns/list',params:{threadId:'t',limit:1n,sortDirection:'desc',itemsView:'full'}},{method:'thread/goal/get',params:{threadId:'t'}},{method:'thread/read',params:{threadId:'t',includeTurns:true}}]);
}));
test('missing/empty/multiple/nonterminal/latest successor evidence stops before goal and history',async()=>{
  for(const latest of [{},{data:[]},{data:[{id:'v',status:'completed'},{id:'v',status:'completed'}]},{data:[{id:'other',status:'completed'}]},{data:[{id:'v',status:'interrupted'}]}])await fixture({latest},async(server,q,seen)=>{await assert.rejects(preflightAsyncChoice(server,q),invalid);assert.equal((await seen()).length,1);});
});
test('active goal or invalid goal refuses while paused/blocked/complete goal retains source eligibility',async()=>{
  for(const status of ['active','unknown'])await fixture({goal:{goal:{threadId:'t',status}}},async(server,q,seen)=>{await assert.rejects(preflightAsyncChoice(server,q),invalid);assert.equal((await seen()).length,2);});
  for(const status of ['paused','blocked','complete','usageLimited','budgetLimited'])await fixture({goal:{goal:{threadId:'t',status}}},async(server,q)=>{assert.equal((await preflightAsyncChoice(server,q)).mode,'start');});
});
test('full history rejects duplicate identity, in-progress sibling, missing original and foreign thread',async()=>{
  for(const history of [{thread:{id:'t',turns:[{id:'v',status:'completed'},{id:'v',status:'completed'}]}},{thread:{id:'t',turns:[{id:'v',status:'completed'},{id:'new',status:'inProgress'}]}},{thread:{id:'t',turns:[{id:'old',status:'completed'}]}},{thread:{id:'other',turns:[{id:'v',status:'completed'}]}}])await fixture({history},async(server,q)=>{await assert.rejects(preflightAsyncChoice(server,q),invalid);});
});
test('native read rejection keeps AppServer remote error instead of guessing a start mode',async()=>fixture({fail:'thread/goal/get'},async(server,q,seen)=>{
  await assert.rejects(preflightAsyncChoice(server,q),e=>{const info=componentWorkerErrorInfo(e);return info?.kind==='AppServer'&&ownedRequestFailure(info.source)?.kind==='Remote';});assert.equal((await seen()).length,2);
}));
test('question identity is captured before awaits and active getters are rejected without invocation',async()=>fixture({},async(server,q,seen)=>{
  const mutable={...q},operation=preflightAsyncChoice(server,mutable);mutable.threadId='changed';mutable.turnId='changed';assert.equal((await operation).mode,'start');assert.ok((await seen()).every(r=>r.params.threadId==='t'));
  let hooks=0;await assert.rejects(preflightAsyncChoice(server,{...q,get runtimeId(){hooks++;return server.instanceId;}}),TypeError);assert.equal(hooks,0);
}));
