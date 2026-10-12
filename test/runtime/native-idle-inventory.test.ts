import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {NativeIdleInventoryReader} from '../../src/runtime/completion/native-idle-inventory.ts';import {CompletionIdleRelease} from '../../src/runtime/completion/idle-release.ts';import {QueueStartCoordinator,type QueueStartBackend} from '../../src/runtime/queue-runner/start-coordinator.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';import {storeFixture} from '../helpers/store-fixture.ts';
const OWNER='00000000-0000-4000-8000-000000000001' as const;
const backend:QueueStartBackend={generation:()=>1n,residentInstanceId:()=>OWNER,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{throw Error('unexpected start');}};
async function insert(path:string,thread:string,status='Candidate',owner:string=OWNER,generation=1n){const db=await openInitialized(path);try{db.prepare("INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail) VALUES(?,?,?,?, 'turn','job',1,?,'prior')").run('i-'+thread,owner,generation,thread,status);}finally{db.close();}}
test('native pending preserves signed negative generations, foreign rows and opaque states before parent admission filter',async()=>storeFixture(async path=>{
 for(const [t,s,o,g] of [['a','Candidate',OWNER,1n],['b','AwaitUnload',OWNER,1n],['c','Unknown',OWNER,1n],['d','Candidate','foreign',1n],['e','Candidate',OWNER,-1n],['f','Settled',OWNER,1n]] as const)await insert(path,t,s,o,g);
 const reader=new NativeIdleInventoryReader(path),queue=new QueueStartCoordinator(path,backend),seen:string[]=[],errors:unknown[]=[],worker=new CompletionIdleRelease({instanceId:OWNER,generation:()=>1n,releaseIdleSubscription:async t=>{seen.push(t.threadId);}},queue,()=> 'safe',e=>{errors.push(e);},reader);
 try{const actual=await reader.pending();assert.deepEqual(actual,await state.pendingIdleIntents(path));assert.equal(actual.at(-1)!.generation,-1n);assert.equal(await reader.get('missing'),null);assert.deepEqual(await reader.get('a'),await state.getIdleIntent(path,'a'));await worker.scanOnce();assert.deepEqual(seen,['a','b']);assert.deepEqual(errors,[]);assert.equal(queue.locks.activeTargetCount,0);}finally{await reader.close();}
}));
test('native inventory keeps exact first128 order and does not decode excluded129th malformed row',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{const q=db.prepare("INSERT INTO cdr_idle_release VALUES(?,?,?,?, 'turn','job',1,'Candidate','prior')");for(let i=0;i<129;i++){const t=String(i).padStart(3,'0');q.run('i'+t,OWNER,1n,t);}db.exec("UPDATE cdr_idle_release SET detail=CAST(x'ff' AS TEXT) WHERE thread_id='128'");}finally{db.close();}
 const reader=new NativeIdleInventoryReader(path);try{const rows=await reader.pending();assert.equal(rows.length,128);assert.equal(rows[0]!.threadId,'000');assert.equal(rows.at(-1)!.threadId,'127');await assert.rejects(reader.get('128'),/unavailable/);}finally{await reader.close();}
}));
test('malformed foreign row within limit fails whole scan rather than being filtered before decode',async()=>storeFixture(async path=>{
 await insert(path,'foreign','Unknown','other',-1n);const db=await openInitialized(path);db.exec("UPDATE cdr_idle_release SET detail=CAST(x'ff' AS TEXT)");db.close();const reader=new NativeIdleInventoryReader(path);try{await assert.rejects(reader.pending(),/unavailable/);}finally{await reader.close();}
}));
test('busy target skips immediately and original diagnostic CAS retains same target lease across native get',async()=>storeFixture(async path=>{
 await insert(path,'a');await insert(path,'b');const reader=new NativeIdleInventoryReader(path),queue=new QueueStartCoordinator(path,backend),seen:string[]=[],errors:unknown[]=[],lease=queue.locks.tryAcquire('a')!;
 const worker=new CompletionIdleRelease({instanceId:OWNER,generation:()=>1n,releaseIdleSubscription:async token=>{seen.push(token.threadId);assert.equal(queue.locks.activeTargetCount,2);throw Error('early refusal');}},queue,()=> 'safe diagnostic',e=>{errors.push(e);},reader);
 try{await worker.scanOnce();assert.deepEqual(seen,['b']);assert.equal(queue.locks.activeTargetCount,1);const b=await reader.get('b');assert.deepEqual([b!.state,b!.detail,b!.revision],['Candidate','safe diagnostic',2n]);assert.equal((await reader.get('a'))!.revision,1n);assert.equal(errors.length,1);}finally{lease.release();await reader.close();}
}));
test('native current-row recheck cannot overwrite intent advanced during accepted release',async()=>storeFixture(async path=>{
 await insert(path,'a');const reader=new NativeIdleInventoryReader(path),queue=new QueueStartCoordinator(path,backend),errors:unknown[]=[];const worker=new CompletionIdleRelease({instanceId:OWNER,generation:()=>1n,releaseIdleSubscription:async token=>{await state.transitionIdleIntent(path,{...token},'Dispatching','already accepted');throw Error('unknown effect');}},queue,()=> 'must not overwrite',e=>{errors.push(e);},reader);
 try{await worker.scanOnce();const row=await reader.get('a');assert.deepEqual([row!.state,row!.detail,row!.revision],['Dispatching','already accepted',2n]);assert.equal(errors.length,1);assert.equal(queue.locks.activeTargetCount,0);}finally{await reader.close();}
}));
test('native inventory preabort/missing/closed failures never initialize a database',async()=>storeFixture(async path=>{
 const reader=new NativeIdleInventoryReader(path),c=new AbortController(),reason=Error('stop');c.abort(reason);assert.throws(()=>reader.pending(c.signal),e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(reader.pending());assert.equal(existsSync(path),false);await reader.close();assert.throws(()=>reader.pending(),/unavailable/);
}));
test('cancellation while scan is pending acquires no target lease and sends no managed release',async()=>storeFixture(async path=>{
 let entered!:()=>void,finish!:(v:any)=>void;const began=new Promise<void>(r=>entered=r),c=new AbortController(),reason=Error('scan cancelled'),queue=new QueueStartCoordinator(path,backend);let sent=0;
 const worker=new CompletionIdleRelease({instanceId:OWNER,generation:()=>1n,releaseIdleSubscription:async()=>{sent++;}},queue,()=> 'safe',()=>{}, {pending:async()=>{entered();return new Promise(r=>finish=r);},get:async()=>{throw Error('no diagnostic');}});
 const task=worker.scanOnce(c.signal);await began;c.abort(reason);finish([{intentId:'i',ownerId:OWNER,generation:1n,threadId:'a',turnId:'turn',jobId:'job',revision:1n,state:'Candidate',detail:''}]);await assert.rejects(task,e=>e===reason);assert.equal(sent,0);assert.equal(queue.locks.activeTargetCount,0);assert.equal(existsSync(path),false);
}));
