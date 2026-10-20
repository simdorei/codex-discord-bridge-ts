import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {claimIngressRecovery,validateIngressRecovery}=state;
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {beginIngressExecution} from "../../src/store/ingress-lifecycle.ts";
import {getIngressIn,type StoredIngress} from "../../src/store/ingress-read.ts";
import {validateIngressRecoveryIn,validateRecoveryBindingIn,type RecoveryClaim} from "../../src/store/ingress-recovery-custody.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function admitted(path:string,route="Explicit",commandName="Recover"):Promise<StoredIngress>{
  const command={[commandName]:{reference:route==="Explicit"?"target":null}},binding={target:"target",route,command};
  await admitIngress(path,{ingressId:"message:3",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,plan:{Execute:command},lifecycle_binding:binding},targetThreadId:"target",canonicalOwner:null,now:1});
  await beginIngressExecution(path,"message:3","processing","target",2);return edit(path,db=>getIngressIn(db,"message:3")!);
}
test("one original Recover or Repair command acquires a non-reusable claim",async()=>{
  for(const command of ["Recover","Repair"])await storeFixture(async path=>{const expected=await admitted(path,"Explicit",command);const claim=await claimIngressRecovery(path,expected);assert.equal(Object.isFrozen(claim),true);await validateIngressRecovery(path,claim);
    await assert.rejects(claimIngressRecovery(path,expected),/already used/);const latest=await edit(path,db=>getIngressIn(db,"message:3")!);assert.equal(latest.phase,"recovery_claimed");await assert.rejects(claimIngressRecovery(path,latest),/already used/);
  });
});
test("claim snapshots expected row before awaiting an owned connection",async()=>{
  await storeFixture(async path=>{const expected=await admitted(path);const pending=claimIngressRecovery(path,expected);expected.phase="changed";(expected.payload as Record<string,unknown>).version=9n;const claim=await pending;await validateIngressRecovery(path,claim);});
});
test("mapped recovery binding checks actual mapping before claiming and before later effects",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1)"));const expected=await admitted(path,"Mapped");const claim=await claimIngressRecovery(path,expected);await validateIngressRecovery(path,claim);await edit(path,db=>db.exec("UPDATE mirror_threads SET codex_thread_id='other'"));await assert.rejects(validateIngressRecovery(path,claim),/no retarget or replay/);});
  await storeFixture(async path=>{const expected=await admitted(path,"Mapped");await assert.rejects(claimIngressRecovery(path,expected),/no retarget or replay/);assert.equal((await edit(path,db=>getIngressIn(db,"message:3")))?.phase,"processing");});
});
test("selected recovery binding requires no mapped room and leaves runtime selection validation external",async()=>{
  await storeFixture(async path=>{const expected=await admitted(path,"Selected");const claim=await claimIngressRecovery(path,expected);await validateIngressRecovery(path,claim);await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1)"));await assert.rejects(validateIngressRecovery(path,claim),/no retarget or replay/);});
});
test("all stored identity and lifecycle fields stay bound to the original claim",async()=>{
  for(const sql of ["UPDATE discord_ingress_journal SET owner_user_id=9","UPDATE discord_ingress_journal SET state='held'","UPDATE discord_ingress_journal SET outcome_json='{}'","UPDATE discord_ingress_journal SET hold_reason='changed'","UPDATE discord_ingress_journal SET updated_at=0","UPDATE discord_ingress_journal SET target_thread_id='other'"])await storeFixture(async path=>{const claim=await claimIngressRecovery(path,await admitted(path));await edit(path,db=>db.exec(sql));await assert.rejects(validateIngressRecovery(path,claim),/no retarget or replay/);});
});
test("changed expected record or original envelope mismatch cannot claim",async()=>{
  await storeFixture(async path=>{const expected=await admitted(path);await assert.rejects(claimIngressRecovery(path,{...expected,channelId:9n}),/no retarget or replay/);await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET source_message_id=4"));const bad=await edit(path,db=>getIngressIn(db,"message:3")!);await assert.rejects(claimIngressRecovery(path,bad),/no retarget or replay/);});
});
test("malformed commands and route/reference combinations reject before mutation",async()=>{
  await storeFixture(async path=>{await edit(path,db=>{for(const binding of [{target:"target",route:"Explicit",command:{Recover:{reference:null}}},{target:"target",route:"Selected",command:{Recover:{reference:"target"}}},{target:"target",route:"Mapped",command:{Recover:{reference:""}}},{target:"target",route:"Explicit",command:{Recover:{reference:"target"},Repair:{reference:"target"}}},{target:"target",route:"Explicit",command:{Recover:{reference:"target",extra:true}}}])assert.throws(()=>validateRecoveryBindingIn(db,binding,1n),/no retarget or replay/);});});
});
test("proof clones cannot acquire authority and validation preserves caller transaction",async()=>{
  await storeFixture(async path=>{const claim=await claimIngressRecovery(path,await admitted(path));await assert.rejects(validateIngressRecovery(path,{...claim}),/no retarget or replay/);await assert.rejects(validateIngressRecovery(path,{} as RecoveryClaim),/no retarget or replay/);
    await edit(path,db=>{db.exec("BEGIN IMMEDIATE");validateIngressRecoveryIn(db,claim);assert.equal(db.isTransaction,true);db.exec("UPDATE discord_ingress_journal SET phase='done'");assert.throws(()=>validateIngressRecoveryIn(db,claim),/no retarget or replay/);db.exec("ROLLBACK");});await validateIngressRecovery(path,claim);
  });
});
