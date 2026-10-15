import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promptRuntimeFixture} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptHttpFixture,promptHttpMessage} from '../../helpers/server-prompt-http-fixture.ts';
import {promptFixture,callPromptFixture,editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {work,stage,enqueue} from '../../helpers/interaction-worker-fixture.ts';
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
import {createNativePromptAuthorityReads} from '../../../src/runtime/server-prompt-authority-reads.ts';
const identity={applicationId:4n,userId:9n},signal=new AbortController().signal;
const input={method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',question:'Choose',options:[{label:'One'},{label:'Two'}]}]}};
function inspect(t:TestContext) {
 for(const name of ['hasObservedCompletion','listQueueJobs','listFiltered','mirroredThreadId','beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));
 const calls:string[]=[],run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){
  const url=String(args[0]),q=args[1] as {operation:string;path:string;target:unknown;generation:unknown};
  if(url.endsWith('/control-evidence-native-worker.ts'))calls.push('Completed');
  if(url.endsWith('/native-read-state-worker.ts')&&q.operation==='List'){assert.equal(q.target,null);assert.equal(q.generation,null);calls.push('Jobs');}
  if(url.endsWith('/native-state-worker.ts')&&q.operation==='MirrorTarget')calls.push('Mapping');
  if(url.endsWith('/native-receipt-store-worker.ts'))calls.push('Receipt');
  return run.apply(this,args);
 });return calls;
}
function verify(calls:string[],count=2) {
 const at=calls.indexOf('Completed');assert.notEqual(at,-1);assert.deepEqual(calls.slice(at),Array.from({length:count},()=>['Completed','Jobs','Mapping']).flat().concat('Receipt'));assert.equal(ownedWorkerUsage().Control,0);
}
async function until(check:()=>boolean) {const deadline=performance.now()+5000;while(!check()){assert.ok(performance.now()<deadline,'bounded fixture wait');await new Promise(resolve=>setTimeout(resolve,5));}}
for(const kind of ['approval','input'] as const) {
 test(`installed automatic ${kind} preparation uses original native reads before unchanged receipt ownership`,async t=>{
  const calls=inspect(t),stop=new AbortController();await promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
   const exits=new RuntimeWorkerExitChannel(),receiver=server.subscribeServerRequests(),errors:unknown[]=[],worker=await startServerRequestRuntimeWorker({owner:server,serverRequestReceiver:receiver},path,http,stop.signal,exits,e=>errors.push(e));
   try{assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(seen.length,1);assert.equal(receiver.tryReceive().kind,'Closed');assert.deepEqual(errors,[]);verify(calls);assert.deepEqual(await callPromptFixture(server,'answers'),[]);}finally{stop.abort();await worker.join();receiver.dispose();exits.close();}
  },()=>stop.abort('accepted')),kind==='input'?input:{});
 });
 for(const route of ['slash','message','gap','poll'] as const)test(`installed ${route} ${kind} prepares and revalidates through native reads with poisoned compatibility facade`,async t=>{
  const calls=inspect(t);await promptRuntimeFixture(f=>promptHttpFixture(async(http,seen)=>{
   if(route==='slash') {
    const decoded=decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},id:'31',token:'offline_token',type:2,data:{id:'9',name:'approval',type:1}})),base=work(f.path,31n,f.gate),w=Object.freeze({...base,work:routeGatewayCommand(decoded,false).work}),q=createInteractionWorkQueue(),exits=new RuntimeWorkerExitChannel();await stage(w);enqueue(q,w);
    const worker=await startPreparedInteractionWorker(f.startup,q,http,exits,code=>f.reports.push(code));
    try{worker.closeInput();assert.deepEqual(await worker.worker.join(),{kind:'Returned',result:{ok:true}});assert.equal((await state.getIngress(f.path,w.custodyIngressId))!.confirmationDelivered,true);assert.deepEqual(seen.map(x=>x.method),['POST','PATCH']);}finally{worker.closeInput();await worker.worker.join();exits.close();q.sender.dispose();q.receiver.dispose();}
   } else if(route==='message') {
    const captured=capturePreparedMessageOptions(f.startup,f.gate,http,f.options);assert.ok(Object.isFrozen(captured.context.promptAuthorityReads));
    const handler=createPreparedMessageHandler(f.startup,f.gate,http,f.options),message=decodeGatewayMessage(JSON.stringify(promptHttpMessage('32')));await handler(message,identity,signal);const before=calls.slice();await handler(message,identity,signal);assert.deepEqual(calls,before);assert.equal(seen.length,1);assert.equal((await state.getIngress(f.path,'message:32'))!.confirmationDelivered,true);
   } else {
    const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),history=createPreparedHistoryOperations(f.startup,f.gate,http,gaps,{...f.options,allowedChannelIds:new Set([1n]),startupChannelId:null,historyPolicyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},historyTargetLimits:{maxRows:128,timeoutMs:5000}});
    try{if(route==='gap'){tracker.record(1n,{timestampMicros:1577836800000000n,messageId:1n},'Full');await history.recover(identity,signal);assert.equal(gaps.snapshot().length,0);}else{const cursor=new HistoryPollState();await history.poll(cursor,identity,signal);assert.equal(cursor.isPrimed(1n),true);}assert.deepEqual(seen.map(x=>x.method),['GET','POST']);assert.equal((await state.getIngress(f.path,'message:33'))!.confirmationDelivered,true);}finally{gaps.dispose();tracker.close();}
   }
   verify(calls);assert.ok(!f.reports.some(code=>code.includes('failed')));
  },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify([promptHttpMessage('33')]));}),kind==='input'?input:{});
 });
}
test('installed automatic recovery revalidates confirmed receipt without creating a fresh request or posting again',async t=>{
 const calls=inspect(t);await promptFixture(async(path,server,request)=>promptHttpFixture(async(http,seen)=>{
  for(let cycle=0;cycle<2;cycle++) {
   calls.length=0;const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),receiver=server.subscribeServerRequests(),errors:unknown[]=[],worker=await startServerRequestRuntimeWorker({owner:server,serverRequestReceiver:receiver},path,http,stop.signal,exits,e=>errors.push(e));
   try{await until(()=>calls.includes('Receipt')&&ownedWorkerUsage().Control===0);stop.abort('recovered');assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(seen.length,1);assert.deepEqual(errors,[]);verify(calls);assert.deepEqual(server.pendingServerRequests('t')[0]!.occurrence.asBytes(),request.occurrence.asBytes());}finally{stop.abort();await worker.join();receiver.dispose();exits.close();}
  }
 }));
});
test('installed automatic stop joins an actual blocked authority read before disposing its receiver and performs no HTTP',async t=>{
 const calls=inspect(t),stop=new AbortController();await promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
  const blocker=new DatabaseSync(path);blocker.exec('BEGIN EXCLUSIVE');const exits=new RuntimeWorkerExitChannel(),receiver=server.subscribeServerRequests(),errors:unknown[]=[],worker=await startServerRequestRuntimeWorker({owner:server,serverRequestReceiver:receiver},path,http,stop.signal,exits,e=>errors.push(e));let ticks=0;const timer=setInterval(()=>ticks++,5);
  try{await until(()=>calls.includes('Completed'));stop.abort('stopped during authority read');await new Promise(r=>setTimeout(r,80));assert.equal(worker.peek(),undefined);assert.equal(receiver.tryReceive().kind,'Empty');assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);assert.deepEqual(seen,[]);blocker.exec('ROLLBACK');assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(receiver.tryReceive().kind,'Closed');assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(errors,[]);assert.deepEqual(seen,[]);}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');stop.abort();await worker.join();blocker.close();receiver.dispose();exits.close();}
 }));
});
test('installed Approval keeps the original action error and no prepared UI on malformed unfiltered queue evidence',async t=>{
 inspect(t);await promptRuntimeFixture(async f=>{
  await editPromptFixture(f.path,"UPDATE codex_turn_queue SET channel_id=1.5");
  await assert.rejects(f.executor.executeWithIngressContext('Approval',{channelId:1n,userId:2n,discordMessageId:45n,autoQueueWhenBusy:false},'message:45'),/Queue read unavailable/);assert.equal(ownedWorkerUsage().Control,0);
 });
});
test('gateway capture retains original native authority functions after supplied context mutation',async t=>{
 const calls=inspect(t);await promptRuntimeFixture(f=>promptHttpFixture(async(http,seen)=>{
  const captured=capturePreparedMessageOptions(f.startup,f.gate,http,f.options),mutable={...createNativePromptAuthorityReads(f.path)},context={...captured.context,promptAuthorityReads:mutable},handler=createGatewayMessageHandler({...captured,context});
  mutable.listQueueJobs=async()=>assert.fail('replaced original function');context.promptAuthorityReads={...mutable,hasObservedCompletion:async()=>assert.fail('replaced original port')};
  await handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage('46'))),identity,signal);assert.equal(seen.length,1);verify(calls);
 }));
});
