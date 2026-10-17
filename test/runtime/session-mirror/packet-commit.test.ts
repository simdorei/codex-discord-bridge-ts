import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {prepareAllDeliveredMirrorPacket as prepare,commitAllDeliveredMirrorPacket as commit,reconcileAllDeliveredMirrorPacket as reconcile,type AllDeliveredMirrorPacket} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {sendSessionMirrorText,sessionMirrorIdentity} from '../../../src/runtime/session-mirror/sender.ts';import {formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
import {MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
const limits={maxWindowBytes:8192,maxRecordBytes:4096,maxRecords:20,decodeTimeoutMs:5000},options={thread:'thread',detail:'Send' as const,currentTurn:'turn'};
const line=JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'한국어 hello'}})+'\n';
async function fixture(run:(path:string,file:string,store:NativeMirrorCursorStore,packet:AllDeliveredMirrorPacket,send:()=>Promise<void>)=>Promise<void>){
 await storeFixture(async path=>{
  const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);
  db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);db.close();
  const store=new NativeMirrorCursorStore(path);
  try{
   await store.initializeSchema();const anchor=(await capture(file,0n)).anchor,old=await store.initializeFresh('thread',anchor,'turn',1,'init');
   await appendFile(file,line);const batch=await observe(anchor,limits,options),packet=await prepare(old,batch,42n,2,'advance');
   const send=async()=>{for(const item of batch.batch.items)await sendSessionMirrorText(path,{async sendValidated(){return 10n}},42n,sessionMirrorIdentity('thread',item),formatMirrorItem(item))};
   await run(path,file,store,packet,send);
  }finally{await store.close()}
 });
}
test('authentic packet connects actual send receipts, file recheck, mapped native commit and read reconciliation',async()=>fixture(async(_path,_file,store,packet,send)=>{
 assert.equal((await reconcile(store,packet)).kind,'CurrentCursorUnchanged');
 await assert.rejects(commit(store,packet),MirrorCursorWriteUnconfirmedError);
 assert.equal((await reconcile(store,packet)).kind,'CurrentCursorUnchanged');
 await send();const result=await commit(store,packet);assert.equal(result.revision,2n);
 const observed=await reconcile(store,packet);assert.equal(observed.kind,'Committed');assert.deepEqual(observed.cursor,result);
 assert.deepEqual(await commit(store,packet),result);
}));
test('file append after preparation blocks new cursor write even when receipts are complete',async()=>fixture(async(_path,file,store,packet,send)=>{
 await send();await appendFile(file,'{}\n');await assert.rejects(commit(store,packet),MirrorFileChangedError);
 assert.equal((await reconcile(store,packet)).kind,'CurrentCursorUnchanged');
}));
test('current mapping change refuses commit and never retargets the packet',async()=>fixture(async(path,_file,store,packet,send)=>{
 await send();const db=await openInitialized(path);try{db.exec('UPDATE mirror_threads SET discord_thread_id=43')}finally{db.close()}
 await assert.rejects(commit(store,packet),MirrorCursorWriteUnconfirmedError);assert.equal(packet.channel,42n);
 assert.equal((await reconcile(store,packet)).kind,'CurrentCursorUnchanged');
}));
test('expired write joins actual native commit and reconciles after file and mapping later change',async()=>fixture(async(path,file,store,packet,send)=>{
 await send();const short=new NativeMirrorCursorStore(path,1);
 try{await assert.rejects(commit(short,packet),MirrorCursorWriteUnconfirmedError);assert.equal(short.busy,false)}finally{await short.close()}
 await appendFile(file,'{}\n');const db=await openInitialized(path);try{db.exec('UPDATE mirror_threads SET discord_thread_id=43')}finally{db.close()}
 const result=await reconcile(store,packet);assert.equal(result.kind,'Committed');assert.equal(result.cursor!.operationId,'advance');
 await assert.rejects(commit(store,packet),MirrorFileChangedError);
}));
test('copied, accessor and proxy packet cannot omit receipts or invoke hooks',async()=>fixture(async(_path,_file,store,packet)=>{
 let calls=0;const forged={get expected(){calls++;return packet.expected}} as AllDeliveredMirrorPacket;
 for(const candidate of [{...packet,receipts:[]},forged,new Proxy(packet,{get(){calls++;throw Error('proxy')}})]){
  await assert.rejects(commit(store,candidate),TypeError);await assert.rejects(reconcile(store,candidate),TypeError);
 }
 assert.equal(calls,0);assert.equal((await reconcile(store,packet)).kind,'CurrentCursorUnchanged');
}));
test('other durable revision or receipt set is conflict, never successful reconciliation',async()=>fixture(async(_path,_file,store,packet,send)=>{
 await send();await store.advanceMapped(packet.expected,packet.anchor,packet.turn,packet.updatedAt,packet.operationId,[],packet.channel);
 assert.equal((await reconcile(store,packet)).kind,'Conflict');
}));
test('pre-aborted commit and read preserve exact reason without storage effects',async()=>fixture(async(_path,_file,store,packet)=>{
 const controller=new AbortController(),reason=Error('stop');controller.abort(reason);
 await assert.rejects(commit(store,packet,controller.signal),e=>e===reason);await assert.rejects(reconcile(store,packet,controller.signal),e=>e===reason);
 assert.equal((await reconcile(store,packet)).kind,'CurrentCursorUnchanged');
}));
