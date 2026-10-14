import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,type RequestListener} from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {idempotentMessageRequest} from '../../../src/discord/idempotent-message.ts';
import {messageNonce} from '../../../src/discord/message-nonce.ts';
import {ownedDiscordTransportFault} from '../../../src/discord/transport-fault.ts';
import {createSessionMirrorHttpTransport} from '../../../src/runtime/discord-runtime/session-mirror-http.ts';

const message={attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:'91',content:'mirror reply',embeds:[],id:'18446744073709551615',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};
const request=()=>idempotentMessageRequest(91n,'mirror reply','session-mirror/v1','thread:turn:message',0n);
async function until(predicate:()=>boolean){for(let i=0;i<2000&&!predicate();i++)await tick();assert.equal(predicate(),true);}
async function fixture(handler:RequestListener,run:(client:DiscordChannelClient)=>Promise<void>){
 const server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}});
 try{await run(client);}finally{await client.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

test('mirror HTTP adapter exposes a frozen own-method port and sends actual nonce-enforced POST with full receipt',{timeout:5000},async()=>{
 const seen:{method:string;path:string;body:string}[]=[];
 await fixture((req,res)=>{
  assert.equal(req.headers.authorization,undefined);let body='';req.on('data',part=>body+=String(part));
  req.on('end',()=>{seen.push({method:req.method!,path:req.url!,body});res.end(JSON.stringify(message));});
 },async client=>{
  const transport=createSessionMirrorHttpTransport(client),descriptor=Object.getOwnPropertyDescriptor(transport,'sendValidated');
  assert.equal(Object.isFrozen(transport),true);assert.deepEqual(Object.keys(transport),['sendValidated']);
  assert.ok(descriptor&&Object.hasOwn(descriptor,'value'));assert.equal(typeof descriptor.value,'function');assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);
  assert.equal(await transport.sendValidated(request()),18446744073709551615n);
  assert.deepEqual(seen,[{method:'POST',path:'/api/v10/channels/91/messages',body:request().body}]);
  const body=seen[0]!.body;assert.ok(body.includes(`"nonce":${messageNonce('session-mirror/v1',91n,'thread:turn:message',0n)}`));
  assert.equal(JSON.parse(body).enforce_nonce,true);assert.deepEqual(JSON.parse(body).allowed_mentions,{parse:[]});assert.equal(client.activeRequests,0);
 });
});

test('mirror HTTP adapter rejects id-only, malformed JSON and malformed complete receipt bodies without retrying',{timeout:5000},async()=>{
 const bodies=['{"id":"123"}','{"id":',JSON.stringify({...message,author:{...message.author,username:false}}),JSON.stringify({...message,id:'0'})];let calls=0;
 await fixture((_req,res)=>res.end(bodies[calls++]!),async client=>{
  const transport=createSessionMirrorHttpTransport(client);
  for(let i=0;i<bodies.length;i++){
   await assert.rejects(transport.sendValidated(request()),error=>ownedDiscordTransportFault(error)?.kind==='Receipt');
   assert.equal(calls,i+1);assert.equal(client.activeRequests,0);
  }
 });
});

test('mirror HTTP adapter rejects forged and proxy clients without reading caller fields',{timeout:5000},async()=>{
 let hooks=0,calls=0;
 await fixture((_req,res)=>{calls++;res.end(JSON.stringify(message));},async client=>{
  const trap={get(){hooks++;throw new Error('get trap');},getOwnPropertyDescriptor(){hooks++;throw new Error('descriptor trap');},getPrototypeOf(){hooks++;throw new Error('prototype trap');}};
  const forged=Object.create(DiscordChannelClient.prototype);
  Object.defineProperties(forged,{activeRequests:{get(){hooks++;return 0;}},sendValidated:{get(){hooks++;return async()=>1n;}}});
  for(const value of [null,{},forged,new Proxy(client,trap),new Proxy(forged,trap)])assert.throws(()=>createSessionMirrorHttpTransport(value as DiscordChannelClient),TypeError);
  assert.equal(hooks,0);assert.equal(calls,0);assert.equal(client.activeRequests,0);
 });
});

test('mirror HTTP binding ignores instance getters and replacement methods before and after capture',{timeout:5000},async()=>{
 let hooks=0,calls=0;
 await fixture((_req,res)=>{calls++;res.end(JSON.stringify(message));},async client=>{
  const before=createSessionMirrorHttpTransport(client);
  Object.defineProperties(client,{activeRequests:{configurable:true,get(){hooks++;throw new Error('instance request getter');}},sendValidated:{configurable:true,get(){hooks++;throw new Error('instance send getter');}}});
  const after=createSessionMirrorHttpTransport(client);
  Object.defineProperty(client,'sendValidated',{configurable:true,value:()=>{hooks++;throw new Error('instance replacement');}});
  assert.equal(await before.sendValidated(request()),18446744073709551615n);
  assert.equal(await Reflect.apply(after.sendValidated,{},[request()]),18446744073709551615n);
  assert.equal(hooks,0);assert.equal(calls,2);
 });
});

test('mirror HTTP binding captures original prototype methods before later replacement',{timeout:5000},async()=>{
 let hooks=0;
 await fixture((_req,res)=>res.end(JSON.stringify(message)),async client=>{
  const getter=Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!,send=DiscordChannelClient.prototype.sendValidated;
  let pending:Promise<bigint>;
  try{
   Object.defineProperty(DiscordChannelClient.prototype,'activeRequests',{configurable:true,get(){hooks++;throw new Error('prototype request getter');}});
   DiscordChannelClient.prototype.sendValidated=()=>{hooks++;throw new Error('prototype send replacement');};
   pending=createSessionMirrorHttpTransport(client).sendValidated(request());
  }finally{Object.defineProperty(DiscordChannelClient.prototype,'activeRequests',getter);DiscordChannelClient.prototype.sendValidated=send;}
  assert.equal(await pending,18446744073709551615n);assert.equal(hooks,0);assert.equal(client.activeRequests,0);
 });
});

test('mirror HTTP adapter validates signal brands without invoking proxy traps or caller getters',{timeout:5000},async()=>{
 let hooks=0,calls=0;
 await fixture((_req,res)=>{calls++;res.end(JSON.stringify(message));},async client=>{
  const forged=Object.create(AbortSignal.prototype);Object.defineProperty(forged,'aborted',{get(){hooks++;return false;}});
  const proxy=new Proxy(new AbortController().signal,{get(){hooks++;throw new Error('signal trap');},getPrototypeOf(){hooks++;throw new Error('signal prototype trap');}});
  for(const signal of [null,{},forged,proxy])assert.throws(()=>createSessionMirrorHttpTransport(client,signal as AbortSignal),TypeError);
  assert.equal(hooks,0);assert.equal(calls,0);
 });
});

test('pre-aborted mirror HTTP adapter preserves exact reason and opens no request',{timeout:5000},async()=>{
 let calls=0;
 await fixture((_req,res)=>{calls++;res.end(JSON.stringify(message));},async client=>{
  const stop=new AbortController(),reason={kind:'mirror stopped'};stop.abort(reason);
  await assert.rejects(createSessionMirrorHttpTransport(client,stop.signal).sendValidated(request()),error=>error===reason);
  assert.equal(calls,0);assert.equal(client.activeRequests,0);
  assert.equal(await createSessionMirrorHttpTransport(client).sendValidated(request()),18446744073709551615n);assert.equal(calls,1);
 });
});

for(const phase of ['headers','body'] as const)test(`mirror ${phase} cancellation joins the pending request without closing the shared client`,{timeout:5000},async()=>{
 let calls=0;
 await fixture((_req,res)=>{calls++;if(calls===1){if(phase==='body'){res.writeHead(200);res.write('{');}}else res.end(JSON.stringify(message));},async client=>{
  const stop=new AbortController(),reason={kind:`mirror ${phase} cancellation`},transport=createSessionMirrorHttpTransport(client,stop.signal);
  const pending=transport.sendValidated(request()),rejected=assert.rejects(pending,error=>error===reason);
  await until(()=>calls===1);assert.equal(client.activeRequests,1);stop.abort(reason);await rejected;
  assert.equal(client.activeRequests,0);
  assert.equal(await createSessionMirrorHttpTransport(client).sendValidated(request()),18446744073709551615n);
  assert.equal(calls,2);assert.equal(client.activeRequests,0);
 });
});
