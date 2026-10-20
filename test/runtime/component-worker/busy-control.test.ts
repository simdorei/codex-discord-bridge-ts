import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {executeBusyAction} from '../../../src/runtime/component-worker/busy-control.ts';
import {busyComponentErrorInfo} from '../../../src/runtime/component-worker/busy-errors.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice, getBusyChoice} from '../../../src/store/busy-choice-store.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ownedRequestFailure} from '../../../src/app-server/request-client.ts';
import type {BusyChoice} from '../../../src/store/busy-choice.ts';
import {promptFixture, callPromptFixture, editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
const choice: BusyChoice = {choiceId:'c',ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt:'prompt',allowSteer:true,createdAt:1,expiresAt:100};
const kind=(k:string)=>(e:unknown)=>busyComponentErrorInfo(e)?.kind===k;
async function setup(db:string,server:ConstructorParameters<typeof ControlTurnVerifier>[1],bind=true) {
  const id=await createBusyChoice(db,{ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt:'new direction',allowSteer:true,now:1,timeToLive:100});
  const c=(await getBusyChoice(db,id,2))!;if(bind)await state.bindBusyControl(db,id,'t','v',null);const locks=new TargetLocks();
  return {choice:c,locks,verify:new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},locks)};
}
async function origins(path:string){const db=await openInitialized(path);try{return db.prepare('SELECT event_digest FROM codex_session_mirror_events').all();}finally{db.close();}}
test('Ignore touches no server/store/target; Pro steer rejection precedes target absence',async()=>{
  await executeBusyAction({...choice,targetThreadId:null},'Ignore',null as any,'/unused',null as any);
  await assert.rejects(executeBusyAction({...choice,prompt:' !PRO x',targetThreadId:null},'Steer',null as any,'/unused',null as any),kind('ControlNotDispatched'));
  await assert.rejects(executeBusyAction({...choice,targetThreadId:null},'Stop',null as any,'/unused',null as any),kind('NoTarget'));
  await assert.rejects(executeBusyAction(choice,'Queue',null as any,'/unused',null as any),/atomic enqueue/);
});
test('native steer binds expected original turn, records user origin and releases shared target lease',async()=>{
  await promptFixture(async(db,server)=>{
    const f=await setup(db,server);await executeBusyAction(f.choice,'Steer',server,db,f.verify,()=>3);
    assert.deepEqual(await callPromptFixture(server,'controls'),[{method:'turn/steer',params:{threadId:'t',expectedTurnId:'v',input:[{type:'text',text:'new direction',text_elements:[]}]}}]);
    assert.equal((await origins(db)).length,1);assert.match((await origins(db))[0]!.event_digest as string,/^discord-user:v1:t:v:/);assert.equal(f.locks.activeTargetCount,0);
  },{enableResponses:true});
});
test('native stop submits exact original turn without user-origin side effect',async()=>{
  await promptFixture(async(db,server)=>{const f=await setup(db,server);await executeBusyAction(f.choice,'Stop',server,db,f.verify);assert.deepEqual(await callPromptFixture(server,'controls'),[{method:'turn/interrupt',params:{threadId:'t',turnId:'v'}}]);assert.deepEqual(await origins(db),[]);assert.equal(f.locks.activeTargetCount,0);},{enableResponses:true});
});
test('missing original binding never substitutes current active turn',async()=>{
  await promptFixture(async(db,server)=>{const f=await setup(db,server,false);await assert.rejects(executeBusyAction(f.choice,'Stop',server,db,f.verify),e=>kind('ControlNotDispatched')(e)&&String(e).includes('no confirmed original turn'));assert.deepEqual(await callPromptFixture(server,'controls'),[]);assert.equal(f.locks.activeTargetCount,0);},{enableResponses:true});
});
test('later active turn and changed mirror reject before any control RPC',async()=>{
  await promptFixture(async(db,server)=>{
    const f=await setup(db,server);await editPromptFixture(db,"UPDATE mirror_threads SET codex_thread_id='other'");await assert.rejects(executeBusyAction(f.choice,'Steer',server,db,f.verify),kind('ControlNotDispatched'));
    await editPromptFixture(db,"UPDATE mirror_threads SET codex_thread_id='t'");await callPromptFixture(server,'next');await assert.rejects(executeBusyAction(f.choice,'Steer',server,db,f.verify),e=>kind('ControlNotDispatched')(e)&&String(e).includes('original turn has ended'));
    assert.deepEqual(await callPromptFixture(server,'controls'),[]);assert.equal(await state.resolveBusyControl(db,f.choice.choiceId,'t'),'v');assert.equal(f.locks.activeTargetCount,0);
  },{enableResponses:true});
});
test('origin SQL failure and clock failure are pre-dispatch and leave zero native controls',async()=>{
  await promptFixture(async(db,server)=>{
    const f=await setup(db,server);await assert.rejects(executeBusyAction(f.choice,'Steer',server,db,f.verify,()=>{throw Error('clock');}),kind('ControlNotDispatched'));
    await editPromptFixture(db,"CREATE TRIGGER block_origin BEFORE INSERT ON codex_session_mirror_events BEGIN SELECT RAISE(ABORT,'origin fixture'); END");await assert.rejects(executeBusyAction(f.choice,'Steer',server,db,f.verify,()=>3),e=>kind('ControlNotDispatched')(e)&&String(e).includes('origin fixture'));
    assert.deepEqual(await callPromptFixture(server,'controls'),[]);assert.equal(f.locks.activeTargetCount,0);
  },{enableResponses:true});
});
test('after-dispatch remote rejection preserves AppServer certainty rather than preflight relabeling',async()=>{
  await promptFixture(async(db,server)=>{
    const f=await setup(db,server);await assert.rejects(executeBusyAction(f.choice,'Stop',server,db,f.verify),e=>{const info=busyComponentErrorInfo(e);return info?.kind==='AppServer'&&ownedRequestFailure(info.source)?.kind==='Remote';});
    assert.equal((await callPromptFixture(server,'controls') as unknown[]).length,1);assert.equal(f.locks.activeTargetCount,0);
  },{enableResponses:true,controlFailure:true});
});
test('shared control lock delays dispatch without releasing another owner and source allowSteer flag is not invented here',async()=>{
  await promptFixture(async(db,server)=>{
    const f=await setup(db,server), held=await f.locks.acquire('t');let finished=false;
    const operation=executeBusyAction({...f.choice,allowSteer:false},'Steer',server,db,f.verify,()=>3).then(()=>{finished=true;});
    await tick();assert.equal(finished,false);assert.deepEqual(await callPromptFixture(server,'controls'),[]);held.release();await operation;
    assert.equal((await callPromptFixture(server,'controls') as unknown[]).length,1);assert.equal(f.locks.activeTargetCount,0);
  },{enableResponses:true});
});
