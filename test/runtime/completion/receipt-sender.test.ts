import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync} from "node:fs";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {newReply} from "../../helpers/delivery-custody.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {sendReceiptChunk,DiscordTransportFault,CompletionDeliveryError,isCompletionHeld,type DiscordReceiptTransport,type IdempotentChunk} from "../../../src/runtime/completion/receipt-sender.ts";
import {busyButtonRow,serializeDiscordComponent} from "../../../src/discord/components.ts";
import {receiptHash} from "../../../src/store/delivery-receipt-key.ts";
import {serializeSerdeValue as json} from "../../../src/core/serde-json.ts";
const chunk=(overrides:Partial<IdempotentChunk>={}):IdempotentChunk=>({domain:"test/v1",logicalKey:"delivery",chunkIndex:0,content:"hello",...overrides});
const key=json([1n,"test/v1","delivery",0n]);
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const read=(path:string)=>edit(path,db=>db.prepare("SELECT * FROM codex_delivery_receipts WHERE receipt_key=?").get(key)!);
test("request is recorded before transport, confirmed afterward, and never resends a delivered chunk",async()=>{
  await storeFixture(async path=>{let calls=0;const transport:DiscordReceiptTransport={async sendValidated(request){calls++;assert.equal(request.method,"POST");assert.equal(request.path,"channels/1/messages");assert.equal((await read(path)).message_id,null);assert.equal(JSON.parse(request.body).enforce_nonce,true);return 9007199254740993n;}};
    await sendReceiptChunk(path,transport,1n,chunk());assert.equal((await read(path)).message_id,"9007199254740993");assert.equal((await read(path)).content_hash,receiptHash("hello"));await sendReceiptChunk(path,transport,1n,chunk());assert.equal(calls,1);
  });
});
test("a concurrent same-key sender sees Unknown while the original request is in flight",async()=>{
  await storeFixture(async path=>{let start!:()=>void,finish!:(id:bigint)=>void,calls=0;const started=new Promise<void>(r=>start=r),reply=new Promise<bigint>(r=>finish=r);const transport:DiscordReceiptTransport={async sendValidated(){calls++;start();return reply;}};
    const original=sendReceiptChunk(path,transport,1n,chunk());await started;await assert.rejects(sendReceiptChunk(path,transport,1n,chunk()),/send outcome unknown/);assert.equal(calls,1);finish(123n);await original;
  });
});
test("429 records one retryable rejection while the same nonce/body is reused",async()=>{
  await storeFixture(async path=>{let calls=0;const bodies:string[]=[];const transport:DiscordReceiptTransport={async sendValidated(r){bodies.push(r.body);if(++calls===1)throw new DiscordTransportFault("Response","rate limit",429);return 123n;}};
    await assert.rejects(sendReceiptChunk(path,transport,1n,chunk()),/definite rejection/);assert.equal((await read(path)).retryable,1);await sendReceiptChunk(path,transport,1n,chunk());assert.equal(calls,2);assert.equal(bodies[0],bodies[1]);assert.equal((await read(path)).message_id,"123");
  });
});
test("other definite HTTP/local rejections block without spinning a later send",async()=>{
  const faults=[...[400,401,403,404,405,413,415,422].map(s=>new DiscordTransportFault("Response","rejected",s)),...(["BuildingRequest","CreatingHeader","Json","Unauthorized","Validation"] as const).map(k=>new DiscordTransportFault(k,"local rejection"))];
  for(const fault of faults)await storeFixture(async path=>{let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;throw fault;}};await assert.rejects(sendReceiptChunk(path,t,1n,chunk()),/definite rejection/);assert.notEqual((await read(path)).blocked_reason,null);await assert.rejects(sendReceiptChunk(path,t,1n,chunk()),/requires correction/);assert.equal(calls,1);});
});
test("5xx, unclassified status and receipt/transport errors remain unconfirmed and cannot retry",async()=>{
  const faults=[...[408,409,500,502,503].map(s=>new DiscordTransportFault("Response","uncertain",s)),new DiscordTransportFault("Receipt","bad JSON"),new DiscordTransportFault("Transport","timeout")];
  for(const fault of faults)await storeFixture(async path=>{let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;throw fault;}};await assert.rejects(sendReceiptChunk(path,t,1n,chunk()),/outcome unconfirmed/);assert.equal((await read(path)).retryable,0);assert.equal((await read(path)).blocked_reason,null);await assert.rejects(sendReceiptChunk(path,t,1n,chunk()),/send outcome unknown/);assert.equal(calls,1);});
});
test("forged and Proxy errors cannot manufacture a retry classification or invoke getters",async()=>{
  let traps=0;const poison=new Proxy({kind:"Response",status:429},{get(){traps++;throw new Error("getter");},getPrototypeOf(){traps++;throw new Error("prototype");}});
  for(const fault of [poison,Object.create(DiscordTransportFault.prototype)])await storeFixture(async path=>{await assert.rejects(sendReceiptChunk(path,{async sendValidated(){throw fault;}},1n,chunk()),/unclassified Discord transport failure/);assert.equal((await read(path)).retryable,0);});assert.equal(traps,0);
});
test("invalid content is rejected before any database creation or HTTP attempt",async()=>{
  await storeFixture(async path=>{let calls=0;await assert.rejects(sendReceiptChunk(path,{async sendValidated(){calls++;return 123n;}},1n,chunk({content:" \n "})),CompletionDeliveryError);assert.equal(calls,0);assert.equal(existsSync(path),false);});
});
test("accepted message whose receipt UPDATE is ignored stays unknown without resend",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("CREATE TRIGGER ignore_confirmation BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(IGNORE); END"));let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;return 123n;}};
    await assert.rejects(sendReceiptChunk(path,t,1n,chunk()),/receipt could not be committed/);assert.equal((await read(path)).message_id,null);await assert.rejects(sendReceiptChunk(path,t,1n,chunk()),/send outcome unknown/);assert.equal(calls,1);
  });
});
test("component bytes participate in body identity but do not change the logical chunk nonce",async()=>{
  await storeFixture(async path=>{let calls=0;const row=busyButtonRow("a".repeat(24),false);const t:DiscordReceiptTransport={async sendValidated(){calls++;return 123n;}};await sendReceiptChunk(path,t,1n,chunk(),[row]);assert.equal((await read(path)).content_hash,receiptHash(`["hello",[${serializeDiscordComponent(row)}]]`));
    await assert.rejects(sendReceiptChunk(path,t,1n,chunk(),[busyButtonRow("a".repeat(24),true)]),/content changed/);assert.equal(calls,1);
  });
});
test("held original New output does not create intent or call the transport",async()=>{
  await storeFixture(async path=>{await newReply(path);let calls=0;await assert.rejects(sendReceiptChunk(path,{async sendValidated(){calls++;return 123n;}},2n,chunk({domain:"completion/v1"}),[],{jobId:"job",threadId:"target",turnId:"turn"}),e=>isCompletionHeld(e));assert.equal(calls,0);await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_receipts").get()?.n,0));});
});
test("rounded, zero or malformed message identities cannot be committed as server receipts",async()=>{
  for(const id of [0n,1n<<64n,123,"123",{}])await storeFixture(async path=>{await assert.rejects(sendReceiptChunk(path,{async sendValidated(){return id as bigint;}},1n,chunk()),/outcome unconfirmed/);assert.equal((await read(path)).message_id,null);assert.equal((await read(path)).retryable,0);});
});
test("input chunk and component collection are snapshotted before awaiting storage",async()=>{
  await storeFixture(async path=>{const input={domain:"test/v1",logicalKey:"delivery",chunkIndex:0,content:"hello"},components=[busyButtonRow("a".repeat(24),false)];let body="";const pending=sendReceiptChunk(path,{async sendValidated(r){body=r.body;return 123n;}},1n,input,components);
    input.content="changed";input.logicalKey="other";components.length=0;await pending;assert.equal(JSON.parse(body).content,"hello");assert.equal(JSON.parse(body).components.length,1);assert.equal((await read(path)).message_id,"123");
  });
});
