import assert from 'node:assert/strict';
import {it} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {NativeBusyCreateWriter,NativeBusyCreateUnknownError,type BusyCreateWrite} from '../../../src/runtime/action-executor/busy-create-native.ts';
import {captureBusyCreateIngress} from '../../../src/runtime/action-executor/busy-create-snapshot.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage,ownedWorkerModuleUrl} from '../../../src/runtime/owned-worker-slot.ts';
const operation:BusyCreateWrite={ingressKey:'message:9007199254740997',eventId:9007199254740997n,channelId:9007199254740995n,ownerUserId:9007199254740993n,thread:'thread😀',turn:' turn😀 ',job:'job',prompt:'\u2003 원본 😀 \u0085',allowSteer:true,mapped:false,now:123.125};
async function init(path:string){const db=await openInitialized(path);db.close();}
function sql(path:string,query:string){const db=new DatabaseSync(path);try{db.exec(query);}finally{db.close();}}
function rows(path:string){const db=new DatabaseSync(path);try{const choices=db.prepare('SELECT * FROM busy_choices');choices.setReadBigInts(true);return {choices:choices.all().map(r=>({...r})),bindings:db.prepare('SELECT * FROM codex_busy_control_bindings').all().map(r=>({...r}))};}finally{db.close();}}
function original(error:unknown):boolean{return error instanceof NativeBusyCreateUnknownError&&error.ingressKey===operation.ingressKey&&error.eventId===operation.eventId&&error.channelId===operation.channelId&&error.ownerUserId===operation.ownerUserId&&error.targetThreadId===operation.thread&&error.turnId===operation.turn&&error.jobId===operation.job&&/^[a-f0-9]{24}$/.test(error.choiceId);}
it('native creation stores exact bigint actors, Unicode prompt, timestamps, route and original binding',()=>storeFixture(async path=>{
 await init(path);const id=await new NativeBusyCreateWriter(path).execute(operation),r=rows(path);assert.deepEqual(r.choices,[{choice_id:id,owner_user_id:operation.ownerUserId,channel_id:operation.channelId,target_thread_id:operation.thread,prompt:operation.prompt,allow_steer:1n,created_at:123.125,expires_at:1923.125,claimed_at:null,require_current_mirror:0n}]);assert.deepEqual(r.bindings,[{choice_id:id,thread_id:operation.thread,turn_id:operation.turn,job_id:operation.job}]);assert.equal(ownedWorkerUsage().Control,0);
}));
it('original nullable and empty turn/job bindings are not refreshed or normalized',()=>storeFixture(async path=>{
 await init(path);for(const pair of [[null,'job'],['',null],[null,null]] as const){const id=await new NativeBusyCreateWriter(path).execute({...operation,turn:pair[0],job:pair[1]});assert.deepEqual(rows(path).bindings.find(r=>r.choice_id===id),{choice_id:id,thread_id:operation.thread,turn_id:pair[0],job_id:pair[1]});}
}));
it('expiry cleanup and orphan cleanup retain original full predicates',()=>storeFixture(async path=>{
 await init(path);const old=await new NativeBusyCreateWriter(path).execute({...operation,now:1});sql(path,"INSERT INTO codex_busy_control_bindings VALUES ('orphan','foreign',NULL,NULL)");const live=await new NativeBusyCreateWriter(path).execute({...operation,now:1801});const r=rows(path);assert.equal(r.choices.length,1);assert.equal(r.choices[0]!.choice_id,live);assert.equal(r.bindings.length,1);assert.notEqual(live,old);
}));
it('route change rolls back expiry cleanup and creates neither choice nor binding',()=>storeFixture(async path=>{
 await init(path);await new NativeBusyCreateWriter(path).execute({...operation,now:1});sql(path,`INSERT INTO mirror_threads VALUES ('foreign','p','t',${operation.channelId},1,1)`);await assert.rejects(new NativeBusyCreateWriter(path).execute({...operation,now:1801}),original);assert.equal(rows(path).choices.length,1);assert.equal(rows(path).bindings.length,1);
}));
it('missing database or required catalog is never created or repaired',()=>storeFixture(async path=>{
 await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);assert.equal(existsSync(path),false);await init(path);sql(path,'DROP TABLE busy_choices');await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);const db=new DatabaseSync(path);try{assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='busy_choices'").get(),undefined);}finally{db.close();}
}));
it('preabort, malformed input and passive ingress capture refuse before native admission',async t=>storeFixture(async path=>{
 let hooks=0,count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args);});const w=new NativeBusyCreateWriter(path),c=new AbortController(),reason=Error('preabort');c.abort(reason);await assert.rejects(w.execute(operation,c.signal),e=>e===reason);
 const getter={...operation};Object.defineProperty(getter,'prompt',{enumerable:true,get(){hooks++;return 'p';}});
 for(const op of [{...operation,prompt:'a'.repeat(131073)},{...operation,thread:'😀'.repeat(4097)},{...operation,turn:'\ud800'},{...operation,eventId:1n<<63n},{...operation,ownerUserId:-1n},{...operation,now:NaN},{...operation,now:Infinity},{...operation,allowSteer:1},{...operation,mapped:null},{...operation,extra:true},getter,new Proxy(operation,{get(){hooks++;return 1;}})])await assert.rejects(w.execute(op as BusyCreateWrite));await assert.rejects(w.execute(operation,undefined,0));
 const identity={ingressKey:operation.ingressKey,eventId:operation.eventId},captured=captureBusyCreateIngress(identity);identity.ingressKey='foreign';assert.equal(captured.ingressKey,operation.ingressKey);assert.ok(Object.isFrozen(captured));assert.throws(()=>captureBusyCreateIngress({...identity,eventId:1n<<63n}));assert.equal(count,0);assert.equal(hooks,0);assert.equal(existsSync(path),false);
}));
it('fixed path, borrowed owner and invalid signals are refused',()=>storeFixture(async path=>{
 const w=new NativeBusyCreateWriter(path);w.assertPath(path);assert.throws(()=>w.assertPath(path+'.foreign'));assert.throws(()=>NativeBusyCreateWriter.prototype.assertReady.call(Object.create(NativeBusyCreateWriter.prototype)),TypeError);const c=new AbortController();let hooks=0;Object.defineProperty(c.signal,'throwIfAborted',{value:()=>hooks++});await assert.rejects(w.execute(operation,c.signal),TypeError);assert.equal(hooks,0);
}));
it('same owner overlap and global Control saturation refuse without poisoning the unsubmitted owner',()=>storeFixture(async path=>{
 await init(path);const w=new NativeBusyCreateWriter(path),next=new NativeBusyCreateWriter(path),active=w.execute(operation);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(w.execute(operation),OwnedWorkerBusyError);await assert.rejects(next.execute(operation),e=>e instanceof OwnedWorkerBudgetError&&!(e instanceof NativeBusyCreateUnknownError));next.assertReady();await active;await next.execute({...operation,eventId:9n,ingressKey:'next'});assert.equal(rows(path).choices.length,2);assert.equal(ownedWorkerUsage().Control,0);
}));
it('SQLite lock wait stays off-thread; timeout joins actual exit and retains an unknown barrier',async()=>storeFixture(async path=>{
 await init(path);const lock=new DatabaseSync(path),w=new NativeBusyCreateWriter(path);let ticks=0;const timer=setInterval(()=>ticks++,2);lock.exec('BEGIN IMMEDIATE');const pending=w.execute(operation,undefined,1),failed=assert.rejects(pending,original);await new Promise<void>(r=>setTimeout(r,35));assert.ok(ticks>2);assert.equal(ownedWorkerUsage().Control,1);lock.exec('ROLLBACK');lock.close();await failed;clearInterval(timer);assert.equal(ownedWorkerUsage().Control,0);assert.equal(rows(path).choices.length,1);assert.throws(()=>w.assertReady(),original);
}));
it('post-admission abort still finishes both commits and never returns buttons',()=>storeFixture(async path=>{
 await init(path);const c=new AbortController(),w=new NativeBusyCreateWriter(path),pending=w.execute(operation,c.signal),failed=assert.rejects(pending,original);c.abort(Error('shutdown'));assert.equal(ownedWorkerUsage().Control,1);await failed;assert.equal(rows(path).choices.length,1);assert.equal(rows(path).bindings.length,1);assert.equal(ownedWorkerUsage().Control,0);await assert.rejects(w.execute({...operation,ingressKey:'new',eventId:9n}),original);assert.equal(rows(path).choices.length,1);
}));
it('cancellation after actual insertion joins original binding despite caller cancellation',async t=>storeFixture(async path=>{
 await init(path);const gate=new SharedArrayBuffer(8),words=new Int32Array(gate),run=OwnedWorkerSlot.prototype.run;
 const worker=ownedWorkerModuleUrl(new URL('../../../src/runtime/action-executor/busy-create-native-worker.ts',import.meta.url),import.meta.url);
 const source=readFileSync(worker,'utf8').replace(/from ['"]([^'"]+)['"]/g,(all,spec:string)=>spec.startsWith('.')?`from '${new URL(spec,worker).href}'`:all).replace('bindBusyControlExisting(q.path',"Atomics.store(testWords,0,1);Atomics.notify(testWords,0);Atomics.wait(testWords,1,0);bindBusyControlExisting(q.path");
 const fixture=new URL('data:text/javascript,'+encodeURIComponent("import {workerData as testData} from 'node:worker_threads';const testWords=new Int32Array(testData.testGate);delete testData.testGate;\n"+source));
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,data:unknown,timeout:number,signal?:AbortSignal){return run.call(this,fixture,{...(data as object),testGate:gate},timeout,signal);});
 const c=new AbortController(),pending=new NativeBusyCreateWriter(path).execute(operation,c.signal),failed=assert.rejects(pending,original);
 try{for(let tries=0;Atomics.load(words,0)!==1;tries++){assert.ok(tries<1000,'worker reached insert gate');await new Promise<void>(r=>setTimeout(r,2));}assert.equal(rows(path).choices.length,1);assert.equal(rows(path).bindings.length,0);c.abort(Error('after insertion'));await new Promise<void>(r=>setTimeout(r,10));assert.equal(ownedWorkerUsage().Control,1);}finally{Atomics.store(words,1,1);Atomics.notify(words,1);await failed;}assert.equal(rows(path).bindings.length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
for(const phase of ['insert','binding'] as const)it(`${phase} rollback leaves exact separate-transaction state and forbids a fresh retry`,async t=>storeFixture(async path=>{
 await init(path);const table=phase==='insert'?'busy_choices':'codex_busy_control_bindings';sql(path,`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`);let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args);});const w=new NativeBusyCreateWriter(path);let unknown:unknown;try{await w.execute(operation);assert.fail('must fail');}catch(e){unknown=e;assert.ok(original(e));}assert.equal(rows(path).choices.length,phase==='insert'?0:1);assert.equal(rows(path).bindings.length,0);sql(path,'DROP TRIGGER fail_write');await assert.rejects(w.execute(operation),e=>e===unknown);assert.equal(count,1);
}));
for(const phase of ['insert','binding'] as const)it(`${phase} ignored write is never acknowledged as a complete choice`,()=>storeFixture(async path=>{
 await init(path);sql(path,`CREATE TRIGGER ignore_write BEFORE INSERT ON ${phase==='insert'?'busy_choices':'codex_busy_control_bindings'} BEGIN SELECT RAISE(IGNORE); END`);await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);assert.equal(rows(path).choices.length,phase==='insert'?0:1);assert.equal(rows(path).bindings.length,0);
}));
it('lost committed ACK and lost rollback ACK keep one original choice identity with no duplicate writes',async t=>storeFixture(async path=>{
 await init(path);let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args).then(()=>{throw Error('ACK lost');});});
 for(const fail of [false,true]){if(fail)sql(path,"CREATE TRIGGER fail_insert BEFORE INSERT ON busy_choices BEGIN SELECT RAISE(ABORT,'fixture'); END");const w=new NativeBusyCreateWriter(path);let unknown:unknown;try{await w.execute(operation);}catch(e){unknown=e;}assert.ok(original(unknown));await assert.rejects(w.execute({...operation,ingressKey:'later',eventId:9n}),e=>e===unknown);assert.equal(rows(path).choices.length,1);}assert.equal(count,2);assert.equal(rows(path).bindings.length,1);
}));
it('every crossed identity, prompt digest, route or timestamp ACK fails closed',async t=>storeFixture(async path=>{
 await init(path);let transform=(v:any):unknown=>v;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return run.apply(this,args).then(transform);});
 for(const key of ['id','path','operation','choiceId','ingressKey','eventId','channelId','ownerUserId','thread','turn','job','allowSteer','mapped','now','expiresAt','promptDigest']){transform=v=>({...v,[key]:'crossed'});await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);}
 for(const bad of [(v:any)=>({...v,extra:true}),(v:any)=>({...v,ok:false}),(v:any)=>({...v,promptDigest:'a'.repeat(262145)}),()=>null]){transform=bad;await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);}assert.equal(ownedWorkerUsage().Control,0);
}));
it('input mutation and suppressed source abort cannot redirect or confirm the original write',()=>storeFixture(async path=>{
 await init(path);const input={...operation},c=new AbortController();c.signal.addEventListener('abort',e=>e.stopImmediatePropagation());const pending=new NativeBusyCreateWriter(path).execute(input,c.signal),failed=assert.rejects(pending,original);input.thread='foreign';input.prompt='changed';input.turn='later';input.now=999;c.abort(Error('suppressed abort'));await failed;const r=rows(path);assert.equal(r.choices[0]!.prompt,operation.prompt);assert.equal(r.choices[0]!.created_at,operation.now);assert.equal(r.bindings[0]!.turn_id,operation.turn);assert.equal(ownedWorkerUsage().Control,0);
}));
it('synchronous submission-return failure joins the live native worker and records unknown',async t=>storeFixture(async path=>{
 await init(path);let joined=false;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){void run.apply(this,args).then(()=>{joined=true;},()=>{joined=true;});throw Error('submission return lost');});await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);assert.equal(joined,true);assert.equal(rows(path).bindings.length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
for(const effect of ["DELETE FROM busy_choices WHERE choice_id=NEW.choice_id","UPDATE busy_choices SET prompt='changed' WHERE choice_id=NEW.choice_id"])it(`binding-trigger choice mutation is rolled back instead of confirming a stale choice: ${effect.slice(0,6)}`,()=>storeFixture(async path=>{
 await init(path);sql(path,`CREATE TRIGGER mutate_choice AFTER INSERT ON codex_busy_control_bindings BEGIN ${effect}; END`);await assert.rejects(new NativeBusyCreateWriter(path).execute(operation),original);const r=rows(path);assert.equal(r.choices.length,1);assert.equal(r.choices[0]!.prompt,operation.prompt);assert.equal(r.bindings.length,0);
}));
import {BusyResultProducer} from '../../../src/runtime/action-executor/busy-result.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {QueueReadCoordinator} from '../../../src/runtime/queue-runner/read-coordinator.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ActionIntegerRangeError} from '../../../src/runtime/action-executor/errors.ts';
it('BusyResult preserves original actor-range validation before sampling its clock',()=>storeFixture(async path=>{
 const locks=new TargetLocks(),verifier=new ControlTurnVerifier(path,null,{selectedThreadId:()=> 'thread'},locks),reads=new QueueReadCoordinator(path,{activeTurnId:async()=>null});let clocks=0;const producer=new BusyResultProducer(path,verifier,reads,()=>{clocks++;return 100;});
 for(const [channel,user] of [[1n,1n<<63n],[1n<<63n,2n],[1n,-1n]])await assert.rejects(producer.busyResult('thread',channel!,user!,'prompt',false,false),ActionIntegerRangeError);assert.equal(clocks,0);assert.equal(locks.activeTargetCount,0);
}));
