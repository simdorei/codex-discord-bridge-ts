import test from 'node:test';import assert from 'node:assert/strict';
import {collectSessionItems,formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
import {sessionMirrorIdentity,sendSessionMirrorText,sessionMirrorReceiptExpectations as plan} from '../../../src/runtime/session-mirror/sender.ts';
import {requireConfirmedReceiptBatchIn as confirmed,UnconfirmedReceiptBatchError} from '../../../src/store/confirmed-receipt-batch.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
function item(text='hi'){return collectSessionItems('thread',[{type:'event_msg',payload:{type:'task_complete',turn_id:'turn',last_agent_message:text}}],'Send').items[0]!;}
test('planned keys and hashes match every actually confirmed marked Unicode chunk',async()=>storeFixture(async path=>{
 const value=item('한😀\n'.repeat(1600)),id=sessionMirrorIdentity('thread',value),text=formatMirrorItem(value),expected=plan(18446744073709551615n,id,text);let calls=0;
 assert.ok(expected.length>2);assert.ok(Object.isFrozen(expected));assert.ok(expected.every(Object.isFrozen));
 await sendSessionMirrorText(path,{async sendValidated(){return BigInt(++calls)}},18446744073709551615n,id,text);
 const db=await openInitialized(path);try{
   db.exec('BEGIN');confirmed(db,expected);
   const rows=db.prepare('SELECT receipt_key AS key,content_hash AS contentHash FROM codex_delivery_receipts').all().map(r=>({...r}));
   assert.deepEqual(rows.sort((a,b)=>String(a.key).localeCompare(String(b.key))),[...expected].sort((a,b)=>a.key.localeCompare(b.key)));assert.equal(calls,expected.length);
 }finally{db.close()}
}));
test('unknown later receipt blocks whole planned batch and restart cannot resend',async()=>storeFixture(async path=>{
 const value=item('x'.repeat(6000)),id=sessionMirrorIdentity('thread',value),text=formatMirrorItem(value),expected=plan(42n,id,text);let calls=0;
 const transport={async sendValidated(){if(++calls===2)throw Error('lost response');return 1n}};
 await assert.rejects(sendSessionMirrorText(path,transport,42n,id,text));await assert.rejects(sendSessionMirrorText(path,transport,42n,id,text));assert.equal(calls,2);
 const db=await openInitialized(path);try{db.exec('BEGIN');assert.throws(()=>confirmed(db,expected),UnconfirmedReceiptBatchError)}finally{db.close()}
}));
test('restart planning is deterministic, scopes and actual content remain bound',()=>{
 const value=item(),id=sessionMirrorIdentity('thread',value);
 assert.deepEqual(plan(42n,id,'hello'),plan(42n,sessionMirrorIdentity('thread',item()),'hello'));
 assert.notDeepEqual(plan(42n,id,'hello'),plan(43n,id,'hello'));
 const a=plan(42n,id,'hello')[0]!,b=plan(42n,id,'changed')[0]!;assert.equal(a.key,b.key);assert.notEqual(a.contentHash,b.contentHash);
 assert.notDeepEqual(plan(42n,id,'hello'),plan(42n,sessionMirrorIdentity('other',value),'hello'));
});
test('empty and trim-only text uses the same no-output receipt as actual sender',async()=>storeFixture(async path=>{
 const id=sessionMirrorIdentity('thread',item());await sendSessionMirrorText(path,{async sendValidated(){return 1n}},42n,id,'\u0085 ');
 const db=await openInitialized(path);try{db.exec('BEGIN');confirmed(db,plan(42n,id,''));assert.deepEqual(plan(42n,id,''),plan(42n,id,'\u0085 '))}finally{db.close()}
}));
test('new planning budget refuses oversized input and forged identities before effects',()=>{
 const id=sessionMirrorIdentity('thread',item());let calls=0;
 assert.throws(()=>plan(42n,{get domain(){calls++;return 'fake'},logicalKey:'fake'},'x'),TypeError);
 assert.throws(()=>plan(0n,id,'x'),RangeError);
 assert.throws(()=>plan(42n,id,'x'.repeat(1048577)),RangeError);
 assert.throws(()=>plan(42n,id,'한'.repeat(400000)),RangeError);
 assert.throws(()=>plan(42n,sessionMirrorIdentity('x'.repeat(66000),item()),'x'),RangeError);
 assert.throws(()=>plan(42n,sessionMirrorIdentity('x'.repeat(60000),item()),'x'.repeat(40000)),RangeError);
 assert.equal(calls,0);
});
