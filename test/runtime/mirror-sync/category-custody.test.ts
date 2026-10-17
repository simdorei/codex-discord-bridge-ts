import test from 'node:test';import assert from 'node:assert/strict';import * as http from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorCategoryCustody} from '../../../src/runtime/mirror-sync/category-custody.ts';
import {DiscordMirrorContainerTransport} from '../../../src/runtime/mirror-sync/container-http.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {ownContainerReceipt,type MirrorContainerReceipt} from '../../../src/store/mirror-container-creation.ts';
const fresh=()=>new AbortController().signal,room=(id='3')=>({id,type:4,guild_id:'1',name:'Codex'});
const local=(id=3n)=>({id,kind:4n,guildId:1n,parentId:null,name:'Codex',topic:null,archived:false,ownerId:null,archiveBefore:null});
async function fixture(handler:http.RequestListener,run:(s:NativeMirrorStore,c:MirrorCategoryCustody)=>Promise<void>){
 await storeFixture(async path=>{const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 const httpClient=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${a.port}/api/v10/`}),store=new NativeMirrorStore(path);
 try{await run(store,new MirrorCategoryCustody(store,new DiscordMirrorContainerTransport(httpClient)));}finally{await httpClient.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}});
}
test('actual category creation persists confirmation/binding and restart reads without duplicate POST',async()=>{
 const seen:string[]=[];await fixture((q,r)=>{seen.push(q.method!);r.end(JSON.stringify(room()));},async(s,c)=>{
  assert.equal(await c.category(1n,[],fresh()),3n);const receipt=ownContainerReceipt(await s.execute({kind:'CategoryReceipt',args:[1n]}) as MirrorContainerReceipt);assert.equal(receipt.phase,'bound');assert.equal(receipt.channel,3n);
  assert.equal(await c.category(1n,[],fresh()),3n);assert.deepEqual(seen,['POST','GET']);
 });
});
test('one valid existing category adopts without POST; duplicates and wrong guild reject',async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.end('{}');},async(_s,c)=>{
  assert.equal(await c.category(1n,[local()],fresh()),3n);
  await assert.rejects(c.category(1n,[local(),local(4n)],fresh()),/multiple Codex/);
  await assert.rejects(c.category(1n,[{...local(),guildId:2n}],fresh()),/wrong guild/);assert.equal(calls,0);
 });
});
test('unknown create response retains attempt and prevents a second POST',async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.end('{"id":"3"}');},async(_s,c)=>{
  await assert.rejects(c.category(1n,[],fresh()));await assert.rejects(c.category(1n,[],fresh()));assert.equal(calls,1);
 });
});
test('confirmed but unbound missing category cannot be recreated',async()=>{
 const seen:string[]=[];await fixture((q,r)=>{seen.push(q.method!);r.writeHead(404);r.end('{"code":10003,"message":"gone"}');},async(s,c)=>{
  const receipt=ownContainerReceipt(await s.execute({kind:'BeginCategory',args:[1n,null]}) as MirrorContainerReceipt);await s.execute({kind:'ConfirmContainer',args:[receipt,3n]});
  await assert.rejects(c.category(1n,[],fresh()),/creation not repeated/);assert.deepEqual(seen,['GET']);
 });
});
test('bound exact category plus fresh404 permits one replacement and binds new ID',async()=>{
 const seen:string[]=[];await fixture((q,r)=>{seen.push(q.method!);if(q.method==='GET'){r.writeHead(404);r.end('{"code":10003,"message":"gone"}');}else r.end(JSON.stringify(room('4')));},async(s,c)=>{
  const receipt=ownContainerReceipt(await s.execute({kind:'BeginCategory',args:[1n,null]}) as MirrorContainerReceipt),confirmed=ownContainerReceipt(await s.execute({kind:'ConfirmContainer',args:[receipt,3n]}) as MirrorContainerReceipt);await s.execute({kind:'BindCategory',args:[confirmed]});
  assert.equal(await c.category(1n,[],fresh()),4n);assert.deepEqual(seen,['GET','POST']);assert.equal(ownContainerReceipt(await s.execute({kind:'CategoryReceipt',args:[1n]}) as MirrorContainerReceipt).channel,4n);
 });
});
test('changed category response identity never binds another room or repeats creation',async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.end(JSON.stringify(room('9')));},async(s,c)=>{
  const receipt=ownContainerReceipt(await s.execute({kind:'BeginCategory',args:[1n,null]}) as MirrorContainerReceipt);await s.execute({kind:'ConfirmContainer',args:[receipt,3n]});
  await assert.rejects(c.category(1n,[],fresh()),/identity changed/);assert.equal(calls,1);
 });
});
