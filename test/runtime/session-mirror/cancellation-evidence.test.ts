import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as sleep} from 'node:timers/promises';
import {MirrorTargetExecution} from '../../../src/runtime/session-mirror/execution.ts';
const counts={targets:1n,events:2n,sent:1n};
function gate(){let resolve!:(v:typeof counts)=>void,reject!:(e:unknown)=>void;const promise=new Promise<typeof counts>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
test('cancelled target retains exact opaque failure without inspecting hooks after cleanup joins',async()=>{
 const owner=new MirrorTargetExecution(),held=gate(),reason={stop:true};let hooks=0;const error=new Proxy({packet:'opaque'},{get(){hooks++;throw Error('getter')},getPrototypeOf(){hooks++;throw Error('prototype')}});
 owner.tryStart({thread:'t',channel:1n},()=>held.promise);await sleep(0);const closing=owner.close(reason);assert.equal(owner.size,1);held.reject(error);const result=(await closing)[0]!.outcome;
 assert.equal(result.kind,'Cancelled');if(result.kind!=='Cancelled')assert.fail();assert.equal(result.reason,reason);
 const settled=Object.getOwnPropertyDescriptor(result,'settled')?.value;assert.equal(settled?.kind,'Failed');assert.equal(settled.error,error);assert.equal(hooks,0);assert.equal(Object.isFrozen(settled),true);assert.equal(owner.size,0);
});
test('late success remains cancelled while exact bounded progress is retained as evidence only',async()=>{
 const owner=new MirrorTargetExecution(),held=gate();owner.tryStart({thread:'t',channel:1n},()=>held.promise);await sleep(0);const closing=owner.close('stop');held.resolve(counts);const result=(await closing)[0]!.outcome;
 assert.equal(result.kind,'Cancelled');const settled=Object.getOwnPropertyDescriptor(result,'settled')?.value;assert.deepEqual(settled,{kind:'Completed',progress:counts});assert.equal(Object.isFrozen(settled.progress),true);
});
test('deadline preserves joined late success evidence but cannot report Completed or release early',async()=>{
 const owner=new MirrorTargetExecution(10),held=gate();owner.tryStart({thread:'t',channel:1n},()=>held.promise);await sleep(30);assert.equal(owner.size,1);assert.deepEqual(owner.takeSettled(),[]);held.resolve(counts);await owner.waitForSettlement();const result=owner.takeSettled()[0]!.outcome;
 assert.equal(result.kind,'TimedOut');assert.deepEqual(Object.getOwnPropertyDescriptor(result,'settled')?.value,{kind:'Completed',progress:counts});await owner.close();
});

import {DatabaseSync} from 'node:sqlite';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';import {MirrorSnapshotOwner} from '../../../src/runtime/session-mirror/snapshot-owner.ts';
import {MirrorBatchExecutionError} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {mixedMirrorPacketSendPlan} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';
test('actual native bound poll shutdown returns authentic reconciliation packet after late accepted HTTP is confirmed',async()=>storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl'),state=join(dirname(path),'state.sqlite');await writeFile(file,'');const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1)}finally{db.close()}
 const stateDb=new DatabaseSync(state);try{stateDb.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');stateDb.prepare('INSERT INTO threads(id,rollout_path,archived)VALUES(?,?,0)').run('thread',file)}finally{stateDb.close()}
 const cursor=new NativeMirrorCursorStore(path),options={read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}};
 let enter!:()=>void,finish!:(id:bigint)=>void,calls=0;const entered=new Promise<void>(r=>enter=r),transport={async sendValidated(){calls++;enter();return new Promise<bigint>(r=>finish=r)}};
 const owner=new MirrorSnapshotOwner(state,path,{threads:{maxRows:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},store:{maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000}},{maxTargets:32,maxBytes:1048576},(hint,channel,jobs,signal)=>pollBoundMirrorTarget(path,hint,channel,jobs,options,transport,signal),()=> 'poll failed');
 try{
  await cursor.initializeSchema();await cursor.initializeFresh('thread',(await captureMirrorCursorAnchor(file,0n)).anchor,'turn',1,'init');await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'accepted'}})+'\n');
  await owner.refresh();owner.dispatch();await Promise.race([entered,owner.waitForSettlement().then(()=>{throw new Error('Poll settled before entering HTTP fixture')})]);const reason={stop:true},closing=owner.close(reason);assert.equal(owner.activeCount,1);finish(123n);
  const result=(await closing)[0]!.outcome;assert.equal(result.kind,'Cancelled');const settled=Object.getOwnPropertyDescriptor(result,'settled')?.value;assert.equal(settled?.kind,'Failed');assert.ok(settled.error instanceof MirrorBatchExecutionError);assert.ok(settled.error.packet);assert.doesNotThrow(()=>mixedMirrorPacketSendPlan(settled.error.packet));
  assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,1n);const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1)}finally{check.close()}
  assert.equal(owner.activeCount,0);assert.equal(ownedWorkerUsage().Background,0);
 }finally{finish?.(123n);await owner.close();await cursor.close()}
}));
