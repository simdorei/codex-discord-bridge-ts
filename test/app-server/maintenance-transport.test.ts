import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {PortableAppServerSession} from "../../src/app-server/portable-session.ts";
import {ResidentAdmissionState} from "../../src/app-server/resident-state.ts";
import {IdleTargetGate} from "../../src/app-server/idle-target-gate.ts";
import {IdleMaintenanceWork,type IdleRpcRequest} from "../../src/app-server/idle-maintenance.ts";
import {MaintenanceTransport,type MaintenanceTransportFence} from "../../src/app-server/maintenance-transport.ts";
import {MutationOutcomeUnknownError,type MaintenanceClaim,type MaintenanceCompletion} from "../../src/app-server/maintenance-attempt.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import type {IdleReleaseJournal,IdleReleaseToken} from "../../src/app-server/idle-release-journal.ts";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
const render=(e:unknown)=>e instanceof Error?e.message:"unknown";
async function fixture(t:TestContext,mode="ok",stateName="Resubscribing",check:()=>void=()=>{}){
  const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});let seen=[];lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){emit({id:m.id,result:{}});return;}if(m.method==='initialized')return;if(m.method==='seen'){emit({id:m.id,result:seen});return;}seen.push(m.method);if(mode==='exit'){process.exit(2);}if(mode==='hang')return;if(mode==='remote'){emit({id:m.id,error:{code:-1,message:'rejected'}});return;}if(m.method==='thread/resume')emit({id:m.id,result:{thread:{id:'T'},wire:m.id}});else if(m.method==='thread/read')emit({id:m.id,result:{thread:{id:'T',status:{type:'notLoaded'}}}});});`;
  const {session}=await PortableAppServerSession.startObserved({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"test",title:"Test",version:"1"}},()=>({value:null,dispose(){}}),()=>"diagnostic",t.signal);
  t.after(()=>session.dispose());const resident=new ResidentAdmissionState(session.residentClient()),gate=new IdleTargetGate(),events:string[]=[],claims:MaintenanceClaim[]=[],finishes:MaintenanceCompletion[]=[];
  let token:IdleReleaseToken={intentId:"i",ownerId:"owner",generation:1n,threadId:"T",turnId:"V",jobId:"j",revision:1n,state:stateName,detail:""};
  const journal:IdleReleaseJournal={beforeMutation:()=>null,resumeRequired:()=>false,checkMutation:()=>{},oldChildExited:()=>{},verify:(expected,idle)=>{events.push("verify");assert.deepEqual(expected,token);},transition:(old,state,detail)=>{assert.deepEqual(old,token);events.push("transition:"+state);token={...old,state,detail,revision:old.revision+1n};return token;}};
  gate.install(journal);const permit=gate.reserve(token),admission=resident.admitRequest(1n);t.after(()=>{permit.release();admission.release();});
  const fence:MaintenanceTransportFence={checkRequest:()=>{events.push("check");},beginMutationWithOrigin:claim=>{events.push("begin");claims.push(claim);return true;},finishMutation:completion=>{events.push("finish");finishes.push(completion);}};
  const transport=new MaintenanceTransport(resident,admission,gate,permit,token,fence,{origin:"pinned"},render,check);
  const rpc=(timeoutMs=1000):IdleRpcRequest=>({token,method:"thread/resume",params:{threadId:"T"},timeoutMs,requireIdle:false,watermark:null});
  return {session,resident,gate,permit,admission,transport,events,claims,finishes,rpc,current:()=>token,fence};
}
test("actual native resume binds writer preflight to exact durable wire and returns confirmed settlement",{timeout:10000},async t=>{
  const f=await fixture(t);f.events.length=0;const reply=await new IdleMaintenanceWork(f.current(),f.permit,f.transport.port()).resubscribe({threadId:"T"}) as {wire:string};
  assert.equal(f.current().state,"Settled");assert.deepEqual(f.events,["verify","check","begin","finish","transition:Settled"]);assert.equal(f.claims[0]!.wire,reply.wire);assert.deepEqual(f.claims[0]!.origin,{origin:"pinned"});assert.equal(f.finishes[0]!.outcome,"reply_ok");assert.equal(f.resident.snapshot().quarantined,false);assert.equal(f.session.residentClient().admissionSnapshot().inFlight,1n);
});
test("native Remote reply settles the attempt as reply_error without quarantining its healthy session",{timeout:10000},async t=>{
  const f=await fixture(t,"remote");const result=await f.transport.port().rpc(f.rpc());assert.equal(result.ok,false);assert.equal(result.phase,"Flushed");assert.equal(f.finishes[0]!.outcome,"reply_error");assert.equal(f.resident.snapshot().quarantined,false);
});
test("healthy fully-flushed native timeout retains the attempt but does not quarantine maintenance",{timeout:10000},async t=>{
  const f=await fixture(t,"hang");const result=await f.transport.port().rpc(f.rpc(30));assert.equal(result.ok,false);assert.equal(result.phase,"Flushed");if(result.ok)throw new Error("unexpected success");assert.ok(result.error instanceof MutationOutcomeUnknownError);assert.equal(f.finishes.length,0);assert.equal(f.resident.snapshot().quarantined,false);assert.deepEqual(await f.session.request("seen",{},1000),["thread/resume"]);
});
test("native transport loss after write retains durable unknown and quarantines that generation",{timeout:10000},async t=>{
  const f=await fixture(t,"exit");const result=await f.transport.port().rpc(f.rpc());assert.equal(result.ok,false);assert.equal(f.finishes.length,0);assert.equal(f.resident.snapshot().quarantined,true);assert.equal(f.resident.restartPendingFor(1n),true);
});
test("actual writer checks resident health before journal/claim and sends no bytes when quarantined",{timeout:10000},async t=>{
  const f=await fixture(t);f.events.length=0;f.resident.markCancelled(1n);const result=await f.transport.port().rpc(f.rpc());assert.equal(result.ok,false);assert.equal(result.phase,"NotStarted");assert.deepEqual(f.events,[]);assert.equal(f.claims.length,0);assert.deepEqual(await f.session.request("seen",{},1000),[]);
});
test("native fresh unload read settles AwaitUnload and does not create a mutation claim",{timeout:10000},async t=>{
  const f=await fixture(t,"ok","AwaitUnload");await new IdleMaintenanceWork(f.current(),f.permit,f.transport.port()).release();assert.equal(f.current().detail,"UnloadedConfirmed");assert.equal(f.claims.length,0);assert.equal(f.finishes.length,0);
});
test("candidate cannot pass native local evidence without an exact witnessed terminal",{timeout:10000},async t=>{
  const f=await fixture(t,"ok","Candidate");await assert.rejects(new IdleMaintenanceWork(f.current(),f.permit,f.transport.port()).release(),/terminal not witnessed/);assert.equal(f.current().state,"Candidate");assert.deepEqual(await f.session.request("seen",{},1000),[]);assert.equal(f.claims.length,0);
});
test("target gate gaps, released admission, and changed token identity stop maintenance",{timeout:10000},async t=>{
  const f=await fixture(t);f.gate.markGap();assert.throws(()=>f.transport.port().localIdle(null),/observer gap/);
  await assert.rejects(f.transport.port().rpc({...f.rpc(),token:{...f.current(),ownerId:"other"}}),/original token identity/);f.admission.release();const result=await f.transport.port().rpc(f.rpc());assert.equal(result.ok,false);assert.equal(result.phase,"NotStarted");assert.equal(f.claims.length,0);
});
test("central idle snapshot distinguishes unrelated, unattributed and responding server requests",()=>{
  const state=new ClientRuntimeState(42);state.commitInitialized();state.recordNotification({method:"turn/completed",params:{threadId:"T",turnId:"V"}});assert.equal(state.idleMaintenanceSnapshot("T","V").caughtUp,false);state.confirmIdleObservation({method:"turn/completed",params:{threadId:"T",turnId:"V"}});assert.equal(state.idleMaintenanceSnapshot("T","V").witnessedTerminal,true);assert.equal(state.idleMaintenanceSnapshot("T","V").caughtUp,true);
  const occurrence=ServerRequestOccurrence.random();state.recordServerRequest({id:"other",occurrence,method:"approval",params:{threadId:"other"}});assert.equal(state.idleMaintenanceSnapshot("T","V").blockingRequest,false);
  const unknown=ServerRequestOccurrence.random();state.recordServerRequest({id:"unknown",occurrence:unknown,method:"approval",params:{}});assert.equal(state.idleMaintenanceSnapshot("T","V").blockingRequest,true);state.beginServerResponse("unknown",unknown);assert.equal(state.idleMaintenanceSnapshot("T","V").blockingRequest,true);
});
test("dispatch-check failure occurs before journal and unsupported methods cannot use maintenance authority",{timeout:10000},async t=>{
  const sentinel=new Error("dispatch denied"),f=await fixture(t,"ok","Resubscribing",()=>{throw sentinel;});f.events.length=0;
  const result=await f.transport.port().rpc(f.rpc());assert.equal(result.ok,false);if(result.ok)throw new Error("unexpected success");assert.equal(result.error,sentinel);assert.equal(result.phase,"NotStarted");assert.deepEqual(f.events,[]);assert.equal(f.resident.snapshot().quarantined,false);
  await assert.rejects(f.transport.port().rpc({...f.rpc(),method:"turn/start"}),/Unsupported maintenance method/);assert.deepEqual(await f.session.request("seen",{},1000),[]);
});
