import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {NativeStandardClaimOwner,NativeStandardClaimUnknownError,type NativeStandardClaim} from '../../../src/runtime/component-worker/standard-claim-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {parseComponentId} from '../../../src/discord/components.ts';
import {routedComponentCustomId} from '../../../src/discord/interaction-routing.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {work} from '../../helpers/interaction-worker-fixture.ts';
const custom=`codex_approval:v2:${'a'.repeat(16)}:${'b'.repeat(32)}:1`,component=parseComponentId(custom)!;
const click=(path:string,id=3n,raw=custom)=>work(path,id,new AdmissionGate(),raw);
async function initialize(path:string){const db=await openInitialized(path);db.close();}
function rows(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT claim_key,created_at,expires_at FROM persistent_component_claims ORDER BY claim_key').all();}finally{db.close();}}
async function held(owner:NativeStandardClaimOwner,path:string):Promise<NativeStandardClaim>{const w=click(path);try{const result=await owner.claim(w,component,100);assert.equal(result.kind,'ExecuteAction');if(result.kind!=='ExecuteAction')throw Error('claim fixture');return result.claim;}finally{w.admissionPermit!.release();}}
const isWorker=(url:URL)=>String(url).endsWith('/standard-claim-native-worker.ts');
test('native standard claim captures exact routed custom ID and original click; canonical duplicate has no new handle',async t=>storeFixture(async path=>{
 await initialize(path);const owner=new NativeStandardClaimOwner(path),w=click(path),ops:any[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isWorker(args[0]))ops.push(args[1]);return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(isWorker(args[0]))ops.push(args[1]);return complete.apply(this,args);});
 try{const mutable={...w},firstPromise=owner.claim(mutable,component,100);mutable.userId=88n;mutable.custodyIngressId='interaction:999';const first=await firstPromise;assert.equal(first.kind,'ExecuteAction');if(first.kind!=='ExecuteAction')throw Error();assert.ok(Object.isFrozen(first.claim));
  assert.equal(routedComponentCustomId(w.work),custom);assert.throws(()=>routedComponentCustomId({...w.work}),TypeError);
  const duplicate=click(path,4n,custom.slice(0,-1)+'3');try{assert.deepEqual(await owner.claim(duplicate,parseComponentId(custom.slice(0,-1)+'3')!,101),{kind:'ActionUnconfirmed'});await owner.ready(first.claim,102);assert.deepEqual(await owner.claim(duplicate,parseComponentId(custom.slice(0,-1)+'3')!,103),{kind:'DeliverConfirmation'});}finally{duplicate.admissionPermit!.release();}
  assert.deepEqual(ops.map(x=>x.operation),['Claim','Claim','Ready','Claim']);assert.equal(ops[0].interactionIngressId,'interaction:3');assert.equal(ops[0].interactionId,3n);assert.equal(ops[0].applicationId,4n);assert.equal(ops[0].actorId,2n);assert.equal(ops[0].channelId,1n);assert.equal(ops[0].sourceMessageId,9n);assert.equal(ops[0].customId,custom);assert.equal(rows(path).length,2);
 }finally{w.admissionPermit!.release();await owner.close();assert.equal(ownedWorkerUsage().Control,0);}
}));
test('copied, forged, cross-owner and consumed claim handles cannot write ready or release',async()=>storeFixture(async path=>{
 await initialize(path);const a=new NativeStandardClaimOwner(path),b=new NativeStandardClaimOwner(path);try{const c=await held(a,path);
  for(const fake of [{...c},Object.create(Object.getPrototypeOf(c)),{}]){assert.throws(()=>a.ready(fake,101),TypeError);assert.throws(()=>a.release(fake),TypeError);}
  assert.throws(()=>b.ready(c,101),TypeError);assert.throws(()=>b.release(c),TypeError);assert.equal(rows(path).length,1);await a.release(c);assert.equal(rows(path).length,0);assert.throws(()=>a.ready(c,101),TypeError);assert.throws(()=>a.release(c),TypeError);
 }finally{await a.close();await b.close();}
}));
test('crossed database/ingress/component, copied route and nonstandard custom IDs fail before worker admission',async t=>storeFixture(async path=>{
 const a=new NativeStandardClaimOwner(path),w=click(path);let submitted=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){submitted++;return run.apply(this,args);});
 try{for(const changed of [{...w,custodyDatabase:path+'-other'},{...w,custodyIngressId:'interaction:99'},{...w,sourceMessageId:null},{...w,work:{...w.work}},{...w,processingMode:'ConfirmationOnly' as const}])await assert.rejects(a.claim(changed,component,100),TypeError);
  await assert.rejects(a.claim(w,parseComponentId(custom.slice(0,-1)+'3')!,100),TypeError);assert.throws(()=>a.requireDatabase(path+'-other'),TypeError);
  const legacy=click(path,8n,'codex_approval:t:1');try{assert.ok('Component'in legacy.work);await assert.rejects(a.claim(legacy,legacy.work.Component,100),TypeError);}finally{legacy.admissionPermit!.release();}
  for(const n of [NaN,Infinity,-1])await assert.rejects(a.claim(w,component,n),TypeError);assert.equal(submitted,0);assert.equal(existsSync(path),false);
 }finally{w.admissionPermit!.release();await a.close();}
}));
test('missing database and missing catalog remain missing and never initialize or repair',async()=>storeFixture(async path=>{
 for(const empty of [false,true]){if(empty)new DatabaseSync(path).close();const a=new NativeStandardClaimOwner(path),w=click(path);try{await assert.rejects(a.claim(w,component,100),NativeStandardClaimUnknownError);assert.equal(existsSync(path),empty);if(empty){const db=new DatabaseSync(path);try{assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(),[]);}finally{db.close();}}}finally{w.admissionPermit!.release();await a.close();}}
}));
test('failed claim insertion rolls back cleanup; same owner cannot fresh-claim after rollback or TTL',async()=>storeFixture(async path=>{
 await state.claimComponent(path,'expired',0,1);const db=new DatabaseSync(path);db.exec("CREATE TRIGGER refuse_claim BEFORE INSERT ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'offline fixture'); END");db.close();const a=new NativeStandardClaimOwner(path),w=click(path);
 try{await assert.rejects(a.claim(w,component,100),NativeStandardClaimUnknownError);assert.deepEqual(rows(path).map(x=>x.claim_key),['expired']);const edit=new DatabaseSync(path);edit.exec('DROP TRIGGER refuse_claim');edit.close();assert.deepEqual(await a.claim(w,component,10000),{kind:'ActionUnconfirmed'});assert.deepEqual(rows(path).map(x=>x.claim_key),['expired']);const other={...w,userId:7n};await assert.rejects(a.claim(other,component,10000),NativeStandardClaimUnknownError);}finally{w.admissionPermit!.release();await a.close();}
}));
test('lost committed Claim ACK is held; explicit original recovery is read-only even after expiry',async t=>storeFixture(async path=>{
 await initialize(path);const run=OwnedWorkerSlot.prototype.run,ops:string[]=[];t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(isWorker(args[0])){const q=args[1] as any;ops.push(q.operation);if(q.operation==='Claim')return task.then(()=>{throw Error('lost original ACK');});}return task;});
 const a=new NativeStandardClaimOwner(path),w=click(path);try{await assert.rejects(a.claim(w,component,100),NativeStandardClaimUnknownError);assert.equal(rows(path).length,1);assert.deepEqual(await a.claim(w,component,10000),{kind:'ActionUnconfirmed'});assert.deepEqual(ops,['Claim','RecoverReady']);assert.equal(rows(path)[0]!.created_at,100);}finally{w.admissionPermit!.release();await a.close();}
}));
for(const key of ['id','path','interactionIngressId','interactionId','applicationId','actorId','channelId','sourceMessageId','customId','actionClaim','readyMarker','operation','now','expiresAt'] as const)test(`crossed native ${key} acknowledgement mints no claim and cannot release`,async t=>storeFixture(async path=>{
 await initialize(path);const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);return isWorker(args[0])?task.then(raw=>({...raw as any,[key]:typeof (raw as any)[key]==='bigint'?99n:'crossed'})):task;});
 const a=new NativeStandardClaimOwner(path),w=click(path);try{await assert.rejects(a.claim(w,component,100),NativeStandardClaimUnknownError);assert.equal(rows(path).length,1);assert.throws(()=>a.release({actionClaim:String(rows(path)[0]!.claim_key),readyMarker:'copied'}),TypeError);}finally{w.admissionPermit!.release();await a.close();}
}));
for(const operation of ['Ready','Release'] as const)test(`lost ${operation} ACK cannot repeat a completion; only original ready read remains allowed`,async t=>storeFixture(async path=>{
 await initialize(path);const a=new NativeStandardClaimOwner(path),c=await held(a,path),complete=OwnedWorkerSlot.prototype.runControlCompletion;t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){const task=complete.apply(this,args);return isWorker(args[0])?task.then(()=>{throw Error('lost completion ACK');}):task;});
 const w=click(path,5n);try{await assert.rejects(operation==='Ready'?a.ready(c,101):a.release(c),NativeStandardClaimUnknownError);assert.throws(()=>a.ready(c,102),TypeError);assert.throws(()=>a.release(c),TypeError);assert.deepEqual(await a.claim(w,component,102),{kind:operation==='Ready'?'DeliverConfirmation':'ActionUnconfirmed'});assert.equal(rows(path).length,operation==='Ready'?2:0);if(operation==='Release')assert.deepEqual(await a.claim(w,component,10000),{kind:'ActionUnconfirmed'});}finally{w.admissionPermit!.release();await a.close();}
}));
for(const operation of ['Ready','Release'] as const)test(`${operation} SQL failure retains original action and has no automatic retry`,async()=>storeFixture(async path=>{
 await initialize(path);const a=new NativeStandardClaimOwner(path),c=await held(a,path),db=new DatabaseSync(path);db.exec(operation==='Ready'?"CREATE TRIGGER refuse_ready BEFORE INSERT ON persistent_component_claims WHEN NEW.claim_key LIKE 'confirmation-ready:%' BEGIN SELECT RAISE(ABORT,'fixture'); END":"CREATE TRIGGER refuse_release BEFORE DELETE ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();const w=click(path);try{await assert.rejects(operation==='Ready'?a.ready(c,101):a.release(c),NativeStandardClaimUnknownError);assert.deepEqual(rows(path).map(x=>x.claim_key),[c.actionClaim]);assert.deepEqual(await a.claim(w,component,102),{kind:'ActionUnconfirmed'});}finally{w.admissionPermit!.release();await a.close();}
}));
test('pre-cancelled original never submits or creates a database',async()=>storeFixture(async path=>{
 const a=new NativeStandardClaimOwner(path),w=click(path),c=new AbortController(),reason=Error('cancelled');c.abort(reason);try{await assert.rejects(a.claim(w,component,100,c.signal),e=>e===reason);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);}finally{w.admissionPermit!.release();await a.close();}
}));
for(const mode of ['deadline','cancel'] as const)test(`Claim ${mode} retains Control and caller ownership until actual locked native exit`,async t=>storeFixture(async path=>{
 const run=OwnedWorkerSlot.prototype.run;if(mode==='deadline')t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return isWorker(args[0])&&(args[1] as any).operation==='Claim'?run.call(this,args[0],args[1],30,args[3]):run.apply(this,args);});
 await initialize(path);const a=new NativeStandardClaimOwner(path),w=click(path),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const controller=new AbortController();let settled=false,ticks=0;const timer=setInterval(()=>ticks++,5),task=a.claim(w,component,100,controller.signal),failed=assert.rejects(task,NativeStandardClaimUnknownError);void task.then(()=>settled=true,()=>settled=true);
 try{await new Promise(r=>setTimeout(r,100));if(mode==='cancel')controller.abort(Error('cancel original'));await new Promise(r=>setTimeout(r,70));assert.equal(settled,false);assert.equal(a.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);db.exec('ROLLBACK');await failed;assert.equal(ownedWorkerUsage().Control,0);assert.equal(a.busy,false);assert.equal(rows(path).length,1);assert.deepEqual(await a.claim(w,component,101),{kind:'ActionUnconfirmed'});}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});await a.close();db.close();w.admissionPermit!.release();}
}));
test('Control saturation refuses new claim without enqueue; original Ready waits in the existing completion FIFO',async()=>storeFixture(async path=>{
 await initialize(path);const a=new NativeStandardClaimOwner(path),heldClaim=await held(a,path),b=new NativeStandardClaimOwner(path),c=new NativeStandardClaimOwner(path),blocked={...click(path,5n),userId:7n},third={...click(path,6n),userId:8n},db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const pending=b.claim(blocked,component,100);let ready=false;const completion=a.ready(heldClaim,101).then(()=>{ready=true;});
 try{await assert.rejects(c.claim(third,component,100),OwnedWorkerBudgetError);await new Promise(r=>setTimeout(r,100));assert.equal(ready,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await pending;await completion;assert.equal(rows(path).length,3);const later=await c.claim(third,component,102);assert.equal(later.kind,'ExecuteAction');}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([pending,completion]);await Promise.all([a.close(),b.close(),c.close()]);db.close();blocked.admissionPermit!.release();third.admissionPermit!.release();}
}));
for(const operation of ['Ready','Release'] as const)test(`same-owner ${operation} completion queues behind its other in-flight claim and joins both workers`,async()=>storeFixture(async path=>{
 await initialize(path);const owner=new NativeStandardClaimOwner(path),first=await held(owner,path),second={...click(path,4n),userId:7n},db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const claim=owner.claim(second,component,100);let finished=false;const completion=(operation==='Ready'?owner.ready(first,101):owner.release(first)).then(()=>{finished=true;});
 try{await new Promise(r=>setTimeout(r,100));assert.equal(finished,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');assert.equal((await claim).kind,'ExecuteAction');await completion;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(rows(path).length,operation==='Ready'?3:1);assert.throws(()=>owner.release(first),TypeError);}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([claim,completion]);await owner.close();db.close();second.admissionPermit!.release();}
}));
test('same original unknown claim cannot recover through another application identity',async t=>storeFixture(async path=>{
 await initialize(path);const run=OwnedWorkerSlot.prototype.run;let count=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(isWorker(args[0])){count++;return task.then(()=>{throw Error('lost ACK');});}return task;});const a=new NativeStandardClaimOwner(path),w=click(path);try{await assert.rejects(a.claim(w,component,100),NativeStandardClaimUnknownError);await assert.rejects(a.claim({...w,applicationId:8n},component,101),NativeStandardClaimUnknownError);assert.equal(count,1);}finally{w.admissionPermit!.release();await a.close();}
}));
test('closing during Ready cancellation joins late commit and never releases original action claim',async()=>storeFixture(async path=>{
 await initialize(path);const owner=new NativeStandardClaimOwner(path),c=await held(owner,path),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');let finished=false,closed=false;const ready=owner.ready(c,101),failed=assert.rejects(ready,NativeStandardClaimUnknownError);void ready.then(()=>finished=true,()=>finished=true);await new Promise(r=>setTimeout(r,30));const close=owner.close().then(()=>{closed=true;});
 try{await new Promise(r=>setTimeout(r,150));assert.equal(finished,false);assert.equal(closed,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await failed;await close;assert.equal(rows(path).length,2);assert.equal(ownedWorkerUsage().Control,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([ready,close]);db.close();}
}));
test('known synchronous invalid Ready input preserves original handle for the valid completion',async()=>storeFixture(async path=>{
 await initialize(path);const owner=new NativeStandardClaimOwner(path);try{const c=await held(owner,path);assert.throws(()=>owner.ready(c,NaN),TypeError);await owner.ready(c,101);assert.equal(rows(path).length,2);}finally{await owner.close();}
}));
