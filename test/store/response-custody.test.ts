import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {serializeStoredQueueJob,selectJob} from "../../src/store/queue-read.ts";
import {captureResponseCustody,captureResponseCustodyOn,beginResponseCustody,beginResponseCustodyOn,finishResponseCustody,finishResponseCustodyOn,checkResponseCustody,checkAllResponseCustody,requireResponseUnheldIn,type ResponseCustodyScope} from "../../src/store/response-custody.ts";
const scope:ResponseCustodyScope={runtime:"runtime",resident:"resident",generation:7n,request:{id:71n,occurrence:[1n,2n,3n],method:"item/tool/requestUserInput",params:{threadId:"target",turnId:"turn"}}};
const body={result:1n};
async function fixture(run:(db:DatabaseSync,path:string)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{
  db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");
  db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('original','target',42,3,101,7,'input',0,1,'running',1,'turn','[]',?,?)").run(1790584100.0000021,1790584100.0000021);
  await run(db,path);
}finally{db.close();}});}
function count(db:DatabaseSync):number{return Number(db.prepare("SELECT COUNT(*) AS n FROM cdr_server_responses").get()!.n);}
function phase(db:DatabaseSync):unknown{return db.prepare("SELECT phase FROM cdr_server_responses").get()?.phase;}
function hold(db:DatabaseSync):void{db.exec("INSERT INTO cdr_execution_holds VALUES('original','target','stop','{}',1)");}
test("capture preserves opaque original-job timestamps and exact occurrence bound authority",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope) as Record<string,unknown>;
  assert.equal(a.key,"f5503615f10c170e51b1c6bf74008732837536ce74ad289a09f570894afa007e");
  assert.equal(a.request_sha256,"19c70797db3e051565af8149f2077861df2778f8a82a086414380edb707ebb17");
  assert.equal(a.original_job,serializeStoredQueueJob(selectJob(db,"original")));assert.equal(a.generation,7n);assert.equal(a.mapping,null);assert.equal(a.stop_sequence,0n);assert.equal(count(db),0);assert.equal(db.isTransaction,false);
  const different=captureResponseCustody(path,{...scope,request:{...(scope.request as object),occurrence:[9n]}}) as Record<string,unknown>;assert.notEqual(a.key,different.key);
}));
for(const column of ["target_thread_id","turn_id","job_id"])test(`admission verifies stored ${column} after trigger and rolls back changed authority`,async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);db.exec(`CREATE TRIGGER changed AFTER INSERT ON cdr_server_responses BEGIN UPDATE cdr_server_responses SET ${column}='foreign' WHERE request_key=NEW.request_key; END`);
  assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.equal(count(db),0);
}));
test("stop after capture or during insertion revokes send authority and preserves original queue",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);hold(db);assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.equal(count(db),0);assert.equal(selectJob(db,"original").ownerUserId,3n);
  db.exec("DELETE FROM cdr_execution_holds; CREATE TRIGGER stopped AFTER INSERT ON cdr_server_responses BEGIN INSERT INTO cdr_execution_holds VALUES('original','target','stop','{}',1); END");
  assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.equal(count(db),0);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,0);
}));
test("flush is not terminal and repeated occurrence can never obtain another send",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);beginResponseCustody(path,scope,a,body);
  assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.throws(()=>finishResponseCustody(path,scope,a,body,"reply_ok"));
  finishResponseCustody(path,scope,a,body,"flushed");assert.equal(phase(db),"flushed");assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.throws(()=>finishResponseCustody(path,scope,a,body,"flushed"));assert.equal(count(db),1);
}));
test("new runtime cannot finish or reuse an admitted old response",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);beginResponseCustody(path,scope,a,body);db.exec("UPDATE codex_mutation_runtime SET runtime_id='replacement'");
  assert.throws(()=>finishResponseCustody(path,scope,a,body,"flushed"));assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.equal(phase(db),"admitted");
}));
test("tampered payload and failed finish retain admitted evidence and block only the affected thread",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);beginResponseCustody(path,scope,a,body);
  assert.throws(()=>finishResponseCustody(path,scope,a,{result:2n},"flushed"));
  db.exec("CREATE TRIGGER reject_finish BEFORE UPDATE ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'fixture finish failure'); END");
  assert.throws(()=>finishResponseCustody(path,scope,a,body,"flushed"),/fixture finish failure/);assert.throws(()=>checkResponseCustody(path,"target"));checkResponseCustody(path,"other");assert.throws(()=>checkAllResponseCustody(path));assert.equal(phase(db),"admitted");
}));
for(const change of ["UPDATE codex_turn_queue SET owner_user_id=99","UPDATE codex_turn_queue SET prompt='changed'","UPDATE codex_turn_queue SET goal_waiting=1","UPDATE codex_turn_queue SET state='pending'","INSERT INTO mirror_threads VALUES('other','p','t',100,42,1)","DELETE FROM codex_turn_queue"])test(`capture becomes stale after original custody mutation: ${change}`,async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);db.exec(change);assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.equal(count(db),0);
}));
test("final completion accepts a retained terminal despite a subsequent stop but does not erase stop",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);beginResponseCustody(path,scope,a,body);hold(db);
  // This test controls the terminal row; the authenticated terminal producer is tested separately.
  db.exec("UPDATE cdr_server_responses SET phase='terminal'");finishResponseCustody(path,scope,a,body,"flushed");assert.equal(phase(db),"terminal");finishResponseCustody(path,scope,a,body,"not_sent");assert.equal(phase(db),"terminal");
  assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,1);assert.throws(()=>beginResponseCustody(path,scope,a,body));
}));
test("not_sent is retained without replay, and deletion/insertion failure yields no authority",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'fixture admission failure'); END");
  assert.throws(()=>beginResponseCustody(path,scope,a,body),/fixture admission failure/);assert.equal(count(db),0);db.exec("DROP TRIGGER reject_insert");beginResponseCustody(path,scope,a,body);finishResponseCustody(path,scope,a,body,"not_sent");assert.equal(phase(db),"not_sent");assert.throws(()=>beginResponseCustody(path,scope,a,body));
}));
test("denied unknown authority fields, changed identity and JS numeric coercion cannot pass",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope) as Record<string,unknown>;
  for(const patch of [{extra:true},{generation:7},{resident:"other"},{thread:"other"},{request_sha256:"wrong"},{stop_sequence:1n}])assert.throws(()=>beginResponseCustody(path,scope,{...a,...patch},body));
  assert.throws(()=>beginResponseCustody(path,{...scope,request:{...(scope.request as object),occurrence:[2n]}},a,body));
  let calls=0;assert.throws(()=>beginResponseCustody(path,scope,{...a,get key(){calls++;return a.key;}},body));assert.equal(calls,0);assert.equal(count(db),0);
}));
test("ambiguous original jobs and missing scope fields fail before admission",async()=>fixture((db,path)=>{
  for(const request of [{},null,{...(scope.request as object),id:null},{...(scope.request as object),params:{threadId:" target",turnId:"turn"}}])assert.throws(()=>captureResponseCustody(path,{...scope,request}));
  db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('duplicate','target',42,3,7,'x',0,1,'running',1,'turn','[]',1,1)");
  assert.throws(()=>captureResponseCustody(path,scope));assert.equal(count(db),0);
}));
test("borrowed variants preserve caller transactions and owned existing-only checks do not create an absent store",async()=>fixture((db,path)=>{
  const a=captureResponseCustodyOn(db,scope);db.exec("BEGIN");assert.throws(()=>beginResponseCustodyOn(db,scope,a,body));assert.equal(db.isTransaction,true);db.exec("ROLLBACK");
  beginResponseCustodyOn(db,scope,a,body);requireResponseUnheldIn(db,"other");finishResponseCustodyOn(db,scope,a,body,"flushed");assert.equal(db.isOpen,true);assert.equal(db.isTransaction,false);
  assert.throws(()=>checkAllResponseCustody(path+".absent"));
}));
test("authority mapping Option may be absent while all other fields remain mandatory",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope) as Record<string,unknown>;const without={...a};delete without.mapping;beginResponseCustody(path,scope,without,body);
  const stored=db.prepare("SELECT authority_json FROM cdr_server_responses").get()!.authority_json as string;assert.equal(parseSerdeValue<Record<string,unknown>>(stored).mapping,null);
}));
function seedResponses(db:DatabaseSync,n:number,state:string):void{
  const q=db.prepare("INSERT INTO cdr_server_responses VALUES(?,'runtime','resident',7,'other','v','j','{}','hash',?,0,?,NULL)");
  db.exec("BEGIN");try{for(let i=0;i<n;i++)q.run("old-"+String(i).padStart(4,"0"),state,i);db.exec("COMMIT");}catch(e){db.exec("ROLLBACK");throw e;}
}
test("only proved terminal history is pruned to 256 and uncertain/flush records remain bounded without eviction",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);seedResponses(db,300,"terminal");beginResponseCustody(path,scope,a,body);assert.equal(count(db),257);
  assert.equal(db.prepare("SELECT MIN(request_key) AS k FROM cdr_server_responses WHERE phase='terminal'").get()!.k,"old-0044");
  db.exec("DELETE FROM cdr_server_responses");seedResponses(db,1024,"flushed");assert.throws(()=>beginResponseCustody(path,scope,a,body));assert.equal(count(db),1024);
}));
test("failed insert rolls back history pruning as well as response admission",async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);seedResponses(db,300,"terminal");db.exec("CREATE TRIGGER no_send BEFORE INSERT ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'denied insert'); END");
  assert.throws(()=>beginResponseCustody(path,scope,a,body),/denied insert/);assert.equal(count(db),300);
}));
for(const column of ["target_thread_id","turn_id","job_id","response_sha256"])test(`finish rechecks ${column} against immutable retained evidence and rolls back trigger`,async()=>fixture((db,path)=>{
  const a=captureResponseCustody(path,scope);beginResponseCustody(path,scope,a,body);db.exec(`CREATE TRIGGER changed_finish AFTER UPDATE ON cdr_server_responses BEGIN UPDATE cdr_server_responses SET ${column}='foreign' WHERE request_key=NEW.request_key; END`);
  assert.throws(()=>finishResponseCustody(path,scope,a,body,"flushed"));assert.equal(phase(db),"admitted");
}));
