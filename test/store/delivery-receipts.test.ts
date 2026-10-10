import {newReply,finalGrant} from "../helpers/delivery-custody.ts";
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {beginDeliveryReceipt,confirmDeliveryReceipt,releaseRejectedDelivery,blockRejectedDelivery,unknownDeliveryReceiptCount,blockedDeliveryReceiptCount,newReplyOutputHold,newReplyAcknowledgementSendable,releaseNewReplyAcknowledgement}=state;
import {parseReceiptKey,receiptHash} from "../../src/store/delivery-receipt-key.ts";
import {getIn} from "../../src/store/new-reply-read.ts";
import {newReplyAcknowledgementKey,newReplyWarningText} from "../../src/store/new-reply-claims.ts";
import {serializeSerdeValue as json} from "../../src/core/serde-json.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const key=(channel:bigint,domain:string,logical:string,index=0n)=>json([channel,domain,logical,index]);
test("receipt tuple parser preserves signed channel and unsigned 64-bit index without coercion",()=>{
  assert.deepEqual(parseReceiptKey('[-9223372036854775808,"d","k",18446744073709551615]'),[-(1n<<63n),"d","k",(1n<<64n)-1n]);
  for(const raw of ['[1.0,"d","k",0]','[1,"d","k",0.0]','[1,"d","k",-1]','[1,"d","k",18446744073709551616]','[1,"d","k",0,null]','{}'])assert.equal(parseReceiptKey(raw),null);
});
test("reopen cannot resend unknown intent and confirmed message identity remains immutable",async()=>{
  await storeFixture(async path=>{assert.deepEqual(await beginDeliveryReceipt(path,"chunk","hash"),{kind:"New"});assert.deepEqual(await beginDeliveryReceipt(path,"chunk","hash"),{kind:"Unknown"});assert.equal(await unknownDeliveryReceiptCount(path),1n);
    assert.equal(await confirmDeliveryReceipt(path,"chunk","123"),true);assert.equal(await confirmDeliveryReceipt(path,"chunk","456"),false);assert.deepEqual(await beginDeliveryReceipt(path,"chunk","hash"),{kind:"Delivered",messageId:"123"});assert.deepEqual(await beginDeliveryReceipt(path,"chunk","changed"),{kind:"ContentConflict"});assert.equal(await unknownDeliveryReceiptCount(path),0n);
  });
});
test("authoritative rejection allows one same-content retry but never a changed body",async()=>{
  await storeFixture(async path=>{await beginDeliveryReceipt(path,"chunk","hash");assert.equal(await releaseRejectedDelivery(path,"chunk"),true);assert.equal(await unknownDeliveryReceiptCount(path),0n);assert.deepEqual(await beginDeliveryReceipt(path,"chunk","changed"),{kind:"ContentConflict"});assert.deepEqual(await beginDeliveryReceipt(path,"chunk","hash"),{kind:"New"});assert.deepEqual(await beginDeliveryReceipt(path,"chunk","hash"),{kind:"Unknown"});});
});
test("operator-blocked rejection persists without tick retry and truncates by Unicode scalars",async()=>{
  await storeFixture(async path=>{await beginDeliveryReceipt(path,"chunk","hash");await blockRejectedDelivery(path,"chunk","😀".repeat(1001));assert.deepEqual(await beginDeliveryReceipt(path,"chunk","hash"),{kind:"RejectedBlocked",reason:"😀".repeat(1000)});assert.equal(await releaseRejectedDelivery(path,"chunk"),false);assert.equal(await unknownDeliveryReceiptCount(path),0n);assert.equal(await blockedDeliveryReceiptCount(path),1n);});
});
test("new acknowledgement opens output only after its exact receipt is confirmed",async()=>{
  await storeFixture(async path=>{await newReply(path);const record=await edit(path,db=>getIn(db,"job")!);const ack=newReplyAcknowledgementKey(record),final=key(2n,"completion/v1","delivery"),guard={jobId:"job",threadId:"target",turnId:"turn"};
    assert.deepEqual(await beginDeliveryReceipt(path,final,"final",guard),{kind:"Held",reason:"new first reply is not confirmed; output remains saved"});
    await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_receipts").get()?.n,0));
    assert.deepEqual(await beginDeliveryReceipt(path,ack,receiptHash("accepted")),{kind:"New"});assert.equal(await confirmDeliveryReceipt(path,ack,"123"),true);
    assert.equal(await newReplyOutputHold(path,"job"),null);assert.deepEqual(await beginDeliveryReceipt(path,final,"final",guard),{kind:"New"});
    await edit(path,db=>assert.equal(db.prepare("SELECT confirmation_delivered FROM discord_ingress_journal").get()?.confirmation_delivered,1));
  });
});
test("wrong acknowledgement body, noncanonical key and uncertain turn cannot acquire intent",async()=>{
  await storeFixture(async path=>{await newReply(path);const ack=key(1n,"message/reply/v1","inbound-message/3/action-result");await assert.rejects(beginDeliveryReceipt(path,ack,"changed"),/identity\/body changed/);
    await assert.rejects(beginDeliveryReceipt(path,key(1n,"message/reply/v1","inbound-message/+03/action-result"),receiptHash("accepted")),/identity\/body changed/);
    await edit(path,db=>db.exec("UPDATE codex_new_first_replies SET turn_id=NULL"));assert.deepEqual(await beginDeliveryReceipt(path,ack,receiptHash("accepted")),{kind:"Held",reason:"new turn acceptance is uncertain; normal acknowledgement is not authorized"});
  });
});
test("new warning receipt never opens output and rejection restores only its warning state",async()=>{
  await storeFixture(async path=>{await newReply(path);const record=await edit(path,db=>getIn(db,"job")!),notice=key(1n,"new/verification-notice/v1","job"),hash=receiptHash(newReplyWarningText(record));
    await beginDeliveryReceipt(path,notice,hash);await edit(path,db=>assert.equal(getIn(db,"job")?.warningDue,2n));await releaseRejectedDelivery(path,notice);await edit(path,db=>assert.equal(getIn(db,"job")?.warningDue,1n));await beginDeliveryReceipt(path,notice,hash);await confirmDeliveryReceipt(path,notice,"warning-id");assert.match((await newReplyOutputHold(path,"job"))!,/not confirmed/);
  });
});
test("ack confirmation rolls back server message ID if original destination drifted",async()=>{
  await storeFixture(async path=>{await newReply(path);const ack=key(1n,"message/reply/v1","inbound-message/3/action-result");await beginDeliveryReceipt(path,ack,receiptHash("accepted"));await edit(path,db=>db.exec("UPDATE mirror_threads SET discord_thread_id=9"));await assert.rejects(confirmDeliveryReceipt(path,ack,"123"),/mapping changed/);await edit(path,db=>assert.equal(db.prepare("SELECT message_id FROM codex_delivery_receipts").get()?.message_id,null));});
});
test("output continuation requires exact turn custody and cannot borrow a first-turn guard",async()=>{
  await storeFixture(async path=>{await newReply(path);await edit(path,db=>db.exec("UPDATE codex_new_first_replies SET confirmation_delivered=1"));const final=key(2n,"completion/v1","later"),guard={jobId:"job",threadId:"target",turnId:"later"};await assert.rejects(beginDeliveryReceipt(path,final,"hash",guard),/exact-turn ownership/);
    await edit(path,db=>db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('later','job','target','later',2,'body',1,1)"));assert.deepEqual(await beginDeliveryReceipt(path,final,"hash",guard),{kind:"New"});
  });
});
test("legacy Reserve transition notice checks channel, content, exact mapping and dead hold",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1); INSERT INTO codex_reserve_transition_notices(notice_id,target_thread_id,channel_id,policy_revision,transition_state,content) VALUES ('notice','target',1,1,'ordinary','notice body')"));const k=key(1n,"reserve/transition/v1","notice");await assert.rejects(beginDeliveryReceipt(path,k,"wrong"),/content changed/);assert.deepEqual(await beginDeliveryReceipt(path,k,receiptHash("notice body")),{kind:"New"});await edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES ('target','runtime',1,1)"));await assert.rejects(beginDeliveryReceipt(path,k,receiptHash("notice body")),/manual review/);});
});
test("legacy Reserve no-turn notice preserves original attempt, not current generation",async()=>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob({jobId:"job",ownerUserId:2n,attemptCount:2n,lastError:"[cdr-rust:auto-reserve-hold:v1] held"}));await edit(path,db=>db.exec("UPDATE codex_turn_queue SET attempt_count=2,last_error='[cdr-rust:auto-reserve-hold:v1] held'; INSERT INTO codex_reserve_start_notices(job_id,target_thread_id,channel_id,app_server_generation,attempt_count,content) VALUES ('job','target',1,99,2,'failure')"));const k=key(1n,"reserve/start-failure/v1","job");assert.deepEqual(await beginDeliveryReceipt(path,k,receiptHash("failure")),{kind:"New"});await edit(path,db=>db.exec("UPDATE codex_turn_queue SET turn_id='started'"));await assert.rejects(beginDeliveryReceipt(path,k,receiptHash("failure")),/held no-turn job/);});
});
test("existing final recovery grant requires exact guard, rendered chunk and original confirmed error",async()=>{
  await storeFixture(async path=>{const final=await finalGrant(path),guard={jobId:"job",threadId:"target",turnId:"turn"},hash=receiptHash("restored final");
    await assert.rejects(beginDeliveryReceipt(path,final,hash),/chunk identity/);await assert.rejects(beginDeliveryReceipt(path,final,"wrong",guard),/chunk identity/);await assert.rejects(beginDeliveryReceipt(path,key(1n,"completion/v1","final",1n),hash,guard),/chunk identity/);
    assert.deepEqual(await beginDeliveryReceipt(path,final,hash,guard),{kind:"New"});assert.deepEqual(await beginDeliveryReceipt(path,final,hash,guard),{kind:"Unknown"});
  });
});
test("changed final recovery evidence or remaining executable/progress custody prevents send intent",async()=>{
  for(const mutation of ["UPDATE codex_delivery_outbox SET content='changed'","UPDATE discord_ingress_journal SET owner_user_id=9","UPDATE codex_delivery_receipts SET message_id='different'","UPDATE mirror_threads SET codex_thread_id='other'","INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('progress','job','target','turn',1,'progress')"]){
    await storeFixture(async path=>{const final=await finalGrant(path);await edit(path,db=>db.exec(mutation));await assert.rejects(beginDeliveryReceipt(path,final,receiptHash("restored final"),{jobId:"job",threadId:"target",turnId:"turn"}));await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_receipts WHERE receipt_key=?").get(final)?.n,0));});
  }
  await storeFixture(async path=>{const final=await finalGrant(path);await state.enqueue(path,queueJob({jobId:"job",ownerUserId:2n}));await assert.rejects(beginDeliveryReceipt(path,final,receiptHash("restored final"),{jobId:"job",threadId:"target",turnId:"turn"}),/executable or uncertain/);});
});
test("malformed stored final grant is not treated as missing authorization",async()=>{
  await storeFixture(async path=>{const final=await finalGrant(path);await edit(path,db=>db.exec("UPDATE cdr_final_recovery SET grant_json='{}'"));await assert.rejects(beginDeliveryReceipt(path,final,"hash",{jobId:"job",threadId:"target",turnId:"turn"}),/Missing Serde field/);});
});
test("receipt write or acknowledgement side-effect failure is atomic",async()=>{
  await storeFixture(async path=>{await newReply(path);const ack=key(1n,"message/reply/v1","inbound-message/3/action-result");await beginDeliveryReceipt(path,ack,receiptHash("accepted"));await edit(path,db=>db.exec("CREATE TRIGGER reject_confirm BEFORE UPDATE OF confirmation_delivered ON codex_new_first_replies BEGIN SELECT RAISE(ABORT,'fixture confirm failure'); END"));await assert.rejects(confirmDeliveryReceipt(path,ack,"123"),/fixture confirm failure/);await edit(path,db=>assert.equal(db.prepare("SELECT message_id FROM codex_delivery_receipts").get()?.message_id,null));});
});
test("acknowledgement recovery permission cannot resend an unknown or blocked outcome",async()=>{
  await storeFixture(async path=>{await newReply(path);let record=await edit(path,db=>getIn(db,"job")!);assert.equal(await newReplyAcknowledgementSendable(path,record),false);await releaseNewReplyAcknowledgement(path,"original");record=await edit(path,db=>getIn(db,"job")!);assert.equal(await newReplyAcknowledgementSendable(path,record),true);
    const ack=newReplyAcknowledgementKey(record);await beginDeliveryReceipt(path,ack,receiptHash("accepted"));assert.equal(await newReplyAcknowledgementSendable(path,record),false);await releaseRejectedDelivery(path,ack);assert.equal(await newReplyAcknowledgementSendable(path,record),true);await blockRejectedDelivery(path,ack,"permission denied");assert.equal(await newReplyAcknowledgementSendable(path,record),false);
    await confirmDeliveryReceipt(path,ack,"confirmed");assert.equal(await newReplyAcknowledgementSendable(path,record),true);
  });
});
