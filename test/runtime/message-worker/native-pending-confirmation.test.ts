import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {NativeCompletionReceiptStore,CompletionReceiptUnconfirmedError} from '../../../src/runtime/completion/native-receipt-store.ts';
import {deliverMessageReplyText as deliver} from '../../../src/runtime/message-worker/reply-delivery.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {DiscordTransportFault} from '../../../src/discord/transport-fault.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {promptHttpFixture} from '../../helpers/server-prompt-http-fixture.ts';
const confirmation='Codex input reply submitted.',source=9007199254740993n;
const key=(id=source,index=0n,domain='message/reply/v1',channel=1n)=>serializeSerdeValue([channel,domain,`inbound-message/${id}/pending-confirmation`,index]);
const hash=receiptHash(confirmation);
function poison(t:TestContext){for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));}
async function initialize(path:string){const db=await openInitialized(path);db.close();}
function rows(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT receipt_key,content_hash,message_id,retryable,blocked_reason FROM codex_delivery_receipts ORDER BY receipt_key').all();}finally{db.close();}}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}}
test('native pending receipt profile permits only canonical original u64 source message, null guard and part zero',async()=>{
 const claim={jobId:'job',threadId:'t',turnId:'v'};
 for(const id of [1n,source,(1n<<64n)-1n])assert.doesNotThrow(()=>new NativeCompletionReceiptStore('/unused',key(id),hash,null));
 for(const bad of [key(0n),key(-1n),key(1n<<64n),key(source,1n),key(source,0n,'message/error/v1'),serializeSerdeValue([1n,'message/reply/v1','inbound-message/01/pending-confirmation',0n]),serializeSerdeValue([1n,'message/reply/v1',`inbound-message/${source}/action-result`,0n]),serializeSerdeValue([1n,'message/reply/v1',`inbound-message/${source}/pending-confirmation/extra`,0n])])assert.throws(()=>new NativeCompletionReceiptStore('/unused',bad,hash,null),TypeError);
 assert.throws(()=>new NativeCompletionReceiptStore('/unused',key(),hash,claim),TypeError);
 const owner=new NativeCompletionReceiptStore('/unused',key(),hash,null);await assert.rejects(owner.begin(key(source+1n),hash,null),/original chunk/);await assert.rejects(owner.begin(key(),receiptHash('changed'),null),/original chunk/);await assert.rejects(owner.begin(key(),hash,claim),/guard differs/);
});
test('native pending helper refuses broad kinds, invalid flags and extra parts before any receipt or HTTP',()=>storeFixture(async path=>{
 await initialize(path);await promptHttpFixture(async(http,seen)=>{
  for(const kind of ['PlannedResponse','ActionResult','SavedRequest','ErrorReport'] as const)await assert.rejects(deliver(path,http,1n,source,kind,confirmation,undefined,true),TypeError);
  await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,1 as never),TypeError);
  await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation','x'.repeat(5000),undefined,true),TypeError);assert.deepEqual(seen,[]);assert.deepEqual(rows(path),[]);
 });
}));
test('native pending confirmation preserves exact source key, content, nonce and confirmed-only recovery without another send',async t=>storeFixture(async path=>{
 await initialize(path);poison(t);await promptHttpFixture(async(http,seen)=>{
  assert.equal(await deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true),1);const first=rows(path)[0]!;assert.equal(first.receipt_key,key());assert.equal(first.content_hash,hash);assert.equal(first.message_id,'901');
  await deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true);assert.equal(seen.length,1);await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation','different',undefined,true),e=>e instanceof DeliveryFailure&&String(e.source).includes('content changed'));assert.equal(seen.length,1);
  await deliver(path,http,1n,source+1n,'PendingConfirmation',confirmation,undefined,true);assert.equal(seen.length,2);assert.notEqual(JSON.parse(seen[0]!.body).nonce,JSON.parse(seen[1]!.body).nonce);assert.deepEqual(rows(path).map(r=>r.receipt_key),[key(),key(source+1n)]);
 });assert.equal(ownedWorkerUsage().Control,0);
}));
for(const status of [400,429,503])test(`native pending ${status} keeps blocked/release/unknown semantics and never automatically retries`,async t=>storeFixture(async path=>{
 await initialize(path);poison(t);const send=DiscordChannelClient.prototype.sendValidated,bodies:string[]=[];
 t.mock.method(DiscordChannelClient.prototype,'sendValidated',function(this:DiscordChannelClient,...args:Parameters<typeof send>){bodies.push(args[0].body);if(bodies.length===1)return Promise.reject(new DiscordTransportFault('Response','fixture rejection',status));return send.apply(this,args);});
 await promptHttpFixture(async(http,seen)=>{
  await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true),DeliveryFailure);assert.equal(bodies.length,1);assert.equal(seen.length,0);const row=rows(path)[0]!;assert.equal(row.message_id,null);assert.equal(row.retryable,status===429?1:0);assert.equal(row.blocked_reason!==null,status===400);
  if(status===429){await deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true);assert.equal(bodies[0],bodies[1]);assert.equal(seen.length,1);assert.equal(rows(path)[0]!.message_id,'901');}else{await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true),DeliveryFailure);assert.equal(bodies.length,1);assert.deepEqual(seen,[]);}
 });assert.equal(ownedWorkerUsage().Control,0);
}));
test('native accepted pending receipt with failed confirm remains unknown and does not resend',async t=>storeFixture(async path=>{
 await initialize(path);const db=new DatabaseSync(path);db.exec("CREATE TRIGGER reject_confirm BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'fixture');END");db.close();poison(t);
 await promptHttpFixture(async(http,seen)=>{await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true),e=>e instanceof DeliveryFailure&&e.source instanceof CompletionReceiptUnconfirmedError);await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true),DeliveryFailure);assert.equal(seen.length,1);assert.equal(rows(path)[0]!.message_id,null);});assert.equal(ownedWorkerUsage().Control,0);
}));
test('native cancellation after Begin acknowledgement leaves unknown intent and no send or automatic replay',async t=>storeFixture(async path=>{
 await initialize(path);poison(t);const abort=new AbortController(),run=OwnedWorkerSlot.prototype.run;let begins=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(String(args[0]).endsWith('/native-receipt-store-worker.ts')&&++begins===1)return pending.then(value=>{abort.abort(Error('after begin'));return value;});return pending;});
 await promptHttpFixture(async(http,seen)=>{await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,abort.signal,true),DeliveryFailure);await assert.rejects(deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true),DeliveryFailure);assert.deepEqual(seen,[]);assert.equal(rows(path)[0]!.message_id,null);});assert.equal(ownedWorkerUsage().Control,0);
}));
test('accepted pending confirmation joins blocked native commit despite cancellation and releases only after actual exit',async t=>storeFixture(async path=>{
 await initialize(path);poison(t);const abort=new AbortController(),send=DiscordChannelClient.prototype.sendValidated,complete=OwnedWorkerSlot.prototype.runControlCompletion;let blocker:DatabaseSync|undefined,confirming=false;
 t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){const result=await send.apply(this,args);blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');abort.abort(Error('accepted cancellation'));return result;});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(String(args[0]).endsWith('/native-receipt-store-worker.ts'))confirming=true;return complete.apply(this,args);});
 await promptHttpFixture(async(http,seen)=>{
  const pending=deliver(path,http,1n,source,'PendingConfirmation',confirmation,abort.signal,true);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
  try{await until(()=>confirming);await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(seen.length,1);blocker!.exec('ROLLBACK');assert.equal(await pending,1);assert.equal(rows(path)[0]!.message_id,'901');await deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,true);assert.equal(seen.length,1);}finally{if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
 });assert.equal(ownedWorkerUsage().Control,0);
}));
test('omitted and false pending profiles preserve direct compatibility receipt methods',async t=>storeFixture(async path=>{
 await initialize(path);let calls=0;const original=state.beginDeliveryReceipt;t.mock.method(state,'beginDeliveryReceipt',(...args:Parameters<typeof original>)=>{calls++;return original(...args);});
 await promptHttpFixture(async(http,seen)=>{await deliver(path,http,1n,source,'PendingConfirmation',confirmation);await deliver(path,http,1n,source,'PendingConfirmation',confirmation,undefined,false);assert.equal(calls,2);assert.equal(seen.length,1);});
}));
