import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativeQueueState} from '../../../src/runtime/queue-runner/native-state.ts';
import {NativeQueueSubmissionUnconfirmedError} from '../../../src/runtime/queue-runner/native-submission-state.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {ForkHandoffTargetMovedError} from '../../../src/store/fork-handoff-admission.ts';
import {DeadGenerationTargetHeldError} from '../../../src/store/fork-completed-target.ts';
import {MirrorMappingChangedError} from '../../../src/store/queue-enqueue.ts';
import {InvalidPromptIntakeLeaseError,type PromptIntakeClaim} from '../../../src/store/prompt-intake.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {PreparedPromptExecutor,type PreparedTargetServices} from '../../../src/runtime/action-executor/prepared-submission.ts';
const input=(mirror=false)=>({jobId:'job',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:mirror,createdAt:1});
const job=()=>queueJob({jobId:'job',channelId:1n,ownerUserId:2n,discordMessageId:3n,prompt:'enriched',createdAt:12});
async function claim(path:string,mirror=false){await state.admitPromptIntake(path,input(mirror));const owned=await state.tryClaimPromptIntake(path,'job',10,20);assert.ok(owned);return owned;}
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
test('native promotion captures original claim before await and accepts its independently renewed lease',async()=>storeFixture(async path=>{
 const owned=await claim(path);await state.renewPromptIntakeClaimIfCurrent(path,owned,11,40);const prepared=job(),task=createNativeQueueState(path).promotePromptIntakeToQueue(path,owned,prepared,25);owned.claimToken='changed';owned.intake.rawPrompt='changed';prepared.prompt='changed';const result=await task;
 assert.equal(result.created,true);assert.equal(result.job.prompt,'enriched');assert.equal(result.job.ownerUserId,2n);assert.equal(await state.getPromptIntake(path,'job'),null);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native exact existing queue transfer keeps created=false and older generation/flags',async()=>storeFixture(async path=>{
 const owned=await claim(path);await state.enqueue(path,{...job(),appServerGeneration:8n,ackSent:true});const result=await createNativeQueueState(path).promotePromptIntakeToQueue(path,owned,job(),12);assert.equal(result.created,false);assert.equal(result.job.appServerGeneration,8n);assert.equal(result.job.ackSent,true);assert.equal(await state.getPromptIntake(path,'job'),null);assert.equal((await state.listFiltered(path,null,null)).length,1);
}));
test('stale token, changed raw identity and expired native promotion remain unconfirmed without transfer',async()=>{
 for(const variant of ['token','raw','expired'])await storeFixture(async path=>{const owned=await claim(path);if(variant==='token')owned.claimToken='stale';if(variant==='raw')owned.intake.rawPrompt='different';await assert.rejects(createNativeQueueState(path).promotePromptIntakeToQueue(path,owned,job(),variant==='expired'?20:12),NativeQueueSubmissionUnconfirmedError);assert.ok(await state.getPromptIntake(path,'job'));assert.equal((await state.listFiltered(path,null,null)).length,0);});
});
test('native promotion source-moved refusal binds the old intake source even when queued target differs',async()=>storeFixture(async path=>{
 const owned=await claim(path);edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET target_thread_id='moved'"));await assert.rejects(createNativeQueueState(path).promotePromptIntakeToQueue(path,owned,{...job(),targetThreadId:'prepared-other'},12),(e:unknown)=>e instanceof ForkHandoffTargetMovedError&&e.sourceThreadId==='target'&&e.targetThreadId==='moved');assert.equal((await state.listFiltered(path,null,null)).length,0);
}));
test('native promotion preserves observed hold on current moved intake before source correction',async()=>storeFixture(async path=>{
 const owned=await claim(path);edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET target_thread_id='moved'; INSERT INTO codex_dead_generation_holds VALUES ('moved','runtime',1,0)"));await assert.rejects(createNativeQueueState(path).promotePromptIntakeToQueue(path,owned,job(),12),(e:unknown)=>e instanceof DeadGenerationTargetHeldError&&e.kind==='DeadGenerationTargetHeld'&&e.targetThreadId==='moved');assert.equal((await state.listFiltered(path,null,null)).length,0);assert.ok(await state.getPromptIntake(path,'job'));assert.equal(ownedWorkerUsage().Control,0);
}));
test('native promotion restores exact mirror refusal and transfers only after mapping matches',async()=>storeFixture(async path=>{
 const owned=await claim(path,true),native=createNativeQueueState(path);await assert.rejects(native.promotePromptIntakeToQueue(path,owned,{...job(),targetThreadId:'mapped'},12),(e:unknown)=>e instanceof MirrorMappingChangedError&&e.discordChannelId===1n&&e.expectedTargetThreadId==='mapped'&&e.actualTargetThreadId===null);
 edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('mapped','project','title',9,1,0)"));assert.equal((await native.promotePromptIntakeToQueue(path,owned,{...job(),targetThreadId:'mapped'},12)).job.targetThreadId,'mapped');assert.equal(await state.getPromptIntake(path,'job'),null);
}));
test('native final-delete failure rolls back full transfer and cannot masquerade as created=false',async()=>storeFixture(async path=>{
 const owned=await claim(path);edit(path,db=>db.exec('CREATE TRIGGER refuse_promotion BEFORE DELETE ON codex_prompt_intakes BEGIN SELECT RAISE(IGNORE); END'));await assert.rejects(createNativeQueueState(path).promotePromptIntakeToQueue(path,owned,job(),12),NativeQueueSubmissionUnconfirmedError);assert.equal((await state.listFiltered(path,null,null)).length,0);assert.equal((await state.getPromptIntake(path,'job'))?.claimToken,owned.claimToken);
}));
test('native promotion checks passive data and finite time before worker or absent-file creation',async()=>storeFixture(async path=>{
 const owned:PromptIntakeClaim={claimToken:'token',intake:{...input(),attemptCount:0n,lastError:'',retryAfter:0,claimToken:'token',claimExpiresAt:20,updatedAt:10}},native=createNativeQueueState(path);let hooks=0;
 await assert.rejects(native.promotePromptIntakeToQueue(path,Object.defineProperty({...owned},'claimToken',{get(){hooks++;return 'bad';}}),job(),12),TypeError);await assert.rejects(native.promotePromptIntakeToQueue(path,new Proxy(owned,{get(){hooks++;throw Error('trap');}}),job(),12),TypeError);await assert.rejects(native.promotePromptIntakeToQueue(path,owned,job(),NaN),InvalidPromptIntakeLeaseError);assert.equal(hooks,0);assert.equal(existsSync(path),false);await assert.rejects(native.promotePromptIntakeToQueue(path,owned,job(),12),NativeQueueSubmissionUnconfirmedError);assert.equal(existsSync(path),false);
}));
test('late native promotion commits once but retains ownership and rejects unconfirmed until exit',async()=>storeFixture(async path=>{
 const owned=await claim(path),db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const task=createNativeQueueState(path,30).promotePromptIntakeToQueue(path,owned,job(),12),rejected=assert.rejects(task,NativeQueueSubmissionUnconfirmedError);let done=false;void task.then(()=>done=true,()=>done=true);
 try{await new Promise(r=>setTimeout(r,200));assert.equal(done,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.equal(await state.getPromptIntake(path,'job'),null);assert.equal((await state.listFiltered(path,null,null)).length,1);}finally{if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db.close();}
}));
test('promotion decoder rejects unrelated hold, source and duplicate-success identities',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativeQueueState('db'),owned:PromptIntakeClaim={claimToken:'token',intake:{...input(),attemptCount:0n,lastError:'',retryAfter:0,claimToken:'token',claimExpiresAt:20,updatedAt:10}};
 for(raw of [{kind:'DeadTargetHeld',jobId:'other',target:'moved'},{kind:'SourceMoved',source:'unrelated',target:'new'},{kind:'Enqueued',value:{created:false,job:queueJob({jobId:'other'})}},{kind:'Enqueued',value:{created:false,job:{...job(),ownerUserId:99n}}},{kind:'Enqueued',value:{created:false,job:{...job(),prompt:'wrong'}}}])await assert.rejects(native.promotePromptIntakeToQueue('db',owned,job(),12),NativeQueueSubmissionUnconfirmedError);
 raw={kind:'DeadTargetHeld',jobId:'job',target:'moved'};await assert.rejects(native.enqueue('db',job()),NativeQueueSubmissionUnconfirmedError);
});
test('actual prepared executor transfers native intake ownership before first backend dispatch',async()=>storeFixture(async path=>{
 const owned=await claim(path);let starts=0;const native=createNativeQueueState(path),queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async expected=>{starts++;assert.equal(expected.prompt,'enriched');assert.equal(await state.getPromptIntake(path,'job'),null);return 'turn';}},{state:native,clock:()=>12});
 const services:PreparedTargetServices={requiresAppServerFork:()=>false,preparePrompt:async()=> 'enriched',busyResult:async()=>{throw Error('busy');},canonicalizeCompletedTarget:async target=>target,currentMirrorTarget:async()=>['target','selected'],prepareActionTarget:async()=>({threadId:'target',sourceLabel:'selected',mirrorMapping:false}),recoverActiveWriterSubmission:async(t,s)=>[t,s]};
 const result=await new PreparedPromptExecutor(path,queue,services).submit({threadId:'target',sourceLabel:'selected',mirrorMapping:false},{channelId:1n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:true,intakeClaim:owned,rawPrompt:'raw'});assert.equal(result.waitsForFinal,true);assert.equal(starts,1);assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);
}));
