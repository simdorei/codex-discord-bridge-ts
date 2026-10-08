import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {createMutationCustodyFence} from "../../src/runtime/mutation-custody-fence.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {selectJob,serializeStoredQueueJob} from "../../src/store/queue-read.ts";
import {ResidentStateError} from "../../src/app-server/resident-state.ts";
import {existsSync} from "node:fs";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import {claimStopControl} from "../../src/store/stop-control-dispatch.ts";
const render=(e:unknown)=>e instanceof Error?e.message:"unavailable";
interface Fixture{db:DatabaseSync;path:string;owner:PortableResidentLifecycle;count():Promise<unknown>;claim():unknown}
function stop(db:DatabaseSync,target:string){db.exec("UPDATE cdr_stop_clock SET revision=1");db.prepare("INSERT INTO cdr_stop_revision_receipts VALUES('stop',?,1,'{}')").run(target);db.prepare("INSERT INTO cdr_stop_revisions VALUES(?,1,'stop')").run(target);}
async function fixture(t:TestContext,run:(f:Fixture)=>Promise<void>,afterOrigin?:(db:DatabaseSync)=>void){await storeFixture(async path=>{
  const db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;
  try{
    db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime'); INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,1,'input',0,1,'starting',1,'[]',1,1)");
    const fence=createMutationCustodyFence(path,"runtime",render);
    const code=`import readline from 'node:readline';let n=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='fixture/count'){emit({id:m.id,result:n});return;}if(m.method==='initialized')return;if(m.method!=='initialize')n++;if(m.params?.hang)return;if(m.params?.remote){emit({id:m.id,error:{code:-7,message:'remote denied'}});return;}emit({id:m.id,result:m.method==='initialize'?{}:{method:m.method,params:m.params}});});`;
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:{...fence,requestOrigin:(m,p)=>{const o=fence.requestOrigin(m,p);afterOrigin?.(db);return o;}}});
    const native=owner;await run({db,path,owner,count:async()=>{const a=native.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,"fixture/count",{},1000);}finally{a.release();}},claim:()=>parseSerdeValue(serializeStoredQueueJob(selectJob(db,"job")))});
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
test("ordinary native mutation captures original stop origin and records exact resident wire completion",{timeout:15000},async t=>fixture(t,async f=>{
  assert.deepEqual(await f.owner.request("thread/settings/update",{threadId:"T",model:"x"},1000,1n),{method:"thread/settings/update",params:{threadId:"T",model:"x"}});
  const r=f.db.prepare("SELECT * FROM codex_mutation_attempts").get()!;assert.equal(r.owner_id,f.owner.instanceId);assert.equal(r.generation,1);assert.equal(r.state,"reply_ok");assert.equal(r.scoped,1);assert.equal(r.target_thread_id,"T");assert.equal(await f.count(),1n);
}));
test("queue native start binds the original claim but sends only ordinary RPC params",{timeout:15000},async t=>fixture(t,async f=>{
  const params={threadId:"T",input:"original"},claim=f.claim();assert.deepEqual(await f.owner.executeQueueTurn({method:"turn/start",params,timeoutMs:1000},1n,claim),{method:"turn/start",params});
  assert.equal(f.db.prepare("SELECT state FROM codex_mutation_attempts").get()!.state,"reply_ok");assert.equal(selectJob(f.db,"job").state,"Starting");assert.equal(await f.count(),1n);
}));
test("original queue changed after capture cannot reach native wire",{timeout:15000},async t=>fixture(t,async f=>{
  const claim=f.claim();f.db.exec("UPDATE codex_turn_queue SET owner_user_id=99");await assert.rejects(f.owner.executeQueueTurn({method:"turn/start",params:{threadId:"T"},timeoutMs:1000},1n,claim),/original queue start/);
  assert.equal(await f.count(),0n);assert.equal(f.db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts").get()!.n,0);
}));
test("stop accepted after original capture revokes ordinary dispatch at final writer",{timeout:15000},async t=>fixture(t,async f=>{
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T"},1000,1n),/predates stop/);assert.equal(await f.count(),0n);assert.equal(f.db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts").get()!.n,0);
},db=>stop(db,"T")));
test("post-insert queue custody trigger rolls back intent before any native bytes",{timeout:15000},async t=>fixture(t,async f=>{
  const c=f.claim();f.db.exec("CREATE TRIGGER changed AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_turn_queue SET owner_user_id=99 WHERE job_id='job'; END");
  await assert.rejects(f.owner.executeQueueTurn({method:"turn/start",params:{threadId:"T"},timeoutMs:1000},1n,c),/original queue start/);assert.equal(await f.count(),0n);assert.equal(selectJob(f.db,"job").ownerUserId,3n);
}));
test("owned Remote reply completes durable reply_error without retaining an unknown hold",{timeout:15000},async t=>fixture(t,async f=>{
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T",remote:true},1000,1n),/remote denied/);assert.equal(f.db.prepare("SELECT state FROM codex_mutation_attempts").get()!.state,"reply_error");assert.equal(f.owner.lifecycleSnapshot().quarantined,false);
}));
test("flushed scoped timeout retains prepared intent, isolates target and does not automatically replay",{timeout:15000},async t=>fixture(t,async f=>{
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T",hang:true},40,1n),/outcome remains unknown/);assert.equal(f.db.prepare("SELECT state FROM codex_mutation_attempts").get()!.state,"prepared");assert.equal(f.owner.lifecycleSnapshot().quarantined,false);
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T"},1000,1n),/unresolved mutation/);await f.owner.request("thread/settings/update",{threadId:"other"},1000,1n);assert.equal(await f.count(),2n);
}));
test("wire reply followed by failed durable completion retains intent and rejects another mutation",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("CREATE TRIGGER denied BEFORE UPDATE ON codex_mutation_attempts BEGIN SELECT RAISE(ABORT,'finish denied'); END");await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T"},1000,1n),/finish denied/);assert.equal(await f.count(),1n);assert.equal(f.db.prepare("SELECT state FROM codex_mutation_attempts").get()!.state,"prepared");
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T"},1000,1n),/unresolved mutation/);assert.equal(await f.count(),1n);
}));
test("durable dead-generation fence applies only to the source method set",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("INSERT INTO codex_dead_generation_holds VALUES('T','runtime',1,0)");
  await assert.rejects(f.owner.request("turn/start",{threadId:"T"},1000,1n),e=>e instanceof ResidentStateError&&e.detail.kind==="DeadGenerationFence");
  await f.owner.request("thread/settings/update",{threadId:"T"},1000,1n);assert.equal(await f.count(),1n);
}));
test("existing-only adapter does not initialize absent stores, while source read-only bypass requires no DB",async()=>storeFixture(async path=>{
  const f=createMutationCustodyFence(path,"runtime",render);assert.equal(f.requestOrigin("thread/read",{threadId:"T"}),null);f.checkRequest(1n,"thread/read",{threadId:"T"});assert.equal(existsSync(path),false);
  assert.throws(()=>f.requestOrigin("turn/start",{threadId:"T"}));assert.throws(()=>f.checkRequest(1n,"turn/start",{threadId:"T"}));assert.equal(existsSync(path),false);assert.equal(typeof f.beginStopMutation,"function");assert.equal(typeof f.finishStopMutation,"function");
}));
test("durable unresolved response blocks its target and unscoped changes, while reads and unrelated target remain available",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("INSERT INTO cdr_server_responses VALUES('old','runtime','resident',1,'T','V','job','{}','hash','admitted',0,0,NULL)");
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T"},1000,1n),/original response custody/);
  await assert.rejects(f.owner.request("unknown/global",{},1000,1n),/original response custody/);
  await f.owner.request("thread/read",{threadId:"T"},1000,1n);await f.owner.request("thread/settings/update",{threadId:"other"},1000,1n);assert.equal(await f.count(),2n);
}));
test("nonsettled stop receipt blocks mutations without blocking explicit interrupt and read custody paths",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('stop','T','resident',1,'V','{}','unknown')");
  await assert.rejects(f.owner.request("thread/settings/update",{threadId:"T"},1000,1n),/stop execution end/);
  await f.owner.request("turn/interrupt",{threadId:"T",turnId:"V"},1000,1n);await f.owner.request("thread/read",{threadId:"T"},1000,1n);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts").get()!.n,0);assert.equal(await f.count(),2n);
}));
function acceptedStop(f:Fixture){
  f.db.exec("UPDATE codex_turn_queue SET state='running',turn_id='V',turn_observation_generation=1; INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',0)");
  const control={operation_id:"stop-original",target:"T",channel:42n,owner:3n,resident:f.owner.instanceId,generation:1n,turn:"V",binding:{target:"T",route:"Selected",command:{Stop:{reference:null}}},jobs:[serializeStoredQueueJob(selectJob(f.db,"job"))],can_settle:true};
  const json=`{${Object.entries(control).map(([k,v])=>`${JSON.stringify(k)}:${serializeSerdeValue(v)}`).join(",")}}`;
  f.db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('stop-original','T',?,1,'V',?,'accepted')").run(f.owner.instanceId,json);
  return claimStopControl(f.path,control,()=>{})!;
}
test("already accepted stop reaches native interrupt once and acknowledgment preserves execution hold",{timeout:15000},async t=>fixture(t,async f=>{
  const claim=acceptedStop(f),request={method:"turn/interrupt",params:{threadId:"T",turnId:"V"},timeoutMs:1000};
  await f.owner.executeStopControl(request,1n,claim,()=>{});assert.equal(await f.count(),1n);assert.equal(f.db.prepare("SELECT phase FROM cdr_stop_controls").get()!.phase,"acknowledged");assert.equal(f.db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts").get()!.n,0);await assert.rejects(f.owner.executeStopControl(request,1n,claim,()=>{}));assert.equal(await f.count(),1n);
}));
test("stale accepted stop cannot interrupt another original queue owner",{timeout:15000},async t=>fixture(t,async f=>{
  const claim=acceptedStop(f);f.db.exec("UPDATE codex_turn_queue SET owner_user_id=99");await assert.rejects(f.owner.executeStopControl({method:"turn/interrupt",params:{threadId:"T",turnId:"V"},timeoutMs:1000},1n,claim,()=>{}),/original stop control/);assert.equal(await f.count(),0n);assert.equal(f.db.prepare("SELECT wire_attempt FROM cdr_stop_controls").get()!.wire_attempt,null);
}));
test("stop wire timeout retains dispatched original receipt and does not grant another interrupt",{timeout:15000},async t=>fixture(t,async f=>{
  const claim=acceptedStop(f);await assert.rejects(f.owner.executeStopControl({method:"turn/interrupt",params:{threadId:"T",turnId:"V",hang:true},timeoutMs:40},1n,claim,()=>{}),/outcome remains unknown/);
  const row=f.db.prepare("SELECT phase,wire_attempt FROM cdr_stop_controls").get()!;assert.equal(row.phase,"dispatching");assert.equal(typeof row.wire_attempt,"string");assert.equal(f.owner.lifecycleSnapshot().quarantined,false);
  await assert.rejects(f.owner.executeStopControl({method:"turn/interrupt",params:{threadId:"T",turnId:"V"},timeoutMs:1000},1n,claim,()=>{}));assert.equal(await f.count(),1n);
}));
