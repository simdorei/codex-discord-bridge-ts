import test from 'node:test';import assert from 'node:assert/strict';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage,OWNED_WORKER_LIMITS} from '../../src/runtime/owned-worker-slot.ts';
import {NativeObservationLedgerOwner} from '../../src/runtime/native-observation-ledger.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
const blocked=new URL('data:text/javascript,'+encodeURIComponent("import{parentPort,workerData}from'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,10000);parentPort.postMessage(true);parentPort.close();"));
const fresh=new URL('data:text/javascript,'+encodeURIComponent("import{parentPort}from'node:worker_threads';parentPort.postMessage(true);parentPort.close();"));
test('three occupied background readers cannot prevent owned observation or foreground control',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const owner=new NativeObservationLedgerOwner(path),memory=new SharedArrayBuffer(4),slots=Array.from({length:3},()=>new OwnedWorkerSlot('Background')),tasks=slots.map(s=>s.run(blocked,memory,10000));
 try{await owner.activate({ownerId:'owner',generation:1n});assert.equal(await owner.verified({ownerId:'owner',generation:1n},0n),true);assert.equal(await new OwnedWorkerSlot('Control').run(fresh,null,2000),true);assert.equal(ownedWorkerUsage().Background,3);assert.equal(ownedWorkerUsage().Observation,0);}
 finally{Atomics.store(new Int32Array(memory),0,1);Atomics.notify(new Int32Array(memory),0);await Promise.allSettled(tasks);await Promise.all(slots.map(s=>s.join()));await owner.close();}
}));
test('global observation capacity is exactly two and remains owned until native exit',async()=>{
 const memory=new SharedArrayBuffer(4),slots=[new OwnedWorkerSlot('Observation'),new OwnedWorkerSlot('Observation')],tasks=slots.map(s=>s.run(blocked,memory,10000));
 try{assert.equal(OWNED_WORKER_LIMITS.Observation,2);assert.equal(ownedWorkerUsage().Observation,2);await assert.rejects(new OwnedWorkerSlot('Observation').run(fresh,null,1000),OwnedWorkerBudgetError);assert.equal(await new OwnedWorkerSlot().run(fresh,null,2000),true);assert.equal(await new OwnedWorkerSlot('Control').run(fresh,null,2000),true);}
 finally{Atomics.store(new Int32Array(memory),0,1);Atomics.notify(new Int32Array(memory),0);await Promise.allSettled(tasks);await Promise.all(slots.map(s=>s.join()));}assert.equal(ownedWorkerUsage().Observation,0);
});

test('question maintenance refuses saturated Background before submission and can run after actual release',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const owner=new NativeObservationLedgerOwner(path),memory=new SharedArrayBuffer(4),slots=Array.from({length:3},()=>new OwnedWorkerSlot('Background')),tasks=slots.map(s=>s.run(blocked,memory,10000));
 for(const task of tasks)void task.catch(()=>{});
 try{
  assert.deepEqual(ownedWorkerUsage(),{Background:3,Control:0,Observation:0,Discovery:0,Maintenance:0});
  await assert.rejects(owner.prepareQuestions('owner',1n),e=>e instanceof OwnedWorkerBudgetError&&Object.getPrototypeOf(e)===OwnedWorkerBudgetError.prototype);
  assert.equal(owner.busy,false);assert.deepEqual(ownedWorkerUsage(),{Background:3,Control:0,Observation:0,Discovery:0,Maintenance:0});
  Atomics.store(new Int32Array(memory),0,1);Atomics.notify(new Int32Array(memory),0);assert.deepEqual(await Promise.all(tasks),[true,true,true]);await Promise.all(slots.map(s=>s.join()));
  assert.equal(await owner.prepareQuestions('owner',1n),undefined);assert.equal(owner.busy,false);
 }finally{Atomics.store(new Int32Array(memory),0,1);Atomics.notify(new Int32Array(memory),0);await Promise.allSettled(tasks);await Promise.all(slots.map(s=>s.join()));await owner.close();}
 assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Observation:0,Discovery:0,Maintenance:0});
}));
