import test from 'node:test';import assert from 'node:assert/strict';
import {sendNativeMirrorReceiptChunk as send} from '../../../src/runtime/session-mirror/native-sender.ts';
import {NativeMirrorReceiptStore,MirrorReceiptWriteUnconfirmedError} from '../../../src/runtime/session-mirror/receipt-store.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';import {sessionMirrorIdentity} from '../../../src/runtime/session-mirror/sender.ts';
import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
const item=collectSessionItems('thread',[{type:'event_msg',payload:{type:'agent_message',message:'hello'}}],'Send','turn').items[0]!;
const chunk={...sessionMirrorIdentity('thread',item),chunkIndex:0n,content:'hello'};
async function fixture(run:(path:string,store:NativeMirrorReceiptStore)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);db.close();
 const store=new NativeMirrorReceiptStore(path,'thread',42n);try{await run(path,store)}finally{await store.close()}
});}
test('native durable receipt confirmed before return and reconstructed sender does not resend',async()=>fixture(async(path,store)=>{
 let calls=0;const bodies:string[]=[];const transport={async sendValidated(r:{body:string}){calls++;bodies.push(r.body);return 10n}};
 await send(store,transport,42n,chunk);const fresh=new NativeMirrorReceiptStore(path,'thread',42n);
 try{await send(fresh,transport,42n,{...chunk})}finally{await fresh.close()}
 assert.equal(calls,1);assert.equal(JSON.parse(bodies[0]!).enforce_nonce,true);assert.equal(ownedWorkerUsage().Background,0);
}));
test('unknown transport result remains held across fresh native owner without another HTTP attempt',async()=>fixture(async(path,store)=>{
 let calls=0;const transport={async sendValidated(){calls++;throw new DiscordTransportFault('Transport','lost response')}};
 await assert.rejects(send(store,transport,42n,chunk),/unconfirmed/);
 const fresh=new NativeMirrorReceiptStore(path,'thread',42n);try{await assert.rejects(send(fresh,transport,42n,chunk),/unknown/)}finally{await fresh.close()}
 assert.equal(calls,1);
}));
test('authoritative 429 permits explicit later retry using same body, without automatic retry loop',async()=>fixture(async(_path,store)=>{
 let calls=0;const bodies:string[]=[];const transport={async sendValidated(r:{body:string}){bodies.push(r.body);if(++calls===1)throw new DiscordTransportFault('Response','rate',429);return 10n}};
 await assert.rejects(send(store,transport,42n,chunk),/rejected/);assert.equal(calls,1);await send(store,transport,42n,chunk);assert.equal(calls,2);assert.equal(bodies[0],bodies[1]);
}));
test('definite forbidden blocks repeated ticks and forged fault cannot release unknown intent',async()=>fixture(async(_path,store)=>{
 let calls=0;const denied={async sendValidated(){calls++;throw new DiscordTransportFault('Response','denied',403)}};
 await assert.rejects(send(store,denied,42n,chunk));await assert.rejects(send(store,denied,42n,chunk),/requires correction/);assert.equal(calls,1);
 const other={...chunk,chunkIndex:1n};let traps=0;const fake=new Proxy({kind:'Response',status:429},{get(){traps++;throw Error('trap')}});
 const unknown={async sendValidated(){calls++;throw fake}};
 await assert.rejects(send(store,unknown,42n,other),/unconfirmed/);await assert.rejects(send(store,unknown,42n,other),/unknown/);assert.equal(traps,0);assert.equal(calls,2);
}));
test('cancellation during accepted HTTP joins and records receipt before surfacing original reason',async()=>fixture(async(path,store)=>{
 let entered!:()=>void,finish!:(n:bigint)=>void,calls=0;const gate=new Promise<void>(r=>entered=r),controller=new AbortController(),reason=Error('stop');
 const pending=send(store,{async sendValidated(){calls++;entered();return new Promise<bigint>(r=>finish=r)}},42n,chunk,controller.signal);
 await gate;controller.abort(reason);finish(10n);await assert.rejects(pending,e=>e===reason);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT message_id AS id FROM codex_delivery_receipts').get()!.id,'10')}finally{db.close()}
 await send(store,{async sendValidated(){calls++;return 11n}},42n,chunk);assert.equal(calls,1);
}));
test('mapping change after actual HTTP attempt does not discard the original confirmed receipt',async()=>fixture(async(path,store)=>{
 await send(store,{async sendValidated(){const db=await openInitialized(path);try{db.exec('UPDATE mirror_threads SET discord_thread_id=43')}finally{db.close()}return 10n}},42n,chunk);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT message_id AS id FROM codex_delivery_receipts').get()!.id,'10')}finally{db.close()}
}));
test('unconfirmed native intent, stale mapping, other domain and pre-abort do not call HTTP',async()=>fixture(async(path,store)=>{
 let calls=0;const transport={async sendValidated(){calls++;return 10n}};
 const short=new NativeMirrorReceiptStore(path,'thread',42n,1);
 try{await assert.rejects(send(short,transport,42n,chunk),MirrorReceiptWriteUnconfirmedError)}finally{await short.close()}
 await assert.rejects(send(store,transport,42n,chunk),/unknown/);
 await assert.rejects(send(store,transport,42n,{...chunk,domain:'completion/v1'}),MirrorReceiptWriteUnconfirmedError);
 const db=await openInitialized(path);try{db.exec('UPDATE mirror_threads SET discord_thread_id=43')}finally{db.close()}
 await assert.rejects(send(store,transport,42n,{...chunk,chunkIndex:1n}),MirrorReceiptWriteUnconfirmedError);
 const controller=new AbortController(),reason=Error('pre');controller.abort(reason);await assert.rejects(send(store,transport,42n,chunk,controller.signal),e=>e===reason);
 assert.equal(calls,0);
}));
