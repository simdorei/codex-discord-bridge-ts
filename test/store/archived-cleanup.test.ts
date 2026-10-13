import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {beginArchivedCleanup as begin,archivedCleanupPendingReason as pending} from '../../src/store/archived-cleanup.ts';
import {beginRoomCleanup,roomCleanupPhase,releaseRejectedRoomCleanup,completeRoomCleanup} from '../../src/store/room-cleanup.ts';
import {roomCleanupPendingReasonReadonly} from '../../src/store/room-cleanup-pending.ts';
import {archivedIngressPreservedIn} from '../../src/store/ingress-recovery.ts';
const payload=serializeSerdeValue({busy_action:'steer',busy_choice:{choice_id:'choice',owner_user_id:7n,channel_id:3n,target_thread_id:'thread',prompt:'p',allow_steer:false,created_at:10,expires_at:20}});
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{
 db.exec("INSERT INTO mirror_threads VALUES('thread','p','title',2,3,1)");db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,canonical_owner,outcome_json,confirmation_delivered,created_at,updated_at) VALUES('interaction:1','interaction',1,3,7,?,'held','result_recorded','thread','busy-choice:choice',?,0,10,11)").run(payload,'{"kind":"busy_control_preflight_rejected","control_dispatched":false}');await run(path,db);
 }finally{db.close();}});}
const audit=(db:DatabaseSync)=>db.prepare('SELECT * FROM cdr_archived_cleanup_evidence').all();
test('exact exclusion, fence and audit commit together without claiming notification delivery',async()=>fixture(async(path,db)=>{
 assert.equal(roomCleanupPendingReasonReadonly(path,3n,'thread'),'ingress');assert.equal(pending(path,3n,'thread',20),null);let verified=0;const token=await begin(path,3n,'thread',2n,20,()=>{verified++;return '{"archived":true}';});assert.equal(verified,1);assert.equal(await roomCleanupPhase(path,3n),'deleting');assert.equal(audit(db).length,1);assert.equal(audit(db)[0]!.token,token);assert.equal(audit(db)[0]!.payload_json,payload);assert.equal(archivedIngressPreservedIn(db,'interaction:1'),true);assert.equal(db.prepare("SELECT confirmation_delivered FROM discord_ingress_journal").get()?.confirmation_delivered,0);await completeRoomCleanup(path,3n,token);assert.equal(archivedIngressPreservedIn(db,'interaction:1'),true);
}));
test('ordinary cleanup still rejects the identical ingress without an exclusion',async()=>fixture(async(path,db)=>{
 await assert.rejects(beginRoomCleanup(path,3n,'thread',20),/ingress/);assert.equal(audit(db).length,0);assert.equal(await roomCleanupPhase(path,3n),null);
}));
for(const mode of ['throw','bad-json','not-string'] as const)test('verification '+mode+' rolls back both audit and fence',async()=>fixture(async(path,db)=>{
 await assert.rejects(begin(path,3n,'thread',2n,20,()=>{if(mode==='throw')throw new Error('archive changed');return mode==='bad-json'?'{':null as unknown as string;}));assert.equal(audit(db).length,0);assert.equal(await roomCleanupPhase(path,3n),null);
}));
test('wrong parent and duplicate owner reject before archive callback',async()=>fixture(async(path,db)=>{
 let calls=0;const verify=()=>{calls++;return '{}';};await assert.rejects(begin(path,3n,'thread',9n,20,verify),/parent identity/);db.exec("INSERT INTO mirror_threads VALUES('other','p','title',2,3,1)");await assert.rejects(begin(path,3n,'thread',2n,20,verify),/mapping identity/);assert.equal(calls,0);assert.equal(audit(db).length,0);
}));
test('a different pending ingress still blocks the exception and callback',async()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('ordinary','message',3,7,'{}','staged','received','thread',1,1)");assert.equal(pending(path,3n,'thread',20),'ingress');let calls=0;await assert.rejects(begin(path,3n,'thread',2n,20,()=>{calls++;return '{}';}),/ingress/);assert.equal(calls,0);assert.equal(audit(db).length,0);
}));
test('ignored audit insert cannot leave a successful cleanup fence',async()=>fixture(async(path,db)=>{
 db.exec("CREATE TRIGGER ignored_audit BEFORE INSERT ON cdr_archived_cleanup_evidence BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(begin(path,3n,'thread',2n,20,()=> '{}'),/not inserted/);assert.equal(audit(db).length,0);assert.equal(await roomCleanupPhase(path,3n),null);
}));
test('released deletion intent leaves immutable audit but cannot suppress recovery',async()=>fixture(async(path,db)=>{
 const token=await begin(path,3n,'thread',2n,20,()=> '{}');await releaseRejectedRoomCleanup(path,3n,token);assert.equal(audit(db).length,1);assert.equal(archivedIngressPreservedIn(db,'interaction:1'),false);assert.throws(()=>db.exec('DELETE FROM cdr_archived_cleanup_evidence'),/append-only/);
}));
test('mutated held row no longer matches the preserved exact audit',async()=>fixture(async(path,db)=>{
 await begin(path,3n,'thread',2n,20,()=> '{}');db.exec('UPDATE discord_ingress_journal SET updated_at=12');assert.equal(archivedIngressPreservedIn(db,'interaction:1'),false);
}));

test('synchronous callback returning rejected Promise is rejected and observed without commit',async()=>fixture(async(path,db)=>{
 await assert.rejects(begin(path,3n,'thread',2n,20,()=>Promise.reject(new Error('async forbidden')) as unknown as string),/returned a Promise/);assert.equal(audit(db).length,0);assert.equal(await roomCleanupPhase(path,3n),null);
}));
