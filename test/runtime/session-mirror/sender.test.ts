import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {collectSessionItems,formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
import {sessionMirrorIdentity,sendSessionMirrorText,SESSION_MIRROR_ASSISTANT_TEXT_NONCE_DOMAIN,SESSION_MIRROR_EVENT_NONCE_DOMAIN} from '../../../src/runtime/session-mirror/sender.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';import {DeliveryFailure} from '../../../src/discord/delivery.ts';
const commentary=(turn:string|null,text='hello',shape='event_msg')=>collectSessionItems('thread-1',[{timestamp:'1',type:shape,payload:shape==='event_msg'?{type:'agent_message',message:text}:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text}]}}],'Send',turn).items[0]!;
const final=(turn:string,text='same reply')=>collectSessionItems('thread',[{type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:text}}],'Send').items[0]!;
test('source ASCII golden and equivalent assistant shapes retain restart-stable text identity',()=>{
 const a=sessionMirrorIdentity('thread-1',commentary(null)),b=sessionMirrorIdentity('thread-1',commentary(null,' hello ','response_item'));
 assert.deepEqual(a,b);assert.equal(a.domain,SESSION_MIRROR_ASSISTANT_TEXT_NONCE_DOMAIN);
 assert.equal(a.logicalKey,'13:8:thread-1:0::f3aefe62965a91903610f0e23cc8a69d5b87cea6d28e75489b0d2ca02ed7993c');
 assert.notDeepEqual(a,sessionMirrorIdentity('other',commentary(null)));assert.notDeepEqual(sessionMirrorIdentity('thread-1',commentary('one')),sessionMirrorIdentity('thread-1',commentary('two')));
});
test('UTF8 lengths not UTF16, Rust trim and event identities stay distinct',()=>{
 const item={...commentary(null),turnId:'😀',text:'\u0085hello\u0085'};
 const a=sessionMirrorIdentity('한',item);assert.ok(a.logicalKey.startsWith('12:3:한:4:😀:'));
 assert.deepEqual(a,sessionMirrorIdentity('한',{...item,text:'hello'}));assert.notDeepEqual(a,sessionMirrorIdentity('한',{...item,text:'\uFEFFhello'}));
 const f=sessionMirrorIdentity('thread',final('one'));assert.equal(f.domain,SESSION_MIRROR_EVENT_NONCE_DOMAIN);assert.notDeepEqual(f,sessionMirrorIdentity('thread',final('two')));
});
test('confirmed receipt survives reconstructed sender identity and new turn sends separately',async()=>storeFixture(async path=>{
 const requests:string[]=[];const transport={async sendValidated(request:{body:string}){requests.push(request.body);return BigInt(100+requests.length);}};
 const first=final('one');await sendSessionMirrorText(path,transport,42n,sessionMirrorIdentity('thread',first),formatMirrorItem(first));
 await sendSessionMirrorText(path,transport,42n,sessionMirrorIdentity('thread',final('one')),formatMirrorItem(first));
 const next=final('two');await sendSessionMirrorText(path,transport,42n,sessionMirrorIdentity('thread',next),formatMirrorItem(next));
 assert.equal(requests.length,2);assert.notEqual(JSON.parse(requests[0]!).nonce,JSON.parse(requests[1]!).nonce);
}));
test('unknown receipt propagates one attempt and reconstructed call cannot resend',async()=>storeFixture(async path=>{
 let calls=0;const transport={async sendValidated(){calls++;throw new DiscordTransportFault('Receipt','unreadable response');}};const item=final('one');
 for(let i=0;i<2;i++)await assert.rejects(sendSessionMirrorText(path,transport,42n,sessionMirrorIdentity('thread',item),formatMirrorItem(item)),e=>e instanceof DeliveryFailure&&e.attempts===1);
 assert.equal(calls,1);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT count(*) n FROM codex_delivery_receipts WHERE message_id IS NULL AND retryable=0').get()?.n,1);}finally{db.close();}
}));
test('multi-chunk partial confirmation reuses prefix and unknown later chunk blocks remaining work',async()=>storeFixture(async path=>{
 let calls=0;const item=final('one','x'.repeat(6000)),id=sessionMirrorIdentity('thread',item),text=formatMirrorItem(item);
 const transport={async sendValidated(){if(++calls===2)throw new DiscordTransportFault('Transport','lost response');return 101n;}};
 await assert.rejects(sendSessionMirrorText(path,transport,42n,id,text),e=>e instanceof DeliveryFailure&&e.part===2&&e.totalParts===5);
 await assert.rejects(sendSessionMirrorText(path,transport,42n,id,text),e=>e instanceof DeliveryFailure&&e.part===2);assert.equal(calls,2);
}));
test('forged identity or invalid channel fails before DB/HTTP, input accessors stay uncalled',async()=>storeFixture(async path=>{
 let calls=0;const transport={async sendValidated(){calls++;return 1n;}},id=sessionMirrorIdentity('thread',final('one'));
 await assert.rejects(sendSessionMirrorText(path,transport,42n,{...id},'text'),TypeError);
 for(const channel of [0n,-1n,1n<<64n])await assert.rejects(sendSessionMirrorText(path,transport,channel,id,'text'),RangeError);
 assert.throws(()=>sessionMirrorIdentity('thread',{...final('one'),get text(){calls++;return 'x';}}),TypeError);
 assert.equal(calls,0);assert.equal(existsSync(path),false);
}));
