import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handleBusyComponent} from '../../../src/runtime/component-worker/busy.ts';
import {busyComponentErrorInfo, BusyComponentError} from '../../../src/runtime/component-worker/busy-errors.ts';
import {busyActionClaimFailure, actionClaimFailure} from '../../../src/runtime/component-worker/claim-failure.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';
import {BackendFailureError, QueueIntegerRangeError} from '../../../src/runtime/queue-runner/errors.ts';
import {BusyQueueExecutor} from '../../../src/runtime/action-executor/busy-queue.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice, getBusyChoice} from '../../../src/store/busy-choice-store.ts';
import {busyReadyMarker, confirmationErrorInfo} from '../../../src/runtime/component-worker/confirmation.ts';
import type {BusyChoice} from '../../../src/store/busy-choice.ts';
import type {BusyAction, ComponentId} from '../../../src/discord/components.ts';
import {promptFixture, callPromptFixture, editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const kind=(name:string)=>(e:unknown)=>busyComponentErrorInfo(e)?.kind===name;
const component=(c:BusyChoice,action:BusyAction):ComponentId=>({Busy:{choice_id:c.choiceId,action}});
const work=(c:BusyChoice)=>({authorizedBusyChoice:c,userId:2n,channelId:1n});
async function choice(db:string,bind=true,prompt='direction') {const id=await createBusyChoice(db,{ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt,allowSteer:true,now:1,timeToLive:100});const c=(await getBusyChoice(db,id,2))!;if(bind)await state.bindBusyControl(db,id,'t','v',null);return c;}
const queue=(db:string,run=async()=>({text:'accepted',waitsForFinal:false,ui:null}))=>new BusyQueueExecutor(db,{processAdmittedPrompt:run},()=>2);
test('owned action and busy failure classifications release only definite variants',()=>{
  for(const k of ['NoTarget','IntegerRange'] as const)assert.equal(actionClaimFailure(new ActionExecutionError(k)),'Release');
  for(const ambiguous of [false,true])assert.equal(actionClaimFailure(new ActionExecutionError('Queue',new BackendFailureError({message:'fixture',ambiguous,kind:'Other'}))),ambiguous?'RetainIndeterminate':'Release');
  assert.equal(actionClaimFailure(new ActionExecutionError('Queue',new QueueIntegerRangeError())),'Release');
  for(const k of ['NoActiveTurn','ControlNotDispatched','NoTarget','SteerNotAllowed'] as const)assert.equal(busyActionClaimFailure(new BusyComponentError(k,'fixture')),'Release');
  for(const e of [{kind:'NoTarget'},Object.create(ActionExecutionError.prototype),new ActionExecutionError('Queue',Object.create(QueueIntegerRangeError.prototype)),new ActionExecutionError('Invalid','fixture')])assert.equal(actionClaimFailure(e),'RetainIndeterminate');
  assert.equal(busyActionClaimFailure(new BusyComponentError('Action',new ActionExecutionError('NoTarget'))),'Release');assert.equal(busyActionClaimFailure(new BusyComponentError('Store',new Error('fixture'))),'RetainIndeterminate');
});
test('Ignore commits claim and ready marker without control/server/queue access, then repeats only confirmation',async()=>storeFixture(async db=>{
  const c=await choice(db),plan=await handleBusyComponent(work(c),component(c,'Ignore'),db,null as any,null as any,null as any,()=>2);
  assert.equal(plan.content,'Busy action submitted.');assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,true);assert.equal(await state.isComponentClaimLive(db,busyReadyMarker(c.choiceId,2n,1n),2),true);
  assert.deepEqual(await handleBusyComponent(work(c),component(c,'Ignore'),db,null as any,null as any,null as any,()=>3),plan);
}));
test('Queue atomic intake succeeds without preclaim and repeated ready marker never reprocesses prompt',async()=>storeFixture(async db=>{
  const c=await choice(db);let calls=0;const q=queue(db,async()=>{calls++;assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,true);return {text:'accepted',waitsForFinal:false,ui:null};});
  const first=await handleBusyComponent(work(c),component(c,'Queue'),db,q,null as any,null as any,()=>2);
  assert.deepEqual(await handleBusyComponent(work(c),component(c,'Queue'),db,q,null as any,null as any,()=>3),first);assert.equal(calls,1);
}));
test('Queue preparation failure retains atomic receipt; next click returns confirmation without reprocessing',async()=>storeFixture(async db=>{
  const c=await choice(db);let calls=0;const q=queue(db,async()=>{calls++;throw Error('prepare fixture');});
  await assert.rejects(handleBusyComponent(work(c),component(c,'Queue'),db,q,null as any,null as any,()=>2),kind('Action'));
  assert.equal(await state.isComponentClaimLive(db,busyReadyMarker(c.choiceId,2n,1n),2),true);await handleBusyComponent(work(c),component(c,'Queue'),db,q,null as any,null as any,()=>3);assert.equal(calls,1);
}));
test('native Stop runs once and commits ready only after response; concurrent duplicate cannot resend',async()=>{
  await promptFixture(async(db,server)=>{
    const c=await choice(db),locks=new TargetLocks(),verify=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},locks);
    const results=await Promise.allSettled([handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>2),handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>2)]);
    assert.ok(results.some(r=>r.status==='fulfilled'));for(const r of results)if(r.status==='rejected')assert.ok(kind('ActionUnconfirmed')(r.reason));
    assert.equal((await callPromptFixture(server,'controls') as unknown[]).length,1);assert.equal(await state.isComponentClaimLive(db,busyReadyMarker(c.choiceId,2n,1n),2),true);assert.equal(locks.activeTargetCount,0);
  },{enableResponses:true});
});
test('preflight missing binding releases claim with zero controls',async()=>{
  await promptFixture(async(db,server)=>{const c=await choice(db,false),verify=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},new TargetLocks());
    await assert.rejects(handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>2),kind('ControlNotDispatched'));assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,false);assert.deepEqual(await callPromptFixture(server,'controls'),[]);
  },{enableResponses:true});
});
test('definite native remote rejection releases claim, but missing adapter uncertainty retains it',async()=>{
  await promptFixture(async(db,server)=>{const c=await choice(db),verify=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},new TargetLocks());
    await assert.rejects(handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>2),kind('AppServer'));assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,false);assert.equal((await callPromptFixture(server,'controls') as unknown[]).length,1);
  },{enableResponses:true,controlFailure:true});
  await promptFixture(async(db,server)=>{const c=await choice(db),verify=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},new TargetLocks());
    await assert.rejects(handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>2),kind('ActionOutcomeIndeterminate'));assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,true);assert.deepEqual(await callPromptFixture(server,'controls'),[]);
    await assert.rejects(handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>3),kind('ActionUnconfirmed'));
  });
});
test('failed ready persistence after native Stop preserves claimed completed action as Recovery failure',async()=>{
  await promptFixture(async(db,server)=>{const c=await choice(db),verify=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},new TargetLocks());
    await editPromptFixture(db,"CREATE TRIGGER block_ready BEFORE INSERT ON persistent_component_claims WHEN NEW.claim_key LIKE 'confirmation-ready:%' BEGIN SELECT RAISE(ABORT,'ready fixture'); END");
    await assert.rejects(handleBusyComponent(work(c),component(c,'Stop'),db,null as any,server,verify,()=>2),e=>{const info=busyComponentErrorInfo(e);return info?.kind==='Confirmation'&&confirmationErrorInfo(info.source)?.kind==='Recovery';});
    assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,true);assert.equal((await callPromptFixture(server,'controls') as unknown[]).length,1);
  },{enableResponses:true});
});
test('original snapshot and actor checks precede database access; Pro steer does not claim',async()=>storeFixture(async db=>{
  const c=await choice(db,true,'!pro fixture');
  await assert.rejects(handleBusyComponent({...work(c),authorizedBusyChoice:null},component(c,'Queue'),'/unused',null as any,null as any,null as any),kind('MissingAuthorizationSnapshot'));
  await assert.rejects(handleBusyComponent({...work(c),userId:3n},component(c,'Queue'),'/unused',null as any,null as any,null as any),kind('WrongUser'));
  await assert.rejects(handleBusyComponent(work(c),component(c,'Steer'),db,null as any,null as any,null as any,()=>2),kind('ControlNotDispatched'));assert.equal((await state.readBusyChoiceState(db,c.choiceId,2))!.claimed,false);
}));
test('expired choice stays missing and claimed-without-ready never becomes confirmation success',async()=>storeFixture(async db=>{
  const c=await choice(db);await assert.rejects(handleBusyComponent(work(c),component(c,'Ignore'),db,null as any,null as any,null as any,()=>101),kind('Missing'));
  const live=await choice(db);await state.claimBusyChoice(db,live.choiceId,2);await assert.rejects(handleBusyComponent(work(live),component(live,'Ignore'),db,null as any,null as any,null as any,()=>3),kind('ActionUnconfirmed'));
}));
test('malformed owned backend ambiguity never releases and inherited ambiguity getter is not inspected',()=>{
  const invalid=new BackendFailureError({message:'fixture',kind:'Other'} as any), wrapped=new ActionExecutionError('Queue',invalid);
  assert.equal(actionClaimFailure(wrapped),'RetainIndeterminate');
});
test('inherited ambiguity getter cannot grant queue claim release',()=>{
  const invalid=new BackendFailureError({message:'fixture',kind:'Other'} as any), wrapped=new ActionExecutionError('Queue',invalid);
  const prior=Object.getOwnPropertyDescriptor(Object.prototype,'ambiguous');let hooks=0,result:unknown;
  const descriptor=Object.assign(Object.create(null),{get(){hooks++;return false;},configurable:true});
  Object.defineProperty(Object.prototype,'ambiguous',descriptor);
  try {result=actionClaimFailure(wrapped);} finally {if(prior)Object.defineProperty(Object.prototype,'ambiguous',prior);else delete (Object.prototype as any).ambiguous;}
  assert.equal(hooks,0);assert.equal(result,'RetainIndeterminate');
});
