import {randomUUID} from 'node:crypto';
import {captureStandardClaimIdentity,standardClaimBinding} from '../../src/runtime/component-worker/standard-claim-snapshot.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {getEnvironmentData,setEnvironmentData} from 'node:worker_threads';
import {OwnedWorkerSlot,OwnedWorkerTimeoutError,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {StoreAuthorityDomain} from '../../src/store/store-authority-domain.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {NativeObservationLedgerOwner} from '../../src/runtime/native-observation-ledger.ts';
import {storeFixture} from '../helpers/store-fixture.ts';import {instrumentStoreWorker,waitTrace,releaseTrace} from '../helpers/store-authority-worker-fixture.ts';
const inventory=new URL('../../src/runtime/completion/native-idle-inventory-worker.ts',import.meta.url),input=(path:string)=>({path,operation:'Pending'});
const extension=import.meta.url.endsWith('.js')?'.js':'.ts';

test('ACK-stalled worker retains original writer until native exit while timers and main writes progress',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),owner={},r=domain.reserveInert(owner)!,trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-idle-inventory-worker'+extension,trace}),slot=new OwnedWorkerSlot('Control');
 let ticks=0;const timer=setInterval(()=>ticks++,5),pending=slot.run(inventory,input(path),10000);
 try{assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.assertInertCurrent(r,owner));await waitTrace(trace);let settled=false;void pending.then(()=>{settled=true;});await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal(domain.snapshot().writers,1);assert.ok(ticks>0);assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);
  const main=await openInitialized(path);assert.equal(domain.snapshot().writers,2);main.close();assert.equal(domain.snapshot().writers,1);
 }finally{releaseTrace(trace);restore();clearInterval(timer);await pending;await slot.join();domain.closeAfterOwnersJoined();}
}));

test('queued Control completion registers and revokes before FIFO wait; pre-spawn abort releases just that ticket',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-idle-inventory-worker'+extension,trace}),first=new OwnedWorkerSlot('Control'),second=new OwnedWorkerSlot('Control'),controller=new AbortController(),sentinel={cancel:true};
 const p=first.run(inventory,input(path+'.other'),10000);await waitTrace(trace);
 const owner={},reservation=domain.reserveInert(owner)!;domain.assertInertCurrent(reservation,owner);
 const before=domain.snapshot().revision,q=second.runControlCompletion(inventory,input(path),10000,controller.signal);assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.assertInertCurrent(reservation,owner));assert.equal(domain.snapshot().revision,before+1n);assert.equal(ownedWorkerUsage().Control,1);
 try{controller.abort(sentinel);await assert.rejects(q,e=>e===sentinel);await second.join();assert.equal(domain.snapshot().writers,0);assert.throws(()=>domain.assertInertCurrent(reservation,owner));assert.equal(ownedWorkerUsage().Control,1);}finally{releaseTrace(trace);restore();await p;await first.join();domain.closeAfterOwnersJoined();}
}));

test('queued timeout and clone failure release exactly once without restoring revoked reservation',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-idle-inventory-worker'+extension,trace}),first=new OwnedWorkerSlot('Control'),second=new OwnedWorkerSlot('Control');
 const p=first.run(inventory,input(path),10000);await waitTrace(trace);
 try{await assert.rejects(second.runControlCompletion(inventory,input(path),20),OwnedWorkerTimeoutError);await second.join();assert.equal(domain.snapshot().writers,1);}finally{releaseTrace(trace);restore();await p;await first.join();}
 const owner={},r=domain.reserveInert(owner)!;
 try{assert.throws(()=>second.run(inventory,{...input(path),bad:()=>{}},10000));assert.equal(domain.snapshot().writers,0);assert.throws(()=>domain.assertInertCurrent(r,owner));await assert.rejects(second.runControlCompletion(inventory,{...input(path),bad:()=>{}},10000));await second.join();assert.equal(domain.snapshot().writers,0);}finally{domain.closeAfterOwnersJoined();}
}));

for(const mode of ['abort','timeout','drop','duplicate','crash'] as const)test(`${mode} never releases a submitted writer before actual exit`,async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-idle-inventory-worker'+extension,trace,...(mode==='drop'||mode==='duplicate'?{ack:mode}:{}),...(mode==='crash'?{after:"Atomics.wait(trace,1,0,15000);throw new Error('fixture crash');"}:{})}),slot=new OwnedWorkerSlot('Observation'),c=new AbortController(),sentinel={abort:true};
 const pending=slot.run(inventory,input(path),mode==='timeout'?100:10000,c.signal),observed=pending.catch(e=>e);
 try{await waitTrace(trace);if(mode==='abort')c.abort(sentinel);if(mode==='abort'||mode==='timeout'){const error=await observed;assert.ok(mode==='abort'?error===sentinel:error instanceof OwnedWorkerTimeoutError);}assert.equal(domain.snapshot().writers,1);assert.equal(slot.busy,true);assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);
 }finally{releaseTrace(trace);restore();await observed;await slot.join();assert.equal(domain.snapshot().writers,0);domain.closeAfterOwnersJoined();}
 if(mode==='drop'||mode==='duplicate'||mode==='crash')assert.ok(await observed instanceof Error);
}));

test('real Observation and Background preparation writers and Control completions progress without an authority queue',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),owner=new NativeObservationLedgerOwner(path),control=new OwnedWorkerSlot('Control'),original={},r=domain.reserveInert(original)!;
 try{
  const a=owner.activate({ownerId:'fixture-a',generation:1n}),b=owner.activate({ownerId:'fixture-b',generation:1n}),c=owner.prepareQuestions('runtime',1n),d=control.runControlCompletion(inventory,input(path),10000);
  assert.equal(domain.snapshot().writers,4);assert.throws(()=>domain.assertInertCurrent(r,original));assert.equal(ownedWorkerUsage().Observation,2);assert.equal(ownedWorkerUsage().Background,1);await Promise.all([a,b,c,d]);await control.join();assert.equal(domain.snapshot().writers,0);
 }finally{await owner.close();await control.join();domain.closeAfterOwnersJoined();}
}));

test('unknown URLs, passive path violations and cross-store worker opens fail closed only when enrolled',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),slot=new OwnedWorkerSlot('Control');let getters=0;
 try{
  assert.throws(()=>slot.run(new URL('data:text/javascript,'),{},1000),/Unknown native/);assert.throws(()=>slot.run(inventory,Object.defineProperty({},'path',{get(){getters++;return path;}}),1000));assert.equal(getters,0);assert.equal(domain.snapshot().writers,0);
  const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-idle-inventory-worker'+extension,trace,before:`const {workerData}=await import('node:worker_threads');workerData.path+= '.foreign';`,after:''});
  try{const result=await slot.run(inventory,input(path),10000);assert.deepEqual(result,{ok:false});await slot.join();assert.equal(domain.snapshot().writers,0);}finally{restore();releaseTrace(trace);}
 }finally{domain.closeAfterOwnersJoined();}
 assert.equal(await slot.run(new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';parentPort.postMessage('compat');")),null,10000),'compat');
}));

test('side channel is restored after construction failure and exact-key business inputs stay unchanged',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),slot=new OwnedWorkerSlot('Control'),key='codex-discord-bridge:store-accounting:v1',original={outside:true};setEnvironmentData(key,original);
 try{const data={...input(path),bad:()=>{}};assert.throws(()=>slot.run(inventory,data,10000));assert.equal(getEnvironmentData(key),original);assert.deepEqual(Object.keys(data),['path','operation','bad']);}finally{setEnvironmentData(key,undefined);domain.closeAfterOwnersJoined();}
}));

test('completion FIFO pins executable before awaiting even if the caller mutates its URL',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-idle-inventory-worker'+extension,trace}),first=new OwnedWorkerSlot('Control'),second=new OwnedWorkerSlot('Control');
 const p=first.run(inventory,input(path),10000);await waitTrace(trace);const mutable=new URL(inventory.href),q=second.runControlCompletion(mutable,input(path),10000);mutable.pathname='/unreviewed-unknown-worker.js';
 try{releaseTrace(trace);assert.deepEqual(await p,{ok:true,value:[]});assert.deepEqual(await q,{ok:true,value:[]});assert.equal(domain.snapshot().writers,0);}finally{releaseTrace(trace);restore();await Promise.allSettled([p,q]);await Promise.all([first.join(),second.join()]);domain.closeAfterOwnersJoined();}
}));

test('enrolled exact-key standard claim worker receives unchanged business fields and actually commits',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),slot=new OwnedWorkerSlot('Control'),identity=captureStandardClaimIdentity({interactionIngressId:'interaction:3',interactionId:3n,applicationId:4n,actorId:2n,channelId:1n,sourceMessageId:9n,customId:`codex_approval:v2:${'a'.repeat(16)}:${'b'.repeat(32)}:1`}),data=standardClaimBinding(randomUUID(),path,'Claim',identity,100),keys=Object.keys(data);
 try{const reply=await slot.run(new URL('../../src/runtime/component-worker/standard-claim-native-worker.ts',import.meta.url),data,10000) as any;assert.equal(reply.ok,true);assert.equal(reply.value,'ExecuteAction');assert.deepEqual(Object.keys(data),keys);assert.equal(domain.snapshot().writers,0);}finally{await slot.join();domain.closeAfterOwnersJoined();}
}));
