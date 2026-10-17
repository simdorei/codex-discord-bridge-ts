import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import workerThreads,{Worker,type WorkerOptions} from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {refreshMirrorPolicyOffThread,takeMirrorPolicyCapacityRefusal,NativeMirrorPolicyError} from '../../../src/runtime/discord-runtime/native-mirror-policy.ts';
import {submitNativeMirrorPolicy,takeNativeMirrorPolicyTransportRefusal} from '../../../src/runtime/discord-runtime/native-mirror-policy-transport.ts';

const limits=Object.freeze({maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000});
const policy=()=>new InteractionAccessPolicy({allowedChannelIds:[1n],allowedUserIds:[2n],mirroredChannelIds:[77n],allowAllChannels:false});
const waiting=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,15000);parentPort.postMessage('released');parentPort.close();"));
const rejection=(pending:Promise<unknown>):Promise<unknown>=>pending.then(()=>assert.fail('Expected rejection'),error=>error);

async function saturated<T>(body:()=>Promise<T>):Promise<T>{
 const shared=new SharedArrayBuffer(4),view=new Int32Array(shared),slots=Array.from({length:3},()=>new OwnedWorkerSlot());
 const tasks:Promise<{value:unknown}|{error:unknown}>[]=[];
 try{
  for(const slot of slots)tasks.push(slot.run(waiting,shared,10000).then(value=>({value}),error=>({error})));
  assert.equal(ownedWorkerUsage().Background,3);return await body();
 }
 finally{
  Atomics.store(view,0,1);Atomics.notify(view,0);
  const results=await Promise.all(tasks);await Promise.all(slots.map(slot=>slot.join()));
  assert.deepEqual(results,tasks.map(()=>({value:'released'})));
  assert.equal(ownedWorkerUsage().Background,0);
 }
}

function initialize(path:string):void{
 const db=new DatabaseSync(path);
 try{db.exec(`CREATE TABLE mirror_threads(codex_thread_id TEXT,thread_title TEXT,discord_channel_id,discord_thread_id,updated_at);
 CREATE TABLE mirror_projects(discord_channel_id);INSERT INTO mirror_threads VALUES ('t','T',8,7,1);INSERT INTO mirror_projects VALUES (9)`);}
 finally{db.close();}
}

test('real shared capacity binds exact transport and owner proofs; genuine errors replayed as admitted abort reasons carry no new proof',async()=>storeFixture(async path=>{
 const original=await saturated(async()=>{
  const transport=submitNativeMirrorPolicy(path,limits),transportError=await rejection(transport);
  const owner=refreshMirrorPolicyOffThread(policy(),path,limits),ownerError=await rejection(owner);
  assert.ok(transportError instanceof OwnedWorkerBudgetError);assert.ok(ownerError instanceof OwnedWorkerBusyError);
  assert.equal(takeNativeMirrorPolicyTransportRefusal(transport.then(()=>undefined,()=>undefined),transportError),false);
  assert.equal(takeNativeMirrorPolicyTransportRefusal(transport,new OwnedWorkerBudgetError()),false);
  assert.equal(takeNativeMirrorPolicyTransportRefusal(owner,ownerError),false);
  assert.equal(takeMirrorPolicyCapacityRefusal(Promise.resolve(policy()),ownerError),false);
  assert.equal(takeMirrorPolicyCapacityRefusal(owner,transportError),false);
  assert.equal(ownedWorkerUsage().Background,3);assert.equal(existsSync(path),false);
  return {transport,transportError,owner,ownerError};
 });
 // A real new submission receives the old error only as its cancellation reason.
 // No slot method, worker result, join Promise, or proof map is replaced.
 for(const layer of ['transport','owner'] as const){
  const abort=new AbortController(),error=layer==='transport'?original.transportError:original.ownerError;
  const pending=layer==='transport'?submitNativeMirrorPolicy(path,limits,abort.signal):refreshMirrorPolicyOffThread(policy(),path,limits,abort.signal);
  const result=rejection(pending);
  try{
   assert.equal(ownedWorkerUsage().Background,1);abort.abort(error);assert.equal(await result,error);
   assert.equal(ownedWorkerUsage().Background,0);assert.equal(takeNativeMirrorPolicyTransportRefusal(pending,error),false);
   if(layer==='owner')assert.equal(takeMirrorPolicyCapacityRefusal(pending as Promise<InteractionAccessPolicy>,error),false);
  }finally{abort.abort(error);await Promise.allSettled([result]);}
 }
 assert.equal(takeNativeMirrorPolicyTransportRefusal(original.transport,original.transportError),true);
 assert.equal(takeNativeMirrorPolicyTransportRefusal(original.transport,original.transportError),false);
 assert.equal(takeMirrorPolicyCapacityRefusal(original.owner,original.ownerError),true);
 assert.equal(takeMirrorPolicyCapacityRefusal(original.owner,original.ownerError),false);
 assert.equal(existsSync(path),false);
}));

test('actual local mirror worker owns the slot through cancellation while concurrent transport and owner invocations receive one-use refusals',async()=>storeFixture(async path=>{
 initialize(path);const abort=new AbortController(),reason=Error('cancel original native read');
 const first=submitNativeMirrorPolicy(path,limits,abort.signal),firstResult=rejection(first);
 const refusals:Promise<unknown>[]=[];
 try{
  const transport=submitNativeMirrorPolicy(path,limits),transportResult=rejection(transport);refusals.push(transportResult);
  const owner=refreshMirrorPolicyOffThread(policy(),path,limits),ownerResult=rejection(owner);refusals.push(ownerResult);
  assert.equal(ownedWorkerUsage().Background,1);abort.abort(reason);
  const transportError=await transportResult,ownerError=await ownerResult;
  assert.ok(transportError instanceof OwnedWorkerBusyError);assert.equal(transportError instanceof OwnedWorkerBudgetError,false);
  assert.ok(ownerError instanceof OwnedWorkerBusyError);
  assert.equal(takeNativeMirrorPolicyTransportRefusal(transport,transportError),true);
  assert.equal(takeNativeMirrorPolicyTransportRefusal(transport,transportError),false);
  assert.equal(takeMirrorPolicyCapacityRefusal(owner,ownerError),true);
  assert.equal(takeMirrorPolicyCapacityRefusal(owner,ownerError),false);
  assert.equal(await firstResult,reason);assert.equal(takeNativeMirrorPolicyTransportRefusal(first,reason),false);
 }finally{abort.abort(reason);await Promise.allSettled([firstResult,...refusals]);}
 assert.equal(ownedWorkerUsage().Background,0);
 assert.deepEqual(await submitNativeMirrorPolicy(path,limits),{ok:true,ids:[7n,8n,9n]});
 assert.equal(ownedWorkerUsage().Background,0);
}));

test('genuine capacity rejection keeps precedence over a later abort before owner continuation',async()=>storeFixture(async path=>saturated(async()=>{
 const abort=new AbortController(),reason=Error('abort after synchronous refusal');
 const pending=refreshMirrorPolicyOffThread(policy(),path,limits,abort.signal);abort.abort(reason);
 const error=await rejection(pending);assert.notEqual(error,reason);assert.ok(error instanceof OwnedWorkerBusyError);
 assert.equal(takeMirrorPolicyCapacityRefusal(pending,error),true);assert.equal(takeMirrorPolicyCapacityRefusal(pending,error),false);
 assert.equal(ownedWorkerUsage().Background,3);assert.equal(existsSync(path),false);
})));

test('owner validates original path, limits and private policy before real shared capacity refusal',async()=>storeFixture(async path=>saturated(async()=>{
 let hooks=0;
 await assert.rejects(refreshMirrorPolicyOffThread(policy(),'bad\0path',limits),RangeError);
 await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,{...limits,maxRows:0n}),RangeError);
 await assert.rejects(refreshMirrorPolicyOffThread(new Proxy(policy(),{get(){hooks++;throw Error('hook');}}),path,limits),TypeError);
 const abort=new AbortController(),reason=Error('already aborted');abort.abort(reason);
 assert.equal(await rejection(refreshMirrorPolicyOffThread(policy(),'bad\0path',{...limits,maxRows:0n},abort.signal)),reason);
 assert.equal(hooks,0);assert.equal(ownedWorkerUsage().Background,3);assert.equal(existsSync(path),false);
})));

for(const layer of ['transport','owner'] as const)for(const store of ['complete','missing'] as const)test(`real worker exit precedes ${layer} continuation cancellation for ${store} raw response`,async()=>storeFixture(async path=>{
 if(store==='complete')initialize(path);
 const abort=new AbortController(),reason=Error('cancel after native exit'),Original=Worker;
 const observed:{exitCode:number;background:number;settled:boolean}[]=[];let settled=false,constructed=0;
 // Observe the original fixed Worker without replacing its URL, options, code,
 // business input, result, or slot methods. The microtask runs after all real
 // exit listeners, including ownership release, but before owner continuation.
 class ExitObserver extends Original{
  constructor(filename:string|URL,options?:WorkerOptions){
   super(filename,options);
   if(filename instanceof URL&&filename.pathname.endsWith('/mirror-policy-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts'))){
    constructed++;this.once('exit',exitCode=>queueMicrotask(()=>{observed.push({exitCode,background:ownedWorkerUsage().Background,settled});abort.abort(reason);}));
   }
  }
 }
 workerThreads.Worker=ExitObserver as typeof Worker;syncBuiltinESMExports();
 let pending:Promise<unknown>|undefined;
 try{
  pending=layer==='owner'?refreshMirrorPolicyOffThread(policy(),path,limits,abort.signal):submitNativeMirrorPolicy(path,limits,abort.signal);void pending.then(()=>settled=true,()=>settled=true);
  if(layer==='owner')assert.equal(await rejection(pending),reason);
  else{
   const result=await pending;
   if(store==='complete')assert.deepEqual(result,{ok:true,ids:[7n,8n,9n]});
   else{assert.equal((result as {ok:unknown}).ok,false);assert.equal(typeof (result as {detail:unknown}).detail,'string');}
  }
  assert.equal(constructed,1);assert.equal(abort.signal.reason,reason);
  assert.deepEqual(observed,[{exitCode:0,background:0,settled:false}]);
  assert.equal(takeNativeMirrorPolicyTransportRefusal(pending,reason),false);
  if(layer==='owner')assert.equal(takeMirrorPolicyCapacityRefusal(pending as Promise<InteractionAccessPolicy>,reason),false);
  assert.equal(ownedWorkerUsage().Background,0);
 }finally{workerThreads.Worker=Original;syncBuiltinESMExports();await pending?.catch(()=>{});}
 // Missing-store read failure is raw ok:false, so the post-success abort wins.
 // Without that abort, the same actual missing read remains a policy error.
 if(store==='missing'){await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,limits),NativeMirrorPolicyError);assert.equal(existsSync(path),false);}
}));

test('transport waits its captured original join rather than a later real worker occupying the shared local slot',async()=>storeFixture(async path=>{
 initialize(path);const Original=Worker;let constructed=0,secondExited=false;
 let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;
 class ExitObserver extends Original{
  constructor(filename:string|URL,options?:WorkerOptions){
   super(filename,options);
   if(filename instanceof URL&&filename.pathname.endsWith('/mirror-policy-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts'))){
    constructed++;
    if(constructed===1)this.once('exit',()=>queueMicrotask(()=>{second=submitNativeMirrorPolicy(path,limits);void second.catch(()=>{});}));
    else this.once('exit',()=>{secondExited=true;});
   }
  }
 }
 workerThreads.Worker=ExitObserver as typeof Worker;syncBuiltinESMExports();
 try{
  first=submitNativeMirrorPolicy(path,limits);assert.deepEqual(await first,{ok:true,ids:[7n,8n,9n]});
  assert.equal(constructed,2);assert.ok(second);assert.equal(secondExited,false);assert.equal(ownedWorkerUsage().Background,1);
  assert.deepEqual(await second,{ok:true,ids:[7n,8n,9n]});assert.equal(secondExited,true);assert.equal(ownedWorkerUsage().Background,0);
 }finally{workerThreads.Worker=Original;syncBuiltinESMExports();await first?.catch(()=>{});await second?.catch(()=>{});}
}));
