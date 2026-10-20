import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {promptFixture,callPromptFixture} from '../helpers/server-prompt-fixture.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {runServerRequestWorker} from '../../src/runtime/server-request-worker.ts';
import {createNativePromptAuthorityReads} from '../../src/runtime/server-prompt-authority-reads.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import type {DiscordReceiptTransport} from '../../src/runtime/completion/receipt-sender.ts';

// Socket-free delivery/receipt qualification. The resident child, subscription,
// SQLite and native receipt/read workers are real. These transport callbacks are
// passive branch witnesses, not an HTTP client or evidence of remote acceptance.
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function receipt(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts').all();}finally{db.close();}}
function idle(){assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});}
function observe(p:Promise<void>){return p.then(()=>({ok:true as const}),error=>({ok:false as const,error}));}
async function bounded<T>(promise:Promise<T>,label:string):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out observing '+label)),3000);})]);}finally{clearTimeout(timer);}}
async function entryBeforeExit(entry:Promise<void>,pending:Promise<unknown>){await bounded(Promise.race([entry,pending.then(()=>{throw new Error('Delivery settled before passive callback entry');})]),'passive callback entry');}
async function until(predicate:()=>boolean){const deadline=performance.now()+3000;while(!predicate()){assert.ok(performance.now()<deadline,'bounded ownership observation');await new Promise(resolve=>setTimeout(resolve,5));}}

for(const operation of ['process','recover'] as const)test(`passive ${operation} transport receives the exact signal and original receiver`,{timeout:20000},()=>promptFixture(async(path,server,request)=>{
 const stop=new AbortController();let sends=0;
 const transport:DiscordReceiptTransport={async sendValidated(_request,signal){assert.equal(this,transport);assert.equal(signal,stop.signal);sends++;return 91n;}};
 const delivery=new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path));
 if(operation==='process')await delivery.process(1n,request,stop.signal);else await delivery.recover(stop.signal);
 assert.equal(sends,1);assert.equal(receipt(path)[0]!.message_id,'91');assert.deepEqual(await callPromptFixture(server,'answers'),[]);idle();
}));

test('pre-aborted direct delivery preserves exact reason without receipt or passive transport entry',{timeout:20000},()=>promptFixture(async(path,server,request)=>{
 const stop=new AbortController(),reason=new Error('original pre-abort');stop.abort(reason);let sends=0;
 const delivery=new ServerRequestDelivery(path,server,{async sendValidated(){sends++;return 92n;}},true,createNativePromptAuthorityReads(path));
 await assert.rejects(delivery.process(1n,request,stop.signal),error=>error===reason);
 await assert.rejects(delivery.recover(stop.signal),error=>error===reason);
 assert.equal(sends,0);assert.deepEqual(receipt(path),[]);idle();
}));

test('passive post-intent cancellation joins callback and keeps unknown receipt across recreated delivery',{timeout:20000},()=>promptFixture(async(path,server,request)=>{
 const stop=new AbortController(),reason=new Error('original in-flight cancellation'),entered=deferred(),release=deferred(),aborted=deferred();let sends=0,ended=false,observedReason:unknown;
 const transport:DiscordReceiptTransport={async sendValidated(_request,signal){
  assert.equal(signal,stop.signal);sends++;assert.equal(receipt(path)[0]!.message_id,null);
  const onAbort=()=>{observedReason=signal!.reason;aborted.resolve();};signal!.addEventListener('abort',onAbort,{once:true});
  try{entered.resolve();await release.promise;signal!.throwIfAborted();return 93n;}finally{signal!.removeEventListener('abort',onAbort);}
 }};
 const delivery=new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path));
 const pending=observe(delivery.process(1n,request,stop.signal)).then(value=>{ended=true;return value;});
 try{
  await entryBeforeExit(entered.promise,pending);stop.abort(reason);await bounded(aborted.promise,'direct abort');assert.equal(observedReason,reason);await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);
  await assert.rejects(delivery.recover(),/already owned/);release.resolve();const result=await pending;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,reason);
  assert.deepEqual(receipt(path).map(row=>({...row})),[{message_id:null,retryable:0,blocked_reason:null}]);
  await assert.rejects(new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path)).process(1n,request),/outcome unknown/);
  assert.equal(sends,1);assert.equal(server.pendingServerRequests().length,1);assert.deepEqual(await callPromptFixture(server,'answers'),[]);idle();
 }finally{stop.abort(reason);release.resolve();await pending;}
}));

test('original receiver and worker retain passive cancelled work until actual callback settlement',{timeout:20000},()=>promptFixture(async(path,server,request)=>{
 const stop=new AbortController(),reason=new Error('worker shutdown'),receiver=server.subscribeServerRequests(),entered=deferred(),release=deferred(),aborted=deferred();
 let sends=0,ended=false,operationSignal:AbortSignal|undefined,observedReason:unknown;const reports:unknown[]=[];
 const transport:DiscordReceiptTransport={async sendValidated(_request,signal){
  assert.ok(signal instanceof AbortSignal);operationSignal=signal;sends++;
  const onAbort=()=>{observedReason=signal.reason;aborted.resolve();};signal.addEventListener('abort',onAbort,{once:true});
  try{entered.resolve();await release.promise;signal.throwIfAborted();return 94n;}finally{signal.removeEventListener('abort',onAbort);}
 }};
 const delivery=new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path));
 const pending=observe(runServerRequestWorker(receiver,server,delivery,stop.signal,event=>{reports.push(event);})).then(value=>{ended=true;return value;});
 try{
  await entryBeforeExit(entered.promise,pending);stop.abort(reason);await bounded(aborted.promise,'worker abort');assert.equal(observedReason,reason);assert.notEqual(operationSignal,stop.signal);assert.equal(operationSignal!.reason,reason);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);assert.equal(receiver.tryReceive().kind,'Empty');
  await assert.rejects(delivery.process(1n,request),/already owned/);assert.throws(()=>delivery.claimWorker(server),/already owned/);
  release.resolve();assert.deepEqual(await pending,{ok:true});assert.equal(receiver.tryReceive().kind,'Closed');assert.deepEqual(reports,[]);
  assert.deepEqual(receipt(path).map(row=>({...row})),[{message_id:null,retryable:0,blocked_reason:null}]);
  await assert.rejects(delivery.recover(),/outcome unknown/);assert.equal(sends,1);assert.deepEqual(await callPromptFixture(server,'answers'),[]);idle();
 }finally{stop.abort(reason);release.resolve();await pending;receiver.dispose();}
}));

test('passive valid ID after cancellation still joins real locked native confirmation before receiver release',{timeout:20000},()=>promptFixture(async(path,server)=>{
 const stop=new AbortController(),reason=new Error('cancel after passive validated ID'),receiver=server.subscribeServerRequests(),entered=deferred();
 let blocker:DatabaseSync|undefined,sends=0,ended=false,ticks=0;const reports:unknown[]=[];
 const transport:DiscordReceiptTransport={async sendValidated(_request,signal){
  assert.ok(signal instanceof AbortSignal);sends++;blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');
  stop.abort(reason);assert.equal(signal.reason,reason);entered.resolve();return 95n;
 }};
 const delivery=new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path));
 const pending=observe(runServerRequestWorker(receiver,server,delivery,stop.signal,event=>{reports.push(event);})).then(value=>{ended=true;return value;});
 const timer=setInterval(()=>ticks++,5);
 try{
  await entryBeforeExit(entered.promise,pending);await until(()=>ownedWorkerUsage().Control===1);await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(ended,false);assert.equal(receiver.tryReceive().kind,'Empty');assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);
  await assert.rejects(delivery.recover(),/already owned/);blocker!.exec('ROLLBACK');assert.deepEqual(await pending,{ok:true});
  assert.equal(receipt(path)[0]!.message_id,'95');assert.equal(receiver.tryReceive().kind,'Closed');assert.deepEqual(reports,[]);
  await new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path)).recover();assert.equal(sends,1);
  assert.deepEqual(await callPromptFixture(server,'answers'),[]);idle();
 }finally{clearInterval(timer);if(blocker?.isTransaction)blocker.exec('ROLLBACK');stop.abort(reason);await pending;blocker?.close();receiver.dispose();}
}));
