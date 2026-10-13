import test from 'node:test';import assert from 'node:assert/strict';import * as http from 'node:http';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {DiscordMirrorInventoryTransport} from '../../src/runtime/mirror-sync/inventory-http.ts';
import {decodeMirrorThreadsPage,decodeMirrorGuildChannels,mirrorArchiveTimestamp,mirrorInventoryResource,mirrorArchivedThreadsPath} from '../../src/discord/mirror-inventory-request.ts';
import {parseDiscordTimestamp} from '../../src/discord/model/timestamp.ts';
const fresh=()=>new AbortController().signal,bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));
const bot={id:'9',username:'fixture',discriminator:'0',bot:true};
const channel=(id:string,owner='9',parent='2',stamp='2026-01-02T03:04:05.123456+00:00')=>({id,type:11,guild_id:'1',parent_id:parent,name:'fixture',owner_id:owner,thread_metadata:{archived:true,archive_timestamp:stamp,auto_archive_duration:1440,locked:false}});
const page=(threads:unknown[],has_more:unknown=false)=>({threads,members:[],has_more});
async function fixture(handler:http.RequestListener,run:(c:DiscordChannelClient,t:DiscordMirrorInventoryTransport)=>Promise<void>){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 const c=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${a.port}/api/v10/`});
 try{await run(c,new DiscordMirrorInventoryTransport(c));}finally{await c.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
test('complete listing decodes required members and rejects malformed known unused fields',()=>{
 assert.equal(decodeMirrorThreadsPage(bytes(page([channel('3')]))).threads[0]!.id,3n);
 for(const bad of [{threads:[]},{threads:[],members:null},{...page([]),has_more:1},{...page([]),members:[{}]},page([{...channel('3'),bitrate:'bad'}])])assert.throws(()=>decodeMirrorThreadsPage(bytes(bad)));
 assert.throws(()=>decodeMirrorThreadsPage(Buffer.from('{"threads":[],"members":[],"has_more":false,"has_more":true}')));
 assert.throws(()=>decodeMirrorGuildChannels(bytes([{id:'3'}])));
});
test('archive cursor is six-digit naive timestamp with exact source routing',()=>{
 assert.equal(mirrorArchiveTimestamp(parseDiscordTimestamp('1969-12-31T23:59:59.999999999+03:00')),'1969-12-31T23:59:59.999999+00:00');
 const t='2026-01-02T03:04:05.123456+00:00',p=mirrorArchivedThreadsPath(2n,t);
 assert.equal(p,'channels/2/threads/archived/public?before='+t+'&limit=100');assert.equal(mirrorInventoryResource(p),'channels/2');
 assert.equal(mirrorInventoryResource('guilds/1/threads/active'),'guilds/1');
 for(const p of ['guilds/0/channels','guilds/01/channels','guilds/18446744073709551616/channels','channels/2/threads/archived/public?limit=99','users/@me?x=1'])assert.equal(mirrorInventoryResource(p),null);
 for(const t of ['2026-13-02T03:04:05.123456+00:00','2026-01-02T03:04:05.123+00:00','2026-01-02T03:04:05.123456+00:00\n'])assert.throws(()=>mirrorArchivedThreadsPath(2n,t));
});
test('inventory filters active parent, consumes every page, replaces duplicate IDs and sorts',async()=>{
 const seen:string[]=[];await fixture((q,r)=>{seen.push(q.url!);const n=seen.length;r.end(JSON.stringify(n===1?bot:n===2?page([channel('5','8'),channel('7','9','99')]):n===3?page([channel('3','8'),channel('5')],true):page([channel('4')])));},async(c,t)=>{
  const result=await t.threadInventory(1n,2n,fresh());assert.deepEqual(result.map(x=>[x.channel.id,x.ownedByBot]),[[3n,false],[4n,true],[5n,true]]);
  assert.equal(seen.length,4);assert.equal(seen[0],'/api/v10/users/@me');assert.equal(seen[1],'/api/v10/guilds/1/threads/active');
  assert.equal(seen[3],'/api/v10/channels/2/threads/archived/public?before=2026-01-02T03:04:05.123456+00:00&limit=100');assert.equal(c.activeRequests,0);assert.ok(Object.isFrozen(result));
 });
});
for(const mode of ['missing-more','missing-cursor','repeated-cursor','late-error'])test('no partial inventory on '+mode,async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;if(calls===1){r.end(JSON.stringify(bot));return;}if(calls===2){r.end(JSON.stringify(page([])));return;}
 if(mode==='late-error'&&calls===4){r.writeHead(500);r.end('{"code":0,"message":"failed"}');return;}
 const p:Record<string,unknown>=page(mode==='missing-cursor'?[]:[channel('3')],true);if(mode==='missing-more')delete p.has_more;r.end(JSON.stringify(p));
 },async(c,t)=>{await assert.rejects(t.threadInventory(1n,2n,fresh()));assert.equal(calls,mode==='missing-more'||mode==='missing-cursor'?3:4);assert.equal(c.activeRequests,0);});
});
test('invalid bot model prevents downstream calls and preabort causes zero requests',async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.end('{"id":"9"}');},async(_c,t)=>{
  await assert.rejects(t.threadInventory(1n,2n,fresh()));assert.equal(calls,1);const a=new AbortController(),reason=new Error('before');a.abort(reason);await assert.rejects(t.threadInventory(1n,2n,a.signal),e=>e===reason);assert.equal(calls,1);
 });
});
test('guild channel list preserves topic and complete model validation',async()=>{
 await fixture((q,r)=>{assert.equal(q.url,'/api/v10/guilds/1/channels');r.end(JSON.stringify([{id:'2',type:0,topic:'project'}]));},async(c,t)=>{const result=await t.channels(1n,fresh());assert.equal(result[0]!.topic,'project');assert.equal(c.activeRequests,0);});
});
test('inventory deadline includes a stalled archive body',{timeout:15000},async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;if(calls<=2)r.end(JSON.stringify(calls===1?bot:page([])));else{r.writeHead(200);r.write('{');}},async(c,t)=>{
  await assert.rejects(t.threadInventory(1n,2n,fresh()),/phase=thread-inventory; whole-operation deadline=10s/);assert.equal(calls,3);assert.equal(c.activeRequests,0);
 });
});
