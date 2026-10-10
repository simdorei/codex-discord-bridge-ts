import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {selectJob,serializeStoredQueueJob} from "../../src/store/queue-read.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {validateQueueStartAuthorityIn} from "../../src/store/queue-start-authority.ts";
import {beginChecked} from "../../src/store/mutation-attempt.ts";
async function fixture(run:(db:DatabaseSync,path:string,claim:Record<string,unknown>)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{
  db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
  db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,101,7,7,'input',0,1,'starting',1,NULL,'[]',?,?)").run(1790584100.0000021,1790584100.0000021);
  const claim=parseSerdeValue<Record<string,unknown>>(serializeStoredQueueJob(selectJob(db,"job")));run(db,path,claim);
}finally{db.close();}});}
test("original starting claim validates without refreshing it and delivery flags are not execution authority",async()=>fixture((db,_p,c)=>{
  db.exec("BEGIN IMMEDIATE");validateQueueStartAuthorityIn(db,c,"T",7n);validateQueueStartAuthorityIn(db,{...c,queued:true,ack_sent:false,extra:"ignored"},"T",7n);assert.equal(db.isTransaction,true);db.exec("ROLLBACK");assert.equal(selectJob(db,"job").attemptCount,1n);
}));
for(const field of ["job_id","target_thread_id","channel_id","owner_user_id","discord_message_id","app_server_generation","execution_generation","turn_observation_generation","goal_waiting","prompt","state","attempt_count","turn_id","baseline_turn_ids","last_error","created_at","updated_at"])test(`queue writer rejects changed original ${field}`,async()=>fixture((db,_p,c)=>{
  const changed={...c,[field]:field==="job_id"?"missing":null};if(c[field]===null)changed[field]="changed";
  assert.throws(()=>validateQueueStartAuthorityIn(db,changed,"T",7n));
}));
test("matching but non-starting, unassigned generation, observed turn or goal-waiting rows cannot authorize a start",async()=>{
  for(const update of ["state='running'","execution_generation=NULL","turn_id='V'","goal_waiting=1"]){await fixture((db)=>{
    db.exec(`UPDATE codex_turn_queue SET ${update}`);const c=parseSerdeValue(serializeStoredQueueJob(selectJob(db,"job")));assert.throws(()=>validateQueueStartAuthorityIn(db,c,"T",7n),/original queue start/);
  });}
});
for(const effect of [
  "INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',0)",
  "INSERT INTO codex_request_cancellations VALUES('job','T',42,3,101,0)",
  "INSERT INTO codex_archive_fences VALUES('T','op',NULL,'attempted')",
  "INSERT INTO codex_dead_generation_holds VALUES('T','runtime',7,0)",
  "INSERT INTO codex_dead_generation_incidents VALUES('runtime',7,'{}','[]',0)",
  "INSERT INTO cdr_async_recovery_policies VALUES('T',1,'publishing_recovery','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v','origin','pending')",
])test(`queue final authority respects durable hold: ${effect.split(" ")[2]}`,async()=>fixture((db,_p,c)=>{
  db.exec(effect);assert.throws(()=>validateQueueStartAuthorityIn(db,c,"T",7n));assert.equal(selectJob(db,"job").attemptCount,1n);
}));
test("writer runs the original queue check again after insertion and rolls back trigger-induced custody change",async()=>fixture((db,path,c)=>{
  db.exec("CREATE TRIGGER custody_changed AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_turn_queue SET owner_user_id=99 WHERE job_id='job'; END");
  assert.throws(()=>beginChecked(path,{runtimeId:"runtime",ownerId:"resident",generation:7n,attemptId:"attempt",wireId:"1",method:"turn/start",targetThreadId:"T",scoped:true,payload:{request:{threadId:"T"},queueClaim:c}},tx=>{validateQueueStartAuthorityIn(tx,c,"T",7n);return undefined;}),/original queue start/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts").get()!.n,0);assert.equal(selectJob(db,"job").ownerUserId,3n);
}));
test("matching claim cannot change the caller target or generation and never executes claim getters",async()=>fixture((db,_p,c)=>{
  assert.throws(()=>validateQueueStartAuthorityIn(db,c,"other",7n));assert.throws(()=>validateQueueStartAuthorityIn(db,c,"T",8n));let calls=0;assert.throws(()=>validateQueueStartAuthorityIn(db,{...c,get job_id(){calls++;return "job";}},"T",7n));assert.equal(calls,0);
}));
