import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {DiscordMirrorDeletionTransport,mirrorDeleteRejectedStatus} from '../../src/runtime/mirror-sync/delete-http.ts';
import {NodeDiscordHttpWire} from '../../src/discord/node-http-wire.ts';
import {isMirrorChannelMethod} from '../../src/discord/mirror-channel-request.ts';
const fresh=()=>new AbortController().signal;
async function fixture(handler:http.RequestListener,run:(c:DiscordChannelClient,t:DiscordMirrorDeletionTransport)=>Promise<void>){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');const c=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${a.port}/api/v10/`});
 try{await run(c,new DiscordMirrorDeletionTransport(c));}finally{await c.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
test('delete uses exact no-body channel route; success body is not decoded',async()=>{
 const seen:unknown[]=[];await fixture((q,r)=>{let body='';q.on('data',x=>body+=String(x));q.on('end',()=>{seen.push([q.method,q.url,body]);r.end('not a channel model');});},async(c,t)=>{await t.delete(3n,fresh());assert.deepEqual(seen,[['DELETE','/api/v10/channels/3','']]);assert.equal(c.activeRequests,0);});
});
test('genuine parsed404 completes deletion, malformed404 remains unknown',async()=>{
 let valid=true;await fixture((_q,r)=>{r.writeHead(404);r.end(valid?'{"code":10003,"message":"Unknown Channel"}':'not JSON');},async(c,t)=>{await t.delete(3n,fresh());valid=false;await assert.rejects(t.delete(3n,fresh()),e=>{assert.equal(mirrorDeleteRejectedStatus(e),undefined);return true;});assert.equal(c.activeRequests,0);});
});
for(const status of [400,401,403,405,413,415,422])test(`parsed HTTP${status} is exact authoritative rejection without retry`,async()=>{
 let count=0;await fixture((_q,r)=>{count++;r.writeHead(status);r.end('{"code":0,"message":"rejected"}');},async(c,t)=>{await assert.rejects(t.delete(3n,fresh()),e=>mirrorDeleteRejectedStatus(e)===status);assert.equal(count,1);assert.equal(c.activeRequests,0);});
});
test('500 and malformed rejection bodies remain unknown; forged names and accessors grant no evidence',async()=>{
 for(const [status,body] of [[500,'{"code":0,"message":"failed"}'],[403,'broken']] as const){let count=0;await fixture((_q,r)=>{count++;r.writeHead(status);r.end(body);},async(_c,t)=>{await assert.rejects(t.delete(3n,fresh()),e=>mirrorDeleteRejectedStatus(e)===undefined);assert.equal(count,1);});}
 let calls=0;const e=new Proxy({name:'MirrorDeleteRejectedError',status:403},{get(){calls++;throw Error('hook');}});assert.equal(mirrorDeleteRejectedStatus(e),undefined);assert.equal(calls,0);
});
test('429 uses shared rate retry then exact original deletion route',async()=>{
 const seen:string[]=[];await fixture((q,r)=>{q.resume();seen.push(q.method+' '+q.url);if(seen.length===1){r.writeHead(429,{'x-ratelimit-scope':'user','x-ratelimit-bucket':'delete','x-ratelimit-limit':'1','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'0.01'});r.end('unused');}else{r.writeHead(204);r.end();}},async(_c,t)=>{await t.delete(3n,fresh());assert.deepEqual(seen,['DELETE /api/v10/channels/3','DELETE /api/v10/channels/3']);});
});
test('caller cancellation during response body keeps unknown outcome and joins owned HTTP',async()=>{
 let entered!:()=>void;const first=new Promise<void>(r=>entered=r);await fixture((_q,r)=>{r.writeHead(403);r.write('{');entered();},async(c,t)=>{const stop=new AbortController(),reason=new Error('cancel'),work=t.delete(3n,stop.signal),checked=assert.rejects(work,e=>e===reason&&mirrorDeleteRejectedStatus(e)===undefined);await first;stop.abort(reason);await checked;assert.equal(c.activeRequests,0);await c.close();assert.equal(c.ownedSockets,0);});
});
test('delete validation and preabort send no request; wire rejects noncanonical routes and body',async()=>{
 let calls=0;await fixture((_q,r)=>{calls++;r.end();},async(_c,t)=>{for(const id of [0n,1n<<64n])await assert.rejects(t.delete(id,fresh()));const stop=new AbortController(),reason=new Error('before');stop.abort(reason);await assert.rejects(t.delete(3n,stop.signal),e=>e===reason);assert.equal(calls,0);});
 assert.equal(isMirrorChannelMethod('DELETE','channels/3'),true);assert.equal(isMirrorChannelMethod('DELETE','channels/3/threads'),false);assert.equal(isMirrorChannelMethod('DELETE','channels/03'),false);
 const wire=new NodeDiscordHttpWire('http://127.0.0.1:1/api/v10/');try{await assert.rejects(wire.request({method:'DELETE',path:'channels/3',body:'{}',authorization:null},100,fresh()),/profile/);}finally{await wire.close();}
});
test('ten-second delete budget includes stalled error body and never mints rejection',{timeout:15000},async()=>{
 let count=0;await fixture((_q,r)=>{count++;r.writeHead(403);r.write('{');},async(c,t)=>{const start=performance.now();await assert.rejects(t.delete(3n,fresh()),e=>e instanceof Error&&/phase=room-delete; whole-operation deadline=10s/.test(e.message)&&mirrorDeleteRejectedStatus(e)===undefined);assert.ok(performance.now()-start>=9900);assert.equal(count,1);assert.equal(c.activeRequests,0);});
});
