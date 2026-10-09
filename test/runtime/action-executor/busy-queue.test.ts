import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BusyQueueExecutor} from '../../../src/runtime/action-executor/busy-queue.ts';
import {actionExecutionErrorInfo} from '../../../src/runtime/action-executor/action-error.ts';
import {busyReadyMarker} from '../../../src/runtime/component-worker/confirmation.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice, getBusyChoice, readBusyChoiceState} from '../../../src/store/busy-choice-store.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import type {StoredPromptIntake} from '../../../src/store/prompt-intake.ts';
async function choice(db:string,mapped=false){if(mapped)await edit(db,"INSERT INTO mirror_threads VALUES ('t','p','T',10,1,1)");const id=await createBusyChoice(db,{ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt:'original prompt',allowSteer:false,now:1,timeToLive:100});return (await getBusyChoice(db,id,2))!;}
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql);}finally{db.close();}}
async function count(path:string){const db=await openInitialized(path);try{return db.prepare('SELECT COUNT(*) AS n FROM codex_prompt_intakes').get()!.n;}finally{db.close();}}
const result={text:'accepted',waitsForFinal:true,ui:null};
const kind=(k:string)=>(e:unknown)=>actionExecutionErrorInfo(e)?.kind===k;
test('Queue intake and ready marker are durable before preparation, with original actor/route and automatic queue flag',async()=>{
  for(const mapped of [false,true])await storeFixture(async db=>{const c=await choice(db,mapped),calls:StoredPromptIntake[]=[];
    const executor=new BusyQueueExecutor(db,{async processAdmittedPrompt(intake){calls.push(intake);assert.equal(await state.isComponentClaimLive(db,busyReadyMarker(c.choiceId,2n,1n),2),true);assert.equal((await readBusyChoiceState(db,c.choiceId,2))!.claimed,true);return result;}},()=>2);
    assert.deepEqual(await executor.enqueueBusyChoice(c),result);assert.equal(calls.length,1);const i=calls[0]!;assert.equal(i.targetThreadId,'t');assert.equal(i.ownerUserId,2n);assert.equal(i.channelId,1n);assert.equal(i.rawPrompt,'original prompt');assert.equal(i.autoQueueWhenBusy,true);assert.equal(i.requireCurrentMirror,mapped);assert.equal(i.discordMessageId,null);
  });
});
test('repeat receipt returns no-duplicate result and never invokes prompt processing again',async()=>storeFixture(async db=>{
  const c=await choice(db);let calls=0;const e=new BusyQueueExecutor(db,{async processAdmittedPrompt(){calls++;return result;}},()=>2);
  await e.enqueueBusyChoice(c);const repeated=await e.enqueueBusyChoice(c);assert.equal(calls,1);assert.equal(await count(db),1);assert.equal(repeated.waitsForFinal,false);assert.equal(repeated.text,`This busy request was already accepted; no duplicate was queued.\njob_id: busy-choice:${c.choiceId}`);
}));
test('concurrent Queue clicks commit one intake and only one preparation',async()=>storeFixture(async db=>{
  const c=await choice(db);let calls=0;const e=new BusyQueueExecutor(db,{async processAdmittedPrompt(){calls++;return result;}},()=>2);await Promise.all([e.enqueueBusyChoice(c),e.enqueueBusyChoice(c)]);assert.equal(calls,1);assert.equal(await count(db),1);
}));
test('changed mirror route fails atomically before preparation and does not claim choice',async()=>storeFixture(async db=>{
  const c=await choice(db,true);await edit(db,"UPDATE mirror_threads SET codex_thread_id='other'");let calls=0;const e=new BusyQueueExecutor(db,{async processAdmittedPrompt(){calls++;return result;}},()=>2);
  await assert.rejects(e.enqueueBusyChoice(c),kind('Store'));assert.equal(calls,0);assert.equal((await readBusyChoiceState(db,c.choiceId,2))!.claimed,false);assert.equal(await count(db),0);
}));
test('post-admission preparation failure keeps recoverable intake and receipt, and retry does not execute again',async()=>storeFixture(async db=>{
  const c=await choice(db),sentinel=new Error('preparation fixture');let calls=0;const e=new BusyQueueExecutor(db,{async processAdmittedPrompt(){calls++;throw sentinel;}},()=>2);
  await assert.rejects(e.enqueueBusyChoice(c),e=>e===sentinel);assert.equal(await count(db),1);assert.equal(await state.isComponentClaimLive(db,busyReadyMarker(c.choiceId,2n,1n),2),true);
  assert.match((await e.enqueueBusyChoice(c)).text,/already accepted/);assert.equal(calls,1);
}));
test('missing target and negative actor identity never begin preparation',async()=>storeFixture(async db=>{
  const c=await choice(db),e=new BusyQueueExecutor(db,{async processAdmittedPrompt(){throw Error('unexpected');}},()=>2);
  await assert.rejects(e.enqueueBusyChoice({...c,targetThreadId:null}),kind('NoTarget'));await assert.rejects(e.enqueueBusyChoice({...c,ownerUserId:-1n}),kind('IntegerRange'));assert.equal(await count(db),0);
}));
test('expired unchanged choice fails; supplied callback and input snapshots stay pinned',async()=>storeFixture(async db=>{
  const c=await choice(db),processor={async processAdmittedPrompt(){return result;}};const e=new BusyQueueExecutor(db,processor,()=>2);processor.processAdmittedPrompt=async()=>{throw Error('changed');};
  const operation=e.enqueueBusyChoice(c);c.prompt='mutated';assert.deepEqual(await operation,result);
  const other=await choice(db),late=new BusyQueueExecutor(db,processor,()=>101);await assert.rejects(late.enqueueBusyChoice(other),kind('Store'));
}));
