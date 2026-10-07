import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {holdIngress,recoverPriorRuntimeIngress,getIngressForOwnerReadonly,listIngressesForOwner}=state;
import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {getIngressIn,ReadOnlySchemaVersionError} from "../../src/store/ingress-read.ts";
import {archivedIngressPreservedIn} from "../../src/store/ingress-recovery.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import type {NewIngress} from "../../src/store/ingress-types.ts";
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:"target",canonicalOwner:null,now:1,...overrides});
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const read=(path:string)=>edit(path,db=>getIngressIn(db,"original")!);
const notices=(path:string)=>edit(path,db=>db.prepare("SELECT content FROM codex_delivery_outbox ORDER BY delivery_id").all().map(r=>String(r.content)));
test("ingress hold stages exactly one notice with original uncertainty and scalar-bounded reason",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request({payload:{attachments:[{}]}}));await holdIngress(path,"original","😀".repeat(501),true,2);const first=(await notices(path))[0]!;
    assert.match(first,/saved but was not executed/);assert.match(first,/Attachment metadata is saved/);assert.equal((await read(path)).holdReason,"😀".repeat(500));
    await holdIngress(path,"original","later",false,3);assert.equal((await notices(path)).length,1);assert.equal((await notices(path))[0],first);assert.equal((await read(path)).holdReason,"later");
  });
});
test("completed action stays known-completed and archive fence retains its original reason",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='completed',phase='result_recorded'"));await holdIngress(path,"original","shutdown",true,2);assert.match((await notices(path))[0]!,/action completed/);});
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='held',phase='archive_fenced',hold_reason='original fence'"));await holdIngress(path,"original","new reason",false,2);assert.equal((await read(path)).holdReason,"original fence");assert.match((await notices(path))[0]!,/was not executed/);});
});
test("owned requests keep their queue/intake recovery authority without new saved POST",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job'; INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json) VALUES ('job','original','{}')"));await holdIngress(path,"original","shutdown",false,2);assert.equal((await read(path)).state,"owned");assert.deepEqual(await notices(path),[]);await edit(path,db=>assert.equal(db.prepare("SELECT ack_recovery_allowed FROM codex_new_first_replies").get()?.ack_recovery_allowed,1));});
});
test("cleanup refusal preserves known pre-delete outcome and does not mint a different notice",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());const outcome={kind:"mirror_cleanup_refused",version:1n,sync_completed:false,delete_dispatched:false,earlier_changes_possible:true,blocked_room_id:9n,protection_reason:"ingress"};
    await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET outcome_json=?").run(serializeSerdeValue(outcome)));await holdIngress(path,"original","😀".repeat(151),false,2);const first=(await read(path)).holdReason;assert.match(first,/room 9 protected by ingress/);assert.ok(first.endsWith("😀".repeat(150)));assert.deepEqual(await notices(path),[]);
    await holdIngress(path,"original","later",true,3);assert.equal((await read(path)).holdReason,first);assert.deepEqual((await read(path)).outcome,outcome);
  });
});
test("archived rejection needs exact audit plus an extant fence and never stages a POST",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>{
    db.exec("UPDATE discord_ingress_journal SET state='held',phase='result_recorded',outcome_json='{}'; INSERT INTO cdr_cleanup_fences VALUES (1,'target','token','deleted',1)");
    const r=db.prepare("SELECT * FROM discord_ingress_journal").get()!;
    const snapshot=JSON.stringify({owner_user_id:r.owner_user_id,canonical_owner:r.canonical_owner,event_id:r.event_id,runtime_id:r.runtime_id,hold_reason:r.hold_reason,updated_at:r.updated_at});
    db.prepare("INSERT INTO cdr_archived_cleanup_evidence VALUES ('token',1,'target','original',?,?,?,'{}',1)").run(r.payload_json as string,r.outcome_json as string,snapshot);assert.equal(archivedIngressPreservedIn(db,"original"),true);
  });await holdIngress(path,"original","shutdown",false,9);assert.equal((await read(path)).updatedAt,1);assert.deepEqual(await notices(path),[]);
    await edit(path,db=>{db.exec("DELETE FROM cdr_cleanup_fences");assert.equal(archivedIngressPreservedIn(db,"original"),false);});await holdIngress(path,"original","shutdown",false,10);assert.equal((await notices(path)).length,1);
  });
});
test("prior runtime recovery excludes current, confirmed, held and owned rows without executing anything",async()=>{
  await storeFixture(async path=>{for(let i=0;i<5;i++)await admitIngress(path,request({ingressId:`r${i}`,eventId:BigInt(10+i)}));await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET runtime_id='old'; UPDATE discord_ingress_journal SET runtime_id='current' WHERE ingress_id='r1'; UPDATE discord_ingress_journal SET confirmation_delivered=1 WHERE ingress_id='r2'; UPDATE discord_ingress_journal SET state='held' WHERE ingress_id='r3'; UPDATE discord_ingress_journal SET state='owned',owner_id='job' WHERE ingress_id='r4'"));
    assert.equal(await recoverPriorRuntimeIngress(path,"current",9),1);assert.equal((await notices(path)).length,1);await edit(path,db=>{assert.equal(getIngressIn(db,"r0")?.state,"held");assert.equal(getIngressIn(db,"r1")?.state,"staged");assert.equal(getIngressIn(db,"r4")?.state,"owned");});assert.equal(await recoverPriorRuntimeIngress(path,"current",10),0);
  });
});
test("notice staging failure rolls back every tentative hold in a recovery transaction",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await admitIngress(path,request({ingressId:"second",eventId:4n}));await edit(path,db=>db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON codex_delivery_outbox WHEN NEW.delivery_id='ingress-hold:second' BEGIN SELECT RAISE(ABORT,'fixture notice failure'); END"));await assert.rejects(recoverPriorRuntimeIngress(path,"current",9),/fixture notice failure/);assert.equal((await read(path)).state,"staged");assert.deepEqual(await notices(path),[]);});
});
test("owner-scoped read excludes unrelated malformed payload before decoding and makes no writes",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET payload_json='not-json'"));assert.equal(getIngressForOwnerReadonly(path,"original",1n,9n),null);assert.equal(getIngressForOwnerReadonly(path,"original",9n,2n),null);assert.throws(()=>getIngressForOwnerReadonly(path,"original",1n,2n));});
});
test("read-only owner inspection neither creates missing files nor migrates older schema",async()=>{
  await storeFixture(async path=>{assert.throws(()=>getIngressForOwnerReadonly(path,"x",1n,2n));assert.equal(existsSync(path),false);const db=new DatabaseSync(path);db.exec("PRAGMA user_version=1");db.close();assert.throws(()=>getIngressForOwnerReadonly(path,"x",1n,2n),ReadOnlySchemaVersionError);const check=new DatabaseSync(path);try{assert.equal(check.prepare("PRAGMA user_version").get()?.user_version,1);assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n,0);}finally{check.close();}});
});
test("owner review list contains only held or unconfirmed completed rows and caps at twenty",async()=>{
  await storeFixture(async path=>{for(let i=0;i<23;i++)await admitIngress(path,request({ingressId:`r${i.toString().padStart(2,"0")}`,eventId:BigInt(100+i),now:i}));await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='held'"));const list=await listIngressesForOwner(path,1n,2n);assert.equal(list.length,20);assert.equal(list[0]?.ingressId,"r22");assert.equal(list[19]?.ingressId,"r03");assert.deepEqual(await listIngressesForOwner(path,1n,9n),[]);});
});
