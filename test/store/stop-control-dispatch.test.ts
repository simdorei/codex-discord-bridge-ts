import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {selectJob,serializeStoredQueueJob} from "../../src/store/queue-read.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import {claimStopControl,validateStopClaimIn,beginStopWire,finishStopWire,recordStopControlError,type StopControl,type StopClaim} from "../../src/store/stop-control-dispatch.ts";
const owner={resident:"resident",generation:7n},request={attempt:"wire-attempt",wire:'"rpc-1"'},params={threadId:"T",turnId:"V"};
async function fixture(run:(db:DatabaseSync,path:string,c:StopControl)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{
  db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,turn_observation_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,5,7,'input',0,1,'running',1,'V','[]',1.5,2.5); INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',1)");
  const c:StopControl={operation_id:"op",target:"T",channel:42n,owner:3n,resident:"resident",generation:7n,turn:"V",binding:{target:"T",route:"Selected",command:{Stop:{reference:null}}},jobs:[serializeStoredQueueJob(selectJob(db,"job"))],can_settle:true};
  const serialized=`{${Object.entries(c).map(([key,value])=>`${JSON.stringify(key)}:${serializeSerdeValue(value)}`).join(",")}}`;
  db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('op','T','resident',7,'V',?,'accepted')").run(serialized);run(db,path,c);
}finally{db.close();}});}
function row(db:DatabaseSync){return db.prepare("SELECT * FROM cdr_stop_controls WHERE operation_id='op'").get()!;}
function claim(path:string,c:StopControl):StopClaim{const v=claimStopControl(path,c,()=>{});assert.ok(v);return v;}
test("original stop claim wins once and selector is checked before and after exact atomic mutation",async()=>fixture((db,path,c)=>{
  let calls=0;const a=claimStopControl(path,c,()=>{calls++;});assert.ok(a);assert.equal(calls,2);assert.equal(row(db).phase,"dispatching");assert.equal(row(db).claim_token,a.token);assert.match(a.token,/^[0-9a-f-]{36}$/);
  assert.equal(claimStopControl(path,c,()=>{calls++;}),null);assert.equal(calls,3);assert.equal(row(db).claim_token,a.token);assert.equal(db.isTransaction,false);
}));
test("changed selector or async callback rolls back the claim token",async()=>fixture((db,path,c)=>{
  let calls=0;const sentinel={};assert.throws(()=>claimStopControl(path,c,()=>{if(++calls===2)throw sentinel;}),e=>e===sentinel);assert.equal(row(db).phase,"accepted");assert.equal(row(db).claim_token,null);
  calls=0;assert.throws(()=>claimStopControl(path,c,async()=>{calls++;}),/synchronous/);assert.equal(calls,0);assert.equal(row(db).claim_token,null);
}));
test("exact stop wire identity commits once; acknowledgment never implies execution ended",async()=>fixture((db,path,c)=>{
  const a=claim(path,c);assert.equal(validateStopClaimIn(db,a,owner,params).token,a.token);beginStopWire(path,a,owner,request,params);assert.equal(row(db).wire_attempt,request.attempt);assert.equal(row(db).wire_id,request.wire);
  assert.throws(()=>beginStopWire(path,a,owner,request,params));finishStopWire(path,a,owner,request,"reply_ok");assert.equal(row(db).phase,"acknowledged");assert.equal(row(db).last_error,"reply_ok");assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,1);
}));
for(const outcome of ["not_sent","reply_error"])test(`stop ${outcome} retains original claim as unknown without rearming`,async()=>fixture((db,path,c)=>{
  const a=claim(path,c);beginStopWire(path,a,owner,request,params);finishStopWire(path,a,owner,request,outcome);assert.equal(row(db).phase,"unknown");assert.equal(row(db).claim_token,a.token);assert.equal(claimStopControl(path,c,()=>{}),null);
}));
test("stale owner, generation, target, turn or token never admits wire",async()=>fixture((db,path,c)=>{
  const a=claim(path,c);
  for(const o of [{resident:"other",generation:7n},{resident:"resident",generation:8n}])assert.throws(()=>beginStopWire(path,a,o,request,params));
  for(const p of [{threadId:"other",turnId:"V"},{threadId:"T",turnId:"other"}])assert.throws(()=>beginStopWire(path,a,owner,request,p));
  for(const token of ["","other"])assert.throws(()=>beginStopWire(path,{...a,token},owner,request,params));assert.equal(row(db).wire_attempt,null);
}));
for(const change of ["UPDATE codex_turn_queue SET prompt='changed'","UPDATE codex_turn_queue SET owner_user_id=9","DELETE FROM cdr_execution_holds","UPDATE cdr_execution_holds SET target_thread_id='foreign'","INSERT INTO codex_archive_fences VALUES('T','archive',NULL,'attempted')","INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('T','V',7,'{}')","INSERT INTO mirror_threads VALUES('foreign','p','title',100,42,0)"])test(`stop original custody refuses mutation: ${change}`,async()=>fixture((db,path,c)=>{
  const a=claim(path,c);db.exec(change);assert.throws(()=>beginStopWire(path,a,owner,request,params));assert.equal(row(db).wire_attempt,null);
}));
test("wire trigger custody changes roll back both wire identity and queue mutation",async()=>fixture((db,path,c)=>{
  const a=claim(path,c);db.exec("CREATE TRIGGER changed AFTER UPDATE OF wire_attempt ON cdr_stop_controls BEGIN UPDATE codex_turn_queue SET owner_user_id=99 WHERE job_id='job'; END");
  assert.throws(()=>beginStopWire(path,a,owner,request,params));assert.equal(row(db).wire_attempt,null);assert.equal(selectJob(db,"job").ownerUserId,3n);
}));
test("wire-row tampering after assignment fails the final retained wire check",async()=>fixture((db,path,c)=>{
  const a=claim(path,c);db.exec("CREATE TRIGGER changed AFTER UPDATE OF wire_attempt ON cdr_stop_controls BEGIN UPDATE cdr_stop_controls SET wire_id='foreign' WHERE operation_id=NEW.operation_id; END");
  assert.throws(()=>beginStopWire(path,a,owner,request,params));assert.equal(row(db).wire_attempt,null);assert.equal(row(db).wire_id,null);
}));
test("settled terminal evidence survives finish and later original queue deletion does not refresh finish authority",async()=>fixture((db,path,c)=>{
  const a=claim(path,c);beginStopWire(path,a,owner,request,params);db.exec("UPDATE cdr_stop_controls SET phase='settled'; DELETE FROM codex_turn_queue");finishStopWire(path,a,owner,request,"reply_ok");assert.equal(row(db).phase,"settled");assert.equal(row(db).last_error,"reply_ok");
  assert.throws(()=>finishStopWire(path,a,owner,{...request,wire:"different"},"reply_ok"));assert.throws(()=>finishStopWire(path,a,owner,request,"flushed"));
}));
test("diagnostics truncate by Unicode scalar and never overwrite a settled/non-dispatching phase",async()=>fixture((db,path,c)=>{
  const a=claim(path,c);recordStopControlError(path,a,"😀".repeat(1001));assert.equal(row(db).phase,"unknown");assert.equal(Array.from(row(db).last_error as string).length,1000);recordStopControlError(path,a,"overwrite");assert.notEqual(row(db).last_error,"overwrite");
}));
test("unknown serde fields are ignored but invalid primitive types/accessors cannot forge custody",async()=>fixture((db,path,c)=>{
  const a=claimStopControl(path,{...c,extra:true},()=>{});assert.ok(a);beginStopWire(path,{...a,extra:true},owner,request,params);
  assert.throws(()=>finishStopWire(path,{...a,control:{...c,generation:7}},owner,request,"reply_ok"));let calls=0;assert.throws(()=>validateStopClaimIn(db,{...a,get token(){calls++;return a.token;}},owner,params));assert.equal(calls,0);
}));
