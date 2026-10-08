import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {usingInitializedStore} from '../../../src/store/owned-scope.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {QueueStartCoordinator,type QueueStartBackend} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {CompletionIdleRelease,type IdleReleaseFailure} from '../../../src/runtime/completion/idle-release.ts';
import type {IdleReleaseToken} from '../../../src/app-server/idle-release-journal.ts';
import type {TickSource} from '../../../src/runtime/delayed-ticks.ts';
const OWNER='00000000-0000-4000-8000-000000000001' as const;
const backend:QueueStartBackend={generation:()=>1n,residentInstanceId:()=> OWNER,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{throw new Error('No start');}};
async function insert(path:string,thread:string,status='Candidate',owner:string=OWNER,generation=1n){await usingInitializedStore(path,db=>{db.prepare("INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail) VALUES(?,?,?,?, 'turn','job',1,?,'prior')").run('i-'+thread,owner,generation,thread,status);});}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(path:string,release:(token:IdleReleaseToken)=>Promise<void>){const queue=new QueueStartCoordinator(path,backend),failures:IdleReleaseFailure[]=[],worker=new CompletionIdleRelease({instanceId:OWNER,generation:()=>1n,releaseIdleSubscription:release},queue,()=> 'safe failure',failure=>{failures.push(failure);});return {queue,failures,worker};}
test('only exact owner/current generation Candidate or AwaitUnload reaches native maintenance',async()=>storeFixture(async path=>{
 for(const [thread,status,owner,gen] of [['a','Candidate',OWNER,1n],['b','AwaitUnload',OWNER,1n],['c','Unknown',OWNER,1n],['d','Dispatching',OWNER,1n],['e','Candidate','foreign',1n],['f','Candidate',OWNER,2n],['g','Candidate',OWNER,-1n],['h','Settled',OWNER,1n]] as const)await insert(path,thread,status,owner,gen);
 const seen:string[]=[],f=fixture(path,async token=>{seen.push(token.threadId);});await f.worker.scanOnce();assert.deepEqual(seen,['a','b']);assert.deepEqual(f.failures,[]);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal((await state.getIdleIntent(path,'e'))!.ownerId,'foreign');
}));
test('busy target is skipped without waiting while another target can release',async()=>storeFixture(async path=>{
 await insert(path,'a');await insert(path,'b');const seen:string[]=[],f=fixture(path,async t=>{seen.push(t.threadId);}),lease=f.queue.locks.tryAcquire('a')!;try{await f.worker.scanOnce();assert.deepEqual(seen,['b']);assert.equal(f.queue.locks.activeTargetCount,1);}finally{lease.release();}assert.equal(f.queue.locks.activeTargetCount,0);
}));
test('unsent unchanged Candidate records safe deferral but AwaitUnload failure remains untouched',async()=>storeFixture(async path=>{
 await insert(path,'a');await insert(path,'b','AwaitUnload');await insert(path,'c');const seen:string[]=[],failure=new Error('private raw details'),f=fixture(path,async t=>{seen.push(t.threadId);if(t.threadId!=='c')throw failure;});await f.worker.scanOnce();assert.deepEqual(seen,['a','b','c']);const a=(await state.getIdleIntent(path,'a'))!,b=(await state.getIdleIntent(path,'b'))!;assert.deepEqual([a.state,a.detail,a.revision],['Candidate','safe failure',2n]);assert.deepEqual([b.state,b.detail,b.revision],['AwaitUnload','prior',1n]);assert.deepEqual(f.failures.map(x=>x.stage),['release','release']);assert.equal(f.failures[0]!.error,failure);
}));
test('failure cannot overwrite an intent advanced during managed native execution',async()=>storeFixture(async path=>{
 await insert(path,'a');const f=fixture(path,async token=>{await state.transitionIdleIntent(path,{...token},'Dispatching','committed native permission');throw new Error('unknown');});await f.worker.scanOnce();const row=(await state.getIdleIntent(path,'a'))!;assert.deepEqual([row.state,row.detail,row.revision],['Dispatching','committed native permission',2n]);assert.equal(f.failures.length,1);assert.equal(f.queue.locks.activeTargetCount,0);
}));
test('deferral record failure is separately reported and later targets are still attempted',async()=>storeFixture(async path=>{
 await insert(path,'a');await insert(path,'b');await usingInitializedStore(path,db=>{db.exec("CREATE TRIGGER reject_deferral BEFORE UPDATE ON cdr_idle_release WHEN OLD.thread_id='a' BEGIN SELECT RAISE(ABORT,'deferral blocked'); END");});const seen:string[]=[],f=fixture(path,async t=>{seen.push(t.threadId);if(t.threadId==='a')throw new Error('original');});await f.worker.scanOnce();assert.deepEqual(seen,['a','b']);assert.deepEqual(f.failures.map(x=>x.stage),['deferral','release']);assert.equal((await state.getIdleIntent(path,'a'))!.revision,1n);
}));
test('shutdown joins already-managed native release and does not begin another target',{timeout:5000},async()=>storeFixture(async path=>{
 await insert(path,'a');await insert(path,'b');const entered=deferred(),release=deferred(),abort=new AbortController(),seen:string[]=[],f=fixture(path,async t=>{seen.push(t.threadId);entered.resolve();await release.promise;});let closed=false;const ticks:TickSource={wait:async()=>{throw new Error('No next tick');},close:()=>{closed=true;}};let stopped=false;const running=f.worker.run(abort.signal,ticks).then(()=>{stopped=true;});await entered.promise;assert.equal(f.queue.locks.activeTargetCount,1);await assert.rejects(f.worker.scanOnce(),/already owned/);abort.abort();await tick();assert.equal(stopped,false);assert.equal(f.queue.locks.activeTargetCount,1);release.resolve();await running;assert.deepEqual(seen,['a']);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(closed,true);
}));
test('pre-aborted scan cannot initialize a missing store',async()=>{
 const abort=new AbortController(),reason=new Error('stop');abort.abort(reason);const f=fixture('/must-not-exist/idle.sqlite',async()=>{throw new Error('No native call');});await assert.rejects(f.worker.scanOnce(abort.signal),e=>e===reason);
});
