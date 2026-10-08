import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {allJobs,serializeStoredQueueJob} from "../../src/store/queue-read.ts";
import {generationIsSealedIn,targetIsHeldIn} from "../../src/store/dead-generation-admission.ts";
import {activateDeadGenerationRuntime,activateDeadGenerationRuntimeIn,captureDeadGeneration,captureDeadGenerationOn,type DeadGenerationCapture} from "../../src/store/dead-generation-capture.ts";
import {migrateDeadGeneration} from "../../src/store/schema-extensions-b1.ts";
const base:DeadGenerationCapture={runtimeId:"runtime",generation:7n,snapshotJson:'{"closed":"EOF"}',affectedTargets:[],startupChannelId:99n,hasUnscopedRequests:false,now:12.5};
async function fixture(run:(db:DatabaseSync,path:string)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{activateDeadGenerationRuntimeIn(db,"runtime");await run(db,path);}finally{db.close();}});}
function job(db:DatabaseSync,id:string,target:string,state="running",generation=7n,channel=55n,time=1){db.prepare("INSERT INTO codex_turn_queue (job_id,target_thread_id,channel_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES (?,?,?,?,'prompt',1,0,?,0,'[]',?,?)").run(id,target,channel,generation,state,time,time);}
function map(db:DatabaseSync,target:string,channel=22n,thread=33n){db.prepare("INSERT INTO mirror_threads VALUES (?,'p','title',?,?,0)").run(target,channel,thread);}
function count(db:DatabaseSync,table:string):number{return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);}
function empty(db:DatabaseSync){for(const t of ["codex_dead_generation_incidents","codex_dead_generation_holds","codex_delivery_outbox"])assert.equal(count(db,t),0);assert.equal(db.isTransaction,false);}

test("dead-generation capture atomically records ordered exact jobs and UTF-8 sorted union of targets",async()=>fixture(db=>{
  job(db,"b","queue","starting",7n,9007199254740993n,2);job(db,"a","queue","running",7n,56n,1);job(db,"p","pending","pending");job(db,"other","other","running",8n);
  job(db,"quarantine","quarantined");db.exec("UPDATE codex_turn_queue SET turn_id='cdr-quarantined:x',last_error='[cdr-rust:app-server-fork-quarantine:v1] x' WHERE job_id='quarantine'");
  const expected=allJobs(db).filter(j=>["a","b"].includes(j.jobId));
  assert.equal(captureDeadGenerationOn(db,{...base,affectedTargets:["😀","\uE000","queue","😀"],hasUnscopedRequests:true}),true);
  const receipt=db.prepare("SELECT * FROM codex_dead_generation_incidents").get()!;
  assert.equal(receipt.snapshot_json,base.snapshotJson);assert.equal(receipt.queue_jobs_json,`[${expected.map(serializeStoredQueueJob).join(",")}]`);
  const rows=db.prepare("SELECT delivery_id,target_thread_id,channel_id,job_id,turn_id FROM codex_delivery_outbox ORDER BY delivery_id").all();
  assert.deepEqual(rows.map(r=>r.target_thread_id),["queue","\uE000","😀",""]);assert.deepEqual(rows.map(r=>r.channel_id),[56,99,99,99]);
  for(const [i,r]of rows.entries()){assert.equal(r.delivery_id,`dead-generation:runtime:7:${i}`);assert.equal(r.job_id,r.delivery_id);assert.equal(r.turn_id,r.delivery_id);}
  assert.equal(generationIsSealedIn(db,7n),true);assert.equal(generationIsSealedIn(db,8n),false);assert.equal(targetIsHeldIn(db,"pending"),false);assert.equal(count(db,"codex_turn_queue"),5);
}));
test("exact receipt retry bypasses jobs and channels without restaging delivered notices",async()=>fixture(db=>{
  assert.equal(captureDeadGenerationOn(db,{...base,affectedTargets:["T"]}),true);db.exec("DELETE FROM codex_delivery_outbox; DROP TABLE codex_turn_queue; DROP TABLE mirror_threads");
  assert.equal(captureDeadGenerationOn(db,{...base,affectedTargets:["different"],startupChannelId:null,hasUnscopedRequests:true,now:13}),false);
  assert.equal(count(db,"codex_delivery_outbox"),0);assert.equal(targetIsHeldIn(db,"different"),false);
  assert.throws(()=>captureDeadGenerationOn(db,{...base,snapshotJson:'{ "closed":"EOF"}'}),/snapshot changed/);
}));
test("runtime is checked before replay and activation changes generation seal without removing prior holds",async()=>fixture(db=>{
  captureDeadGenerationOn(db,{...base,affectedTargets:["T"]});activateDeadGenerationRuntimeIn(db,"replacement");
  assert.throws(()=>captureDeadGenerationOn(db,base),/identity is stale/);assert.equal(generationIsSealedIn(db,7n),false);assert.equal(targetIsHeldIn(db,"T"),true);
  assert.equal(captureDeadGenerationOn(db,{...base,runtimeId:"replacement",affectedTargets:["T"]}),true);
  assert.equal(db.prepare("SELECT runtime_id FROM codex_dead_generation_holds").get()!.runtime_id,"runtime");assert.equal(count(db,"codex_delivery_outbox"),2);
}));
test("notice recipient precedence uses first queue row then mapping then startup without positivity fallback",async()=>fixture(db=>{
  map(db,"mapped-thread");map(db,"mapped-channel",22n,0n);
  captureDeadGenerationOn(db,{...base,affectedTargets:["mapped-thread","mapped-channel"]});
  assert.deepEqual(db.prepare("SELECT channel_id FROM codex_delivery_outbox ORDER BY target_thread_id").all().map(r=>r.channel_id),[22,33]);
  job(db,"bad","bad","running",8n,0n);map(db,"bad",5n,6n);
  assert.throws(()=>captureDeadGenerationOn(db,{...base,generation:8n}),/no usable channel/);assert.equal(count(db,"codex_dead_generation_incidents"),1);assert.equal(targetIsHeldIn(db,"bad"),false);
}));
test("later notice failure rolls back incident, holds and earlier notices together",async()=>fixture(db=>{
  map(db,"a");assert.throws(()=>captureDeadGenerationOn(db,{...base,affectedTargets:["a","z"],startupChannelId:null}),/no usable channel/);empty(db);
  db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'notice failure'); END");
  assert.throws(()=>captureDeadGenerationOn(db,{...base,affectedTargets:["a"]}),/notice failure/);empty(db);
}));
test("all jobs decode before filtering and a mapped corruption is read even with a valid queue channel",async()=>fixture(db=>{
  job(db,"unrelated","U","pending",99n);db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='{' WHERE job_id='unrelated'");
  assert.throws(()=>captureDeadGenerationOn(db,base),/JSON/);empty(db);db.exec("DELETE FROM codex_turn_queue");
  job(db,"good","T");map(db,"T");db.exec("UPDATE mirror_threads SET discord_thread_id='bad' WHERE codex_thread_id='T'");
  assert.throws(()=>captureDeadGenerationOn(db,base),/integer bigint/);empty(db);
}));
test("capture validation preserves source empty/whitespace distinctions and rejects invalid JSON before SQL",async()=>fixture(db=>{
  for(const patch of [{runtimeId:""},{generation:0n},{generation:1n<<63n},{affectedTargets:["\u0085"]},{snapshotJson:"{"},{now:-1},{startupChannelId:1n<<63n}])assert.throws(()=>captureDeadGenerationOn(db,{...base,...patch}));empty(db);
  assert.throws(()=>activateDeadGenerationRuntimeIn(db,"\u0085"),/empty app-server/);
  // Capture only checks runtime is nonempty; the active row may contain whitespace.
  db.exec("UPDATE codex_app_server_runtime SET runtime_id=' '");assert.equal(captureDeadGenerationOn(db,{...base,runtimeId:" ",affectedTargets:["\uFEFF"]}),true);
}));
test("caller transaction is neither nested nor rolled back and query_only failure leaves no partial state",async()=>fixture(db=>{
  db.exec("BEGIN");assert.throws(()=>captureDeadGenerationOn(db,base));assert.equal(db.isTransaction,true);db.exec("ROLLBACK; PRAGMA query_only=ON");
  assert.throws(()=>captureDeadGenerationOn(db,base),/readonly/);empty(db);
}));
test("owned path snapshots the caller before async initialization and keeps receipt exact",async()=>fixture(async(db,path)=>{
  await activateDeadGenerationRuntime(path,"runtime");const c={...base,affectedTargets:["T"]};const pending=captureDeadGeneration(path,c);c.affectedTargets[0]="changed";c.snapshotJson="null";
  assert.equal(await pending,true);assert.equal(targetIsHeldIn(db,"T"),true);assert.equal(targetIsHeldIn(db,"changed"),false);assert.equal(db.prepare("SELECT snapshot_json FROM codex_dead_generation_incidents").get()!.snapshot_json,base.snapshotJson);
}));
for(const encoding of ["UTF-8","UTF-16le","UTF-16be"])test(`repeat receipt decodes exact ${encoding} text and rejects corrupt receipt storage`,()=>{
  const db=new DatabaseSync(":memory:");try{
    db.exec(`PRAGMA encoding='${encoding}'`);migrateDeadGeneration(db);activateDeadGenerationRuntimeIn(db,"한😀");
    const c={...base,runtimeId:"한😀",snapshotJson:'{"한":"😀"}'};
    db.prepare("INSERT INTO codex_dead_generation_incidents VALUES(?,7,?,'[]',0)").run(c.runtimeId,c.snapshotJson);
    // No queue or mapping exists: a matching receipt must return before those reads.
    assert.equal(captureDeadGenerationOn(db,c),false);
    db.exec("UPDATE codex_dead_generation_incidents SET snapshot_json=x'ff'");assert.throws(()=>captureDeadGenerationOn(db,c),/Expected string/);assert.equal(db.isTransaction,false);
  }finally{db.close();}
});
test("no affected work can seal without a channel while an unscoped notice requires a usable destination",async()=>fixture(db=>{
  assert.equal(captureDeadGenerationOn(db,{...base,startupChannelId:null}),true);assert.equal(count(db,"codex_delivery_outbox"),0);
  assert.throws(()=>captureDeadGenerationOn(db,{...base,generation:8n,startupChannelId:null,hasUnscopedRequests:true}),/no usable channel/);
  assert.equal(generationIsSealedIn(db,8n),false);assert.equal(count(db,"codex_dead_generation_incidents"),1);
}));
