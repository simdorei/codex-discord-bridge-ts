import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../../../helpers/store-fixture.ts";
import {queueJob} from "../../../helpers/queue-job.ts";
import {openInitialized} from "../../../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../../../src/store/state-access-facade.ts";
import {initialCompletionCursor,type CompletionEntry} from "../../../../src/store/completion-metadata.ts";
import type {CompletionSource} from "../../../../src/store/completion-metadata-sql.ts";
import {deliverCompletionEntry} from "../../../../src/runtime/completion/scheduler/http-work.ts";
const resident={instanceId:()=>"runtime",generation:()=>1n};
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const head=async(path:string,source:CompletionSource)=>(await state.completionPage(path,source,initialCompletionCursor(),"runtime",1n)).page.entries[0]!;
const questions={async deliverChecked(){throw new Error("unexpected question");}};
function options(sent:string[]){return {transport:{async sendValidated(r:{body:string}){sent.push(JSON.parse(r.body).content);return BigInt(sent.length);}},failures:{render:()=>"safe failure"},now:()=>1};}
async function final(path:string){await edit(path,db=>db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('d','j','t','u',1,'final',1,1)"));}
test("current final entry uses guarded confirmed send and retires only its outbox",async()=>storeFixture(async path=>{
  await final(path);const sent:string[]=[];await deliverCompletionEntry(path,await head(path,"Final"),resident,options(sent),questions);assert.deepEqual(sent,["final"]);assert.deepEqual(await state.listPendingDeliveries(path),[]);
}));
test("stale entry does no transport call and preserves changed durable content",async()=>storeFixture(async path=>{
  await final(path);const entry=await head(path,"Final");await edit(path,db=>db.exec("UPDATE codex_delivery_outbox SET content='changed body'"));const sent:string[]=[];await deliverCompletionEntry(path,entry,resident,options(sent),questions);assert.deepEqual(sent,[]);assert.equal((await state.listPendingDeliveries(path))[0]?.content,"changed body");
}));
test("commentary and Goal payload branches retain their original ordering/ownership checks",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('c','j','t','u',1,'progress'); INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('t','u',1,'goal',NULL)"));const sent:string[]=[];
  await deliverCompletionEntry(path,await head(path,"Commentary"),resident,options(sent),questions);assert.deepEqual(sent,["In progress\nprogress"]);
  await assert.rejects(deliverCompletionEntry(path,await head(path,"Goal"),resident,options(sent),questions),/legacy goal progress/);assert.equal((await state.pendingGoalProgress(path)).length,1);
}));
test("start notice branch rechecks exact no-turn custody and keeps queue held",async()=>storeFixture(async path=>{
  await state.enqueue(path,queueJob({jobId:"start",targetThreadId:"t"}));await edit(path,db=>db.exec("UPDATE codex_turn_queue SET last_error='[cdr-rust:auto-reserve-hold:v1] usage'; INSERT INTO codex_reserve_start_notices(job_id,target_thread_id,channel_id,app_server_generation,attempt_count,content,created_at) VALUES ('start','t',1,1,0,'Failed start',1)"));
  const sent:string[]=[];await deliverCompletionEntry(path,await head(path,"StartFailure"),resident,options(sent),questions);assert.deepEqual(sent,["Failed start"]);assert.equal((await state.pendingStartNotices(path)).length,0);await edit(path,db=>assert.equal(db.prepare("SELECT state FROM codex_turn_queue").get()?.state,"pending"));
}));
test("question branch passes current generation to mandatory checked UI adapter, not a raw POST",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,created_at,updated_at) VALUES ('q','runtime',1,'t','u','i','j',1,2,'{\"index\":0,\"title\":\"Q\",\"options\":[]}',1,1)"));
  let calls=0,seen:bigint|undefined;const sent:string[]=[];
  await deliverCompletionEntry(path,await head(path,"Question"),{instanceId:()=>"runtime",generation:()=>++calls===1?1n:2n},options(sent),{async deliverChecked(_path,current,_transport,q){seen=current;assert.equal(q.generation,1n);assert.equal(q.id,"q");}});
  assert.equal(seen,2n);assert.deepEqual(sent,[]);
}));
test("Observed is state work and cannot POST through HTTP dispatcher",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES ('t','u',1,'bad json')"));const sent:string[]=[];await deliverCompletionEntry(path,await head(path,"Observed"),resident,options(sent),questions);assert.deepEqual(sent,[]);
}));
test("out-of-i64 generation refuses before initializing a database",async()=>storeFixture(async path=>{
  const entry:CompletionEntry={source:"Final",id:"d",target:"t",turn:"u",channel:1n,bytes:1n,position:{stamp:0,ordinal:0n,id:"d"}};
  await assert.rejects(deliverCompletionEntry(path,entry,{instanceId:()=>"runtime",generation:()=>1n<<63n},options([]),questions),/SQLite integer contract/);assert.equal(existsSync(path),false);
}));
