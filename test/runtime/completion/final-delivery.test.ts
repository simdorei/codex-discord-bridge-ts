import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {newReply} from "../../helpers/delivery-custody.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {selectDelivery,type StoredDelivery} from "../../../src/store/delivery.ts";
import {deliverFinal,attemptAllFinals,CompletionChunkFailure,CompletionChannelIdError,type FinalDeliveryOptions} from "../../../src/runtime/completion/final-delivery.ts";
import {DiscordTransportFault,isCompletionHeld} from "../../../src/runtime/completion/receipt-sender.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function seed(path:string,content="final",channel=1n):Promise<StoredDelivery>{return edit(path,db=>{
  db.prepare("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('d','job','target','turn',?,?,1,1)").run(channel,content);return selectDelivery(db,"d");
});}
function options(send:FinalDeliveryOptions["transport"]["sendValidated"]):FinalDeliveryOptions{return {transport:{sendValidated:send},failures:{render:()=>"safe failure"},now:()=>123};}
const count=(path:string,table:string)=>edit(path,db=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
test("final chunks confirm receipts before retiring outbox",async()=>storeFixture(async path=>{
  const pending=await seed(path,"x".repeat(2100));const nonces:string[]=[];
  await deliverFinal(path,pending,options(async request=>{assert.equal(await count(path,"codex_delivery_outbox"),1);const body=JSON.parse(request.body);nonces.push(String(body.nonce));return BigInt(100+nonces.length);}));
  assert.equal(nonces.length,2);assert.notEqual(nonces[0],nonces[1]);assert.equal(await count(path,"codex_delivery_outbox"),0);assert.equal(await count(path,"codex_delivery_receipts"),2);
}));
test("partial rejection retries only unfinished receipt with stable nonce on next invocation",async()=>storeFixture(async path=>{
  const pending=await seed(path,"x".repeat(2100));const seen:string[]=[];let reject=true;
  const opts=options(async request=>{seen.push(String(JSON.parse(request.body).nonce));if(reject&&seen.length===2)throw new DiscordTransportFault("Response","rate limit",429);return 100n;});
  await assert.rejects(deliverFinal(path,pending,opts),CompletionChunkFailure);
  const stored=await edit(path,db=>selectDelivery(db,"d"));assert.equal(stored.attemptCount,1n);assert.equal(stored.updatedAt,123);assert.equal(stored.lastError,"safe failure");
  reject=false;await deliverFinal(path,stored,opts);assert.equal(seen.length,3);assert.equal(seen[1],seen[2]);assert.equal(await count(path,"codex_delivery_outbox"),0);
}));
test("ambiguous transport stays held across later final invocations without another POST",async()=>storeFixture(async path=>{
  const pending=await seed(path);let calls=0;const opts=options(async()=>{calls++;throw new DiscordTransportFault("Transport","lost reply");});
  await assert.rejects(deliverFinal(path,pending,opts));await assert.rejects(deliverFinal(path,pending,opts));assert.equal(calls,1);
  assert.equal((await edit(path,db=>selectDelivery(db,"d"))).attemptCount,2n);assert.equal(await count(path,"codex_delivery_outbox"),1);
}));
test("Held preflight leaves attempts and failure clock untouched",async()=>storeFixture(async path=>{
  await newReply(path);const pending=await seed(path,"final",2n);let calls=0;
  await assert.rejects(deliverFinal(path,pending,{transport:{async sendValidated(){calls++;return 1n;}},failures:{render(){calls++;return "bad";}},now(){calls++;return 1;}}),isCompletionHeld);
  assert.equal(calls,0);assert.equal((await edit(path,db=>selectDelivery(db,"d"))).attemptCount,0n);assert.equal(await count(path,"codex_delivery_receipts"),0);
}));
test("commentary barrier records failure but creates no receipt",async()=>storeFixture(async path=>{
  const pending=await seed(path);await edit(path,db=>db.exec("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('commentary','job','target','turn',1,'progress')"));let calls=0;
  await assert.rejects(deliverFinal(path,pending,options(async()=>{calls++;return 1n;})),/earlier undelivered progress/);
  assert.equal(calls,0);assert.equal(await count(path,"codex_delivery_receipts"),0);assert.equal((await edit(path,db=>selectDelivery(db,"d"))).attemptCount,1n);
}));
test("invalid signed channel records failure before transport",async()=>storeFixture(async path=>{
  const pending=await seed(path,"final",0n);let calls=0;await assert.rejects(deliverFinal(path,pending,options(async()=>{calls++;return 1n;})),CompletionChannelIdError);assert.equal(calls,0);
}));
test("receipt commit failure keeps intent unknown and outbox pending",async()=>storeFixture(async path=>{
  const pending=await seed(path);await edit(path,db=>db.exec("CREATE TRIGGER ignore_receipt BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(IGNORE); END"));let calls=0;const opts=options(async()=>{calls++;return 9n;});
  await assert.rejects(deliverFinal(path,pending,opts));await assert.rejects(deliverFinal(path,pending,opts));assert.equal(calls,1);assert.equal(await count(path,"codex_delivery_outbox"),1);
}));
test("outbox retirement failure is not a send failure, confirmed receipt skips retry POST",async()=>storeFixture(async path=>{
  const pending=await seed(path);await edit(path,db=>db.exec("CREATE TRIGGER no_retire BEFORE DELETE ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'retain final'); END"));let calls=0;const opts=options(async()=>{calls++;return 9n;});
  await assert.rejects(deliverFinal(path,pending,opts),/retain final/);assert.equal((await edit(path,db=>selectDelivery(db,"d"))).attemptCount,0n);
  await edit(path,db=>db.exec("DROP TRIGGER no_retire"));await deliverFinal(path,pending,opts);assert.equal(calls,1);assert.equal(await count(path,"codex_delivery_outbox"),0);
}));
test("failure clock and persistence errors replace original while preserving custody",async()=>storeFixture(async path=>{
  const pending=await seed(path);const sentinel={clock:true};const base=options(async()=>{throw new DiscordTransportFault("Transport","lost");});
  await assert.rejects(deliverFinal(path,pending,{...base,now(){throw sentinel;}}),e=>e===sentinel);assert.equal((await edit(path,db=>selectDelivery(db,"d"))).attemptCount,0n);
  await edit(path,db=>db.exec("CREATE TRIGGER fail_record BEFORE UPDATE ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'cannot record'); END"));
  await assert.rejects(deliverFinal(path,pending,base),/cannot record/);assert.equal(await count(path,"codex_delivery_outbox"),1);
}));
test("caller mutation after entry does not retarget later chunks or retirement",async()=>storeFixture(async path=>{
  const pending=await seed(path,"x".repeat(2100));const sent:string[]=[];
  const run=deliverFinal(path,pending,options(async request=>{sent.push(request.path);return 9n;}));pending.channelId=88n;pending.deliveryId="different";pending.content="changed";await run;
  assert.deepEqual(sent,["channels/1/messages","channels/1/messages"]);assert.equal(await count(path,"codex_delivery_outbox"),0);
}));
test("attempt-all is sequential, runs later items and retains first even undefined",async()=>{
  const seen:number[]=[];let caught=false;
  try{await attemptAllFinals([1,2,3],async n=>{seen.push(n);await Promise.resolve();if(n===1)throw undefined;if(n===2)throw new Error("second");});}catch(e){caught=true;assert.equal(e,undefined);}
  assert.equal(caught,true);assert.deepEqual(seen,[1,2,3]);await attemptAllFinals([],async()=>{});
});
