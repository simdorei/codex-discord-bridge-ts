import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {OwnedWorkerSlot,ownedWorkerModuleUrl,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {NativeCompletionDiscoveryReader} from '../../src/runtime/completion/native-discovery.ts';
import {CompletionDiscovery} from '../../src/runtime/completion/scheduler/discovery.ts';
import {CompletionReady} from '../../src/runtime/completion/scheduler/ready.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';import {storeFixture} from '../helpers/store-fixture.ts';
test('DELETE journal main synchronous writer cannot strand an autonomous read snapshot waiting for parent',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode,'delete');db.close();
 const shared=new SharedArrayBuffer(12),a=new Int32Array(shared),run=OwnedWorkerSlot.prototype.run;
 const driver=ownedWorkerModuleUrl(new URL('../../src/store/owned-driver.ts',import.meta.url),import.meta.url).href;
 OwnedWorkerSlot.prototype.run=function(url,data,timeout,signal){
  if(!url.pathname.endsWith('/native-discovery-worker.ts'))return run.call(this,url,data,timeout,signal);
  const module=ownedWorkerModuleUrl(url,import.meta.url).href;
  const code=`import {workerData} from 'node:worker_threads';import {CheckedRead} from ${JSON.stringify(driver)};const a=new Int32Array(workerData.barrier);delete workerData.barrier;const open=CheckedRead.open,finish=CheckedRead.prototype.finish;CheckedRead.open=function(path){const r=open(path);Atomics.store(a,0,1);Atomics.notify(a,0);if(Atomics.wait(a,1,0,3000)==='timed-out'){r.close();throw Error('test barrier timed out');}return r;};CheckedRead.prototype.finish=function(){const r=finish.call(this);Atomics.store(a,2,1);return r;};await import(${JSON.stringify(module)});`;
  return run.call(this,new URL('data:text/javascript,'+encodeURIComponent(code)),{...(data as object),barrier:shared},timeout,signal);
 };
 const owner=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['Goal'],()=>0,owner),ready=new CompletionReady<null>(),writer=new DatabaseSync(path,{timeout:2000});let pending:Promise<unknown>|undefined;
 try{
  pending=d.readAsync('runtime',1n,ready,new Set());void pending.catch(()=>{});
  assert.notEqual(Atomics.wait(a,0,0,3000),'timed-out');assert.equal(Atomics.load(a,0),1);
  writer.exec("BEGIN IMMEDIATE; INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('concurrent','turn',1,'body','job')");
  Atomics.store(a,1,1);Atomics.notify(a,1);writer.exec('COMMIT');
  // finish ran in the worker even though this event loop was synchronously blocked.
  await pending;assert.equal(Atomics.load(a,2),1);assert.equal(ready.httpLength,0);
  d.wake();await d.readAsync('runtime',1n,ready,new Set());assert.equal(ready.httpLength,1);assert.equal(ready.httpSnapshot()[0]!.target,'concurrent');assert.equal(ownedWorkerUsage().Discovery,0);
 }finally{Atomics.store(a,1,1);Atomics.notify(a,1);if(writer.isTransaction)writer.exec('ROLLBACK');writer.close();await Promise.allSettled([pending]);await owner.close();ready.dispose();OwnedWorkerSlot.prototype.run=run;}
}));
