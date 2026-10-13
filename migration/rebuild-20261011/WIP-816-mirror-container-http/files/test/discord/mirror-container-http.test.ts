import test from 'node:test';import assert from 'node:assert/strict';import * as http from 'node:http';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {DiscordMirrorContainerTransport} from '../../src/runtime/mirror-sync/container-http.ts';
import {mirrorCreateContainerRequest,mirrorUpdateContainerRequest,mirrorContainerCreatePath} from '../../src/discord/mirror-container-request.ts';
const fresh=()=>new AbortController().signal;
async function fixture(handler:http.RequestListener,run:(c:DiscordChannelClient,t:DiscordMirrorContainerTransport)=>Promise<void>){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 const c=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${a.port}/api/v10/`});
 try{await run(c,new DiscordMirrorContainerTransport(c));}finally{await c.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
test('container request bytes preserve source field order and omit absent optionals',()=>{
 assert.deepEqual(mirrorCreateContainerRequest(1n,null,4n,'Codex',null),{path:'guilds/1/channels',body:'{"type":4,"name":"Codex"}'});
 assert.equal(mirrorCreateContainerRequest(1n,2n,0n,'project','').body,'{"type":0,"name":"project","parent_id":"2","topic":""}');
 assert.equal(mirrorUpdateContainerRequest(3n,'new',null).body,'{"name":"new"}');
 assert.equal(mirrorUpdateContainerRequest(3n,'new','topic').body,'{"name":"new","topic":"topic"}');
});
test('validation uses scalar-count limits and exact nonzero IDs',()=>{
 assert.doesNotThrow(()=>mirrorCreateContainerRequest(1n,null,0n,'😀'.repeat(100),'😀'.repeat(1024)));
 for(const f of [()=>mirrorCreateContainerRequest(0n,null,4n,'x',null),()=>mirrorCreateContainerRequest(1n,0n,0n,'x',null),()=>mirrorCreateContainerRequest(1n,null,11n as never,'x',null),()=>mirrorCreateContainerRequest(1n,null,0n,'',null),()=>mirrorCreateContainerRequest(1n,null,0n,'x'.repeat(101),null),()=>mirrorCreateContainerRequest(1n,null,0n,'x','x'.repeat(1025)),()=>mirrorUpdateContainerRequest(3n,'x','\ud800')])assert.throws(f);
 for(const p of ['guilds/0/channels','guilds/01/channels','guilds/1/channels?x=1','guilds/1/channels\n'])assert.equal(mirrorContainerCreatePath(p),false);
});
test('real shared HTTP creates category and text and reads full topic model',async()=>{
 const seen:unknown[]=[];await fixture((q,r)=>{let body='';q.on('data',x=>body+=String(x));q.on('end',()=>{seen.push([q.method,q.url,body]);r.end(JSON.stringify({id:'3',type:body.includes('"type":4')?4:0,guild_id:'1',name:'name',topic:'saved'}));});},async(c,t)=>{
  assert.equal((await t.create(1n,null,4n,'Codex',null,fresh())).kind,4n);
  assert.equal((await t.create(1n,2n,0n,'name','topic',fresh())).topic,'saved');
  assert.equal((await t.channel(3n,fresh()))!.topic,'saved');
  assert.deepEqual(seen,[['POST','/api/v10/guilds/1/channels','{"type":4,"name":"Codex"}'],['POST','/api/v10/guilds/1/channels','{"type":0,"name":"name","parent_id":"2","topic":"topic"}'],['GET','/api/v10/channels/3','']]);assert.equal(c.activeRequests,0);
 });
});
test('update ignores successful response model but preserves exact optional topic semantics',async()=>{
 const bodies:string[]=[];await fixture((q,r)=>{assert.equal(q.method,'PATCH');let b='';q.on('data',x=>b+=String(x));q.on('end',()=>{bodies.push(b);r.end('not a model');});},async(_c,t)=>{await t.update(3n,'n',null,fresh());await t.update(3n,'n','',fresh());assert.deepEqual(bodies,['{"name":"n"}','{"name":"n","topic":""}']);});
});
test('malformed create and malformed404 remain errors; parsed404 read is absent',async()=>{
 for(const [status,body] of [[200,'{"id":"3"}'],[404,'bad']] as const)await fixture((_q,r)=>{r.writeHead(status);r.end(body);},async(_c,t)=>{await assert.rejects(t.create(1n,null,4n,'Codex',null,fresh()));});
 await fixture((_q,r)=>{r.writeHead(404);r.end('{"code":10003,"message":"Unknown Channel"}');},async(_c,t)=>assert.equal(await t.channel(3n,fresh()),null));
});
test('preabort and invalid create do not dispatch HTTP',async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.end('{}');},async(_c,t)=>{const a=new AbortController(),reason=new Error('stop');a.abort(reason);await assert.rejects(t.create(1n,null,4n,'Codex',null,a.signal),e=>e===reason);await assert.rejects(t.create(1n,null,4n,'',null,fresh()));assert.equal(calls,0);});
});
