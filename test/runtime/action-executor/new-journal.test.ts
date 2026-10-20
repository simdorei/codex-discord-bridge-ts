import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {snapshotStoredIngress} from '../../../src/store/ingress-snapshot.ts';
import {newCommandPrompt} from '../../../src/store/ingress-new-input.ts';
const context=()=>({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true});
test('new admission freezes original prompt, context and origin without owning thread/start',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>10),record=await journal.admit(context(),'original');assert.equal(newCommandPrompt(record),'original');assert.equal(record.kind,'action');assert.equal(record.state,'staged');assert.equal(record.ownerId,null);assert.equal(record.targetThreadId,null);assert.match(record.ingressId,/^action:/);
 assert.deepEqual((record.payload as {context:unknown}).context,{channel_id:99n,user_id:20n,discord_message_id:30n,auto_queue_when_busy:true});assert.ok((record.payload as {new_origin:unknown}).new_origin);
 const duplicate=await journal.admit(context(),'original');assert.equal(duplicate.ingressId,record.ingressId);assert.deepEqual(snapshotStoredIngress((await state.getIngress(path,record.ingressId))!),record);
}));
test('concurrent distinct prompts retain one original admission and reject the conflicting repeat',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>10),results=await Promise.allSettled([journal.admit(context(),'first'),journal.admit(context(),'second')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const winner=results.find(r=>r.status==='fulfilled');assert.ok(winner&&winner.status==='fulfilled');const original=winner.value;assert.deepEqual(snapshotStoredIngress((await state.ingressByOrigin(path,30n))!),original);assert.equal(original.state,'staged');assert.equal(await state.beginIngressThreadStart(path,original.ingressId,1n,11),true);assert.equal(await state.beginIngressThreadStart(path,original.ingressId,1n,12),false);
}));
test('same event cannot borrow a different original actor or channel',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>10),record=await journal.admit(context(),'original');
 for(const changed of [{...context(),userId:21n},{...context(),channelId:100n}])await assert.rejects(journal.admit(changed,'original'),/different original channel, user, command, or prompt/);
 assert.deepEqual(snapshotStoredIngress((await state.getIngress(path,record.ingressId))!),record);
}));
test('manual hold persists public-safe reason and returns detailed original failure without automatic recreation',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>10),record=await journal.admit(context(),'original');const error=await journal.hold(record,new Error('remote detail'),true);assert.match(error.message,/no automatic thread\/start retry: remote detail/);
 const saved=await state.getIngress(path,record.ingressId);assert.equal(saved?.state,'held');assert.equal(saved?.holdReason,'new-thread creation needs manual review; automatic recreation is disabled');assert.equal(saved?.holdReason.includes('remote detail'),false);
 await assert.rejects(journal.hold({...record},new Error('foreign'),false),/original journal admission/);
}));
test('clock failure during hold retains both errors without claiming a saved hold',async()=>storeFixture(async path=>{
 let now=10;const journal=new NewThreadJournal(path,()=>now),record=await journal.admit(context(),'original');now=NaN;const error=await journal.hold(record,new Error('creation failure'),false);assert.match(error.message,/creation failure/);assert.match(error.message,/recording its manual hold also failed/);assert.equal((await state.getIngress(path,record.ingressId))?.state,'staged');
}));
test('blank prompts and pre-abort never create storage',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>10);await assert.rejects(journal.admit(context(),'\u0085\u2003'),/must not be blank/);const controller=new AbortController(),reason=new Error('cancel');controller.abort(reason);await assert.rejects(journal.admit(context(),'original',controller.signal),e=>e===reason);assert.equal(existsSync(path),false);
}));

test('mutation of a returned journal record cannot redirect manual hold to another request',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>10),original=await journal.admit(context(),'one'),other=await journal.admit({...context(),discordMessageId:31n},'two');const key=original.ingressId;original.ingressId=other.ingressId;
 await assert.rejects(journal.hold(original,new Error('failure'),false),/original journal admission/);assert.equal((await state.getIngress(path,key))?.state,'staged');assert.equal((await state.getIngress(path,other.ingressId))?.state,'staged');
}));
