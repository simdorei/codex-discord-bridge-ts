import {it} from 'node:test';import assert from 'node:assert/strict';import * as http from 'node:http';import {brotliCompressSync} from 'node:zlib';import {setImmediate as tick} from 'node:timers/promises';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {DiscordResponseEngine} from '../../src/discord/response-engine.ts';
import {discordMessageDecoder} from '../../src/discord/model/message.ts';
import {isDecodedGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
import {historyMessagePath,historyChannelResource,HISTORY_HTTP_MAX_BYTES} from '../../src/discord/history-request.ts';
import {NodeDiscordHttpWire} from '../../src/discord/node-http-wire.ts';
const message={attachments:[],author:{id:'2',username:'u',discriminator:'0'},channel_id:'42',content:'한글',embeds:[],id:'9007199254740993',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};
async function fixture(handler:http.RequestListener,run:(client:DiscordChannelClient,origin:string)=>Promise<void>,globalLimit=50){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const origin='http://127.0.0.1:'+addr.port+'/api/v10/';const client=await DiscordChannelClient.create({token:null,testOrigin:origin,report:()=>{},globalLimit});
 try{await run(client,origin);}finally{await client.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
it('history uses exact source GET ten-message route, empty request and complete branded model decoding',async()=>{
 let count=0;await fixture((req,res)=>{count++;assert.equal(req.method,'GET');assert.equal(req.url,'/api/v10/channels/42/messages?limit=10');assert.equal(req.headers.authorization,undefined);let body='';req.on('data',v=>body+=v);req.on('end',()=>{assert.equal(body,'');res.end(JSON.stringify([message]));});},async client=>{
  const rows=await client.fetchLatestChannelMessages(42n);assert.equal(rows.length,1);assert.equal(rows[0]!.id,9007199254740993n);assert.ok(isDecodedGatewayMessage(rows[0]));assert.ok(Object.isFrozen(rows));assert.equal(client.activeRequests,0);assert.equal(count,1);
 });
});
it('canonical history profile rejects other limits, cursors, paths, bodies and zero/overflow IDs before network',async()=>{
 assert.equal(historyMessagePath(42n),'channels/42/messages?limit=10');
 for(const path of ['channels/0/messages?limit=10','channels/042/messages?limit=10','channels/42/messages?limit=11','channels/42/messages?limit=10&before=1','channels/42/messages?limit=10\n','channels/18446744073709551616/messages?limit=10'])assert.equal(historyChannelResource(path),null);
 for(const id of [0n,-1n,1n<<64n])assert.throws(()=>historyMessagePath(id),TypeError);
 let calls=0;await fixture((_q,res)=>{calls++;res.end('[]');},async (_client,origin)=>{const wire=new NodeDiscordHttpWire(origin);try{for(const input of [{method:'GET' as const,path:'channels/42/messages?limit=11',body:null},{method:'POST' as const,path:historyMessagePath(42n),body:null},{method:'GET' as const,path:historyMessagePath(42n),body:'{}'}])await assert.rejects(wire.request({...input,authorization:null},1000,new AbortController().signal));assert.equal(calls,0);}finally{await wire.close();}});
});
it('malformed nested model or eleven rows fails entire actual HTTP page without automatic retry',async()=>{
 let calls=0;await fixture((_q,res)=>{calls++;res.end(JSON.stringify(calls===1?[message,{...message,author:{id:'2'}}]:Array.from({length:11},()=>message)));},async client=>{await assert.rejects(client.fetchLatestChannelMessages(42n),/history response/);await assert.rejects(client.fetchLatestChannelMessages(42n),/history response/);assert.equal(calls,2);assert.equal(client.activeRequests,0);});
});
it('Brotli complete history response is decoded and encoded/expanded bodies over budget are refused',async()=>{
 const huge=Buffer.alloc(HISTORY_HTTP_MAX_BYTES+1,32);let calls=0;await fixture((_q,res)=>{calls++;if(calls===1){res.setHeader('content-encoding','br');res.end(brotliCompressSync(Buffer.from(JSON.stringify([message]))));}else if(calls===2){res.end(huge);}else{res.setHeader('content-encoding','br');res.end(brotliCompressSync(huge));}},async client=>{assert.equal((await client.fetchLatestChannelMessages(42n)).length,1);await assert.rejects(client.fetchLatestChannelMessages(42n));assert.equal(client.activeRequests,0);await assert.rejects(client.fetchLatestChannelMessages(42n));assert.equal(client.activeRequests,0);assert.equal(calls,3);});
});
it('same owned rate manager retries 429 history and global limit also counts typing',async()=>{
 let calls=0;await fixture((_q,res)=>{calls++;res.setHeader('x-ratelimit-scope','user');res.setHeader('x-ratelimit-bucket','history');res.setHeader('x-ratelimit-limit','1');res.setHeader('x-ratelimit-remaining','0');res.setHeader('x-ratelimit-reset-after','0.01');if(calls===1){res.writeHead(429);res.end('ignored');}else res.end('[]');},async client=>{assert.deepEqual(await client.fetchLatestChannelMessages(42n),[]);assert.equal(calls,2);});
 calls=0;await fixture((_q,res)=>{calls++;res.writeHead(204);res.end();},async client=>{await client.createTyping(42n,new AbortController().signal);const reason=new Error('stop waiting'),c=new AbortController(),pending=client.fetchLatestChannelMessages(42n,c.signal),check=assert.rejects(pending,e=>e===reason);await tick();c.abort(reason);await check;assert.equal(calls,1);},1);
});
it('cancelled stalled HTTP body joins request cleanup and preserves exact signal reason',async()=>{
 const entered=deferred();await fixture((_q,res)=>{res.writeHead(200);res.write('[');entered.resolve();},async client=>{const c=new AbortController(),reason=new Error('stop body'),pending=client.fetchLatestChannelMessages(42n,c.signal),check=assert.rejects(pending,e=>e===reason);await entered.promise;c.abort(reason);await check;assert.equal(client.activeRequests,0);await client.close();assert.equal(client.ownedSockets,0);});
});
it('401 invalidates shared authorization owner and does not retry history',async()=>{
 let calls=0,releases=0;const engine=new DiscordResponseEngine({token:'offline-fixture',decoder:discordMessageDecoder,rateLimiter:{async acquire(){return {complete(){},release(){}};}},wire:{async request(input){calls++;assert.equal(input.authorization,'Bot offline-fixture');return {status:401,headers:new Map(),async bytes(){return Buffer.from('{"code":0,"message":"unauthorized"}');},release(){releases++;return Promise.resolve();}};}}});
 try{await assert.rejects(engine.fetchLatestChannelMessages(42n));assert.equal(engine.authorizationInvalidated,true);await assert.rejects(engine.fetchLatestChannelMessages(42n));assert.equal(calls,1);assert.equal(releases,1);}finally{await engine.close();}
});
