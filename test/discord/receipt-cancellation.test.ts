import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {idempotentMessageRequest} from '../../src/discord/idempotent-message.ts';
import {sendReceiptChunk} from '../../src/runtime/completion/receipt-sender.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
const request=()=>idempotentMessageRequest(1n,'text','test','cancel',0);
test('receipt request cancellation aborts and joins native body without closing shared client',{timeout:5000},()=>storeFixture(async path=>{
 let count=0,started!:()=>void;const entered=new Promise<void>(r=>{started=r;});const server=createServer((req,res)=>{req.resume();req.on('end',()=>{count++;if(count===1){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');started();}else res.end(JSON.stringify({attachments:[],author:{id:'1',username:'u',discriminator:'0'},channel_id:'1',content:'',embeds:[],id:'100',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{
  const pre=new AbortController();pre.abort();await assert.rejects(client.sendValidated(request(),pre.signal));assert.equal(count,0);
  const abort=new AbortController(),transport={sendValidated:(r:ReturnType<typeof request>)=>client.sendValidated(r,abort.signal)},chunk={domain:'test',logicalKey:'cancel',chunkIndex:0,content:'text'};
  const pending=sendReceiptChunk(path,transport,1n,chunk);await entered;abort.abort(new Error('operation deadline'));await assert.rejects(pending,/unconfirmed/);assert.equal(client.activeRequests,0);assert.equal(await state.unknownDeliveryReceiptCount(path),1n);
  await assert.rejects(sendReceiptChunk(path,client,1n,chunk),/outcome unknown/);assert.equal(count,1);
  assert.equal(await client.sendValidated(idempotentMessageRequest(1n,'other','test','other',0)),100n);assert.equal(count,2);
 }finally{await client.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);}
}));
