import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {prepareMixedMirrorPacket as prepare,mixedMirrorPacketSendPlan as plan,commitMixedMirrorPacket as commit,reconcileMixedMirrorPacket as reconcile,commitAllDeliveredMirrorPacket,mirrorPacketSendPlan} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError} from '../../../src/runtime/session-mirror/cursor-store.ts';import {NativeMirrorReceiptStore} from '../../../src/runtime/session-mirror/receipt-store.ts';
import type {MirrorDeliveryMode} from '../../../src/runtime/session-mirror/receipt-plan.ts';
const limits={maxJobs:32n,maxValueBytes:1048576n};
async function context(path:string){
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);db.close();
 const cursor=new NativeMirrorCursorStore(path),receipt=new NativeMirrorReceiptStore(path,'thread',42n);
 await cursor.initializeSchema();const anchor=(await capture(file,0n)).anchor,old=await cursor.initializeFresh('thread',anchor,'turn',1,'init');
 await appendFile(file,['handled','deliver'].map(message=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message}})+'\n').join(''));
 const batch=await observe(anchor,{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},{thread:'thread',detail:'All',currentTurn:'turn'});
 return {file,cursor,receipt,old,batch};
}
async function fixture(run:(c:Awaited<ReturnType<typeof context>>,path:string)=>Promise<void>){await storeFixture(async path=>{const c=await context(path);try{await run(c,path)}finally{await c.receipt.close();await c.cursor.close()}})}
async function mark(path:string,digest:string){const db=await openInitialized(path);try{db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(digest,'thread')}finally{db.close()}}
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql)}finally{db.close()}}
test('authentic mixed packet covers every item and commits one confirmed send plus one durable skip',async()=>fixture(async(c,path)=>{
 await mark(path,c.batch.batch.items[0]!.digest);const packet=await prepare(c.old,c.batch,42n,2,'op',['Skip','Deliver']);let calls=0;
 await plan(packet).sendItem(c.receipt,{async sendValidated(){calls++;return 10n}},1);const next=await commit(c.cursor,packet,limits);
 assert.equal(next.revision,2n);assert.equal(packet.itemCount,2);assert.equal(calls,1);assert.equal((await reconcile(c.cursor,packet)).kind,'Committed');
 await assert.rejects(plan(packet).sendItem(c.receipt,{async sendValidated(){calls++;return 11n}},0),/Skipped/);assert.equal(calls,1);
}));
test('missing skip proof and missing last delivery both retain whole cursor',async()=>fixture(async(c,path)=>{
 const packet=await prepare(c.old,c.batch,42n,2,'op',['Skip','Deliver']);await plan(packet).sendItem(c.receipt,{async sendValidated(){return 10n}},1);
 await assert.rejects(commit(c.cursor,packet,limits),MirrorCursorWriteUnconfirmedError);assert.equal((await c.cursor.read('thread'))!.revision,1n);
 await mark(path,c.batch.batch.items[0]!.digest);await edit(path,'DELETE FROM codex_delivery_receipts');await assert.rejects(commit(c.cursor,packet,limits),MirrorCursorWriteUnconfirmedError);assert.equal((await c.cursor.read('thread'))!.revision,1n);
}));
test('mixed packet cannot bypass skip proof through all-delivered API, copy or proxy',async()=>fixture(async c=>{
 const packet=await prepare(c.old,c.batch,42n,2,'op',['Skip','Skip']);let calls=0;
 await assert.rejects(commitAllDeliveredMirrorPacket(c.cursor,packet),TypeError);assert.throws(()=>mirrorPacketSendPlan(packet),TypeError);
 await assert.rejects(commit(c.cursor,{...packet},limits),TypeError);await assert.rejects(commit(c.cursor,new Proxy(packet,{get(){calls++;throw Error('hook')}}),limits),TypeError);assert.equal(calls,0);assert.equal((await c.cursor.read('thread'))!.revision,1n);
}));
test('all-skipped packet advances only when each authentic digest has current proof',async()=>fixture(async(c,path)=>{
 const packet=await prepare(c.old,c.batch,42n,2,'op',['Skip','Skip']);assert.deepEqual(packet.receipts,[]);
 await mark(path,c.batch.batch.items[0]!.digest);await assert.rejects(commit(c.cursor,packet,limits),MirrorCursorWriteUnconfirmedError);
 await mark(path,c.batch.batch.items[1]!.digest);assert.equal((await commit(c.cursor,packet,limits)).revision,2n);
}));
test('post-write skip revocation rolls back mixed packet and keeps prior marker',async()=>fixture(async(c,path)=>{
 await mark(path,c.batch.batch.items[0]!.digest);const packet=await prepare(c.old,c.batch,42n,2,'op',['Skip','Deliver']);await plan(packet).sendItem(c.receipt,{async sendValidated(){return 10n}},1);
 await edit(path,'CREATE TRIGGER erase_marker AFTER UPDATE ON codex_session_mirror_offsets BEGIN DELETE FROM codex_session_mirror_events;END');
 await assert.rejects(commit(c.cursor,packet,limits),MirrorCursorWriteUnconfirmedError);assert.equal((await c.cursor.read('thread'))!.revision,1n);
 await edit(path,'DROP TRIGGER erase_marker');assert.equal((await commit(c.cursor,packet,limits)).revision,2n);
}));
test('exact mixed packet read reconciliation works after a later marker or mapping change',async()=>fixture(async(c,path)=>{
 for(const item of c.batch.batch.items)await mark(path,item.digest);const packet=await prepare(c.old,c.batch,42n,2,'op',['Skip','Skip']);await commit(c.cursor,packet,limits);
 await edit(path,'DELETE FROM codex_session_mirror_events;UPDATE mirror_threads SET discord_thread_id=43');await assert.rejects(commit(c.cursor,packet,limits),MirrorCursorWriteUnconfirmedError);assert.equal((await reconcile(c.cursor,packet)).kind,'Committed');
}));
test('decisions cannot be omitted or mutated while planning and later file changes hold commit',async()=>fixture(async(c,path)=>{
 await assert.rejects(prepare(c.old,c.batch,42n,2,'bad',['Skip']),TypeError);
 const modes:MirrorDeliveryMode[]=['Skip','Deliver'],pending=prepare(c.old,c.batch,42n,2,'op',modes);modes.fill('Skip');const packet=await pending;assert.deepEqual(packet.deliveryModes,['Skip','Deliver']);assert.ok(Object.isFrozen(packet.deliveryModes));
 await mark(path,c.batch.batch.items[0]!.digest);await plan(packet).sendItem(c.receipt,{async sendValidated(){return 10n}},1);await appendFile(c.file,'{}\n');await assert.rejects(commit(c.cursor,packet,limits));assert.equal((await c.cursor.read('thread'))!.revision,1n);
}));
