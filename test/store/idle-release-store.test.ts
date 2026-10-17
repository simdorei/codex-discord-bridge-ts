import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {migrateIdleRelease} from "../../src/store/schema-extensions-a.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {selectIdleIntentIn} from "../../src/store/idle-release-row.ts";
import {pendingIdleIntentsIn,beforeIdleMutationOn,idleTransitionAllowed,transitionIdleIntentOn,verifyIdleIntentIn,verifyIdleIntentWithObservationsOn,settleExitedIdleOwnerIn,beforeIdleCleanupIn} from "../../src/store/idle-release-store.ts";
import {activateObservationOn,markUnknownObservationOn} from "../../src/store/observation-ledger.ts";
function fixture(encoding="UTF-8"){const db=new DatabaseSync(":memory:");db.exec(`PRAGMA encoding='${encoding}'`);migrateIdleRelease(db);return db;}
function insert(db:DatabaseSync,status="Candidate",thread="T",owner="owner",generation=7n){db.prepare(`INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail) VALUES(?,?,?,?, 'V','job',1,?,'prior detail')`).run("i-"+thread,owner,generation,thread,status);}
test("before-mutation missing or settled is a no-op while an unsent candidate is cancelled regardless of old owner",()=>{
  const db=fixture();try{assert.equal(beforeIdleMutationOn(db,"new",9n,"absent"),null);insert(db);assert.equal(beforeIdleMutationOn(db,"new",9n,"T"),null);const row=selectIdleIntentIn(db,"T")!;assert.deepEqual([row.ownerId,row.generation,row.state,row.detail,row.revision],["owner",7n,"Settled","CancelledBeforeSend",2n]);assert.equal(beforeIdleMutationOn(db,"new",9n,"T"),null);assert.deepEqual(selectIdleIntentIn(db,"T"),row);assert.equal(db.isTransaction,false);}finally{db.close();}
});
for(const encoding of ["UTF-8","UTF-16le","UTF-16be"]){test(`AwaitUnload grants exactly one matching-owner resume and preserves source returned detail in ${encoding}`,()=>{
  const db=fixture(encoding);try{insert(db,"AwaitUnload","T😀","owner",9007199254740993n);const original=selectIdleIntentIn(db,"T😀")!;assert.throws(()=>beforeIdleMutationOn(db,"other",original.generation,"T😀"),/no automatic resume/);assert.throws(()=>beforeIdleMutationOn(db,"owner",original.generation+1n,"T😀"),/no automatic resume/);assert.deepEqual(selectIdleIntentIn(db,"T😀"),original);const result=beforeIdleMutationOn(db,"owner",original.generation,"T😀")!;assert.deepEqual([result.state,result.revision,result.detail],["Resubscribing",2n,"prior detail"]);assert.equal(selectIdleIntentIn(db,"T😀")!.detail,"real resume required before next mutation");verifyIdleIntentIn(db,result,false);assert.throws(()=>beforeIdleMutationOn(db,"owner",original.generation,"T😀"),/no automatic resume/);}finally{db.close();}
});}
test("all uncertain phases remain held without automatic resume or start",()=>{
  const db=fixture();try{for(const status of ["Dispatching","Resubscribing","Unknown"]){insert(db,status,status);const before=selectIdleIntentIn(db,status);assert.throws(()=>beforeIdleMutationOn(db,"owner",7n,status),/requires review/);assert.deepEqual(selectIdleIntentIn(db,status),before);}}finally{db.close();}
});
test("transition allowlist matches source state/reason pairs rather than elapsed-time permission",()=>{
  const allowed=[["Candidate","Dispatching","any"],["Candidate","Candidate","why"],["Dispatching","AwaitUnload","ack"],["Dispatching","Unknown","uncertain"],["Resubscribing","Unknown","uncertain"],["Candidate","Settled","CancelledBeforeSend"],["Dispatching","Settled","CancelledBeforeSend"],["AwaitUnload","Settled","UnloadedConfirmed"],["Resubscribing","Settled","SupersededByConfirmedResubscribe"],["Unknown","Settled","OldServerExited"],["Resubscribing","AwaitUnload","ResumeCancelledBeforeSend"]];for(const [a,b,c] of allowed)assert.equal(idleTransitionAllowed(a!,b!,c!),true);
  for(const [a,b,c]of [["Unknown","Settled","timeout"],["AwaitUnload","Resubscribing","resume"],["Settled","Settled","OldServerExited"],["Resubscribing","Settled","CancelledBeforeSend"],["Dispatching","Settled","CancelledBeforeSend "]])assert.equal(idleTransitionAllowed(a!,b!,c!),false);
});
test("transition CAS validates every identity and truncates diagnostics by Unicode scalar",()=>{
  const db=fixture();try{insert(db);const old=selectIdleIntentIn(db,"T")!;for(const field of ["intentId","ownerId","threadId","turnId","jobId"] as const)assert.throws(()=>transitionIdleIntentOn(db,{...old,[field]:"changed"},"Dispatching","why"),/compare-and-set/);for(const field of ["generation","revision"] as const)assert.throws(()=>transitionIdleIntentOn(db,{...old,[field]:old[field]+1n},"Dispatching","why"),/compare-and-set/);const next=transitionIdleIntentOn(db,old,"Dispatching","😀".repeat(513));assert.equal(Array.from(next.detail).length,512);assert.equal(next.revision,2n);assert.throws(()=>transitionIdleIntentOn(db,old,"Dispatching","retry"),/compare-and-set/);assert.equal(db.isTransaction,false);}finally{db.close();}
});
test("verify compares identity and state but deliberately ignores diagnostic detail",()=>{
  const db=fixture();try{insert(db);const old=selectIdleIntentIn(db,"T")!;verifyIdleIntentIn(db,{...old,detail:"different"},false);assert.throws(()=>verifyIdleIntentIn(db,{...old,state:"Unknown"},false),/identity\/state/);assert.throws(()=>verifyIdleIntentIn(db,{...old,revision:2n},false),/identity\/state/);}finally{db.close();}
});
test("pending intents are bounded to 128 in thread order and omit Settled",()=>{
  const db=fixture();try{for(let i=139;i>=0;i--)insert(db,"Candidate",String(i).padStart(3,"0"));insert(db,"Settled","000-settled");const rows=pendingIdleIntentsIn(db);assert.equal(rows.length,128);assert.equal(rows[0]!.threadId,"000");assert.equal(rows.at(-1)!.threadId,"127");}finally{db.close();}
});
test("ignored CAS or deletion after update rolls back rather than inventing a committed intent",()=>{
  const db=fixture();try{insert(db);const old=selectIdleIntentIn(db,"T")!;db.exec("CREATE TRIGGER ignore_idle BEFORE UPDATE ON cdr_idle_release BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>transitionIdleIntentOn(db,old,"Dispatching","why"),/compare-and-set/);assert.deepEqual(selectIdleIntentIn(db,"T"),old);db.exec("DROP TRIGGER ignore_idle; CREATE TRIGGER delete_idle AFTER UPDATE ON cdr_idle_release BEGIN DELETE FROM cdr_idle_release WHERE thread_id=NEW.thread_id; END");assert.throws(()=>transitionIdleIntentOn(db,old,"Dispatching","why"),/updated idle intent missing/);assert.deepEqual(selectIdleIntentIn(db,"T"),old);}finally{db.close();}
});
test("exact exited owner settles only its own generation and is idempotent",()=>{
  const db=fixture();try{insert(db,"Unknown","a");insert(db,"Dispatching","b","owner",8n);insert(db,"Resubscribing","c","other",7n);settleExitedIdleOwnerIn(db,"owner",7n);assert.equal(selectIdleIntentIn(db,"a")!.state,"Settled");assert.equal(selectIdleIntentIn(db,"a")!.detail,"OldServerExited");const before=selectIdleIntentIn(db,"a");settleExitedIdleOwnerIn(db,"owner",7n);assert.deepEqual(selectIdleIntentIn(db,"a"),before);assert.equal(selectIdleIntentIn(db,"b")!.state,"Dispatching");assert.equal(selectIdleIntentIn(db,"c")!.state,"Resubscribing");}finally{db.close();}
});
test("borrowed cleanup cancels only unsent candidate and preserves the caller rollback",()=>{
  const db=fixture();try{insert(db);insert(db,"Unknown","held");assert.throws(()=>beforeIdleCleanupIn(db,"T"),/active transaction/);db.exec("BEGIN IMMEDIATE");beforeIdleCleanupIn(db,"T");beforeIdleCleanupIn(db,"held");assert.equal(selectIdleIntentIn(db,"T")!.state,"Settled");assert.equal(selectIdleIntentIn(db,"held")!.state,"Unknown");db.exec("ROLLBACK");assert.equal(selectIdleIntentIn(db,"T")!.state,"Candidate");}finally{db.close();}
});
test("owned facade and observation verification keep unresolved coverage distinct from token identity",async()=>storeFixture(async path=>{
  const db=await openInitialized(path);try{insert(db);const intent=selectIdleIntentIn(db,"T")!;assert.throws(()=>verifyIdleIntentWithObservationsOn(db,intent,true),/durable observation range/);activateObservationOn(db,{ownerId:"owner",generation:7n});verifyIdleIntentWithObservationsOn(db,intent,true);markUnknownObservationOn(db,{ownerId:"owner",generation:7n},"gap");assert.throws(()=>verifyIdleIntentWithObservationsOn(db,intent,true),/durable observation range/);verifyIdleIntentWithObservationsOn(db,intent,false);
    const promise=state.transitionIdleIntent(path,intent,"Dispatching","exact");intent.ownerId="changed-after-call";const next=await promise;assert.equal(next.ownerId,"owner");assert.equal((await state.getIdleIntent(path,"T"))!.state,"Dispatching");assert.equal((await state.pendingIdleIntents(path)).length,1);await state.verifyIdleIntent(path,next,false);await state.settleExitedIdleOwner(path,"owner",7n);assert.equal((await state.getIdleIntent(path,"T"))!.state,"Settled");
  }finally{db.close();}
}));
