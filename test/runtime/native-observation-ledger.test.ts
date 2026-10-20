import test from 'node:test';import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {NativeObservationLedgerOwner} from '../../src/runtime/native-observation-ledger.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
import {IdleObservationError} from '../../src/app-server/notification-state.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
const scope={ownerId:'owned',generation:9007199254740993n};
async function fixture(body:(db:Awaited<ReturnType<typeof openInitialized>>,o:NativeObservationLedgerOwner,path:string)=>Promise<void>,timeout=5000){await storeFixture(async path=>{const db=await openInitialized(path),o=new NativeObservationLedgerOwner(path,timeout);try{await body(db,o,path);}finally{if(db.isTransaction)db.exec('ROLLBACK');await o.close();db.close();}});}
test('native observation preserves original bigints, actual effects and page CAS',async()=>fixture(async(db,o)=>{
 await o.activate(scope);await o.discover(scope,2n);const old=(await o.next(scope))!;assert.equal(old.scope.generation,scope.generation);
 assert.equal(await o.certify(scope,1n,[{kind:'Terminal',thread:'T',turn:'V',payload:'p'}]),false);
 db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('T','V',?,'p','owned')").run(scope.generation);
 assert.equal(await o.certify(scope,1n,[{kind:'Terminal',thread:'T',turn:'V',payload:'p'}]),true);
 assert.equal(await o.finish(old,1n),false);const next=(await o.next(scope))!;assert.equal(await o.finish(next,1n),true);
 assert.equal(await o.verified(scope,2n),false);assert.equal(await o.certify(scope,2n,[{kind:'NoRequiredStore'}]),true);assert.equal(await o.verified(scope,2n),true);
 await o.markUnknown(scope,'unattributed');assert.equal(await o.verified(scope,2n),false);
}));
test('two owned observation operations wait DB lock without blocking main timers or consuming Control',async()=>fixture(async(db,o,path)=>{
 state.activateObservationExisting(path,scope);db.exec('BEGIN IMMEDIATE');
 const a=o.discover(scope,1n),b=o.discover(scope,2n);void a.catch(()=>{});void b.catch(()=>{});
 try{assert.equal(ownedWorkerUsage().Observation,2);assert.equal(ownedWorkerUsage().Control,0);assert.throws(()=>o.next(scope),OwnedWorkerBusyError);
 await new Promise(r=>setTimeout(r,50));assert.equal(db.isTransaction,true);assert.equal(o.busy,true);
 db.exec('ROLLBACK');await Promise.all([a,b]);assert.equal((await o.next(scope))!.scope.generation,scope.generation);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([a,b]);}
}));
test('accepted cancellation joins late committed operation and never returns a synthetic success',async()=>fixture(async(db,o,path)=>{
 state.activateObservationExisting(path,scope);db.exec('BEGIN IMMEDIATE');const c=new AbortController(),p=o.discover(scope,1n,c.signal);let done=false;
 void p.then(()=>{done=true;},()=>{done=true;});const rejected=assert.rejects(p,IdleObservationError);c.abort(new Error('cancel'));
 await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(ownedWorkerUsage().Observation,1);db.exec('ROLLBACK');await rejected;
 assert.equal(state.nextObservationGapExisting(path,scope)!.last,1n);assert.equal(o.busy,false);
}));
test('owner close joins both accepted workers before releasing lifetime',async()=>fixture(async(db,o,path)=>{
 state.activateObservationExisting(path,scope);db.exec('BEGIN IMMEDIATE');const a=o.discover(scope,1n),b=o.markUnknown(scope,'lost');
 const rejected=[assert.rejects(a,IdleObservationError),assert.rejects(b,IdleObservationError)];let closed=false;
 const closing=o.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,40));assert.equal(closed,false);
 db.exec('ROLLBACK');await Promise.all(rejected);await closing;assert.equal(ownedWorkerUsage().Observation,0);assert.throws(()=>o.next(scope),/closed/);
}));
test('deadline is not OS completion and retains slot through actual exit',async()=>fixture(async(db,o,path)=>{
 state.activateObservationExisting(path,scope);db.exec('BEGIN IMMEDIATE');const p=o.discover(scope,1n),rejected=assert.rejects(p,IdleObservationError);let done=false;
 void p.then(()=>{done=true;},()=>{done=true;});await new Promise(r=>setTimeout(r,80));assert.equal(done,false);assert.equal(o.busy,true);
 db.exec('ROLLBACK');await rejected;assert.equal(o.busy,false);
},10));
test('native observation missing database never initializes or claims confirmed proof',async()=>storeFixture(async path=>{
 const o=new NativeObservationLedgerOwner(path);try{await assert.rejects(o.activate(scope),IdleObservationError);assert.equal(existsSync(path),false);}finally{await o.close();}
}));
test('native boundary rejects oversized effects, accessor scope and pre-aborted submission without allocation',async()=>fixture(async(_db,o)=>{
 let calls=0;assert.throws(()=>o.activate({...scope,get ownerId(){calls++;return 'bad';}}));assert.equal(calls,0);
 assert.throws(()=>o.certify(scope,1n,Array.from({length:33},()=>({kind:'NoRequiredStore' as const}))));
 assert.throws(()=>o.certify(scope,1n,[{kind:'Final',thread:'T',turn:'V',content:'x'.repeat(1048576)}]));
 assert.throws(()=>o.activate({...scope,generation:1n<<63n}));assert.throws(()=>o.markUnknown(scope,'x'.repeat(32769)));
 const c=new AbortController();c.abort(new Error('already'));assert.throws(()=>o.next(scope,c.signal),/already/);
 assert.equal(ownedWorkerUsage().Observation,0);assert.equal(ownedWorkerUsage().Control,0);
}));
test('caller mutation after submission cannot replace original observation identity',async()=>fixture(async(db,o,path)=>{
 const original={...scope};db.exec('BEGIN IMMEDIATE');const pending=o.activate(original);original.ownerId='foreign';original.generation=8n;
 await new Promise(r=>setTimeout(r,30));db.exec('ROLLBACK');await pending;
 assert.equal(state.observationScopeVerifiedExisting(path,scope,0n),true);assert.equal(state.observationScopeVerifiedExisting(path,original,0n),false);
}));

test('batched inspection retains original bigint scope, gaps and durable proof',async()=>fixture(async(_db,o)=>{
 await o.activate(scope);assert.deepEqual(await o.inspect(scope,0n),{gap:null,verified:true});
 const pending=await o.inspect(scope,2n);assert.equal(pending.gap!.scope.generation,scope.generation);assert.equal(pending.gap!.last,2n);assert.equal(pending.verified,false);
 await o.certify(scope,1n,[{kind:'NoRequiredStore'}]);assert.equal((await o.inspect(scope,2n)).verified,false);
 await o.certify(scope,2n,[{kind:'NoRequiredStore'}]);assert.deepEqual(await o.inspect(scope,2n),{gap:null,verified:true});
 await o.markUnknown(scope,'unattributed');assert.equal((await o.inspect(scope,2n)).verified,false);
}));

test('cancelled inspection joins accepted database work and retains its original scope',async()=>fixture(async(db,o,path)=>{
 state.activateObservationExisting(path,scope);db.exec('BEGIN IMMEDIATE');const original={...scope},c=new AbortController(),pending=o.inspect(original,1n,c.signal);
 original.ownerId='foreign';original.generation=8n;const rejected=assert.rejects(pending,IdleObservationError);c.abort(new Error('cancel'));let done=false;void pending.then(()=>{done=true;},()=>{done=true;});
 await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(ownedWorkerUsage().Observation,1);db.exec('ROLLBACK');await rejected;
 assert.equal(state.nextObservationGapExisting(path,scope)!.last,1n);assert.equal(o.busy,false);
 assert.throws(()=>o.inspect(scope,1n,c.signal),/cancel/);assert.equal(ownedWorkerUsage().Observation,0);
}));
