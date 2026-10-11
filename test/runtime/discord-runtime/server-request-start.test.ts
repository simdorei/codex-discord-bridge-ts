import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {promptFixture,callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {startServerRequestRuntimeWorker} from '../../../src/runtime/discord-runtime/server-request-start.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel,isRuntimeMonitoredWorker} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
const message={attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:'1',content:'',embeds:[],id:'991',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};
async function wire(run:(client:DiscordChannelClient,bodies:string[],reply:{value:unknown;gate:Promise<void>|null},sent:ReturnType<typeof deferred>)=>Promise<void>){
 const bodies:string[]=[],sent=deferred(),reply:{value:unknown;gate:Promise<void>|null}={value:message,gate:null};
 const server=http.createServer((request,response)=>{let body='';request.on('data',c=>body+=String(c));request.on('end',()=>{bodies.push(body);sent.resolve();void(async()=>{if(reply.gate)await reply.gate;response.end(JSON.stringify(reply.value));})();});});let client:DiscordChannelClient|undefined;
 try{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}});await run(client,bodies,reply,sent);}
 finally{try{if(client)await client.close();}finally{server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}
}
test('actual native pending prompt -> owned HTTP/model -> receipt, with original receiver and common worker handle',{timeout:15000},async()=>promptFixture(async(path,owner)=>wire(async(client,bodies,_reply,sent)=>{
 const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),exit=exits.receiver(),receiver=owner.subscribeServerRequests();let worker:RuntimeMonitoredWorker|undefined;const errors:unknown[]=[];
 Object.defineProperty(owner,'subscribeServerRequests',{value:()=>{throw new Error('unexpected resubscription');}});
 try{worker=await startServerRequestRuntimeWorker({owner,serverRequestReceiver:receiver},path,client,stop.signal,exits,e=>{errors.push(e);});exits.close();assert.equal(isRuntimeMonitoredWorker(worker),true);await sent.promise;stop.abort('done');assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(await exit.receive(),'server-request');assert.equal(await exit.receive(),null);assert.equal(receiver.tryReceive().kind,'Closed');assert.equal(bodies.length,1);const body=JSON.parse(bodies[0]!);assert.equal(body.enforce_nonce,true);assert.ok(body.components.length>0);assert.equal(errors.length,0);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,'991');}finally{db.close();}assert.deepEqual(await callPromptFixture(owner,'answers'),[]);assert.equal(owner.lifecycleSnapshot().healthy,true);assert.equal(client.activeRequests,0);
 }finally{stop.abort();if(worker)await worker.join();exits.close();receiver.dispose();}
})));
test('force abort after factory return joins in-flight response and receipt before releasing receiver',{timeout:15000},async()=>promptFixture(async(path,owner)=>wire(async(client,bodies,reply,sent)=>{
 const release=deferred();reply.gate=release.promise;const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),receiver=owner.subscribeServerRequests();let worker:RuntimeMonitoredWorker|undefined;
 try{worker=await startServerRequestRuntimeWorker({owner,serverRequestReceiver:receiver},path,client,stop.signal,exits,()=>{});await sent.promise;worker.abort();await new Promise(r=>setImmediate(r));assert.equal(worker.peek(),undefined);assert.equal(client.activeRequests,1);release.resolve();assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(receiver.tryReceive().kind,'Closed');assert.equal(bodies.length,1);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,'991');}finally{db.close();}}
 finally{release.resolve();stop.abort();if(worker)await worker.join();exits.close();receiver.dispose();}
})));
test('malformed success response remains uncertain and recreated runtime worker never posts it twice',{timeout:15000},async()=>promptFixture(async(path,owner)=>wire(async(client,bodies,reply)=>{
 reply.value={id:'991'};
 for(let n=0;n<2;n++){const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),receiver=owner.subscribeServerRequests();let worker:RuntimeMonitoredWorker|undefined;let errors=0;
 try{worker=await startServerRequestRuntimeWorker({owner,serverRequestReceiver:receiver},path,client,stop.signal,exits,e=>{assert.equal(e.kind,'Error');errors++;stop.abort('done');});assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(errors,1);assert.equal(receiver.tryReceive().kind,'Closed');}finally{stop.abort();if(worker)await worker.join();exits.close();receiver.dispose();}}
 assert.equal(bodies.length,1);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,null);}finally{db.close();}
})));
test('already stopped startup still disposes transferred receiver without HTTP or a stranded pre-entry task',{timeout:15000},async()=>promptFixture(async(path,owner)=>wire(async(client,bodies)=>{
 const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),receiver=owner.subscribeServerRequests();stop.abort('done');const worker=await startServerRequestRuntimeWorker({owner,serverRequestReceiver:receiver},path,client,stop.signal,exits,()=>{});worker.abort();assert.equal((await worker.join()).kind,'Returned');assert.equal(receiver.tryReceive().kind,'Closed');assert.equal(bodies.length,0);exits.close();
})));
test('invalid HTTP owner or closed notifier fails before receiver ownership transfer',{timeout:15000},async()=>promptFixture(async(path,owner)=>wire(async(client,bodies)=>{
 const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),receiver=owner.subscribeServerRequests();
 try{await assert.rejects(startServerRequestRuntimeWorker({owner,serverRequestReceiver:receiver},path,Object.create(DiscordChannelClient.prototype),stop.signal,exits,()=>{}),TypeError);assert.equal(receiver.tryReceive().kind,'Empty');exits.close();await assert.rejects(startServerRequestRuntimeWorker({owner,serverRequestReceiver:receiver},path,client,stop.signal,exits,()=>{}),/closed/);assert.equal(receiver.tryReceive().kind,'Empty');assert.equal(bodies.length,0);}finally{receiver.dispose();exits.close();}
})));
