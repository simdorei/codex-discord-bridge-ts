import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ensureForkHandoffTable} from '../../../src/store/fork-handoff-admission.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {DeadGenerationTargetHeldError} from '../../../src/store/fork-completed-target.ts';
import {QueueStartCoordinator,type QueueStartBackend} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {createNativeQueueState} from '../../../src/runtime/queue-runner/native-state.ts';
import {QueueForkCoordinator} from '../../../src/runtime/queue-runner/fork-coordinator.ts';
import {ForkRuntimeError} from '../../../src/runtime/queue-runner/fork-errors.ts';
import {NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
function edit(path:string,run:(db:DatabaseSync)=>void){const db=new DatabaseSync(path);try{run(db);}finally{db.close();}}
async function setup(path:string,cycle=false){const db=await openInitialized(path);try{ensureForkHandoffTable(db);const add=db.prepare(`INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at) VALUES(?,?,1,1,2,'reason',?,?,2,0,1)`);add.run('a','a','b','b');add.run('b','b',cycle?'a':'c',cycle?'a':'c');}finally{db.close();}}
const backend=():QueueStartBackend=>({generation:()=>1n,residentInstanceId:()=> 'resident',requiresAppServerFork:()=>true,activeTurnId:async()=>null,resumeThread:async()=>assert.fail('resume'),readTurns:async()=>assert.fail('read turns'),startClaimedTurn:async()=>assert.fail('start'),forkThread:async()=>assert.fail('fork')});
test('actual native QueueStartCoordinator completed chain keeps per-hop held checks and never invokes poisoned compatibility lookup',async t=>storeFixture(async path=>{
 await setup(path);t.mock.method(state,'completedAppServerForkTargetForSource',async()=>assert.fail('main compatibility lookup'));const operations:string[]=[],run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as {operation:string;id?:string;target?:string};operations.push(q.operation+':'+(q.id??q.target));return run.apply(this,args);});
 const queue=new QueueStartCoordinator(path,backend(),{state:createNativeQueueState(path)});assert.deepEqual(await queue.ensureAppServerOnlyTarget('a'),{threadId:'c',forkedFrom:'a',quarantinedJobId:null});assert.deepEqual(operations,['DeadTarget:a','CompletedForkTarget:a','DeadTarget:b','CompletedForkTarget:b','DeadTarget:c','CompletedForkTarget:c']);assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native fork coordinator observes a newly held next target before the next lookup or cycle check',async t=>storeFixture(async path=>{
 await setup(path,true);const operations:string[]=[],run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as {operation:string;id?:string;target?:string};operations.push(q.operation+':'+(q.id??q.target));const task=run.apply(this,args);return q.operation==='CompletedForkTarget'&&q.id==='a'?task.then(value=>{edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES('b','runtime',1,0)"));return value;}):task;});
 const queue=new QueueStartCoordinator(path,backend(),{state:createNativeQueueState(path)});await assert.rejects(queue.ensureAppServerOnlyTarget('a'),e=>e instanceof DeadGenerationTargetHeldError&&e.targetThreadId==='b');assert.deepEqual(operations,['DeadTarget:a','CompletedForkTarget:a','DeadTarget:b']);assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native fork coordinator keeps source hold precedence and distinct existing cycle refusal',async()=>storeFixture(async path=>{
 await setup(path,true);const queue=new QueueStartCoordinator(path,backend(),{state:createNativeQueueState(path)});await assert.rejects(queue.ensureAppServerOnlyTarget('a'),e=>e instanceof ForkRuntimeError&&e.kind==='ForkTargetCycle');edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES('a','runtime',1,0)"));await assert.rejects(queue.ensureAppServerOnlyTarget('a'),e=>e instanceof DeadGenerationTargetHeldError&&e.targetThreadId==='a');assert.equal(queue.locks.activeTargetCount,0);
}));
test('native fork coordinator failed completed lookup never falls through to unresolved intent or backend work',async()=>storeFixture(async path=>{
 await setup(path);edit(path,db=>db.exec('DROP TABLE codex_thread_fork_handoffs'));const native=createNativeQueueState(path),coordinator=new QueueForkCoordinator(path,backend(),{...native,unresolvedAppServerForkHandoffForSource:async()=>assert.fail('unavailable is not absence')});await assert.rejects(coordinator.ensureTarget('a'),e=>e instanceof NativePromptIntakeUnavailableError&&e.operation==='CompletedForkTarget');assert.equal(ownedWorkerUsage().Control,0);
}));
test('fork coordinator captures completed lookup once and preserves exact Promise rejection and chain ordering',async()=>{
 const order:string[]=[],failure=new Error('unchanged'),input={...state,deadTargetHeld:async(_path:string,target:string)=>{order.push('held:'+target);return false;},completedAppServerForkTargetForSource:async(path:string,source:string)=>{assert.equal(path,'original');order.push('completed:'+source);if(source==='a')return 'b';throw failure;},unresolvedAppServerForkHandoffForSource:async()=>assert.fail('unavailable is not absence')};const coordinator=new QueueForkCoordinator('original',backend(),input);input.completedAppServerForkTargetForSource=async()=>assert.fail('replacement');await assert.rejects(coordinator.ensureTarget('a'),e=>e===failure);assert.deepEqual(order,['held:a','completed:a','held:b','completed:b']);
});
test('native completed lookup deadline retains queue target lock until worker exit and cannot admit a successor',async t=>storeFixture(async path=>{
 await setup(path);let blocker:DatabaseSync|undefined,entered!:()=>void;const began=new Promise<void>(r=>{entered=r;}),run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as {operation:string};if(q.operation==='CompletedForkTarget'){blocker=new DatabaseSync(path);blocker.exec('PRAGMA journal_mode=DELETE;BEGIN IMMEDIATE');const task=run.call(this,args[0],args[1],30);entered();return task;}return run.apply(this,args);});
 const queue=new QueueStartCoordinator(path,backend(),{state:createNativeQueueState(path)}),pending=queue.ensureAppServerOnlyTarget('a'),rejected=assert.rejects(pending,e=>e instanceof NativePromptIntakeUnavailableError&&e.operation==='CompletedForkTarget');let settled=false,ticks=0;void pending.then(()=>{settled=true;},()=>{settled=true;});const timer=setInterval(()=>{ticks++;},5);
 try{await began;await new Promise(r=>setTimeout(r,160));assert.equal(settled,false);assert.ok(ticks>2);assert.equal(queue.locks.tryAcquire('a'),undefined);assert.equal(ownedWorkerUsage().Control,1);blocker!.exec('ROLLBACK');await rejected;assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);}finally{clearInterval(timer);if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
}));
