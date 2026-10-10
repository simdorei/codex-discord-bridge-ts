import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {BusyResultProducer} from '../../../src/runtime/action-executor/busy-result.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {QueueReadCoordinator} from '../../../src/runtime/queue-runner/read-coordinator.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
function fixture(path:string,active:string|null='turn',serverAvailable=true){
 const locks=new TargetLocks();const server={generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:1}),activeTurnId:()=>active};
 const verifier=new ControlTurnVerifier(path,serverAvailable?server:null,{selectedThreadId:()=> 'thread'},locks),reads=new QueueReadCoordinator(path,{activeTurnId:async()=>active});
 return {locks,producer:new BusyResultProducer(path,verifier,reads,()=>100)};
}
test('confirmed active turn creates exact 30-minute busy choice and pinned control binding',async()=>storeFixture(async path=>{
 const f=fixture(path),result=await f.producer.busyResult('thread',1n,2n,'raw',true,false);assert.equal(result.ui?.kind,'Busy');assert.ok(result.ui&&result.ui.kind==='Busy');assert.equal(result.ui.allowSteer,true);
 const row=await state.readBusyChoiceState(path,result.ui.choiceId,100);assert.equal(row?.choice.prompt,'raw');assert.equal(row?.choice.ownerUserId,2n);assert.equal(row?.choice.expiresAt,1900);assert.equal(await state.resolveBusyControl(path,result.ui.choiceId,'thread'),'turn');assert.equal(f.locks.activeTargetCount,0);
}));
test('Pro busy never offers steer while retaining exact original control binding',async()=>storeFixture(async path=>{
 const f=fixture(path),result=await f.producer.busyResult('thread',1n,2n,'!pro investigate',true,false);assert.equal(result.ui?.kind,'ProBusy');assert.match(result.text,/cannot be steered/);assert.ok(result.ui&&result.ui.kind==='ProBusy');assert.equal((await state.readBusyChoiceState(path,result.ui.choiceId,100))?.choice.allowSteer,false);assert.equal(await state.resolveBusyControl(path,result.ui.choiceId,'thread'),'turn');
}));
test('missing server disables steer without inventing idle or losing request',async()=>storeFixture(async path=>{
 const f=fixture(path,'turn',false),result=await f.producer.busyResult('thread',1n,2n,'raw',true,false);assert.ok(result.ui&&result.ui.kind==='Busy');assert.equal(result.ui.allowSteer,false);assert.match(result.text,/resident Codex app-server is unavailable/);
}));
test('missing active turn produces conservative controls and no fabricated binding',async()=>storeFixture(async path=>{
 const f=fixture(path,null),result=await f.producer.busyResult('thread',1n,2n,'raw',true,false);assert.ok(result.ui&&result.ui.kind==='Busy');assert.equal(result.ui.allowSteer,false);assert.match(result.text,/no currently owned active turn/);assert.equal(await state.resolveBusyControl(path,result.ui.choiceId,'thread'),null);
}));
test('changed mapped route fails before persisting a choice and releases shared lock',async()=>storeFixture(async path=>{
 const f=fixture(path);await assert.rejects(f.producer.busyResult('thread',1n,2n,'raw',false,true),/original busy prompt route changed/);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM busy_choices').get()?.n,0);}finally{db.close();}assert.equal(f.locks.activeTargetCount,0);
}));
test('cancellation while waiting for target lock creates no choice and leaves unrelated lease alone',async()=>storeFixture(async path=>{
 const f=fixture(path),lease=await f.locks.acquire('thread'),controller=new AbortController(),reason=new Error('cancel');const pending=f.producer.busyResult('thread',1n,2n,'raw',true,false,controller.signal),checked=assert.rejects(pending,e=>e===reason);controller.abort(reason);await checked;assert.equal(f.locks.activeTargetCount,1);lease.release();assert.equal(f.locks.activeTargetCount,0);
}));
test('native protocol active cache and real completion evidence change control eligibility without RPC dispatch',async()=>{
 const {asyncChoiceServer}=await import('../../helpers/async-choice-server.ts');
 await storeFixture(async path=>asyncChoiceServer({active:'v'},async(server,_q,seen)=>{
  const locks=new TargetLocks(),verifier=new ControlTurnVerifier(path,server,{selectedThreadId:()=> 't'},locks),reads=new QueueReadCoordinator(path,{activeTurnId:async target=>server.activeTurnId(target)}),producer=new BusyResultProducer(path,verifier,reads,()=>100);
  const first=await producer.busyResult('t',1n,2n,'raw',true,false);assert.ok(first.ui&&first.ui.kind==='Busy');assert.equal(first.ui.allowSteer,true);assert.equal(await state.resolveBusyControl(path,first.ui.choiceId,'t'),'v');
  const db=await openInitialized(path);try{db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES ('t','v',1,'{}')");}finally{db.close();}
  const next=await producer.busyResult('t',1n,2n,'later',true,false);assert.ok(next.ui&&next.ui.kind==='Busy');assert.equal(next.ui.allowSteer,false);assert.match(next.text,/turn completed or connection changed/);assert.deepEqual(await seen(),[]);assert.equal(locks.activeTargetCount,0);
 }));
});
