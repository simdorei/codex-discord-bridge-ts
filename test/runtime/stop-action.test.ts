import assert from "node:assert/strict";
import {test} from "node:test";
import {StopActionExecutor} from "../../src/runtime/action-executor/stop-action.ts";
import {StopControlWorker} from "../../src/runtime/action-executor/stop-worker.ts";
import {snapshotSettingsBinding,validateSelectedSettingsSnapshot,validateLifecycleSettingsSnapshot} from "../../src/runtime/action-executor/settings-snapshot.ts";
import {MissingActionAppServerError,ActionIntegerRangeError,InvalidActionRequestError,storeActionCheck} from "../../src/runtime/action-executor/errors.ts";
import {StoreIntegrityError} from "../../src/store/schema-assembly.ts";
import {TargetLocks} from "../../src/core/keyed-locks.ts";
import type {AppRequest} from "../../src/app-server/requests.ts";
import type {StopControl} from "../../src/store/stop-control-dispatch.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {createMutationCustodyFence} from "../../src/runtime/mutation-custody-fence.ts";
const RESIDENT="00000000-0000-4000-8000-000000000001" as const,context={channelId:42n,userId:3n};
const binding=(route="Explicit")=>({target:"T",route,command:{Stop:{reference:route==="Explicit"?"T":null}}});
const render=(e:unknown)=>e instanceof Error?e.message:"opaque";
function fake(){
  const calls:string[]=[],locks=new TargetLocks();let selected:string|null="T",mapped:string|null=null,running:StopControl|null=null,unresolved:{jobs:string[];ingresses?:string[]}|null=null,active:string|null="V";
  const server={instanceId:RESIDENT as typeof RESIDENT,generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:1}),activeTurnId:()=>{calls.push("active");return active;},execute:async(r:AppRequest,g:bigint|null=null)=>{calls.push(`execute:${r.method}:${g}`);assert.deepEqual(r.params,{threadId:"T",turnId:"V"});return {};}};
  const bridge={selectedThreadId:()=>{calls.push("selected");return selected;}},store={
    acceptRunningStop:()=>{calls.push("accept-running");return running;},acceptUnresolvedStop:()=>{calls.push("accept-unresolved");return unresolved;},hasObservedCompletion:async()=>{calls.push("terminal");return false;},mirroredThreadId:async()=>{calls.push("mapping");return mapped;}};
  const executor=new StopActionExecutor("fixture",server,bridge,locks,render,store);
  return {executor,server,store,bridge,calls,locks,set:(v:{selected?:string|null;mapped?:string|null;running?:StopControl|null;unresolved?:typeof unresolved;active?:string|null})=>{if(Object.hasOwn(v,"selected"))selected=v.selected!;if(Object.hasOwn(v,"mapped"))mapped=v.mapped!;if(Object.hasOwn(v,"running"))running=v.running!;if(Object.hasOwn(v,"unresolved"))unresolved=v.unresolved!;if(Object.hasOwn(v,"active"))active=v.active!;}};
}
test("Running acceptance returns immediately without target lock, active lookup or inline interrupt",async()=>{
  const f=fake();f.set({running:{operation_id:"original-stop"} as StopControl});const lease=f.locks.tryAcquire("T")!;try{const r=await f.executor.stopBound(context,binding());assert.equal(r.waitsForFinal,false);assert.equal(r.ui,null);assert.match(r.text,/operation_id: original-stop/);assert.match(r.text,/Execution end is not confirmed/);assert.deepEqual(f.calls,["accept-running"]);}finally{lease.release();}
});
test("unresolved local acceptance works without resident and reports counts without certifying end",async()=>{
  const f=fake();f.set({unresolved:{jobs:["a","b"],ingresses:["x"]}});const noServer=new StopActionExecutor("fixture",null,f.bridge,f.locks,render,f.store);const r=await noServer.stopBound(context,binding());assert.match(r.text,/unresolved\): 2/);assert.match(r.text,/Unowned original requests held: 1/);assert.deepEqual(f.calls,["accept-unresolved"]);
});
test("no local receipt and no resident fail rather than inventing idle or execution end",async()=>{const f=fake();await assert.rejects(new StopActionExecutor("fixture",null,f.bridge,f.locks,render,f.store).stopBound(context,binding()),MissingActionAppServerError);assert.deepEqual(f.calls,["accept-unresolved"]);});
test("legacy explicit fallback uses exact active turn and generation without resume/fork",async()=>{
  const f=fake();f.set({selected:"other",mapped:"other"});const r=await f.executor.stopBound(context,binding());assert.equal(r.text,"Stop request submitted for T.");assert.deepEqual(f.calls,["accept-running","accept-unresolved","active","terminal","execute:turn/interrupt:1"]);assert.equal(f.locks.activeTargetCount,0);
});
test("legacy fallback waits on shared control lock and does not retarget changed mapping",async()=>{
  const f=fake();f.set({mapped:"T"});const lease=f.locks.tryAcquire("T")!,p=f.executor.stopBound(context,binding("Mapped"));await Promise.resolve();assert.deepEqual(f.calls,["accept-running","accept-unresolved"]);f.set({mapped:"other"});lease.release();await assert.rejects(p,/lifecycle target changed/);assert.equal(f.calls.includes("active"),false);assert.equal(f.locks.activeTargetCount,0);
});
test("accepted binding is snapshotted before waiting and cache absence never creates a replacement",async()=>{
  const f=fake(),b=binding("Selected"),lease=f.locks.tryAcquire("T")!,p=f.executor.stopBound(context,b);b.target="other";lease.release();assert.equal((await p).text,"Stop request submitted for T.");
  const absent=fake();absent.set({active:null});await assert.rejects(absent.executor.stopBound(context,binding()),/no currently owned/);assert.equal(absent.calls.some(c=>c.startsWith("execute")),false);
});
test("actor channel/owner and native generation enforce signed storage range",async()=>{
  for(const c of [{channelId:1n<<63n,userId:3n},{channelId:42n,userId:-1n}]){const f=fake();await assert.rejects(f.executor.stopBound(c,binding()),ActionIntegerRangeError);assert.deepEqual(f.calls,[]);}
});
test("derived frozen settings support sequence/unit-enum input, ignore fields and preserve command Value",()=>{
  const b=snapshotSettingsBinding(["T",{Selected:null},{Stop:{reference:null}}]);assert.equal(b.route,"Selected");assert.equal(Object.isFrozen(b),true);assert.deepEqual(b.command,{Stop:{reference:null}});assert.equal(snapshotSettingsBinding({...binding(),extra:1n}).target,"T");
  for(const bad of [{target:"T",route:"bad",command:{}},{target:"T",route:"Mapped"},null])assert.throws(()=>snapshotSettingsBinding(bad),InvalidActionRequestError);
  let touched=0;assert.throws(()=>snapshotSettingsBinding({...binding(),get command(){touched++;return {};}}));assert.equal(touched,0);
});
test("selected action check stays input error outside transaction but central store check preserves custody taxonomy",()=>{
  const b=snapshotSettingsBinding(binding("Selected")),bridge={selectedThreadId:()=>"other"};assert.throws(()=>validateSelectedSettingsSnapshot(b,bridge),InvalidActionRequestError);assert.throws(storeActionCheck(()=>validateSelectedSettingsSnapshot(b,bridge),render),StoreIntegrityError);
  let touched=0;const poison={get message(){touched++;throw new Error("getter");}};assert.throws(storeActionCheck(()=>{throw poison;},()=>"safe"),e=>e instanceof StoreIntegrityError&&e.result==="safe");assert.equal(touched,0);
});
test("lifecycle current mapping overrides selection and Explicit does not read either",async()=>{
  let calls=0;const bridge={selectedThreadId:()=>{calls++;return "T";}},store={mirroredThreadId:async()=>{calls++;return "other";}};await validateLifecycleSettingsSnapshot("fixture",snapshotSettingsBinding(binding()),42n,bridge,store);assert.equal(calls,0);await assert.rejects(validateLifecycleSettingsSnapshot("fixture",snapshotSettingsBinding(binding("Selected")),42n,bridge,store),/lifecycle target changed/);assert.equal(calls,1);
});
test("real DB accepts local intent without resident; selected change within writer rolls back as StoreIntegrity",async()=>storeFixture(async path=>{
  const db=await openInitialized(path);try{db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('j','T',42,3,1,'p',0,1,'pending',0,'[]',1,1)");let reads=0;
    const changed=new StopActionExecutor(path,null,{selectedThreadId:()=>++reads===1?"T":"other"},new TargetLocks(),render);await assert.rejects(changed.stopBound(context,binding("Selected")),StoreIntegrityError);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,0);
    const accepted=await new StopActionExecutor(path,null,{selectedThreadId:()=>"T"},new TargetLocks(),render).stopBound(context,binding("Selected"));assert.match(accepted.text,/Stop accepted/);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()!.n,1);assert.equal(db.prepare("SELECT state FROM codex_turn_queue").get()!.state,"pending");
  }finally{db.close();}
}));
test("real frozen Stop action accepts under busy target, owned worker later sends exact interrupt once",{timeout:15000},async t=>storeFixture(async path=>{
  const db=await openInitialized(path);let server:PortableResidentLifecycle|undefined;try{
    db.exec("INSERT INTO codex_app_server_runtime VALUES(1,'runtime');INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('j','T',42,3,1,1,'p',0,1,'running',1,'V','[]',1,1)");
    const code=`import readline from 'node:readline';let n=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='seed')emit({method:'turn/started',params:{threadId:'T',turnId:'V'}});if(m.method==='turn/interrupt')n++;emit({id:m.id,result:m.method==='count'?n:{}});});`;
    server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:createMutationCustodyFence(path,"runtime",render)});const owner=server,locks=new TargetLocks(),bridge={selectedThreadId:()=>"T"},action=new StopActionExecutor(path,owner,bridge,locks,render),worker=new StopControlWorker(path,owner,bridge,locks,render,()=>{});
    const raw=async(method:string)=>{const a=owner.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};await raw("seed");const lease=locks.tryAcquire("T")!;const result=await action.stopBound(context,binding());assert.match(result.text,/Execution end is not confirmed/);assert.equal(await raw("count"),0n);assert.equal(await worker.process(),0);lease.release();assert.equal(await worker.process(),0);assert.equal(await worker.process(),1);assert.equal(await raw("count"),1n);assert.equal(state.stopControlPhase(path,db.prepare("SELECT operation_id FROM cdr_stop_controls").get()!.operation_id as string),"acknowledged");
  }finally{try{if(server)await server.dispose();}finally{db.close();}}
}));

test("pre-cancel does not accept any local stop or acquire a target",async()=>{const f=fake(),c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(f.executor.stopBound(context,binding(),null,c.signal),e=>e===reason);assert.deepEqual(f.calls,[]);assert.equal(f.locks.activeTargetCount,0);});
test("cancelled legacy fallback leaves foreign target owner intact and never interrupts",async()=>{const f=fake(),c=new AbortController(),reason=new Error('cancel'),lease=f.locks.tryAcquire('T')!;try{const pending=f.executor.stopBound(context,binding(),null,c.signal),assertion=assert.rejects(pending,e=>e===reason);await Promise.resolve();c.abort(reason);await assertion;lease.requireTarget('T');assert.deepEqual(f.calls,['accept-running','accept-unresolved']);}finally{lease.release();}assert.equal(f.locks.activeTargetCount,0);});
