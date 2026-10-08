import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import type {AppRequest} from "../../src/app-server/requests.ts";
import {StopControlWorker,type StopWorkerFailure} from "../../src/runtime/action-executor/stop-worker.ts";
import {SkippedTicks,nextSkippedDeadline} from "../../src/runtime/skipped-ticks.ts";
import {TargetLocks} from "../../src/core/keyed-locks.ts";
import type {StopControl,StopClaim} from "../../src/store/stop-control-dispatch.ts";
import {MissingActionAppServerError,InvalidActionRequestError} from "../../src/runtime/action-executor/errors.ts";
import {ResidentStateError} from "../../src/app-server/resident-state.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {createMutationCustodyFence} from "../../src/runtime/mutation-custody-fence.ts";
import {setTimeout as delay} from "node:timers/promises";
const RESIDENT="00000000-0000-4000-8000-000000000001" as const;
const render=(e:unknown)=>e instanceof Error?e.message:"opaque";
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function control(id:string,target=id,resident:string=RESIDENT,generation=1n):StopControl{return {operation_id:id,target,channel:42n,owner:3n,resident,generation,turn:`turn:${target}`,binding:{target,route:"Explicit",command:{Stop:{reference:target}}},jobs:[],can_settle:true};}
function fake(controls:StopControl[]){
  const rows=controls.map((control,i)=>({seq:BigInt(i+1),control,phase:"accepted",token:null as string|null,error:""})),calls:string[]=[],locks=new TargetLocks(),failures:StopWorkerFailure[]=[];let selected:string|null="T";let hook:((signal?:AbortSignal)=>Promise<void>)|undefined;let checkHook:(()=>Promise<boolean>)|undefined;
  const bridge={selectedThreadId:()=>selected},server={instanceId:RESIDENT as typeof RESIDENT,generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:1}),activeTurnId:(thread:string)=>`turn:${thread}`,
    executeStopControl:async(request:AppRequest,g:bigint,input:unknown,check:()=>void,signal?:AbortSignal)=>{calls.push(`attempt:${(input as StopClaim).control.operation_id}`);assert.equal(request.method,"turn/interrupt");assert.equal(request.timeoutMs,2000);if(hook)await hook(signal);check();signal?.throwIfAborted();calls.push(`wire:${(input as StopClaim).control.operation_id}`);rows.find(r=>r.control.operation_id===(input as StopClaim).control.operation_id)!.phase="acknowledged";return {};}};
  const store={pendingStopControlsAfter:(_p:string,after:bigint)=>{calls.push(`read:${after}`);return rows.filter(r=>r.seq>after&&r.phase==="accepted").slice(0,16).map(r=>[r.seq,r.control] as const);},
    claimStopControl:(_p:string,input:unknown,check:()=>void):StopClaim|null=>{check();const c=input as StopControl,r=rows.find(r=>r.control.operation_id===c.operation_id)!;calls.push(`claim:${c.operation_id}`);if(r.phase!=="accepted")return null;r.phase="dispatching";r.token=`token:${c.operation_id}`;return {control:c,token:r.token};},
    recordStopControlError:(_p:string,input:unknown,error:string)=>{const r=rows.find(r=>r.control.operation_id===(input as StopClaim).control.operation_id)!;r.phase="unknown";r.error=error;calls.push(`error:${r.control.operation_id}`);},
    hasObservedCompletion:async()=>checkHook?checkHook():false,mirroredThreadId:async()=>null};
  const worker=new StopControlWorker("fixture",server,bridge,locks,render,e=>{failures.push(e);},store);
  return {worker,server,store,bridge,rows,calls,locks,failures,setSelected:(v:string|null)=>{selected=v;},setHook:(v:typeof hook)=>{hook=v;},setCheck:(v:typeof checkHook)=>{checkHook=v;}};
}
test("busy original target cannot block later keyset work and revisits only after wrap",async()=>{
  const f=fake([control("busy"),control("foreign","foreign","other"),control("free")]),lease=f.locks.tryAcquire("busy")!;
  assert.equal(await f.worker.process(),1);assert.equal(f.worker.cursor,3n);assert.deepEqual(f.calls.filter(c=>c.startsWith("wire")),["wire:free"]);lease.release();assert.equal(await f.worker.process(),0);assert.equal(f.worker.cursor,0n);assert.equal(await f.worker.process(),1);assert.deepEqual(f.calls.filter(c=>c.startsWith("wire")),["wire:free","wire:busy"]);assert.equal(f.locks.activeTargetCount,0);
});
test("wrong resident/generation and already-ended original turn are skipped before claim",async()=>{
  const f=fake([control("old","old","other"),control("gen","gen",RESIDENT,2n),control("done")]);f.setCheck(async()=>true);assert.equal(await f.worker.process(),0);assert.equal(f.calls.some(c=>c.startsWith("claim")),false);
});
test("stored binding invalidity and selected change abort cycle without changing accepted intent",async()=>{
  for(const binding of [{target:"T",route:"invalid",command:{}},{target:"T",route:"Selected",command:{Stop:{reference:null}}}]){const f=fake([{...control("T"),binding}]);f.setSelected("other");await assert.rejects(f.worker.process(),InvalidActionRequestError);assert.equal(f.rows[0]!.phase,"accepted");assert.equal(f.worker.cursor,1n);assert.equal(f.locks.activeTargetCount,0);}
});
test("selected snapshot is checked again at actual dispatch and failure stays unknown without wire",async()=>{
  const f=fake([{...control("T"),binding:{target:"T",route:"Selected",command:{Stop:{reference:null}}}}]);f.setHook(async()=>{f.setSelected("other");});assert.equal(await f.worker.process(),1);assert.equal(f.rows[0]!.phase,"unknown");assert.equal(f.calls.some(c=>c.startsWith("wire")),false);assert.ok(f.failures[0]!.error instanceof ResidentStateError);assert.equal(await f.worker.process(),0);
});
test("failed RPC is recorded once, reported centrally and does not prevent a later independent original",async()=>{
  const f=fake([control("a"),control("b")]);let n=0;f.setHook(async()=>{if(++n===1)throw new Error("remote refusal");});assert.equal(await f.worker.process(),2);assert.equal(f.rows[0]!.phase,"unknown");assert.equal(f.rows[1]!.phase,"acknowledged");assert.equal(f.failures.length,1);assert.equal(f.rows[0]!.error,"remote refusal");await f.worker.process();await f.worker.process();assert.equal(n,2);
});
test("concurrent process calls rejected and abort while verification waits never claims later",async()=>{
  const f=fake([control("a")]),entered=deferred<void>(),release=deferred<boolean>(),c=new AbortController(),reason={stop:true};f.setCheck(async()=>{entered.resolve();return release.promise;});const pending=f.worker.process(c.signal);await entered.promise;await assert.rejects(f.worker.process(),/already active/);c.abort(reason);release.resolve(false);await assert.rejects(pending,e=>e===reason);assert.equal(f.rows[0]!.phase,"accepted");assert.equal(f.locks.activeTargetCount,0);assert.equal(f.calls.some(c=>c.startsWith("claim")),false);
});
test("abort after claimed dispatch retains unknown authority and never runs the post-error recorder",async()=>{
  const f=fake([control("a")]),entered=deferred<void>(),c=new AbortController(),reason={shutdown:true};f.setHook(signal=>new Promise((_resolve,reject)=>{entered.resolve();signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});}));const pending=f.worker.process(c.signal);await entered.promise;c.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(f.rows[0]!.phase,"dispatching");assert.equal(f.rows[0]!.error,"");assert.equal(f.failures.length,0);assert.equal(f.locks.activeTargetCount,0);assert.equal(await f.worker.process(),0);
});
test("owned polling cycle deadline is cooperative, retains its claim and emits one report",{timeout:5000},async()=>{
  const f=fake([control("a")]),shutdown=new AbortController();let closed=0,waits=0;f.setHook(signal=>new Promise((_r,reject)=>signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true})));
  const worker=new StopControlWorker("fixture",f.server,f.bridge,f.locks,render,e=>{f.failures.push(e);if(e.stage==="deadline")shutdown.abort();},f.store);
  await worker.run(shutdown.signal,()=>({wait:()=>{waits++;return Promise.resolve();},close:()=>{closed++;}}));assert.equal(f.failures.length,1);assert.equal(f.failures[0]!.stage,"deadline");assert.equal(f.rows[0]!.phase,"dispatching");assert.equal(closed,1);assert.equal(waits,1);assert.equal(f.locks.activeTargetCount,0);
});
test("shutdown joins an outstanding verification before releasing its shared target lease",async()=>{
  const f=fake([control("a")]),entered=deferred<void>(),release=deferred<boolean>(),shutdown=new AbortController();let closed=false,ended=false;f.setCheck(async()=>{entered.resolve();return release.promise;});const run=f.worker.run(shutdown.signal,()=>({wait:()=>Promise.resolve(),close:()=>{closed=true;}})).then(()=>{ended=true;});await entered.promise;shutdown.abort();await Promise.resolve();assert.equal(ended,false);assert.equal(f.locks.activeTargetCount,1);release.resolve(false);await run;assert.equal(closed,true);assert.equal(f.locks.activeTargetCount,0);assert.equal(f.rows[0]!.phase,"accepted");
});
test("pre-aborted run does no work and tick factory/close failure releases the worker owner flag",async()=>{
  const f=fake([]),c=new AbortController();c.abort();await f.worker.run(c.signal,()=>{throw new Error("must not create");});const live=new AbortController();await assert.rejects(f.worker.run(live.signal,()=>{throw new Error("factory");}),/factory/);
  await f.worker.run(c.signal);await assert.rejects(f.worker.run(live.signal,()=>({wait:async()=>{live.abort();},close:()=>{throw new Error("close");}})),/close/);const next=new AbortController();await f.worker.run(next.signal,()=>({wait:async()=>{next.abort();},close(){}}));
});
test("missing server is a typed failure; skipped tick phase math has no catch-up burst",async()=>{
  const f=fake([]);await assert.rejects(new StopControlWorker("f",null,f.bridge,f.locks,render,()=>{},f.store).process(),MissingActionAppServerError);
  assert.equal(nextSkippedDeadline(0,0,250),250);assert.equal(nextSkippedDeadline(250,1201,250),1250);assert.equal(nextSkippedDeadline(250,1250,250),1500);assert.throws(()=>nextSkippedDeadline(2,1,250));
  const ticks=new SkippedTicks(60000);await ticks.wait();const pending=ticks.wait();assert.throws(()=>ticks.wait(),/pending/);ticks.close();await pending;await ticks.wait();ticks.close();
});
async function native(t:TestContext,run:(path:string,db:Awaited<ReturnType<typeof openInitialized>>,owner:PortableResidentLifecycle,locks:TargetLocks,worker:StopControlWorker,raw:(method:string)=>Promise<unknown>)=>Promise<void>,hang=false){await storeFixture(async path=>{
  const db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;try{
    db.exec("INSERT INTO codex_app_server_runtime VALUES(1,'runtime');INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");for(const target of ["A","B"])db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES(?,?,42,3,1,1,'p',0,1,'running',1,?,'[]',1,1)").run(target,target,`turn:${target}`);
    const code=`import readline from 'node:readline';let sent=[];const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='seed')for(const thread of ['A','B'])emit({method:'turn/started',params:{threadId:thread,turnId:'turn:'+thread}});if(m.method==='count'){emit({id:m.id,result:sent});return;}if(m.method==='turn/interrupt'){sent.push(m.params.threadId);if(${hang})return;}emit({id:m.id,result:{}});});`;
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:createMutationCustodyFence(path,"runtime",render)});const server=owner,locks=new TargetLocks(),worker=new StopControlWorker(path,server,{selectedThreadId:()=>null},locks,render,()=>{});
    const raw=async(method:string)=>{const a=server.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};await raw("seed");for(const target of ["A","B"])state.acceptRunningStop(path,{target,channel:42n,owner:3n},{target,route:"Explicit",command:{Stop:{reference:target}}},null,server.instanceId,1n,()=>{});
    await run(path,db,server,locks,worker,raw);
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
test("actual native worker bypasses a busy target, interrupts each original once and never replays",{timeout:15000},async t=>native(t,async(_path,db,_owner,locks,worker,raw)=>{
  const lease=locks.tryAcquire("A")!;assert.equal(await worker.process(),1);assert.deepEqual(await raw("count"),["B"]);lease.release();assert.equal(await worker.process(),0);assert.equal(await worker.process(),1);assert.deepEqual(await raw("count"),["B","A"]);assert.equal(await worker.process(),0);assert.equal(await worker.process(),0);assert.deepEqual(await raw("count"),["B","A"]);assert.deepEqual(db.prepare("SELECT phase FROM cdr_stop_controls ORDER BY sequence").all().map(r=>r.phase),["acknowledged","acknowledged"]);
}));
test("native cancellation after actual interrupt keeps original dispatch custody and blocks replay",{timeout:15000},async t=>native(t,async(path,db,_owner,locks,worker,raw)=>{
  const blocked=locks.tryAcquire("B")!,c=new AbortController(),reason={cancel:true},work=worker.process(c.signal);while((await raw("count") as string[]).length===0)await delay(1,undefined,{signal:t.signal});c.abort(reason);await assert.rejects(work,e=>e===reason);assert.deepEqual(await raw("count"),["A"]);assert.equal(db.prepare("SELECT phase FROM cdr_stop_controls WHERE target_thread_id='A'").get()!.phase,"dispatching");assert.equal(state.pendingStopControlsAfter(path,0n).some(([,r])=>r.target==="A"),false);assert.equal(await worker.process(),0);assert.deepEqual(await raw("count"),["A"]);blocked.release();
},true));
