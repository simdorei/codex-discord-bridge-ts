import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {ingressCancellationOwnersIn} from "../../src/store/ingress-cancellation-owners.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function admitted(path:string,id="original",event=3n):Promise<void>{await admitIngress(path,{ingressId:id,kind:"action",eventId:event,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{command:"new",prompt:"hello"},targetThreadId:"target",canonicalOwner:null,now:1});await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job' WHERE ingress_id=?").run(id));}
test("cancellation validates all job/event owners without changing records or transaction",async()=>{
  await storeFixture(async path=>{await admitted(path);await admitted(path,"duplicate",4n);await edit(path,db=>{db.exec("BEGIN; PRAGMA query_only=1");assert.deepEqual(ingressCancellationOwnersIn(db,"job",3n,"target",1n,2n).sort(),["duplicate","original"]);assert.equal(db.isTransaction,true);assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal WHERE state='owned'").get()?.n,2);db.exec("ROLLBACK");});});
});
test("one conflicting event or ownership record refuses the entire cancellation owner set",async()=>{
  for(const mutation of ["owner_user_id=9","owner_kind='other'","target_thread_id='other'","state='held'","owner_id='different'"])await storeFixture(async path=>{await admitted(path);await edit(path,db=>{db.exec(`UPDATE discord_ingress_journal SET ${mutation}`);assert.throws(()=>ingressCancellationOwnersIn(db,"job",3n,"target",1n,2n),/nothing was cancelled/);});});
});
test("new-room cancellation preserves original room and needs versioned creation plus exact mirror",async()=>{
  await storeFixture(async path=>{await admitted(path);await edit(path,db=>{assert.throws(()=>ingressCancellationOwnersIn(db,"job",3n,"target",50n,2n),/nothing was cancelled/);
    db.exec(`UPDATE discord_ingress_journal SET outcome_json='{"new_creation":{"version":1,"origin_channel_id":1}}'; INSERT INTO mirror_threads VALUES ('target','p','title',10,50,1)`);
    assert.deepEqual(ingressCancellationOwnersIn(db,"job",3n,"target",50n,2n),["original"]);assert.equal(db.prepare("SELECT channel_id FROM discord_ingress_journal").get()?.channel_id,1);
    db.exec("UPDATE mirror_threads SET codex_thread_id='other'");assert.throws(()=>ingressCancellationOwnersIn(db,"job",3n,"target",50n,2n),/nothing was cancelled/);
  });});
});
test("unknown or non-new creation evidence never permits cross-room cancellation",async()=>{
  for(const outcome of ['{"new_creation":{"version":1.0,"origin_channel_id":1}}','{"new_creation":{"version":1,"origin_channel_id":9}}','{"new_creation":null}'])await storeFixture(async path=>{await admitted(path);await edit(path,db=>{db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',10,50,1)");db.prepare("UPDATE discord_ingress_journal SET outcome_json=?").run(outcome);assert.throws(()=>ingressCancellationOwnersIn(db,"job",3n,"target",50n,2n),/nothing was cancelled/);});});
});
