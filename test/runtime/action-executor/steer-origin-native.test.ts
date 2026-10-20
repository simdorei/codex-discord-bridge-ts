import assert from 'node:assert/strict';
import {it} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {userOriginMarker} from '../../../src/store/mirror-origin.ts';
import {NativeSteerOriginWriter,NativeSteerOriginUnknownError,type SteerOriginWrite} from '../../../src/runtime/action-executor/steer-origin-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const operation:SteerOriginWrite={ingressKey:'message:9007199254740997',eventId:9007199254740997n,channelId:9007199254740995n,ownerUserId:9007199254740993n,thread:'thread😀',turn:'turn',generation:9007199254740999n,prompt:'\u2003 원본 😀 \u0085',now:123};
async function init(path:string){const db=await openInitialized(path);db.close();}
function rows(path:string){const db=new DatabaseSync(path);try{return db.prepare('SELECT event_digest,codex_thread_id,created_at FROM codex_session_mirror_events').all().map(r=>({...r}));}finally{db.close();}}
function original(error:unknown):boolean{return error instanceof NativeSteerOriginUnknownError&&error.ingressKey===operation.ingressKey&&error.eventId===operation.eventId&&error.channelId===operation.channelId&&error.ownerUserId===operation.ownerUserId&&error.targetThreadId===operation.thread&&error.turnId===operation.turn&&error.generation===operation.generation&&error.marker===userOriginMarker(operation.thread,operation.turn,operation.prompt);}
it('native origin commits exact original Unicode marker and preserves first-custody timestamp',()=>storeFixture(async path=>{
 await init(path);const w=new NativeSteerOriginWriter(path);await w.execute(operation);assert.equal(ownedWorkerUsage().Control,0);await w.execute({...operation,now:999});assert.deepEqual(rows(path),[{event_digest:userOriginMarker(operation.thread,operation.turn,operation.prompt),codex_thread_id:operation.thread,created_at:123}]);
}));
it('missing runtime store is never created and returns bound uncertainty',()=>storeFixture(async path=>{
 await assert.rejects(new NativeSteerOriginWriter(path).execute(operation),original);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
it('owner is fixed to its original database and rejects borrowed owners',()=>storeFixture(async path=>{
 const w=new NativeSteerOriginWriter(path);w.assertPath(path);assert.throws(()=>w.assertPath(path+'.foreign'),/another database/);assert.throws(()=>NativeSteerOriginWriter.prototype.assertPath.call(Object.create(NativeSteerOriginWriter.prototype),path),TypeError);
}));
it('preabort preserves exact cancellation and never submits a native worker',async t=>storeFixture(async path=>{
 const c=new AbortController(),reason=new Error('preabort');c.abort(reason);let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args);});await assert.rejects(new NativeSteerOriginWriter(path).execute(operation,c.signal),e=>e===reason);assert.equal(count,0);assert.equal(existsSync(path),false);
}));
it('malformed and over-budget inputs reject before worker admission without caller getters',async t=>storeFixture(async path=>{
 let hooks=0,count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args);});const w=new NativeSteerOriginWriter(path),getter={...operation};Object.defineProperty(getter,'prompt',{enumerable:true,get(){hooks++;return 'p';}});
 for(const op of [{...operation,prompt:'a'.repeat(65537)},{...operation,prompt:'😀'.repeat(16385)},{...operation,thread:'a'.repeat(16385)},{...operation,turn:'\ud800'},{...operation,ingressKey:''},{...operation,eventId:1n<<63n},{...operation,ownerUserId:-1n},{...operation,generation:1n<<64n},{...operation,now:NaN},{...operation,now:Infinity},{...operation,extra:true},getter,new Proxy(operation,{get(){hooks++;throw Error('caller hook');}})])await assert.rejects(w.execute(op as SteerOriginWrite));await assert.rejects(w.execute(operation,undefined,0));assert.equal(count,0);assert.equal(hooks,0);assert.equal(existsSync(path),false);
}));
it('same owner overlap and global Control saturation refuse without admission or origin replay',()=>storeFixture(async path=>{
 await init(path);const w=new NativeSteerOriginWriter(path),pending=w.execute(operation);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(w.execute(operation),OwnedWorkerBusyError);await assert.rejects(new NativeSteerOriginWriter(path).execute(operation),e=>e instanceof OwnedWorkerBudgetError&&!(e instanceof NativeSteerOriginUnknownError));await pending;assert.equal(rows(path).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
it('locked SQLite leaves event loop alive and releases Control only after real exit',()=>storeFixture(async path=>{
 await init(path);const db=new DatabaseSync(path);let ticks=0;const timer=setInterval(()=>ticks++,2);try{db.exec('BEGIN IMMEDIATE');await assert.rejects(new NativeSteerOriginWriter(path).execute(operation),original);assert.ok(ticks>2);assert.equal(db.isTransaction,true);assert.equal(rows(path).length,0);}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');db.close();}assert.equal(ownedWorkerUsage().Control,0);await new NativeSteerOriginWriter(path).execute({...operation,ingressKey:'message:new',eventId:6n});assert.equal(rows(path).length,1);
}));
it('post-admission abort joins the original writer, retaining exact identity and ignoring late success',()=>storeFixture(async path=>{
 await init(path);const c=new AbortController(),pending=new NativeSteerOriginWriter(path).execute(operation,c.signal),failed=assert.rejects(pending,original);assert.equal(ownedWorkerUsage().Control,1);c.abort(new Error('post-admission'));assert.equal(ownedWorkerUsage().Control,1);await failed;assert.equal(ownedWorkerUsage().Control,0);assert.equal(rows(path).length,1);
}));
it('deadline and lost committed reply each submit once, join native exit and never replay',async t=>storeFixture(async path=>{
 await init(path);let count=0,lose=false;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args).then(value=>{if(lose)throw Error('lost ACK');return value;});});await assert.rejects(new NativeSteerOriginWriter(path).execute(operation,undefined,1),original);assert.equal(count,1);assert.equal(rows(path).length,1);lose=true;await assert.rejects(new NativeSteerOriginWriter(path).execute({...operation,turn:'next'}),NativeSteerOriginUnknownError);assert.equal(count,2);assert.equal(rows(path).length,2);assert.equal(ownedWorkerUsage().Control,0);
}));
it('crossed binding, malformed and oversized acknowledgements never confirm origin',async t=>storeFixture(async path=>{
 await init(path);const run=OwnedWorkerSlot.prototype.run;let transform=(v:any):unknown=>v;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return run.apply(this,args).then(transform);});
 for(const key of ['id','path','operation','ingressKey','eventId','channelId','ownerUserId','thread','turn','generation','now','marker']){transform=v=>({...v,[key]:'crossed'});await assert.rejects(new NativeSteerOriginWriter(path).execute(operation),original);}
 for(const bad of [(v:any)=>({...v,extra:true}),(v:any)=>({...v,ok:false}),(v:any)=>({...v,marker:'a'.repeat(262145)}),()=>null]){transform=bad;await assert.rejects(new NativeSteerOriginWriter(path).execute(operation),original);}assert.equal(rows(path).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
it('input mutation after admission cannot redirect the original marker',()=>storeFixture(async path=>{
 await init(path);const input={...operation},pending=new NativeSteerOriginWriter(path).execute(input);input.prompt='changed';input.thread='foreign';input.turn='later';input.ingressKey='foreign';await pending;assert.equal(rows(path)[0]!.event_digest,userOriginMarker(operation.thread,operation.turn,operation.prompt));
}));
it('synchronous submission-return failure still joins the native write before releasing custody',async t=>storeFixture(async path=>{
 await init(path);const run=OwnedWorkerSlot.prototype.run;let joined=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){void run.apply(this,args).then(()=>{joined=true;},()=>{joined=true;});throw Error('submission return lost');});await assert.rejects(new NativeSteerOriginWriter(path).execute(operation),original);assert.equal(joined,true);assert.equal(ownedWorkerUsage().Control,0);assert.equal(rows(path).length,1);
}));
it('caller signal hooks never run and suppressed cancellation is detected after real join',async t=>storeFixture(async path=>{
 await init(path);const c=new AbortController();c.signal.addEventListener('abort',e=>e.stopImmediatePropagation());const pending=new NativeSteerOriginWriter(path).execute(operation,c.signal),failed=assert.rejects(pending,original);c.abort(new Error('suppressed source'));await failed;assert.equal(ownedWorkerUsage().Control,0);
 const next=new AbortController(),work=new NativeSteerOriginWriter(path).execute(operation,next.signal),invalid=assert.rejects(work,original);let hooks=0;Object.defineProperty(next.signal,'removeEventListener',{value:()=>{hooks++;throw Error('caller hook');}});await invalid;assert.equal(hooks,0);assert.equal(ownedWorkerUsage().Control,0);
}));
it('one unresolved original blocks later writes with the same bound error and no replay',async t=>storeFixture(async path=>{
 await init(path);let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args).then(()=>{throw Error('ACK lost');});});const writer=new NativeSteerOriginWriter(path);let unknown:unknown;try{await writer.execute(operation);assert.fail('expected unknown');}catch(error){unknown=error;assert.ok(original(error));}assert.throws(()=>writer.assertReady(),e=>e===unknown);await assert.rejects(writer.execute({...operation,turn:'later',ingressKey:'next'}),e=>e===unknown);assert.equal(count,1);assert.equal(rows(path).length,1);
}));
import {captureSteerOriginAdmission} from '../../../src/runtime/action-executor/steer-origin-snapshot.ts';
it('original admission identity is bounded and captured before target-selection awaits without hooks',()=>{
 const input={ingressKey:operation.ingressKey,eventId:operation.eventId,ownerUserId:operation.ownerUserId},captured=captureSteerOriginAdmission(input);input.ingressKey='foreign';input.eventId=8n;input.ownerUserId=9n;assert.equal(captured.ingressKey,operation.ingressKey);assert.equal(captured.eventId,operation.eventId);assert.equal(captured.ownerUserId,operation.ownerUserId);assert.ok(Object.isFrozen(captured));let hooks=0;const getter={...input};Object.defineProperty(getter,'ingressKey',{enumerable:true,get(){hooks++;return 'hook';}});for(const bad of [{...input,extra:true},{...input,ingressKey:'a'.repeat(16385)},{...input,ownerUserId:1n<<63n},getter,new Proxy(input,{get(){hooks++;return 'hook';}})])assert.throws(()=>captureSteerOriginAdmission(bad));assert.equal(hooks,0);
});
it('pre-submission capacity refusal leaves the same native owner usable after release',()=>storeFixture(async path=>{
 await init(path);const first=new NativeSteerOriginWriter(path),next=new NativeSteerOriginWriter(path),active=first.execute(operation);await assert.rejects(next.execute({...operation,turn:'next'}),OwnedWorkerBudgetError);next.assertReady();await active;await next.execute({...operation,turn:'next'});assert.equal(rows(path).length,2);
}));
it('rolled-back ACK loss creates the same unresolved barrier and does not retry the original write',async t=>storeFixture(async path=>{
 await init(path);const db=new DatabaseSync(path);db.exec("CREATE TRIGGER origin_failure BEFORE INSERT ON codex_session_mirror_events BEGIN SELECT RAISE(ABORT,'rollback fixture'); END");db.close();let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){count++;return run.apply(this,args).then(()=>{throw Error('lost rollback ACK');});});const w=new NativeSteerOriginWriter(path);let unknown:unknown;try{await w.execute(operation);}catch(error){unknown=error;}assert.ok(original(unknown));await assert.rejects(w.execute(operation),e=>e===unknown);assert.equal(count,1);assert.equal(rows(path).length,0);assert.equal(ownedWorkerUsage().Control,0);
}));
