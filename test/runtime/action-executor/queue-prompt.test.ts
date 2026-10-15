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
import type {AdmissionReads} from '../../../src/runtime/action-executor/admission-read-state.ts';
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

function observedPrompt(reads:AdmissionReads){
 const calls:string[]=[],result={text:'admitted',waitsForFinal:false,ui:null},replay:{value:Awaited<ReturnType<QueueStartCoordinator['replaySubmissionForMessage']>>}={value:null};
 const selection={target:async(channel:bigint)=>{assert.equal(channel,9007199254740993n);calls.push('selection');return ['original','mirror'];}} as unknown as ActionThreadSelection;
 const targets={canonicalizeCompletedTarget:async(thread:string)=>{assert.equal(thread,'original');calls.push('canonical');return 'canonical';}} as unknown as ActionTargetServices;
 const queue={replaySubmissionForMessage:async(event:bigint)=>{assert.equal(event,9007199254740995n);calls.push('replay');return replay.value;},reads:{busyStatus:async(thread:string)=>{assert.equal(thread,'canonical');calls.push('busy');return {busy:false,allowSteer:false};}}} as unknown as QueueStartCoordinator;
 const intake={admitPrompt:async(request:{targetThreadId:string;channelId:bigint;userId:bigint;discordMessageId:bigint|null})=>{assert.equal(request.targetThreadId,'canonical');assert.equal(request.channelId,9007199254740993n);assert.equal(request.userId,9007199254740994n);assert.ok(request.discordMessageId===null||request.discordMessageId===9007199254740995n);calls.push('intake');return result;}} as unknown as PromptIntakeProcessor;
 const busy={busyResult:async()=>assert.fail('no busy choice expected')} as unknown as BusyResultProducer;
 return {calls,result,replay,create:(port:AdmissionReads)=>new QueuePromptExecutor('original-database',selection,targets,queue,intake,busy,port),executor:new QueuePromptExecutor('original-database',selection,targets,queue,intake,busy,reads)};
}
const emptyAdmission=():AdmissionReads=>({getIngress:async()=>null,ingressByOrigin:async()=>null,mirroredThreadId:async()=>null});
test('prompt origin port is captured once and preserves exact bigint ordering, saved replay and null-event skip',async()=>{
 const reads=emptyAdmission(),f=observedPrompt(reads);let origins=0;
 const captured={...reads,ingressByOrigin:async(path:string,event:bigint)=>{assert.equal(path,'original-database');assert.equal(event,9007199254740995n);origins++;f.calls.push('origin');return null;}};
 const executor=f.create(captured);captured.ingressByOrigin=async()=>assert.fail('replacement must not be invoked');
 assert.deepEqual(await executor.queuePrompt(9007199254740993n,9007199254740994n,9007199254740995n,false,'raw'),f.result);assert.deepEqual(f.calls,['selection','origin','replay','canonical','busy','intake']);
 f.calls.length=0;f.replay.value={jobId:'saved',queued:true,turnId:null};assert.match((await executor.queuePrompt(9007199254740993n,9007199254740994n,9007199254740995n,false,'raw')).text,/Queued/);assert.deepEqual(f.calls,['selection','origin','replay']);
 f.calls.length=0;await executor.queuePrompt(9007199254740993n,9007199254740994n,null,true,'raw');assert.deepEqual(f.calls,['selection','canonical','intake']);assert.equal(origins,2);
});
test('prompt constructor refuses active admission ports and origin invocation requires a genuine Promise without assimilation',async()=>{
 const f=observedPrompt(emptyAdmission());let hooks=0;
 for(const key of ['getIngress','ingressByOrigin','mirroredThreadId'] as const){
  const accessor=Object.defineProperty(emptyAdmission(),key,{get(){hooks++;return async()=>null;}});assert.throws(()=>f.create(accessor),TypeError);
  for(const value of [function*(){hooks++;},async function*(){hooks++;},new Proxy(()=>null,{apply(){hooks++;return null;}}),null])assert.throws(()=>f.create({...emptyAdmission(),[key]:value} as AdmissionReads),TypeError);
 }
 assert.throws(()=>f.create(new Proxy(emptyAdmission(),{getOwnPropertyDescriptor(){hooks++;return undefined;}})),TypeError);
 for(const value of [null,undefined,{get then(){hooks++;return ()=>{hooks++;};}},new Proxy(Promise.resolve(null),{})]){
  const executor=f.create({...emptyAdmission(),ingressByOrigin:()=>value} as AdmissionReads);f.calls.length=0;await assert.rejects(executor.queuePrompt(9007199254740993n,9007199254740994n,9007199254740995n,false,'raw'),/Promise/);assert.deepEqual(f.calls,['selection']);
 }assert.equal(hooks,0);
});
test('prompt origin preserves synchronous and asynchronous errors without replay, canonicalization, busy choice or intake',async()=>{
 for(const synchronous of [false,true]){const failure=new Error('origin unavailable'),f=observedPrompt({...emptyAdmission(),ingressByOrigin:()=>{if(synchronous)throw failure;return Promise.reject(failure);}});
  await assert.rejects(f.executor.queuePrompt(9007199254740993n,9007199254740994n,9007199254740995n,false,'raw'),e=>e===failure);assert.deepEqual(f.calls,['selection']);
 }
});
test('prompt origin cancellation joins its captured read and never enters a successor',async()=>{
 let release!:(value:null)=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),read=new Promise<null>(r=>{release=r;}),f=observedPrompt({...emptyAdmission(),ingressByOrigin:()=>{entered();return read;}}),cancel=new AbortController(),reason=new Error('cancel original origin');let settled=false;
 const pending=f.executor.queuePrompt(9007199254740993n,9007199254740994n,9007199254740995n,false,'raw',cancel.signal),rejected=assert.rejects(pending,e=>e===reason);void pending.then(()=>{settled=true;},()=>{settled=true;});await started;cancel.abort(reason);await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(f.calls,['selection']);release(null);await rejected;assert.deepEqual(f.calls,['selection']);
 f.calls.length=0;await assert.rejects(f.executor.queuePrompt(9007199254740993n,9007199254740994n,9007199254740995n,false,'raw',cancel.signal),e=>e===reason);assert.deepEqual(f.calls,[]);
});
