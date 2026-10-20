import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {MirrorMappingChangedError} from '../../../src/store/queue-enqueue.ts';
import {ForkHandoffTargetMovedError,ensureForkHandoffTable} from '../../../src/store/fork-handoff-admission.ts';
import {createNativeQueueState} from '../../../src/runtime/queue-runner/native-state.ts';
import {NativeQueueSubmissionUnconfirmedError} from '../../../src/runtime/queue-runner/native-submission-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {PreparedPromptExecutor,type PreparedTargetServices} from '../../../src/runtime/action-executor/prepared-submission.ts';

async function edit(path:string,run:(db:DatabaseSync)=>void=()=>{}){const db=await openInitialized(path);try{run(db);}finally{db.close();}}
function moved(db:DatabaseSync){ensureForkHandoffTable(db);db.exec("DROP TABLE IF EXISTS codex_exact_thread_routing");db.exec("INSERT INTO codex_thread_fork_handoffs (handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at) VALUES ('handoff','old',1,1,1,'reason','new','new',1,0,1)");}
test('native enqueue snapshots before await and preserves created/replayed full rows without overwrite',async()=>storeFixture(async path=>{
 await edit(path);const native=createNativeQueueState(path),input=queueJob({channelId:9007199254740995n,discordMessageId:99n,prompt:'한글😀'}),task=native.enqueue(path,input);input.prompt='mutated';input.jobId='changed';const first=await task;
 assert.equal(first.created,true);assert.equal(first.job.jobId,'saved');assert.equal(first.job.prompt,'한글😀');assert.equal(first.job.channelId,9007199254740995n);
 const second=await native.enqueue(path,queueJob({jobId:'new-job',targetThreadId:'other',discordMessageId:99n,prompt:'never overwrite'}));assert.equal(second.created,false);assert.deepEqual(second.job,first.job);assert.equal((await state.listFiltered(path,null,null)).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native mirror refusal is nominal and lossless only after original transaction and worker exit',async()=>storeFixture(async path=>{
 const channel=9007199254740995n;await edit(path,db=>db.prepare("INSERT INTO mirror_threads VALUES ('new','p','title',1,?,0)").run(channel));const native=createNativeQueueState(path),input=queueJob({channelId:channel,targetThreadId:'old'}),mapping={discordChannelId:channel,targetThreadId:'old'},task=native.enqueueIfMirrorMatches(path,input,mapping);mapping.targetThreadId='mutated';
 await assert.rejects(task,(e:unknown)=>{assert.ok(e instanceof MirrorMappingChangedError);assert.equal(e.discordChannelId,channel);assert.equal(e.expectedTargetThreadId,'old');assert.equal(e.actualTargetThreadId,'new');assert.equal(ownedWorkerUsage().Control,0);return true;});assert.equal((await state.listFiltered(path,null,null)).length,0);
 assert.equal((await native.enqueueIfMirrorMatches(path,{...input,targetThreadId:'new'},{discordChannelId:channel,targetThreadId:'new'})).created,true);
}));
test('native legacy source refusal retains exact original class and source-target pair',async()=>storeFixture(async path=>{
 await edit(path,moved);await assert.rejects(createNativeQueueState(path).enqueue(path,queueJob({targetThreadId:'old'})),(e:unknown)=>e instanceof ForkHandoffTargetMovedError&&e.sourceThreadId==='old'&&e.targetThreadId==='new');assert.equal(ownedWorkerUsage().Control,0);assert.equal((await state.listFiltered(path,null,null)).length,0);
}));
test('native unexpected SQL error rolls back idle mutation and does not turn into a retarget refusal',async()=>storeFixture(async path=>{
 await edit(path,db=>db.exec("INSERT INTO cdr_idle_release VALUES ('intent','owner',1,'target','turn','old-job',7,'Candidate','old'); CREATE TRIGGER corrupt_queue AFTER INSERT ON codex_turn_queue BEGIN UPDATE codex_turn_queue SET prompt=CAST(X'80' AS TEXT) WHERE job_id=NEW.job_id; END"));
 await assert.rejects(createNativeQueueState(path).enqueue(path,queueJob()),NativeQueueSubmissionUnconfirmedError);
 const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);assert.equal(db.prepare('SELECT state FROM cdr_idle_release').get()!.state,'Candidate');}finally{db.close();}
}));
test('native submission refuses active input, path retargeting and absent DB without creation',async()=>storeFixture(async path=>{
 const native=createNativeQueueState(path);let hooks=0;const bad=Object.defineProperty(queueJob(),'prompt',{get(){hooks++;return 'bad';}});
 await assert.rejects(native.enqueue(path,bad),TypeError);await assert.rejects(native.enqueue(path,new Proxy(queueJob(),{get(){hooks++;throw Error('trap');}})),TypeError);
 await assert.rejects(native.enqueueIfMirrorMatches(path,queueJob(),Object.defineProperty({discordChannelId:1n,targetThreadId:'target'},'targetThreadId',{get(){hooks++;return 'bad';}})),TypeError);
 await assert.rejects(native.enqueue(path+'other',queueJob()),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);
 await assert.rejects(native.enqueue(path,queueJob()),NativeQueueSubmissionUnconfirmedError);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native new submission refuses Control saturation with no extra pool or replay',async()=>storeFixture(async path=>{
 await edit(path);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');const native=createNativeQueueState(path),first=native.enqueue(path,queueJob());
 try{await assert.rejects(native.enqueue(path,queueJob({jobId:'second'})),OwnedWorkerBudgetError);assert.equal(ownedWorkerUsage().Control,1);assert.equal(ownedWorkerUsage().Background,0);db.exec('ROLLBACK');assert.equal((await first).created,true);assert.equal((await state.listFiltered(path,null,null)).length,1);}finally{if(db.isTransaction)db.exec('ROLLBACK');await first.catch(()=>{});db.close();}
}));
for(const mirror of [false,true])test(`late native ${mirror?'refusal':'commit'} remains unconfirmed until actual exit`,async()=>storeFixture(async path=>{
 await edit(path);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');const native=createNativeQueueState(path,30);let done=false,ticks=0;
 const task=mirror?native.enqueueIfMirrorMatches(path,queueJob(),{discordChannelId:1n,targetThreadId:'target'}):native.enqueue(path,queueJob()),rejected=assert.rejects(task,NativeQueueSubmissionUnconfirmedError),timer=setInterval(()=>ticks++,10);void task.then(()=>done=true,()=>done=true);
 try{await new Promise(r=>setTimeout(r,200));assert.equal(done,false);assert.ok(ticks>=3);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.equal((await state.listFiltered(path,null,null)).length,mirror?0:1);}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db.close();}
}));
test('unknown, wrong-request and malformed native responses cannot mint retarget errors or success',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativeQueueState('db');
 for(raw of [{kind:'Unconfirmed'},{kind:'MirrorChanged',channel:1n,expected:'target',actual:null},{kind:'SourceMoved',source:'other',target:'new'},{kind:'SourceMoved',source:'target',target:7},{kind:'Enqueued',value:{created:'true',job:queueJob()}},{kind:'Enqueued',value:{created:true,job:queueJob({jobId:'wrong'})}}])await assert.rejects(native.enqueue('db',queueJob()),NativeQueueSubmissionUnconfirmedError);
 for(raw of [{kind:'MirrorChanged',channel:2n,expected:'target',actual:'new'},{kind:'MirrorChanged',channel:1n,expected:'other',actual:'new'},{kind:'MirrorChanged',channel:1n,expected:'target',actual:'\ud800'}])await assert.rejects(native.enqueueIfMirrorMatches('db',queueJob(),{discordChannelId:1n,targetThreadId:'target'}),NativeQueueSubmissionUnconfirmedError);
});
for(const mode of ['mirror','disappeared','source'] as const)test(`real PreparedPromptExecutor preserves ${mode} handling across native enqueue`,async()=>storeFixture(async path=>{
 await edit(path,db=>{if(mode==='mirror')db.exec("INSERT INTO mirror_threads VALUES ('new','p','title',1,1,0)");if(mode==='source')moved(db);});
 let starts=0,retargets=0;const native=createNativeQueueState(path),queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async claim=>{starts++;assert.equal(claim.targetThreadId,'new');return 'turn';}},{state:native});
 const services:PreparedTargetServices={requiresAppServerFork:()=>true,preparePrompt:async raw=>raw,busyResult:async()=>{throw Error('unexpected busy');},canonicalizeCompletedTarget:async t=>t,currentMirrorTarget:async()=>mode==='disappeared'?['old','selected']:['new','mirror'],prepareActionTarget:async()=>{retargets++;assert.equal(ownedWorkerUsage().Control,0);return {threadId:'new',sourceLabel:mode==='source'?'selected':'mirror',mirrorMapping:mode!=='source'};},recoverActiveWriterSubmission:async(t,s)=>[t,s]};
 const executor=new PreparedPromptExecutor(path,queue,services),task=executor.submit({threadId:'old',sourceLabel:mode==='source'?'selected':'mirror',mirrorMapping:mode!=='source'},{channelId:1n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:true,intakeClaim:null,rawPrompt:'prompt'});
 if(mode==='disappeared'){await assert.rejects(task,/mapping disappeared/);assert.equal(starts,0);assert.equal(retargets,0);assert.equal((await state.listFiltered(path,null,null)).length,0);}else{assert.equal((await task).waitsForFinal,true);assert.equal(starts,1);assert.equal(retargets,1);const rows=await state.listFiltered(path,null,null);assert.equal(rows.length,1);assert.equal(rows[0]!.targetThreadId,'new');assert.equal(rows[0]!.state,'Running');}assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);
}));
test('real prepared executor refuses a second native mirror change without inserting or starting work',async()=>storeFixture(async path=>{
 await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('new','p','title',1,1,0)"));let starts=0,prepares=0;
 const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{starts++;return 'turn';}},{state:createNativeQueueState(path)});
 const services:PreparedTargetServices={requiresAppServerFork:()=>true,preparePrompt:async raw=>raw,busyResult:async()=>{throw Error('busy');},canonicalizeCompletedTarget:async t=>t,currentMirrorTarget:async()=>['new','mirror'],prepareActionTarget:async()=>{prepares++;await edit(path,db=>db.exec("UPDATE mirror_threads SET codex_thread_id='newer'"));return {threadId:'new',sourceLabel:'mirror',mirrorMapping:true};},recoverActiveWriterSubmission:async(t,s)=>[t,s]};
 await assert.rejects(new PreparedPromptExecutor(path,queue,services).submit({threadId:'old',sourceLabel:'mirror',mirrorMapping:true},{channelId:1n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:true,intakeClaim:null,rawPrompt:'prompt'}),/changed again/);
 assert.equal(prepares,1);assert.equal(starts,0);assert.equal((await state.listFiltered(path,null,null)).length,0);assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);
}));
test('actual coordinator retains target lock through late native enqueue commit without starting or replaying',async t=>storeFixture(async path=>{
 await edit(path);let db:DatabaseSync|undefined,starts=0,signal!:()=>void;const reached=new Promise<void>(r=>signal=r),original=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,data:unknown,timeout:number,abort?:AbortSignal){
  if(/native-submission-worker\.(ts|js)$/.test(url.pathname)){db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');const result=original.call(this,url,data,30,abort);signal();return result;}
  return original.call(this,url,data,timeout,abort);
 });
 const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{starts++;return 'turn';}},{state:createNativeQueueState(path)}),task=queue.submitIdentified('new','target',1n,2n,3n,'prompt');let done=false;void task.then(()=>done=true,()=>done=true);const rejected=assert.rejects(task,NativeQueueSubmissionUnconfirmedError);
 try{await reached;await new Promise(r=>setTimeout(r,200));assert.equal(done,false);assert.equal(queue.locks.tryAcquire('target'),undefined);const other=queue.locks.tryAcquire('unrelated');assert.ok(other);other.release();assert.equal(ownedWorkerUsage().Control,1);db!.exec('ROLLBACK');await rejected;assert.equal(starts,0);assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);const rows=await state.listFiltered(path,null,null);assert.equal(rows.length,1);assert.equal(rows[0]!.state,'Pending');assert.equal(rows[0]!.attemptCount,0n);}finally{if(db?.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db?.close();}
}));
