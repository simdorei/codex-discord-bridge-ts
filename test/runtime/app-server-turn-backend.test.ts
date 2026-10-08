import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {AppServerTurnBackend,appBackendTurnInput} from "../../src/runtime/app-server-turn-backend.ts";
import {createAppBackendErrors} from "../../src/runtime/app-backend-errors.ts";
import {BackendFailureError} from "../../src/runtime/queue-runner/errors.ts";
import {QueueStartCoordinator} from "../../src/runtime/queue-runner/start-coordinator.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {AppServerRequestError} from "../../src/app-server/request-client.ts";
import {ResidentStateError} from "../../src/app-server/resident-state.ts";
import {IdleObservationError} from "../../src/app-server/notification-state.ts";
import {MutationOutcomeUnknownError} from "../../src/app-server/maintenance-attempt.ts";
import {AppServerClosedError,AppServerInvalidReplyError} from "../../src/app-server/client-errors.ts";
import {createMutationCustodyFence} from "../../src/runtime/mutation-custody-fence.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {selectJob} from "../../src/store/queue-read.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import type {DatabaseSync} from "node:sqlite";
const render=(e:unknown)=>e instanceof Error?e.message:"opaque";
const code=`import readline from 'node:readline';let mode='',seen=[];const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>emit({id:m.id,result});if(m.method==='initialized')return;if(m.method==='initialize'){reply({});return;}if(m.method==='fixture/mode'){mode=m.params.mode;reply({});return;}if(m.method==='fixture/seen'){reply(seen);return;}if(m.method==='fixture/active'){emit({method:'turn/started',params:{threadId:'T',turnId:'active'}});reply({});return;}seen.push({method:m.method,params:m.params});if(mode==='writer'&&m.method==='thread/resume'){emit({id:m.id,error:{code:-32600,message:'already has an active writer'}});return;}if(mode==='usage'&&m.method==='turn/start'){emit({id:m.id,error:{code:-3,message:'limited',data:{codexErrorInfo:'usageLimitExceeded'}}});return;}if(m.method==='thread/resume'){reply({thread:{id:mode==='wrong'?'other':m.params.threadId}});return;}if(m.method==='thread/read'){reply({thread:{id:m.params.threadId,turns:mode==='turns'?[{id:'z',status:'completed'},{id:'a',status:'inProgress'},{id:'z',status:'interrupted'}]:[]}});return;}if(m.method==='thread/turns/list'){reply({data:[{id:'original',status:'inProgress',items:[]}],nextCursor:null});return;}if(m.method==='thread/goal/get'){reply({goal:{status:'active'}});return;}if(m.method==='thread/fork'){reply({thread:{id:mode==='same'?m.params.threadId:'forked'}});return;}if(m.method==='turn/start'){reply(mode==='missing'?{}:{turn:{id:'  started\\u0085'}});return;}reply({});});`;
interface F{owner:PortableResidentLifecycle;backend:AppServerTurnBackend;db:DatabaseSync;path:string;mode(value:string):Promise<void>;seen():Promise<any[]>}
async function fixture(t:TestContext,run:(f:F)=>Promise<void>){await storeFixture(async path=>{
  const db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;
  try{
    db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime'); INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,1,'original',0,1,'starting',1,'[]',1,1)");
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:createMutationCustodyFence(path,"runtime",render)});
    const server=owner,backend=new AppServerTurnBackend(server,render,{resumeTimeoutMs:1000,historyTimeoutMs:1000});
    const call=async(method:string,params:unknown)=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,method,params,1000,undefined,t.signal);}finally{a.release();}};
    await run({owner:server,backend,db,path,mode:async mode=>{await call("fixture/mode",{mode});},seen:async()=>await call("fixture/seen",{}) as any[]});
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
const check=(kind:string,ambiguous:boolean)=>(e:unknown)=>e instanceof BackendFailureError&&e.failure.kind===kind&&e.failure.ambiguous===ambiguous;
test("native core adapter preserves fresh skip then consumes knowledge before a missing-id start",{timeout:15000},async t=>fixture(t,async f=>{
  f.backend.rememberNewThread("T",1n);await f.backend.resumeThread("T");assert.deepEqual(await f.backend.readTurns("T"),[]);assert.deepEqual(await f.seen(),[]);
  await f.mode("missing");await assert.rejects(f.backend.startTurn("T","p"),check("Other",true));await f.backend.readTurns("T");assert.deepEqual((await f.seen()).map(v=>v.method),["turn/start","thread/read"]);
  assert.equal(f.backend.generation(),1n);assert.equal(f.backend.residentInstanceId(),f.owner.instanceId);assert.equal(f.backend.requiresAppServerFork(),false);
}));
test("native reads preserve last duplicate turn and UTF-8 order; resume checks exact identity",{timeout:15000},async t=>fixture(t,async f=>{
  await f.mode("turns");assert.deepEqual(await f.backend.readTurns("T"),[{turnId:"a",status:"InProgress"},{turnId:"z",status:"Interrupted"}]);
  await f.mode("wrong");await assert.rejects(f.backend.resumeThread("T"),check("Other",false));await f.mode("writer");await assert.rejects(f.backend.resumeThread("T"),check("ActiveWriter",false));
}));
test("native claimed start binds original durable job, sends only input and returns Rust-trimmed turn",{timeout:15000},async t=>fixture(t,async f=>{
  assert.equal(await f.backend.startClaimedTurn(selectJob(f.db,"job")),"started");const seen=await f.seen();assert.equal(seen.length,1);assert.deepEqual(seen[0],{method:"turn/start",params:{threadId:"T",input:[{type:"text",text:"original",text_elements:[]}]}});
  assert.equal(f.db.prepare("SELECT state FROM codex_mutation_attempts").get()!.state,"reply_ok");
}));
test("stale claimed start remains ambiguous and cannot send native bytes or rewind Starting",{timeout:15000},async t=>fixture(t,async f=>{
  const claim=selectJob(f.db,"job");f.db.exec("UPDATE codex_turn_queue SET owner_user_id=99");await assert.rejects(f.backend.startClaimedTurn(claim),check("Other",true));assert.deepEqual(await f.seen(),[]);assert.equal(selectJob(f.db,"job").state,"Starting");
}));
test("real QueueStartCoordinator resumes, reads, claims, dispatches and persists Running",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("UPDATE codex_turn_queue SET state='pending',execution_generation=NULL,attempt_count=0");const q=new QueueStartCoordinator(f.path,f.backend);await q.kickTarget("T");
  assert.equal(selectJob(f.db,"job").state,"Running");assert.equal(selectJob(f.db,"job").turnId,"started");assert.deepEqual((await f.seen()).map(v=>v.method),["thread/resume","thread/read","turn/start"]);
}));
test("native fork must be distinct and structured usage limit stays definite",{timeout:15000},async t=>fixture(t,async f=>{
  assert.equal(await f.backend.forkThread("T"),"forked");await f.mode("same");await assert.rejects(f.backend.forkThread("T"),check("Other",true));await f.mode("usage");await assert.rejects(f.backend.startTurn("T","p"),check("UsageLimit",false));
}));
test("active snapshot is local to current native client and aborted reads issue no requests",{timeout:15000},async t=>fixture(t,async f=>{
  assert.equal(await f.backend.activeTurnId("T"),null);const a=f.owner.admitResponse(1n);try{await a.client.requestAdmitted(a.permit,"fixture/active",{},1000);}finally{a.release();}
  assert.equal(await f.backend.activeTurnId("T"),"active");assert.equal(await f.backend.activeTurnId("other"),null);const c=new AbortController(),reason={cancel:true};c.abort(reason);await assert.rejects(f.backend.readTurns("T",c.signal),e=>e===reason);assert.deepEqual(await f.seen(),[]);
}));
test("fresh registry prunes other generations and exact prompt prefix controls data-only skill inputs",async()=>{
  let g=1n,calls=0;const server={instanceId:"resident",generation:()=>g,execute:async()=>{calls++;return {thread:{id:"old",turns:[]}};}} as unknown as PortableResidentLifecycle;
  const b=new AppServerTurnBackend(server,render);b.rememberNewThread("old",1n);b.rememberNewThread("new",2n);assert.deepEqual(await b.readTurns("old"),[]);assert.equal(calls,1);g=2n;assert.deepEqual(await b.readTurns("new"),[]);assert.equal(calls,1);
  const p="$ask-chatgpt-pro [@Chrome](plugin://chrome@openai-bundled)";for(const tail of [""," ","\u0085x"]){const input=appBackendTurnInput(p+tail,"/exact/skill");assert.equal(input.length,3);assert.deepEqual(input[1],{type:"skill",name:"ask-chatgpt-pro",path:"/exact/skill"});}
  for(const prompt of [" "+p,p+"x",p+"\uFEFFx"])assert.equal(appBackendTurnInput(prompt,"p").length,1);
});
const mapper=createAppBackendErrors(()=>"safe");
for(const [label,error,startAmbiguous] of [
  ["timeout",new AppServerRequestError({kind:"Timeout",method:"turn/start",timeoutMs:1}),true],
  ["transport",new AppServerRequestError({kind:"TransportClosed",method:"turn/start",reason:"EOF"}),true],
  ["channel",new AppServerRequestError({kind:"ResponseChannelClosed",method:"turn/start"}),true],
  ["closed",new AppServerClosedError(),true],
  ["invalid reply",new AppServerInvalidReplyError("bad"),false],
  ["generation",new ResidentStateError({kind:"GenerationMismatch",expected:1n,actual:2n}),false],
  ["unknown",new MutationOutcomeUnknownError("turn/start","lost"),true],
  ["ordinary JS",new Error("IO"),true],
] as const)test(`central backend classification ${label}`,()=>{assert.equal(mapper.failure("start",error).failure.ambiguous,startAmbiguous);assert.equal(mapper.failure("read",error).failure.ambiguous,false);});
test("central mapper applies exact held, idle, active writer and usage discriminants",()=>{
  const held=new ResidentStateError({kind:"MutationHeld",message:"hold"});assert.equal(mapper.failure("claimedStart",held).failure.ambiguous,true);assert.equal(mapper.failure("start",held).failure.kind,"ExecutionHeld");
  const idle=new IdleObservationError("[cdr-rust:async-resolution-held:v1] T");assert.equal(mapper.failure("resume",idle).failure.kind,"ExecutionHeld");assert.equal(mapper.failure("start",new IdleObservationError("other")).failure.kind,"Other");
  assert.equal(mapper.failure("resume",new MutationOutcomeUnknownError("m","reason")).failure.kind,"ExecutionHeld");
  for(const method of ["thread/resume","turn/start"])for(const code of [-32600n,-1n]){const e=new AppServerRequestError({kind:"Remote",method,code,message:"already has an active writer",data:null});assert.equal(mapper.failure("resume",e).failure.kind,method==="thread/resume"&&code===-32600n?"ActiveWriter":"Other");}
  const usage=new AppServerRequestError({kind:"Remote",method:"turn/start",code:-1n,message:"not trusted",data:{type:"usage_limit"}});assert.equal(mapper.failure("claimedStart",usage).failure.kind,"UsageLimit");assert.equal(mapper.failure("mutation",usage).failure.kind,"Other");
});
test("forged error prototypes and poisoned public fields cannot authorize a definite retry",()=>{
  let reads=0;const fake=Object.create(ResidentStateError.prototype);Object.defineProperty(fake,"detail",{get(){reads++;return {kind:"MutationHeld"};}});assert.equal(mapper.failure("start",fake).failure.ambiguous,true);
  const real=new ResidentStateError({kind:"MutationHeld",message:"original"});Object.defineProperty(real,"detail",{get(){reads++;return {kind:"ReplacementState"};}});assert.equal(mapper.failure("start",real).failure.kind,"ExecutionHeld");
  const proxy=new Proxy({}, {get(){reads++;throw new Error("trap");},getPrototypeOf(){reads++;throw new Error("trap");}});assert.equal(mapper.failure("start",proxy).failure.ambiguous,true);assert.equal(reads,0);
});

test("native bounded history and terminal observations preserve raw source evidence without pretending to be release proof",{timeout:15000},async t=>fixture(t,async f=>{
  assert.deepEqual(await f.backend.readAsyncHistory("T",["original"]),{threadId:"T",turns:[{id:"original",status:"inProgress",items:[]}],history_exhausted:true});
  const terminal=await f.backend.readAsyncTerminal("T",["original"]) as Record<string,unknown>;assert.deepEqual(terminal.goal_observation,{goal:{status:"active"}});assert.deepEqual(terminal.thread_observation,{thread:{id:"T",turns:[]}});assert.equal(Object.hasOwn(terminal,"withCurrentConnection"),false);
  assert.deepEqual((await f.seen()).map(v=>v.method),["thread/read","thread/turns/list","thread/read","thread/turns/list","thread/goal/get","thread/read"]);
}));
