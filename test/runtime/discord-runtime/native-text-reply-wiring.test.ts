import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptFixture,callPromptFixture,editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {promptHttpFixture,promptHttpMessage} from '../../helpers/server-prompt-http-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {createPreparedMessageHandler,capturePreparedMessageOptions} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createPreparedHistoryOperations} from '../../../src/runtime/discord-runtime/history-bootstrap.ts';
import {createGatewayMessageHandler} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {createNativePromptAuthorityReads} from '../../../src/runtime/server-prompt-authority-reads.ts';
import {deliverMessageReplyText} from '../../../src/runtime/message-worker/reply-delivery.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {MutationOutcomeUnknownError} from '../../../src/app-server/maintenance-attempt.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
const identity={applicationId:4n,userId:9n},signal=new AbortController().signal,messageId='9007199254740993';
const input={method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',options:[{label:'One'},{label:'Two'}]}]}};
function inspect(t:TestContext){
 for(const name of ['hasObservedCompletion','listQueueJobs','listFiltered','mirroredThreadId','beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));
 const calls:string[]=[],receipts:Record<string,unknown>[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const url=String(args[0]),q=args[1] as Record<string,unknown>;if(url.endsWith('/control-evidence-native-worker.ts'))calls.push('Completed');if(url.endsWith('/native-read-state-worker.ts')&&q.operation==='List'){assert.equal(q.target,null);assert.equal(q.generation,null);calls.push('Jobs');}if(url.endsWith('/native-state-worker.ts')&&q.operation==='MirrorTarget')calls.push('Mapping');if(url.endsWith('/native-receipt-store-worker.ts')){calls.push('Begin');receipts.push(q);}return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(String(args[0]).endsWith('/native-receipt-store-worker.ts')){calls.push('Confirm');receipts.push(args[1] as Record<string,unknown>);}return complete.apply(this,args);});return {calls,receipts};
}
function verify(observed:ReturnType<typeof inspect>,id=messageId){const at=observed.calls.indexOf('Completed');assert.ok(at>=0);assert.ok(observed.calls.slice(0,at).every(x=>x==='Mapping'));assert.deepEqual(observed.calls.slice(at),['Completed','Jobs','Mapping','Begin','Confirm']);assert.ok(observed.receipts.every(q=>q.key===serializeSerdeValue([1n,'message/reply/v1',`inbound-message/${id}/pending-confirmation`,0n])&&q.guard===null));assert.equal(ownedWorkerUsage().Control,0);}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}}
for(const kind of ['approval','input'] as const)for(const route of ['message','drain','gap','poll'] as const)test(`installed ${route} ${kind} text reply retains original ingress and native reads/confirmation without repeated response`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),observed=inspect(t),body=kind==='approval'?'2':'1|two|"quoted"';
 await promptHttpFixture(async(http,seen)=>{
  if(route==='message'||route==='drain'){
   const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),message=decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,body)));
   let fence:DrainFenceKey|undefined;if(route==='drain'){fence=DrainFenceKey.create('text','1|2','worker');f.gate.seal(fence);}
   await handler(message,identity,signal);verify(observed);assert.deepEqual(f.reports,[]);const before=observed.calls.length;await handler(message,identity,signal);assert.ok(observed.calls.slice(before).every(x=>x==='Mapping'));assert.equal(seen.length,1);if(fence)assert.equal(f.gate.isDrainedFor(fence),true);
  }else{
   const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),history=createPreparedHistoryOperations(f.startup,f.gate,http,gaps,{...f.options,allowedChannelIds:new Set([1n]),startupChannelId:null,historyTargetLimits:{maxRows:128,timeoutMs:5000}});
   try{if(route==='gap'){tracker.record(1n,{timestampMicros:1577836800000000n,messageId:1n},'Full');await history.recover(identity,signal);assert.equal(gaps.snapshot().length,0);}else{const cursor=new HistoryPollState();await history.poll(cursor,identity,signal);assert.equal(cursor.isPrimed(1n),true);}verify(observed);assert.deepEqual(seen.map(x=>x.method),['GET','POST']);}finally{gaps.dispose();tracker.close();}
  }
  const row=(await state.getIngress(path,`message:${messageId}`))!;assert.equal(row.eventId,BigInt(messageId));assert.equal(row.sourceMessageId,BigInt(messageId));assert.equal(row.ownerUserId,2n);assert.equal(row.channelId,1n);assert.equal(row.targetThreadId,'t');assert.equal(row.confirmationDelivered,true);assert.deepEqual(row.outcome,{pending_reply:'handled',confirmation:kind==='approval'?'Approval response submitted: acceptForSession':'Codex input reply submitted.'});
  const posts=seen.filter(x=>x.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0]!.path,'/api/v10/channels/1/messages');assert.equal(JSON.parse(posts[0]!.body).content,(row.outcome as {confirmation:string}).confirmation);
  assert.equal(server.pendingServerRequests('t').length,0);assert.deepEqual(await callPromptFixture(server,'answers'),[{id:'approval',result:kind==='approval'?{decision:'acceptForSession'}:{answers:{q:{answers:['One','Two','"quoted"']}}}}]);
  // Receipt-only recovery remains possible after the original request is gone.
  await deliverMessageReplyText(path,http,1n,BigInt(messageId),'PendingConfirmation',(row.outcome as {confirmation:string}).confirmation,undefined,true);assert.equal(seen.filter(x=>x.method==='POST').length,1);assert.equal(observed.calls.filter(x=>x==='Completed').length,1);
 },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify([promptHttpMessage(messageId,body)]));});if(route==='drain')assert.deepEqual(f.reports,['on_message_error','on_message_error_report_failed']);else assert.ok(!f.reports.some(code=>code.includes('failed')));
},{enableResponses:true,...(kind==='input'?input:{})}));
test('gateway text reply captures native profile and original authority functions before source context changes',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),observed=inspect(t);await promptHttpFixture(async(http,seen)=>{
  const base=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),reads={...createNativePromptAuthorityReads(path)},context={...base.context,promptAuthorityReads:reads},handler=createGatewayMessageHandler({...base,context});
  context.nativePromptReceipts=false;context.promptAuthorityReads={...reads,hasObservedCompletion:async()=>assert.fail('replaced context')};reads.listQueueJobs=async()=>assert.fail('replaced function');
  await handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'1'))),identity,signal);verify(observed);assert.equal(seen.length,1);
 });
},{enableResponses:true}));
for(const failure of ['response-unknown','result-write','receipt-confirm'])test(`installed text reply ${failure} retains original ingress without duplicate response or false confirmation`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),observed=inspect(t);let responses=0;const respond=PortableResidentLifecycle.prototype.respond;
 t.mock.method(PortableResidentLifecycle.prototype,'respond',function(this:PortableResidentLifecycle,...args:Parameters<typeof respond>){responses++;return failure==='response-unknown'?Promise.reject(new MutationOutcomeUnknownError('server/response','fixture unconfirmed')):respond.apply(this,args);});
 if(failure==='result-write')await editPromptFixture(path,"CREATE TRIGGER reject_result BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture');END");
 if(failure==='receipt-confirm')await editPromptFixture(path,"CREATE TRIGGER reject_confirm BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'fixture');END");
 await promptHttpFixture(async(http,seen)=>{
  const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),message=decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'1')));await handler(message,identity,signal);const before=observed.calls.slice();await handler(message,identity,signal);assert.deepEqual(observed.calls,before);assert.equal(responses,1);
  const row=(await state.getIngress(path,`message:${messageId}`))!;assert.equal(row.state,'held');assert.equal(row.confirmationDelivered,false);assert.equal(seen.length,failure==='receipt-confirm'?1:0);assert.ok(f.reports.includes('on_message_error'));
  if(failure==='receipt-confirm'){assert.deepEqual(row.outcome,{pending_reply:'handled',confirmation:'Approval response submitted: accept'});await assert.rejects(deliverMessageReplyText(path,http,1n,BigInt(messageId),'PendingConfirmation','Approval response submitted: accept',undefined,true));assert.equal(seen.length,1);}else assert.equal(observed.calls.includes('Begin'),false);
 });assert.equal(ownedWorkerUsage().Control,0);
},{enableResponses:true}));
test('installed cancellation joins locked native authority read and retains original gateway admission/custody until exit',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),observed=inspect(t),abort=new AbortController(),reason=Error('text stop'),run=OwnedWorkerSlot.prototype.run;let blocker:DatabaseSync|undefined;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/control-evidence-native-worker.ts')&&blocker===undefined){blocker=new DatabaseSync(path);blocker.exec('BEGIN EXCLUSIVE');}return run.apply(this,args);});
 await promptHttpFixture(async(http,seen)=>{
  const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),pending=handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage(messageId,'1'))),identity,abort.signal);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
  try{await until(()=>blocker!==undefined);const fence=DrainFenceKey.create('cancel','1|2','worker');f.gate.seal(fence);abort.abort(reason);await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Control,1);assert.deepEqual(seen,[]);blocker!.exec('ROLLBACK');await assert.rejects(pending,e=>e===reason);assert.equal(f.gate.isDrainedFor(fence),true);assert.equal((await state.getIngress(path,`message:${messageId}`))!.state,'held');assert.equal(observed.calls.includes('Begin'),false);assert.deepEqual(await callPromptFixture(server,'answers'),[]);}finally{if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
 });assert.equal(ownedWorkerUsage().Control,0);
},{enableResponses:true}));
