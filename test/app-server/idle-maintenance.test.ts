import assert from "node:assert/strict";
import {test} from "node:test";
import {IdleTargetGate} from "../../src/app-server/idle-target-gate.ts";
import {IdleMaintenanceWork,type IdleRpcRequest,type IdleRpcResult,type IdleMaintenancePort} from "../../src/app-server/idle-maintenance.ts";
import type {IdleReleaseJournal,IdleReleaseToken} from "../../src/app-server/idle-release-journal.ts";
const token=(state="Candidate"):IdleReleaseToken=>({intentId:"i",ownerId:"o",generation:7n,threadId:"T",turnId:"V",jobId:"j",revision:1n,state,detail:""});
const ok=(value:unknown):IdleRpcResult=>({ok:true,value,phase:"Flushed"});
const idle=(id="V",status="completed")=>({thread:{id:"T",status:{type:"idle"},turns:[{id,status}]}});
function fixture(state="Candidate"){
  let current=token(state),generation=7n,witness=true,revision=20n,failTransition:string|null=null;
  const events:unknown[]=[];const replies:IdleRpcResult[]=[ok({goal:null}),ok(idle()),ok({status:"unsubscribed"})];
  const journal:IdleReleaseJournal={beforeMutation:()=>null,checkMutation:()=>{},resumeRequired:()=>false,verify:()=>{},oldChildExited:()=>{},transition:(old,next,detail)=>{
    events.push(["advance",next,detail]);assert.deepEqual(old,current);if(failTransition===next)throw new Error("store unavailable");current={...old,state:next,detail,revision:old.revision+1n};return current;
  }};
  const gate=new IdleTargetGate();gate.install(journal);const permit=gate.reserve(current);
  const port:IdleMaintenancePort={rpc:async r=>{events.push(r);const result=replies.shift();assert.ok(result);return result;},localIdle:expected=>{events.push(["local",expected]);if(expected!==null&&expected!==revision)throw new Error("watermark changed");return revision;},witnessedTerminal:(t,v)=>{assert.equal(t,"T");assert.equal(v,"V");return witness;},generation:()=>generation,renderError:e=>e instanceof Error?e.message:"unknown"};
  return {port,permit,gate,events,replies,work:()=>new IdleMaintenanceWork(current,permit,port),current:()=>current,setGeneration:(v:bigint)=>{generation=v;},setWitness:(v:boolean)=>{witness=v;},setRevision:(v:bigint)=>{revision=v;},failTransition:(v:string)=>{failTransition=v;}};
}
test("release proves exact terminal, goal and latest turn before committing dispatch; ACK requires a fresh unload read",async()=>{
  const f=fixture();await f.work().release();assert.equal(f.current().state,"AwaitUnload");
  const rpc=f.events.filter(x=>!Array.isArray(x)) as IdleRpcRequest[];
  assert.deepEqual(rpc.map(r=>[r.method,r.timeoutMs,r.requireIdle,r.watermark,r.token.state]),[["thread/goal/get",2000,true,20n,"Candidate"],["thread/read",2000,true,20n,"Candidate"],["thread/unsubscribe",8000,true,20n,"Dispatching"]]);
  assert.deepEqual(rpc[1]!.params,{threadId:"T",includeTurns:true});assert.ok(Object.isFrozen(rpc[2]!.token));
  f.replies.push(ok({thread:{id:"T",status:{type:"notLoaded"}}}));await f.work().release();assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"UnloadedConfirmed");f.permit.release();
});
test("all three unsubscribe ACK variants stay AwaitUnload, never immediate settled permission",async()=>{
  for(const status of ["unsubscribed","notSubscribed","notLoaded"]){const f=fixture();f.replies[2]=ok({status});await f.work().release();assert.equal(f.current().state,"AwaitUnload");f.permit.release();}
});
test("missing witness prevents every RPC and records a Candidate deferral",async()=>{
  const f=fixture();f.setWitness(false);await assert.rejects(f.work().release(),/terminal not witnessed/);assert.equal(f.events.some(x=>!Array.isArray(x)),false);assert.equal(f.current().state,"Candidate");f.permit.release();
});
test("goal must be explicit and only absent goal value or Complete allows read",async()=>{
  for(const goal of [{},{goal:{threadId:"T",status:"blocked"}},{goal:{threadId:"T",status:"paused"}},{goal:{threadId:"other",status:"complete"}},{goal:{threadId:"T",status:"active"}}]){const f=fixture();f.replies[0]=ok(goal);await assert.rejects(f.work().release());assert.equal(f.events.filter(x=>!Array.isArray(x)).length,1);assert.equal(f.current().state,"Candidate");f.permit.release();}
  const f=fixture();f.replies[0]=ok({goal:{threadId:"T",status:"complete"}});await f.work().release();assert.equal(f.current().state,"AwaitUnload");f.permit.release();
});
test("latest exact turn and idle thread are required, with completed/failed/interrupted terminal statuses",async()=>{
  for(const reply of [idle("wrong"),idle("V","inProgress"),{thread:{id:"T",status:{type:"idle"},turns:[]}},{thread:{id:"other",status:{type:"idle"},turns:[{id:"V",status:"completed"}]}},{thread:{id:"T",status:{type:"active"},turns:[{id:"V",status:"completed"}]}}]){const f=fixture();f.replies[1]=ok(reply);await assert.rejects(f.work().release(),/exact latest terminal/);assert.equal(f.current().state,"Candidate");assert.equal(f.replies.length,1);f.permit.release();}
  for(const status of ["failed","interrupted"]){const f=fixture();f.replies[1]=ok(idle("V",status));await f.work().release();assert.equal(f.current().state,"AwaitUnload");f.permit.release();}
});
test("watermark change during the read prevents unsubscribe",async()=>{
  const f=fixture(),rpc=f.port.rpc;f.port.rpc=async r=>{const result=await rpc(r);if(r.method==="thread/read")f.setRevision(21n);return result;};await assert.rejects(f.work().release(),/watermark changed/);assert.equal(f.current().state,"Candidate");assert.equal(f.replies.length,1);f.permit.release();
});
test("failed permission commit prevents transport, while failed ACK commit retains Dispatching",async()=>{
  for(const next of ["Dispatching","AwaitUnload"]){const f=fixture();f.failTransition(next);await assert.rejects(f.work().release(),/store unavailable/);assert.equal(f.current().state,next==="Dispatching"?"Candidate":"Dispatching");assert.equal(f.replies.length,next==="Dispatching"?1:0);f.permit.release();}
});
test("unsubscribe errors distinguish not sent from partial and flushed, preserving raw error",async()=>{
  for(const phase of ["NotStarted","Partial","Flushed"] as const){const f=fixture(),error=new Error("transport lost");f.replies[2]={ok:false,error,phase};await assert.rejects(f.work().release(),e=>e===error);assert.equal(f.current().state,phase==="NotStarted"?"Settled":"Unknown");f.permit.release();}
  const f=fixture();f.replies[2]=ok({status:"unrecognized"});await assert.rejects(f.work().release(),/unclassifiable unsubscribe/);assert.equal(f.current().state,"Unknown");f.permit.release();
});
test("failure recording combines errors and retains the dispatch hold",async()=>{
  const f=fixture();f.failTransition("Unknown");f.replies[2]={ok:false,error:new Error("lost"),phase:"Flushed"};await assert.rejects(f.work().release(),/lost; recording failed: store unavailable; durable dispatch hold retained/);assert.equal(f.current().state,"Dispatching");f.permit.release();
});
test("AwaitUnload probes without idle requirement, never treats different identity or an idle reply as unload",async()=>{
  for(const reply of [{thread:{id:"other",status:{type:"notLoaded"}}},{thread:{id:"T",status:{type:"idle"}}}]){const f=fixture("AwaitUnload");f.replies.splice(0,f.replies.length,ok(reply));if(reply.thread.id==="other")await assert.rejects(f.work().release(),/different or missing thread/);else await f.work().release();assert.equal(f.current().state,"AwaitUnload");const rpc=f.events[0] as IdleRpcRequest;assert.equal(rpc.requireIdle,false);assert.equal(rpc.watermark,null);assert.deepEqual(rpc.params,{threadId:"T",includeTurns:false});f.permit.release();}
});
test("resubscribe requires durable permission and exact reply generation before settlement",async()=>{
  const f=fixture("Resubscribing");f.replies.splice(0,f.replies.length,ok({thread:{id:"T"}}));const reply=await f.work().resubscribe({threadId:"T"});assert.deepEqual(reply,{thread:{id:"T"}});assert.equal(f.current().detail,"SupersededByConfirmedResubscribe");f.permit.release();
  for(const wrongGeneration of [false,true]){const f=fixture("Resubscribing");f.replies.splice(0,f.replies.length,ok({thread:{id:wrongGeneration?"T":"wrong"}}));if(wrongGeneration)f.setGeneration(8n);await assert.rejects(f.work().resubscribe({threadId:"T"}),/wrong identity or owner changed/);assert.equal(f.current().state,"Unknown");f.permit.release();}
});
test("resubscribe not-started restores AwaitUnload; uncertain write never automatically retries",async()=>{
  for(const phase of ["NotStarted","Partial","Flushed"] as const){const f=fixture("Resubscribing"),error=new Error("timeout");f.replies.splice(0,f.replies.length,{ok:false,error,phase});await assert.rejects(f.work().resubscribe({threadId:"T"}),e=>e===error);assert.equal(f.current().state,phase==="NotStarted"?"AwaitUnload":"Unknown");assert.equal(f.events.filter(x=>!Array.isArray(x)).length,1);f.permit.release();}
});
test("one work is consumed once, methods are pinned, and released permits prevent work",async()=>{
  const f=fixture(),work=f.work();f.port.rpc=async()=>{throw new Error("replacement");};await work.release();await assert.rejects(work.release(),/already consumed/);f.permit.release();assert.throws(()=>f.work(),/released/);
});
test("missing write phase or adapter exception after dispatch retains durable Dispatching",async()=>{
  for(const reject of [true,false]){const f=fixture(),rpc=f.port.rpc;f.port.rpc=async r=>{if(r.method!=="thread/unsubscribe")return rpc(r);if(reject)throw new Error("adapter broken");return {ok:false,error:new Error("unknown"),phase:"incorrect"} as unknown as IdleRpcResult;};await assert.rejects(f.work().release());assert.equal(f.current().state,"Dispatching");f.permit.release();}
});
test("eligibility error recording preserves source ordering and resume settlement failures retain the durable hold",async()=>{
  const f=fixture();f.setWitness(false);f.failTransition("Candidate");await assert.rejects(f.work().release(),/store unavailable/);assert.equal(f.current().state,"Candidate");f.permit.release();
  const r=fixture("Resubscribing");r.replies.splice(0,r.replies.length,ok({thread:{id:"T"}}));r.failTransition("Settled");await assert.rejects(r.work().resubscribe({threadId:"T"}),/store unavailable/);assert.equal(r.current().state,"Resubscribing");r.permit.release();
  const q=fixture("Resubscribing");q.replies.splice(0,q.replies.length,{ok:false,error:new Error("lost"),phase:"Partial"});q.failTransition("Unknown");await assert.rejects(q.work().resubscribe({threadId:"T"}),/lost; recording failed: store unavailable; durable resume hold retained/);assert.equal(q.current().state,"Resubscribing");q.permit.release();
});
test("maintenance keeps target exclusion while a caller stops observing its pending promise",async()=>{
  const f=fixture();let complete!:(v:IdleRpcResult)=>void;const rpc=f.port.rpc;
  f.port.rpc=r=>r.method==="thread/unsubscribe"?new Promise(resolve=>{complete=resolve;}):rpc(r);
  const pending=f.work().release();while(!complete)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.current().state,"Dispatching");assert.throws(()=>f.gate.admit("o",7n,"T"),/maintenance is in flight/);
  complete(ok({status:"unsubscribed"}));await pending;assert.equal(f.current().state,"AwaitUnload");f.permit.release();
});
