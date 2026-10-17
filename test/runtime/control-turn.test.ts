import assert from "node:assert/strict";
import {test} from "node:test";
import {ControlTurnVerifier} from "../../src/runtime/action-executor/control-turn.ts";
import {MissingActionAppServerError,InvalidActionRequestError,NoActionTargetError,ActionIntegerRangeError} from "../../src/runtime/action-executor/errors.ts";
import {InvalidActionRequestError as PriorInvalid} from "../../src/runtime/action-executor/prepared-submission.ts";
import {TargetLocks} from "../../src/core/keyed-locks.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
function setup(){
  let g=1n,active:string|null="V",healthy=true,quarantined=false,restartPending=false,terminal=false,mapped:string|null=null,selected:string|null="T",onActive=()=>{};const calls:string[]=[];
  const server={generation:()=>g,lifecycleSnapshot:()=>({generation:g,healthy,quarantined,restartPending,processId:1}),activeTurnId:(thread:string)=>{calls.push(`active:${thread}`);onActive();return active;}};
  const store={hasObservedCompletion:async()=>{calls.push("terminal");return terminal;},mirroredThreadId:async()=>{calls.push("mapping");return mapped;}},bridge={selectedThreadId:()=>{calls.push("selected");return selected;}},locks=new TargetLocks();
  return {verifier:new ControlTurnVerifier("fixture",server,bridge,locks,store),server,store,bridge,locks,calls,set:(v:{g?:bigint;active?:string|null;healthy?:boolean;quarantined?:boolean;restartPending?:boolean;terminal?:boolean;mapped?:string|null;selected?:string|null;onActive?:()=>void})=>{if(v.g!==undefined)g=v.g;if(Object.hasOwn(v,"active"))active=v.active!;if(v.healthy!==undefined)healthy=v.healthy;if(v.quarantined!==undefined)quarantined=v.quarantined;if(v.restartPending!==undefined)restartPending=v.restartPending;if(v.terminal!==undefined)terminal=v.terminal;if(Object.hasOwn(v,"mapped"))mapped=v.mapped!;if(Object.hasOwn(v,"selected"))selected=v.selected!;if(v.onActive)onActive=v.onActive;}};
}
test("source command errors retain old exported constructor identity",()=>{assert.equal(PriorInvalid,InvalidActionRequestError);});
test("healthy exact active turn is read-only and shared locks serialize other control work",async()=>{
  const f=setup();assert.deepEqual(await f.verifier.owned("T","V"),["V",1n]);assert.deepEqual(f.calls,["active:T","terminal"]);const lease=await f.verifier.lock("T");assert.equal(f.locks.tryAcquire("T"),undefined);const other=f.locks.tryAcquire("other")!;other.release();lease.release();assert.equal(f.locks.activeTargetCount,0);
});
for(const field of ["healthy","quarantined","restartPending"] as const)test(`control refuses unhealthy lifecycle ${field} before active/store reads`,async()=>{const f=setup();f.set({[field]:field!=="healthy"});await assert.rejects(f.verifier.owned("T"),InvalidActionRequestError);assert.deepEqual(f.calls,[]);});
test("cache absence, original-turn mismatch, generation drift and terminal evidence all refuse",async()=>{
  const absent=setup();absent.set({active:null});await assert.rejects(absent.verifier.owned("T"),/no currently owned/);assert.deepEqual(absent.calls,["active:T"]);
  const mismatch=setup();await assert.rejects(mismatch.verifier.owned("T","old"),/original turn has ended/);assert.deepEqual(mismatch.calls,["active:T"]);
  const changed=setup();changed.set({onActive:()=>changed.set({g:2n})});await assert.rejects(changed.verifier.owned("T"),/connection changed/);assert.deepEqual(changed.calls,["active:T"]);
  const ended=setup();ended.set({terminal:true});await assert.rejects(ended.verifier.owned("T"),/turn completed/);assert.deepEqual(ended.calls,["active:T","terminal"]);
});
test("current mapped target wins over selected; changed target rejects before active query",async()=>{
  const f=setup();f.set({mapped:"mapped",selected:"T"});await assert.rejects(f.verifier.control(42n,"T"),/control target changed/);assert.deepEqual(f.calls,["mapping"]);f.calls.length=0;assert.deepEqual(await f.verifier.control(42n,"mapped","V"),["V",1n]);assert.deepEqual(f.calls,["mapping","active:mapped","terminal"]);
});
test("no selected target, missing server and out-of-range channel are distinct typed failures",async()=>{
  const f=setup();f.set({selected:null});await assert.rejects(f.verifier.control(42n,"T"),NoActionTargetError);await assert.rejects(f.verifier.target(1n<<63n),ActionIntegerRangeError);
  const missing=new ControlTurnVerifier("fixture",null,f.bridge,f.locks,f.store);await assert.rejects(missing.owned("T"),MissingActionAppServerError);
});
test("actual native active cache and SQLite terminal evidence fence current turn without RPC fallback",{timeout:15000},async t=>storeFixture(async path=>{
  const db=await openInitialized(path),code=`import readline from 'node:readline';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='seed')emit({method:'turn/started',params:{threadId:'T',turnId:'V'}});emit({id:m.id,result:{}});});`;
  const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal),v=new ControlTurnVerifier(path,owner,{selectedThreadId:()=>"T"},new TargetLocks());
  try{await assert.rejects(v.owned("T"),/no currently owned/);const a=owner.admitResponse(1n);try{await a.client.requestAdmitted(a.permit,"seed",{},1000);}finally{a.release();}assert.deepEqual(await v.control(42n,"T","V"),["V",1n]);
    db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('T','V',1,'{}')");await assert.rejects(v.owned("T","V"),/turn completed/);assert.equal(owner.generation(),1n);
  }finally{await owner.dispose();db.close();}
}));
