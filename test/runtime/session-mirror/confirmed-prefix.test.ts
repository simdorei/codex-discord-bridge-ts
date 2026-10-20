import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';import {NativeMirrorReceiptStore} from '../../../src/runtime/session-mirror/receipt-store.ts';
import {captureMirrorCursorAnchor,observeAnchoredMirrorBatch,type AnchoredMirrorBatch} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {planMixedMirrorReceiptsOffThread,MirrorReceiptPlan} from '../../../src/runtime/session-mirror/receipt-plan.ts';
import {prepareMixedMirrorPacket,mixedMirrorPacketSendPlan,commitMixedMirrorPacket} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';import type {BoundMirrorCursor} from '../../../src/store/mirror-cursor-journal.ts';import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';
async function fixture(run:(path:string,observation:AnchoredMirrorBatch,expected:BoundMirrorCursor,store:NativeMirrorReceiptStore,cursor:NativeMirrorCursorStore)=>Promise<void>){await storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1)}finally{db.close()}
 const cursor=new NativeMirrorCursorStore(path),store=new NativeMirrorReceiptStore(path,'thread',42n);try{await cursor.initializeSchema();const anchor=(await captureMirrorCursorAnchor(file,0n)).anchor,expected=await cursor.initializeFresh('thread',anchor,'turn',1,'init');await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'x'.repeat(4000)}})+'\n');const observation=await observeAnchoredMirrorBatch(anchor,{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},{thread:'thread',detail:'All',currentTurn:'turn'});await run(path,observation,expected,store,cursor)}finally{await store.close();await cursor.close()}
})}
test('confirmed native whole item bypasses repeated receipt begin and HTTP but keeps complete receipt coverage',async()=>fixture(async(path,observation,_expected,store)=>{
 const initial=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver']);let calls=0;await initial.sendItem(store,{async sendValidated(){return BigInt(++calls)}},0);assert.ok(calls>1);
 const cached=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver'],undefined,5000,path);assert.equal(cached.itemAlreadyConfirmed(store,0),true);assert.deepEqual(cached.receipts,initial.receipts);
 let begins=0;const begin=NativeMirrorReceiptStore.prototype.begin;NativeMirrorReceiptStore.prototype.begin=function(...args:Parameters<typeof begin>){begins++;return begin.apply(this,args)};
 try{await cached.sendItem(store,{async sendValidated(){assert.fail('duplicate HTTP')}},0);assert.equal(begins,0)}finally{NativeMirrorReceiptStore.prototype.begin=begin}
}));
test('partial confirmed chunk prefix is skipped on explicit retry while rejected chunk remains retryable',async()=>fixture(async(path,observation,_expected,store)=>{
 const initial=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver']);let attempted=0;
 await assert.rejects(initial.sendItem(store,{async sendValidated(){attempted++;if(attempted===2)throw new DiscordTransportFault('Response','429',429);return 1n}},0));
 const cached=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver'],undefined,5000,path);assert.equal(cached.itemAlreadyConfirmed(store,0),false);let begins=0,calls=0;const begin=NativeMirrorReceiptStore.prototype.begin;NativeMirrorReceiptStore.prototype.begin=function(...args:Parameters<typeof begin>){begins++;return begin.apply(this,args)};
 try{await cached.sendItem(store,{async sendValidated(){calls++;return BigInt(10+calls)}},0);assert.equal(calls,initial.receipts.length-1);assert.equal(begins,initial.receipts.length-1)}finally{NativeMirrorReceiptStore.prototype.begin=begin}
}));
test('cached confirmation cannot be used with different database, thread or channel native owner',async()=>fixture(async(path,observation,_expected,store)=>{
 const initial=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver']);await initial.sendItem(store,{async sendValidated(){return 1n}},0);const cached=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver'],undefined,5000,path);
 for(const other of [new NativeMirrorReceiptStore(path+'.other','thread',42n),new NativeMirrorReceiptStore(path,'other',42n),new NativeMirrorReceiptStore(path,'thread',43n)])try{assert.throws(()=>cached.itemAlreadyConfirmed(other,0),/different owner/);await assert.rejects(cached.sendItem(other,{async sendValidated(){assert.fail('HTTP')}},0),/different owner/)}finally{await other.close()}
 assert.equal(existsSync(path+'.other'),false);assert.throws(()=>MirrorReceiptPlan.prototype.itemAlreadyConfirmed.call(new Proxy(cached,{}),store,0),TypeError);
}));
test('receipt deleted after cached snapshot blocks final cursor transaction without automatic resend',async()=>fixture(async(path,observation,expected,store,cursor)=>{
 const initial=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver']);await initial.sendItem(store,{async sendValidated(){return 1n}},0);
 const packet=await prepareMixedMirrorPacket(expected,observation,42n,2,'advance',['Deliver'],undefined,path),plan=mixedMirrorPacketSendPlan(packet);assert.equal(plan.itemAlreadyConfirmed(store,0),true);
 const db=await openInitialized(path);try{db.prepare('DELETE FROM codex_delivery_receipts WHERE receipt_key=?').run(packet.receipts[0]!.key)}finally{db.close()}
 await plan.sendItem(store,{async sendValidated(){assert.fail('No automatic resend after snapshot')}},0);
 await assert.rejects(commitMixedMirrorPacket(cursor,packet,{maxJobs:32n,maxValueBytes:1048576n}));assert.equal((await cursor.read('thread'))!.revision,1n);
}));
test('missing snapshot database is never initialized and preabort prevents even cached chunk work',async()=>fixture(async(path,observation,_expected,store)=>{
 const missing=path+'.missing';await assert.rejects(planMixedMirrorReceiptsOffThread(observation,42n,['Deliver'],undefined,5000,missing));assert.equal(existsSync(missing),false);
 const plan=await planMixedMirrorReceiptsOffThread(observation,42n,['Deliver'],undefined,5000,path),c=new AbortController(),reason={stop:true};c.abort(reason);await assert.rejects(plan.sendItem(store,{async sendValidated(){assert.fail('HTTP')}},0,c.signal),e=>e===reason);
}));
