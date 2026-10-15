import {createNativeInteractionJournal} from '../../../src/runtime/interaction-worker/journal.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import type {InteractionProcessor} from '../../../src/runtime/interaction-worker/worker.ts';
import {startInteractionRuntimeWorker} from '../../../src/runtime/discord-runtime/interaction-start.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptFixture} from '../../helpers/server-prompt-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {createPreparedInteractionIngress} from '../../../src/runtime/discord-runtime/interaction-ingress-bootstrap.ts';
import {startPreparedInteractionWorker} from '../../../src/runtime/discord-runtime/interaction-bootstrap.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
const id=9007199254740993n,key=`interaction:${id}`;
const event=()=>decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},channel_id:'1',id:String(id),token:'offline_token',type:2,user:{id:'2',username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}}));
async function until(check:()=>boolean){const end=performance.now()+8000;while(!check()){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}}
function inspect(t:TestContext){
 for(const name of ['admitIngress','admitMappedSlashIngress','admitBusyInteraction','acknowledgeIngress','beginIngressExecution','beginIngressConfirmation','getIngress','recordIngressResult','confirmIngress','holdIngress','authorizeAbandonmentDecision','deliveredPublicationProposal'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));
 const order:string[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion,ack=DiscordChannelClient.prototype.acknowledgeInteraction,update=DiscordChannelClient.prototype.updateInitialResponse;
 const observe=(args:Parameters<typeof run>,queued:boolean)=>{const q=args[1] as any;if(String(args[0]).endsWith('/interaction-worker/native-journal-worker.ts')){assert.equal(q.identity.ingressId,key);assert.equal(q.identity.eventId,id);assert.equal(q.identity.applicationId,4n);assert.equal(typeof q.origin,'string');assert.equal(typeof q.requestId,'string');assert.equal(queued,['Acknowledge','Result','Confirm','Hold'].includes(q.operation));order.push(q.operation);}};
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){observe(args,false);return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){observe(args,true);return complete.apply(this,args);});
 t.mock.method(DiscordChannelClient.prototype,'acknowledgeInteraction',async function(this:DiscordChannelClient,...args:Parameters<typeof ack>){const r=await ack.apply(this,args);order.push('DiscordACK');return r;});
 t.mock.method(DiscordChannelClient.prototype,'updateInitialResponse',async function(this:DiscordChannelClient,...args:Parameters<typeof update>){order.push('HTTP');return update.apply(this,args);});return order;
}
async function runInstalled(f:ReturnType<typeof setupPromptRuntime>,http:DiscordChannelClient,report:(...args:unknown[])=>void,process?:InteractionProcessor['process']){
 const q=createInteractionWorkQueue(),exits=new RuntimeWorkerExitChannel(),handler=createPreparedInteractionIngress(f.startup,f.gate,q,http,new AutocompleteCatalog('{"data":[]}'),false,report),owner=process===undefined?await startPreparedInteractionWorker(f.startup,q,http,exits,report):await startInteractionRuntimeWorker(q,f.path,http,{process,notifyDeliveryReady:()=>{},report},exits,createNativeInteractionJournal(f.path));return {q,handler,owner,exits};
}
test('installed ingress and worker use captured native journal with exact ACK, rejection read, result and HTTP order',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),{getIngress}=await import('../../../src/store/ingress-read.ts');await httpFixture(async(http,seen)=>{
  const reports:unknown[]=[],r=await runInstalled(f,http,(...args)=>reports.push(args));try{await r.handler({event:event(),tag:'Normal',sequence:1n,receivedAtMs:performance.now()},new AbortController().signal);r.owner.closeInput();assert.deepEqual(await r.owner.worker.join(),{kind:'Returned',result:{ok:true}});assert.deepEqual(order,['Admit','DiscordACK','Acknowledge','Begin','Read','Result','HTTP','Confirm']);assert.deepEqual(seen,['POST','PATCH','POST']);assert.equal((await getIngress(path,key))!.confirmationDelivered,true);assert.deepEqual(reports,[]);}finally{r.q.receiver.dispose();r.owner.closeInput();await r.owner.worker.join();r.exits.close();}
 });assert.equal(ownedWorkerUsage().Control,0);
}));
test('cancelled durable ACK joins native lock and cancellation hold before original permit is released',async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),abort=new AbortController(),reason=Error('cancel ACK'),ack=DiscordChannelClient.prototype.acknowledgeInteraction;let blocker:DatabaseSync|undefined;
 t.mock.method(DiscordChannelClient.prototype,'acknowledgeInteraction',async function(this:DiscordChannelClient,...args:Parameters<typeof ack>){const value=await ack.apply(this,args);blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');return value;});
 await httpFixture(async(http,seen)=>{const reports:unknown[]=[],r=await runInstalled(f,http,(...args)=>reports.push(args)),pending=r.handler({event:event(),tag:'Normal',sequence:1n,receivedAtMs:performance.now()},abort.signal);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
  try{await until(()=>order.includes('Acknowledge'));abort.abort(reason);const fence=DrainFenceKey.create('cancel','1|2','fixture');f.gate.seal(fence);await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Control,1);blocker!.exec('ROLLBACK');await assert.rejects(pending,e=>e===reason);assert.equal(f.gate.isDrainedFor(fence),true);assert.deepEqual(order,['Admit','DiscordACK','Acknowledge','Hold']);assert.deepEqual(seen,['POST']);}finally{if(blocker?.isTransaction)blocker.exec('ROLLBACK');blocker?.close();await pending.catch(()=>{});r.owner.closeInput();await r.owner.worker.join();r.exits.close();}
 });
}));
for(const failure of ['delivery','confirmation'] as const)test(`installed cleanup ${failure} retains known result and uses native custody hold`,async t=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),order=inspect(t),{getIngress}=await import('../../../src/store/ingress-read.ts');
 if(failure==='delivery')t.mock.method(DiscordChannelClient.prototype,'updateInitialResponse',async()=>{order.push('HTTP');throw Error('unconfirmed delivery');});
 if(failure==='confirmation'){const db=new DatabaseSync(path);try{db.exec("CREATE TRIGGER fail_confirm BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture'); END");}finally{db.close();}}
 await httpFixture(async(http)=>{const process=createInteractionProcessor(path,server,http,{...f.executor.interactionServices(http),executeWithIngressContext:async()=>{throw new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'queued requests'));}}),r=await runInstalled(f,http,()=>{},process);try{await r.handler({event:event(),tag:'Normal',sequence:1n,receivedAtMs:performance.now()},new AbortController().signal);r.owner.closeInput();await r.owner.worker.join();const row=(await getIngress(path,key))!;assert.equal(row.state,'held');assert.equal((row.outcome as any).kind,'mirror_cleanup_refused');assert.equal(row.confirmationDelivered,false);assert.deepEqual(order,['Admit','DiscordACK','Acknowledge','Begin','Read','Result','HTTP',...(failure==='confirmation'?['Confirm']:[]),'Hold']);}finally{r.owner.closeInput();await r.owner.worker.join();r.exits.close();}}
 );
}));

test('overlapping fresh slash admission explicitly refuses saturation without ACK or enqueue, while accepted original finishes',()=>promptFixture(async(path,server)=>{
 const f=setupPromptRuntime(path,server),{getIngress}=await import('../../../src/store/ingress-read.ts');await httpFixture(async(http,seen)=>{
  const r=await runInstalled(f,http,()=>{}),trace=new SharedArrayBuffer(8),extension=import.meta.url.endsWith('.js')?'.js':'.ts',restore=instrumentStoreWorker({match:'interaction-worker/native-journal-worker'+extension,trace});
  const first=r.handler({event:event(),tag:'Normal',sequence:1n,receivedAtMs:performance.now()},new AbortController().signal);
  try{await waitTrace(trace);const second=decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},channel_id:'1',id:String(id+1n),token:'offline_token',type:2,user:{id:'2',username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}}));
   await assert.rejects(r.handler({event:second,tag:'Normal',sequence:2n,receivedAtMs:performance.now()},new AbortController().signal),/capacity is occupied/);assert.deepEqual(seen,[]);assert.equal(r.q.snapshot().queued,0);assert.equal(await getIngress(path,`interaction:${id+1n}`),null);assert.equal((await getIngress(path,key))!.state,'staged');
   restore();releaseTrace(trace);await first;r.owner.closeInput();await r.owner.worker.join();assert.equal((await getIngress(path,key))!.confirmationDelivered,true);assert.equal(await getIngress(path,`interaction:${id+1n}`),null);
  }finally{restore();releaseTrace(trace);await first.catch(()=>{});r.owner.closeInput();await r.owner.worker.join();r.exits.close();}
 });
}));

test('installed Normal lane reports only proven fresh capacity refusal and preserves its already accepted handler',()=>promptFixture(async(path,server)=>{
 const {GatewayIngressLane}=await import('../../../src/discord/gateway/lane.ts'),{runInteractionLane}=await import('../../../src/runtime/discord-runtime/interaction-lane.ts'),{getIngress}=await import('../../../src/store/ingress-read.ts');
 const f=setupPromptRuntime(path,server);await httpFixture(async(http,seen)=>{
  const r=await runInstalled(f,http,()=>{}),lane=new GatewayIngressLane<import('../../../src/runtime/discord-runtime/interaction-lane.ts').OwnedInteractionIngress>(8),shutdown=new AbortController(),force=new AbortController(),reports:import('../../../src/runtime/discord-runtime/interaction-failure.ts').InteractionFailureReport[]=[];
  const trace=new SharedArrayBuffer(8),extension=import.meta.url.endsWith('.js')?'.js':'.ts',restore=instrumentStoreWorker({match:'interaction-worker/native-journal-worker'+extension,trace}),running=runInteractionLane('Normal',lane.receiver(),r.handler,shutdown.signal,force.signal,{report:value=>{reports.push(value);}});let laneSettled=false;void running.then(()=>laneSettled=true,()=>laneSettled=true);
  const next=(eventId:bigint)=>decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},channel_id:'1',id:String(eventId),token:'offline_token',type:2,user:{id:'2',username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}}));
  try{lane.trySend({event:event(),tag:'Normal',sequence:1n,receivedAtMs:performance.now()});await waitTrace(trace);lane.trySend({event:next(id+1n),tag:'Normal',sequence:2n,receivedAtMs:performance.now()});await until(()=>reports.length===1);assert.equal(reports[0]!.interactionId,id+1n);assert.match(reports[0]!.error,/refused before persistence.*capacity is occupied/);assert.equal(laneSettled,false);assert.deepEqual(seen,[]);assert.equal(await getIngress(path,`interaction:${id+1n}`),null);
   restore();releaseTrace(trace);let end=performance.now()+5000;while(!(await getIngress(path,key))?.confirmationDelivered||ownedWorkerUsage().Control!==0){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}assert.equal((await getIngress(path,key))!.state,'completed');
   lane.trySend({event:next(id+2n),tag:'Normal',sequence:3n,receivedAtMs:performance.now()});end=performance.now()+5000;while(!(await getIngress(path,`interaction:${id+2n}`))?.confirmationDelivered){assert.ok(performance.now()<end);await new Promise(r=>setTimeout(r,5));}assert.equal(reports.length,1);assert.equal(laneSettled,false);
  }finally{restore();releaseTrace(trace);shutdown.abort();await running;r.owner.closeInput();await r.owner.worker.join();r.exits.close();}
 });
}));
