import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe,AnchoredMirrorBatch} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {planMixedMirrorReceiptsOffThread as plan,planMirrorReceiptsOffThread,snapshotMirrorDeliveryModes,type MirrorDeliveryMode} from '../../../src/runtime/session-mirror/receipt-plan.ts';
import {NativeMirrorReceiptStore} from '../../../src/runtime/session-mirror/receipt-store.ts';import {OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';import {sessionMirrorIdentity,sessionMirrorReceiptExpectations} from '../../../src/runtime/session-mirror/sender.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
async function fixture(run:(batch:AnchoredMirrorBatch,path:string)=>Promise<void>){await storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,['first','second','third'].map(message=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message}})+'\n').join(''));
 const a=(await capture(file,0n)).anchor;const batch=await observe(a,{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},{thread:'thread',detail:'All',currentTurn:'turn'});await run(batch,path);
})}
test('mixed plan preserves original item indices and exact delivered receipt hash without skipped chunks',async()=>fixture(async(batch,path)=>{
 const result=await plan(batch,42n,['Skip','Deliver','Skip']),item=batch.batch.items[1]!,expected=sessionMirrorReceiptExpectations(42n,sessionMirrorIdentity('thread',item),formatMirrorItem(item));
 assert.equal(result.itemCount,3);assert.deepEqual(result.receipts,expected);assert.equal(result.receiptSetHash,createHash('sha256').update(serializeSerdeValue(expected.map(r=>[r.key,r.contentHash]))).digest('hex'));
 const store=new NativeMirrorReceiptStore(path,'thread',42n);let calls=0;try{await assert.rejects(result.sendItem(store,{async sendValidated(){calls++;return 1n}},0),/Skipped/);await assert.rejects(result.sendItem(store,{async sendValidated(){calls++;return 1n}},2),/Skipped/);assert.equal(calls,0);assert.equal(store.busy,false);}finally{await store.close()}
}));
test('all skipped plan has no receipt but grants no cursor or delivery permission',async()=>fixture(async batch=>{
 const result=await plan(batch,42n,['Skip','Skip','Skip']);assert.deepEqual(result.receipts,[]);assert.equal(result.itemCount,3);assert.equal(result.receiptSetHash,createHash('sha256').update('[]').digest('hex'));
}));
test('every authentic item needs an explicit own decision and proxies/getters are never invoked',async()=>fixture(async batch=>{
 for(const value of [[],['Deliver'],Array(3),['Deliver','Wrong','Skip']])await assert.rejects(plan(batch,42n,value as MirrorDeliveryMode[]),TypeError);
 let calls=0;const getter=['Deliver','Deliver','Deliver'] as MirrorDeliveryMode[];Object.defineProperty(getter,'1',{get(){calls++;throw Error('hook')}});await assert.rejects(plan(batch,42n,getter),TypeError);
 const proxy=new Proxy([],{get(){calls++;throw Error('proxy')}});assert.throws(()=>snapshotMirrorDeliveryModes(proxy,0),TypeError);assert.equal(calls,0);assert.equal(ownedWorkerUsage().Background,0);
}));
test('delivery decisions are captured before await and mixed/all planner share one native slot',async()=>fixture(async batch=>{
 const modes:MirrorDeliveryMode[]=['Skip','Deliver','Skip'],pending=plan(batch,42n,modes);modes.fill('Skip');await assert.rejects(planMirrorReceiptsOffThread(batch,42n),OwnedWorkerBusyError);assert.ok((await pending).receipts.length>0);assert.equal(ownedWorkerUsage().Background,0);
}));
test('cancelled mixed planner joins native exit before any successor uses its slot',async()=>fixture(async batch=>{
 const controller=new AbortController(),reason=Error('stop'),pending=plan(batch,42n,['Deliver','Skip','Deliver'],controller.signal);controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);assert.ok((await plan(batch,42n,['Deliver','Skip','Deliver'])).receipts.length>0);
}));
