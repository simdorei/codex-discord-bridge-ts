import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {NativeRecoveryOwner,NativeRecoveryUnavailableError} from '../../../src/runtime/writer-recovery/native-owner.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {getIngressIn,type StoredIngress} from '../../../src/store/ingress-read.ts';
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function fixture(run:(path:string,record:StoredIngress,owner:NativeRecoveryOwner)=>Promise<void>,route='Explicit',kind='Recover'){
 await storeFixture(async path=>{const command={[kind]:{reference:route==='Explicit'?'target':null}},binding={target:'target',route,command};
 if(route==='Mapped')await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES('target','p','title',10,1,1)"));
 await state.admitIngress(path,{ingressId:'message:3',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,plan:{Execute:command},lifecycle_binding:binding},targetThreadId:'target',canonicalOwner:null,now:1});
 await state.beginIngressExecution(path,'message:3','processing','target',2);const record=await edit(path,db=>getIngressIn(db,'message:3')!),owner=new NativeRecoveryOwner(path);try{await run(path,record,owner);}finally{await owner.close();}});
}
test('native owner binds one original claim, cancels once, and keeps process-exit unproven',()=>fixture(async(path,record,owner)=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));const claim=await owner.claim(record);await owner.check(claim);assert.deepEqual(await owner.cancel(claim),{jobs:['job'],startedOrUncertain:0});await assert.rejects(owner.cancel(claim),/consumed/);await owner.check(claim);
 await edit(path,db=>{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_request_cancellations').get()?.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_execution_holds').get()?.n,1);assert.equal(getIngressIn(db,'message:3')?.phase,'recovery_claimed');});assert.equal(ownedWorkerUsage().Control,0);
}));
test('cloned and another-owner proof cannot reach persistence',()=>fixture(async(path,record,owner)=>{
 const claim=await owner.claim(record);await assert.rejects(owner.cancel({...claim}),/Unknown/);const other=new NativeRecoveryOwner(path);try{await assert.rejects(other.cancel(claim),/Unknown/);}finally{await other.close();}await owner.check(claim);
}));
test('claim input is captured before await and caller mutation cannot retarget it',()=>fixture(async(_path,record,owner)=>{
 const pending=owner.claim(record);record.phase='changed';record.targetThreadId='other';const claim=await pending;await owner.check(claim);
}));
test('changed mapping refuses cancellation without consuming old requests',()=>fixture(async(path,record,owner)=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));const claim=await owner.claim(record);await edit(path,db=>db.exec("UPDATE mirror_threads SET codex_thread_id='other'"));await assert.rejects(owner.cancel(claim),NativeRecoveryUnavailableError);await edit(path,db=>assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,1));
},'Mapped'));
for(const kind of ['Selected','Repair'])test('unconnected '+kind+' scope is refused without claiming',()=>fixture(async(path,record,owner)=>{
 await assert.rejects(owner.claim(record),NativeRecoveryUnavailableError);await edit(path,db=>assert.equal(getIngressIn(db,'message:3')?.phase,'processing'));
},kind==='Selected'?'Selected':'Explicit',kind==='Repair'?'Repair':'Recover'));
test('pre-abort is exact and no durable claim is created',()=>fixture(async(path,record,owner)=>{
 const c=new AbortController(),reason={cancel:'before'};c.abort(reason);await assert.rejects(owner.claim(record,c.signal),e=>e===reason);await edit(path,db=>assert.equal(getIngressIn(db,'message:3')?.phase,'processing'));
}));
test('close joins in-flight native work and preserves unknown outcome instead of retrying',()=>fixture(async(path,record,owner)=>{
 const pending=owner.claim(record);const rejected=assert.rejects(pending,NativeRecoveryUnavailableError);await owner.close();await rejected;assert.equal(ownedWorkerUsage().Control,0);await assert.rejects(owner.claim(record),/closed/);await edit(path,db=>assert.ok(['processing','recovery_claimed'].includes(getIngressIn(db,'message:3')!.phase)));
}));
test('concurrent and oversized original claims fail before another submission',()=>fixture(async(_path,record,owner)=>{
 const pending=owner.claim(record);await assert.rejects(owner.claim(record),/busy/i);const claim=await pending;await owner.check(claim);
 const large={...record,holdReason:'x'.repeat(1048577)};await assert.rejects(owner.claim(large),/budget/);
}));
test('late original record mutation prevents check and cancellation',()=>fixture(async(path,record,owner)=>{
 const claim=await owner.claim(record);await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET updated_at=updated_at+1"));await assert.rejects(owner.check(claim),NativeRecoveryUnavailableError);await assert.rejects(owner.cancel(claim),NativeRecoveryUnavailableError);
}));


for(const operation of ['claim','check','cancel'] as const)test('oversized stored evidence refuses native '+operation+' without cancellation',()=>fixture(async(path,record,owner)=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
 const token=operation==='claim'?null:await owner.claim(record);
 await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET hold_reason=? WHERE ingress_id='message:3'").run('한'.repeat(349526)));
 if(operation==='claim')await assert.rejects(owner.claim(record),NativeRecoveryUnavailableError);
 else if(operation==='check')await assert.rejects(owner.check(token!),NativeRecoveryUnavailableError);
 else await assert.rejects(owner.cancel(token!),NativeRecoveryUnavailableError);
 await edit(path,db=>{assert.equal(db.prepare("SELECT phase FROM discord_ingress_journal WHERE ingress_id='message:3'").get()?.phase,operation==='claim'?'processing':'recovery_claimed');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_request_cancellations').get()?.n,0);});
}));
test('claim readback byte guard rolls back oversized trigger mutation',()=>fixture(async(path,record,owner)=>{
 await edit(path,db=>db.exec("CREATE TRIGGER enlarge_recovery AFTER UPDATE OF phase ON discord_ingress_journal WHEN NEW.phase='recovery_claimed' BEGIN UPDATE discord_ingress_journal SET hold_reason=hex(zeroblob(524289)) WHERE ingress_id=NEW.ingress_id; END"));
 await assert.rejects(owner.claim(record),NativeRecoveryUnavailableError);
 await edit(path,db=>{assert.equal(db.prepare("SELECT phase FROM discord_ingress_journal WHERE ingress_id='message:3'").get()?.phase,'processing');assert.equal(db.prepare("SELECT length(hold_reason) AS n FROM discord_ingress_journal WHERE ingress_id='message:3'").get()?.n,0);});
}));

test('stored evidence scalar gate precedes JSON decode and requires a transaction',()=>fixture(async(path,record,owner)=>{
 await owner.claim(record);
 await edit(path,db=>{
  const expected=getIngressIn(db,'message:3')!;
  assert.throws(()=>state.validateIngressRecoverySnapshotIn(db,expected),/owning transaction/);
  db.prepare("UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id='message:3'").run('{'+ 'x'.repeat(1048576));
  db.exec('BEGIN');
  try{assert.throws(()=>state.validateIngressRecoverySnapshotIn(db,expected),/byte budget/);assert.equal(db.isTransaction,true);}finally{db.exec('ROLLBACK');}
 });
}));
