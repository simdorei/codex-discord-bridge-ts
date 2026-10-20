import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';
import {beginNewThreadAttempt,NewThreadAttempt,type NewAttemptReport} from '../../../src/runtime/action-executor/new-attempt.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
const context=()=>({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true});
async function original(path:string){const journal=new NewThreadJournal(path,()=>10),record=await journal.admit(context(),'original');return {journal,record};}
test('winner disposal holds unknown unowned creation exactly once; duplicate does not hold winner',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),reports:NewAttemptReport[]=[],attempt=await beginNewThreadAttempt(path,journal,record,1n,v=>{reports.push(v);},()=>11);
 await assert.rejects(beginNewThreadAttempt(path,journal,record,1n,()=>{},()=>12),/already attempted/);assert.equal((await state.getIngress(path,record.ingressId))?.state,'executing');
 const disposal=attempt.dispose();assert.equal(attempt.dispose(),disposal);await disposal;assert.equal((await state.getIngress(path,record.ingressId))?.state,'held');assert.match((await state.getIngress(path,record.ingressId))!.holdReason,/attempt ended before durable prompt ownership/);assert.deepEqual(reports,[]);
}));
test('dispose joins running work before holding and work failure retains exact identity',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),attempt=await beginNewThreadAttempt(path,journal,record,1n,()=>{},()=>11);let release!:(v:void)=>void,settled=false;const wait=new Promise<void>(r=>{release=r;}),error=new Error('remote uncertain');
 const work=attempt.run(async()=>{await wait;throw error;}),checked=assert.rejects(work,e=>e===error),dispose=attempt.dispose().then(()=>{settled=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(settled,false);assert.equal((await state.getIngress(path,record.ingressId))?.state,'executing');release();await checked;await dispose;assert.equal((await state.getIngress(path,record.ingressId))?.state,'held');
}));
test('durably owned prompt is never converted into an unowned attempt hold',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),attempt=await beginNewThreadAttempt(path,journal,record,1n,()=>{},()=>11);
 // Fixture simulates a completed durable custody handoff, not the production promotion transaction.
 const db=await openInitialized(path);try{db.prepare("UPDATE discord_ingress_journal SET owner_kind='prompt',owner_id='job' WHERE ingress_id=?").run(record.ingressId);}finally{db.close();}
 await attempt.dispose();const saved=await state.getIngress(path,record.ingressId);assert.equal(saved?.ownerId,'job');assert.equal(saved?.state,'executing');assert.equal(saved?.holdReason,'');
}));
test('abort racing successful begin cleans the won attempt before rejecting',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),controller=new AbortController(),reason=new Error('shutdown');await assert.rejects(beginNewThreadAttempt(path,journal,record,1n,()=>{},()=>{controller.abort(reason);return 11;},controller.signal),e=>e===reason);assert.equal((await state.getIngress(path,record.ingressId))?.state,'held');
}));
test('cleanup recording failure is reported with request identity and never claims a saved hold',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),reports:NewAttemptReport[]=[];let now=11;const attempt=await beginNewThreadAttempt(path,journal,record,1n,v=>{reports.push(v);},()=>now);now=NaN;await attempt.dispose();assert.equal(reports.length,1);assert.equal(reports[0]?.ingressId,record.ingressId);assert.equal((await state.getIngress(path,record.ingressId))?.state,'executing');
}));
test('forged guard and foreign journal record cannot acquire attempt ownership',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path);assert.throws(()=>new NewThreadAttempt(Symbol(),path,record.ingressId,()=>11,()=>{}),/won new-thread attempt/);await assert.rejects(beginNewThreadAttempt(path,journal,{...record},1n,()=>{},()=>11),/original journal admission/);assert.equal((await state.getIngress(path,record.ingressId))?.state,'staged');
}));
