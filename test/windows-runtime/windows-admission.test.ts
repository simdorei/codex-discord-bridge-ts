import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedWorkerSlot,OwnedWorkerTimeoutError,OwnedWorkerBudgetError,OWNED_CONTROL_ADMISSION_QUEUE_LIMIT,ownedWorkerUsage,withOwnedWorkerBackpressure,takeOwnedWorkerAdmissionRefusal} from '../../src/runtime/owned-worker-slot.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {NativeIdleBeforeOwner} from '../../src/runtime/native-idle-before.ts';
const module=(code:string)=>new URL('data:text/javascript,'+encodeURIComponent(code));
const blocked=module("import {parentPort,workerData} from 'node:worker_threads';const a=new Int32Array(workerData);Atomics.store(a,1,1);Atomics.wait(a,0,0,5000);parentPort.postMessage('release');parentPort.close();");
const finished=module("import {parentPort,workerData} from 'node:worker_threads';parentPort.postMessage(workerData);parentPort.close();");
async function fixture(run:(shared:Int32Array)=>Promise<void>){const slot=new OwnedWorkerSlot('Control'),shared=new Int32Array(new SharedArrayBuffer(8)),work=slot.run(blocked,shared.buffer,6000);try{const until=performance.now()+3000;while(Atomics.load(shared,1)!==1){assert.ok(performance.now()<until);await delay(5);}await run(shared);}finally{Atomics.store(shared,0,1);Atomics.notify(shared,0);await work;await slot.join();}}
test('bounded ingress capacity waits once, preserves completion priority and joins actual workers',()=>fixture(async shared=>{
 const first=new OwnedWorkerSlot('Control'),second=new OwnedWorkerSlot('Control'),completion=new OwnedWorkerSlot('Control'),order:string[]=[];
 const a=first.runControlAdmission(finished,'admission-1',3000).then(v=>{order.push(String(v));}),b=second.runControlAdmission(finished,'admission-2',3000).then(v=>{order.push(String(v));}),c=completion.runControlCompletion(finished,'completion',3000).then(v=>{order.push(String(v));});
 await delay(30);assert.deepEqual(order,[]);assert.equal(ownedWorkerUsage().Control,1);Atomics.store(shared,0,1);Atomics.notify(shared,0);await Promise.all([a,b,c]);await Promise.all([first.join(),second.join(),completion.join()]);assert.deepEqual(order,['completion','admission-1','admission-2']);assert.equal(ownedWorkerUsage().Control,0);
}));
test('unstarted ingress deadline and overflow neither submit nor consume capacity',()=>fixture(async()=>{
 const expired=new OwnedWorkerSlot('Control');await assert.rejects(expired.runControlAdmission(finished,'must-not-run',20),OwnedWorkerTimeoutError);await expired.join();assert.equal(expired.busy,false);
 const cancel=new AbortController(),slots=Array.from({length:OWNED_CONTROL_ADMISSION_QUEUE_LIMIT},()=>new OwnedWorkerSlot('Control'));
 const pending=slots.map(slot=>assert.rejects(slot.runControlAdmission(finished,'must-not-run',3000,cancel.signal)));
 const overflow=new OwnedWorkerSlot('Control');await assert.rejects(overflow.runControlAdmission(finished,'overflow',3000),OwnedWorkerBudgetError);cancel.abort(new Error('cancel before worker'));await Promise.all(pending);await Promise.all(slots.map(slot=>slot.join()));await overflow.join();assert.equal(ownedWorkerUsage().Control,1);
}));
test('installed runtime backpressure includes preexisting owners while default adapters still refuse',()=>fixture(async shared=>{
 const outside=new OwnedWorkerSlot('Control'),ordinary=new OwnedWorkerSlot('Control');
 const refusal=ordinary.run(finished,'not-submitted',3000);let error:unknown;try{await refusal;}catch(e){error=e;}assert.ok(error instanceof OwnedWorkerBudgetError);assert.equal(takeOwnedWorkerAdmissionRefusal(ordinary,refusal,error),true);assert.equal(takeOwnedWorkerAdmissionRefusal(ordinary,refusal,error),false);
 const order:string[]=[];const queued=withOwnedWorkerBackpressure(()=>outside.run(finished,'once',3000)).then(v=>{order.push(String(v));});await delay(20);assert.deepEqual(order,[]);assert.equal(ownedWorkerUsage().Control,1);Atomics.store(shared,0,1);Atomics.notify(shared,0);await queued;await outside.join();assert.deepEqual(order,['once']);
}));
test('installed idle checks isolate thread custody while sharing one native control slot',()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const owner=new NativeIdleBeforeOwner(path,()=> 'fixture',5000,true);
 try{await owner.validateInstallation();const first=owner.before('resident',1n,'first'),second=owner.before('resident',1n,'second');assert.throws(()=>owner.before('resident',1n,'first'),/still running/);assert.ok(ownedWorkerUsage().Control<=1);assert.deepEqual(await Promise.all([first,second]),[null,null]);assert.equal(owner.busy,false);}
 finally{await owner.close();}
}));
