import test from 'node:test';
import assert from 'node:assert/strict';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {beginDeliveryReceipt} from '../../../src/store/delivery-receipts.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
import {messageNonce} from '../../../src/discord/message-nonce.ts';
import {decodeGatewayMessageDispatch} from '../../../src/discord/gateway/decoded-message.ts';
import {confirmGatewayReceiptEcho} from '../../../src/runtime/discord-runtime/receipt-echo.ts';
import {splitDeliveryChunks} from '../../../src/discord/text.ts';
const domain='mirror/test',logical='final';
const key='[42,"mirror/test","final",0]';
function message(extra:Record<string,unknown>={}){return decodeGatewayMessageDispatch(JSON.stringify({op:0,s:1,t:'MESSAGE_CREATE',d:{attachments:[],author:{id:'7',username:'bot',discriminator:'0',bot:true},channel_id:'42',content:'answer',components:[],embeds:[],id:'99',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false,type:0,nonce:messageNonce(domain,42n,logical,0).toString(),...extra}}));}
test('lost HTTP acknowledgement is confirmed only by matching bot nonce/channel/content; duplicate echo is harmless',()=>storeFixture(async database=>{
 const db=await openInitialized(database);db.close();assert.equal((await beginDeliveryReceipt(database,key,receiptHash('answer'))).kind,'New');
 assert.equal((await beginDeliveryReceipt(database,key,receiptHash('answer'))).kind,'Unknown');
 for(const extra of [{nonce:'1'},{channel_id:'43'},{content:'other'},{webhook_id:'88'},{edited_timestamp:'2020-01-01T00:00:01+00:00'},{author:{id:'8',username:'other',discriminator:'0',bot:true}},{author:{id:'7',username:'bot',discriminator:'0',bot:false}}])assert.equal(await confirmGatewayReceiptEcho(database,message(extra),7n),false);
 assert.equal(await confirmGatewayReceiptEcho(database,message(),7n),true);
 assert.deepEqual(await beginDeliveryReceipt(database,key,receiptHash('answer')),{kind:'Delivered',messageId:'99'});
 assert.equal(await confirmGatewayReceiptEcho(database,message(),7n),false);
}));
test('ambiguous persisted aliases do not manufacture receipt confirmation',()=>storeFixture(async database=>{
 const db=await openInitialized(database);db.close();await beginDeliveryReceipt(database,key,receiptHash('answer'));await beginDeliveryReceipt(database,'[42, "mirror/test", "final", 0]',receiptHash('answer'));
 assert.equal(await confirmGatewayReceiptEcho(database,message(),7n),false);assert.equal((await beginDeliveryReceipt(database,key,receiptHash('answer'))).kind,'Unknown');
}));

test('legacy final barrier opens only after every exact reply chunk has a receipt',()=>storeFixture(async database=>{
 const response='fixture output '.repeat(220),chunks=splitDeliveryChunks(response,true),replyDomain='message/reply/v1',replyLogical='inbound-message/123/action-result';assert.ok(chunks.length>1);
 const db=await openInitialized(database);try{db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,owner_kind,owner_id,outcome_json,created_at,updated_at) VALUES('message:123','message',123,42,7,'{}','owned','result_recorded','prompt','job-fixture',?,1,1)").run(JSON.stringify({response,waits_for_final:true}));}finally{db.close();}
 for(let index=0;index<chunks.length;index++)await beginDeliveryReceipt(database,`[42,"${replyDomain}","${replyLogical}",${index}]`,receiptHash(chunks[index]!));
 for(let index=0;index<chunks.length;index++){
  assert.equal(await confirmGatewayReceiptEcho(database,message({id:String(200+index),content:chunks[index]!,nonce:messageNonce(replyDomain,42n,replyLogical,index).toString()}),7n),true);
  const read=await openInitialized(database);try{assert.equal(read.prepare("SELECT confirmation_delivered FROM discord_ingress_journal WHERE ingress_id='message:123'").get()!.confirmation_delivered,index===chunks.length-1?1:0);}finally{read.close();}
 }
}));

test('button echo uses the emitted component hash, never a content-only fallback',()=>storeFixture(async database=>{
 const components=[{type:1,components:[{type:2,custom_id:'fixture',label:'Choose',style:1}]}],db=await openInitialized(database);db.close();
 await beginDeliveryReceipt(database,key,receiptHash(JSON.stringify(['answer',components])));
 assert.equal(await confirmGatewayReceiptEcho(database,message(),7n),false);
 assert.equal(await confirmGatewayReceiptEcho(database,message({components}),7n),true);
}));
