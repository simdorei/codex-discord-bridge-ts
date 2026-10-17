import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {NativeMirrorReceiptStore,MirrorReceiptWriteUnconfirmedError} from '../../../src/runtime/session-mirror/receipt-store.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
import {collectSessionItems,formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
import {sessionMirrorIdentity,sessionMirrorReceiptExpectations} from '../../../src/runtime/session-mirror/sender.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
const thread='한:thread',channel=42n,turn='회:1😀';
function planned(kind='agent_message',target=thread,ch=channel){
 const payload=kind==='agent_message'?{type:kind,message:'한😀'}:{type:'task_complete',turn_id:turn,last_agent_message:'final'};
 const item=collectSessionItems(target,[{type:'event_msg',payload}],'Send',turn).items[0]!;
 return sessionMirrorReceiptExpectations(ch,sessionMirrorIdentity(target,item),formatMirrorItem(item))[0]!;
}
async function fixture(run:(path:string,store:NativeMirrorReceiptStore)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(thread,'project','title',1n,channel,1);db.close();
 const store=new NativeMirrorReceiptStore(path,thread,channel);try{await run(path,store)}finally{await store.close()}
});}
test('native mirror intents preserve New Unknown Delivered and content conflict across both domains',async()=>fixture(async(_path,store)=>{
 for(const kind of ['agent_message','task_complete']){
  const p=planned(kind);assert.equal((await store.begin(p.key,p.contentHash)).kind,'New');
  assert.equal((await store.begin(p.key,p.contentHash)).kind,'Unknown');
  assert.equal(await store.confirm(p.key,p.contentHash,'18446744073709551615'),true);
  assert.deepEqual(await store.begin(p.key,p.contentHash),{kind:'Delivered',messageId:'18446744073709551615'});
  assert.equal((await store.begin(p.key,'b'.repeat(64))).kind,'ContentConflict');
  assert.equal(await store.confirm(p.key,p.contentHash,'2'),false);
 }
 assert.equal(ownedWorkerUsage().Background,0);
}));
test('only explicit rejection release permits one new attempt, blocked reasons keep 1000 scalars',async()=>fixture(async(_path,store)=>{
 const p=planned();await store.begin(p.key,p.contentHash);assert.equal(await store.releaseRejected(p.key,p.contentHash),true);
 assert.equal((await store.begin(p.key,p.contentHash)).kind,'New');assert.equal((await store.begin(p.key,p.contentHash)).kind,'Unknown');
 assert.equal(await store.blockRejected(p.key,p.contentHash,'😀'.repeat(1001)),true);
 assert.equal(await store.releaseRejected(p.key,p.contentHash),false);
 assert.deepEqual(await store.begin(p.key,p.contentHash),{kind:'RejectedBlocked',reason:'😀'.repeat(1000)});
}));
test('current mapping is required for intent but already attempted receipt remains confirmable after remap',async()=>fixture(async(path,store)=>{
 const p=planned();await store.begin(p.key,p.contentHash);const db=await openInitialized(path);try{db.exec('UPDATE mirror_threads SET discord_thread_id=43')}finally{db.close()}
 await assert.rejects(store.begin(p.key,p.contentHash),MirrorReceiptWriteUnconfirmedError);
 assert.equal(await store.confirm(p.key,p.contentHash,'10'),true);
 const check=await openInitialized(path);try{assert.equal(check.prepare('SELECT message_id AS m FROM codex_delivery_receipts').get()!.m,'10')}finally{check.close()}
}));
test('wrong thread/channel/domain keys never create receipt intents',async()=>fixture(async(path,store)=>{
 const hash='a'.repeat(64);
 for(const p of [planned('agent_message','foreign'),planned('task_complete','foreign'),planned('agent_message',thread,43n),{key:serializeSerdeValue([42n,'completion/v1','job',0n]),contentHash:hash}]){
  await assert.rejects(store.begin(p.key,p.contentHash),MirrorReceiptWriteUnconfirmedError);
 }
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts').get()!.n,0)}finally{db.close()}
}));
test('cancelled begin joins actual intent and later observation is Unknown, never another New',async()=>fixture(async(_path,store)=>{
 const p=planned(),controller=new AbortController(),reason=Error('cancel');const pending=store.begin(p.key,p.contentHash,controller.signal);controller.abort(reason);
 await assert.rejects(pending,e=>e instanceof MirrorReceiptWriteUnconfirmedError&&e.cause===reason);
 assert.equal(store.busy,false);assert.equal((await store.begin(p.key,p.contentHash)).kind,'Unknown');
}));
test('expired confirmation joins actual accepted receipt and fresh owner sees Delivered',async()=>fixture(async(path,store)=>{
 const p=planned();await store.begin(p.key,p.contentHash);const short=new NativeMirrorReceiptStore(path,thread,channel,1);
 try{await assert.rejects(short.confirm(p.key,p.contentHash,'10'),MirrorReceiptWriteUnconfirmedError);assert.equal(short.busy,false)}finally{await short.close()}
 assert.deepEqual(await store.begin(p.key,p.contentHash),{kind:'Delivered',messageId:'10'});
}));
test('close and overlap retain native ownership; absent store and pre-abort never create files',async()=>fixture(async(path,store)=>{
 const p=planned(),pending=store.begin(p.key,p.contentHash),checked=assert.rejects(pending,MirrorReceiptWriteUnconfirmedError);
 await assert.rejects(store.begin(p.key,p.contentHash),OwnedWorkerBusyError);await store.close();await checked;
 assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(store.begin(p.key,p.contentHash),/closed/);
 const missing=path+'.absent',fresh=new NativeMirrorReceiptStore(missing,thread,channel),controller=new AbortController(),reason=Error('pre');controller.abort(reason);
 try{await assert.rejects(fresh.begin(p.key,p.contentHash,controller.signal),e=>e===reason);await assert.rejects(fresh.begin(p.key,p.contentHash),MirrorReceiptWriteUnconfirmedError);assert.equal(existsSync(missing),false)}finally{await fresh.close()}
}));
test('corrupt oversize stored values are held before unbounded row decoding',async()=>fixture(async(path,store)=>{
 const p=planned();await store.begin(p.key,p.contentHash);const db=await openInitialized(path);try{db.prepare('UPDATE codex_delivery_receipts SET blocked_reason=?').run('x'.repeat(8001))}finally{db.close()}
 await assert.rejects(store.begin(p.key,p.contentHash),MirrorReceiptWriteUnconfirmedError);
}));
test('confirmation hash mismatch and trigger-altered message are refused and rolled back',async()=>fixture(async(path,store)=>{
 const p=planned();await store.begin(p.key,p.contentHash);
 await assert.rejects(store.confirm(p.key,'b'.repeat(64),'10'),MirrorReceiptWriteUnconfirmedError);
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER corrupt AFTER UPDATE OF message_id ON codex_delivery_receipts BEGIN UPDATE codex_delivery_receipts SET message_id='11'; END")}finally{db.close()}
 await assert.rejects(store.confirm(p.key,p.contentHash,'10'),MirrorReceiptWriteUnconfirmedError);
 const check=await openInitialized(path);try{assert.equal(check.prepare('SELECT message_id AS m FROM codex_delivery_receipts').get()!.m,null)}finally{check.close()}
}));
test('invalid message or request bounds fail before any native work',async()=>fixture(async(_path,store)=>{
 const p=planned();for(const id of ['0','01','-1','18446744073709551616','1\n'])await assert.rejects(store.confirm(p.key,p.contentHash,id),TypeError);
 await assert.rejects(store.begin('x'.repeat(65537),p.contentHash),RangeError);await assert.rejects(store.blockRejected(p.key,p.contentHash,'x'.repeat(16385)),RangeError);
 assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);
}));
