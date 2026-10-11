import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {prepareAllDeliveredMirrorPacket as prepare,mirrorPacketSendPlan,commitAllDeliveredMirrorPacket as commit,type AllDeliveredMirrorPacket} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';
import {MirrorReceiptPlan} from '../../../src/runtime/session-mirror/receipt-plan.ts';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorReceiptStore} from '../../../src/runtime/session-mirror/receipt-store.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';
import {splitDeliveryChunks} from '../../../src/discord/text.ts';
const line=(text:string)=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:text}})+'\n';
async function fixture(content:string,run:(path:string,cursor:NativeMirrorCursorStore,receipt:NativeMirrorReceiptStore,packet:AllDeliveredMirrorPacket)=>Promise<void>){
 await storeFixture(async path=>{
  const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);
  db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);db.close();
  const cursor=new NativeMirrorCursorStore(path),receipt=new NativeMirrorReceiptStore(path,'thread',42n);
  try{
   await cursor.initializeSchema();const anchor=(await capture(file,0n)).anchor,old=await cursor.initializeFresh('thread',anchor,'turn',1,'init');await appendFile(file,content);
   const batch=await observe(anchor,{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},{thread:'thread',detail:'Send',currentTurn:'turn'});
   await run(path,cursor,receipt,await prepare(old,batch,42n,2,'advance'));
  }finally{await receipt.close();await cursor.close()}
 });
}
test('one native plan sends exact marked Unicode chunks, all receipts and mapped cursor commit end to end',async()=>fixture(line('한😀'.repeat(1200))+line('second'),async(_path,cursor,receipt,packet)=>{
 const plan=mirrorPacketSendPlan(packet);assert.equal(plan.itemCount,2);assert.equal(mirrorPacketSendPlan(packet),plan);
 const bodies:string[]=[];const transport={async sendValidated(request:{body:string}){bodies.push(JSON.parse(request.body).content);return BigInt(bodies.length)}};
 await plan.sendItem(receipt,transport,0);
 await assert.rejects(commit(cursor,packet),MirrorCursorWriteUnconfirmedError);
 await plan.sendItem(receipt,transport,1);
 const next=await commit(cursor,packet);assert.equal(next.revision,2n);assert.equal(bodies.length,plan.receipts.length);
 assert.deepEqual(bodies,[...splitDeliveryChunks('In progress\n\n'+'한😀'.repeat(1200),true),...splitDeliveryChunks('In progress\n\nsecond',true)]);
 await plan.sendItem(receipt,transport,0);assert.equal(bodies.length,plan.receipts.length);
}));
test('partial unknown receipt holds later chunks and whole cursor across repeated explicit item call',async()=>fixture(line('x'.repeat(6000)),async(_path,cursor,receipt,packet)=>{
 const plan=mirrorPacketSendPlan(packet);let calls=0;
 const transport={async sendValidated(){if(++calls===2)throw new DiscordTransportFault('Transport','unknown');return 10n}};
 await assert.rejects(plan.sendItem(receipt,transport,0),e=>e instanceof DeliveryFailure&&e.part===2&&e.attempts===1);
 await assert.rejects(plan.sendItem(receipt,transport,0),e=>e instanceof DeliveryFailure&&e.part===2);assert.equal(calls,2);
 await assert.rejects(commit(cursor,packet),MirrorCursorWriteUnconfirmedError);assert.equal((await cursor.read('thread'))!.revision,1n);
}));
test('cancelled in-flight first chunk retains its confirmed receipt and starts no later chunk',async()=>fixture(line('x'.repeat(6000)),async(path,_cursor,receipt,packet)=>{
 const plan=mirrorPacketSendPlan(packet);let enter!:()=>void,finish!:(id:bigint)=>void,calls=0;const entered=new Promise<void>(r=>enter=r),controller=new AbortController(),reason=Error('stop');
 const pending=plan.sendItem(receipt,{async sendValidated(){calls++;enter();return new Promise<bigint>(r=>finish=r)}},0,controller.signal);
 await entered;controller.abort(reason);finish(10n);
 await assert.rejects(pending,e=>e instanceof DeliveryFailure&&e.source===reason);assert.equal(calls,1);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1)}finally{db.close()}
}));
test('changed mapping prevents the first outbound call despite a previously prepared plan',async()=>fixture(line('hello'),async(path,_cursor,receipt,packet)=>{
 const plan=mirrorPacketSendPlan(packet),db=await openInitialized(path);try{db.exec('UPDATE mirror_threads SET discord_thread_id=43')}finally{db.close()}
 let calls=0;await assert.rejects(plan.sendItem(receipt,{async sendValidated(){calls++;return 10n}},0),DeliveryFailure);assert.equal(calls,0);
}));
test('private plan receiver and copied packet cannot invoke transport or custom getters',async()=>fixture(line('hello'),async(_path,_cursor,receipt,packet)=>{
 let calls=0;const forged=Object.create(MirrorReceiptPlan.prototype);Object.defineProperty(forged,'items',{get(){calls++;throw Error('hook')}});
 await assert.rejects(MirrorReceiptPlan.prototype.sendItem.call(forged,receipt,{async sendValidated(){calls++;return 1n}},0),TypeError);
 assert.throws(()=>mirrorPacketSendPlan({...packet}),TypeError);
 const plan=mirrorPacketSendPlan(packet);for(const index of [-1,1,1.5,NaN])await assert.rejects(plan.sendItem(receipt,{async sendValidated(){calls++;return 1n}},index),RangeError);
 assert.equal(calls,0);assert.ok(Object.isFrozen(plan));
}));
test('pre-aborted plan starts neither storage nor HTTP and retains exact cancellation',async()=>fixture(line('hello'),async(path,_cursor,receipt,packet)=>{
 const plan=mirrorPacketSendPlan(packet),controller=new AbortController(),reason=Error('pre');controller.abort(reason);let calls=0;
 await assert.rejects(plan.sendItem(receipt,{async sendValidated(){calls++;return 1n}},0,controller.signal),e=>e===reason);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts').get()!.n,0)}finally{db.close()}assert.equal(calls,0);
}));
