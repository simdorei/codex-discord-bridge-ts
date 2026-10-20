import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe,AnchoredMirrorBatch} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {prepareAllDeliveredMirrorPacket as prepare} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {sendSessionMirrorText,sessionMirrorIdentity,sessionMirrorReceiptExpectations} from '../../../src/runtime/session-mirror/sender.ts';
import {formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
import {MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
const limits={maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:40,decodeTimeoutMs:5000};
const options={thread:'thread',detail:'Send' as const,currentTurn:'turn'};
const line=(text:string,turn='turn')=>JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:text}})+'\n';
async function fixture(run:(path:string,file:string,store:NativeMirrorCursorStore)=>Promise<void>){
 await storeFixture(async path=>{
  const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');
  const db=await openInitialized(path);db.close();const store=new NativeMirrorCursorStore(path);
  try{await store.initializeSchema();await run(path,file,store)}finally{await store.close()}
 });
}
test('all actual Unicode chunks are required before one native cursor advance',async()=>fixture(async(path,file,store)=>{
 const anchor=(await capture(file,0n)).anchor,expected=await store.initializeFresh('thread',anchor,'turn',1,'init');
 await appendFile(file,line('한😀'.repeat(1200))+line('second','second-turn'));
 const batch=await observe(anchor,limits,options),packet=await prepare(expected,batch,42n,2,'advance');
 assert.equal(packet.itemCount,2);assert.ok(packet.receipts.length>2);assert.equal(packet.historyIntegrityVerified,false);
 assert.deepEqual(batch.expectedAnchor,expected.anchor);assert.notDeepEqual(batch.prior.stamp,expected.anchor.stamp);
 let calls=0;const transport={async sendValidated(){return BigInt(++calls)}};
 const first=batch.batch.items[0]!;
 await sendSessionMirrorText(path,transport,42n,sessionMirrorIdentity('thread',first),formatMirrorItem(first));
 await assert.rejects(store.advance(packet.expected,packet.anchor,packet.turn,packet.updatedAt,packet.operationId,packet.receipts),MirrorCursorWriteUnconfirmedError);
 assert.deepEqual(await store.read('thread'),expected);
 const second=batch.batch.items[1]!;
 await sendSessionMirrorText(path,transport,42n,sessionMirrorIdentity('thread',second),formatMirrorItem(second));
 const next=await store.advance(packet.expected,packet.anchor,packet.turn,packet.updatedAt,packet.operationId,packet.receipts);
 assert.equal(next.anchor.offset,BigInt(Buffer.byteLength(line('한😀'.repeat(1200))+line('second','second-turn'))));assert.equal(calls,packet.receipts.length);
 assert.deepEqual(await store.advance(packet.expected,packet.anchor,packet.turn,packet.updatedAt,packet.operationId,packet.receipts),next);
 assert.equal(calls,packet.receipts.length);
}));
test('changed channel receipts do not satisfy complete packet coverage',async()=>fixture(async(path,file,store)=>{
 const anchor=(await capture(file,0n)).anchor,expected=await store.initializeFresh('thread',anchor,'turn',1,'init');
 await appendFile(file,line('message'));const batch=await observe(anchor,limits,options),packet=await prepare(expected,batch,43n,2,'advance'),item=batch.batch.items[0]!;
 await sendSessionMirrorText(path,{async sendValidated(){return 1n}},42n,sessionMirrorIdentity('thread',item),formatMirrorItem(item));
 await assert.rejects(store.advance(expected,packet.anchor,packet.turn,2,'advance',packet.receipts),MirrorCursorWriteUnconfirmedError);
 assert.deepEqual(await store.read('thread'),expected);
}));
test('no-output prefix can progress while invalid suffix stays beyond cursor',async()=>fixture(async(_path,file,store)=>{
 const anchor=(await capture(file,0n)).anchor,expected=await store.initializeFresh('thread',anchor,'turn',1,'init');
 await appendFile(file,'{}\n{"partial":');const batch=await observe(anchor,limits,options),packet=await prepare(expected,batch,42n,2,'empty');
 assert.equal(packet.itemCount,0);assert.equal(packet.receipts.length,0);assert.equal(packet.anchor.offset,3n);assert.equal(batch.batch.heldSuffix,true);
 assert.equal((await store.advance(expected,packet.anchor,packet.turn,2,'empty',packet.receipts)).anchor.offset,3n);
}));
test('wrong persisted thread, turn or old generation cannot borrow an authentic batch',async()=>fixture(async(_path,file,store)=>{
 const anchor=(await capture(file,0n)).anchor,expected=await store.initializeFresh('thread',anchor,'turn',1,'init');
 await appendFile(file,line('message'));const batch=await observe(anchor,limits,options);
 for(const wrong of [{...expected,thread:'foreign'},{...expected,turn:'foreign'},{...expected,anchor:batch.prior}]){
  await assert.rejects(prepare(wrong,batch,42n,2,'wrong'),/persisted cursor/);
 }
}));
test('post-decode file change and pre-abort cannot manufacture a packet',async()=>fixture(async(_path,file,store)=>{
 const anchor=(await capture(file,0n)).anchor,expected=await store.initializeFresh('thread',anchor,'turn',1,'init');
 await appendFile(file,line('message'));const batch=await observe(anchor,limits,options);await appendFile(file,'{}\n');
 await assert.rejects(prepare(expected,batch,42n,2,'changed'),MirrorFileChangedError);
 const controller=new AbortController(),reason=Error('cancel');controller.abort(reason);
 await assert.rejects(prepare(expected,batch,42n,2,'cancelled',controller.signal),e=>e===reason);
 assert.deepEqual(await store.read('thread'),expected);
}));
test('private brand rejects forged getters and immutable packet captures input before await',async()=>fixture(async(_path,file,store)=>{
 const anchor=(await capture(file,0n)).anchor,expected=await store.initializeFresh('thread',anchor,'turn',1,'init');
 let calls=0;const forged=Object.create(AnchoredMirrorBatch.prototype);
 Object.defineProperty(forged,'expectedAnchor',{get(){calls++;throw Error('getter')}});
 await assert.rejects(prepare(expected,forged,42n,2,'forged'),TypeError);assert.equal(calls,0);
 await appendFile(file,line('message'));const batch=await observe(anchor,limits,options),mutable={...expected};
 const pending=prepare(mutable,batch,42n,2,'captured');mutable.thread='foreign';const packet=await pending;
 assert.equal(packet.expected.thread,'thread');assert.ok(Object.isFrozen(packet));assert.ok(Object.isFrozen(packet.receipts));
 const item=batch.batch.items[0]!;
 assert.deepEqual(packet.receipts,sessionMirrorReceiptExpectations(42n,sessionMirrorIdentity('thread',item),formatMirrorItem(item)));
 for(const [channel,time,id] of [[0n,2,'ok'],[1n<<63n,2,'ok'],[42n,NaN,'ok'],[42n,2,'']] as const)
  await assert.rejects(prepare(expected,batch,channel,time,id));
}));
