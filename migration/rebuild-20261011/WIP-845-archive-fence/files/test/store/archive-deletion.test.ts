import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {beginArchiveDeletionExisting as begin,beginArchiveDeletionIn,completeArchiveDeletionExisting as complete,deleteArchivedMirrorStateExisting as deleteMapping} from '../../src/store/archive-deletion.ts';
const confirmation={messageId:11n,channelId:3n,userId:7n,reference:'thread'};
async function fixture(run:(path:string,db:DatabaseSync)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{
 db.exec("INSERT INTO mirror_threads VALUES('thread','p','title',2,3,1)");
 db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:11','message',11,3,7,?,'executing','executing','thread',1,1)").run(JSON.stringify({plan:{Execute:{DeleteArchiveConfirm:{reference:'thread'}}}}));await run(path,db);
 }finally{db.close();}});}
const fence=(db:DatabaseSync)=>db.prepare('SELECT token,channels,phase FROM cdr_archive_fences').get();
test('exact confirmation is excluded and durable ownership survives reopen',async()=>fixture((path,db)=>{
 const token=begin(path,'thread',2,confirmation);assert.equal(fence(db)?.token,token);assert.equal(fence(db)?.channels,'[3]');assert.equal(fence(db)?.phase,'deleting');assert.equal(db.isTransaction,false);
 assert.throws(()=>complete(path,'thread','wrong'),/ownership/);assert.equal(fence(db)?.phase,'deleting');complete(path,'thread',token);assert.equal(fence(db)?.phase,'deleted');assert.throws(()=>complete(path,'thread',token),/ownership/);
}));
for(const [key,value] of [['messageId',12n],['channelId',4n],['userId',8n],['reference','other']] as const)test('confirmation mismatch '+key+' cannot install fence',async()=>fixture((path,db)=>{assert.throws(()=>begin(path,'thread',2,{...confirmation,[key]:value}),/custody/);assert.equal(fence(db),undefined);}));
for(const mutation of ["UPDATE discord_ingress_journal SET state='staged'","UPDATE discord_ingress_journal SET kind='interaction'","UPDATE discord_ingress_journal SET event_id=12","UPDATE discord_ingress_journal SET payload_json='{}'"])test('stored confirmation change rejects: '+mutation,async()=>fixture((path,db)=>{db.exec(mutation);assert.throws(()=>begin(path,'thread',2,confirmation),/custody/);assert.equal(fence(db),undefined);}));
test('null confirmation does not suppress executing ingress',async()=>fixture((path,db)=>{assert.throws(()=>begin(path,'thread',2,null),/ingress/);assert.equal(fence(db),undefined);}));
test('different pending ingress still protects target',async()=>fixture((path,db)=>{db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('other','message',3,7,'{}','staged','received','thread',1,1)");assert.throws(()=>begin(path,'thread',2,confirmation),/ingress/);assert.equal(fence(db),undefined);}));
test('ignored fence insert rejects and transaction rolls back',async()=>fixture((path,db)=>{db.exec("CREATE TRIGGER ignore_fence BEFORE INSERT ON cdr_archive_fences BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>begin(path,'thread',2,confirmation),/not stored/);assert.equal(fence(db),undefined);assert.equal(db.isTransaction,false);}));
test('second reservation cannot replace original token',async()=>fixture((path,db)=>{const token=begin(path,'thread',2,confirmation);assert.throws(()=>begin(path,'thread',3,confirmation));assert.equal(fence(db)?.token,token);}));
test('borrowed leaf requires transaction and rollback removes uncommitted reservation',async()=>fixture((_path,db)=>{assert.throws(()=>beginArchiveDeletionIn(db,'thread',2,confirmation),/transaction/);db.exec('BEGIN IMMEDIATE');beginArchiveDeletionIn(db,'thread',2,confirmation);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.equal(fence(db),undefined);}));
test('invalid target and nonfinite timestamp cannot persist fence',async()=>fixture((path,db)=>{for(const now of [NaN,Infinity,-Infinity])assert.throws(()=>begin(path,'thread',now,confirmation),/invalid/);assert.throws(()=>begin(path,'',2,confirmation),/invalid/);assert.equal(fence(db),undefined);}));
test('new ingress is fenced durably after reservation',async()=>fixture((path,db)=>{begin(path,'thread',2,confirmation);db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('new','message',3,7,'{}','staged','received','thread',3,3)");const row=db.prepare("SELECT state,phase FROM discord_ingress_journal WHERE ingress_id='new'").get();assert.equal(row?.state,'held');assert.equal(row?.phase,'archive_fenced');}));
test('owned mirror deletion removes only selected mapping and cursor, retaining recovery fence',async()=>fixture((path,db)=>{
 db.exec("INSERT INTO mirror_threads VALUES('other','p','other',2,4,1); INSERT INTO codex_session_mirror_offsets VALUES('thread','r',1,1,NULL); INSERT INTO codex_session_mirror_offsets VALUES('other','r2',2,1,NULL)");
 const token=begin(path,'thread',2,confirmation);assert.throws(()=>deleteMapping(path,'thread','wrong'),/ownership/);assert.deepEqual(deleteMapping(path,'thread',token),{mirrorThreads:1n,sessionMirrorOffsets:1n});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mirror_threads').get()?.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_session_mirror_offsets').get()?.n,1);assert.equal(fence(db)?.phase,'deleting');complete(path,'thread',token);assert.throws(()=>deleteMapping(path,'thread',token),/ownership/);
}));
test('second mapping delete failure rolls back first and keeps original fence',async()=>fixture((path,db)=>{
 db.exec("INSERT INTO codex_session_mirror_offsets VALUES('thread','r',1,1,NULL); CREATE TRIGGER no_cursor_delete BEFORE DELETE ON codex_session_mirror_offsets BEGIN SELECT RAISE(ABORT,'cursor protected'); END");const token=begin(path,'thread',2,confirmation);assert.throws(()=>deleteMapping(path,'thread',token),/cursor protected/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mirror_threads').get()?.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_session_mirror_offsets').get()?.n,1);assert.equal(fence(db)?.token,token);assert.equal(fence(db)?.phase,'deleting');
}));
test('ignored mapping deletion fails postcondition and retains rows',async()=>fixture((path,db)=>{
 db.exec("CREATE TRIGGER ignored_mapping BEFORE DELETE ON mirror_threads BEGIN SELECT RAISE(IGNORE); END");const token=begin(path,'thread',2,confirmation);assert.throws(()=>deleteMapping(path,'thread',token),/postcondition/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mirror_threads').get()?.n,1);assert.equal(fence(db)?.phase,'deleting');
}));
