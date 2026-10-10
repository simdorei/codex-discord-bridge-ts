import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {observeCompletionTerminal as observe} from "../../src/runtime/completion/observation.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import type {ResidentNotificationEvent} from "../../src/app-server/resident-forwarders.ts";
import {StoreIntegrityError} from "../../src/store/schema-assembly.ts";
import {QueueIntegerRangeError} from "../../src/runtime/queue-runner/errors.ts";
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{
  db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,7,7,'original',0,1,'running',1,'V','[]',1,1)");await run(path,db);
}finally{db.close();}});}
function event(method:string,params:unknown,generation=7n):ResidentNotificationEvent{return {kind:"Notification",generation,notification:{method,params}};}
const final=(text="exact final",extra:Record<string,unknown>={})=>event("item/completed",{threadId:"T",turnId:"V",item:{type:"agentMessage",phase:"final_answer",text,...extra}});
const terminal=(status="completed",extra:Record<string,unknown>={})=>event("turn/completed",{threadId:"T",turn:{id:"V",status,...extra}});
test("final store records only exact Running generation, preserves first value and separates turns",async()=>fixture(async(path,db)=>{
  assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),null);
  for(const [thread,turn,g] of [["other","V",7n],["T","other",7n],["T","V",8n]] as const)assert.equal(await state.recordObservedFinalAnswer(path,thread,turn,g,"wrong"),false);
  assert.equal(await state.recordObservedFinalAnswer(path,"T","V",7n,"첫 답😀\0tail"),true);assert.equal(await state.recordObservedFinalAnswer(path,"T","V",7n,"changed"),false);assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),"첫 답😀\0tail");
  db.exec("UPDATE codex_turn_queue SET state='starting',turn_id=NULL");assert.equal(await state.recordObservedFinalAnswer(path,"T","V",7n,"no"),false);assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),"첫 답😀\0tail");
}));
test("final owner uses observation generation before app-server generation and permits goal-waiting Running",async()=>fixture(async(path,db)=>{
  db.exec("UPDATE codex_turn_queue SET turn_observation_generation=9,goal_waiting=1");assert.equal(await state.recordObservedFinalAnswer(path,"T","V",7n,"old"),false);assert.equal(await state.recordObservedFinalAnswer(path,"T","V",9n,"new"),true);
  assert.equal(await state.getObservedFinalAnswer(path,"T","V",9n),"new");assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),null);
}));
test("final read validates invalid UTF-8 and non-TEXT storage without silently repairing",async()=>fixture(async(path,db)=>{
  await state.recordObservedFinalAnswer(path,"T","V",7n,"original");db.exec("UPDATE codex_observed_final_answers SET content=CAST(x'ff' AS TEXT)");await assert.rejects(state.getObservedFinalAnswer(path,"T","V",7n),StoreIntegrityError);
  db.exec("UPDATE codex_observed_final_answers SET content=x'6162'");await assert.rejects(state.getObservedFinalAnswer(path,"T","V",7n),StoreIntegrityError);
}));
test("final read decodes native UTF-16LE database bytes and missing fields stay null",async()=>storeFixture(async path=>{
  const create=new DatabaseSync(path);create.exec("PRAGMA encoding='UTF-16le';CREATE TABLE sentinel(x)");create.close();await state.getObservedFinalAnswer(path,"T","V",7n);const db=new DatabaseSync(path);try{db.prepare("INSERT INTO codex_observed_final_answers VALUES (?,?,?,?)").run("T","V",7,"한😀");}finally{db.close();}
  assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),"한😀");assert.equal(await state.getObservedFinalAnswer(path,"T","other",7n),null);
}));
test("terminal producer ignores gaps and unrelated methods without creating a database",async()=>storeFixture(async path=>{
  await observe(path,"resident",{kind:"Gap",generation:1n,skipped:2n});await observe(path,"resident",event("unknown",{}));await observe(path,"resident",final("async",{delivery:"async"}));await observe(path,"resident",final("comment",{phase:"commentary"}));assert.equal(existsSync(path),false);
}));
test("final producer preserves source final text extraction and never records async commentary",async()=>fixture(async(path)=>{
  await observe(path,"resident",final(" async ",{delivery:"async"}));assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),null);
  await observe(path,"resident",final("\u0085한😀 \n"));assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),"한😀");await observe(path,"resident",final("conflict"));assert.equal(await state.getObservedFinalAnswer(path,"T","V",7n),"한😀");
}));
test("terminal journal stores bounded metadata and exact resident identity, not prompt or tools",async()=>fixture(async(path,db)=>{
  await observe(path,"first",terminal("failed",{durationMs:5n,error:{message:" error ",codexErrorInfo:"usageLimitExceeded",private:"secret"},items:[{secret:"prompt"}]}));
  const row=db.prepare("SELECT * FROM codex_observed_completions").get()!;assert.equal(row.resident_owner,"first");const value=parseSerdeValue<Record<string,any>>(row.payload as string);assert.deepEqual(value,{threadId:"T",turn:{id:"V",status:"failed",durationMs:5n,error:{message:"error",codexErrorInfo:"usageLimitExceeded"}}});assert.equal((row.payload as string).includes("secret"),false);
  assert.equal(await state.hasObservedCompletionResidentEvidence(path,"T","V",7n,"first"),true);for(const [g,owner] of [[7n,"second"],[8n,"first"]] as const)assert.equal(await state.hasObservedCompletionResidentEvidence(path,"T","V",g,owner),false);
  await observe(path,"second",terminal());assert.equal(db.prepare("SELECT resident_owner FROM codex_observed_completions").get()!.resident_owner,"first");
}));
test("missing owner and stale generation never manufacture final or terminal provenance",async()=>fixture(async(path,db)=>{
  await observe(path,"resident",{...terminal(),generation:8n});await observe(path,"resident",{...final(),generation:8n});assert.equal(await state.hasObservedCompletion(path,"T","V"),false);assert.equal(await state.getObservedFinalAnswer(path,"T","V",8n),null);
  db.exec("DELETE FROM codex_turn_queue");await observe(path,"resident",terminal());assert.equal(await state.hasObservedCompletion(path,"T","V"),false);
}));
test("failed initial terminal write leaves original queue untouched and replaying event does not replay request",async()=>fixture(async(path,db)=>{
  const before=db.prepare("SELECT * FROM codex_turn_queue").get();db.exec("CREATE TRIGGER denied BEFORE INSERT ON codex_observed_completions BEGIN SELECT RAISE(ABORT,'journal denied'); END");await assert.rejects(observe(path,"resident",terminal()),/journal denied/);assert.deepEqual(db.prepare("SELECT * FROM codex_turn_queue").get(),before);assert.equal(await state.hasObservedCompletion(path,"T","V"),false);
  db.exec("DROP TRIGGER denied");await observe(path,"resident",terminal());await observe(path,"resident",terminal());assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()!.n,1);assert.deepEqual(db.prepare("SELECT * FROM codex_turn_queue").get(),before);
}));
test("unknown and in-progress terminal statuses refuse journaling; integer conversion happens even for unrelated notifications",async()=>fixture(async(path)=>{
  for(const status of ["unknown","inProgress"])await assert.rejects(observe(path,"resident",terminal(status)));assert.equal(await state.hasObservedCompletion(path,"T","V"),false);
  await assert.rejects(observe(path,"resident",event("unknown",{},1n<<63n)),QueueIntegerRangeError);
}));
test("invalid direct identity and generation fail before store initialization",async()=>storeFixture(async path=>{
  assert.throws(()=>state.recordObservedFinalAnswer(path,"\ud800","V",7n,"x"));assert.throws(()=>state.getObservedFinalAnswer(path,"T","V",1n<<63n));assert.throws(()=>state.hasObservedCompletionResidentEvidence(path,"T","V",7n,"\ud800"));assert.equal(existsSync(path),false);
}));
test("actual native received final and terminal are durable before observation confirmation",{timeout:15000},async t=>fixture(async(path,db)=>{
  db.exec("UPDATE codex_turn_queue SET app_server_generation=1,execution_generation=1");const code=`import readline from 'node:readline';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='emit'){emit({method:'item/completed',params:{threadId:'T',turnId:'V',item:{type:'agentMessage',phase:'final_answer',text:'native final'}}});emit({method:'turn/completed',params:{threadId:'T',turn:{id:'V',status:'completed'}}});}emit({id:m.id,result:{}});});`;
  const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal),receiver=owner.subscribeNotifications();
  try{const a=owner.admitResponse(1n);try{await a.client.requestAdmitted(a.permit,"emit",{},1000);}finally{a.release();}for(let i=0;i<2;i++){const received=await receiver.receive(t.signal);await observe(path,owner.instanceId,received);if(received.kind==="Notification")owner.confirmIdleObservation(received.generation,received.notification);}
    assert.equal(await state.getObservedFinalAnswer(path,"T","V",1n),"native final");assert.equal(await state.hasObservedCompletionResidentEvidence(path,"T","V",1n,owner.instanceId),true);assert.equal(db.prepare("SELECT attempt_count FROM codex_turn_queue").get()!.attempt_count,1);
  }finally{receiver.dispose();await owner.dispose();}
}));
