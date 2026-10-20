import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptFixture} from '../../helpers/server-prompt-fixture.ts';
import {promptHttpFixture,promptHttpMessage} from '../../helpers/server-prompt-http-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {capturePreparedMessageOptions} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createDiscordHistoryOperations} from '../../../src/runtime/discord-runtime/history-operations.ts';
import {createGatewayMessageHandler,type MessageHandlerOptions} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {newExecutionPrompt} from '../../../src/store/ingress-new-input.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const identity={applicationId:4n,userId:9n},messageId='9007199254740993',key=`message:${messageId}`;
const message=()=>({...promptHttpMessage(messageId,'!new raw'),attachments:[{id:'10',filename:'a.txt',size:3,url:'https://example.invalid/unused',proxy_url:'https://example.invalid/unused'}]});
function inspect(t:TestContext){
 for(const name of ['admitIngress','recordIngressProcessingMode','beginIngressExecution','recordNewInput','recordIngressResult','confirmIngress','holdIngress'] as const)t.mock.method(state,name,()=>assert.fail(`legacy ${name}`));
 const order:string[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as any;if(String(args[0]).endsWith('/native-journal-worker.ts')){assert.equal(q.id,key);assert.ok(['Admit','Mode','Begin','NewInput'].includes(q.operation));order.push(q.operation);}return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){const q=args[1] as any;if(String(args[0]).endsWith('/native-journal-worker.ts')){assert.equal(q.id,key);assert.ok(['Result','Confirm','Hold'].includes(q.operation));order.push(q.operation);}return complete.apply(this,args);});return order;
}
function options(f:ReturnType<typeof setupPromptRuntime>){return {...f.options,config:{...f.options.config,attachmentsEnabled:true},attachmentTransport:{async get(){return {contentLength:3n,chunks:(async function*(){yield Buffer.from('abc');})(),async release(){}};}}};}
function captured(f:ReturnType<typeof setupPromptRuntime>,http:Parameters<typeof capturePreparedMessageOptions>[2],execute:MessageHandlerOptions['context']['services']['executeWithIngressContext']){const base=capturePreparedMessageOptions(f.startup,f.gate,http,options(f));return {...base,context:{...base.context,services:{...base.context.services,executeWithIngressContext:execute}}};}
async function route(kind:'gateway'|'gap'|'poll',base:MessageHandlerOptions,signal:AbortSignal,sealed=false){
 if(kind==='gateway'){await createGatewayMessageHandler(base)(decodeGatewayMessage(JSON.stringify(message())),identity,signal);return;}
 const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),history=createDiscordHistoryOperations(gaps,{...base,nativeTargetLimits:{maxRows:128,timeoutMs:5000},allowedChannelIds:new Set([1n]),startupChannelId:null});
 try{if(kind==='gap'){tracker.record(1n,{timestampMicros:1577836800000000n,messageId:1n},'Full');await history.recover(identity,signal);if(sealed)assert.equal(gaps.snapshot().length,1);}else await history.poll(new HistoryPollState(),identity,signal);}finally{gaps.dispose();tracker.close();}
}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}}
for(const kind of ['gateway','gap','poll'] as const)test(`installed ${kind} persists native New input before execution with unchanged original plan and exact actor`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t);let executions=0;
 await promptHttpFixture(async(http,seen)=>{
  const base=captured(f,http,async(action,actor,request)=>{executions++;order.push('Execute');assert.deepEqual(action,{New:{prompt:'raw'}});assert.equal(request,key);assert.deepEqual(actor,{channelId:1n,userId:2n,discordMessageId:BigInt(messageId),autoQueueWhenBusy:false});const row=(await state.getIngress(path,key))!;assert.deepEqual((row.payload as any).plan,{Execute:{New:{prompt:'raw'}}});assert.match(newExecutionPrompt(row)!,/abc/);assert.match(newExecutionPrompt(row)!,/sha256: /);return {text:'created',waitsForFinal:false,ui:null};});
  await route(kind,base,new AbortController().signal);assert.equal(executions,1);assert.deepEqual(order,['Admit','Begin','NewInput','Execute','Result','Confirm']);assert.equal((await state.getIngress(path,key))!.confirmationDelivered,true);assert.equal(seen.filter(x=>x.method==='POST').length,1);
 },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify([message()]));});assert.equal(ownedWorkerUsage().Control,0);
}));
for(const kind of ['gateway','gap','poll'] as const)test(`sealed ${kind} cannot prepare attached New or dispatch thread/start`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),fence=DrainFenceKey.create('new-input','1|2','drain');f.gate.seal(fence);
 await promptHttpFixture(async(http,seen)=>{const base=captured(f,http,async()=>assert.fail('thread/start during sealed drain'));await route(kind,{...base,context:{...base.context,attachmentTransport:{async get(){assert.fail('attachment during drain');}}}},new AbortController().signal,true);assert.deepEqual(order,[]);assert.equal(await state.getIngress(path,key),null);assert.equal(f.gate.isDrainedFor(fence),true);if(kind!=='gateway')assert.deepEqual(seen,[]);});
}));
for(const failure of ['store','ack'] as const)test(`failed native New input ${failure} cannot execute or replay an attached command`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),run=OwnedWorkerSlot.prototype.run;
 if(failure==='store'){const db=new DatabaseSync(path);try{db.exec("CREATE TRIGGER reject_new_input BEFORE UPDATE OF outcome_json ON discord_ingress_journal WHEN json_type(NEW.outcome_json,'$.new_input')='object' BEGIN SELECT RAISE(ABORT,'fixture'); END");}finally{db.close();}}
 else t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const result=await run.apply(this,args) as any;if((args[1] as any).operation==='NewInput')result.requestId='foreign';return result;});
 await promptHttpFixture(async(http)=>{const base=captured(f,http,async()=>assert.fail('thread/start after unconfirmed preparation'));await route('gateway',base,new AbortController().signal);const row=(await state.getIngress(path,key))!;assert.equal(row.state,'held');assert.equal(row.confirmationDelivered,false);assert.equal((row.outcome as any)?.new_input!==undefined,failure==='ack');assert.deepEqual(order,['Admit','Begin','NewInput','Hold']);await route('gateway',base,new AbortController().signal);assert.deepEqual(order,['Admit','Begin','NewInput','Hold','Admit']);});assert.equal(ownedWorkerUsage().Control,0);
}));
test('cancelled locked native New input retains permit through actual exit and subsequent hold without thread/start',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),abort=new AbortController(),reason=Error('cancel prepared New'),run=OwnedWorkerSlot.prototype.run;let lock:DatabaseSync|undefined,holdSeen=false,restore:(()=>void)|undefined;const trace=new SharedArrayBuffer(8);
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if((args[1] as any).operation==='NewInput'){lock=new DatabaseSync(path);lock.exec('BEGIN IMMEDIATE');const extension=import.meta.url.endsWith('.js')?'.js':'.ts';restore=instrumentStoreWorker({match:'native-journal-worker'+extension,trace});}return run.apply(this,args);});
 const complete=OwnedWorkerSlot.prototype.runControlCompletion;t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if((args[1] as any).operation==='Hold')holdSeen=true;return complete.apply(this,args);});
 await promptHttpFixture(async(http,seen)=>{
  const base=captured(f,http,async()=>assert.fail('thread/start after cancelled preparation')),pending=route('gateway',base,abort.signal),failed=assert.rejects(pending,e=>e===reason);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
  try{await until(()=>lock!==undefined);const fence=DrainFenceKey.create('new-input','1|2','cancel');f.gate.seal(fence);abort.abort(reason);await new Promise(r=>setTimeout(r,50));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(holdSeen,false);
   lock!.exec('ROLLBACK');await waitTrace(trace);assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(holdSeen,false);restore!();releaseTrace(trace);await failed;assert.equal(f.gate.isDrainedFor(fence),true);assert.equal(holdSeen,true);assert.deepEqual(order,['Admit','Begin','NewInput','Hold']);assert.deepEqual(seen,[]);const row=(await state.getIngress(path,key))!;assert.equal(row.state,'held');assert.equal(row.confirmationDelivered,false);assert.match(newExecutionPrompt(row)!,/abc/);
  }finally{restore?.();releaseTrace(trace);if(lock?.isTransaction)lock.exec('ROLLBACK');await pending.catch(()=>{});lock?.close();}
 });assert.equal(ownedWorkerUsage().Control,0);
}));
