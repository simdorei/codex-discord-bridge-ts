import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientLifecycle} from '../../src/app-server/client-lifecycle.ts';
import {ResidentAdmissionState,ResidentStateError,type ResidentDeadClientPort} from '../../src/app-server/resident-state.ts';
import {cloneDeadGenerationWork,deadGenerationWorkEqual,type DeadGenerationWork} from '../../src/app-server/dead-generation-work.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
const occurrence=(n:number)=>ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(n));
function fixture(){
 const gate=new ClientLifecycle();let exited=false,closed=false,work=cloneDeadGenerationWork({generation:1n,closedReason:'EOF',activeTurns:[{threadId:'T',turnId:'V'},{threadId:'U',turnId:'W'}],serverRequests:[{id:1n,occurrence:occurrence(1),method:'approval',params:{threadId:'T',n:18446744073709551615n}},{id:'1',occurrence:occurrence(2),method:'approval',params:{}}]});let settlements=0;
 const port:ResidentDeadClientPort=Object.freeze({identity:{},admitOperation:()=>gate.admit(),sealAdmissions:()=>gate.sealForCleanup('close'),sealIfQuiescent:()=>gate.sealIfQuiescent(()=>work.activeTurns.length===0&&work.serverRequests.length===0),withOpen:<T>(fn:()=>T)=>gate.withOpen(fn),hasOwnedChildExited:()=>exited,isTransportClosed:()=>closed,sealIfNoAdmissions:()=>gate.sealIfQuiescent(()=>true),deadGenerationWork:()=>closed?work:null,settleDeadGenerationExact:(expected:DeadGenerationWork)=>{if(!exited||!closed||!deadGenerationWorkEqual(work,expected))return false;settlements++;work=cloneDeadGenerationWork({...work,activeTurns:[],serverRequests:[]});return true;}});
 const state=new ResidentAdmissionState(port);return {gate,port,state,get work(){return work;},get settlements(){return settlements;},setWork(w:DeadGenerationWork){work=cloneDeadGenerationWork(w);},exit(){exited=true;},close(){closed=true;},ready(){exited=true;closed=true;state.markCurrentClosed(port,1n);}};
}
function deferred(){let resolve!:()=>void,reject!:(e:unknown)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const fenceError=(e:unknown)=>e instanceof ResidentStateError&&e.detail.kind==='DeadGenerationFence';
test('async fence preserves live/closed/exit/admission eligibility and immutable original work',async()=>{
 const f=fixture();f.state.markTimeout(1n);let calls=0;const capture=async()=>{calls++;};assert.equal(await f.state.fenceDeadGenerationBeforeRestartAsync(capture),true);f.close();assert.equal(await f.state.fenceDeadGenerationBeforeRestartAsync(capture),false);const lease=f.state.admitResponse(1n);f.exit();assert.equal(await f.state.fenceDeadGenerationBeforeRestartAsync(capture),false);assert.equal(calls,0);lease.release();
 const d=deferred(),original=f.work,pending=f.state.fenceDeadGenerationBeforeRestartAsync(async w=>{calls++;assert.ok(deadGenerationWorkEqual(w,original));assert.ok(Object.isFrozen(w));assert.equal(f.settlements,0);await d.promise;});assert.equal(calls,1);assert.equal(f.state.generation(),1n);assert.equal(f.settlements,0);assert.ok(deadGenerationWorkEqual(f.work,original));d.resolve();assert.equal(await pending,true);assert.equal(f.settlements,1);
});
test('owned exit without final closure cannot persist; empty work still captures; sealed intentional cleanup skips it',async()=>{
 const f=fixture();f.state.requestRestart();f.exit();let calls=0;assert.equal(await f.state.fenceDeadGenerationBeforeRestartAsync(async()=>{calls++;}),false);assert.equal(calls,0);f.close();f.setWork({...f.work,activeTurns:[],serverRequests:[]});assert.equal(await f.state.fenceDeadGenerationBeforeRestartAsync(async()=>{calls++;}),true);assert.equal(calls,1);
 const g=fixture();g.setWork({...g.work,activeTurns:[],serverRequests:[]});g.state.requestRestart();assert.equal(g.state.restartCandidate().kind,'Sealed');assert.equal(await g.state.fenceDeadGenerationBeforeRestartAsync(async()=>{throw 0;}),true);
});
for(const field of ['closedReason','turn','order','idType','occurrence','method','params','requestsOrder'] as const)test(`async fence rejects complete ${field} change across await`,async()=>{
 const f=fixture();f.ready();const d=deferred(),p=f.state.fenceDeadGenerationBeforeRestartAsync(()=>d.promise),w=f.work,r=w.serverRequests[0]!;
 const changes:Record<typeof field,DeadGenerationWork>={closedReason:{...w,closedReason:'changed'},turn:{...w,activeTurns:[{threadId:'T',turnId:'other'}]},order:{...w,activeTurns:[...w.activeTurns].reverse()},idType:{...w,serverRequests:[{...r,id:'1'}]},occurrence:{...w,serverRequests:[{...r,occurrence:occurrence(7)}]},method:{...w,serverRequests:[{...r,method:'other'}]},params:{...w,serverRequests:[{...r,params:{threadId:'T',n:1n}}]},requestsOrder:{...w,serverRequests:[...w.serverRequests].reverse()}};
 f.setWork(changes[field]);d.resolve();await assert.rejects(p,fenceError);assert.equal(f.settlements,0);assert.ok(deadGenerationWorkEqual(f.work,changes[field]));assert.equal(f.state.generation(),1n);
});
for(const kind of ['terminal','replacement'] as const)test(`async fence refuses ${kind} ownership change across await`,async()=>{
 const f=fixture();f.ready();const d=deferred(),p=f.state.fenceDeadGenerationBeforeRestartAsync(()=>d.promise);
 if(kind==='terminal')f.state.prepareClose();else{const next=fixture();f.state.recordReplacement(next.port,2n);f.state.installReplacementWith(next.port,2n,()=>{});}
 d.resolve();await assert.rejects(p,fenceError);assert.equal(f.settlements,0);assert.equal(f.work.serverRequests.length,2);
});
test('failed or cancelled async capture leaves original evidence and restart obligation for exact retry',async()=>{
 const f=fixture();f.ready();const original=f.work,reason={},d=deferred(),p=f.state.fenceDeadGenerationBeforeRestartAsync(()=>d.promise);d.reject(reason);await assert.rejects(p,e=>e===reason);assert.ok(deadGenerationWorkEqual(f.work,original));assert.equal(f.state.snapshot().restartPending,true);
 const c=new AbortController(),next=deferred(),q=f.state.fenceDeadGenerationBeforeRestartAsync(()=>next.promise,c.signal);c.abort(reason);next.resolve();await assert.rejects(q,e=>e===reason);assert.equal(f.settlements,0);assert.equal(await f.state.fenceDeadGenerationBeforeRestartAsync(async()=>{}),true);
});
test('cached settled snapshot cannot mask new evidence across async reconciliation',async()=>{
 const f=fixture();f.ready();await f.state.fenceDeadGenerationBeforeRestartAsync(async()=>{});const d=deferred(),p=f.state.fenceDeadGenerationBeforeRestartAsync(()=>d.promise);f.setWork({...f.work,activeTurns:[{threadId:'new',turnId:'v'}]});d.resolve();await assert.rejects(p,fenceError);assert.equal(f.work.activeTurns[0]!.threadId,'new');assert.equal(f.settlements,1);
});
