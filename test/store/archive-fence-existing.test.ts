import assert from 'node:assert/strict';
import {it} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
async function init(path:string){const db=await openInitialized(path);db.close();}
function read(path:string){const db=new DatabaseSync(path);try{return db.prepare('SELECT * FROM codex_archive_fences ORDER BY target_thread_id').all();}finally{db.close();}}
it('existing-only writes never create an absent store',async()=>storeFixture(async path=>{
 for(const run of [()=>state.reserveArchiveScopeExisting(path,['a'],null),()=>state.markArchiveVerifiedExisting(path,'missing'),()=>state.releaseRejectedArchiveExisting(path,'missing')]){assert.throws(run);assert.equal(existsSync(path),false);}
}));
it('malformed existing schema is not migrated or repaired by writes',async()=>storeFixture(async path=>{
 const db=new DatabaseSync(path);db.exec('CREATE TABLE sentinel(value TEXT)');db.close();
 assert.throws(()=>state.reserveArchiveScopeExisting(path,['a'],null),/no such table/);
 assert.throws(()=>state.markArchiveVerifiedExisting(path,'missing'),/no such table/);
 assert.throws(()=>state.releaseRejectedArchiveExisting(path,'missing'),/no such table/);
 const after=new DatabaseSync(path);try{assert.deepEqual(after.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name),['sentinel']);}finally{after.close();}
}));
it('existing-only scope uses original set semantics and verified fences remain',async()=>storeFixture(async path=>{
 await init(path);const id=state.reserveArchiveScopeExisting(path,['b','a','b'],null);assert.match(id,/^[0-9a-f-]{36}$/);
 assert.deepEqual(read(path).map(r=>[r.target_thread_id,r.operation_id,r.phase]),[['a',id,'attempted'],['b',id,'attempted']]);
 state.markArchiveVerifiedExisting(path,id);assert.ok(read(path).every(r=>r.phase==='verified'));
 assert.throws(()=>state.releaseRejectedArchiveExisting(path,id),/missing rejected/);assert.throws(()=>state.markArchiveVerifiedExisting(path,id),/missing attempted/);assert.equal(read(path).length,2);
}));
it('original whitespace validation precedes all existing-store access',async()=>storeFixture(async path=>{
 for(const scope of [[],[''],[' a'],['a\u0085']])assert.throws(()=>state.reserveArchiveScopeExisting(path,scope,null),/invalid archive/);
 assert.throws(()=>state.reserveArchiveScopeExisting(path,['\ud800'],null),TypeError);assert.equal(existsSync(path),false);
 await init(path);state.reserveArchiveScopeExisting(path,['\ufeffa'],null);assert.equal(read(path)[0]!.target_thread_id,'\ufeffa');
}));
it('second insertion failure rolls back the whole existing-only reservation',async()=>storeFixture(async path=>{
 await init(path);const db=new DatabaseSync(path);db.exec("CREATE TRIGGER reject_b BEFORE INSERT ON codex_archive_fences WHEN NEW.target_thread_id='b' BEGIN SELECT RAISE(ABORT,'reject second'); END");db.close();
 assert.throws(()=>state.reserveArchiveScopeExisting(path,['a','b'],null),/reject second/);assert.equal(read(path).length,0);
}));
it('existing-only release affects only its attempted operation',async()=>storeFixture(async path=>{
 await init(path);const a=state.reserveArchiveScopeExisting(path,['a'],null),b=state.reserveArchiveScopeExisting(path,['b'],null);
 state.releaseRejectedArchiveExisting(path,a);assert.deepEqual(read(path).map(r=>r.operation_id),[b]);assert.throws(()=>state.releaseRejectedArchiveExisting(path,a),/missing rejected/);
}));
it('busy existing writer neither creates a partial fence nor owns caller transaction',async()=>storeFixture(async path=>{
 await init(path);const lock=new DatabaseSync(path);try{lock.exec('BEGIN IMMEDIATE');assert.throws(()=>state.reserveArchiveScopeExisting(path,['a'],null),/locked/);assert.equal(lock.isTransaction,true);assert.equal(lock.prepare('SELECT count(*) AS n FROM codex_archive_fences').get()!.n,0);lock.exec('ROLLBACK');}finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
 assert.equal(read(path).length,0);state.reserveArchiveScopeExisting(path,['a'],null);assert.equal(read(path).length,1);
}));
it('existing and initialized entry points share collision and operation authority',async()=>storeFixture(async path=>{
 const id=await state.reserveArchiveScope(path,['z'],null);assert.throws(()=>state.reserveArchiveScopeExisting(path,['a','z'],null),/existing archive fence/);assert.deepEqual(read(path).map(r=>r.target_thread_id),['z']);state.markArchiveVerifiedExisting(path,id);await assert.rejects(state.releaseRejectedArchive(path,id),/missing rejected/);
}));
it('only a completed archive refusal releases later admission when its notification is held',async()=>storeFixture(async path=>{
 const payload={version:1,plan:{Execute:{Archive:{reference:null}}}};
 await state.admitIngress(path,{ingressId:'refused',kind:'message',eventId:1n,applicationId:null,channelId:2n,ownerUserId:3n,sourceMessageId:1n,targetThreadId:'a',canonicalOwner:null,now:1,payload});
 await state.beginIngressExecution(path,'refused','processing','a',2);
 const outcome={kind:'archive_not_dispatched',version:1,archive_dispatched:false};
 await state.recordIngressResult(path,'refused',outcome,3);
 await state.holdIngress(path,'refused','notification failed',false,4);
 const db=new DatabaseSync(path);try{
  for(const changed of [{...outcome,archive_dispatched:true},{...outcome,archive_dispatched:'false'},{...outcome,archive_dispatched:0},{...outcome,version:2},{...outcome,kind:'unverified'},{}]){
   db.prepare('UPDATE discord_ingress_journal SET outcome_json=?').run(JSON.stringify(changed));
   assert.equal(state.unfinishedArchiveRequestExisting(path,'a',null),'refused');
   assert.throws(()=>state.reserveArchiveScopeExisting(path,['a'],null),/unfinished/);
  }
  db.prepare('UPDATE discord_ingress_journal SET outcome_json=?,payload_json=?').run(JSON.stringify(outcome),JSON.stringify({version:1,plan:{Execute:{Stop:{reference:null}}}}));
  assert.equal(state.unfinishedArchiveRequestExisting(path,'a',null),'refused');
  db.prepare('UPDATE discord_ingress_journal SET payload_json=?').run(JSON.stringify(payload));
 }finally{db.close();}
 assert.equal(state.unfinishedArchiveRequestExisting(path,'a',null),null);
 const reservation=state.reserveArchiveScopeExisting(path,['a'],null);assert.equal(read(path)[0]?.operation_id,reservation);
}));
