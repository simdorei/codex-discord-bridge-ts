import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import type {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {initializeRuntimeCustody} from "../../src/runtime/runtime-custody.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {serializeDeadGenerationWork,type DeadGenerationWork} from "../../src/app-server/dead-generation-work.ts";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
import {ResidentStateError} from "../../src/app-server/resident-state.ts";
import {createRuntimeFenceErrors} from "../../src/runtime/fence-errors.ts";
const render=(e:unknown)=>e instanceof Error?e.message:"diagnostic";
const code=`import readline from 'node:readline';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='seed'){emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});emit({id:'scoped',method:'approval',params:{threadId:'p',turnId:'vp'}});emit({id:'unscoped',method:'approval',params:{}});}if(m.method==='die'){process.exit(0);return;}if(m.id!==undefined)emit({id:m.id,result:{ok:true}});});`;
async function fixture(t:TestContext,run:(owner:PortableResidentLifecycle,db:DatabaseSync,path:string)=>Promise<void>){await storeFixture(async path=>{
  const custody=await initializeRuntimeCustody(path,"runtime",99n,render),db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;
  try{
    db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','q',42,3,1,'input',0,1,'running',1,'vq','[]',1,1)");
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork:custody.persistDeadWork,oldChildExited(){}},t.signal,{fence:custody.fence,renderError:render});
    await run(owner,db,path);
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
async function call(owner:PortableResidentLifecycle,method:string,t:TestContext){const a=owner.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},1000,undefined,t.signal);}finally{a.release();}}
async function kill(owner:PortableResidentLifecycle,t:TestContext){await call(owner,"seed",t);const changes=owner.subscribeLifecycleChanges();try{await assert.rejects(call(owner,"die",t));await changes.changed(t.signal);}finally{changes.dispose();}}
async function restart(owner:PortableResidentLifecycle,t:TestContext){let reported=false;for(;;){try{if(await owner.restartIfQuiescent(t.signal))return;}catch(error){assert.equal(reported,false);assert.ok(error instanceof AggregateError&&error.errors.some(e=>e?.code==="ERR_STREAM_PREMATURE_CLOSE"));reported=true;}await delay(1,undefined,{signal:t.signal});}}
test("actual process death atomically fences active turns, scoped approvals and queue work before replacement",{timeout:15000},async t=>fixture(t,async(owner,db)=>{
  await kill(owner,t);await restart(owner,t);assert.equal(owner.generation(),2n);
  const receipt=db.prepare("SELECT * FROM codex_dead_generation_incidents").get()!;assert.equal(receipt.runtime_id,"runtime");assert.equal(receipt.generation,1);
  const snapshot=parseSerdeValue<Record<string,any>>(receipt.snapshot_json as string);assert.deepEqual(snapshot.activeTurns,[{threadId:"t",turnId:"v"}]);assert.equal(snapshot.serverRequests.length,2);assert.equal(snapshot.serverRequests[0].occurrence.length,16);assert.ok(snapshot.serverRequests[0].occurrence.every((v:unknown)=>typeof v==="bigint"));
  assert.deepEqual(db.prepare("SELECT target_thread_id FROM codex_dead_generation_holds ORDER BY target_thread_id").all().map(r=>r.target_thread_id),["p","q","t"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()!.n,4);assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()!.n,1);
  await owner.request("thread/read",{threadId:"t"},1000,2n);await assert.rejects(owner.request("turn/start",{threadId:"t"},1000,2n),/process loss/);await owner.request("thread/settings/update",{threadId:"unrelated"},1000,2n);
}));
test("failed capture refuses replacement, leaves no partial hold/notice, and retries the exact original snapshot",{timeout:15000},async t=>fixture(t,async(owner,db)=>{
  db.exec("CREATE TRIGGER capture_denied BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'capture denied'); END");await kill(owner,t);
  // Retry only the quiescence observation until the actual persistence attempt executes.
  let denied=false;while(!denied){try{assert.equal(await owner.restartIfQuiescent(t.signal),false);}catch(error){assert.match(String(error),/capture denied/);denied=true;}if(!denied)await delay(1,undefined,{signal:t.signal});}
  assert.equal(owner.generation(),1n);for(const table of ["codex_dead_generation_incidents","codex_dead_generation_holds","codex_delivery_outbox"])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
  db.exec("DROP TRIGGER capture_denied");await restart(owner,t);assert.equal(owner.generation(),2n);assert.equal(db.prepare("SELECT count(*) AS n FROM codex_dead_generation_incidents").get()!.n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()!.n,4);
}));
test("runtime startup publishes both identities and keeps old incidents/attempts rather than authorizing replay",async()=>storeFixture(async path=>{
  await initializeRuntimeCustody(path,"first",null,render);const db=await openInitialized(path);try{
    db.exec("INSERT INTO codex_dead_generation_incidents VALUES('first',1,'{}','[]',0)");await initializeRuntimeCustody(path,"second",0n,render);
    assert.equal(db.prepare("SELECT runtime_id FROM codex_app_server_runtime").get()!.runtime_id,"second");assert.equal(db.prepare("SELECT runtime_id FROM codex_mutation_runtime").get()!.runtime_id,"second");assert.equal(db.prepare("SELECT count(*) AS n FROM codex_dead_generation_incidents").get()!.n,1);
  }finally{db.close();}
}));
test("startup rejects overflowing channel before creating database and recorder refuses removed schema",async()=>storeFixture(async path=>{
  await assert.rejects(initializeRuntimeCustody(path,"runtime",1n<<63n,render));assert.equal(existsSync(path),false);
  const c=await initializeRuntimeCustody(path,"runtime",99n,render),db=await openInitialized(path);try{db.exec("DROP TABLE codex_app_server_runtime");assert.throws(()=>c.persistDeadWork("owner",{generation:1n,closedReason:"EOF",activeTurns:[],serverRequests:[]}),/no such table/);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_app_server_runtime'").get()!.n,0);}finally{db.close();}
}));
test("dead work serialization preserves exact source struct order, vector order and occurrence integer bytes",()=>{
  const work:DeadGenerationWork={generation:7n,closedReason:"한😀",activeTurns:[{threadId:"T",turnId:"V"}],serverRequests:[{id:9n,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(1)),method:"approval",params:{z:2n,a:1n}}]};
  assert.equal(serializeDeadGenerationWork(work),'{'+'"generation":7,"closedReason":"한😀","activeTurns":[{"threadId":"T","turnId":"V"}],"serverRequests":[{"id":9,"occurrence":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"method":"approval","params":{"a":1,"z":2}}]}');
  let calls=0;assert.throws(()=>serializeDeadGenerationWork({...work,get closedReason(){calls++;return "changed";}}));assert.equal(calls,0);
});
test("second activation failure is reported centrally and preserves source two-step partial activation",async()=>storeFixture(async path=>{
  await initializeRuntimeCustody(path,"first",null,render);const db=await openInitialized(path);try{
    db.exec("CREATE TRIGGER reject_new_runtime BEFORE UPDATE ON codex_mutation_runtime BEGIN SELECT RAISE(ABORT,'runtime activation denied'); END");
    await assert.rejects(initializeRuntimeCustody(path,"second",null,render),e=>e instanceof ResidentStateError&&e.detail.kind==="DeadGenerationFence"&&e.message.includes("runtime activation denied"));
    assert.equal(db.prepare("SELECT runtime_id FROM codex_app_server_runtime").get()!.runtime_id,"second");assert.equal(db.prepare("SELECT runtime_id FROM codex_mutation_runtime").get()!.runtime_id,"first");
  }finally{db.close();}
}));
test("central fence error mapping delegates diagnostics without inspecting error fields",()=>{
  let touched=0,seen:unknown;const opaque={get message(){touched++;throw new Error("must not read");}},mapper=createRuntimeFenceErrors(e=>{seen=e;return "redacted";});
  for(const kind of ["MutationHeld","DeadGenerationFence"] as const)assert.throws(()=>mapper.run(kind,()=>{throw opaque;}),e=>e instanceof ResidentStateError&&e.detail.kind===kind&&e.detail.message==="redacted");
  assert.equal(seen,opaque);assert.equal(touched,0);assert.equal(mapper.run("MutationHeld",()=>42),42);assert.equal(Object.isFrozen(mapper),true);
  assert.throws(()=>createRuntimeFenceErrors((async()=>"bad") as unknown as (e:unknown)=>string),/synchronous/);
});
