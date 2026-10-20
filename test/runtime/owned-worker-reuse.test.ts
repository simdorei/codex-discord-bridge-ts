import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {getEnvironmentData,setEnvironmentData} from 'node:worker_threads';
import {storeFixture} from '../helpers/store-fixture.ts';
import {instrumentStoreWorker,releaseTrace,waitTrace} from '../helpers/store-authority-worker-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {StoreAuthorityDomain} from '../../src/store/store-authority-domain.ts';
import {serializeStopControl} from '../../src/store/stop-control-dispatch.ts';
import {NativeStopPendingReader} from '../../src/runtime/action-executor/stop-pending-native.ts';
import {OwnedWorkerSlot,OwnedWorkerTimeoutError,ownedWorkerUsage,ownedWorkerReuseStats,withOwnedWorkerBackpressure,withOwnedWorkerReuse,closeOwnedWorkerPool} from '../../src/runtime/owned-worker-slot.ts';
import {REUSABLE_WORKER_ENV} from '../../src/runtime/reusable-worker-entry.ts';

const stopUrl=new URL('../../src/runtime/action-executor/stop-pending-native-worker.ts',import.meta.url);
const inventoryUrl=new URL('../../src/runtime/completion/native-idle-inventory-worker.ts',import.meta.url);
const input=(path:string)=>({id:'fixture',path,operation:'Pending',after:0n});
const extension=import.meta.url.endsWith('.js')?'.js':'.ts';
const empty={Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0};
const pooled=<T>(run:()=>Promise<T>)=>withOwnedWorkerReuse(()=>withOwnedWorkerBackpressure(async()=>{try{return await run();}finally{await closeOwnedWorkerPool();assert.deepEqual(ownedWorkerUsage(),empty);}}));

test('periodic Stop reads reuse one actual worker but observe new database rows and fresh cursor input',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  const reader=new NativeStopPendingReader(path);
  for(let i=0;i<30;i++)assert.deepEqual(await reader.pending(0n),[]);
  assert.deepEqual(ownedWorkerReuseStats(),{started:1,reused:29,live:1});
  const db=await openInitialized(path);
  try{db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('fixture','T','R',1,'V',?,'accepted')").run(serializeStopControl({operation_id:'fixture',target:'T',channel:9223372036854775807n,owner:3n,resident:'R',generation:1n,turn:'V',binding:{target:'T'},jobs:[],can_settle:true}));}finally{db.close();}
  const rows=await reader.pending(0n);assert.equal(rows.length,1);assert.equal(rows[0]![1].channel,9223372036854775807n);
  assert.deepEqual(await reader.pending(rows[0]![0]),[]);assert.equal(ownedWorkerReuseStats().started,1);
 });
}));

test('idle workers retain the physical lane and store registration until eviction or pool shutdown',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path);
 try{await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Maintenance');
  assert.equal((await slot.runMaintenanceRead(stopUrl,input(path),5000) as {ok:boolean}).ok,true);
  assert.equal(slot.busy,false);assert.equal(ownedWorkerUsage().Maintenance,1);assert.equal(domain.snapshot().writers,1);
  assert.equal(domain.reserveInert({}),null);
  assert.deepEqual(await slot.runMaintenanceRead(inventoryUrl,{path,operation:'Pending'},5000),{ok:true,value:[]});
  assert.equal(ownedWorkerUsage().Maintenance,1);assert.equal(domain.snapshot().writers,1);assert.equal(ownedWorkerReuseStats().started,1);assert.equal(ownedWorkerReuseStats().reused,1);
  const readonly=new URL('../../src/runtime/discord-runtime/history-target-worker.ts',import.meta.url);
  await slot.runMaintenanceRead(readonly,{path,allowed:[],startup:null,maxRows:16},5000);
  assert.equal(domain.snapshot().writers,0);assert.equal(ownedWorkerReuseStats().started,2);
  assert.equal((await slot.runMaintenanceRead(stopUrl,input(path),5000) as {ok:boolean}).ok,true);
  assert.equal(ownedWorkerReuseStats().started,3);assert.equal(domain.snapshot().writers,1);
 });assert.equal(domain.snapshot().writers,0);}finally{domain.closeAfterOwnersJoined();}
}));

test('abort of active pooled native work retains lane and writer until actual exit and is never replayed',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),trace=new SharedArrayBuffer(8);
 const restore=instrumentStoreWorker({match:'reusable-store-worker'+extension,trace,before:'Atomics.store(trace,0,1);Atomics.wait(trace,1,0,15000);',after:''});
 try{await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Maintenance'),abort=new AbortController(),reason=new Error('cancel active read');
  const pending=slot.runMaintenanceRead(stopUrl,input(path),5000,abort.signal);let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
  try{
   await waitTrace(trace);abort.abort(reason);await delay(25);
   assert.equal(slot.busy,true);assert.equal(settled,false);assert.equal(domain.snapshot().writers,1);assert.equal(ownedWorkerUsage().Maintenance,1);assert.equal(ownedWorkerReuseStats().started,1);
  }finally{releaseTrace(trace);}
  await assert.rejects(pending,error=>error===reason);await slot.join();assert.equal(domain.snapshot().writers,0);assert.equal(ownedWorkerUsage().Maintenance,0);
  assert.equal((await slot.runMaintenanceRead(stopUrl,input(path),5000) as {ok:boolean}).ok,true);assert.equal(ownedWorkerReuseStats().started,2);
 });}finally{releaseTrace(trace);restore();domain.closeAfterOwnersJoined();}
}));

test('timeout retires a pooled worker and a cancelled queued request never starts a native operation',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'reusable-store-worker'+extension,trace,before:'Atomics.store(trace,0,1);Atomics.wait(trace,1,0,15000);',after:''});
 try{await pooled(async()=>{
  const first=new OwnedWorkerSlot('Maintenance'),second=new OwnedWorkerSlot('Maintenance'),abort=new AbortController(),reason=new Error('cancel queued');
  const pending=first.runMaintenanceRead(stopUrl,input(path),300);void pending.catch(()=>{});
  try{
   await waitTrace(trace);
   const queued=second.runMaintenanceRead(stopUrl,input(path),5000,abort.signal);abort.abort(reason);await assert.rejects(queued,error=>error===reason);
   await delay(350);assert.equal(first.busy,true);assert.equal(ownedWorkerUsage().Maintenance,1);assert.equal(ownedWorkerReuseStats().started,1);
  }finally{releaseTrace(trace);}
  await assert.rejects(pending,OwnedWorkerTimeoutError);await first.join();assert.equal(ownedWorkerUsage().Maintenance,0);
 });}finally{releaseTrace(trace);restore();}
}));

test('pool shutdown joins idle workers and later cleanup requests retain one-shot behavior',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Maintenance');await slot.runMaintenanceRead(stopUrl,input(path),5000);
  await closeOwnedWorkerPool();assert.deepEqual(ownedWorkerUsage(),empty);assert.equal(ownedWorkerReuseStats().live,0);
  await slot.runMaintenanceRead(stopUrl,input(path),5000);assert.deepEqual(ownedWorkerUsage(),empty);assert.equal(ownedWorkerReuseStats().started,1);
 });
}));

test('structured-clone failures restore worker environment and release unsubmitted registrations',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),prior=getEnvironmentData(REUSABLE_WORKER_ENV),sentinel={outside:true};
 setEnvironmentData(REUSABLE_WORKER_ENV,sentinel);
 try{await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Maintenance');
  await assert.rejects(slot.runMaintenanceRead(stopUrl,{...input(path),bad:()=>{}},5000));
  assert.deepEqual(ownedWorkerUsage(),empty);assert.equal(domain.snapshot().writers,0);assert.equal(getEnvironmentData(REUSABLE_WORKER_ENV),sentinel);
  await slot.runMaintenanceRead(stopUrl,input(path),5000);
  await assert.rejects(slot.runMaintenanceRead(stopUrl,{...input(path),bad:()=>{}},5000));
  assert.equal(domain.snapshot().writers,0);assert.deepEqual(ownedWorkerUsage(),empty);
 });}finally{setEnvironmentData(REUSABLE_WORKER_ENV,prior);domain.closeAfterOwnersJoined();}
}));

test('a leaked writable connection prevents reusable acknowledgement and forces actual native exit',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),trace=new SharedArrayBuffer(8);
 const store=new URL('../../src/store/existing-store'+extension,import.meta.url).href;
 const restore=instrumentStoreWorker({match:'reusable-store-worker'+extension,trace,before:`const {openExisting}=await import(${JSON.stringify(store)});const {workerData}=await import('node:worker_threads');globalThis.leaked=openExisting(workerData.path);`,after:''});
 try{await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Maintenance');
  await assert.rejects(slot.runMaintenanceRead(stopUrl,input(path),5000),/retained an open store connection/);
  await slot.join();assert.equal(domain.snapshot().writers,0);assert.equal(ownedWorkerReuseStats().live,0);
 });}finally{restore();domain.closeAfterOwnersJoined();}
}));

test('three warm background workers yield actual capacity to an unrelated CPU request',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  await Promise.all(Array.from({length:3},()=>new OwnedWorkerSlot().run(stopUrl,input(path),5000)));
  assert.equal(ownedWorkerUsage().Background,3);
  const cpu=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';parentPort.postMessage('cpu result');parentPort.close();"));
  assert.equal(await new OwnedWorkerSlot().runCpu(cpu,null,5000),'cpu result');
  assert.equal(ownedWorkerUsage().Background,2);assert.equal(ownedWorkerReuseStats().live,2);
 });
}));

test('queued path mutation cannot repurpose a warm worker for a different store',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'reusable-store-worker'+extension,trace,before:'Atomics.store(trace,0,1);Atomics.wait(trace,1,0,15000);',after:''});
 try{await pooled(async()=>{
  const first=new OwnedWorkerSlot('Maintenance'),second=new OwnedWorkerSlot('Maintenance'),request=input(path);
  const running=first.runMaintenanceRead(stopUrl,input(path),5000);
  try{
   await waitTrace(trace);const queued=second.runMaintenanceRead(stopUrl,request,5000);request.path=path+'.different';releaseTrace(trace);
   await running;await assert.rejects(queued,/store binding changed/);await second.join();assert.equal(ownedWorkerReuseStats().started,1);
  }finally{releaseTrace(trace);await running;}
 });}finally{releaseTrace(trace);restore();}
}));

test('different read-only operation modules share one worker without retaining the previous input or result',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  const slot=new OwnedWorkerSlot(),history=new URL('../../src/discord/history-page-worker.ts',import.meta.url),mirror=new URL('../../src/runtime/session-mirror/store-discovery-worker.ts',import.meta.url);
  for(let i=0;i<5;i++){
   assert.deepEqual(await slot.run(history,new TextEncoder().encode('[]'),5000),{ok:true,value:[]});
   assert.deepEqual(await slot.run(mirror,{path,maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576},5000),{ok:true,targets:[],jobs:[]});
  }
  assert.deepEqual(ownedWorkerReuseStats(),{started:1,reused:9,live:1});
 });
}));

test('different scoped mirror store operations share their exact writable path and close every connection',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  const slot=new OwnedWorkerSlot(),cursor=new URL('../../src/runtime/session-mirror/cursor-store-worker.ts',import.meta.url),startup=new URL('../../src/runtime/session-mirror/startup-intent-store-worker.ts',import.meta.url);
  assert.deepEqual(await slot.run(cursor,{path,kind:'Schema'},5000),{ok:true,value:null});
  assert.deepEqual(await slot.run(startup,{path,kind:'Schema',cancel:new SharedArrayBuffer(4),timeoutMs:5000},5000),{ok:true,value:null});
  assert.deepEqual(await slot.run(cursor,{path,kind:'Read',thread:'T'},5000),{ok:true,value:null});
  assert.deepEqual(await slot.run(startup,{path,kind:'Read',thread:'T',cancel:new SharedArrayBuffer(4),timeoutMs:5000},5000),{ok:true,value:null});
  assert.deepEqual(ownedWorkerReuseStats(),{started:1,reused:3,live:1});
 });
}));
