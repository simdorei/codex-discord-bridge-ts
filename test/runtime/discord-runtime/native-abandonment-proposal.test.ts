import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {gatewayPolicyFixture as fixture,consume,publish,message,messageId,identity,signal,until} from '../../helpers/gateway-policy-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {getIngressExisting} from '../../../src/store/ingress-read.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {RuntimeGatewayIdentityConflictError} from '../../../src/runtime/discord-runtime/identity-wait.ts';
import {createPreparedHistoryOperations} from '../../../src/runtime/discord-runtime/history-bootstrap.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
const job='550e8400-e29b-41d4-a716-446655440000',extension=import.meta.url.endsWith('.js')?'.js':'.ts';
type Context=Parameters<Parameters<typeof fixture>[0]>[0];
function seed(c:Context){const db=new DatabaseSync(c.f.path);try{db.prepare("UPDATE codex_turn_queue SET job_id=?,state='pending',turn_id=NULL,discord_message_id=7,app_server_generation=1 WHERE job_id='job'").run(job);db.exec("INSERT INTO codex_app_server_runtime VALUES(1,'app');INSERT INTO codex_mutation_runtime VALUES(1,'wire')");db.prepare("INSERT INTO cdr_async_recovery_policies VALUES('t',1,'publishing_recovery',?,'turn','origin',?)").run('a'.repeat(64),job);}finally{db.close();}}
function poison(t:TestContext){for(const name of ['abandonmentCommandTarget','getIngress','proposeAbandonment','bindAbandonmentDelivery','beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery','admitIngress','beginIngressExecution','recordIngressResult','confirmIngress','holdIngress'] as const)t.mock.method(state,name,()=>assert.fail('compatibility '+name));}
function count(c:Context,table:string){const db=new DatabaseSync(c.f.path,{readOnly:true});try{return db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n;}finally{db.close();}}
function isProposal(args:Parameters<OwnedWorkerSlot['run']>,operation:string){return String(args[0]).endsWith('/abandonment-proposal-native-worker.ts')&&(args[1] as any).operation===operation;}
const posts=(c:Context)=>c.seen.filter(r=>r.method==='POST').length;

for(const route of ['gateway','history'] as const)test(`installed ${route} abandonment uses native route, proposal, receipts, binding and original result with poisoned facade`,async t=>fixture(async c=>{
 seed(c);poison(t);const event=message(messageId,'!discard-request '+job);
 if(route==='gateway')await c.handler(event,identity,signal());else{c.page.push(JSON.parse(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:event.content,embeds:[],id:String(event.id),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false,type:0})));const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),history=createPreparedHistoryOperations(c.f.startup,c.f.gate,c.http,gaps,{...c.f.options,allowedChannelIds:new Set([1n]),startupChannelId:null,historyPolicyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},historyTargetLimits:{maxRows:128,timeoutMs:5000}});try{tracker.record(1n,{timestampMicros:1577836799000000n,messageId:1n},'Full');await history.recover(identity,signal());}finally{gaps.dispose();tracker.close();}}
 assert.equal(posts(c),1);assert.equal(count(c,'cdr_recovery_abandonment_proposals'),1);assert.equal(count(c,'cdr_recovery_abandonment_deliveries'),1);assert.equal(count(c,'cdr_recovery_abandonment_decisions'),0);assert.equal(getIngressExisting(c.f.path,`message:${messageId}`)!.confirmationDelivered,true);assert.equal(c.f.queue.locks.activeTargetCount,0);assert.equal(c.clock.deadlines.length,0);
}));

for(const stage of ['Prepare','ReceiptConfirm','Bind','Result','Confirm'] as const)test(`installed unconfirmed ${stage} logs only and never emits an ERROR POST or retries admission`,async t=>fixture(async c=>{
 seed(c);poison(t);let admissions=0,mutations=0;const ordinary=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof ordinary>){if(String(args[0]).endsWith('/native-journal-worker.ts')&&(args[1] as any).operation==='Admit')admissions++;const raw=await ordinary.apply(this,args);if(stage==='Prepare'&&isProposal(args,'Prepare')){mutations++;return {ok:false};}return raw;});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',async function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){const raw=await complete.apply(this,args);if((stage==='Result'||stage==='Confirm')&&String(args[0]).endsWith('/native-journal-worker.ts')&&(args[1] as any).operation===stage||stage==='Bind'&&isProposal(args,'Bind')||stage==='ReceiptConfirm'&&String(args[0]).endsWith('/native-receipt-store-worker.ts')&&(args[1] as any).operation==='Confirm'){mutations++;return {ok:false};}return raw;});
 await c.handler(message(messageId,'!discard-request '+job),identity,signal());assert.equal(posts(c),stage==='Prepare'?0:1);assert.equal(mutations,1);assert.equal(admissions,1);assert.equal(count(c,'cdr_recovery_abandonment_proposals'),1);assert.equal(count(c,'cdr_recovery_abandonment_deliveries'),['Bind','Result','Confirm'].includes(stage)?1:0);assert.equal(getIngressExisting(c.f.path,`message:${messageId}`)!.state,'held');assert.equal(c.clock.deadlines.length,0);assert.deepEqual(c.f.reports,['on_message_error']);
}));

for(const stage of ['Prepare','ReceiptConfirm','Bind'] as const)for(const stop of ['shutdown','force','conflict'] as const)test(`installed ${stop} during stalled ${stage} retains accepted original, admission and lease through actual exit`,async t=>fixture(async c=>{
 seed(c);poison(t);const trace=new SharedArrayBuffer(8),method=stage==='Prepare'?'run':'runControlCompletion',base=OwnedWorkerSlot.prototype[method];let restore:()=>void=()=>{};
 t.mock.method(OwnedWorkerSlot.prototype,method,function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){if(stage==='ReceiptConfirm'?String(args[0]).endsWith('/native-receipt-store-worker.ts')&&(args[1] as any).operation==='Confirm':isProposal(args,stage)){restore=instrumentStoreWorker({match:(stage==='ReceiptConfirm'?'native-receipt-store-worker':'abandonment-proposal-native-worker')+extension,trace});}return base.apply(this,args);});
 publish(c.owner,message(messageId,'!discard-request '+job));const consumer=consume(c.owner,c.handler),reason=Error('force proposal');let settled=false;void consumer.pending.then(()=>settled=true,()=>settled=true);
 try{await waitTrace(trace);const fence=DrainFenceKey.create('proposal-stalled','1|2','test');c.f.gate.seal(fence);assert.equal(c.f.gate.isDrainedFor(fence),false);assert.equal(c.owner.acceptedMessageView().size,1);
  if(stop==='shutdown')consumer.stop.abort();else if(stop==='force')consumer.force.abort(reason);else c.owner.publish({kind:'Ready',identity:{userId:19n,applicationId:14n}},2);
  await new Promise(r=>setTimeout(r,50));assert.equal(settled,false);assert.equal(c.owner.acceptedMessageView().size,1);assert.equal(c.f.gate.isDrainedFor(fence),false);assert.equal(c.f.queue.locks.activeTargetCount,1);assert.equal(ownedWorkerUsage().Control,1);
  restore();releaseTrace(trace);if(stop==='shutdown')await consumer.pending;else await assert.rejects(consumer.pending,e=>stop==='force'?e===reason:e instanceof RuntimeGatewayIdentityConflictError);
  assert.equal(c.owner.acceptedMessageView().size,0);assert.equal(c.f.gate.isDrainedFor(fence),true);assert.equal(c.f.queue.locks.activeTargetCount,0);assert.equal(posts(c),stage==='Prepare'?0:1);assert.equal(count(c,'cdr_recovery_abandonment_deliveries'),stage==='Prepare'?0:1);assert.equal(getIngressExisting(c.f.path,`message:${messageId}`)!.confirmationDelivered,stage!=='Prepare');assert.deepEqual(c.clock.deadlines,[]);
 }finally{restore();releaseTrace(trace);await consumer.pending.catch(()=>{});consumer.dispose();}
}));

test('installed mapping changes during target lock wait refuse preparation without retargeting',async t=>fixture(async c=>{
 seed(c);const lease=await c.f.queue.locks.acquire('t'),base=OwnedWorkerSlot.prototype.run;let routed=false;t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){const raw=await base.apply(this,args);if(isProposal(args,'Route'))routed=true;return raw;});
 const pending=c.handler(message(messageId,'!discard-request '+job),identity,signal());try{await until(()=>routed);const db=new DatabaseSync(c.f.path);db.exec("UPDATE mirror_threads SET discord_thread_id=99 WHERE codex_thread_id='t'");db.close();lease.release();await pending;assert.equal(count(c,'cdr_recovery_abandonment_proposals'),0);assert.equal(posts(c),0);assert.equal(c.f.queue.locks.activeTargetCount,0);assert.equal(getIngressExisting(c.f.path,`message:${messageId}`)!.state,'held');}finally{lease.release();await pending;}
}));
