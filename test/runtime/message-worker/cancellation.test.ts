import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {asyncChoiceServer} from '../../helpers/async-choice-server.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage} from '../../../src/runtime/message-worker/classification.ts';
import {admitMessageCandidateAt} from '../../../src/runtime/message-worker/admission.ts';
import {createMessageProcessor,type MessageBusinessServices} from '../../../src/runtime/message-worker/processor.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import type {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
const config={attachmentsEnabled:true,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n};
async function admitted(path:string,text='!help',attachments:unknown[]=[]){const m=decodeGatewayMessage(JSON.stringify({attachments,author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:text,embeds:[],id:'3',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false,type:0})),policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});const c=await classifyGatewayMessage(m,path,{enableMessageContent:true,plainAskMentionUserIds:new Set()},policy,null);assert.equal(c.kind,'Candidate');if(c.kind!=='Candidate')throw Error();const a=(await admitMessageCandidateAt(c.candidate,100,{now:()=>101,report:()=>{}}))!,gate=new AdmissionGate(),permit=gate.tryEnter(),fence=DrainFenceKey.create('runtime','1|2','message');a.retainAdmission(permit);permit.release();gate.seal(fence);return {a,gate,fence};}
function context(path:string,server:PortableResidentLifecycle,http:DiscordChannelClient,services:MessageBusinessServices){return {database:path,applicationId:4n,server,http,config,attachmentRoot:dirname(path),attachmentTransport:{async get(){throw Error('unused transport');}},attachmentReport:()=>{},controlVerifier:new ControlTurnVerifier(path,server,{selectedThreadId:()=> 't'},new TargetLocks()),services,now:()=>102};}
test('pre-aborted processor disposes admitted custody and permit without target action or HTTP',()=>storeFixture(path=>httpFixture((http,seen)=>asyncChoiceServer({},async server=>{
 const owner=await admitted(path),abort=new AbortController(),reason=new Error('stop');abort.abort(reason);const services:MessageBusinessServices={async targetThreadId(){assert.fail();},async executeWithIngressContext(){assert.fail();},notifyDeliveryReady(){assert.fail();}};
 await assert.rejects(createMessageProcessor(context(path,server,http,services))(owner.a,abort.signal),e=>e===reason);assert.equal(owner.gate.isDrainedFor(owner.fence),true);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');assert.deepEqual(seen,[]);
}))));
test('processing abort passes exact signal to required business port and joins its cleanup before release',()=>storeFixture(path=>httpFixture((http,seen)=>asyncChoiceServer({},async server=>{
 const owner=await admitted(path),abort=new AbortController(),reason=new Error('action stop');let entered!:()=>void,finish!:()=>void,cleaned=false;const began=new Promise<void>(r=>entered=r),cleanup=new Promise<void>(r=>finish=r);
 const services:MessageBusinessServices={async targetThreadId(){return 't';},async executeWithIngressContext(_a,_actor,_key,signal){assert.equal(signal,abort.signal);entered();await new Promise<void>(r=>signal!.addEventListener('abort',()=>r(),{once:true}));await cleanup;cleaned=true;throw signal!.reason;},notifyDeliveryReady(){assert.fail();}};
 const pending=createMessageProcessor(context(path,server,http,services))(owner.a,abort.signal),failed=assert.rejects(pending,e=>e===reason);await began;abort.abort(reason);await Promise.resolve();assert.equal(owner.gate.isDrainedFor(owner.fence),false);assert.equal(cleaned,false);finish();await failed;assert.equal(cleaned,true);assert.equal(owner.gate.isDrainedFor(owner.fence),true);assert.deepEqual(seen,[]);
}))));
test('message reply body cancellation keeps unknown receipt and result but releases custody and shared HTTP',()=>storeFixture(path=>asyncChoiceServer({},async server=>{
 let entered!:()=>void,count=0;const began=new Promise<void>(r=>entered=r),wire=createServer((req,res)=>{req.resume();req.on('end',()=>{count++;res.writeHead(200);res.write('{');entered();});});await new Promise<void>(r=>wire.listen(0,'127.0.0.1',r));const http=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(wire.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{const owner=await admitted(path),abort=new AbortController(),reason=new Error('reply stop'),services:MessageBusinessServices={async targetThreadId(){return 't';},async executeWithIngressContext(){return {text:'done',waitsForFinal:false,ui:null};},notifyDeliveryReady(){assert.fail();}};
 const pending=createMessageProcessor(context(path,server,http,services))(owner.a,abort.signal),failed=assert.rejects(pending,e=>e===reason);await began;abort.abort(reason);await failed;assert.equal(owner.gate.isDrainedFor(owner.fence),true);assert.equal(http.activeRequests,0);assert.equal(count,1);assert.equal(await state.unknownDeliveryReceiptCount(path),1n);const row=(await state.getIngress(path,'message:3'))!;assert.equal(row.confirmationDelivered,false);assert.deepEqual(row.outcome,{response:'done',waits_for_final:false});
 }finally{await http.close();wire.closeAllConnections();await new Promise<void>((r,j)=>wire.close(e=>e?j(e):r()));assert.equal(http.ownedSockets,0);}
})));
test('attachment abort propagates through processor without ordinary failed-input fallback or action',()=>storeFixture(path=>httpFixture((http,seen)=>asyncChoiceServer({},async server=>{
 const attachment={id:'10',filename:'a.txt',size:0,url:'https://example.invalid/unused',proxy_url:'https://example.invalid/unused'},owner=await admitted(path,'!new raw',[attachment]),abort=new AbortController(),reason=new Error('attachment stop');let calls=0;const services:MessageBusinessServices={async targetThreadId(){return 't';},async executeWithIngressContext(){calls++;return {text:'bad',waitsForFinal:false,ui:null};},notifyDeliveryReady(){assert.fail();}};
 const ctx=context(path,server,http,services);const transport={async get(_url:string,signal?:AbortSignal){assert.equal(signal,abort.signal);abort.abort(reason);throw reason;}};
 await assert.rejects(createMessageProcessor({...ctx,attachmentTransport:transport})(owner.a,abort.signal),e=>e===reason);assert.equal(calls,0);assert.equal(owner.gate.isDrainedFor(owner.fence),true);assert.deepEqual(seen,[]);assert.equal((await state.getIngress(path,'message:3'))!.outcome,undefined);
}))));
