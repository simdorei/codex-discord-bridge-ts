import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {createMainNativeMutationBroker,type MainNativeMutationBroker} from '../../src/runtime/native-mutation-broker-owner.ts';
import {calculateMutationBrokerReservation,validateMutationBrokerLimits,captureMutationClaim,validateMutationNativeResult,validateMutationReply,type MutationBrokerLimits} from '../../src/runtime/native-mutation-broker-protocol.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {createMutationCustodyFence} from '../../src/runtime/mutation-custody-fence.ts';
import {NativeMutationTransport} from '../../src/runtime/native-mutation-transport.ts';
import {ownedWorkerUsage,OwnedWorkerSlot,ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';
import type {MaintenanceClaim} from '../../src/app-server/maintenance-attempt.ts';
const base={maxClaimUtf8Bytes:8192,maxClaimStringUnits:8192,maxClaimNodes:256,maxClaimEdges:256,maxClaimDepth:16,maxContainerEntries:64,maxNativeResultUtf8Bytes:16384,maxRetainedLogicalBytes:10000000,maxRetainedNodes:100000,maxRetainedEdges:100000,nativeTimeoutMs:5000,handshakeTimeoutMs:5000,exchangeTimeoutMs:5000,preparedAwaitFinishTimeoutMs:5000,terminalRetentionMs:5000,minStatusIntervalMs:1} satisfies MutationBrokerLimits;
const waitLimit=10000;
type Report={event:string;value:any};
function harness(broker:MainNativeMutationBroker,claim:MaintenanceClaim,scenario:string){
 const buffer=new SharedArrayBuffer(4),gate=new Int32Array(buffer),reports:Report[]=[];
 const worker=new Worker(ownedWorkerModuleUrl(new URL('./fixtures/native-mutation-broker-client-worker.ts',import.meta.url),import.meta.url),{workerData:{claim,scenario,gate:buffer}});
 let exited=false,exitCode:number|null=null;const joined=new Promise<void>((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>{exited=true;exitCode=code;resolve();});});
 worker.on('message',r=>reports.push(r));broker.bindRequester(worker);
 return {worker,reports,joined,advance(n:number){Atomics.store(gate,0,n);},async event(name:string):Promise<any>{const end=Date.now()+waitLimit;for(;;){const error=reports.find(r=>r.event==='error');if(error)throw new Error(JSON.stringify(error.value));const r=reports.find(r=>r.event===name);if(r)return r.value;if(exited)throw Error('Requester exited '+exitCode+' before '+name);if(Date.now()>end)throw Error('Fixture observation deadline '+name);await delay(2);}}};
}
async function fixture(run:(path:string,db:DatabaseSync,c:MaintenanceClaim)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
 const params={threadId:'T'},origin=createMutationCustodyFence(path,'runtime',()=> 'safe').requestOrigin('thread/settings/update',params);
 const c:MaintenanceClaim={ownerId:'resident',generation:1n,attemptId:'original-attempt',wire:12n,method:'thread/settings/update',params,scoped:true,origin};
 try{await run(path,db,c);}finally{db.close();}
});}
function row(db:DatabaseSync){return db.prepare('SELECT owner_id,attempt_id,wire_id,target_thread_id,state FROM codex_mutation_attempts').get();}
async function cleanup(b:MainNativeMutationBroker,h:ReturnType<typeof harness>){h.advance(4);await b.close();await h.joined;assert.equal(ownedWorkerUsage().Control,0);}

test('mandatory limits, copy reservations, graph minima and timer ceilings are enforced',()=>{
 const limits=validateMutationBrokerLimits(base),r=calculateMutationBrokerReservation(limits);
 assert.equal(r.lifecycleLogicalBytes,6*(2*8192+8192+8*256)+4*(3*16384+32)+16*2048);
 assert.equal(r.lifecycleNodes,6*256+16+256);assert.equal(r.lifecycleEdges,6*256+12+256);
 assert.equal(r.rootLogicalBytes,3*16384);assert.equal(r.rootNodes,192);assert.equal(r.rootEdges,192);
 for(const name of Object.keys(base)){assert.throws(()=>validateMutationBrokerLimits({...base,[name]:0}));}
 for(const name of ['handshakeTimeoutMs','exchangeTimeoutMs','preparedAwaitFinishTimeoutMs','terminalRetentionMs','minStatusIntervalMs'])assert.throws(()=>validateMutationBrokerLimits({...base,[name]:2147483648}));
 for(const name of ['maxRetainedLogicalBytes','maxRetainedNodes','maxRetainedEdges'])assert.throws(()=>validateMutationBrokerLimits({...base,[name]:Number.MAX_SAFE_INTEGER+1}));
 assert.throws(()=>validateMutationBrokerLimits({...base,maxClaimNodes:1}));assert.throws(()=>validateMutationBrokerLimits({...base,maxClaimEdges:1}));assert.throws(()=>validateMutationBrokerLimits({...base,maxClaimUtf8Bytes:1}));
});
test('passive validation rejects proxies, getters, cycles, wide/deep/oversize before cloning',()=>{
 const c={ownerId:'o',generation:1n,attemptId:'a',wire:1n,method:'m',params:null,scoped:false,origin:null};let calls=0;
 assert.throws(()=>captureMutationClaim(new Proxy(c,{get(){calls++;throw Error();}}),base));
 assert.throws(()=>captureMutationClaim({...c,params:Object.defineProperty({},'x',{enumerable:true,get(){calls++;throw Error();}})},base));assert.equal(calls,0);assert.throws(()=>captureMutationClaim({...c,params:1n<<100000n},base));
 const cyclic:any={};cyclic.self=cyclic;assert.throws(()=>captureMutationClaim({...c,params:cyclic},base));
 let deep:any=null;for(let i=0;i<20;i++)deep={x:deep};assert.throws(()=>captureMutationClaim({...c,params:deep},base));
 assert.throws(()=>captureMutationClaim({...c,params:Array(65).fill(null)},base));
 assert.throws(()=>captureMutationClaim({...c,params:'x'.repeat(9000)},base));
 const shared={x:'v'};const captured=captureMutationClaim({...c,params:{a:shared,b:shared}},base);assert.ok(Object.isFrozen(captured));shared.x='changed';assert.equal((captured.params as any).a.x,'v');
 assert.throws(()=>captureMutationClaim({...c,params:new Date()},base));assert.throws(()=>captureMutationClaim({...c,params:[,]},base));
});
test('native raw result only exact passive bounded ok true confirms',()=>{
 assert.equal(validateMutationNativeResult({ok:true},base),true);
 for(const value of [{ok:true,detail:'extra'},{ok:false,detail:'failed'},{ok:1},null,new Proxy({ok:true},{})]){let accepted=false;try{accepted=validateMutationNativeResult(value,base);}catch{}assert.equal(accepted,false);}
 assert.equal(validateMutationReply({version:1,epoch:'a'.repeat(32),exchange:Number.MAX_SAFE_INTEGER,body:{kind:'pending',phase:'finish',beginSequence:Number.MAX_SAFE_INTEGER,closing:false}},'a'.repeat(32))!==null,true);
});
for(const scenario of ['normal','mutate','detach-terminal'])test(`real SQLite begin and one derived completion: ${scenario}`,async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,scenario);
 try{
  await h.event('ready');assert.ok(b.snapshot().lifecycleLogicalBytes>0);assert.equal(b.snapshot().rootLogicalBytes,49152);h.advance(1);
  assert.equal((await h.event('begin')).kind,'accepted');assert.equal((await h.event('begin-result')).kind,'begin-confirmed');
  assert.deepEqual({...row(db)},{owner_id:'resident',attempt_id:'original-attempt',wire_id:'12',target_thread_id:'T',state:'prepared'});
  assert.ok(b.snapshot().lifecycleLogicalBytes>0);h.advance(2);await h.event('begin-ack');assert.ok(b.snapshot().lifecycleLogicalBytes>0);h.advance(3);
  assert.equal((await h.event('terminal')).result,'finish-confirmed');assert.equal(row(db)?.state,'reply_ok');assert.equal(b.snapshot().nativeInvocations,2);assert.ok(b.snapshot().lifecycleLogicalBytes>0);
  h.advance(4);await h.joined;await b.join();assert.equal(b.snapshot().lifecycleLogicalBytes,0);assert.equal(b.snapshot().rootLogicalBytes,0);
 }finally{await cleanup(b,h);}
}));
for(const scenario of ['close','cancel','detach-begin','ttl'])test(`prepared intent survives ${scenario} without synthesized not_sent`,async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',{...base,preparedAwaitFinishTimeoutMs:scenario==='ttl'?100:5000}),h=harness(b,c,scenario);
 try{await h.event('ready');h.advance(1);await h.event('begin-result');h.advance(2);
  if(scenario==='ttl'){const end=Date.now()+waitLimit;while(b.snapshot().state!=='closing'){if(Date.now()>end)throw Error('TTL closure observation deadline');await delay(2);}h.advance(3);await h.event('closed-error');}
  await h.joined;await b.join();assert.equal(row(db)?.state,'prepared');assert.equal(b.snapshot().nativeInvocations,1);
 }finally{await cleanup(b,h);}
}));
test('failed completion is unknown, consumed once, and leaves original row prepared',async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,'normal');
 try{await h.event('ready');h.advance(1);await h.event('begin-result');db.exec("CREATE TRIGGER deny_finish BEFORE UPDATE ON codex_mutation_attempts BEGIN SELECT RAISE(ABORT,'denied'); END");h.advance(2);await h.event('begin-ack');h.advance(3);
  assert.equal((await h.event('terminal')).result,'unknown');assert.equal(row(db)?.state,'prepared');assert.equal(b.snapshot().finishConsumed,true);assert.equal(b.snapshot().nativeInvocations,2);h.advance(4);
 }finally{await cleanup(b,h);}
}));
test('SQL begin rollback stays unknown even with absent row',async()=>fixture(async(path,db,c)=>{
 db.exec("CREATE TRIGGER deny_begin BEFORE INSERT ON codex_mutation_attempts BEGIN SELECT RAISE(ABORT,'denied'); END");
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,'normal');
 try{await h.event('ready');h.advance(1);assert.equal((await h.event('begin-result')).result,'unknown');await h.joined;await b.join();assert.equal(row(db),undefined);assert.equal(b.snapshot().nativeInvocations,1);}finally{await cleanup(b,h);}
}));
for(const scenario of ['raw-normal','raw-injected','raw-foreign'])test(`fixed negative requester wire: ${scenario}`,async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,scenario);
 try{await h.event('ready');h.advance(1);
  if(scenario==='raw-foreign'){await h.event('closed');await b.join();assert.equal(row(db),undefined);assert.equal(b.snapshot().nativeInvocations,0);return;}
  assert.equal((await h.event('duplicate-begin')).reason,'wrong-state');assert.equal((await h.event('early-finish')).reason,'wrong-state');await h.event('begin-result');h.advance(2);
  if(scenario==='raw-injected'){await h.event('closed');await b.join();assert.equal(row(db)?.state,'prepared');assert.equal(b.snapshot().nativeInvocations,1);return;}
  assert.equal((await h.event('repeat-result')).reason,'wrong-state');await h.event('begin-ack');h.advance(3);
  assert.equal((await h.event('duplicate-finish')).reason,'wrong-state');assert.equal((await h.event('terminal')).result,'finish-confirmed');assert.equal(b.snapshot().nativeInvocations,2);h.advance(4);
 }finally{await cleanup(b,h);}
}));
function blockControl(){
 const buffer=new SharedArrayBuffer(16),view=new Int32Array(buffer),slot=new OwnedWorkerSlot('Control');
 const task=slot.run(new URL('../helpers/native-mixed-lane-worker.ts',import.meta.url),{id:'control-blocker',shared:buffer,offered:''},5000);
 void task.catch(()=>undefined);
 return {slot,task,async ready(){const end=Date.now()+5000;while(Atomics.load(view,1)!==1){if(Date.now()>end)throw Error('Control gate deadline');await delay(2);}},async release(){Atomics.store(view,0,1);Atomics.notify(view,0);Atomics.store(view,3,1);Atomics.notify(view,3);await task;await slot.join();}};
}
test('actual occupied Control lane makes invoked begin unknown without a row',async()=>fixture(async(path,db,c)=>{
 const blocker=blockControl();await blocker.ready();const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,'normal');
 try{await h.event('ready');h.advance(1);assert.equal((await h.event('begin-result')).result,'unknown');await h.joined;await b.join();assert.equal(row(db),undefined);assert.equal(b.snapshot().nativeInvocations,1);}
 finally{await blocker.release();await cleanup(b,h);}
}));
test('finish waits original Control FIFO and keeps lifecycle reservation',async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,'normal');let blocker:ReturnType<typeof blockControl>|undefined;
 try{await h.event('ready');h.advance(1);await h.event('begin-result');h.advance(2);await h.event('begin-ack');blocker=blockControl();await blocker.ready();h.advance(3);await h.event('finish');
  assert.equal(row(db)?.state,'prepared');assert.equal(b.snapshot().nativeRetention,true);assert.ok(b.snapshot().lifecycleLogicalBytes>0);assert.equal(ownedWorkerUsage().Control,1);
  await blocker.release();blocker=undefined;assert.equal((await h.event('terminal')).result,'finish-confirmed');h.advance(4);
 }finally{if(blocker)await blocker.release();await cleanup(b,h);}
}));
test('close after native submission with SQLite lock held retains singleton until actual joins',async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,'normal');
 try{await h.event('ready');db.exec('BEGIN IMMEDIATE');h.advance(1);await h.event('begin');
  const closing=b.close();assert.equal(b.snapshot().nativeRetention,true);assert.ok(b.snapshot().lifecycleLogicalBytes>0);assert.throws(()=>createMainNativeMutationBroker(path,'runtime',base),/root retained/);
  db.exec('COMMIT');await closing;assert.equal(b.snapshot().rootLogicalBytes,0);assert.equal(b.snapshot().lifecycleLogicalBytes,0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');await cleanup(b,h);}
}));
for(const scenario of ['lost-begin-ack','lost-finish','lost-terminal-ack'])test(`simulated single correlated observation loss: ${scenario}`,async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',{...base,exchangeTimeoutMs:100}),h=harness(b,c,scenario);
 try{await h.event('ready');h.advance(1);await h.event('begin-result');h.advance(2);
  if(scenario!=='lost-begin-ack'){await h.event('begin-ack');h.advance(3);}
  if(scenario==='lost-terminal-ack'){await h.event('terminal');h.advance(4);}
  await h.event('suppressed');assert.equal((await h.event('loss-error')).name,'OutcomeUnknown');await h.joined;await b.join();
  assert.equal(row(db)?.state,scenario==='lost-begin-ack'?'prepared':'reply_ok');assert.equal(b.snapshot().nativeInvocations,scenario==='lost-begin-ack'?1:2);
 }finally{await cleanup(b,h);}
}));

test('local port close cannot release root before original requester actual exit',async()=>fixture(async(path,db,c)=>{
 const b=createMainNativeMutationBroker(path,'runtime',base),h=harness(b,c,'hold-closed');
 try{await h.event('ready');h.advance(1);await h.event('begin-result');h.advance(2);await h.event('holding-exit');
  assert.equal(b.snapshot().nativeRetention,false);assert.equal(b.snapshot().requesterRetention,true);assert.ok(b.snapshot().lifecycleLogicalBytes>0);assert.ok(b.snapshot().rootLogicalBytes>0);
  assert.throws(()=>createMainNativeMutationBroker(path,'runtime',base),/root retained/);const joined=b.close();assert.equal(b.close(),joined);h.advance(4);await h.joined;await joined;
  assert.equal(b.snapshot().requesterRetention,false);assert.equal(b.snapshot().lifecycleLogicalBytes,0);assert.equal(row(db)?.state,'prepared');
 }finally{await cleanup(b,h);}
}));
