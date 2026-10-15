import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptFixture,callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {promptHttpFixture,promptHttpMessage} from '../../helpers/server-prompt-http-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {capturePreparedMessageOptions,createPreparedMessageHandler} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createPreparedHistoryOperations} from '../../../src/runtime/discord-runtime/history-bootstrap.ts';
import {createGatewayMessageHandler} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
const identity={applicationId:4n,userId:9n},messageId='9007199254740993',key=`message:${messageId}`;
function inspect(t:TestContext,receipts=true){
 for(const name of ['admitIngress','recordIngressProcessingMode','beginIngressExecution','recordIngressResult','confirmIngress','holdIngress',...(receipts?['beginDeliveryReceipt','confirmDeliveryReceipt'] as const:[])] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));
 const order:string[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion,respond=PortableResidentLifecycle.prototype.respond;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as Record<string,unknown>;if(String(args[0]).endsWith('/native-journal-worker.ts')){assert.equal(q.id,key);assert.ok(['Admit','Mode','Begin'].includes(q.operation as string));order.push(q.operation as string);}if(String(args[0]).endsWith('/native-receipt-store-worker.ts')){assert.equal(q.key,serializeSerdeValue([1n,'message/reply/v1',`inbound-message/${messageId}/pending-confirmation`,0n]));order.push('ReceiptBegin');}return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){const q=args[1] as Record<string,unknown>;if(String(args[0]).endsWith('/native-journal-worker.ts')){assert.equal(q.id,key);order.push(q.operation as string);}if(String(args[0]).endsWith('/native-receipt-store-worker.ts'))order.push('ReceiptConfirm');return complete.apply(this,args);});
 t.mock.method(PortableResidentLifecycle.prototype,'respond',async function(this:PortableResidentLifecycle,...args:Parameters<typeof respond>){const result=await respond.apply(this,args);order.push('Responded');return result;});return order;
}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}}
for(const route of ['gateway','drain','gap','poll'] as const)test(`installed ${route} journal is native with exact response/result/receipt/confirmation order`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t);await promptHttpFixture(async(http,seen)=>{
  const signal=new AbortController().signal;
  if(route==='gateway'||route==='drain'){
   const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),message=decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'1')));
   if(route==='drain')f.gate.seal(DrainFenceKey.create('journal','1|2','worker'));
   await handler(message,identity,signal);
  }else{
   const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),history=createPreparedHistoryOperations(f.startup,f.gate,http,gaps,{...f.options,allowedChannelIds:new Set([1n]),startupChannelId:null,historyTargetLimits:{maxRows:128,timeoutMs:5000}});
   try{if(route==='gap'){tracker.record(1n,{timestampMicros:1577836800000000n,messageId:1n},'Full');await history.recover(identity,signal);}else await history.poll(new HistoryPollState(),identity,signal);}finally{gaps.dispose();tracker.close();}
  }
  assert.deepEqual(order,['Admit',...(route==='drain'?['Mode']:[]),'Begin','Responded','Result','ReceiptBegin','ReceiptConfirm','Confirm']);
  const row=(await state.getIngress(path,key))!;assert.equal(row.eventId,BigInt(messageId));assert.equal(row.sourceMessageId,BigInt(messageId));assert.equal(row.ownerUserId,2n);assert.equal(row.confirmationDelivered,true);assert.deepEqual(row.outcome,{pending_reply:'handled',confirmation:'Approval response submitted: accept'});assert.equal(seen.filter(x=>x.method==='POST').length,1);assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
 },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify([promptHttpMessage(messageId,'1')]));});assert.equal(ownedWorkerUsage().Control,0);
},{enableResponses:true}));
test('installed handler captures original journal port before context and function mutation',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t);await promptHttpFixture(async(http)=>{
  const base=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),context={...base.context},handler=createGatewayMessageHandler({...base,context});
  assert.equal(Object.isFrozen(context.messageJournal),true);context.messageJournal={...context.messageJournal!,admitIngress:async()=>assert.fail('replaced admission'),beginIngressExecution:async()=>assert.fail('replaced begin')};
  await handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'1'))),identity,new AbortController().signal);assert.equal((await state.getIngress(path,key))!.confirmationDelivered,true);assert.ok(order.includes('Responded'));
 });
},{enableResponses:true}));
for(const at of ['response','receipt'] as const)test(`cancellation after accepted ${at} retains required persistence and original permit through locked native exit`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),abort=new AbortController(),reason=Error('cancel accepted'),respond=PortableResidentLifecycle.prototype.respond,send=DiscordChannelClient.prototype.sendValidated;let blocker:DatabaseSync|undefined;
 const lock=()=>{blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');abort.abort(reason);};
 if(at==='response')t.mock.method(PortableResidentLifecycle.prototype,'respond',async function(this:PortableResidentLifecycle,...args:Parameters<typeof respond>){const value=await respond.apply(this,args);lock();return value;});
 else t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){const value=await send.apply(this,args);lock();return value;});
 await promptHttpFixture(async(http,seen)=>{
  const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),pending=handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'1'))),identity,abort.signal);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
  try{await until(()=>blocker!==undefined&&order.includes(at==='response'?'Result':'ReceiptConfirm'));const fence=DrainFenceKey.create('cancel','1|2','worker');f.gate.seal(fence);await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Control,1);blocker!.exec('ROLLBACK');await assert.rejects(pending,e=>e===reason);assert.equal(f.gate.isDrainedFor(fence),true);
   const row=(await state.getIngress(path,key))!;assert.deepEqual(row.outcome,{pending_reply:'handled',confirmation:'Approval response submitted: accept'});assert.equal(row.confirmationDelivered,at==='receipt');assert.equal(seen.length,at==='receipt'?1:0);assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
  }finally{if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
 });assert.equal(ownedWorkerUsage().Control,0);
},{enableResponses:true}));
test('cancellation during joined native Begin does not dispatch a new action or response',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),abort=new AbortController(),reason=Error('cancel begin'),run=OwnedWorkerSlot.prototype.run;let blocker:DatabaseSync|undefined;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as Record<string,unknown>;if(String(args[0]).endsWith('/native-journal-worker.ts')&&q.operation==='Begin'){blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');}return run.apply(this,args);});
 await promptHttpFixture(async(http,seen)=>{
  const base=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),handler=createGatewayMessageHandler({...base,context:{...base.context,services:{...base.context.services,executeWithIngressContext:async()=>assert.fail('action after cancelled begin')}}});
  const pending=handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'!help'))),identity,abort.signal);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
  try{await until(()=>blocker!==undefined);const fence=DrainFenceKey.create('cancel','1|2','worker');f.gate.seal(fence);abort.abort(reason);await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);blocker!.exec('ROLLBACK');await assert.rejects(pending,e=>e===reason);assert.equal(f.gate.isDrainedFor(fence),true);assert.deepEqual(seen,[]);assert.deepEqual(order,['Admit','Begin','Hold']);assert.equal((await state.getIngress(path,key))!.state,'held');assert.deepEqual(await callPromptFixture(server,'answers'),[]);}finally{if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
 });
},{enableResponses:true}));
for(const failure of ['delivery','confirmation','cancel'] as const)test(`installed cleanup ${failure} persists known result and joined holds through original native custody`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t,false),abort=new AbortController(),reason=Error('cancel known refusal');let executions=0,sends=0;
 if(failure==='confirmation'){const db=new DatabaseSync(path);db.exec("CREATE TRIGGER fail_confirmation BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();}
 if(failure==='delivery')t.mock.method(DiscordChannelClient.prototype,'sendValidated',async()=>{sends++;throw Error('unconfirmed HTTP');});
 await promptHttpFixture(async(http,seen)=>{
  const base=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),handler=createGatewayMessageHandler({...base,context:{...base.context,services:{...base.context.services,executeWithIngressContext:async()=>{executions++;if(failure==='cancel')abort.abort(reason);throw new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'queued requests'));}}}}),message=decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'!help')));
  if(failure==='cancel')await assert.rejects(handler(message,identity,abort.signal),e=>e===reason);else await handler(message,identity,abort.signal);
  const row=(await state.getIngress(path,key))!;assert.equal(row.state,'held');assert.equal(row.confirmationDelivered,false);assert.equal((row.outcome as any).kind,'mirror_cleanup_refused');assert.equal((row.outcome as any).earlier_changes_possible,true);
  assert.deepEqual(order,['Admit','Begin','Result',...(failure==='confirmation'?['Confirm']:[]),'Hold','Hold']);assert.equal(executions,1);assert.equal(seen.length,failure==='confirmation'?1:0);assert.equal(sends,failure==='delivery'?1:0);
  await handler(message,identity,new AbortController().signal);assert.equal(executions,1);assert.equal(order.at(-1),'Admit');assert.equal(ownedWorkerUsage().Control,0);
 });
},{enableResponses:true}));
