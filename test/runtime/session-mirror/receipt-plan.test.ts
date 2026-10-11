import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';import {storeFixture} from '../../helpers/store-fixture.ts';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe,AnchoredMirrorBatch} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {planMirrorReceiptsOffThread as plan} from '../../../src/runtime/session-mirror/receipt-plan.ts';
import {OwnedWorkerBusyError,OwnedWorkerTimeoutError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
import {sessionMirrorIdentity,sessionMirrorReceiptExpectations} from '../../../src/runtime/session-mirror/sender.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
async function fixture(content:string,run:(batch:AnchoredMirrorBatch)=>Promise<void>){
 await storeFixture(async path=>{
  const file=join(dirname(path),'rollout.jsonl');await writeFile(file,content);
  const anchor=(await capture(file,0n)).anchor;
  const batch=await observe(anchor,{maxWindowBytes:1048576,maxRecordBytes:262144,maxRecords:100,decodeTimeoutMs:5000},{thread:'thread',detail:'All',currentTurn:'turn'});
  await run(batch);
 });
}
const line=(text:string)=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:text}})+'\n';
test('native receipt plan matches exact sender chunks, keys and canonical set hash',async()=>fixture(line('한😀'.repeat(1200)),async batch=>{
 const result=await plan(batch,42n),expected=batch.batch.items.flatMap(item=>[...sessionMirrorReceiptExpectations(42n,sessionMirrorIdentity('thread',item),formatMirrorItem(item))]);
 assert.ok(result.receipts.length>2);assert.deepEqual(result.receipts,expected);
 assert.equal(result.receiptSetHash,createHash('sha256').update(serializeSerdeValue(expected.map(r=>[r.key,r.contentHash]))).digest('hex'));
 assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.receipts));assert.equal(ownedWorkerUsage().Background,0);
}));
test('empty native item batch has exact empty receipt set hash',async()=>fixture('{}\n',async batch=>{
 const result=await plan(batch,42n);assert.deepEqual(result.receipts,[]);assert.equal(result.receiptSetHash,createHash('sha256').update('[]').digest('hex'));
}));
test('overlapping native planner has no queue and first owner still settles normally',async()=>fixture(line('hello'),async batch=>{
 const pending=plan(batch,42n);await assert.rejects(plan(batch,42n),OwnedWorkerBusyError);await pending;assert.equal(ownedWorkerUsage().Background,0);
}));
test('cancelled and timed-out planner join actual native exit before another succeeds',async()=>fixture(line('hello'),async batch=>{
 const controller=new AbortController(),reason=Error('stop'),pending=plan(batch,42n,controller.signal);controller.abort(reason);
 await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
 await assert.rejects(plan(batch,42n,undefined,1),OwnedWorkerTimeoutError);assert.equal(ownedWorkerUsage().Background,0);
 assert.ok((await plan(batch,42n)).receipts.length>0);
}));
test('forged batch getters and invalid resources fail before native submission',async()=>fixture(line('hello'),async batch=>{
 let calls=0;const forged=Object.create(AnchoredMirrorBatch.prototype);Object.defineProperty(forged,'batch',{get(){calls++;throw Error('hook')}});
 await assert.rejects(plan(forged,42n),TypeError);await assert.rejects(plan(batch,0n),RangeError);await assert.rejects(plan(batch,42n,undefined,10001),RangeError);
 const controller=new AbortController(),reason=Error('pre');controller.abort(reason);await assert.rejects(plan(batch,42n,controller.signal),e=>e===reason);
 assert.equal(calls,0);assert.equal(ownedWorkerUsage().Background,0);
}));
test('authentic expanded tool output cannot exceed submitted item count',async()=>{
 const content=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:Array(4097).fill('x')}})+'\n';
 await fixture(content,async batch=>{assert.equal(batch.batch.items.length,4097);await assert.rejects(plan(batch,42n),/item budget/);assert.equal(ownedWorkerUsage().Background,0)});
});
test('authentic expanded tool output cannot exceed aggregate input byte budget',async()=>{
 const content=Array.from({length:4},(_,i)=>JSON.stringify({timestamp:String(i),type:'response_item',payload:{type:'function_call_output',output:Array(1000).fill('x'.repeat(200))}})+'\n').join('');
 await fixture(content,async batch=>{assert.equal(batch.batch.items.length,4000);await assert.rejects(plan(batch,42n),/input exceeds/);assert.equal(ownedWorkerUsage().Background,0)});
});
