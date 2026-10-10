import {advanceAcceptedStopRevisionIn} from "../../src/store/stop-acceptance.ts";
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {serializeStopControl} from "../../src/store/stop-control-dispatch.ts";
import {serializeStoredQueueJob,selectJob} from "../../src/store/queue-read.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {createMutationCustodyFence} from "../../src/runtime/mutation-custody-fence.ts";
import {interruptTurn} from "../../src/app-server/requests.ts";
import {observeCompletionTerminal} from "../../src/runtime/completion/observation.ts";
import {existsSync} from "node:fs";
const scope={target:"T",channel:42n,owner:3n},binding={target:"T",route:"Explicit",command:{Stop:{reference:"T"}}};
async function fixture(run:(path:string,db:DatabaseSync)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function job(db:DatabaseSync,id="job",status="running",turn:string|null="V"){db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES(?,'T',42,3,7,?, 'original',0,1,?,?,?,'[]',1.25,1.5)").run(id,status==="pending"?null:7,status,status==="pending"?0:1,turn);}
function controlIngress(db:DatabaseSync){db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,source_message_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:100','message',100,42,3,100,?,'executing','processing','T',10,11)").run(serializeSerdeValue({version:1n,lifecycle_binding:binding,plan:{Execute:binding.command}}));return getIngressIn(db,"message:100")!;}
function accept(path:string,expected:ReturnType<typeof controlIngress>|null=null,g=7n,check=()=>{}){return state.acceptRunningStop(path,scope,binding,expected,"resident",g,check,()=>50);}
function rollbackState(db:DatabaseSync){for(const table of ["cdr_execution_holds","cdr_stop_controls","cdr_stop_revision_receipts"])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);}
test("Running admission records opaque original jobs and first holds without changing queue",async()=>fixture((path,db)=>{
  job(db);job(db,"pending","pending",null);const original=controlIngress(db),before=db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id").all(),raw=serializeStoredQueueJob(selectJob(db,"job"));let checked=0;const c=accept(path,original,7n,()=>{checked++;})!;
  assert.equal(c.operation_id,"stop:message:100");assert.equal(c.turn,"V");assert.equal(c.can_settle,true);assert.equal(c.jobs[0],raw);assert.equal(checked,2);assert.deepEqual(db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id").all(),before);
  const r=db.prepare("SELECT * FROM cdr_stop_controls").get()!;assert.equal(r.phase,"accepted");assert.equal(r.claim_token,null);assert.equal(r.record_json,serializeStopControl(c));assert.equal(getIngressIn(db,"message:100")!.phase,"stop_accepted");
  assert.equal((getIngressIn(db,"message:100")!.outcome as any).execution_end_confirmed,false);
}));
test("no Running owner returns no control before preparing/unowned decoding",async()=>fixture((path,db)=>{
  job(db,"pending","pending",null);db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES('i','T',42,CAST(x'ff' AS TEXT),0,0,1,1)");assert.equal(accept(path),null);rollbackState(db);
}));
for(const sql of ["UPDATE codex_turn_queue SET turn_id=NULL","UPDATE codex_turn_queue SET turn_id=''","UPDATE codex_turn_queue SET owner_user_id=99","UPDATE codex_turn_queue SET channel_id=99","INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('T','V',6,'{}')"])
 test(`Running admission rejects ${sql}`,async()=>fixture((path,db)=>{job(db);db.exec(sql);assert.throws(()=>accept(path));rollbackState(db);}));
test("multiple Running and mixed quarantined owners are refused",async()=>{
  await fixture((path,db)=>{job(db);job(db,"other","running","V2");assert.throws(()=>accept(path));rollbackState(db);});
  await fixture((path,db)=>{job(db);job(db,"other","running","cdr-quarantined:old");db.exec("UPDATE codex_turn_queue SET last_error='[cdr-rust:app-server-fork-quarantine:v1] old' WHERE job_id='other'");assert.throws(()=>accept(path));rollbackState(db);});
});
for(const change of ["UPDATE codex_turn_queue SET goal_waiting=1","UPDATE codex_turn_queue SET turn_observation_generation=6","INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('starting','T',42,3,7,'p',0,1,'starting',1,'[]',1,1)"])
 test(`uncertain ownership retains stop intent but cannot certify settlement: ${change}`,async()=>fixture((path,db)=>{job(db);db.exec(change);assert.equal(accept(path)!.can_settle,false);assert.equal(db.prepare("SELECT phase FROM cdr_stop_controls").get()!.phase,"accepted");}));
test("preparing/unowned originals receive holds while Running can_settle retains its exact source job-only meaning",async()=>fixture((path,db)=>{
  job(db);db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES('i','T',42,3,'raw',0,0,1,1)");db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,source_message_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:101','message',101,42,3,101,?,'executing','processing','T',10,11)").run(serializeSerdeValue({version:1n,plan:{Execute:{Ask:{prompt:"raw"}}}}));
  const c=accept(path)!;assert.equal(c.can_settle,true);assert.equal(getIngressIn(db,"message:101")!.state,"held");assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,2);const evidence=parseSerdeValue<Record<string,unknown>>(db.prepare("SELECT evidence_json FROM cdr_execution_holds WHERE job_id='i'").get()!.evidence_json as string);assert.equal(evidence.operation_id,c.operation_id);
  const scope=parseSerdeValue<Record<string,unknown>>(db.prepare("SELECT scope_json FROM cdr_stop_revision_receipts").get()!.scope_json as string);assert.equal(scope.hadPreparing,true);assert.deepEqual(scope.ingresses,["message:101"]);
}));
for(const mutation of ["UPDATE cdr_stop_controls SET record_json='{}';","UPDATE cdr_execution_holds SET reason='changed';","UPDATE codex_turn_queue SET prompt='changed';","UPDATE cdr_stop_revisions SET operation_id='changed';"])
 test(`post-insert Running custody tampering rolls back: ${mutation}`,async()=>fixture((path,db)=>{job(db);const original=controlIngress(db);db.exec(`CREATE TRIGGER tamper AFTER INSERT ON cdr_stop_revisions BEGIN ${mutation} END`);assert.throws(()=>accept(path,original));rollbackState(db);assert.equal(getIngressIn(db,"message:100")!.phase,"processing");assert.equal(selectJob(db,"job").prompt,"original");}));
test("final selected-state check failure rolls back accepted control and revisions",async()=>fixture((path,db)=>{job(db);const expected=controlIngress(db);let calls=0;assert.throws(()=>accept(path,expected,7n,()=>{if(++calls===2)throw new Error("selected changed");}),/selected changed/);assert.equal(calls,2);rollbackState(db);}));
test("bound excludes 129 queued originals; missing legacy DB creates no receipt",async()=>{
  await fixture((path,db)=>{job(db);for(let i=0;i<128;i++)job(db,`p${i}`,"pending",null);assert.throws(()=>accept(path));rollbackState(db);});
  await storeFixture(async path=>{assert.equal(accept(path),null);assert.equal(existsSync(path),false);assert.throws(()=>accept(path,null,0n));assert.equal(existsSync(path),false);});
});
test("actual accepted control claims once, sends one native interrupt, and settles only on exact terminal",{timeout:15000},async t=>fixture(async(path,db)=>{
  job(db);db.exec("UPDATE codex_turn_queue SET app_server_generation=1,execution_generation=1;INSERT INTO codex_app_server_runtime VALUES(1,'runtime');INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");
  const code=`import readline from 'node:readline';let interrupts=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='turn/interrupt')interrupts++;if(m.method==='fixture/count'){emit({id:m.id,result:interrupts});return;}if(m.method==='fixture/terminal')emit({method:'turn/completed',params:{threadId:'T',turn:{id:'V',status:'interrupted'}}});emit({id:m.id,result:{}});});`;
  const render=(e:unknown)=>e instanceof Error?e.message:"diagnostic",owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:createMutationCustodyFence(path,"runtime",render)}),notifications=owner.subscribeNotifications();
  const raw=async(method:string)=>{const a=owner.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
  try{const c=state.acceptRunningStop(path,scope,binding,null,owner.instanceId,1n,()=>{})!,claim=state.claimStopControl(path,c,()=>{})!;assert.ok(claim);await owner.executeStopControl(interruptTurn("T","V"),1n,claim,()=>{});
    assert.equal(db.prepare("SELECT phase FROM cdr_stop_controls").get()!.phase,"acknowledged");assert.equal(await raw("fixture/count"),1n);assert.equal(state.claimStopControl(path,c,()=>{}),null);await assert.rejects(owner.executeStopControl(interruptTurn("T","V"),1n,claim,()=>{}));assert.equal(await raw("fixture/count"),1n);
    await raw("fixture/terminal");await observeCompletionTerminal(path,owner.instanceId,await notifications.receive(t.signal));assert.equal(db.prepare("SELECT phase FROM cdr_stop_controls").get()!.phase,"settled");assert.equal(selectJob(db,"job").attemptCount,1n);assert.equal(selectJob(db,"job").state,"Running");
  }finally{notifications.dispose();await owner.dispose();}
}));

test("shared revision advance requires caller transaction and nonblank operation before publication",async()=>fixture((path,db)=>{
  assert.throws(()=>advanceAcceptedStopRevisionIn(db,scope,binding,{jobs:[]},"op"),/active transaction/);rollbackState(db);db.exec("BEGIN");try{assert.throws(()=>advanceAcceptedStopRevisionIn(db,scope,binding,{jobs:[]},"\u0085"),/revision evidence differs/);rollbackState(db);assert.equal(db.isTransaction,true);}finally{db.exec("ROLLBACK");}
}));
