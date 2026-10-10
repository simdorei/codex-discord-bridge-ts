import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as http from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {idempotentMessageRequest} from '../../src/discord/idempotent-message.ts';
const message={attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:'1',content:'',embeds:[],id:'123',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};
const request=(channel=1n)=>idempotentMessageRequest(channel,'body','owned-client','key',0);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(handler:http.RequestListener,run:(client:DiscordChannelClient)=>Promise<void>,options:{globalLimit?:number;report?:(error:unknown)=>void}={}){
 const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:options.report??(()=>{}),...(options.globalLimit===undefined?{}:{globalLimit:options.globalLimit})});
 try{await run(client);}finally{await client.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
}
test('owned channel client composes complete receipt decoder and typing without adapter injection',{timeout:5000},async()=>{
 const paths:string[]=[],bodies:string[]=[];await fixture((req,res)=>{paths.push(req.url!);let body='';req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>{bodies.push(body);if(req.url?.endsWith('/typing')){res.writeHead(204);res.end();}else res.end(JSON.stringify(message));});},async client=>{
  assert.equal(await client.sendValidated(request()),123n);await client.createTyping(1n,new AbortController().signal);assert.deepEqual(paths,['/api/v10/channels/1/messages','/api/v10/channels/1/typing']);assert.equal(JSON.parse(bodies[0]!).enforce_nonce,true);assert.equal(bodies[1],'');assert.equal(client.activeRequests,0);
  const closing=client.close();assert.equal(client.close(),closing);await closing;assert.equal(client.ownedSockets,0);await assert.rejects(client.sendValidated(request()),/stopped/);
 });
});
test('owned client cannot be configured with an id-only success decoder',{timeout:5000},async()=>{
 await fixture((_q,res)=>res.end('{"id":"123"}'),async client=>{await assert.rejects(client.sendValidated(request()),/receipt decode failed/);assert.equal(client.activeRequests,0);});
});
test('429 wire retry reuses nonce and waits for the same owned rate manager',{timeout:5000},async()=>{
 const bodies:string[]=[];await fixture((req,res)=>{let body='';req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>{bodies.push(body);res.setHeader('x-ratelimit-scope','user');res.setHeader('x-ratelimit-bucket','fixture');res.setHeader('x-ratelimit-limit','1');res.setHeader('x-ratelimit-remaining','0');res.setHeader('x-ratelimit-reset-after','0.02');if(bodies.length===1){res.writeHead(429);res.end('not read');}else res.end(JSON.stringify(message));});},async client=>{assert.equal(await client.sendValidated(request()),123n);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);});
});
test('shared global limiter includes both typing and messages; close cancels queued work',{timeout:5000},async()=>{
 let calls=0;await fixture((req,res)=>{calls++;if(req.url?.endsWith('/typing')){res.writeHead(204);res.end();}else res.end(JSON.stringify(message));},async client=>{
  await client.createTyping(1n,new AbortController().signal);const pending=client.sendValidated(request(2n)),reason=new Error('close queued'),rejected=assert.rejects(pending,e=>e===reason);await tick();assert.equal(calls,1);await client.close(reason);await rejected;assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);assert.equal(calls,1);
 },{globalLimit:1});
});
test('close joins stalled body, pending same-channel admission and owned sockets',{timeout:5000},async()=>{
 const entered=deferred();let calls=0;await fixture((_q,res)=>{calls++;res.writeHead(200);res.write('{');entered.resolve();},async client=>{
  const first=client.sendValidated(request()),firstRejected=assert.rejects(first);await entered.promise;
  const second=client.sendValidated(request()),secondRejected=assert.rejects(second);await tick();await client.close(new Error('stop all'));await Promise.all([firstRejected,secondRejected]);assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);assert.ok(calls>=1&&calls<=2);
 });
});
test('pre-aborted typing opens no connection and preserves exact cancellation identity',{timeout:5000},async()=>{
 let calls=0;await fixture((_q,res)=>{calls++;res.end();},async client=>{const abort=new AbortController(),reason=new Error('cancel typing');abort.abort(reason);await assert.rejects(client.createTyping(1n,abort.signal),e=>e===reason);assert.equal(calls,0);assert.equal(client.activeRequests,0);});
});
test('test origin credentials/arbitrary host and asynchronous diagnostics are rejected before requests',async()=>{
 for(const options of [{token:'secret',testOrigin:'http://127.0.0.1:1234/api/v10/'},{token:null,testOrigin:'http://localhost:1234/api/v10/'},{token:null,testOrigin:'https://example.com/api/v10/'},{token:null,testOrigin:'http://127.0.0.1:99999/api/v10/'}])await assert.rejects(DiscordChannelClient.create({...options,report:()=>{}}));
 await assert.rejects(DiscordChannelClient.create({token:null,report:async()=>{}}),/synchronous/);
});
test('construction failures clean initialized owners without exposing token contents',async()=>{
 await assert.rejects(DiscordChannelClient.create({token:null,globalLimit:0,report:()=>{}}),/global limit/);
 await assert.rejects(DiscordChannelClient.create({token:'private-secret\n',report:()=>{}}),e=>e instanceof Error&&!e.message.includes('private-secret'));
 await assert.rejects(DiscordChannelClient.create({token:null,headerTimeoutMs:-1,report:()=>{}}),/timeout/);
 const client=await DiscordChannelClient.create({token:'offline-fixture',report:()=>{}});assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);await client.close();
});
test('one client close does not destroy another client HTTP agent or sockets',{timeout:5000},async()=>{
 const server=http.createServer((_q,res)=>res.end(JSON.stringify(message)));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const options={token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}};
 const a=await DiscordChannelClient.create(options),b=await DiscordChannelClient.create(options);try{assert.equal(await a.sendValidated(request()),123n);await a.close();assert.equal(await b.sendValidated(request()),123n);}finally{await Promise.all([a.close(),b.close()]);server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
