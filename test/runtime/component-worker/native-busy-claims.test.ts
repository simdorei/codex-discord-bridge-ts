import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {NativeBusyClaimOwner,NativeBusyClaimUnknownError,type NativeBusyClaim} from '../../../src/runtime/component-worker/busy-claim-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice,getBusyChoice,readBusyChoiceStateExisting,claimBusyChoiceExisting,releaseBusyChoiceClaimExisting} from '../../../src/store/busy-choice-store.ts';
import {serializeBusyChoice,type BusyChoice} from '../../../src/store/busy-choice.ts';
import {parseComponentId,type BusyAction} from '../../../src/discord/components.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {work} from '../../helpers/interaction-worker-fixture.ts';
import {busyReadyMarker} from '../../../src/runtime/component-worker/confirmation.ts';
const saved=():BusyChoice=>({choiceId:'a'.repeat(24),ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt:'original 😀',allowSteer:false,createdAt:1,expiresAt:101});
const raw=(c:BusyChoice,action:BusyAction='Ignore')=>`codex_busy:${c.choiceId}:${action.toLowerCase()}`;
const component=(c:BusyChoice,action:BusyAction='Ignore')=>parseComponentId(raw(c,action))!;
const click=(path:string,c:BusyChoice,id=3n,action:BusyAction='Ignore',custom=raw(c,action))=>({...work(path,id,new AdmissionGate(),custom),authorizedBusyChoice:c});
async function choice(path:string){const c=saved(),id=await createBusyChoice(path,{...c,now:c.createdAt,timeToLive:100});return (await getBusyChoice(path,id,2))!;}
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
function rows(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return {busy:db.prepare('SELECT choice_id,prompt,claimed_at,expires_at FROM busy_choices ORDER BY choice_id').all(),ready:db.prepare('SELECT claim_key,created_at,expires_at FROM persistent_component_claims ORDER BY claim_key').all()};}finally{db.close();}}
async function held(owner:NativeBusyClaimOwner,path:string,c:BusyChoice):Promise<NativeBusyClaim>{const w=click(path,c);try{const result=await owner.claim(w,component(c),2);assert.equal(result.kind,'ExecuteAction');if(result.kind!=='ExecuteAction')throw Error('claim fixture');return result.claim;}finally{w.admissionPermit!.release();}}
const isWorker=(url:URL)=>String(url).endsWith('/busy-claim-native-worker.ts');
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

test('native Busy captures original exact click, raw custom ID and pre-ACK choice before await; ready precedes duplicate claim',async t=>storeFixture(async path=>{
 const c=await choice(path),owner=new NativeBusyClaimOwner(path),w=click(path,c,3n,'Ignore',raw(c)+' '),ops:any[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isWorker(args[0]))ops.push(args[1]);return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(isWorker(args[0]))ops.push(args[1]);return complete.apply(this,args);});
 try{const mutable={...w,authorizedBusyChoice:{...c}},pending=owner.claim(mutable,component(c),2);mutable.userId=7n;mutable.authorizedBusyChoice.prompt='changed';const first=await pending;assert.equal(first.kind,'ExecuteAction');if(first.kind!=='ExecuteAction')throw Error();assert.ok(Object.isFrozen(first.claim));
  assert.deepEqual(await owner.claim(w,component(c),3),{kind:'ActionUnconfirmed'});await owner.ready(first.claim,4);edit(path,'DELETE FROM busy_choices');assert.deepEqual(await owner.claim(w,component(c),5),{kind:'DeliverConfirmation'});
  assert.deepEqual(ops.map(x=>x.operation),['Claim','Claim','Ready','Claim']);assert.equal(ops[0].interactionIngressId,'interaction:3');assert.equal(ops[0].interactionId,3n);assert.equal(ops[0].applicationId,4n);assert.equal(ops[0].actorId,2n);assert.equal(ops[0].channelId,1n);assert.equal(ops[0].sourceMessageId,9n);assert.equal(ops[0].customId,raw(c)+' ');assert.equal(ops[0].choiceJson,serializeBusyChoice(c));assert.equal(ops[0].action,'Ignore');
 }finally{w.admissionPermit!.release();await owner.close();}
}));

test('Queue is ready-read only and cannot receive, forge or complete a native Busy claim; ConfirmationOnly never claims',async()=>storeFixture(async path=>{
 const c=await choice(path),owner=new NativeBusyClaimOwner(path),w=click(path,c,3n,'Queue');try{
  assert.deepEqual(await owner.claim(w,component(c,'Queue'),2),{kind:'ExecuteQueue'});assert.equal(rows(path).busy[0]!.claimed_at,null);assert.throws(()=>owner.ready({choiceId:c.choiceId,readyMarker:busyReadyMarker(c.choiceId,2n,1n)},2),TypeError);
  const confirmation={...w,processingMode:'ConfirmationOnly' as const};assert.equal(await owner.confirmationReady(confirmation,component(c,'Queue'),2),false);await assert.rejects(owner.claim(confirmation,component(c,'Queue'),2),TypeError);
  await state.claimComponent(path,busyReadyMarker(c.choiceId,2n,1n),2,1800);edit(path,'DELETE FROM busy_choices');assert.equal(await owner.confirmationReady(confirmation,component(c,'Queue'),3),true);assert.deepEqual(await owner.claim(w,component(c,'Queue'),3),{kind:'DeliverConfirmation'});assert.equal(rows(path).busy.length,0);
 }finally{w.admissionPermit!.release();await owner.close();}
}));

test('copied, forged, cross-owner and consumed handles cannot ready or release the original Busy choice',async()=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),b=new NativeBusyClaimOwner(path);try{const h=await held(a,path,c);for(const fake of [{...h},Object.create(Object.getPrototypeOf(h)),{}]){assert.throws(()=>a.ready(fake,3),TypeError);assert.throws(()=>a.release(fake),TypeError);}assert.throws(()=>b.release(h),TypeError);await a.release(h);assert.equal(rows(path).busy[0]!.claimed_at,null);assert.throws(()=>a.release(h),TypeError);assert.throws(()=>a.ready(h,4),TypeError);}finally{await a.close();await b.close();}
}));

test('crossed actor/channel/choice/custody/component and copied route fail without native submission',async t=>storeFixture(async path=>{
 const c=saved(),a=new NativeBusyClaimOwner(path),w=click(path,c);let submitted=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){submitted++;return run.apply(this,args);});
 try{for(const changed of [{...w,userId:7n},{...w,channelId:7n},{...w,custodyDatabase:path+'-other'},{...w,custodyIngressId:'interaction:99'},{...w,work:{...w.work}},{...w,authorizedBusyChoice:null},{...w,authorizedBusyChoice:{...c,choiceId:'b'.repeat(24)}}])await assert.rejects(a.claim(changed,component(c),2),TypeError);
  await assert.rejects(a.claim(w,component(c,'Stop'),2),TypeError);for(const n of [NaN,Infinity,-1])await assert.rejects(a.claim(w,component(c),n),TypeError);assert.equal(submitted,0);assert.equal(existsSync(path),false);
 }finally{w.admissionPermit!.release();await a.close();}
}));

for(const empty of [false,true])test(`native Busy never ${empty?'repairs a missing catalog':'creates a missing database'}`,async()=>storeFixture(async path=>{
 if(empty)new DatabaseSync(path).close();const c=saved(),a=new NativeBusyClaimOwner(path),w=click(path,c);try{await assert.rejects(a.claim(w,component(c),2),NativeBusyClaimUnknownError);assert.equal(existsSync(path),empty);if(empty){const db=new DatabaseSync(path);try{assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(),[]);}finally{db.close();}}}finally{w.admissionPermit!.release();await a.close();}
}));

test('source Busy state decode precedes expiry, keeps claimed-at zero, and existing operations preserve row count',async()=>storeFixture(async path=>{
 const c=await choice(path);edit(path,'UPDATE busy_choices SET claimed_at=0');assert.equal(readBusyChoiceStateExisting(path,c.choiceId,2)!.claimed,true);assert.equal(claimBusyChoiceExisting(path,c.choiceId,2),false);assert.equal(releaseBusyChoiceClaimExisting(path,c.choiceId),true);assert.equal(releaseBusyChoiceClaimExisting(path,c.choiceId),false);assert.equal(readBusyChoiceStateExisting(path,c.choiceId,101),null);assert.equal(rows(path).busy.length,1);
 edit(path,"UPDATE busy_choices SET prompt=CAST(x'80' AS TEXT)");assert.throws(()=>readBusyChoiceStateExisting(path,c.choiceId,1000),/Invalid text encoding/);assert.equal(rows(path).busy.length,1);
}));

test('expired stored choice is Missing without cleanup; original snapshot expiry/allowSteer is not new authority policy',async()=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),w=click(path,c);try{assert.deepEqual(await a.claim(w,component(c),101),{kind:'Missing'});assert.equal(rows(path).busy.length,1);
  const original={...c,expiresAt:0,allowSteer:false},other=click(path,original,4n,'Steer');try{assert.equal((await a.claim(other,component(c,'Steer'),2)).kind,'ExecuteAction');}finally{other.admissionPermit!.release();}
 }finally{w.admissionPermit!.release();await a.close();}
}));

for(const failure of ['rollback','lost_ack'] as const)test(`${failure} Claim remains unknown and cannot reclaim after expiry or a changed click`,async t=>storeFixture(async path=>{
 const c=await choice(path),run=OwnedWorkerSlot.prototype.run,ops:string[]=[];t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(isWorker(args[0])){const q=args[1] as any;ops.push(q.operation);if(failure==='lost_ack'&&q.operation==='Claim')return task.then(()=>{throw Error('lost original ACK');});}return task;});
 if(failure==='rollback')edit(path,"CREATE TRIGGER refuse_busy BEFORE UPDATE OF claimed_at ON busy_choices BEGIN SELECT RAISE(ABORT,'fixture'); END");
 const a=new NativeBusyClaimOwner(path),w=click(path,c);try{await assert.rejects(a.claim(w,component(c),2),NativeBusyClaimUnknownError);if(failure==='rollback')edit(path,'DROP TRIGGER refuse_busy');assert.equal(rows(path).busy[0]!.claimed_at,failure==='rollback'?null:2);
  const later=click(path,c,4n);try{assert.deepEqual(await a.claim(later,component(c),10000),{kind:'ActionUnconfirmed'});}finally{later.admissionPermit!.release();}
  for(const patch of [{applicationId:8n},{sourceMessageId:null},{sourceMessageId:10n},{authorizedBusyChoice:{...c,prompt:'different'}},{authorizedBusyChoice:{...c,expiresAt:10001}},{authorizedBusyChoice:{...c,allowSteer:true}}])await assert.rejects(a.claim({...w,...patch},component(c),10000),NativeBusyClaimUnknownError);
  for(const action of ['Queue','Ignore'] as const){const changed=click(path,c,5n,action,raw(c,action)+' ');try{await assert.rejects(a.claim(changed,component(c,action),10000),NativeBusyClaimUnknownError);}finally{changed.admissionPermit!.release();}}assert.deepEqual(ops,['Claim','RecoverReady']);assert.equal(rows(path).busy[0]!.claimed_at,failure==='rollback'?null:2);
 }finally{w.admissionPermit!.release();await a.close();}
}));

for(const key of ['id','path','operation','interactionIngressId','interactionId','applicationId','actorId','channelId','sourceMessageId','customId','choiceJson','choiceId','action','readyMarker','now','expiresAt'] as const)test(`crossed Busy ${key} ACK mints no claim and leaves durable claim held`,async t=>storeFixture(async path=>{
 const c=await choice(path),run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);return isWorker(args[0])?task.then(raw=>({...raw as any,[key]:typeof (raw as any)[key]==='bigint'?99n:'crossed'})):task;});
 const a=new NativeBusyClaimOwner(path),w=click(path,c);try{await assert.rejects(a.claim(w,component(c),2),NativeBusyClaimUnknownError);assert.equal(rows(path).busy[0]!.claimed_at,2);assert.throws(()=>a.release({choiceId:c.choiceId,readyMarker:'copied'}),TypeError);}finally{w.admissionPermit!.release();await a.close();}
}));

for(const operation of ['Ready','Release'] as const)for(const failure of ['sql','lost_ack'] as const)test(`${operation} ${failure} never repeats completion or creates a fresh claim; explicit recovery is ready-only`,async t=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),h=await held(a,path,c),w=click(path,c,4n);
 if(failure==='sql')edit(path,operation==='Ready'?"CREATE TRIGGER refuse_ready BEFORE INSERT ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'fixture'); END":"CREATE TRIGGER refuse_release BEFORE UPDATE OF claimed_at ON busy_choices BEGIN SELECT RAISE(ABORT,'fixture'); END");
 else{const complete=OwnedWorkerSlot.prototype.runControlCompletion;t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){const task=complete.apply(this,args);return isWorker(args[0])?task.then(()=>{throw Error('lost completion ACK');}):task;});}
 try{await assert.rejects(operation==='Ready'?a.ready(h,3):a.release(h),NativeBusyClaimUnknownError);assert.throws(()=>a.ready(h,4),TypeError);assert.throws(()=>a.release(h),TypeError);assert.deepEqual(await a.claim(w,component(c),4),{kind:operation==='Ready'&&failure==='lost_ack'?'DeliverConfirmation':'ActionUnconfirmed'});assert.equal(rows(path).busy[0]!.claimed_at,operation==='Release'&&failure==='lost_ack'?null:2);assert.deepEqual(await a.claim(w,component(c),10000),{kind:'ActionUnconfirmed'});}finally{w.admissionPermit!.release();await a.close();}
}));

test('Ready keeps original cleanup+insert rollback',async()=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),h=await held(a,path,c);await state.claimComponent(path,'expired',0,1);edit(path,"CREATE TRIGGER refuse_ready BEFORE INSERT ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'fixture'); END");try{await assert.rejects(a.ready(h,3),NativeBusyClaimUnknownError);assert.deepEqual(rows(path).ready.map(x=>x.claim_key),['expired']);assert.equal(rows(path).busy[0]!.claimed_at,2);}finally{await a.close();}
}));

test('pre-cancelled claim and known synchronous Ready refusal preserve no-submission custody',async()=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),w=click(path,c),cancel=new AbortController();cancel.abort(Error('cancelled'));try{await assert.rejects(a.claim(w,component(c),2,cancel.signal),e=>e===cancel.signal.reason);assert.equal(rows(path).busy[0]!.claimed_at,null);const h=await held(a,path,c);assert.throws(()=>a.ready(h,NaN),TypeError);await a.ready(h,3);assert.equal(rows(path).ready.length,1);}finally{w.admissionPermit!.release();await a.close();}
}));

for(const mode of ['deadline','cancel'] as const)test(`Busy Claim ${mode} retains worker and caller until real native exit despite late autocommit`,async t=>storeFixture(async path=>{
 const c=await choice(path),run=OwnedWorkerSlot.prototype.run;if(mode==='deadline')t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return isWorker(args[0])&&(args[1] as any).operation==='Claim'?run.call(this,args[0],args[1],30,args[3]):run.apply(this,args);});
 const a=new NativeBusyClaimOwner(path),w=click(path,c),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const cancel=new AbortController();let settled=false,ticks=0;const timer=setInterval(()=>ticks++,5),task=a.claim(w,component(c),2,cancel.signal),failed=assert.rejects(task,NativeBusyClaimUnknownError);void task.then(()=>settled=true,()=>settled=true);
 try{await sleep(100);if(mode==='cancel')cancel.abort(Error('cancel'));await sleep(70);assert.equal(settled,false);assert.equal(a.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);db.exec('ROLLBACK');await failed;assert.equal(a.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(rows(path).busy[0]!.claimed_at,2);assert.deepEqual(await a.claim(w,component(c),3),{kind:'ActionUnconfirmed'});}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});await a.close();db.close();w.admissionPermit!.release();}
}));

for(const operation of ['Ready','Release'] as const)test(`same-owner owned ${operation} waits FIFO behind another Claim; extra claim is refused without queue`,async()=>storeFixture(async path=>{
 const first=await choice(path),second=await choice(path),third=await choice(path),a=new NativeBusyClaimOwner(path),b=new NativeBusyClaimOwner(path),h=await held(a,path,first),w=click(path,second,4n),next=click(path,third,5n),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const pending=a.claim(w,component(second),2);let completed=false;const completion=(operation==='Ready'?a.ready(h,3):a.release(h)).then(()=>{completed=true;});
 try{await assert.rejects(b.claim(next,component(third),2),OwnedWorkerBudgetError);await sleep(100);assert.equal(completed,false);assert.equal(a.busy,true);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');assert.equal((await pending).kind,'ExecuteAction');await completion;assert.equal(a.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(readBusyChoiceStateExisting(path,first.choiceId,3)!.claimed,operation==='Ready');assert.equal((await b.claim(next,component(third),3)).kind,'ExecuteAction');}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([pending,completion]);await a.close();await b.close();db.close();w.admissionPermit!.release();next.admissionPermit!.release();}
}));

test('close during Ready waits for cancelled native exit and late commit without release or replay',async()=>storeFixture(async path=>{
 const c=await choice(path),owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');let finished=false,closed=false;const ready=owner.ready(h,3),failed=assert.rejects(ready,NativeBusyClaimUnknownError);void ready.then(()=>finished=true,()=>finished=true);await sleep(50);const close=owner.close().then(()=>closed=true);
 try{await sleep(150);assert.equal(finished,false);assert.equal(closed,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await failed;await close;assert.equal(rows(path).ready.length,1);assert.equal(rows(path).busy[0]!.claimed_at,2);assert.equal(ownedWorkerUsage().Control,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([ready,close]);db.close();}
}));


test('Ready cleanup is not truncated by native envelope limits and keeps the original Busy claim',async()=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),h=await held(a,path,c),db=new DatabaseSync(path);try{db.exec('BEGIN IMMEDIATE');const insert=db.prepare('INSERT INTO persistent_component_claims VALUES(?,0,1)');for(let n=0;n<6000;n++)insert.run('expired:'+n+':'+('x'.repeat(128)));db.exec('COMMIT');}finally{db.close();}
 try{await a.ready(h,3);assert.deepEqual(rows(path).ready.map(x=>x.claim_key),[h.readyMarker]);assert.equal(rows(path).busy[0]!.claimed_at,2);}finally{await a.close();}
}));

test('native Busy preserves null source identity without substituting the original prompt message',async t=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),w={...click(path,c),sourceMessageId:null},run=OwnedWorkerSlot.prototype.run;let captured:any;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isWorker(args[0]))captured=args[1];return run.apply(this,args);});
 try{const result=await a.claim(w,component(c),2);assert.equal(result.kind,'ExecuteAction');assert.equal(captured.sourceMessageId,null);assert.equal(captured.interactionId,3n);if(result.kind==='ExecuteAction')await a.release(result.claim);}finally{w.admissionPermit!.release();await a.close();}
}));
