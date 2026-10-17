import test from 'node:test';import assert from 'node:assert/strict';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';
import {startPromptIntakeRuntimeWorker} from '../../../src/runtime/discord-runtime/prompt-intake-start.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import type {TickSource} from '../../../src/runtime/delayed-ticks.ts';
const flush=()=>new Promise<void>(r=>setImmediate(r));
class Ticks implements TickSource{wake:(()=>void)|undefined;closed=false;wait(){return new Promise<void>(r=>{this.wake=r;});}fire(){assert.ok(this.wake);const r=this.wake;this.wake=undefined;r();}close(){this.closed=true;this.wake?.();}}
async function fixture(run:(path:string,executor:RuntimeCommandExecutor,starts:string[])=>Promise<void>,prepare:(p:string)=>Promise<string>=async p=>p+' prepared'){await storeFixture(async path=>{
 const root=dirname(path),bridge=new BridgeState(join(root,'bridge.json')),starts:string[]=[];
 const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=> 'fixture',activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async(claim:{prompt:string})=>{starts.push(claim.prompt);return 'turn';}});
 const executor=new RuntimeCommandExecutor({paths:{state:join(root,'unused-codex.sqlite'),mirror:path,bridge:bridge.path()},bridge,server:null,backend:null,queue,render:()=> 'fixture',preparePrompt:prepare,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000});await run(path,executor,starts);
});}
async function admit(path:string,id:string){await state.admitPromptIntake(path,{jobId:id,targetThreadId:id,channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:'raw '+id,autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});}
test('periodic binding uses actual executor intake and promotes saved original prompt after first delayed tick',async()=>fixture(async(path,executor,starts)=>{
 await admit(path,'ready');const ticks=new Ticks(),stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),gate=new AdmissionGate(),errors:unknown[]=[];
 const worker=startPromptIntakeRuntimeWorker(executor,gate,stop.signal,exits,e=>{errors.push(e);},()=>ticks);
 try{await flush();assert.deepEqual(starts,[]);ticks.fire();while(ticks.wake===undefined&&worker.peek()===undefined)await flush();assert.deepEqual(starts,['raw ready prepared']);assert.equal(await state.getPromptIntake(path,'ready'),null);assert.equal((await state.listQueueJobs(path)).length,1);assert.deepEqual(errors,[]);}finally{stop.abort();await worker.join();exits.close();}assert.equal(ticks.closed,true);
}));
test('periodic cycle preserves foreign intake lease, manual hold and retry deadline without releasing claims',async()=>fixture(async(path,executor,starts)=>{
 for(const id of ['foreign','held','deferred'])await admit(path,id);const db=await openInitialized(path);try{db.exec("UPDATE codex_prompt_intakes SET claim_token='foreign-token',claim_expires_at=9999999999 WHERE job_id='foreign'; UPDATE codex_prompt_intakes SET retry_after=9999999999 WHERE job_id='deferred'; INSERT INTO cdr_execution_holds VALUES('held','held','manual','{}',1)");}finally{db.close();}
 const ticks=new Ticks(),stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),worker=startPromptIntakeRuntimeWorker(executor,new AdmissionGate(),stop.signal,exits,()=>{},()=>ticks);
 try{await flush();ticks.fire();while(ticks.wake===undefined&&worker.peek()===undefined)await flush();assert.deepEqual(starts,[]);assert.equal((await state.getPromptIntake(path,'foreign'))!.claimToken,'foreign-token');assert.equal((await state.getPromptIntake(path,'deferred'))!.retryAfter,9999999999);assert.equal(await state.executionHoldReason(path,'held'),'manual');}finally{stop.abort();await worker.join();exits.close();}
}));
test('forced shutdown during real intake preparation retains admission until queue promotion and lease completion',async()=>{
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r);
 await fixture(async(path,executor,starts)=>{await admit(path,'ready');const ticks=new Ticks(),stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),gate=new AdmissionGate(),key=DrainFenceKey.create('runtime','1|2','nonce'),worker=startPromptIntakeRuntimeWorker(executor,gate,stop.signal,exits,()=>{},()=>ticks);
 try{await flush();ticks.fire();await entered;worker.abort();gate.seal(key);await flush();assert.equal(worker.peek(),undefined);assert.equal(gate.isDrainedFor(key),false);release();assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(gate.isDrainedFor(key),true);assert.deepEqual(starts,['raw ready prepared']);assert.equal(await state.getPromptIntake(path,'ready'),null);}finally{release();stop.abort();await worker.join();exits.close();}
 },async p=>{enter();await wait;return p+' prepared';});
});
test('sealed gate prevents actual recovery and pre-entry abort allocates no tick resource',async()=>fixture(async(path,executor,starts)=>{
 await admit(path,'ready');const gate=new AdmissionGate(),key=DrainFenceKey.create('runtime','1|2','nonce');gate.seal(key);const ticks=new Ticks(),stop=new AbortController(),exits=new RuntimeWorkerExitChannel();let allocated=0;
 const pre=startPromptIntakeRuntimeWorker(executor,gate,stop.signal,exits,()=>{},()=>{allocated++;return ticks;});pre.abort();await pre.join();assert.equal(allocated,0);
 const worker=startPromptIntakeRuntimeWorker(executor,gate,stop.signal,exits,()=>{},()=>ticks);try{await flush();ticks.fire();await flush();assert.deepEqual(starts,[]);assert.ok(await state.getPromptIntake(path,'ready'));assert.equal(gate.isDrainedFor(key),true);}finally{stop.abort();await worker.join();exits.close();}
}));
test('forged executor cannot substitute recovery port or execute getter',()=>{let calls=0;const fake=Object.create(RuntimeCommandExecutor.prototype);Object.defineProperty(fake,'promptIntakeRecoveryServices',{get(){calls++;return ()=>({recoverPromptIntakes:async()=>0});}});const exits=new RuntimeWorkerExitChannel();try{assert.throws(()=>startPromptIntakeRuntimeWorker(fake,new AdmissionGate(),new AbortController().signal,exits,()=>{}),TypeError);assert.equal(calls,0);}finally{exits.close();}});
