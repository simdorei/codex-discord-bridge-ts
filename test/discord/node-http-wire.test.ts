import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as http from 'node:http';
import {brotliCompressSync} from 'node:zlib';
import {NodeDiscordHttpWire} from '../../src/discord/node-http-wire.ts';
import {DiscordResponseEngine} from '../../src/discord/response-engine.ts';
import {DiscordChannelRateLimiter} from '../../src/discord/rate-header-adapter.ts';
import {sendReceiptChunk} from '../../src/runtime/completion/receipt-sender.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import type {DiscordWireRequest} from '../../src/discord/response-engine.ts';
const request=(body='{}'):DiscordWireRequest=>({method:'POST',path:'channels/1/messages',body,authorization:null});
async function fixture(handler:http.RequestListener,run:(wire:NodeDiscordHttpWire,server:http.Server)=>Promise<void>){
 const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(address===null||typeof address==='string')throw new Error('No listener');const wire=new NodeDiscordHttpWire(`http://127.0.0.1:${address.port}/api/v10/`);
 try{await run(wire,server);}finally{await wire.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
test('actual HTTP request uses exact path/body/headers and releases its response ownership',{timeout:5000},async()=>{
 let url='',body='',encoding='',length='';await fixture((req,res)=>{url=req.url!;encoding=req.headers['accept-encoding']!;length=req.headers['content-length']!;req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>res.end('{"id":"91"}'));},async wire=>{const response=await wire.request(request('{"text":"한글"}'),2000,new AbortController().signal);assert.equal(response.status,200);assert.equal(new TextDecoder().decode(await response.bytes()),'{"id":"91"}');await assert.rejects(response.bytes(),/ownership/);await response.release();assert.equal(wire.activeRequests,0);assert.equal(url,'/api/v10/channels/1/messages');assert.equal(body,'{"text":"한글"}');assert.equal(Number(length),Buffer.byteLength(body));assert.equal(encoding,'br');});
});
test('Brotli body and first raw duplicate header preserve source wire semantics',{timeout:5000},async()=>{
 await fixture((_req,res)=>{res.setHeader('content-encoding','br');res.setHeader('x-ratelimit-bucket',['first','second']);res.end(brotliCompressSync(Buffer.from('{"value":1}')));},async wire=>{const r=await wire.request(request(),2000,new AbortController().signal);assert.equal(Buffer.from(r.headers.get('x-ratelimit-bucket')!).toString(),'first');assert.equal(Buffer.from(await r.bytes()).toString(),'{"value":1}');await r.release();});
});
test('non-ASCII bucket bytes remain Latin1 bytes rather than UTF8 re-encoding',{timeout:5000},async()=>{
 await fixture((_req,res)=>{res.socket!.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nX-RateLimit-Bucket: '),Buffer.from([255]),Buffer.from('\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')]));},async wire=>{const r=await wire.request(request(),2000,new AbortController().signal);assert.deepEqual([...r.headers.get('x-ratelimit-bucket')!],[255]);await r.release();});
});
test('redirect is returned without visiting its location',{timeout:5000},async()=>{
 let calls=0;await fixture((_req,res)=>{calls++;res.writeHead(302,{location:'https://example.invalid/never'});res.end('{}');},async wire=>{const r=await wire.request(request(),2000,new AbortController().signal);assert.equal(r.status,302);await r.release();assert.equal(calls,1);});
});
test('loopback origin never receives authorization and arbitrary remote origins are rejected',{timeout:5000},async()=>{
 for(const origin of ['https://example.com/api/v10/','http://discord.com/api/v10/','https://user:secret@discord.com/api/v10/','https://discord.com/api/v10/?x=1'])assert.throws(()=>new NodeDiscordHttpWire(origin),/Unsupported/);
 let calls=0;await fixture((_q,r)=>{calls++;r.end('{}');},async wire=>{await assert.rejects(wire.request({...request(),authorization:'Bot fake-secret'},100,new AbortController().signal),e=>e instanceof Error&&!e.message.includes('fake-secret'));assert.equal(calls,0);});
});
test('header deadline cancels and joins an actual stalled request',{timeout:5000},async()=>{
 await fixture(()=>{},async wire=>{await assert.rejects(wire.request(request(),20,new AbortController().signal),/HTTP request failed/);assert.equal(wire.activeRequests,0);await wire.close();assert.equal(wire.ownedSockets,0);});
});
test('abort during body streaming rejects with exact reason and joins cleanup',{timeout:5000},async()=>{
 await fixture((_q,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('partial');},async wire=>{const abort=new AbortController(),r=await wire.request(request(),2000,abort.signal),reason=new Error('stop body'),body=r.bytes(),rejected=assert.rejects(body,e=>e===reason);abort.abort(reason);await rejected;await r.release();assert.equal(wire.activeRequests,0);await wire.close();assert.equal(wire.ownedSockets,0);});
});
test('wire close reclaims an unread response and is idempotent',{timeout:5000},async()=>{
 await fixture((_q,res)=>{res.writeHead(200);res.write('pending');},async wire=>{const r=await wire.request(request(),2000,new AbortController().signal);assert.equal(wire.activeRequests,1);const closing=wire.close();assert.equal(wire.close(),closing);await closing;await r.release();assert.equal(wire.activeRequests,0);assert.equal(wire.ownedSockets,0);await assert.rejects(wire.request(request(),10,new AbortController().signal),/closed/);});
});
test('pre-abort sends nothing and invalid Brotli remains a body failure',{timeout:5000},async()=>{
 let calls=0;await fixture((_q,res)=>{calls++;res.setHeader('content-encoding','br');res.end('not-brotli');},async wire=>{const abort=new AbortController(),reason=new Error('pre-stop');abort.abort(reason);await assert.rejects(wire.request(request(),10,abort.signal),e=>e===reason);assert.equal(calls,0);const r=await wire.request(request(),2000,new AbortController().signal);await assert.rejects(r.bytes(),/body could not be read/);await r.release();assert.equal(wire.activeRequests,0);});
});
test('real loopback HTTP + rate manager + receipt store sends once and confirms durable identity',{timeout:10000},async()=>storeFixture(async path=>{
 let calls=0;await fixture((_q,res)=>{calls++;res.setHeader('content-type','application/json');res.end('{"id":"123"}');},async wire=>{const rate=new DiscordChannelRateLimiter({report:()=>{throw new Error('No warning');}}),engine=new DiscordResponseEngine({token:null,wire,rateLimiter:rate,decoder:{decode:body=>BigInt(JSON.parse(Buffer.from(body).toString()).id)}}),chunk={domain:'native-test',logicalKey:'one',chunkIndex:0,content:'content'};
 try{await sendReceiptChunk(path,engine,1n,chunk);await sendReceiptChunk(path,engine,1n,chunk);assert.equal(calls,1);assert.equal(wire.activeRequests,0);}finally{await engine.close();await rate.close();}
 });
}));
test('immediate close joins requests before socket assignment without leaking its agent',{timeout:5000},async()=>{
 for(let i=0;i<12;i++)await fixture(()=>{},async wire=>{const pending=wire.request(request(),2000,new AbortController().signal),rejected=assert.rejects(pending);await Promise.all([wire.close(),rejected]);assert.equal(wire.activeRequests,0);assert.equal(wire.ownedSockets,0);});
});
