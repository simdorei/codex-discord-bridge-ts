import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promptFixture,callPromptFixture,editPromptFixture} from '../helpers/server-prompt-fixture.ts';
import {promptHttpFixture} from '../helpers/server-prompt-http-fixture.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {OwnedWorkerBudgetError,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {createNativePromptAuthorityReads,capturePromptAuthorityReadContext,type PromptAuthorityReads} from '../../src/runtime/server-prompt-authority-reads.ts';
import {prepareOneServerPrompt,prepareServerPrompts,preparedPromptEqual,PromptRedisplayChangedError} from '../../src/runtime/server-prompt-redisplay.ts';
import {PromptAuthorityError} from '../../src/runtime/server-prompt-authority.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {deliverServerPrompts} from '../../src/runtime/server-prompt-delivery.ts';
import {NativeQueueReadUnavailableError} from '../../src/runtime/queue-runner/native-read-state.ts';
import {pendingServerRequestEqual} from '../../src/app-server/server-request-state.ts';
const names=['hasObservedCompletion','listQueueJobs','mirroredThreadId'] as const;
function poison(t:TestContext){for(const name of names)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));}
function deferred(){let release!:()=>void;const wait=new Promise<void>(r=>release=r);return {wait,release};}
const input={method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',question:'x'.repeat(5000),options:[{label:'One'}]}]}};

test('optional authority context ignores inherited ports, rejects accessor and proxy hooks, and captures original own functions',async()=>{
 let hooks=0;const path='/original',port={hasObservedCompletion:async()=>false,listQueueJobs:async()=>[],mirroredThreadId:async()=> 'original'} satisfies PromptAuthorityReads;
 assert.equal(capturePromptAuthorityReadContext(path,{}),undefined);assert.equal(capturePromptAuthorityReadContext(path,Object.create({promptAuthorityReads:port})),undefined);
 const context={promptAuthorityReads:port},captured=capturePromptAuthorityReadContext(path,context)!;port.mirroredThreadId=async()=> 'replaced';context.promptAuthorityReads={...port,mirroredThreadId:async()=> 'other'};assert.ok(Object.isFrozen(captured));assert.equal(await captured.mirroredThreadId(path,1n),'original');assert.throws(()=>captured.mirroredThreadId('/different',1n),TypeError);
 const getter=Object.defineProperty({},'promptAuthorityReads',{get(){hooks++;return port;}}),proxy=new Proxy(context,{getOwnPropertyDescriptor(){hooks++;throw Error('trap');}});
 for(const value of [getter,proxy,{promptAuthorityReads:null}])assert.throws(()=>capturePromptAuthorityReadContext(path,value),TypeError);
 assert.throws(()=>capturePromptAuthorityReadContext(path,{promptAuthorityReads:new Proxy(port,{})}),TypeError);
 const thenable=capturePromptAuthorityReadContext(path,{promptAuthorityReads:{...port,listQueueJobs:()=>({then(){hooks++;}})}})!;assert.throws(()=>thenable.listQueueJobs(path),TypeError);assert.equal(hooks,0);
});
for(const kind of ['approval','input','unsupported','secret'] as const)test(`native ${kind} preparation matches the direct compatibility snapshot and fixed unavailable semantics`,async t=>promptFixture(async(path,server,request)=>{
 const reference=await prepareOneServerPrompt(path,server,request,1n,1n,2n),referenceAll=await prepareServerPrompts(path,server,'t',1n,2n),reads=createNativePromptAuthorityReads(path);poison(t);
 const one=await prepareOneServerPrompt(path,server,request,1n,1n,2n,reads),all=await prepareServerPrompts(path,server,'t',1n,2n,reads);
 assert.ok(preparedPromptEqual(reference,one));assert.ok(preparedPromptEqual(referenceAll[0]!,all[0]!));assert.ok(pendingServerRequestEqual(one.request,request));assert.equal(one.unavailable,kind==='unsupported'||kind==='secret');assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(ownedWorkerUsage().Control,0);
},kind==='input'?input:kind==='unsupported'?{method:'unrecognized/request',params:{threadId:'t',turnId:'v'}}:kind==='secret'?{method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',question:'private',isSecret:true}]}}:{}));

test('preparation captures the original port and request before first await and preserves read errors exactly',async()=>promptFixture(async(path,server,request)=>{
 const native=createNativePromptAuthorityReads(path),held=deferred(),entered=deferred(),calls:string[]=[];
 const reads={hasObservedCompletion:async(p,t,v)=>{calls.push('Completed');entered.release();await held.wait;return native.hasObservedCompletion(p,t,v);},listQueueJobs:async p=>{calls.push('Jobs');return native.listQueueJobs(p);},mirroredThreadId:async(p,c)=>{calls.push('Mapping');return native.mirroredThreadId(p,c);}} satisfies PromptAuthorityReads,mutable={...request};
 const pending=prepareOneServerPrompt(path,server,mutable,1n,1n,2n,reads);await entered.wait;
 reads.listQueueJobs=async()=>assert.fail('replacement function');mutable.params={threadId:'other',turnId:'other'};held.release();const prepared=await pending;
 assert.equal(prepared.unavailable,false);assert.ok(pendingServerRequestEqual(prepared.request,request));assert.deepEqual(calls,['Completed','Jobs','Mapping']);
 const failure=Error('original read failure');await assert.rejects(prepareOneServerPrompt(path,server,request,1n,1n,2n,{...native,listQueueJobs:async()=>{throw failure;}}),e=>e===failure);
}));
for(const after of names)for(const operation of ['automatic','one','all','delivery'] as const)test(`${operation} keeps the original occurrence when it changes after ${after}`,async t=>promptFixture(async(path,server,request)=>promptHttpFixture(async(http,seen)=>{
 const native=createNativePromptAuthorityReads(path),prepared=await prepareServerPrompts(path,server,'t',1n,2n,native),calls:string[]=[];let changed=false;
 const original=PortableResidentLifecycle.prototype.pendingServerRequests,replacement=ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(99));
 t.mock.method(PortableResidentLifecycle.prototype,'pendingServerRequests',function(this:PortableResidentLifecycle,thread:string|null=null){return original.call(this,thread).map(value=>changed?{...value,occurrence:replacement}:value);});
 const step=async<T>(name:string,pending:Promise<T>):Promise<T>=>{calls.push(name);const result=await pending;if(name===after)changed=true;return result;};
 const reads:PromptAuthorityReads={hasObservedCompletion:(...args)=>step('hasObservedCompletion',native.hasObservedCompletion(...args)),listQueueJobs:(...args)=>step('listQueueJobs',native.listQueueJobs(...args)),mirroredThreadId:(...args)=>step('mirroredThreadId',native.mirroredThreadId(...args))};poison(t);
 if(operation==='automatic')await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>assert.fail('unexpected HTTP')},true,reads).process(1n,request),PromptAuthorityError);
 else if(operation==='one'){const result=await prepareOneServerPrompt(path,server,request,1n,1n,2n,reads);assert.equal(result.unavailable,true);assert.deepEqual(result.prompt.components,[]);assert.ok(pendingServerRequestEqual(result.request,request));}
 else if(operation==='all')await assert.rejects(prepareServerPrompts(path,server,'t',1n,2n,reads),PromptRedisplayChangedError);
 else await assert.rejects(deliverServerPrompts({database:path,server,http,channelId:1n,userId:2n,commandKey:'original',nativePromptReceipts:true,promptAuthorityReads:reads},prepared),PromptRedisplayChangedError);
 assert.deepEqual(calls,[...names]);assert.deepEqual(seen,[]);assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(server.pendingServerRequests('t').length,1);assert.ok(!pendingServerRequestEqual(server.pendingServerRequests('t')[0]!,request));assert.ok(pendingServerRequestEqual(original.call(server,'t')[0]!,request));
})));
for(const change of ['actor','channel','mapping','turn','generation','request'] as const)test(`native multi-chunk redisplay stops before another HTTP request after ${change} drift`,async t=>promptFixture(async(path,server)=>{
 const reads=createNativePromptAuthorityReads(path),prompts=await prepareServerPrompts(path,server,'t',1n,2n,reads);poison(t);
 let changed=false;const original=PortableResidentLifecycle.prototype.pendingServerRequests,replacement=ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(99));
 t.mock.method(PortableResidentLifecycle.prototype,'pendingServerRequests',function(this:PortableResidentLifecycle,thread:string|null=null){return original.call(this,thread).map(value=>changed?{...value,occurrence:replacement}:value);});
 await promptHttpFixture(async(http,seen)=>{
  await assert.rejects(deliverServerPrompts({database:path,server,http,channelId:1n,userId:2n,commandKey:'drift-'+change,nativePromptReceipts:true,promptAuthorityReads:reads},prompts),PromptRedisplayChangedError);assert.equal(seen.length,1);assert.equal(ownedWorkerUsage().Control,0);
 },async()=>{if(change==='actor')await editPromptFixture(path,'UPDATE codex_turn_queue SET owner_user_id=99');else if(change==='channel')await editPromptFixture(path,'UPDATE codex_turn_queue SET channel_id=99');else if(change==='mapping')await editPromptFixture(path,"UPDATE mirror_threads SET codex_thread_id='other'");else if(change==='turn')await callPromptFixture(server,'next');else if(change==='generation')server.requestRestart();else changed=true;});
},input));

test('native unfiltered allJobs errors on unrelated malformed rows before automatic or explicit HTTP without fallback',async t=>promptFixture(async(path,server,request)=>{
 const reads=createNativePromptAuthorityReads(path),prompts=await prepareServerPrompts(path,server,'t',1n,2n,reads);await state.enqueue(path,queueJob({jobId:'unrelated',targetThreadId:'unrelated'}));await editPromptFixture(path,"UPDATE codex_turn_queue SET channel_id=1.5 WHERE job_id='unrelated'");
 await assert.rejects(prepareServerPrompts(path,server,'t',1n,2n),e=>!(e instanceof PromptAuthorityError));poison(t);
 await assert.rejects(prepareServerPrompts(path,server,'t',1n,2n,reads),NativeQueueReadUnavailableError);
 await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>assert.fail('unexpected HTTP')},true,reads).process(1n,request),NativeQueueReadUnavailableError);
 await promptHttpFixture(async(http,seen)=>{await assert.rejects(deliverServerPrompts({database:path,server,http,channelId:1n,userId:2n,commandKey:'bad-evidence',promptAuthorityReads:reads,nativePromptReceipts:true},prompts),NativeQueueReadUnavailableError);assert.deepEqual(seen,[]);});assert.equal(ownedWorkerUsage().Control,0);
}));

test('automatic native authority rejects Control saturation without a queue, joins cancelled blocked read, and never sends',async t=>promptFixture(async(path,server,request)=>{
 const reads=createNativePromptAuthorityReads(path),abort=new AbortController(),reason=Error('cancel original'),db=new DatabaseSync(path);db.exec('BEGIN EXCLUSIVE');poison(t);
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>assert.fail('unexpected HTTP')},true,reads),pending=delivery.process(1n,request,abort.signal);let ended=false;void pending.then(()=>{ended=true;},()=>{ended=true;});
 try{await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>assert.fail('unexpected HTTP')},true,createNativePromptAuthorityReads(path)).process(1n,request),OwnedWorkerBudgetError);assert.equal(ownedWorkerUsage().Control,1);abort.abort(reason);await new Promise(r=>setTimeout(r,80));assert.equal(ended,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(delivery.recover(),/already owned/);db.exec('ROLLBACK');await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Control,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));

test('direct omitted ports keep compatibility reads and receipt behavior',async t=>promptFixture(async(path,server,request)=>{
 const calls:string[]=[];for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(state,name)!,original=state[name];Object.defineProperty(state,name,{...descriptor,value:(...args:unknown[])=>{calls.push(name);return Reflect.apply(original,state,args);}});t.after(()=>Object.defineProperty(state,name,descriptor));}
 const one=await prepareOneServerPrompt(path,server,request,1n,1n,2n);assert.equal(one.unavailable,false);assert.deepEqual(calls,[...names]);calls.length=0;
 const prompts=await prepareServerPrompts(path,server,'t',1n,2n);assert.deepEqual(calls,[...names]);calls.length=0;
 let sends=0;await new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 90n;}}).process(1n,request);assert.equal(sends,1);assert.deepEqual(calls,[...names,...names]);calls.length=0;
 await promptHttpFixture(async(http,seen)=>{await deliverServerPrompts({database:path,server,http,channelId:1n,userId:2n,commandKey:'compat'},prompts);assert.equal(seen.length,1);assert.deepEqual(calls,[...names]);});
}));

test('native automatic multi-chunk input retains original channel and accepted prefix after channel drift',async t=>promptFixture(async(path,server,request)=>{
 const reads=createNativePromptAuthorityReads(path);poison(t);let sends=0;
 await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;await editPromptFixture(path,'UPDATE codex_turn_queue SET channel_id=99');return 95n;}},true,reads).process(1n,request),/original delivery channel changed/);
 assert.equal(sends,1);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1);}finally{db.close();}assert.equal(ownedWorkerUsage().Control,0);
},input));

test('native automatic multi-chunk input recovers exact original receipts without a new occurrence or another send',async t=>promptFixture(async(path,server,request)=>{
 const reads=createNativePromptAuthorityReads(path),bodies:Array<{nonce:string;components?:unknown[]}>=[],transport={sendValidated:async(value:{body:string})=>{bodies.push(JSON.parse(value.body));return BigInt(200+bodies.length);}};poison(t);
 await new ServerRequestDelivery(path,server,transport,true,reads).process(1n,request);const count=bodies.length;assert.ok(count>1);assert.ok(bodies.at(-1)!.components!.length>0);assert.ok(bodies.slice(0,-1).every(body=>(body.components?.length??0)===0));
 await new ServerRequestDelivery(path,server,transport,true,reads).recover();assert.equal(bodies.length,count);assert.ok(pendingServerRequestEqual(server.pendingServerRequests('t')[0]!,request));assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(ownedWorkerUsage().Control,0);
},input));

test('redisplay snapshots original path actor command and read functions before awaited evidence',async t=>promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
 const native=createNativePromptAuthorityReads(path),prompts=await prepareServerPrompts(path,server,'t',1n,2n,native),held=deferred(),entered=deferred();let first=true;
 const mutable={...native,hasObservedCompletion:async(...args:Parameters<PromptAuthorityReads['hasObservedCompletion']>)=>{if(first){first=false;entered.release();await held.wait;}return native.hasObservedCompletion(...args);}},context={database:path,server,http,channelId:1n,userId:2n,commandKey:'original-key',promptAuthorityReads:mutable,nativePromptReceipts:true};poison(t);
 const pending=deliverServerPrompts(context,prompts);await entered.wait;context.database=path+'.wrong';context.channelId=99n;context.userId=99n;context.commandKey='changed-key';mutable.listQueueJobs=async()=>assert.fail('changed reads');held.release();await pending;
 assert.ok(seen.length>1);assert.ok(seen.every(request=>request.path.includes('/channels/1/messages')));const db=new DatabaseSync(path,{readOnly:true});try{const rows=db.prepare('SELECT receipt_key FROM codex_delivery_receipts').all();assert.equal(rows.length,seen.length);assert.ok(rows.every(row=>String(row.receipt_key).includes('original-key')&&!String(row.receipt_key).includes('changed-key')));}finally{db.close();}assert.equal(ownedWorkerUsage().Control,0);
}),input));
