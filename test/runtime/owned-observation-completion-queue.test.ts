import test from 'node:test';import assert from 'node:assert/strict';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,OwnedWorkerTimeoutError,ownedWorkerUsage,OWNED_COMPLETION_QUEUE_LIMIT} from '../../src/runtime/owned-worker-slot.ts';
const worker=(s:string)=>new URL('data:text/javascript,'+encodeURIComponent(s));
const blocked=worker("import{parentPort,workerData}from'node:worker_threads';const a=new Int32Array(workerData);Atomics.store(a,1,1);Atomics.wait(a,0,0,10000);parentPort.postMessage('done');parentPort.close();");
const fresh=worker("import{parentPort,workerData}from'node:worker_threads';parentPort.postMessage(workerData);parentPort.close();");
function unlock(b:SharedArrayBuffer){const a=new Int32Array(b);Atomics.store(a,0,1);Atomics.notify(a,0);}
function blockers(){const memory=[new SharedArrayBuffer(8),new SharedArrayBuffer(8)],slots=memory.map(()=>new OwnedWorkerSlot('Observation')),tasks=slots.map((s,i)=>s.run(blocked,memory[i],8000));return{memory,slots,tasks,async close(){memory.forEach(unlock);await Promise.allSettled(tasks);await Promise.all(slots.map(s=>s.join()));}};}
test('original gap FIFO takes one released lane before new reads while independent Control stays usable',async()=>{
 const b=blockers(),a=new OwnedWorkerSlot('Observation'),z=new OwnedWorkerSlot('Observation'),order:unknown[]=[];
 const p=a.runObservationCompletion(fresh,'first',6000).then(v=>{order.push(v);}),q=z.runObservationCompletion(fresh,'second',6000).then(v=>{order.push(v);});
 try{assert.equal(ownedWorkerUsage().Observation,2);await assert.rejects(new OwnedWorkerSlot('Observation').run(fresh,null,1000),OwnedWorkerBudgetError);assert.equal(await new OwnedWorkerSlot('Control').run(fresh,'control',1000),'control');unlock(b.memory[0]!);await Promise.all([p,q]);assert.deepEqual(order,['first','second']);assert.equal(ownedWorkerUsage().Observation,1);}
 finally{await b.close();await Promise.allSettled([p,q]);await a.join();await z.join();}
});
test('gap queue has exactly128 waiting entries and cancellation removes only queued work',async()=>{
 const b=blockers(),c=new AbortController(),reason={cancel:true},slots=Array.from({length:OWNED_COMPLETION_QUEUE_LIMIT},()=>new OwnedWorkerSlot('Observation')),pending=slots.map(s=>s.runObservationCompletion(fresh,'never',6000,c.signal).catch(e=>e));
 try{await assert.rejects(new OwnedWorkerSlot('Observation').runObservationCompletion(fresh,null,6000),OwnedWorkerBudgetError);c.abort(reason);for(const e of await Promise.all(pending))assert.equal(e,reason);assert.equal(ownedWorkerUsage().Observation,2);assert.ok(slots.every(s=>!s.busy));}
 finally{c.abort(reason);await b.close();await Promise.allSettled(pending);await Promise.all(slots.map(s=>s.join()));}
});
test('gap deadline expires without submitting and slot is reusable after joined refusal',async()=>{
 const b=blockers(),s=new OwnedWorkerSlot('Observation');try{await assert.rejects(s.runObservationCompletion(fresh,null,20),OwnedWorkerTimeoutError);await s.join();assert.equal(s.busy,false);assert.equal(ownedWorkerUsage().Observation,2);await b.close();assert.equal(await s.runObservationCompletion(fresh,'new',1000),'new');}finally{await b.close();await s.join();}
});
test('accepted gap cancellation keeps ownership until actual native exit',async()=>{
 const s=new OwnedWorkerSlot('Observation'),b=new SharedArrayBuffer(8),c=new AbortController(),reason={cancel:true};const p=s.runObservationCompletion(blocked,b,6000,c.signal);const rejection=assert.rejects(p,e=>e===reason);let settled=false;void p.then(()=>{settled=true;},()=>{settled=true;});
 try{const end=Date.now()+4000;while(Atomics.load(new Int32Array(b),1)!==1){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}c.abort(reason);await new Promise(r=>setTimeout(r,25));assert.equal(settled,false);assert.equal(s.busy,true);assert.equal(ownedWorkerUsage().Observation,1);unlock(b);await rejection;await s.join();assert.equal(ownedWorkerUsage().Observation,0);}
 finally{unlock(b);await Promise.allSettled([p]);await s.join();}
});
test('gap queue rejects wrong lane and malformed deadlines before resource allocation',()=>{
 assert.throws(()=>new OwnedWorkerSlot('Control').runObservationCompletion(fresh,null,1000),/Observation/);for(const n of [0,-1,NaN,Infinity,2147483648])assert.throws(()=>new OwnedWorkerSlot('Observation').runObservationCompletion(fresh,null,n));assert.equal(ownedWorkerUsage().Observation,0);
});
