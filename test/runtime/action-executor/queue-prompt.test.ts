import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dirname,join} from 'node:path';
import {queueJob} from '../../helpers/queue-job.ts';
import {frozenSlashTarget} from '../../../src/store/ingress-new-input.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {QueuePromptExecutor} from '../../../src/runtime/action-executor/queue-prompt.ts';
import {ActionThreadSelection} from '../../../src/runtime/action-executor/thread-selection.ts';
import {ActionTargetServices} from '../../../src/runtime/action-executor/action-target.ts';
import {BusyResultProducer} from '../../../src/runtime/action-executor/busy-result.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {PromptIntakeProcessor} from '../../../src/runtime/prompt-intake/processor.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {INTERVIEW_HEADER} from '../../../src/runtime/action-executor/interview-header.ts';
function fixture(path:string){
 let active:string|null=null;const starts:string[]=[],bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('thread');
 const backend={generation:()=>1n,residentInstanceId:()=> 'resident',activeTurnId:async()=>active,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async(claim:Readonly<{prompt:string}>)=>{starts.push(claim.prompt);return 'turn';}};
 const queue=new QueueStartCoordinator(path,backend,{clock:()=>100}),verifier=new ControlTurnVerifier(path,null,bridge,new TargetLocks()),busy=new BusyResultProducer(path,verifier,queue.reads,()=>100);
 const targets=new ActionTargetServices(path,bridge,queue,{preparePrompt:async raw=>raw+' enriched',busyResult:busy.busyResult.bind(busy)}),intake=new PromptIntakeProcessor(path,queue,targets,{clock:()=>100,ticks:()=>({wait:()=>new Promise<void>(()=>{}),close(){}})});
 const executor=new QueuePromptExecutor(path,new ActionThreadSelection('unused-codex-state',path,bridge),targets,queue,intake,busy);
 return {executor,starts,queue,bridge,setActive:(value:string|null)=>{active=value;}};
}
test('ordinary prompt uses durable intake and actual queue, while saved repeat never dispatches twice',async()=>storeFixture(async path=>{
 const f=fixture(path),first=await f.executor.queuePrompt(1n,2n,3n,false,'raw');assert.equal(first.text,'In progress\nmessage: raw');assert.deepEqual(f.starts,['raw enriched']);assert.deepEqual(await state.listPromptIntakes(path),[]);
 await f.executor.queuePrompt(1n,2n,3n,false,'raw');assert.deepEqual(f.starts,['raw enriched']);
}));
test('busy request makes choice before intake unless auto-queue is enabled',async()=>storeFixture(async path=>{
 const f=fixture(path);f.setActive('active');const first=await f.executor.queuePrompt(1n,2n,3n,false,'raw');assert.ok(first.ui&&first.ui.kind==='Busy');assert.deepEqual(await state.listPromptIntakes(path),[]);assert.deepEqual(f.starts,[]);
 const queued=await f.executor.queuePrompt(1n,2n,4n,true,'queued');assert.equal(queued.waitsForFinal,true);assert.match(queued.text,/^Queued/);assert.equal((await state.listFiltered(path,'thread',null)).length,1);assert.deepEqual(f.starts,[]);
}));
test('interview uses exact pinned header before durable preparation',async()=>storeFixture(async path=>{
 const f=fixture(path);await f.executor.interview(1n,2n,3n,true,'question');assert.deepEqual(f.starts,[INTERVIEW_HEADER+'question enriched']);
}));
test('original slash route fence precedes saved replay and any busy choice',async()=>storeFixture(async path=>{
 const f=fixture(path);await state.admitIngress(path,{ingressId:'interaction:3',kind:'interaction',eventId:3n,applicationId:9n,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,work:{Slash:{name:'ask',values:{prompt:{String:'raw'}}}}},targetThreadId:'original',canonicalOwner:null,now:100});
 const original=await state.ingressByOrigin(path,3n);assert.ok(original);assert.equal(frozenSlashTarget(original),'original');
 await state.enqueue(path,queueJob({jobId:'saved-origin',targetThreadId:'thread',discordMessageId:3n,ownerUserId:2n}));assert.ok(await f.queue.replaySubmissionForMessage(3n));
 await assert.rejects(f.executor.queuePrompt(1n,2n,3n,false,'raw'),/original slash prompt target changed/);assert.deepEqual(f.starts,[]);assert.deepEqual(await state.listPromptIntakes(path),[]);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM busy_choices').get()?.n,0);}finally{db.close();}
}));
test('pre-cancelled prompt never starts target reads or intake',async()=>storeFixture(async path=>{
 const f=fixture(path),controller=new AbortController(),reason=new Error('shutdown');controller.abort(reason);await assert.rejects(f.executor.queuePrompt(1n,2n,3n,false,'raw',controller.signal),e=>e===reason);assert.deepEqual(f.starts,[]);assert.deepEqual(await state.listPromptIntakes(path),[]);
}));
