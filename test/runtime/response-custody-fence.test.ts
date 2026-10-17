import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {createResponseCustodyFence} from "../../src/runtime/response-custody-fence.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {ResidentStateError} from "../../src/app-server/resident-state.ts";
import type {ResponseOwner} from "../../src/app-server/response-attempt.ts";

interface Fixture{owner:PortableResidentLifecycle;db:DatabaseSync;call(method:string):Promise<unknown>;path:string}
const render=(error:unknown)=>error instanceof Error?error.message:"unavailable";
async function fixture(t:TestContext,run:(f:Fixture)=>Promise<void>,afterCapture?:(db:DatabaseSync)=>void){await storeFixture(async path=>{
  const db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;
  try{
    db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1)");
    const response=createResponseCustodyFence(path,"runtime",render);
    const code=`import readline from 'node:readline';let n=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==='approval'&&m.method===undefined){n++;emit({method:'fixture/answered',params:m});return;}if(m.method==='ask')emit({id:'approval',method:'item/tool/requestUserInput',params:{threadId:'T',turnId:'V'}});if(m.id!==undefined)emit({id:m.id,result:m.method==='count'?n:{}});});`;
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:{
      ...response,responseAuthority:request=>{const a=response.responseAuthority(request);afterCapture?.(db);return a;},
      requestOrigin:()=>{throw new Error("fixture forbids ordinary dispatch");},checkRequest:(_g,m)=>{if(m!=="server/response")throw new Error("fixture forbids mutation");},beginMutationWithOrigin:()=>{throw new Error("fixture forbids mutation");},finishMutation:()=>{throw new Error("fixture forbids mutation");},
    }});
    const native=owner,call=async(method:string)=>{const a=native.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
    await run({owner,db,call,path});
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
async function ask(f:Fixture,t:TestContext){const r=f.owner.subscribeServerRequests();try{await f.call("ask");const e=await r.receive(t.signal);if(e.kind!=="Request")throw new Error("fixture request missing");return e.request;}finally{r.dispose();}}
async function answer(f:Fixture,t:TestContext,request:Awaited<ReturnType<typeof ask>>,error=false){const r=f.owner.subscribeNotifications();try{
  if(error)await f.owner.respondError(request.id,request.occurrence,{code:-7n,message:"declined",data:null},1n);else await f.owner.respond(request.id,request.occurrence,{approved:true},1n);
  for(;;){const e=await r.receive(t.signal);if(e.kind==="Notification"&&e.notification.method==="fixture/answered")return e.notification.params;}
}finally{r.dispose();}}
for(const error of [false,true])test(`native ${error?"error":"result"} response commits actual SQLite authority before wire and exact flush after`,{timeout:15000},async t=>fixture(t,async f=>{
  const request=await ask(f,t),value=await answer(f,t,request,error);
  assert.deepEqual(value,error?{id:"approval",error:{code:-7n,message:"declined",data:null}}:{id:"approval",result:{approved:true}});
  const row=f.db.prepare("SELECT * FROM cdr_server_responses").get()!;assert.equal(row.phase,"flushed");assert.equal(row.resident_owner,f.owner.instanceId);assert.equal(row.target_thread_id,"T");
  const a=parseSerdeValue<Record<string,unknown>>(row.authority_json as string);assert.equal(a.resident,f.owner.instanceId);assert.equal(a.generation,1n);assert.equal(a.job,"job");
  assert.equal(await f.call("count"),1n);await assert.rejects(f.owner.respond(request.id,request.occurrence,{},1n),/stale/);assert.equal(await f.call("count"),1n);
}));
test("stop inserted after capture but before actual writer prevents all response bytes",{timeout:15000},async t=>fixture(t,async f=>{
  const request=await ask(f,t);await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/execution-held/);assert.equal(await f.call("count"),0n);assert.equal(f.db.prepare("SELECT count(*) AS n FROM cdr_server_responses").get()!.n,0);
},db=>{db.exec("INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',0)");}));
test("response admission failure rolls back and no bytes leave native writer",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("CREATE TRIGGER denied BEFORE INSERT ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'actual admission denied'); END");const request=await ask(f,t);
  await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/actual admission denied/);assert.equal(await f.call("count"),0n);assert.equal(f.db.prepare("SELECT count(*) AS n FROM cdr_server_responses").get()!.n,0);
}));
test("native successful bytes followed by failed durable finish stay admitted without replay",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("CREATE TRIGGER denied BEFORE UPDATE ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'actual finish denied'); END");const request=await ask(f,t);
  await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/actual finish denied.*original response admission retained/);assert.equal(await f.call("count"),1n);assert.equal(f.db.prepare("SELECT phase FROM cdr_server_responses").get()!.phase,"admitted");await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/stale/);assert.equal(await f.call("count"),1n);
}));
test("runtime replacement is observed through a fresh existing connection and revokes captured authority",{timeout:15000},async t=>fixture(t,async f=>{
  const request=await ask(f,t);await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/runtime changed/);assert.equal(await f.call("count"),0n);
},db=>{db.exec("UPDATE codex_mutation_runtime SET runtime_id='replacement'");}));
test("adapter encodes real occurrence bytes as integers and refuses forged/native oversized identity without getter calls",async()=>storeFixture(async path=>{
  const db=await openInitialized(path);try{
    db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1)");
    const f=createResponseCustodyFence(path,"runtime",render),request={id:"approval",occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(7)),method:"approval",params:{threadId:"T",turnId:"V"}},owner={ownerId:"resident",generation:1n,request};
    const first=f.responseAuthority(owner)!.value as Record<string,unknown>;
    request.occurrence=ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(8));const second=f.responseAuthority(owner)!.value as Record<string,unknown>;assert.notEqual(first.key,second.key);
    assert.throws(()=>f.responseAuthority({...owner,generation:1n<<63n}),e=>e instanceof ResidentStateError&&e.detail.kind==="MutationHeld");
    let calls=0;assert.throws(()=>f.responseAuthority({get ownerId(){calls++;return "resident";},generation:1n,request}));assert.equal(calls,0);
    assert.throws(()=>f.responseAuthority({...owner,request:{...request,occurrence:Object.create(ServerRequestOccurrence.prototype)}} as ResponseOwner));assert.equal(Object.isFrozen(f),true);
  }finally{db.close();}
}));
