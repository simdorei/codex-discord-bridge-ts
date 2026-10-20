import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {DiscordNewMirrorTransport} from '../../src/runtime/mirror-sync/new-mirror-http.ts';
import {NewThreadMirrorLink} from '../../src/runtime/mirror-sync/new-mirror-link.ts';
import {mirrorCreateThreadRequest,mirrorChannelResource,isMirrorChannelMethod} from '../../src/discord/mirror-channel-request.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {readMirrorCreationIn} from '../../src/store/mirror-creation.ts';
import {mirrorThreadChannels} from '../../src/store/mirror-mapping.ts';
import {TargetLocks} from '../../src/core/keyed-locks.ts';
const channel={id:'3',guild_id:'1',parent_id:'2',type:11,name:'hello'};const signal=()=>new AbortController().signal;
const pause=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(handler:http.RequestListener,run:(client:DiscordChannelClient,transport:DiscordNewMirrorTransport)=>Promise<void>){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');const client=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${a.port}/api/v10/`});
 try{await run(client,new DiscordNewMirrorTransport(client));}finally{await client.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
test('owned mirror HTTP uses exact read/create/update routes and typed complete channel decode',async()=>{
 const calls:unknown[]=[];await fixture((q,r)=>{let body='';q.on('data',c=>body+=String(c));q.on('end',()=>{calls.push([q.method,q.url,body]);r.end(q.method==='PATCH'?'not decoded':JSON.stringify(channel));});},async(client,t)=>{
  const found=await t.channel(3n,signal());assert.deepEqual(found,{id:3n,guildId:1n,parentId:2n,kind:11n,name:'hello',archived:false});assert.equal((await t.createThread(1n,2n,'hello',signal())).id,3n);await t.updateThread(found!,'renamed',signal());assert.deepEqual(calls,[['GET','/api/v10/channels/3',''],['POST','/api/v10/channels/2/threads','{"auto_archive_duration":10080,"type":11,"name":"hello"}'],['PATCH','/api/v10/channels/3','{"archived":false,"name":"renamed"}']]);assert.equal(client.activeRequests,0);
 });
});
test('only genuine parsed HTTP404 becomes absent, malformed body remains failure',async()=>{
 let body='{"code":10003,"message":"Unknown Channel"}',status=404;await fixture((_q,r)=>{r.writeHead(status);r.end(body);},async(_c,t)=>{assert.equal(await t.channel(3n,signal()),null);body='not json';await assert.rejects(t.channel(3n,signal()));status=403;body='{"code":50001,"message":"Missing Access"}';await assert.rejects(t.channel(3n,signal()),/HTTP 403/);});
});
test('partial, duplicate recognized fields and malformed ignored channel data cannot confirm create',async()=>{
 for(const body of ['{"id":"3"}','{"id":"3","type":11,"id":"4"}','{"id":"3","type":11,"bitrate":"bad"}'])await fixture((_q,r)=>r.end(body),async(_c,t)=>{await assert.rejects(t.createThread(1n,2n,'hello',signal()),/channel response model could not be decoded/);});
});
test('mirror429 retries exact request but server and decode failures never retry create',async()=>{
 const bodies:string[]=[];await fixture((q,r)=>{let body='';q.on('data',c=>body+=String(c));q.on('end',()=>{bodies.push(body);if(bodies.length===1){r.writeHead(429,{'x-ratelimit-scope':'user','x-ratelimit-bucket':'mirror','x-ratelimit-limit':'1','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'0.01'});r.end('unused');}else r.end(JSON.stringify(channel));});},async(_c,t)=>{await t.createThread(1n,2n,'hello',signal());assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);});
 for(const status of [500,200]){let calls=0;await fixture((_q,r)=>{calls++;r.writeHead(status);r.end(status===500?'{"code":0,"message":"failure"}':'{}');},async(_c,t)=>{await assert.rejects(t.createThread(1n,2n,'hello',signal()));assert.equal(calls,1);});}
});
test('body cancellation releases HTTP and preserves exact caller reason',async()=>{
 const entered=pause();await fixture((_q,r)=>{r.writeHead(200);r.write('{');entered.resolve();},async(c,t)=>{const a=new AbortController(),reason=new Error('cancel room create'),work=t.createThread(1n,2n,'hello',a.signal),rejected=assert.rejects(work,e=>e===reason);await entered.promise;a.abort(reason);await rejected;assert.equal(c.activeRequests,0);await c.close();assert.equal(c.ownedSockets,0);});
});
test('request validation uses source scalar count and canonical nonzero u64 routing',()=>{
 assert.equal(JSON.parse(mirrorCreateThreadRequest(2n,'😀'.repeat(100)).body).name.length,200);assert.throws(()=>mirrorCreateThreadRequest(2n,'😀'.repeat(101)),/length/);assert.throws(()=>mirrorCreateThreadRequest(2n,''),/length/);assert.throws(()=>mirrorCreateThreadRequest(0n,'x'),/identity/);assert.throws(()=>mirrorCreateThreadRequest(1n<<64n,'x'),/identity/);
 for(const path of ['channels/01','channels/0','channels/1/threads/','channels/1\n','channels/1?x','channels/18446744073709551616'])assert.equal(mirrorChannelResource(path),null);assert.equal(isMirrorChannelMethod('POST','channels/1'),false);assert.equal(isMirrorChannelMethod('GET','channels/1/threads'),false);assert.equal(isMirrorChannelMethod('PATCH','channels/1'),true);
});
test('real HTTP and SQLite new-room linker preserves custody before POST and commits one exact room',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{const calls:string[]=[];await fixture((q,r)=>{calls.push(q.method+' '+q.url);q.resume();if(q.method==='GET')r.end(JSON.stringify(q.url?.endsWith('/2')?{id:'2',guild_id:'1',type:0,name:'project'}:channel));else{assert.equal(readMirrorCreationIn(db,'thread')?.phase,'attempted');r.end(JSON.stringify(channel));}},async(_c,t)=>{
  const link=new NewThreadMirrorLink(path,t,new TargetLocks(),1n,()=>1);assert.equal(await link.linkNewThread(2n,'thread','hello','/project'),3n);assert.deepEqual(await mirrorThreadChannels(path,'thread'),[2n,3n]);assert.equal(readMirrorCreationIn(db,'thread'),null);assert.deepEqual(calls,['GET /api/v10/channels/2','POST /api/v10/channels/2/threads']);
 });}finally{db.close();}
}));
test('unknown HTTP create body retains attempted custody and repeated linkage never POSTs again',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{let creates=0;await fixture((q,r)=>{q.resume();if(q.method==='GET')r.end('{"id":"2","guild_id":"1","type":0}');else{creates++;r.end('{"id":"3"}');}},async(_c,t)=>{const link=new NewThreadMirrorLink(path,t,new TargetLocks());await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'));await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'),/outcome is unknown/);assert.equal(creates,1);assert.equal(readMirrorCreationIn(db,'thread')?.phase,'attempted');});}finally{db.close();}
}));
test('whole-operation ten-second budget cancels stalled successful body without retry',{timeout:15000},async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.writeHead(200);r.write('{');},async(c,t)=>{const start=performance.now();await assert.rejects(t.createThread(1n,2n,'hello',signal()),/whole-operation deadline=10s/);const elapsed=performance.now()-start;assert.ok(elapsed>=9900&&elapsed<14000);assert.equal(calls,1);assert.equal(c.activeRequests,0);});
});
