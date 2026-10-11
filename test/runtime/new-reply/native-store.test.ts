import test from 'node:test';import assert from 'node:assert/strict';
import {storeFixture} from '../../helpers/store-fixture.ts';import {newReply} from '../../helpers/delivery-custody.ts';
import {NativeNewReplyStore,NewReplyStoreWriteUnconfirmedError} from '../../../src/runtime/new-reply/native-store.ts';
import {OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {usingInitializedStore} from '../../../src/store/owned-scope.ts';import {getIn} from '../../../src/store/new-reply-read.ts';
const update={scan:{offset:55n},verified:true,error:'',now:10};
test('actual native facade reads original intent and conditionally checkpoints exact revision',async()=>storeFixture(async path=>{
 await newReply(path);const store=new NativeNewReplyStore(path);try{const before=(await store.pending())[0]!;assert.equal(before.identity.job_id,'job');assert.equal(Object.isFrozen(before),true);assert.equal(await store.checkpoint(before,update),true);assert.equal(await store.checkpoint(before,update),false);const current=(await store.pending())[0]!;assert.equal(current.version,before.version+1n);assert.deepEqual(current.scan,{offset:55n});assert.equal(current.confirmationDelivered,false);}finally{await store.close();}assert.equal(ownedWorkerUsage().Background,0);
}));
test('native owner refuses overlap and close joins accepted read before reporting closed',async()=>storeFixture(async path=>{
 await newReply(path);const store=new NativeNewReplyStore(path),pending=store.pending();await assert.rejects(store.pending(),OwnedWorkerBusyError);const observed=pending.catch(e=>e);const reason=new Error('close owner');await store.close(reason);assert.equal(await observed,reason);assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(store.pending(),/closed/);
}));
test('submitted checkpoint timeout is unconfirmed and native exit precedes revision reconciliation',async()=>storeFixture(async path=>{
 await newReply(path);const original=await usingInitializedStore(path,d=>getIn(d,'job')!),store=new NativeNewReplyStore(path,0);
 try{await assert.rejects(store.checkpoint(original,update),(e:unknown)=>e instanceof NewReplyStoreWriteUnconfirmedError&&e.jobId==='job'&&e.expectedVersion===original.version);assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);const after=await usingInitializedStore(path,d=>getIn(d,'job')!);assert.ok(after.version===original.version||after.version===original.version+1n);if(after.version===original.version+1n)assert.deepEqual(after.scan,{offset:55n});}finally{await store.close();}
}));
test('checkpoint input is snapshotted before native execution and native SQL failure is unconfirmed',async()=>storeFixture(async path=>{
 await newReply(path);const original=await usingInitializedStore(path,d=>getIn(d,'job')!),store=new NativeNewReplyStore(path);
 try{const changing={...update,scan:{offset:55n}},pending=store.checkpoint(original,changing);changing.scan.offset=999n;assert.equal(await pending,true);assert.deepEqual((await store.pending())[0]!.scan,{offset:55n});await usingInitializedStore(path,d=>d.exec("CREATE TRIGGER fail_new_checkpoint BEFORE UPDATE ON codex_new_first_replies BEGIN SELECT RAISE(ABORT,'fixture refusal'); END"));const before=(await store.pending())[0]!;await assert.rejects(store.checkpoint(before,update),NewReplyStoreWriteUnconfirmedError);assert.equal((await store.pending())[0]!.version,before.version);}finally{await store.close();}
}));
test('preabort does not start native work and getter input cannot run hooks',async()=>storeFixture(async path=>{
 await newReply(path);const original=await usingInitializedStore(path,d=>getIn(d,'job')!),store=new NativeNewReplyStore(path),c=new AbortController(),reason=new Error('preabort');c.abort(reason);
 try{await assert.rejects(store.checkpoint(original,update,c.signal),e=>e===reason);let hooks=0;const bad=Object.defineProperty({...update},'scan',{get(){hooks++;return {};}});await assert.rejects(store.checkpoint(original,bad));assert.equal(hooks,0);assert.equal(ownedWorkerUsage().Background,0);}finally{await store.close();}
}));

test('missing diagnostic ownership is rejected before native submission',async()=>storeFixture(async path=>{const store=new NativeNewReplyStore(path);try{const pending=store.checkpoint({} as never,update);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(pending,TypeError);assert.equal(store.busy,false);}finally{await store.close();}}));
