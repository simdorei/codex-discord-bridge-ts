import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {promptFixture,callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {promptHttpFixture,promptHttpMessage} from '../../helpers/server-prompt-http-fixture.ts';
import {work,stage,enqueue} from '../../helpers/interaction-worker-fixture.ts';
import type {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand} from '../../../src/discord/interaction-routing.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {startPreparedInteractionWorker} from '../../../src/runtime/discord-runtime/interaction-bootstrap.ts';
import {startServerRequestRuntimeWorker} from '../../../src/runtime/discord-runtime/server-request-start.ts';
import {createPreparedMessageHandler,capturePreparedMessageOptions} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createPreparedHistoryOperations} from '../../../src/runtime/discord-runtime/history-bootstrap.ts';
import {createGatewayMessageHandler} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {captureNativePromptReceipts} from '../../../src/runtime/server-prompt-receipt-profile.ts';
import {ServerRequestDelivery} from '../../../src/runtime/server-request-delivery.ts';
import {deliverServerPrompts} from '../../../src/runtime/server-prompt-delivery.ts';
import {createMessageProcessor} from '../../../src/runtime/message-worker/processor.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import {deliverActionResult} from '../../../src/runtime/interaction-worker/action-delivery.ts';
import {recoverDiscordHistoryChannel} from '../../../src/runtime/history-poll/discord-gap.ts';
import {prepareServerPrompts} from '../../../src/runtime/server-prompt-redisplay.ts';
const identity={applicationId:4n,userId:9n},signal=new AbortController().signal;
function record(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT receipt_key,message_id FROM codex_delivery_receipts ORDER BY receipt_key').all();}finally{db.close();}}
function inspect(t:TestContext){
 for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail(`main-thread receipt ${name}`));
 const operations:{lane:string;operation:string;key:string;guard:unknown}[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/native-receipt-store-worker.ts'))operations.push({lane:'begin',...args[1] as {operation:string;key:string;guard:unknown}});return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(String(args[0]).endsWith('/native-receipt-store-worker.ts'))operations.push({lane:'completion',...args[1] as {operation:string;key:string;guard:unknown}});return complete.apply(this,args);});
 return operations;
}
function verify(operations:ReturnType<typeof inspect>,domain:string){assert.deepEqual(operations.map(x=>[x.lane,x.operation]),[['begin','Begin'],['completion','Confirm']]);assert.ok(operations.every(x=>x.guard===null&&x.key.includes(domain)));assert.equal(ownedWorkerUsage().Control,0);}
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){await promptFixture(async(path,server)=>{const f=await setup(path,server);await run(f);assert.equal(f.queue.locks.activeTargetCount,0);assert.deepEqual(await callPromptFixture(server,'answers'),[]);});}
async function setup(path:string,server:PortableResidentLifecycle) {
 const codex=join(dirname(path),'codex.sqlite'),bridgePath=join(dirname(path),'bridge.json'),db=new DatabaseSync(codex);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES('t','Target','/tmp',1,0,0)");}finally{db.close();}
 const bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('t');const gate=new AdmissionGate(),backend=new AppServerTurnBackend(server,()=> 'fixture',{resumeTimeoutMs:1000,historyTimeoutMs:1000}),queue=new QueueStartCoordinator(path,backend,{admission:gate}),executor=new RuntimeCommandExecutor({paths:{state:codex,mirror:path,bridge:bridgePath},bridge,server,backend,queue,render:()=> 'fixture',preparePrompt:async p=>p,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000}),policy=new InteractionAccessPolicy({allowAllChannels:false,allowedChannelIds:[1n],allowedUserIds:[2n],mirroredChannelIds:[]});
 const reports:string[]=[],options={config:{attachmentsEnabled:false,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n},attachmentRoot:dirname(path),attachmentTransport:{async get(){throw Error('unexpected attachment');}},attachmentReport:()=>{},classification:{enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()},report:(code:string)=>{reports.push(code);},now:()=>102};
 return {path,server,queue,gate,options,reports,startup:{owner:server,queue,executor,policy}};
}
test('installed automatic startup uses native receipt ownership with poisoned facade and joins accepted response after stop',async t=>{
 const operations=inspect(t),stop=new AbortController();await promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
  const exits=new RuntimeWorkerExitChannel(),receiver=server.subscribeServerRequests(),errors:unknown[]=[],worker=await startServerRequestRuntimeWorker({owner:server,serverRequestReceiver:receiver},path,http,stop.signal,exits,error=>errors.push(error));
  try{assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(receiver.tryReceive().kind,'Closed');assert.equal(seen.length,1);assert.equal(record(path)[0]!.message_id,'901');assert.deepEqual(errors,[]);verify(operations,'server-request/prompt/v1');assert.deepEqual(await callPromptFixture(server,'answers'),[]);}finally{stop.abort();await worker.join();receiver.dispose();exits.close();}
 },()=>{stop.abort(Error('stop after request accepted'));}));
});
test('installed slash approval traverses original executor, action custody and native redisplay receipt before followup',async t=>{
 const operations=inspect(t);await fixture(f=>promptHttpFixture(async(http,seen)=>{
  const decoded=decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},id:'31',token:'offline_token',type:2,data:{id:'9',name:'approval',type:1}})),base=work(f.path,31n,f.gate),w=Object.freeze({...base,work:routeGatewayCommand(decoded,false).work}),q=createInteractionWorkQueue(),exits=new RuntimeWorkerExitChannel();await stage(w);enqueue(q,w);
  const worker=await startPreparedInteractionWorker(f.startup,q,http,exits,code=>f.reports.push(code));
  try{worker.closeInput();assert.deepEqual(await worker.worker.join(),{kind:'Returned',result:{ok:true}});assert.equal((await state.getIngress(f.path,w.custodyIngressId))!.confirmationDelivered,true);assert.deepEqual(seen.map(x=>x.method),['POST','PATCH']);assert.equal(record(f.path)[0]!.message_id,'901');assert.deepEqual(f.reports,[]);verify(operations,'server-request/redisplay/v1');}finally{worker.closeInput();await worker.worker.join();exits.close();q.sender.dispose();q.receiver.dispose();}
 }));
});
test('installed message approval keeps native profile through frozen gateway context and records original command identity',async t=>{
 const operations=inspect(t);await fixture(f=>promptHttpFixture(async(http,seen)=>{
  const captured=capturePreparedMessageOptions(f.startup,f.gate,http,f.options);assert.equal(captured.context.nativePromptReceipts,true);assert.ok(Object.isFrozen(captured.context));const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),message=decodeGatewayMessage(JSON.stringify(promptHttpMessage('32')));
  await handler(message,identity,signal);await handler(message,identity,signal);assert.equal((await state.getIngress(f.path,'message:32'))!.confirmationDelivered,true);assert.equal(seen.length,1);assert.match(String(record(f.path)[0]!.receipt_key),/message:32/);assert.equal(record(f.path)[0]!.message_id,'901');assert.deepEqual(f.reports,[]);verify(operations,'server-request/redisplay/v1');
 }));
});
for(const mode of ['gap','poll'] as const)test(`installed ${mode} history approval preserves native profile through actual history context copies`,async t=>{
 const operations=inspect(t);await fixture(f=>promptHttpFixture(async(http,seen)=>{
  const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),history=createPreparedHistoryOperations(f.startup,f.gate,http,gaps,{...f.options,allowedChannelIds:new Set([1n]),startupChannelId:null,historyPolicyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},historyTargetLimits:{maxRows:128,timeoutMs:5000}});
  try{if(mode==='gap'){tracker.record(1n,{timestampMicros:1577836800000000n,messageId:1n},'Full');await history.recover(identity,signal);assert.equal(gaps.snapshot().length,0);}else{const cursor=new HistoryPollState();await history.poll(cursor,identity,signal);assert.equal(cursor.isPrimed(1n),true);}
   assert.equal((await state.getIngress(f.path,'message:33'))!.confirmationDelivered,true);assert.deepEqual(seen.map(x=>x.method),['GET','POST']);assert.equal(record(f.path)[0]!.message_id,'902');assert.match(String(record(f.path)[0]!.receipt_key),/message:33/);verify(operations,'server-request/redisplay/v1');assert.equal(f.reports.length,1);assert.equal(f.reports[0],mode==='gap'?'discord_message_gap_recovered':'discord_history_poll');
  }finally{gaps.dispose();tracker.close();}
 },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify([promptHttpMessage('33')]));}));
});
test('shared emergency handler retains explicitly captured native profile even if source context changes later',async t=>{
 const operations=inspect(t);await fixture(f=>promptHttpFixture(async(http,seen)=>{
  const captured=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),prompts=await prepareServerPrompts(f.path,f.server,'t',1n,2n),context={...captured.context,services:{...captured.context.services,executeWithIngressContext:async()=>({text:'prepared emergency fixture',waitsForFinal:false,ui:{kind:'ServerPrompts' as const,prompts}})}};
  const handler=createGatewayMessageHandler({...captured,context});context.nativePromptReceipts=false;const fence=DrainFenceKey.create('fixture','1|2','worker');f.gate.seal(fence);f.gate.closeControls(fence);await handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage('34','!force_restart'))),identity,signal);
  assert.equal(seen.length,1);assert.equal((await state.getIngress(f.path,'message:34'))!.confirmationDelivered,true);assert.equal(f.gate.isDrainedFor(fence),true);verify(operations,'server-request/redisplay/v1');
 }));
});
test('receipt profiles are captured as own strict booleans without executing getters or proxy hooks',async()=>{
 let hooks=0;const getter=Object.defineProperty({},'nativePromptReceipts',{get(){hooks++;return true;}}),proxy=new Proxy({nativePromptReceipts:true},{getOwnPropertyDescriptor(){hooks++;throw Error('proxy trap');}});
 assert.equal(captureNativePromptReceipts({}),false);assert.equal(captureNativePromptReceipts(Object.create({nativePromptReceipts:true})),false);assert.equal(captureNativePromptReceipts({nativePromptReceipts:false}),false);assert.equal(captureNativePromptReceipts({nativePromptReceipts:true}),true);
 for(const input of [getter,proxy,...[undefined,null,0,1,'true',{}].map(nativePromptReceipts=>({nativePromptReceipts}))]){assert.throws(()=>captureNativePromptReceipts(input),TypeError);assert.throws(()=>createMessageProcessor(input as never),TypeError);await assert.rejects(deliverServerPrompts(input as never,[]),TypeError);}
 assert.equal(hooks,0);assert.throws(()=>new ServerRequestDelivery('missing',null as never,null as never,1 as never),TypeError);assert.throws(()=>createInteractionProcessor('missing',null as never,null as never,null as never,1 as never),TypeError);await assert.rejects(deliverActionResult(null as never,null as never,'missing',null as never,null as never,1 as never),TypeError);
 await fixture(f=>promptHttpFixture(async(http,seen)=>{const captured=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),bad=Object.defineProperty({...captured.context},'nativePromptReceipts',{get(){hooks++;return true;}});assert.throws(()=>createGatewayMessageHandler({...captured,context:bad}),TypeError);await assert.rejects(recoverDiscordHistoryChannel({...captured,context:bad,applicationId:4n,botUserId:9n},1n,{micros:0n,messageId:1n}),TypeError);assert.equal(hooks,0);assert.deepEqual(seen,[]);}));
});
test('installed automatic stop retains worker and receiver until accepted native confirmation exits a real SQLite lock',async t=>{
 const operations=inspect(t),stop=new AbortController();let blocker:DatabaseSync|undefined;await promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
  const exits=new RuntimeWorkerExitChannel(),receiver=server.subscribeServerRequests(),errors:unknown[]=[],worker=await startServerRequestRuntimeWorker({owner:server,serverRequestReceiver:receiver},path,http,stop.signal,exits,error=>errors.push(error));let ticks=0;const timer=setInterval(()=>ticks++,5);
  try{const deadline=performance.now()+5000;while(!operations.some(x=>x.operation==='Confirm')){assert.ok(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}await new Promise(resolve=>setTimeout(resolve,100));assert.equal(worker.peek(),undefined);assert.equal(receiver.tryReceive().kind,'Empty');assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);assert.equal(seen.length,1);blocker!.exec('ROLLBACK');assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(record(path)[0]!.message_id,'901');assert.equal(receiver.tryReceive().kind,'Closed');assert.deepEqual(errors,[]);verify(operations,'server-request/prompt/v1');}finally{clearInterval(timer);if(blocker?.isTransaction)blocker.exec('ROLLBACK');stop.abort();await worker.join();blocker?.close();receiver.dispose();exits.close();}
 },()=>{blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');stop.abort(Error('stop during accepted HTTP'));}));
});
