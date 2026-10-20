import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {messageReplyIdentity,deliverMessageReplyText as deliver,sendMessageReplyOnce as once,type MessageReplyKind} from '../../../src/runtime/message-worker/reply-delivery.ts';
import {splitDeliveryChunks,splitExactDeliveryChunks} from '../../../src/discord/text.ts';
import {busyButtonRow,serializeDiscordComponent} from '../../../src/discord/components.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
import {serializeSerdeValue as json} from '../../../src/core/serde-json.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';
const key=(id:bigint,kind:MessageReplyKind,part=0)=>{const i=messageReplyIdentity(id,kind);return json([1n,i.domain,i.logicalKey,BigInt(part)]);};
async function hashes(path:string){const db=await openInitialized(path);try{return db.prepare('SELECT receipt_key,content_hash,message_id FROM codex_delivery_receipts ORDER BY receipt_key').all();}finally{db.close();}}
test('reply kind domains and key aliases match exact source identities',()=>{
 for(const [kind,domain,segment] of [['PendingConfirmation','message/reply/v1','pending-confirmation'],['PlannedResponse','message/reply/v1','planned-response'],['ActionResult','message/reply/v1','action-result'],['SavedRequest','message/reply/v1','action-result'],['ErrorReport','message/error/v1','error-report']] as const){const i=messageReplyIdentity((1n<<64n)-1n,kind);assert.deepEqual(i,{domain,logicalKey:`inbound-message/18446744073709551615/${segment}`});assert.ok(Object.isFrozen(i));}
 for(const id of [0n,-1n,1n<<64n])assert.throws(()=>messageReplyIdentity(id,'ActionResult'),TypeError);assert.throws(()=>messageReplyIdentity(1n,'unknown' as any),TypeError);
});
test('ordinary multi-chunk native delivery stores exact indexed receipts and never repeats delivered POSTs',()=>storeFixture(path=>httpFixture(async(client,seen)=>{
 const text='  '+('가나다'.repeat(1500))+'  ',chunks=splitDeliveryChunks(text,true);assert.equal(await deliver(path,client,1n,42n,'ActionResult',text),chunks.length);assert.equal(seen.length,chunks.length);
 let rows=await hashes(path);assert.equal(rows.length,chunks.length);for(let i=0;i<chunks.length;i++){const row=rows.find(r=>r.receipt_key===key(42n,'ActionResult',i))!;assert.equal(row.content_hash,receiptHash(chunks[i]!));assert.ok(row.message_id);}
 assert.equal(await deliver(path,client,1n,42n,'ActionResult',text),chunks.length);assert.equal(seen.length,chunks.length);
}))); 
test('saved structured text preserves whitespace while ordinary replies trim',()=>storeFixture(path=>httpFixture(async(client,seen)=>{
 const text=' \n'+('x'.repeat(2000))+'\n ';await deliver(path,client,1n,43n,'SavedRequest',text);await deliver(path,client,1n,44n,'ActionResult',text);const rows=await hashes(path);
 for(const [id,kind,chunks] of [[43n,'SavedRequest',splitExactDeliveryChunks(text,true)],[44n,'ActionResult',splitDeliveryChunks(text,true)]] as const)for(let i=0;i<chunks.length;i++)assert.equal(rows.find(r=>r.receipt_key===key(id,kind,i))!.content_hash,receiptHash(chunks[i]!));
 assert.equal(seen.length,4);
})));
test('one-shot components are receipt-bound and repeated call skips network',()=>storeFixture(path=>httpFixture(async(client,seen)=>{
 const components=[busyButtonRow('0123456789abcdef01234567',true)];await once(path,client,1n,45n,'ActionResult','Choose',components);await once(path,client,1n,45n,'ActionResult','Choose',components);
 const row=(await hashes(path))[0]!;assert.equal(row.receipt_key,key(45n,'ActionResult'));assert.equal(row.content_hash,receiptHash(`[${JSON.stringify('Choose')},[${components.map(serializeDiscordComponent).join(',')}]]`));assert.deepEqual(seen,['POST']);
})));
test('saved request and action result share identity so content conflicts cannot send twice',()=>storeFixture(path=>httpFixture(async(client,seen)=>{
 await once(path,client,1n,46n,'SavedRequest',' saved ');await assert.rejects(deliver(path,client,1n,46n,'ActionResult',' saved '),e=>e instanceof DeliveryFailure&&e.attempts===1);assert.deepEqual(seen,['POST']);
 await once(path,client,1n,46n,'ErrorReport','error');assert.deepEqual(seen,['POST','POST']);assert.equal((await hashes(path)).length,2);
})));
test('unknown receipt stops on exact chunk with no automatic retry or later chunk send',()=>storeFixture(path=>httpFixture(async(client,seen)=>{
 const text='z'.repeat(4000),chunks=splitDeliveryChunks(text,true);await state.beginDeliveryReceipt(path,key(47n,'ActionResult',1),receiptHash(chunks[1]!));
 await assert.rejects(deliver(path,client,1n,47n,'ActionResult',text),e=>e instanceof DeliveryFailure&&e.part===2&&e.attempts===1);assert.deepEqual(seen,['POST']);
 await assert.rejects(deliver(path,client,1n,47n,'ActionResult',text),DeliveryFailure);assert.deepEqual(seen,['POST']);assert.equal((await hashes(path)).length,2);
})));
test('invalid kind, ID and malformed Unicode reject before receipts or HTTP',()=>storeFixture(path=>httpFixture(async(client,seen)=>{
 await assert.rejects(deliver(path,client,0n,48n,'ActionResult','text'),TypeError);await assert.rejects(once(path,client,1n,48n,'bad' as any,'text'),TypeError);await assert.rejects(deliver(path,client,1n,48n,'ActionResult','\ud800'),TypeError);assert.deepEqual(seen,[]);assert.deepEqual(await hashes(path),[]);
})));
