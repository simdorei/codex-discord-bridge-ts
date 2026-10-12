import test from 'node:test';import {setImmediate as tick} from 'node:timers/promises';import assert from 'node:assert/strict';
import {OwnedWorkerSlot,ownedWorkerModuleUrl,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {NativeTypingInventoryReader} from '../../src/runtime/completion/native-typing.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {storeFixture} from '../helpers/store-fixture.ts';
test('actual native typing reads whole queue then terminal journal on distinct closed-between connections',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const shared=new SharedArrayBuffer(4),a=new Int32Array(shared),run=OwnedWorkerSlot.prototype.runMaintenanceRead;
 OwnedWorkerSlot.prototype.runMaintenanceRead=function(url,data,timeout,signal){if(!url.pathname.endsWith('/native-typing-worker.ts'))return run.call(this,url,data,timeout,signal);const module=ownedWorkerModuleUrl(url,import.meta.url).href;
  const source=`import {workerData} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';const a=new Int32Array(workerData.trace);delete workerData.trace;let queue;const closed=new WeakSet(),prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close;DatabaseSync.prototype.close=function(){const r=close.call(this);closed.add(this);return r;};DatabaseSync.prototype.prepare=function(sql){if(sql.includes(' FROM codex_turn_queue ORDER BY created_at, job_id')){queue=this;Atomics.store(a,0,1);}if(sql.includes(' FROM codex_observed_completions ORDER BY rowid')){if(!queue||queue===this||!closed.has(queue))throw Error('incorrect read lifetime/order');Atomics.store(a,0,2);}return prepare.call(this,sql);};await import(${JSON.stringify(module)});`;
  return run.call(this,new URL('data:text/javascript,'+encodeURIComponent(source)),{...(data as object),trace:shared},timeout,signal);
 };
 const owner=new NativeTypingInventoryReader(path);try{assert.deepEqual(await owner.read(),{jobs:[],terminals:[]});assert.equal(Atomics.load(a,0),2);}finally{OwnedWorkerSlot.prototype.runMaintenanceRead=run;await owner.close();}
}));
test('oversize, invalid i64 and accessor-bearing worker replies fail without partial inventory',async()=>storeFixture(async path=>{
 const run=OwnedWorkerSlot.prototype.runMaintenanceRead,owner=new NativeTypingInventoryReader(path);let called=0;
 try{const hostile=Object.defineProperty({},'jobs',{enumerable:true,get(){called++;return [];}});
  for(const raw of [{ok:true,jobs:[],terminals:[],padding:'x'.repeat(16*1024*1024)},{ok:true,jobs:[{targetThreadId:'a',turnId:null,state:'Pending',goalWaiting:false,channelId:1n<<63n}],terminals:[]},hostile]){OwnedWorkerSlot.prototype.runMaintenanceRead=async()=>raw;await assert.rejects(owner.read());assert.equal(owner.active,0);}assert.equal(called,0);
 }finally{OwnedWorkerSlot.prototype.runMaintenanceRead=run;await owner.close();}
}));
test('typing abort keeps ownership through actual worker exit and never returns a late snapshot',async()=>storeFixture(async path=>{
 const run=OwnedWorkerSlot.prototype.runMaintenanceRead,shared=new SharedArrayBuffer(8),a=new Int32Array(shared),c=new AbortController(),reason=Error('stop typing');
 const blocked=new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort,workerData} from 'node:worker_threads';const a=new Int32Array(workerData);Atomics.store(a,1,1);Atomics.wait(a,0,0,5000);parentPort.postMessage({ok:true,jobs:[],terminals:[]});parentPort.close();`));
 OwnedWorkerSlot.prototype.runMaintenanceRead=function(url,data,timeout,signal){return run.call(this,blocked,shared,timeout,signal);};const owner=new NativeTypingInventoryReader(path);let settled=false;const task=owner.read(c.signal).then(()=>({error:null}),error=>({error})).then(r=>{settled=true;return r;});
 try{const deadline=performance.now()+3000;while(Atomics.load(a,1)===0){assert.ok(performance.now()<deadline,'native worker entry');await tick();}c.abort(reason);for(let i=0;i<12;i++)await Promise.resolve();assert.equal(settled,false);assert.equal(owner.active,1);assert.equal(ownedWorkerUsage().Maintenance,1);assert.throws(()=>owner.read(),/still running/);}finally{Atomics.store(a,0,1);Atomics.notify(a,0);const result=await task;assert.equal(result.error,reason);await owner.close();OwnedWorkerSlot.prototype.runMaintenanceRead=run;}assert.equal(ownedWorkerUsage().Maintenance,0);
}));
