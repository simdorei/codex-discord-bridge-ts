import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {beginRoomCleanup as begin,completeRoomCleanup as complete,releaseRejectedRoomCleanup as release,roomCleanupPhase as phase,roomCleanupConfirmedTarget as confirmed,unconfirmedRoomCleanupChannels as unconfirmed,RoomCleanupProtectedError} from '../../src/store/room-cleanup.ts';
import {beginMirrorCategory,beginMirrorCreation,beginMirrorProject} from '../../src/store/state-access-facade.ts';
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function mapping(db:DatabaseSync,target='target',parent=2n,room=3n){db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,1)').run(target,'p','title',parent,room);}
function idle(db:DatabaseSync,state='Candidate'){db.prepare("INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail) VALUES('intent','owner',1,'target','turn','job',0,?,'detail')").run(state);}
test('cleanup records exact ownership, rejects duplicate attempts and retains success tombstone',async()=>fixture(async(path,db)=>{
 mapping(db);const token=await begin(path,3n,'target',1);assert.equal(await phase(path,3n),'deleting');assert.deepEqual(await unconfirmed(path),[3n]);await assert.rejects(begin(path,3n,'target',2),/outcome is fenced/);await assert.rejects(complete(path,3n,'foreign'),/ownership changed/);
 await complete(path,3n,token);assert.equal(await phase(path,3n),'deleted');assert.equal(await confirmed(path,3n,'target'),true);assert.equal(await confirmed(path,3n,'other'),false);assert.deepEqual(await unconfirmed(path),[]);await assert.rejects(release(path,3n,token),/ownership changed/);
}));
test('authoritative rejection releases only its own unfinished attempt',async()=>fixture(async(path,db)=>{
 const token=await begin(path,3n,null,1);await assert.rejects(release(path,3n,'foreign'),/ownership changed/);assert.equal(await phase(path,3n),'deleting');await release(path,3n,token);assert.equal(await phase(path,3n),null);await assert.rejects(release(path,3n,token),/ownership changed/);
}));
test('mapping must be absent for targetless room or exactly one matching target',async()=>fixture(async(path,db)=>{
 mapping(db);await assert.rejects(begin(path,3n,null,1),/mapping identity changed/);await assert.rejects(begin(path,3n,'wrong',1),/mapping identity changed/);mapping(db,'other',2n,4n);await assert.rejects(begin(path,2n,'target',1),/mapping identity changed/);await assert.rejects(begin(path,0n,null,1),/mapping identity changed/);await assert.rejects(begin(path,8n,null,NaN),/mapping identity changed/);
}));
test('thread creation custody protects parent, exact target and orphan cleanup',async()=>fixture(async(path,db)=>{
 await beginMirrorCreation(path,{thread:'creating',guild:1n,parent:2n,expected:null});for(const [id,target] of [[2n,'other'],[99n,'creating'],[99n,null]] as const)await assert.rejects(begin(path,id,target,1),(e:unknown)=>e instanceof RoomCleanupProtectedError&&e.reason==='unresolved mirror creation');assert.deepEqual(await unconfirmed(path),[]);
}));
test('container creation custody protects parent and targetless orphan cleanup',async()=>fixture(async(path,db)=>{
 await beginMirrorProject(path,'p',1n,2n,[],(a,b)=>a===b);await assert.rejects(begin(path,2n,'target',1),(e:unknown)=>e instanceof RoomCleanupProtectedError&&e.reason==='unresolved mirror container creation');await assert.rejects(begin(path,99n,null,1),RoomCleanupProtectedError);
}));
test('an unknown category creation protects unidentified rooms globally',async()=>fixture(async(path,db)=>{
 await beginMirrorCategory(path,1n,null);await assert.rejects(begin(path,99n,null,1),RoomCleanupProtectedError);assert.deepEqual(await unconfirmed(path),[]);
}));
test('idle candidate settles atomically with cleanup fence',async()=>fixture(async(path,db)=>{
 mapping(db);idle(db);await begin(path,3n,'target',1);const row=db.prepare('SELECT state,detail,revision FROM cdr_idle_release').get();assert.deepEqual({...row},{state:'Settled',detail:'CancelledBeforeSend',revision:1});
}));
test('pending work rolls back candidate cancellation and does not create fence',async()=>fixture(async(path,db)=>{
 mapping(db);idle(db);db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,target_thread_id,state,phase,confirmation_delivered,payload_json,created_at,updated_at) VALUES('i','message',3,1,'target','staged','received',0,'{}',1,1)");
 await assert.rejects(begin(path,3n,'target',1),(e:unknown)=>e instanceof RoomCleanupProtectedError&&e.reason==='ingress');assert.equal(db.prepare('SELECT state FROM cdr_idle_release').get()?.state,'Candidate');assert.equal(await phase(path,3n),null);
}));
test('unsettled release state protects cleanup without settling it',async()=>fixture(async(path,db)=>{
 mapping(db);idle(db,'Dispatching');await assert.rejects(begin(path,3n,'target',1),(e:unknown)=>e instanceof RoomCleanupProtectedError&&e.reason==='unsettled idle subscription release');assert.equal(db.prepare('SELECT state FROM cdr_idle_release').get()?.state,'Dispatching');
}));
test('ignored or changed intent insert cannot return a token authorizing remote deletion',async()=>fixture(async(path,db)=>{
 db.exec("CREATE TRIGGER ignore_fence BEFORE INSERT ON cdr_cleanup_fences BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(begin(path,3n,null,1),/not stored exactly/);assert.equal(await phase(path,3n),null);db.exec('DROP TRIGGER ignore_fence');
 db.exec("CREATE TRIGGER change_fence AFTER INSERT ON cdr_cleanup_fences BEGIN UPDATE cdr_cleanup_fences SET token='foreign' WHERE channel_id=NEW.channel_id; END");await assert.rejects(begin(path,3n,null,1),/not stored exactly/);assert.equal(await phase(path,3n),null);
}));
