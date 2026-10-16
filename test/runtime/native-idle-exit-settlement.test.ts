import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeIdleBeforeOwner} from '../../src/runtime/native-idle-before.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {IdleObservationError} from '../../src/app-server/notification-state.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {selectIdleIntentIn} from '../../src/store/idle-release-row.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../helpers/store-authority-worker-fixture.ts';
const match='native-idle-before-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
const generation=9007199254740993n;
function insert(db:DatabaseSync,status:string,thread=status,owner='owner',g=generation){db.prepare("INSERT INTO cdr_idle_release VALUES(?,?,?,?,'V','job',1,?,'prior')").run('i-'+thread,owner,g,thread,status);}
async function fixture(run:(path:string,db:DatabaseSync,owner:NativeIdleBeforeOwner)=>Promise<void>,timeout?:number){await storeFixture(async path=>{const db=await openInitialized(path),owner=timeout===undefined?new NativeIdleBeforeOwner(path,()=> 'safe'):new NativeIdleBeforeOwner(path,()=> 'safe',timeout);try{await run(path,db,owner);}finally{if(db.isTransaction)db.exec('ROLLBACK');await owner.close();db.close();}});}
for(const native of [false,true])test(`${native?'native':'central leaf'} exact exit settles every nonterminal phase and preserves foreign and settled rows`,async()=>fixture(async(path,db,owner)=>{
 const statuses=['Candidate','Dispatching','AwaitUnload','Resubscribing','Unknown','Settled'];for(const status of statuses)insert(db,status);
 insert(db,'Unknown','foreign-owner','other');insert(db,'Unknown','foreign-generation','owner',generation+1n);
 const before=new Map(statuses.concat(['foreign-owner','foreign-generation']).map(t=>[t,selectIdleIntentIn(db,t)]));
 const run=async()=>{if(native)await owner.settleExitedOwner('owner',generation);else state.settleExitedIdleOwnerExisting(path,'owner',generation);};await run();
 for(const status of statuses){const row=selectIdleIntentIn(db,status)!;assert.deepEqual(row,status==='Settled'?before.get(status):{...before.get(status),state:'Settled',detail:'OldServerExited',revision:2n});}
 for(const thread of ['foreign-owner','foreign-generation'])assert.deepEqual(selectIdleIntentIn(db,thread),before.get(thread));
 const settled=statuses.map(t=>selectIdleIntentIn(db,t));await run();assert.deepEqual(statuses.map(t=>selectIdleIntentIn(db,t)),settled);assert.equal(db.isTransaction,false);
}));
for(const failure of ['timeout','abort'] as const)test(failure==='timeout'?'30ms timeout-only lock retention; cold retry remains unqualified':'real SQLite lock leaves main timers live and retains abort worker until actual exit',async()=>fixture(async(_path,db,owner)=>{
 insert(db,'Unknown');db.exec('BEGIN IMMEDIATE');const controller=new AbortController(),pending=owner.settleExitedOwner('owner',generation,controller.signal);let done=false;const result=pending.then(()=>{done=true;return null;},error=>{done=true;return error;});
 if(failure==='abort'){await delay(50);controller.abort(new Error('cancel'));}await delay(100);assert.equal(done,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.equal(selectIdleIntentIn(db,'Unknown')!.state,'Unknown');
 db.exec('ROLLBACK');assert.ok(await result instanceof IdleObservationError);assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(selectIdleIntentIn(db,'Unknown')!.revision,2n);
 if(failure==='abort'){await owner.settleExitedOwner('owner',generation);assert.equal(selectIdleIntentIn(db,'Unknown')!.revision,2n);}
},failure==='timeout'?30:5000));
for(const failure of ['drop','duplicate','owner','generation','nonce','path','operation','extra','envelope','crash'] as const)test(`committed ${failure} ACK is unconfirmed, joins actual exit, and permits only explicit idempotent retry`,async()=>fixture(async(_path,db,owner)=>{
 insert(db,'Unknown');const trace=new SharedArrayBuffer(8);const changed=failure==='generation'?"generation:value.value.generation+1n":failure==='extra'?"extra:true":`${failure}:'changed'`;
 const restore=instrumentStoreWorker({match,trace,...(failure==='drop'||failure==='duplicate'?{ack:failure}:{}),...(['owner','generation','nonce','path','operation','extra'].includes(failure)?{before:`parentPort.postMessage=value=>post({...value,value:{...value.value,${changed}}});`}:{}),...(failure==='envelope'?{before:"parentPort.postMessage=value=>post({...value,extra:true});"}:{}),...(failure==='crash'?{after:"Atomics.wait(trace,1,0,15000);throw new Error('after commit');"}:{})});
 let pending:Promise<void>|undefined;try{pending=owner.settleExitedOwner('owner',generation);let done=false;const result=pending.then(()=>{done=true;return null;},error=>{done=true;return error;});await waitTrace(trace);assert.equal(selectIdleIntentIn(db,'Unknown')!.state,'Settled');await delay(20);assert.equal(done,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);releaseTrace(trace);restore();assert.ok(await result instanceof IdleObservationError);assert.equal(ownedWorkerUsage().Control,0);await owner.settleExitedOwner('owner',generation);assert.equal(selectIdleIntentIn(db,'Unknown')!.revision,2n);}finally{releaseTrace(trace);restore();if(pending)await Promise.allSettled([pending]);}
}));
test('missing existing store is never initialized; invalid identities submit no work',async()=>storeFixture(async path=>{
 const owner=new NativeIdleBeforeOwner(path,()=> 'safe');try{for(const g of [-1n,1n<<63n])assert.throws(()=>owner.settleExitedOwner('owner',g));for(const id of ['bad\0','\ud800','x'.repeat(4097)])assert.throws(()=>owner.settleExitedOwner(id,1n));assert.equal(owner.busy,false);await assert.rejects(owner.settleExitedOwner('owner',generation),IdleObservationError);assert.equal(existsSync(path),false);}finally{await owner.close();}
}));

// Separate source-default evidence, not a pass of the historical 30ms cold retry.
// The real lock lasts 100ms after facade entry. The timeout is induced only by
// holding actual postcommit worker exit until submission+5200ms.
test('source-default 5000ms postcommit exit timeout confirms one same-owner idempotent recovery', {timeout:20000},async()=>fixture(async(_path,db,owner)=>{
 insert(db,'Unknown');const trace=new SharedArrayBuffer(12),facade=new URL('../../src/store/state-access-facade.ts',import.meta.url);if(import.meta.url.endsWith('.js'))facade.pathname=facade.pathname.slice(0,-3)+'.js';
 const restore=instrumentStoreWorker({match,trace,before:`const {StateAccessFacade:state}=await import(${JSON.stringify(facade.href)});const original=state.settleExitedIdleOwnerExisting;state.settleExitedIdleOwnerExisting=(...args)=>{Atomics.store(trace,2,1);return Reflect.apply(original,state,args);};`});
 let pending:Promise<void>|undefined;try{
  db.exec('BEGIN IMMEDIATE');const submitted=performance.now();pending=owner.settleExitedOwner('owner',generation);let done=false;const observed=pending.then(()=>{done=true;return null;},error=>{done=true;return error;});
  await waitTrace(trace,2);await delay(100);assert.equal(done,false);assert.equal(db.isTransaction,true);assert.equal(selectIdleIntentIn(db,'Unknown')!.state,'Unknown');assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);
  db.exec('ROLLBACK');await waitTrace(trace);assert.equal(selectIdleIntentIn(db,'Unknown')!.revision,2n);assert.equal(selectIdleIntentIn(db,'Unknown')!.state,'Settled');
  await delay(Math.max(0,submitted+5200-performance.now()));assert.equal(done,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);
  releaseTrace(trace);restore();assert.ok(await observed instanceof IdleObservationError);assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
  await owner.settleExitedOwner('owner',generation);assert.equal(selectIdleIntentIn(db,'Unknown')!.revision,2n);assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');releaseTrace(trace);restore();if(pending)await Promise.allSettled([pending]);}
}));
