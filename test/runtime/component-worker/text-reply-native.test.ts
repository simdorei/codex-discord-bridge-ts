import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {ServerRequestOccurrence} from '../../../src/protocol/ids.ts';
import {handlePendingTextReply as reply} from '../../../src/runtime/component-worker/text-reply.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {createNativePromptAuthorityReads,type PromptAuthorityReads} from '../../../src/runtime/server-prompt-authority-reads.ts';
import {promptTextFingerprint} from '../../../src/runtime/server-prompt-text-binding.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {NativeQueueReadUnavailableError} from '../../../src/runtime/queue-runner/native-read-state.ts';
import {promptFixture,callPromptFixture,editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
const names=['hasObservedCompletion','listQueueJobs','mirroredThreadId'] as const;
const kind=(name:string)=>(e:unknown)=>componentWorkerErrorInfo(e)?.kind===name;
function poison(t:TestContext){for(const name of [...names,'listFiltered'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));}
function deferred(){let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);return {wait,release};}
const input={enableResponses:true,method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',options:[{label:'One'},{label:'Two'}]}]}};
for(const type of ['approval','input'] as const)test(`native ${type} text reply uses captured authority and exact original response grammar`,async t=>promptFixture(async(path,server,request)=>{
 const reads=createNativePromptAuthorityReads(path);poison(t);
 const text=type==='approval'?'2':'1|two|"quoted \\ text"',confirmation=await reply('t',`[codex-reply:${promptTextFingerprint(request,1n)}] ${text}`,server,path,1n,2n,undefined,reads);
 assert.equal(confirmation,type==='approval'?'Approval response submitted: acceptForSession':'Codex input reply submitted.');
 assert.deepEqual(await callPromptFixture(server,'answers'),[{id:'approval',result:type==='approval'?{decision:'acceptForSession'}:{answers:{q:{answers:['One','Two','"quoted \\ text"']}}}}]);
 assert.equal(server.pendingServerRequests('t').length,0);assert.equal(ownedWorkerUsage().Control,0);
 await assert.rejects(reply('t',`[codex-reply:${promptTextFingerprint(request,1n)}] 1`,server,path,1n,2n,undefined,reads),kind('NoPendingRequest'));
},type==='input'?input:{enableResponses:true}));
for(const id of ['9007199254740993',9007199254740993n,'"quoted\\id"'])test(`native text response boundary retains exact ${typeof id} request ID ${String(id)}`,async t=>promptFixture(async(path,server,request)=>{
 const captured={...request,id},calls:unknown[][]=[];
 t.mock.method(PortableResidentLifecycle.prototype,'pendingServerRequests',()=>[captured]);
 t.mock.method(PortableResidentLifecycle.prototype,'respond',async(...args:unknown[])=>{calls.push(args);});poison(t);
 await reply('t',`[codex-reply:${promptTextFingerprint(captured,1n)}] 1`,server,path,1n,2n,undefined,createNativePromptAuthorityReads(path));
 assert.equal(calls.length,1);assert.equal(calls[0]![0],id);assert.deepEqual((calls[0]![1] as ServerRequestOccurrence).asBytes(),request.occurrence.asBytes());assert.deepEqual(calls[0]!.slice(2),[{decision:'accept'},1n,undefined]);
}, {enableResponses:true}));
test('native reply captures original request params and port functions before authority awaits; no fresh request selection',async t=>promptFixture(async(path,server,request)=>{
 const native=createNativePromptAuthorityReads(path),held=deferred(),entered=deferred(),calls:string[]=[];
 const reads={hasObservedCompletion:async(...args)=>{calls.push('Completed');entered.release();await held.wait;return native.hasObservedCompletion(...args);},listQueueJobs:async(...args)=>{calls.push('Jobs');return native.listQueueJobs(...args);},mirroredThreadId:async(...args)=>{calls.push('Mapping');return native.mirroredThreadId(...args);}} satisfies PromptAuthorityReads;
 const original=PortableResidentLifecycle.prototype.pendingServerRequests,mutable={...request,params:structuredClone(request.params)};let snapshots=0;
 t.mock.method(PortableResidentLifecycle.prototype,'pendingServerRequests',function(this:PortableResidentLifecycle,thread:string|null){snapshots++;return snapshots===1?[mutable]:original.call(this,thread);});poison(t);
 const pending=reply('t','1|"quoted"',server,path,1n,2n,undefined,reads);await entered.wait;
 mutable.id='changed';mutable.params={threadId:'other',turnId:'other',questions:[]};reads.listQueueJobs=async()=>assert.fail('replaced read');held.release();
 assert.equal(await pending,'Codex input reply submitted.');assert.deepEqual(calls,['Completed','Jobs','Mapping']);assert.equal(snapshots,2);
 assert.deepEqual(await callPromptFixture(server,'answers'),[{id:'approval',result:{answers:{q:{answers:['One','"quoted"']}}}}]);
},input));
for(const [channel,user] of [[1n,3n],[9n,2n]])test(`native wrong actor/channel ${channel}/${user} rejects before answer parsing`,async t=>promptFixture(async(path,server)=>{
 poison(t);await assert.rejects(reply('t','not a valid approval',server,path,channel!,user!,undefined,createNativePromptAuthorityReads(path)),kind('Authority'));assert.deepEqual(await callPromptFixture(server,'answers'),[]);
},{enableResponses:true}));
for(const after of names)for(const change of ['id','occurrence','params','method'] as const)test(`native reply never refreshes ${change} changed after ${after}`,async t=>promptFixture(async(path,server)=>{
 const native=createNativePromptAuthorityReads(path),original=PortableResidentLifecycle.prototype.pendingServerRequests;let changed=false;
 t.mock.method(PortableResidentLifecycle.prototype,'pendingServerRequests',function(this:PortableResidentLifecycle,thread:string|null){return original.call(this,thread).map(r=>!changed?r:change==='id'?{...r,id:1n}:change==='occurrence'?{...r,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(91))}:change==='params'?{...r,params:{threadId:'t',turnId:'v',changed:true}}:{...r,method:'item/fileChange/requestApproval'});});
 const step=async<T>(name:string,pending:Promise<T>)=>{const result=await pending;if(name===after)changed=true;return result;};
 const reads:PromptAuthorityReads={hasObservedCompletion:(...args)=>step(names[0],native.hasObservedCompletion(...args)),listQueueJobs:(...args)=>step(names[1],native.listQueueJobs(...args)),mirroredThreadId:(...args)=>step(names[2],native.mirroredThreadId(...args))};poison(t);
 await assert.rejects(reply('t','1',server,path,1n,2n,undefined,reads),kind('Authority'));assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(ownedWorkerUsage().Control,0);
},{enableResponses:true}));
test('native malformed unrelated allJobs row is preserved as unavailable, without response or compatibility fallback',async t=>promptFixture(async(path,server)=>{
 await state.enqueue(path,queueJob({jobId:'unrelated',targetThreadId:'other'}));await editPromptFixture(path,"UPDATE codex_turn_queue SET channel_id=1.5 WHERE job_id='unrelated'");poison(t);
 await assert.rejects(reply('t','1',server,path,1n,2n,undefined,createNativePromptAuthorityReads(path)),e=>componentWorkerErrorInfo(e)?.source instanceof NativeQueueReadUnavailableError);assert.deepEqual(await callPromptFixture(server,'answers'),[]);
},{enableResponses:true}));
test('native text reply refuses saturated Control, and cancellation retains a blocked read until actual exit without response',async t=>promptFixture(async(path,server)=>{
 const db=new DatabaseSync(path),reads=createNativePromptAuthorityReads(path),abort=new AbortController(),reason=Error('cancel original text');db.exec('BEGIN EXCLUSIVE');poison(t);
 const pending=reply('t','1',server,path,1n,2n,abort.signal,reads);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
 try{await assert.rejects(reply('t','1',server,path,1n,2n,undefined,createNativePromptAuthorityReads(path)),e=>componentWorkerErrorInfo(e)?.source instanceof OwnedWorkerBudgetError);abort.abort(reason);await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(await callPromptFixture(server,'answers'),[]);}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
},{enableResponses:true}));
