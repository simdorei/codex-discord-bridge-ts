import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import type {DatabaseSync} from 'node:sqlite';
import {NativeResponseCompletionTransport} from '../../src/runtime/native-response-completion-transport.ts';
import {NativeResponseCompletionOwner} from '../../src/runtime/native-response-completion-owner.ts';
import {createResponseCustodyFence} from '../../src/runtime/response-custody-fence.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {isOwnedMutationOutcomeUnknown} from '../../src/app-server/maintenance-attempt.ts';
import type {DurableResponseClaim} from '../../src/app-server/response-attempt.ts';
import {ServerRequestOccurrence,type RequestId} from '../../src/protocol/ids.ts';
import {sha256SerdeValue} from '../../src/core/serde-json.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {responseWorkerFixture,responseUntil} from '../helpers/response-completion-worker-fixture.ts';

const originalId=9007199254740993n;
const occurrenceBytes=Uint8Array.from([0,255,1,254,2,253,3,252,4,251,5,250,6,249,7,248]);
const unknown=(error:unknown)=>isOwnedMutationOutcomeUnknown(error);
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function phase(db:DatabaseSync){return db.prepare('SELECT phase FROM cdr_server_responses').get()?.phase;}
function makeClaim(path:string){
 const request={id:originalId as RequestId,occurrence:ServerRequestOccurrence.fromBytes(occurrenceBytes),method:'item/tool/requestUserInput',params:{threadId:'T',turnId:'V',nested:{question:'original'}}};
 const original={ownerId:'resident',generation:1n,request};
 const authority=createResponseCustodyFence(path,'runtime',String).responseAuthority(original)!.value as Record<string,unknown>;
 return {...original,authority:{...authority},payload:{result:{approved:true,choice:18446744073709551615n}}};
}
interface Fixture {
 path:string;db:DatabaseSync;owner:NativeResponseCompletionOwner;claim:ReturnType<typeof makeClaim>;
 admit():object;
}
async function fixture(run:(f:Fixture)=>Promise<void>,timeoutMs=5000){
 await storeFixture(async path=>{
  const db=await openInitialized(path);
  let owner:NativeResponseCompletionOwner|undefined;
  try{
   db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1)");
   owner=new NativeResponseCompletionOwner(path,'runtime',timeoutMs);
   const completion=owner,claim=makeClaim(path),fence=createResponseCustodyFence(path,'runtime',String);
   await run({path,db,owner:completion,claim,admit:()=>{const receipt=completion.captureResponse(claim);fence.beginResponse(claim);return receipt;}});
  }finally{if(db.isTransaction)db.exec('ROLLBACK');try{await owner?.close();}finally{db.close();}}
 });
}

for(const outcome of ['flushed','not_sent'] as const)test(`native response completion persists observed ${outcome} with exact bigint and occurrence identity`,{timeout:15000},async()=>fixture(async f=>{
 const receipt=f.admit();assert.equal(Object.isFrozen(receipt),true);assert.deepEqual(Reflect.ownKeys(receipt),[]);assert.equal(phase(f.db),'admitted');
 const row=f.db.prepare('SELECT * FROM cdr_server_responses').get()!;
 const expectedRequest={id:originalId,occurrence:Array.from(occurrenceBytes,byte=>BigInt(byte)),method:f.claim.request.method,params:f.claim.request.params};
 assert.equal(row.request_key,sha256SerdeValue(['runtime','resident',1n,originalId,expectedRequest.occurrence]));
 assert.notEqual(row.request_key,sha256SerdeValue(['runtime','resident',1n,originalId.toString(),expectedRequest.occurrence]));
 const authority=parseSerdeValue<Record<string,unknown>>(row.authority_json as string);
 assert.equal(authority.request_sha256,sha256SerdeValue(expectedRequest));assert.equal(authority.generation,1n);
 assert.equal(row.response_sha256,sha256SerdeValue(f.claim.payload));
 await f.owner.finishResponse(receipt,outcome);
 assert.equal(phase(f.db),outcome);assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
 assert.throws(()=>f.owner.finishResponse(receipt,outcome),/unused receipt/);
}));

test('native response receipt owns original request, authority and payload despite caller mutation',async()=>fixture(async f=>{
 const receipt=f.admit(),before=f.db.prepare('SELECT * FROM cdr_server_responses').get()!;
 f.claim.ownerId='replacement';f.claim.generation=2n;f.claim.request.id='replacement';
 f.claim.request.occurrence=ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(9));
 f.claim.request.method='replacement';f.claim.request.params.threadId='elsewhere';f.claim.request.params.nested.question='changed';
 f.claim.authority.key='replacement';f.claim.authority.original_job='replacement';
 f.claim.payload.result.approved=false;f.claim.payload.result.choice=1n;
 await f.owner.finishResponse(receipt,'flushed');
 const after=f.db.prepare('SELECT * FROM cdr_server_responses').get()!;
 for(const key of ['request_key','runtime_id','resident_owner','generation','target_thread_id','turn_id','job_id','authority_json','response_sha256'])assert.equal(after[key],before[key],key);
 assert.equal(after.phase,'flushed');
}));

test('native completion preserves existing response capture behavior above one MiB',async()=>fixture(async f=>{
 const claim={...f.claim,payload:{...f.claim.payload,details:'x'.repeat(1048577)}};
 const receipt=f.owner.captureResponse(claim);createResponseCustodyFence(f.path,'runtime',String).beginResponse(claim);
 assert.equal(f.db.prepare('SELECT response_sha256 FROM cdr_server_responses').get()!.response_sha256,sha256SerdeValue(claim.payload));
 await f.owner.finishResponse(receipt,'flushed');assert.equal(phase(f.db),'flushed');
}));

test('copied, forged and foreign receipts cannot settle an original response',async()=>fixture(async f=>storeFixture(async otherPath=>{
 const otherDb=await openInitialized(otherPath),other=new NativeResponseCompletionOwner(otherPath,'runtime');
 try{
  const receipt=f.admit();
  assert.throws(()=>f.owner.finishResponse({...receipt},'not_sent'),/unused receipt/);
  assert.throws(()=>f.owner.finishResponse(Object.create(receipt) as object,'not_sent'),/unused receipt/);
  assert.throws(()=>other.finishResponse(receipt,'not_sent'),/unused receipt/);
  assert.equal(phase(f.db),'admitted');assert.equal(phase(otherDb),undefined);
  await f.owner.finishResponse(receipt,'not_sent');assert.equal(phase(f.db),'not_sent');
 }finally{await other.close();otherDb.close();}
})));

test('closed owner refuses capture and consumes uncompleted receipt without settling admission',async()=>fixture(async f=>{
 const receipt=f.admit();await f.owner.close();
 assert.throws(()=>f.owner.captureResponse(f.claim),/closed/);
 await assert.rejects(f.owner.finishResponse(receipt,'not_sent'),unknown);
 assert.throws(()=>f.owner.finishResponse(receipt,'flushed'),/unused receipt/);
 assert.equal(phase(f.db),'admitted');assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
}));

test('preaborted completion remains unknown and cannot reuse its consumed receipt',async()=>fixture(async f=>{
 const receipt=f.admit(),controller=new AbortController();controller.abort(new Error('already canceled'));
 await assert.rejects(f.owner.finishResponse(receipt,'flushed',controller.signal),unknown);
 assert.throws(()=>f.owner.finishResponse(receipt,'not_sent'),/unused receipt/);
 assert.equal(phase(f.db),'admitted');assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
}));

for(const outcome of ['flushed','not_sent'] as const)test(`native ${outcome} completion preserves a terminal original response`,async()=>fixture(async f=>{
 const receipt=f.admit();f.db.exec("UPDATE cdr_server_responses SET phase='terminal'");
 await f.owner.finishResponse(receipt,outcome);assert.equal(phase(f.db),'terminal');
}));

for(const mismatch of ['payload','authority','occurrence','integer-id-type'] as const)test(`mismatched original ${mismatch} remains unknown and admitted`,async()=>fixture(async f=>{
 f.admit();
 const claim:DurableResponseClaim=mismatch==='payload'?{...f.claim,payload:{result:{approved:false}}}
  :mismatch==='authority'?{...f.claim,authority:{...f.claim.authority,stop_sequence:99n}}
  :mismatch==='occurrence'?{...f.claim,request:{...f.claim.request,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(8))}}
  :{...f.claim,request:{...f.claim.request,id:originalId.toString()}};
 const receipt=f.owner.captureResponse(claim);
 await assert.rejects(f.owner.finishResponse(receipt,'flushed'),unknown);
 assert.equal(phase(f.db),'admitted');assert.throws(()=>f.owner.finishResponse(receipt,'not_sent'),/unused receipt/);
}));

test('runtime replacement cannot lend authority to an original completion',async()=>fixture(async f=>{
 const receipt=f.admit();f.db.exec("UPDATE codex_mutation_runtime SET runtime_id='replacement'");
 await assert.rejects(f.owner.finishResponse(receipt,'flushed'),unknown);
 assert.equal(phase(f.db),'admitted');assert.throws(()=>f.owner.finishResponse(receipt,'not_sent'),/unused receipt/);
}));

test('failed SQLite completion is unknown, retains admission and is never retried',async()=>fixture(async f=>{
 const receipt=f.admit();f.db.exec("CREATE TRIGGER denied BEFORE UPDATE ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'completion denied'); END");
 await assert.rejects(f.owner.finishResponse(receipt,'flushed'),unknown);
 assert.equal(phase(f.db),'admitted');assert.equal(ownedWorkerUsage().Control,0);
 f.db.exec('DROP TRIGGER denied');assert.throws(()=>f.owner.finishResponse(receipt,'flushed'),/unused receipt/);
 await delay(25);assert.equal(phase(f.db),'admitted');assert.equal(f.owner.busy,false);
}));

test('held SQLite completion leaves event loop responsive and joins its worker',{timeout:15000},async()=>fixture(async f=>{
 const receipt=f.admit();f.db.exec('BEGIN IMMEDIATE');
 let timerElapsed=Infinity;const start=performance.now();
 const timer=setTimeout(()=>{timerElapsed=performance.now()-start;f.db.exec('COMMIT');},250);
 try{
  const pending=f.owner.finishResponse(receipt,'flushed');assert.equal(f.owner.busy,true);await pending;
  assert.ok(timerElapsed<1500,`event loop timer delayed ${timerElapsed}ms`);
  assert.equal(phase(f.db),'flushed');assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
 }finally{clearTimeout(timer);if(f.db.isTransaction)f.db.exec('ROLLBACK');}
}));

test('cancellation waits for native lock exit and never rewrites an observed flush as not_sent',{timeout:15000},async()=>fixture(async f=>{
 const receipt=f.admit(),controller=new AbortController();f.db.exec('BEGIN IMMEDIATE');
 const pending=f.owner.finishResponse(receipt,'flushed',controller.signal),rejected=assert.rejects(pending,unknown);
 let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await delay(100);assert.equal(f.owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);
  controller.abort(new Error('cancel original completion'));await delay(50);
  assert.equal(settled,false);assert.equal(phase(f.db),'admitted');assert.equal(ownedWorkerUsage().Control,1);
  f.db.exec('COMMIT');await rejected;
  assert.equal(phase(f.db),'flushed');assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
  assert.throws(()=>f.owner.finishResponse(receipt,'not_sent'),/unused receipt/);
 }finally{if(f.db.isTransaction)f.db.exec('ROLLBACK');await Promise.allSettled([pending,rejected]);}
}));

test('expired completion deadline joins native exit and reports a late commit as unknown',{timeout:15000},async()=>fixture(async f=>{
 const receipt=f.admit();f.db.exec('BEGIN IMMEDIATE');
 const pending=f.owner.finishResponse(receipt,'flushed'),rejected=assert.rejects(pending,unknown);
 let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await delay(200);assert.equal(settled,false);assert.equal(f.owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.equal(phase(f.db),'admitted');
  f.db.exec('COMMIT');await rejected;
  assert.equal(phase(f.db),'flushed');assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
  assert.throws(()=>f.owner.finishResponse(receipt,'not_sent'),/unused receipt/);
 }finally{if(f.db.isTransaction)f.db.exec('ROLLBACK');await Promise.allSettled([pending,rejected]);}
},100));

test('close cancels outstanding completion but joins its original native write',{timeout:15000},async()=>fixture(async f=>{
 const receipt=f.admit();f.db.exec('BEGIN IMMEDIATE');
 const pending=f.owner.finishResponse(receipt,'not_sent'),rejected=assert.rejects(pending,unknown);
 let closing:Promise<void>|undefined,closed=false;
 try{
  await delay(100);assert.equal(ownedWorkerUsage().Control,1);
  closing=f.owner.close();void closing.then(()=>{closed=true;});await delay(50);
  assert.equal(closed,false);assert.equal(f.owner.busy,true);assert.equal(phase(f.db),'admitted');
  f.db.exec('COMMIT');await rejected;await closing;
  assert.equal(phase(f.db),'not_sent');assert.equal(f.owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
 }finally{if(f.db.isTransaction)f.db.exec('ROLLBACK');await Promise.allSettled([pending,rejected,closing]);}
}));

test('capture performs no store creation and missing completion store remains absent',async()=>fixture(async f=>storeFixture(async missingPath=>{
 const missing=new NativeResponseCompletionOwner(missingPath,'runtime');
 try{
  const receipt=missing.captureResponse(f.claim);assert.equal(Object.isFrozen(receipt),true);assert.equal(missing.busy,false);assert.equal(existsSync(missingPath),false);
  await assert.rejects(missing.finishResponse(receipt,'flushed'),unknown);
  assert.equal(existsSync(missingPath),false);assert.equal(existsSync(`${missingPath}-wal`),false);assert.equal(existsSync(`${missingPath}-shm`),false);
  assert.throws(()=>missing.finishResponse(receipt,'not_sent'),/unused receipt/);assert.equal(phase(f.db),undefined);
 }finally{await missing.close();}
})));
test('queued completion cancellation uses the existing Control FIFO and submits no extra worker',{timeout:15000},async()=>fixture(async f=>{
 const receipt=f.admit(),second=f.owner.captureResponse(f.claim),watch=responseWorkerFixture(f.path),controller=new AbortController();
 const first=f.owner.finishResponse(receipt,'flushed');let next:Promise<void>|undefined;
 try{
  await responseUntil(()=>Atomics.load(watch.trace,3)===1,'first completion committed and retained');
  next=f.owner.finishResponse(second,'not_sent',controller.signal);const rejected=assert.rejects(next,unknown);controller.abort(Error('cancel queued original'));
  await rejected;assert.equal(watch.count,1);assert.equal(watch.exited,0);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.owner.busy,true);assert.throws(()=>f.owner.finishResponse(second,'flushed'),/unused receipt/);
  watch.release();await first;assert.equal(phase(f.db),'flushed');assert.equal(ownedWorkerUsage().Control,0);
 }finally{watch.release();await Promise.allSettled([first,...(next?[next]:[])]);await watch.join();watch.restore();}
}));

for(const stop of ['close','caller-abort'] as const)test(`completion ${stop} between transport settlement and owner classification remains unknown`,{timeout:15000},async()=>fixture(async f=>{
 const original=NativeResponseCompletionTransport.prototype.submit,controller=new AbortController();
 let reached=false,closing:Promise<void>|undefined,closed=false;
 NativeResponseCompletionTransport.prototype.submit=function(handle,job,signal){
  return Reflect.apply(original,this,[handle,job,signal]).then(raw=>{
   // The real worker has completed and joined. Stop in the precise additional
   // continuation before the owner receives raw data; do not forge an ACK.
   reached=true;assert.equal(ownedWorkerUsage().Control,0);assert.equal(phase(f.db),'flushed');assert.equal(f.owner.busy,true);
   if(stop==='close'){closing=f.owner.close();void closing.then(()=>{closed=true;});assert.equal(closed,false);}
   else controller.abort(Error('caller abort before owner classification'));
   assert.equal(f.owner.busy,true);return raw;
  });
 };
 try{
  const receipt=f.admit();await assert.rejects(f.owner.finishResponse(receipt,'flushed',controller.signal),unknown);
  assert.equal(reached,true);await closing;assert.equal(f.owner.busy,false);assert.equal(phase(f.db),'flushed');
  assert.throws(()=>f.owner.finishResponse(receipt,'not_sent'),/unused receipt/);
 }finally{NativeResponseCompletionTransport.prototype.submit=original;await closing;}
}));
