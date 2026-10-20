import {validateIngressRecoveryIn} from '../../../src/store/ingress-recovery-custody.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {existsSync,copyFileSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {getIngressIn,type StoredIngress} from '../../../src/store/ingress-read.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {NativeBridgeStateOwner,type BridgeSelectionSnapshot} from '../../../src/runtime/bridge-state-native.ts';
import {NativeRepairClaimOwner,NativeRepairClaimUnknownError} from '../../../src/runtime/writer-recovery/native-repair-owner.ts';
import {NativeRecoveryOwner} from '../../../src/runtime/writer-recovery/native-owner.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const worker=(url:URL)=>/native-repair-worker\.(ts|js)$/.test(url.pathname);
interface Fixture{path:string;db:DatabaseSync;record:StoredIngress;owner:NativeRepairClaimOwner;bridge:BridgeState;native:NativeBridgeStateOwner;selection:BridgeSelectionSnapshot|null;}
async function fixture(run:(f:Fixture)=>Promise<void>,route:'Explicit'|'Mapped'|'Selected'='Explicit'){
 await storeFixture(async path=>{
  const db=await openInitialized(path),bridge=new BridgeState(join(dirname(path),'bridge.json')),native=new NativeBridgeStateOwner(bridge.path());
  await native.execute({kind:'Select',id:'T'});const command={Repair:{reference:route==='Explicit'?'T':null}};
  await state.admitIngress(path,{ingressId:'message:3',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,plan:{Execute:command},lifecycle_binding:{target:'T',route,command},stop_origin:{target:'T',stopRevision:0n}},targetThreadId:'T',canonicalOwner:null,now:1});
  await state.beginIngressExecution(path,'message:3','processing','T',2);if(route==='Mapped')db.exec("INSERT INTO mirror_threads VALUES('T','p','title',10,1,1)");
  const owner=new NativeRepairClaimOwner(path,bridge,native),selection=route==='Selected'?await native.captureSelected():null;
  try{await run({path,db,record:getIngressIn(db,'message:3')!,owner,bridge,native,selection});}finally{if(db.isTransaction)db.exec('ROLLBACK');await owner.close();db.close();}
 });
}
function read(f:Fixture,run:()=>void){f.db.exec('BEGIN');try{run();}finally{f.db.exec('ROLLBACK');}}
test('native Repair claims exactly once and retains authenticated borrowed synchronous custody',()=>fixture(async f=>{
 const claim=await f.owner.claim(f.record);assert.deepEqual(Object.keys(claim),[]);assert.equal(getIngressIn(f.db,'message:3')!.phase,'recovery_claimed');assert.equal(ownedWorkerUsage().Control,0);
 read(f,()=>{assert.equal(f.owner.checkIn(claim,f.db),undefined);assert.throws(()=>f.owner.checkIn({...claim},f.db),/Unknown/);assert.throws(()=>f.owner.checkIn(f.record as never,f.db),/Unknown/);assert.throws(()=>validateIngressRecoveryIn(f.db,claim as never),/admission changed/);});
 const foreign=new NativeRepairClaimOwner(f.path,f.bridge,f.native);try{read(f,()=>assert.throws(()=>foreign.checkIn(claim,f.db),/Unknown/));}finally{await foreign.close();}
 const recovery=new NativeRecoveryOwner(f.path);try{await assert.rejects(recovery.check(claim as never),/Unknown/);}finally{await recovery.close();}
 await assert.rejects(f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(getIngressIn(f.db,'message:3')!.phase,'recovery_claimed');
}));
test('borrowed native Repair check sees uncommitted changes without closing or settling caller transaction',()=>fixture(async f=>{
 const claim=await f.owner.claim(f.record);assert.throws(()=>f.owner.checkIn(claim,f.db),/owning transaction/);
 f.db.exec('BEGIN IMMEDIATE');assert.equal(f.owner.checkIn(claim,f.db),undefined);f.db.exec("UPDATE discord_ingress_journal SET owner_user_id=99");assert.throws(()=>f.owner.checkIn(claim,f.db),/admission changed/);assert.equal(f.db.isTransaction,true);assert.equal(f.db.isOpen,true);f.db.exec('ROLLBACK');read(f,()=>f.owner.checkIn(claim,f.db));
}));
test('copied database and forged database location cannot borrow authentic Repair claim',()=>fixture(async f=>{
 const claim=await f.owner.claim(f.record);f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const otherPath=f.path+'.copy';copyFileSync(f.path,otherPath);const other=new DatabaseSync(otherPath);other.exec('BEGIN');try{Object.defineProperty(other,'location',{value:()=>f.db.location()});assert.throws(()=>f.owner.checkIn(claim,other),/another database/);assert.equal(other.isTransaction,true);}finally{other.exec('ROLLBACK');other.close();}
 assert.throws(()=>f.owner.assertOwner(otherPath,f.bridge,f.native),/another database/);read(f,()=>f.owner.checkIn(claim,f.db));
}));
test('original Repair record is captured before await without caller retargeting',()=>fixture(async f=>{
 const pending=f.owner.claim(f.record);f.record.ownerUserId=99n;f.record.targetThreadId='other';f.record.payload=null;const claim=await pending;read(f,()=>f.owner.checkIn(claim,f.db));assert.equal(getIngressIn(f.db,'message:3')!.ownerUserId,2n);
}));
test('Recover snapshot cannot borrow dedicated Repair authority',()=>fixture(async f=>{
 f.db.exec("UPDATE discord_ingress_journal SET payload_json=replace(payload_json,'Repair','Recover')");assert.throws(()=>f.owner.claim(getIngressIn(f.db,'message:3')!),/original Repair/);assert.equal(getIngressIn(f.db,'message:3')!.phase,'processing');
}));
for(const moment of ['before','after'] as const)test('archive fence '+moment+' claim preserves original fence and refuses repair',()=>fixture(async f=>{
 const claim=moment==='after'?await f.owner.claim(f.record):null;f.db.exec("INSERT INTO codex_archive_fences VALUES('T','archive',NULL,'attempted')");
 if(claim===null)assert.throws(()=>f.owner.claim(f.record),/archive fence/);else read(f,()=>assert.throws(()=>f.owner.checkIn(claim,f.db),/archive fence/));
 assert.equal(getIngressIn(f.db,'message:3')!.phase,moment==='before'?'processing':'recovery_claimed');assert.equal(f.db.prepare('SELECT count(*) n FROM codex_archive_fences').get()!.n,1);
}));
for(const moment of ['before','after'] as const)test('mapping '+moment+' claim never refreshes target',()=>fixture(async f=>{
 const claim=moment==='after'?await f.owner.claim(f.record):null;f.db.exec("UPDATE mirror_threads SET codex_thread_id='other'");
 if(claim===null)assert.throws(()=>f.owner.claim(f.record),/admission changed/);else read(f,()=>assert.throws(()=>f.owner.checkIn(claim,f.db),/admission changed/));
 assert.equal(getIngressIn(f.db,'message:3')!.targetThreadId,'T');
},'Mapped'));
for(const sql of [
 "CREATE TRIGGER corrupt_claim AFTER UPDATE OF phase ON discord_ingress_journal BEGIN UPDATE discord_ingress_journal SET hold_reason='changed' WHERE ingress_id=NEW.ingress_id; END",
 "CREATE TRIGGER corrupt_claim AFTER UPDATE OF phase ON discord_ingress_journal BEGIN UPDATE discord_ingress_journal SET hold_reason=hex(zeroblob(524289)) WHERE ingress_id=NEW.ingress_id; END",
 "CREATE TRIGGER corrupt_claim AFTER UPDATE OF phase ON discord_ingress_journal BEGIN INSERT INTO codex_archive_fences VALUES('T','archive',NULL,'attempted'); END",
])test('claim trigger mutation is rolled back and cannot produce a Repair token',()=>fixture(async f=>{
 f.db.exec(sql);await assert.rejects(f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(getIngressIn(f.db,'message:3')!.phase,'processing');assert.equal(getIngressIn(f.db,'message:3')!.holdReason,'');assert.equal(f.db.prepare('SELECT count(*) n FROM codex_archive_fences').get()!.n,0);
}));
test('existing-only Repair owner does not create or migrate missing and partial stores',()=>fixture(async f=>{
 const missing=f.path+'.missing',owner=new NativeRepairClaimOwner(missing,f.bridge);try{assert.throws(()=>owner.claim(f.record));assert.equal(existsSync(missing),false);}finally{await owner.close();}
 const partial=f.path+'.partial',db=new DatabaseSync(partial);db.exec('CREATE TABLE sentinel(value TEXT)');db.close();const before=readFileSync(partial),other=new NativeRepairClaimOwner(partial,f.bridge);try{assert.throws(()=>other.claim(f.record));assert.deepEqual(readFileSync(partial),before);}finally{await other.close();}
}));
test('preabort, hostile records, signals and oversize refuse without native claim',async t=>fixture(async f=>{
 let hooks=0,submits=0;t.mock.method(OwnedWorkerSlot.prototype,'run',()=>{submits++;throw Error('unexpected submit');});
 const c=new AbortController(),reason=new Error('preabort');c.abort(reason);assert.throws(()=>f.owner.claim(f.record,null,c.signal),e=>e===reason);
 const hooked=Object.defineProperty({...f.record},'payload',{get(){hooks++;return f.record.payload;}});assert.throws(()=>f.owner.claim(hooked));assert.throws(()=>f.owner.claim(new Proxy(f.record,{ownKeys(){hooks++;return [];}})));assert.throws(()=>f.owner.claim({...f.record,holdReason:'x'.repeat(1048577)}),/budget/);
 const signal=new AbortController().signal;Object.defineProperty(signal,'throwIfAborted',{value(){hooks++;}});assert.throws(()=>f.owner.claim(f.record,null,signal));assert.equal(hooks,0);assert.equal(submits,0);assert.equal(getIngressIn(f.db,'message:3')!.phase,'processing');
}));
test('first native Selected epoch remains original across away-and-back before or after claim',async()=>{
 await fixture(async f=>{await f.native.execute({kind:'Select',id:'other'});await f.native.execute({kind:'Select',id:'T'});assert.throws(()=>f.owner.claim(f.record,f.selection),/stale/);assert.equal(getIngressIn(f.db,'message:3')!.phase,'processing');},'Selected');
 await fixture(async f=>{const claim=await f.owner.claim(f.record,f.selection);await f.native.execute({kind:'Select',id:'other'});await f.native.execute({kind:'Select',id:'T'});read(f,()=>assert.throws(()=>f.owner.checkIn(claim,f.db),/stale/));},'Selected');
});
test('Selected owner rejects missing, cloned and foreign epoch proof without a write',()=>fixture(async f=>{
 assert.throws(()=>f.owner.claim(f.record),/Missing/);assert.throws(()=>f.owner.claim(f.record,{...f.selection}),/stale/);const other=new NativeBridgeStateOwner(f.native.path()),foreign=await other.captureSelected();assert.throws(()=>f.owner.claim(f.record,foreign),/stale/);assert.equal(getIngressIn(f.db,'message:3')!.phase,'processing');
},'Selected'));
test('Selected lease holds through actual native exit and ACK validation, then releases',async t=>fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run;let exited=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(!worker(args[0]))return pending;return pending.then(async value=>{exited=true;assert.equal(ownedWorkerUsage().Control,0);for(const op of [{kind:'Select',id:'other'},{kind:'Select',id:'T'},{kind:'Selected'},{kind:'Remember',id:'T',model:null,reasoning:null,speed:null}] as const)await assert.rejects(f.native.execute(op),OwnedWorkerBusyError);return value;});});
 const claim=await f.owner.claim(f.record,f.selection);assert.equal(exited,true);read(f,()=>f.owner.checkIn(claim,f.db));assert.equal(await f.native.execute({kind:'Selected'}),'T');
},'Selected'));
test('selected lease liveness loss rolls back the claim, then joins and releases',async t=>fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(worker(args[0]))Atomics.store(new Int32Array((args[1] as any).proof.active),0,0);return run.apply(this,args);});
 await assert.rejects(f.owner.claim(f.record,f.selection),NativeRepairClaimUnknownError);assert.equal(getIngressIn(f.db,'message:3')!.phase,'processing');assert.equal(ownedWorkerUsage().Control,0);assert.equal(await f.native.execute({kind:'Selected'}),'T');
},'Selected'));
for(const mode of ['abort','deadline','close'] as const)test(mode+' joins blocked native claim and keeps Selected lease until real exit',()=>fixture(async f=>{
 f.db.exec('BEGIN IMMEDIATE');const c=new AbortController(),pending=f.owner.claim(f.record,f.selection,c.signal,mode==='deadline'?1:5000);let settled=false,closed=false;const failure=assert.rejects(pending,NativeRepairClaimUnknownError).then(()=>{settled=true;});const closing=mode==='close'?f.owner.close().then(()=>{closed=true;}):null;if(mode==='abort')c.abort(new Error('after submit'));
 try{await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal(closed,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(f.native.execute({kind:'Select',id:'other'}),OwnedWorkerBusyError);if(mode!=='close')assert.throws(()=>f.owner.claim(f.record,f.selection),OwnedWorkerBusyError);f.db.exec('ROLLBACK');await failure;if(closing!==null)await closing;assert.equal(ownedWorkerUsage().Control,0);assert.equal(await f.native.execute({kind:'Selected'}),'T');assert.throws(()=>f.owner.claim(f.record,f.selection),mode==='close'?/closed/:NativeRepairClaimUnknownError);}finally{if(f.db.isTransaction)f.db.exec('ROLLBACK');await failure;if(closing!==null)await closing;}
},'Selected'));
test('global Control saturation has zero queue and does not poison an unsubmitted owner',()=>fixture(async f=>{
 f.db.exec('BEGIN IMMEDIATE');const first=f.owner.claim(f.record);const second=new NativeRepairClaimOwner(f.path,f.bridge,f.native);try{await assert.rejects(second.claim(f.record),OwnedWorkerBusyError);assert.equal(ownedWorkerUsage().Control,1);f.db.exec('ROLLBACK');await first;f.db.exec("UPDATE discord_ingress_journal SET phase='processing',updated_at=2");const claim=await second.claim(f.record);read(f,()=>second.checkIn(claim,f.db));}finally{if(f.db.isTransaction)f.db.exec('ROLLBACK');await first.catch(()=>{});await second.close();}
}));
for(const outcome of ['commit','rollback'] as const)test('lost ACK after '+outcome+' permanently blocks original and fresh ingress retry on same owner',async t=>fixture(async f=>{
 if(outcome==='rollback')f.db.exec("CREATE TRIGGER reject_claim BEFORE UPDATE OF phase ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture rejection'); END");
 const run=OwnedWorkerSlot.prototype.run;let calls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!worker(args[0]))return task;calls++;return task.then(()=>{throw new Error('lost ACK');});});
 await assert.rejects(f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(getIngressIn(f.db,'message:3')!.phase,outcome==='commit'?'recovery_claimed':'processing');assert.throws(()=>f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.throws(()=>f.owner.claim({...f.record,ingressId:'message:4',eventId:4n,sourceMessageId:4n}),NativeRepairClaimUnknownError);assert.equal(calls,1);assert.equal(ownedWorkerUsage().Control,0);
}));
for(const field of ['id','path','operation','ok','location','record','extra'] as const)test('crossed or malformed '+field+' ACK cannot mint Repair custody',async t=>fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return run.apply(this,args).then((reply:any)=>worker(args[0])?{...reply,[field]:field==='ok'?false:field==='record'?{...reply.record,ownerUserId:99n}:field==='location'?'':field==='extra'?'x'.repeat(1048577):'crossed'}:reply);});
 await assert.rejects(f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(getIngressIn(f.db,'message:3')!.phase,'recovery_claimed');assert.throws(()=>f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(ownedWorkerUsage().Control,0);
}));
test('nonempty crossed ACK location cannot mint a claim for a copied database',async t=>fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run,copy=f.path+'.crossed';let changed=false;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return run.apply(this,args).then((reply:any)=>{if(!worker(args[0]))return reply;f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');copyFileSync(f.path,copy);const foreign=new DatabaseSync(copy);try{changed=true;return {...reply,location:foreign.location('main')};}finally{foreign.close();}});});
 await assert.rejects(f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(changed,true);assert.equal(getIngressIn(f.db,'message:3')!.phase,'recovery_claimed');assert.throws(()=>f.owner.claim(f.record),NativeRepairClaimUnknownError);assert.equal(ownedWorkerUsage().Control,0);
}));
