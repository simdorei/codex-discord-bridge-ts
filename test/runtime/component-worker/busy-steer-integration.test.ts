import assert from 'node:assert/strict';
import {it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {queueJob} from '../../helpers/queue-job.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {userOriginMarker} from '../../../src/store/mirror-origin.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {NativeMutationOwner,type NativeMutationReceipt} from '../../../src/runtime/native-mutation-owner.ts';
import type {ResidentNativeDispatch} from '../../../src/app-server/resident-native-dispatch.ts';
import {NativeSteerOriginUnknownError} from '../../../src/runtime/action-executor/steer-origin-native.ts';
import {NativeBusyClaimUnknownError} from '../../../src/runtime/component-worker/busy-claim-native.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import type {BusyChoice} from '../../../src/store/busy-choice.ts';
import type {BusyAction} from '../../../src/discord/components.ts';
import {createBusyChoice,getBusyChoice} from '../../../src/store/busy-choice-store.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayComponent} from '../../../src/discord/interaction-routing.ts';
import {stageOrdinaryInteraction,type OrdinaryInteractionStageRequest} from '../../../src/runtime/discord-dispatch/stage-ordinary.ts';
import {createInteractionWorkQueue,type InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import {runInteractionWorker} from '../../../src/runtime/interaction-worker/worker.ts';
import {busyReadyMarker} from '../../../src/runtime/component-worker/confirmation.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {busyComponentErrorInfo} from '../../../src/runtime/component-worker/busy-errors.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
import {fence,enqueue} from '../../helpers/interaction-worker-fixture.ts';
const actor={channelId:9007199254740999n,userId:9007199254740993n,discordMessageId:9007199254740997n,autoQueueWhenBusy:false},key='message:'+actor.discordMessageId;
const code=`import readline from 'node:readline';import {readFileSync} from 'node:fs';const seen=[];let failure=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');let fileTurn='';setInterval(()=>{try{const next=readFileSync(process.env.TURN_FIXTURE_PATH,'utf8');if(next!==fileTurn){fileTurn=next;emit({method:'turn/started',params:{threadId:'t',turnId:next}});}}catch{}},10).unref();readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>emit({id:m.id,result});if(m.method==='initialized')return;if(m.method==='initialize'){reply({});return;}if(m.method==='fixture/seen'){reply(seen);return;}if(m.method==='fixture/fail'){failure=true;reply({});return;}if(m.method==='fixture/end'){emit({method:'turn/completed',params:{threadId:'t',turnId:'v'}});reply({});return;}if(m.method==='fixture/seed'){emit({method:'turn/started',params:{threadId:'t',turnId:m.params.turn}});reply({});return;}seen.push({method:m.method,params:m.params});if(m.method==='turn/steer'||m.method==='turn/interrupt'){if(failure)emit({id:m.id,error:{code:-9,message:'fixture rejection'}});else reply({});}else emit({id:m.id,error:{code:-9,message:'unsupported fixture call'}});});`;
async function fixture(run:(f:{path:string;server:PortableResidentLifecycle;executor:RuntimeCommandExecutor;queue:QueueStartCoordinator;call:(method:string,params?:unknown)=>Promise<any>;seen:()=>Promise<any[]>})=>Promise<void>,afterNativeBegin?:()=>Promise<void>){return storeFixture(async path=>{
 const codex=join(dirname(path),'codex.sqlite'),bridgePath=join(dirname(path),'bridge.json'),bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('t');const cd=new DatabaseSync(codex);cd.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES('t','Target','/tmp',1,0,0)");cd.close();
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");db.prepare("INSERT INTO mirror_threads VALUES('t','p','title',?,1,1)").run(actor.channelId);db.close();
 const native=afterNativeBegin===undefined?undefined:new NativeMutationOwner(path,'runtime',x=>x);
 const nativeDispatch:ResidentNativeDispatch|undefined=native===undefined?undefined:{beginMutationWithOrigin:async input=>{const receipt=await native.begin(input);await afterNativeBegin!();return receipt;},beginQueueMutation:input=>native.beginQueue(input),beginStopMutation:input=>native.beginStop(input),finishMutation:(receipt,outcome)=>native.finish(receipt as NativeMutationReceipt,outcome),wasNotSubmitted:(e,a,w,m)=>native.ownsUnsubmittedFailure(e,a,w,m),validate:receipt=>native.validateForDispatch(receipt as NativeMutationReceipt),close:()=>native.close()};
 const render=(e:unknown)=>e instanceof Error?e.message:'fixture error',server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{TURN_FIXTURE_PATH:path+'.turn'}},clientInfo:{name:'steer',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render),...(nativeDispatch===undefined?{}:{nativeDispatch})}),backend=new AppServerTurnBackend(server,render),queue=new QueueStartCoordinator(path,backend);
 const executor=new RuntimeCommandExecutor({paths:{state:codex,mirror:path,bridge:bridgePath},bridge,server,backend,queue,render,preparePrompt:async p=>p,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000});
 const call=async(method:string,params:unknown={})=>{const admission=server.admitResponse(server.generation());try{return await admission.client.requestAdmitted(admission.permit,method,params,1000);}finally{admission.release();}};
 try{await call('fixture/seed',{turn:'v'});await run({path,server,executor,queue,call,seen:async()=>await call('fixture/seen') as any[]});}finally{await server.dispose();await native?.close();}
});}
function markers(path:string){const db=new DatabaseSync(path);try{return db.prepare('SELECT event_digest FROM codex_session_mirror_events').all().map(r=>r.event_digest);}finally{db.close();}}
function isOrigin(args:Parameters<OwnedWorkerSlot['run']>):boolean{return String(args[0]).endsWith('/steer-origin-native-worker.ts');}
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
const now=()=>Date.now()/1000;
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
async function choice(f:Fixture,prompt='original',bind=true,allowSteer=false):Promise<BusyChoice>{
 const at=now(),id=await createBusyChoice(f.path,{ownerUserId:actor.userId,channelId:actor.channelId,targetThreadId:'t',prompt,allowSteer,now:at,timeToLive:1800});
 if(bind)await state.bindBusyControl(f.path,id,'t','v',null);return (await getBusyChoice(f.path,id,at))!;
}
function request(c:BusyChoice,id=actor.discordMessageId,action:BusyAction='Steer'):OrdinaryInteractionStageRequest{
 const decoded=decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},id:String(id),token:'offline',type:3,data:{custom_id:`codex_busy:${c.choiceId}:${action.toLowerCase()}`,component_type:2}}));
 return {applicationId:4n,interactionId:id,channelId:actor.channelId,userId:actor.userId,sourceMessageId:9007199254740901n,work:routeGatewayComponent(decoded).work};
}
const options={settingsResolver:null,cleanup:{report:()=>{}}};
async function stage(f:Fixture,c:BusyChoice,id=actor.discordMessageId,action:BusyAction='Steer',gate=new AdmissionGate()):Promise<InboundInteractionWork>{
 const input=request(c,id,action),staged=await stageOrdinaryInteraction(f.path,input,options);assert.equal(staged.kind,'Created');if(staged.kind!=='Created')throw Error('fixture stage');
 try{await staged.custody.acknowledge();const receipt=staged.custody.intoReceipt();return {...input,interactionToken:'offline',processingMode:'Execute',custodyDatabase:receipt.database,custodyIngressId:receipt.ingressId,authorizedBusyChoice:receipt.busyChoice,admissionPermit:gate.tryEnter()};}finally{await staged.custody.dispose();}
}
async function httpFixture(run:(http:DiscordChannelClient,posts:{method:string;body:any}[])=>Promise<void>){
 const posts:{method:string;body:any}[]=[],local=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{posts.push({method:req.method!,body:body===''?null:JSON.parse(body)});if(req.method==='PATCH'){res.statusCode=204;res.end();}else res.end(JSON.stringify({attachments:[],author:{id:'9',username:'fixture',discriminator:'0'},channel_id:String(actor.channelId),content:'',embeds:[],id:String(100+posts.length),type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));});});
 await new Promise<void>(r=>local.listen(0,'127.0.0.1',r));const http=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(local.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{await run(http,posts);}finally{await http.close();local.closeAllConnections();await new Promise<void>((r,j)=>local.close(e=>e?j(e):r()));}
}
function prepare(f:Fixture,http:DiscordChannelClient,w:InboundInteractionWork){assert.ok('Component'in w.work);return f.executor.interactionServices(http).prepareComponent(w,w.work.Component);}
async function processWork(f:Fixture,http:DiscordChannelClient,w:InboundInteractionWork){const q=createInteractionWorkQueue();enqueue(q,w);q.sender.dispose();const errors:string[]=[];await runInteractionWorker(q,f.path,http,{process:createInteractionProcessor(f.path,f.server,http,f.executor.interactionServices(http)),notifyDeliveryReady(){},report(_code,detail){errors.push(detail);}});return errors;}
function busyKind(error:unknown){const info=componentWorkerErrorInfo(error);return info?.kind==='Busy'?busyComponentErrorInfo(info.source)?.kind:null;}
async function ready(f:Fixture,c:BusyChoice){return state.isComponentClaimLive(f.path,busyReadyMarker(c.choiceId,actor.userId,actor.channelId),now());}
async function selectedFixture(f:Fixture){edit(f.path,'DELETE FROM mirror_threads');edit(join(dirname(f.path),'codex.sqlite'),"INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES('other','Other','/tmp',2,0,0)");}
async function select(f:Fixture,id:string,event=20n){return f.executor.executeWithIngressContext({Use:{reference:id}},{...actor,discordMessageId:event},`message:${event}`);}

it('actual executor component services use shared native origin with exact captured click identities and stored allowSteer=false',async t=>{
 t.mock.method(state,'recordUserOrigin',()=>assert.fail('main-thread origin writer'));
 const submissions:any[]=[],run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isOrigin(args))submissions.push(args[1]);if(String(args[0]).endsWith('/bridge-state-native-worker.ts'))assert.notEqual((args[1] as any).operation.kind,'Selected');return run.apply(this,args);});
 await fixture(f=>httpFixture(async(http,posts)=>{const prompt='\u2003 방향 😀 \u0085',c=await choice(f,prompt),w=await stage(f,c),original={...w},pending=prepare(f,http,w);
  Object.assign(w,{custodyIngressId:'interaction:wrong',interactionId:5n,userId:6n,channelId:7n,sourceMessageId:8n,authorizedBusyChoice:{...c,prompt:'replacement'}});
  try{const prepared=await pending;assert.equal(posts.length,0);assert.equal(submissions.length,1);const op=submissions[0].input;assert.equal(op.ingressKey,original.custodyIngressId);assert.equal(op.eventId,original.interactionId);assert.equal(op.channelId,original.channelId);assert.equal(op.ownerUserId,original.userId);assert.equal(op.thread,'t');assert.equal(op.turn,'v');assert.equal(op.generation,f.server.generation());assert.equal(op.prompt,prompt);assert.notEqual(op.eventId,original.sourceMessageId);assert.deepEqual(markers(f.path),[userOriginMarker('t','v',prompt)]);assert.equal(await ready(f,c),true);const seen=await f.seen();assert.equal(seen.length,1);assert.equal(seen[0].params.expectedTurnId,'v');assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);await prepared.deliver();}finally{original.admissionPermit!.release();}
 }));
});

for(const rollback of [false,true])it(`${rollback?'rolled-back':'committed'} missing origin ACK retains original busy claim and ingress, with canonical second click and no replay`,async t=>{
 let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!isOrigin(args))return task;count++;return task.then(()=>{throw Error('lost original ACK');});});
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await choice(f),w=await stage(f,c);if(rollback)edit(f.path,"CREATE TRIGGER reject_origin BEFORE INSERT ON codex_session_mirror_events BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  await processWork(f,http,w);const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'held');assert.equal(ingress?.outcome,undefined);assert.equal(ingress?.eventId,w.interactionId);assert.equal(ingress?.ownerUserId,w.userId);assert.equal(ingress?.channelId,w.channelId);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);
  assert.equal((await stageOrdinaryInteraction(f.path,request(c),options)).kind,'Duplicate');const second=await stageOrdinaryInteraction(f.path,request(c,actor.discordMessageId+1n),options);assert.equal(second.kind,'CanonicalRepeat');if(second.kind==='CanonicalRepeat')assert.equal(second.confirmationReady,false);
  assert.equal(count,1);assert.equal(markers(f.path).length,rollback?0:1);assert.deepEqual(await f.seen(),[]);assert.ok(posts.every(x=>x.body?.content!=='Busy action submitted.'));assert.equal(f.queue.locks.activeTargetCount,0);
 }));
});

for(const ordinaryFirst of [false,true])it(`one writer barrier blocks ${ordinaryFirst?'ordinary to busy':'busy to ordinary'} retries before target verification or native submission`,async t=>{
 let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!isOrigin(args))return task;count++;return task.then(()=>{throw Error('lost ACK');});});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c);try{
  if(ordinaryFirst)await assert.rejects(f.executor.executeWithIngressContext({Steer:{prompt:'ordinary'}},actor,key),NativeSteerOriginUnknownError);else await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ActionOutcomeIndeterminate');
  t.mock.method(ControlTurnVerifier.prototype,'control',()=>assert.fail('unknown barrier must precede control reads'));
  if(ordinaryFirst)await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ActionOutcomeIndeterminate');else await assert.rejects(f.executor.executeWithIngressContext({Steer:{prompt:'ordinary'}},actor,key),NativeSteerOriginUnknownError);
  const other=await choice(f,'new choice'),next=await stage(f,other,actor.discordMessageId+2n);try{await assert.rejects(prepare(f,http,next),e=>busyKind(e)==='ActionOutcomeIndeterminate');assert.equal((await state.readBusyChoiceState(f.path,other.choiceId,now()))!.claimed,true);assert.equal(await ready(f,other),false);}finally{next.admissionPermit!.release();}
  assert.equal(count,1);assert.deepEqual(await f.seen(),[]);
 }finally{w.admissionPermit!.release();}}));
});

it('confirmed pre-submission refusal releases busy claim and allows a fresh admitted second click',async t=>{
 let refuse=true,count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isOrigin(args)){count++;if(refuse)return Promise.reject(new OwnedWorkerBusyError());}return run.apply(this,args);});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c);await processWork(f,http,w);const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'completed');assert.equal((ingress?.outcome as any)?.kind,'busy_control_preflight_rejected');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,false);assert.equal(await ready(f,c),false);assert.deepEqual(markers(f.path),[]);refuse=false;const next=await stage(f,c,actor.discordMessageId+1n);await processWork(f,http,next);assert.equal((await state.getIngress(f.path,next.custodyIngressId))?.state,'completed');assert.equal(await ready(f,c),true);assert.equal(count,2);assert.equal((await f.seen()).length,1);
 }));
});

it('origin cancellation joins native exit while retaining target lock, original ingress and admission permit',async t=>{
 let submitted!:()=>void;const started=new Promise<void>(r=>submitted=r),cancel=new AbortController();let lock:DatabaseSync|undefined;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(!isOrigin(args))return run.apply(this,args);lock=new DatabaseSync((args[1] as {path:string}).path);lock.exec('BEGIN IMMEDIATE');const task=run.call(this,args[0],args[1],args[2],cancel.signal);submitted();return task;});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),gate=new AdmissionGate(),seal=fence(),w=await stage(f,c,actor.discordMessageId,'Steer',gate);gate.seal(seal);let finished=false;const pending=processWork(f,http,w).then(()=>{finished=true;});try{await started;cancel.abort(Error('fixture cancellation'));await sleep(10);assert.equal(finished,false);assert.equal(gate.isDrainedFor(seal),false);assert.equal(f.queue.locks.activeTargetCount,1);assert.equal(ownedWorkerUsage().Control,1);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'executing');lock!.exec('ROLLBACK');lock!.close();lock=undefined;await pending;assert.equal(gate.isDrainedFor(seal),true);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'held');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);}finally{if(lock!==undefined){if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}await pending;}}));
});

for(const change of ['turn','mapping','completion','generation'] as const)it(`${change} change after confirmed origin never substitutes later busy authority`,async t=>{
 let after:()=>Promise<void>=async()=>{};const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);return isOrigin(args)?task.then(async value=>{await after();return value;}):task;});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c);after=async()=>{if(change==='turn')await f.call('fixture/seed',{turn:'later'});else if(change==='mapping')edit(f.path,"UPDATE mirror_threads SET codex_thread_id='foreign'");else if(change==='completion')edit(f.path,"INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('t','v',1,'{}')");else{await f.call('fixture/end');assert.equal(await f.server.forceRestartIfQuiescent(),true);await f.call('fixture/seed',{turn:'v'});}};
  try{await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ControlNotDispatched');assert.equal(await state.resolveBusyControl(f.path,c.choiceId,'t'),'v');assert.deepEqual(markers(f.path),[userOriginMarker('t','v','original')]);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.equal(f.queue.locks.activeTargetCount,0);}finally{w.admissionPermit!.release();}
 }));
});

for(const checkpoint of [1,2])for(const restore of [false,true])it(`Selected ${restore?'away/back':'change'} at control check ${checkpoint} rejects without refreshing the authentic snapshot`,async t=>{
 let observed=0,change:()=>Promise<void>=async()=>{};const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).endsWith('/control-evidence-native-worker.ts')&&++observed===checkpoint)return task.then(async value=>{await change();return value;});return task;});
 await fixture(f=>httpFixture(async(http)=>{await selectedFixture(f);const c=await choice(f),w=await stage(f,c);change=async()=>{await select(f,'other');if(restore)await select(f,'t',21n);};try{await assert.rejects(prepare(f,http,w),/Selected Bridge snapshot is stale/);assert.equal(observed,checkpoint);assert.equal(markers(f.path).length,checkpoint===1?0:1);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.equal(f.queue.locks.activeTargetCount,0);}finally{w.admissionPermit!.release();}}));
});

for(const change of ['selected','turn'] as const)it(`${change} change during delayed native preflight is rejected at actual wire guard`,{timeout:15000},async()=>{
 let after:()=>Promise<void>=async()=>{};await fixture(f=>httpFixture(async(http)=>{if(change==='selected')await selectedFixture(f);const c=await choice(f),w=await stage(f,c);after=async()=>{if(change==='selected'){await select(f,'other');await select(f,'t',21n);}else{await writeFile(f.path+'.turn','later');const deadline=AbortSignal.timeout(3000);while(f.server.activeTurnId('t')!=='later'){deadline.throwIfAborted();await sleep(5);}}};
  try{await assert.rejects(prepare(f,http,w),/Selected Bridge snapshot is stale|original busy Steer turn or connection changed/);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.equal(markers(f.path).length,1);const db=new DatabaseSync(f.path);try{assert.deepEqual(db.prepare('SELECT state FROM codex_mutation_attempts').all().map(r=>r.state),['not_sent']);}finally{db.close();}assert.equal(f.queue.locks.activeTargetCount,0);}finally{w.admissionPermit!.release();}
 }),async()=>after());
});

it('unchanged Selected choice reaches checked native dispatch once',async()=>fixture(f=>httpFixture(async(http)=>{
 await selectedFixture(f);const c=await choice(f),w=await stage(f,c);await processWork(f,http,w);assert.equal((await f.seen()).length,1);assert.equal(await ready(f,c),true);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.confirmationDelivered,true);
}),async()=>{}));

it('successful busy action deduplicates canonical clicks and ConfirmationOnly services retry clears without action replay',async()=>fixture(f=>httpFixture(async(http,posts)=>{
 const c=await choice(f),w=await stage(f,c);await processWork(f,http,w);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'completed');const duplicate=await stageOrdinaryInteraction(f.path,request(c),options);assert.equal(duplicate.kind,'Duplicate');
 const nextRequest=request(c,actor.discordMessageId+1n),repeat=await stageOrdinaryInteraction(f.path,nextRequest,options);assert.equal(repeat.kind,'CanonicalRepeat');if(repeat.kind!=='CanonicalRepeat')throw Error('fixture repeat');assert.equal(repeat.confirmationReady,false);
 const again=await prepare(f,http,{...w,processingMode:'ConfirmationOnly',admissionPermit:null});await again.deliver();assert.equal((await f.seen()).length,1);assert.equal(markers(f.path).length,1);assert.deepEqual(posts.map(x=>x.method),['POST','PATCH','PATCH']);
})));

it('failed button clear retries only confirmation while completed receipt prevents action replay',async t=>{
 const clear=DiscordChannelClient.prototype.clearMessageComponents;let fail=true;t.mock.method(DiscordChannelClient.prototype,'clearMessageComponents',function(this:DiscordChannelClient,...args:Parameters<typeof clear>){if(fail){fail=false;return Promise.reject(Error('fixture clear'));}return clear.apply(this,args);});
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await choice(f),w=await stage(f,c);await processWork(f,http,w);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'completed');assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.confirmationDelivered,false);assert.equal(await ready(f,c),true);
  const nextRequest=request(c,actor.discordMessageId+1n),repeat=await stageOrdinaryInteraction(f.path,nextRequest,options);assert.equal(repeat.kind,'CanonicalRepeat');if(repeat.kind!=='CanonicalRepeat')throw Error('fixture repeat');assert.equal(repeat.confirmationReady,false);const again=await prepare(f,http,{...w,processingMode:'ConfirmationOnly',admissionPermit:null});await again.deliver();assert.equal((await f.seen()).length,1);assert.equal(markers(f.path).length,1);assert.equal(posts.filter(x=>x.body?.content==='Busy action submitted.').length,1);assert.equal(posts.filter(x=>x.method==='PATCH').length,1);
 }));
});

for(const action of ['Stop','Ignore'] as const)it(`installed ${action} does not depend on native Steer writer or Selected`,async t=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isOrigin(args))assert.fail('no origin for non-Steer');if(String(args[0]).endsWith('/bridge-state-native-worker.ts'))assert.notEqual((args[1] as any).operation.kind,'Selected');return run.apply(this,args);});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c,actor.discordMessageId,action);await processWork(f,http,w);assert.equal(await ready(f,c),true);assert.equal((await f.seen()).length,action==='Stop'?1:0);assert.deepEqual(markers(f.path),[]);}));
});

for(const missing of ['binding','mapping'] as const)it(`installed busy Steer rejects changed ${missing} before native origin and keeps original turn binding`,async t=>{
 let origins=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isOrigin(args))origins++;return run.apply(this,args);});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f,'original',missing!=='binding'),w=await stage(f,c);if(missing==='mapping')edit(f.path,"UPDATE mirror_threads SET codex_thread_id='foreign'");try{await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ControlNotDispatched');assert.equal(origins,0);assert.equal(await state.resolveBusyControl(f.path,c.choiceId,'t'),missing==='binding'?null:'v');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,false);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.equal(f.queue.locks.activeTargetCount,0);}finally{w.admissionPermit!.release();}}));
});

it('a busy click already waiting on the ordinary target lock observes the same unknown barrier after lock transfer',async t=>{
 let submitted!:()=>void,release!:()=>void;const started=new Promise<void>(r=>submitted=r),held=new Promise<void>(r=>release=r);let origins=0;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!isOrigin(args))return task;origins++;return task.then(async()=>{submitted();await held;throw Error('delayed lost ACK');});});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c),ordinary=f.executor.executeWithIngressContext({Steer:{prompt:'ordinary'}},actor,key),ordinaryFailed=assert.rejects(ordinary,NativeSteerOriginUnknownError);let controlReads=0;const control=ControlTurnVerifier.prototype.control;t.mock.method(ControlTurnVerifier.prototype,'control',function(this:ControlTurnVerifier,...args:Parameters<typeof control>){controlReads++;return control.apply(this,args);});
  try{await started;let waiting!:()=>void;const blocked=new Promise<void>(r=>waiting=r),lock=ControlTurnVerifier.prototype.lock;t.mock.method(ControlTurnVerifier.prototype,'lock',function(this:ControlTurnVerifier,...args:Parameters<typeof lock>){waiting();return lock.apply(this,args);});const busy=prepare(f,http,w),busyFailed=assert.rejects(busy,e=>busyKind(e)==='ActionOutcomeIndeterminate');await blocked;assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(f.queue.locks.activeTargetCount,1);release();await ordinaryFailed;await busyFailed;assert.equal(origins,1);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.equal(f.queue.locks.activeTargetCount,0);assert.ok(controlReads>=1);}finally{release();await ordinaryFailed;w.admissionPermit!.release();}
 }));
});

const isBusyClaim=(url:URL)=>String(url).endsWith('/busy-claim-native-worker.ts');
for(const action of ['Queue','Steer','Stop','Ignore'] as const)it(`installed ${action} preserves native claim/ready order, completed ingress before success delivery and canonical custody`,async t=>{
 const ops:any[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isBusyClaim(args[0]))ops.push({lane:'begin',...args[1] as any});return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(isBusyClaim(args[0]))ops.push({lane:'completion',...args[1] as any});return complete.apply(this,args);});
 for(const method of ['claimBusyChoice','releaseBusyChoiceClaim','readBusyChoiceState','claimComponent','resolveBusyControl'] as const)t.mock.method(state,method,()=>assert.fail('main-thread Busy persistence fallback'));
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await choice(f),w=await stage(f,c,actor.discordMessageId,action),send=DiscordChannelClient.prototype.sendValidated;
  t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){if(args[0].body.includes('Busy action submitted.')){const original=await state.getIngress(f.path,w.custodyIngressId);assert.equal(original?.state,action==='Queue'?'owned':'completed');assert.equal(original?.phase,'result_recorded');assert.equal((original?.outcome as any)?.action_completed,true);}return send.apply(this,args);});
  const errors=await processWork(f,http,w);assert.deepEqual(errors,[]);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.confirmationDelivered,true);assert.equal(await ready(f,c),true);assert.equal((await f.seen()).filter(x=>x.method==='turn/steer'||x.method==='turn/interrupt').length,action==='Steer'||action==='Stop'?1:0);
  assert.deepEqual(ops.map(x=>[x.lane,x.operation]),action==='Queue'?[['begin','ReadReady']]:action==='Ignore'?[['begin','Claim'],['completion','Ready']]:[['begin','Claim'],['begin','Resolve'],['completion','Ready']]);assert.equal(ops[0].interactionIngressId,w.custodyIngressId);assert.equal(ops[0].interactionId,w.interactionId);assert.equal(ops[0].sourceMessageId,w.sourceMessageId);assert.equal(ops[0].action,action);
  const repeat=await stageOrdinaryInteraction(f.path,request(c,actor.discordMessageId+1n,action),options);assert.equal(repeat.kind,'CanonicalRepeat');if(repeat.kind!=='CanonicalRepeat')throw Error();assert.equal(repeat.confirmationReady,action==='Queue');
  const confirmation=await prepare(f,http,{...w,processingMode:'ConfirmationOnly',admissionPermit:null});await confirmation.deliver();assert.equal(ops.at(-1).operation,'ReadReady');assert.deepEqual(posts.map(x=>x.method),['POST','PATCH','PATCH']);
 }));
});

for(const failure of ['rollback','lost_ack','partial_ack'] as const)it(`installed Busy ${failure} Claim retains original ingress and shared service barrier without preflight receipt`,async t=>{
 const ops:string[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(isBusyClaim(args[0])){const op=(args[1] as any).operation;ops.push(op);if(op==='Claim'&&failure!=='rollback')return task.then(raw=>{if(failure==='lost_ack')throw Error('lost ACK');return {ok:true,value:(raw as any).value};});}return task;});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(isBusyClaim(args[0]))assert.fail('unknown claim cannot settle');return complete.apply(this,args);});
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await choice(f),w=await stage(f,c);if(failure==='rollback')edit(f.path,"CREATE TRIGGER refuse_busy BEFORE UPDATE OF claimed_at ON busy_choices BEGIN SELECT RAISE(ABORT,'fixture'); END");await processWork(f,http,w);const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'held');assert.equal(ingress?.outcome,undefined);assert.equal(ingress?.eventId,w.interactionId);assert.equal(ingress?.ownerUserId,w.userId);assert.equal(ingress?.channelId,w.channelId);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,failure!=='rollback');assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.equal(posts.some(x=>x.body?.content==='Busy action submitted.'),false);
  if(failure==='rollback')edit(f.path,'DROP TRIGGER refuse_busy');await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ActionUnconfirmed');
  const repeat=await stageOrdinaryInteraction(f.path,request(c,actor.discordMessageId+1n),options);assert.equal(repeat.kind,'CanonicalRepeat');if(repeat.kind!=='CanonicalRepeat')throw Error();assert.equal(repeat.confirmationReady,false);
  const other=await choice(f),next=await stage(f,other,actor.discordMessageId+2n,'Queue');try{await assert.rejects(prepare(f,http,next),e=>{const info=componentWorkerErrorInfo(e),busy=info?.kind==='Busy'?busyComponentErrorInfo(info.source):null;return busy?.kind==='Store'&&busy.source instanceof NativeBusyClaimUnknownError;});assert.equal((await state.readBusyChoiceState(f.path,other.choiceId,now()))!.claimed,false);}finally{next.admissionPermit!.release();}assert.deepEqual(ops,['Claim','RecoverReady']);
 }));
});

for(const failure of ['sql','lost_ack'] as const)it(`installed ${failure} Ready keeps completed-action custody and never reruns the successful Stop`,async t=>{
 const ops:string[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isBusyClaim(args[0]))ops.push((args[1] as any).operation);return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){const task=complete.apply(this,args);if(isBusyClaim(args[0])){ops.push((args[1] as any).operation);if(failure==='lost_ack')return task.then(()=>{throw Error('lost Ready ACK');});}return task;});
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await choice(f),w=await stage(f,c,actor.discordMessageId,'Stop');if(failure==='sql')edit(f.path,"CREATE TRIGGER refuse_ready BEFORE INSERT ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'fixture'); END");await processWork(f,http,w);const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'completed');assert.equal((ingress?.outcome as any)?.action_completed,true);assert.equal(ingress?.confirmationDelivered,false);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal((await f.seen()).length,1);assert.equal(posts.length,0);
  if(failure==='sql'){edit(f.path,'DROP TRIGGER refuse_ready');await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ActionUnconfirmed');}
  else{const plan=await prepare(f,http,w);await plan.deliver();assert.deepEqual(posts.map(x=>x.method),['POST','PATCH']);}
  assert.deepEqual(ops,['Claim','Resolve','Ready','RecoverReady']);assert.equal((await f.seen()).length,1);
 }));
});

for(const failure of ['rejected','unknown'] as const)it(`installed Stop ${failure} response uses the unchanged release allowlist`,async t=>{
 const ops:string[]=[],complete=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(isBusyClaim(args[0]))ops.push((args[1] as any).operation);return complete.apply(this,args);});
 if(failure==='unknown')t.mock.method(PortableResidentLifecycle.prototype,'execute',async()=>{throw Error('unconfirmed control');});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c,actor.discordMessageId,'Stop');if(failure==='rejected')await f.call('fixture/fail');try{await assert.rejects(prepare(f,http,w),e=>busyKind(e)===(failure==='rejected'?'AppServer':'ActionOutcomeIndeterminate'));assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,failure==='unknown');assert.equal(await ready(f,c),false);assert.deepEqual(ops,failure==='rejected'?['Release']:[]);assert.equal((await f.seen()).length,failure==='rejected'?1:0);}finally{w.admissionPermit!.release();}}));
});

it('failed native Release of a definite preflight rejection stays Store uncertainty and never grants a retry receipt',async()=>fixture(f=>httpFixture(async(http)=>{
 const c=await choice(f,'original',false),w=await stage(f,c,actor.discordMessageId,'Stop');edit(f.path,"CREATE TRIGGER refuse_release BEFORE UPDATE OF claimed_at ON busy_choices WHEN NEW.claimed_at IS NULL BEGIN SELECT RAISE(ABORT,'fixture'); END");await processWork(f,http,w);const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'held');assert.equal(ingress?.outcome,undefined);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);edit(f.path,'DROP TRIGGER refuse_release');await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ActionUnconfirmed');
})));

for(const action of ['Queue','Steer'] as const)it(`installed ${action} rejects a changed route at its original boundary`,async()=>fixture(f=>httpFixture(async(http)=>{
 const c=await choice(f),w=await stage(f,c,actor.discordMessageId,action);edit(f.path,"UPDATE mirror_threads SET codex_thread_id='other'");try{await assert.rejects(prepare(f,http,w),e=>busyKind(e)===(action==='Queue'?'Action':'ControlNotDispatched'));assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,false);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);}finally{w.admissionPermit!.release();}
})));

it('changed stored prompt never substitutes the original pre-ACK Steer payload; stored TTL still controls claim eligibility',async()=>fixture(f=>httpFixture(async(http)=>{
 const c=await choice(f),w=await stage(f,c);edit(f.path,"UPDATE busy_choices SET prompt='replacement',allow_steer=1");try{await prepare(f,http,w);assert.equal((await f.seen())[0].params.input[0].text,'original');}finally{w.admissionPermit!.release();}
 const next=await choice(f),expired=await stage(f,next,actor.discordMessageId+1n,'Ignore');edit(f.path,`UPDATE busy_choices SET expires_at=0 WHERE choice_id='${next.choiceId}'`);try{await assert.rejects(prepare(f,http,expired),e=>busyKind(e)==='Missing');assert.equal(await ready(f,next),false);}finally{expired.admissionPermit!.release();}
})));

for(const mismatch of ['userId','channelId'] as const)it(`changed Busy ${mismatch} and Pro Steer are rejected before claiming`,async t=>{
 const run=OwnedWorkerSlot.prototype.run;let claims=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isBusyClaim(args[0]))claims++;return run.apply(this,args);});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),w=await stage(f,c);try{await assert.rejects(prepare(f,http,{...w,[mismatch]:7n}),e=>busyKind(e)===(mismatch==='userId'?'WrongUser':'WrongChannel'));assert.equal(claims,0);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,false);}finally{w.admissionPermit!.release();}
  const pro=await choice(f,'!PrO inspect'),next=await stage(f,pro,actor.discordMessageId+1n);try{await assert.rejects(prepare(f,http,next),e=>busyKind(e)==='ControlNotDispatched');assert.equal(claims,0);assert.equal((await state.readBusyChoiceState(f.path,pro.choiceId,now()))!.claimed,false);}finally{next.admissionPermit!.release();}
 }));
});

it('cancelled native Busy Claim joins real exit before releasing interaction admission and custody',async t=>{
 let started!:()=>void;const submitted=new Promise<void>(r=>started=r),cancel=new AbortController();let blocker:DatabaseSync|undefined;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(!isBusyClaim(args[0])||(args[1] as any).operation!=='Claim')return run.apply(this,args);blocker=new DatabaseSync((args[1] as any).path);blocker.exec('BEGIN IMMEDIATE');const task=run.call(this,args[0],args[1],args[2],cancel.signal);started();return task;});
 await fixture(f=>httpFixture(async(http)=>{const c=await choice(f),gate=new AdmissionGate(),seal=fence(),w=await stage(f,c,actor.discordMessageId,'Steer',gate);gate.seal(seal);let finished=false;const pending=processWork(f,http,w).then(()=>finished=true);try{await submitted;cancel.abort(Error('cancel Busy claim'));await sleep(100);assert.equal(finished,false);assert.equal(gate.isDrainedFor(seal),false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'executing');blocker!.exec('ROLLBACK');blocker!.close();blocker=undefined;await pending;assert.equal(gate.isDrainedFor(seal),true);assert.equal(ownedWorkerUsage().Control,0);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'held');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);}finally{if(blocker!==undefined){if(blocker.isTransaction)blocker.exec('ROLLBACK');blocker.close();}await pending;}}));
});

it('lost native Queue acceptance ACK retains atomic prompt ownership and ready; new services only confirm without another admission',async t=>{
 const run=OwnedWorkerSlot.prototype.run;let admissions=0;const busyOps:string[]=[];
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(isBusyClaim(args[0]))busyOps.push((args[1] as any).operation);if(String(args[0]).endsWith('/prompt-intake/native-state-worker.ts')&&(args[1] as any).operation==='AdmitBusy'){admissions++;return task.then(()=>{throw Error('lost atomic Queue ACK');});}return task;});
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await choice(f),w=await stage(f,c,actor.discordMessageId,'Queue');try{
  await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='Action');assert.equal(await ready(f,c),true);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);const original=await state.getIngress(f.path,w.custodyIngressId);assert.equal(original?.state,'owned');assert.equal(original?.ownerKind,'prompt');assert.equal(original?.ownerId,`busy-choice:${c.choiceId}`);assert.equal(posts.length,0);assert.deepEqual(await f.seen(),[]);
  const repeat=await stageOrdinaryInteraction(f.path,request(c,actor.discordMessageId+1n,'Queue'),options);assert.equal(repeat.kind,'CanonicalRepeat');if(repeat.kind!=='CanonicalRepeat')throw Error();assert.equal(repeat.confirmationReady,true);
  const plan=await prepare(f,http,w);await plan.deliver();assert.equal(admissions,1);assert.deepEqual(busyOps,['ReadReady','ReadReady']);assert.deepEqual(posts.map(x=>x.method),['POST','PATCH']);assert.deepEqual(await f.seen(),[]);
 }finally{w.admissionPermit!.release();}}));
});

function bindingRow(path:string,c:BusyChoice){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT turn_id,job_id FROM codex_busy_control_bindings WHERE choice_id=?').get(c.choiceId);}finally{db.close();}}
async function precedingChoice(f:Fixture){await state.enqueue(f.path,queueJob({jobId:'preceding',targetThreadId:'t',channelId:actor.channelId}));edit(f.path,"UPDATE codex_turn_queue SET state='running',turn_id='v'");const c=await choice(f,'original',false);await state.bindBusyControl(f.path,c.choiceId,'t',null,'preceding');return c;}
const isResolution=(args:Parameters<OwnedWorkerSlot['run']>)=>isBusyClaim(args[0])&&(args[1] as any).operation==='Resolve';
for(const action of ['Stop','Steer'] as const)it(`installed ${action} pins exact preceding job before its original turn control`,async()=>fixture(f=>httpFixture(async(http)=>{
 const c=await precedingChoice(f),w=await stage(f,c,actor.discordMessageId,action);assert.equal(bindingRow(f.path,c)!.turn_id,null);await processWork(f,http,w);assert.equal(bindingRow(f.path,c)!.turn_id,'v');const sent=await f.seen();assert.equal(sent.length,1);assert.equal(sent[0].params[action==='Stop'?'turnId':'expectedTurnId'],'v');assert.equal(await ready(f,c),true);assert.equal(f.queue.locks.activeTargetCount,0);
})));

for(const action of ['Stop','Steer'] as const)for(const change of ['ended','superseded','waiting','mapping'] as const)it(`installed ${action} rejects ${change} after native resolution without refreshing original control`,async()=>fixture(f=>httpFixture(async(http)=>{
 const c=await precedingChoice(f),w=await stage(f,c,actor.discordMessageId,action);if(change==='ended')await f.call('fixture/end');if(change==='superseded')await f.call('fixture/seed',{turn:'later'});if(change==='waiting')edit(f.path,'UPDATE codex_turn_queue SET goal_waiting=1');if(change==='mapping')edit(f.path,"UPDATE mirror_threads SET codex_thread_id='other'");
 try{await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ControlNotDispatched');assert.equal(bindingRow(f.path,c)!.turn_id,change==='waiting'?null:'v');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,false);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.deepEqual(markers(f.path),[]);assert.equal(f.queue.locks.activeTargetCount,0);}finally{w.admissionPermit!.release();}
})));

for(const action of ['Stop','Steer'] as const)for(const failure of ['rollback','lost_ack','partial_ack'] as const)it(`installed ${action} ${failure} Resolve retains ingress and claim without RPC, preflight receipt or new action`,async t=>{
 let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!isResolution(args))return task;count++;return task.then(raw=>{if(failure==='lost_ack')throw Error('lost resolution ACK');return failure==='partial_ack'?{ok:true,value:(raw as any).value}:raw;});});
 await fixture(f=>httpFixture(async(http,posts)=>{const c=await precedingChoice(f),w=await stage(f,c,actor.discordMessageId,action);if(failure==='rollback')edit(f.path,"CREATE TRIGGER reject_resolve BEFORE UPDATE OF turn_id ON codex_busy_control_bindings BEGIN SELECT RAISE(ABORT,'fixture'); END");await processWork(f,http,w);
  assert.equal(bindingRow(f.path,c)!.turn_id,failure==='rollback'?null:'v');const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'held');assert.equal(ingress?.outcome,undefined);assert.equal(ingress?.eventId,w.interactionId);assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);assert.deepEqual(markers(f.path),[]);assert.equal(posts.some(x=>x.body?.content==='Busy action submitted.'),false);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);
  const duplicate=await stageOrdinaryInteraction(f.path,request(c,actor.discordMessageId+1n,action),options);assert.equal(duplicate.kind,'CanonicalRepeat');if(duplicate.kind!=='CanonicalRepeat')throw Error();assert.equal(duplicate.confirmationReady,false);await assert.rejects(prepare(f,http,w),e=>busyKind(e)==='ActionUnconfirmed');
  const next=await choice(f),other=await stage(f,next,actor.discordMessageId+2n,'Queue');try{await assert.rejects(prepare(f,http,other),e=>{const info=componentWorkerErrorInfo(e),busy=info?.kind==='Busy'?busyComponentErrorInfo(info.source):null;return busy?.kind==='Store'&&busy.source instanceof NativeBusyClaimUnknownError&&busy.source.operation==='Resolve';});assert.equal((await state.readBusyChoiceState(f.path,next.choiceId,now()))!.claimed,false);assert.equal(count,1);}finally{other.admissionPermit!.release();}
 }));
});

for(const action of ['Stop','Steer'] as const)it(`cancelled installed ${action} Resolve retains target lease, admission and Control lane until native exit`,async t=>{
 let started!:()=>void;const submitted=new Promise<void>(r=>started=r),cancel=new AbortController();let blocker:DatabaseSync|undefined;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(!isResolution(args))return run.apply(this,args);blocker=new DatabaseSync((args[1] as any).path);blocker.exec('BEGIN IMMEDIATE');const task=run.call(this,args[0],args[1],args[2],cancel.signal);started();return task;});
 await fixture(f=>httpFixture(async(http)=>{const c=await precedingChoice(f),gate=new AdmissionGate(),seal=fence(),w=await stage(f,c,actor.discordMessageId,action,gate);gate.seal(seal);let finished=false;const pending=processWork(f,http,w).then(()=>{finished=true;});try{await submitted;cancel.abort(Error('cancel resolution'));await sleep(100);assert.equal(finished,false);assert.equal(gate.isDrainedFor(seal),false);assert.equal(f.queue.locks.activeTargetCount,1);assert.equal(ownedWorkerUsage().Control,1);assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'executing');assert.equal(bindingRow(f.path,c)!.turn_id,null);blocker!.exec('ROLLBACK');blocker!.close();blocker=undefined;await pending;assert.equal(gate.isDrainedFor(seal),true);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(bindingRow(f.path,c)!.turn_id,'v');assert.equal((await state.getIngress(f.path,w.custodyIngressId))?.state,'held');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,true);assert.equal(await ready(f,c),false);assert.deepEqual(await f.seen(),[]);}finally{if(blocker!==undefined){if(blocker.isTransaction)blocker.exec('ROLLBACK');blocker.close();}await pending;}}));
});

it('confirmed no-submission Resolve refusal permits owned release and a fresh admitted click',async t=>{
 let refuse=true,count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isResolution(args)){count++;if(refuse)return Promise.reject(new OwnedWorkerBusyError());}return run.apply(this,args);});
 await fixture(f=>httpFixture(async(http)=>{const c=await precedingChoice(f),w=await stage(f,c,actor.discordMessageId,'Stop');await processWork(f,http,w);const ingress=await state.getIngress(f.path,w.custodyIngressId);assert.equal(ingress?.state,'completed');assert.equal((ingress?.outcome as any)?.kind,'busy_control_preflight_rejected');assert.equal((await state.readBusyChoiceState(f.path,c.choiceId,now()))!.claimed,false);assert.equal(bindingRow(f.path,c)!.turn_id,null);assert.deepEqual(await f.seen(),[]);refuse=false;const next=await stage(f,c,actor.discordMessageId+1n,'Stop');await processWork(f,http,next);assert.equal(bindingRow(f.path,c)!.turn_id,'v');assert.equal(await ready(f,c),true);assert.equal(count,2);assert.equal((await f.seen()).length,1);
 }));
});

for(const firstAction of ['Stop','Steer'] as const)it(`already-claimed ${firstAction==='Stop'?'Steer':'Stop'} waiting on target lock observes same-owner unknown resolution barrier`,async t=>{
 const secondAction=firstAction==='Stop'?'Steer':'Stop';let resolutions=0;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!isResolution(args))return task;resolutions++;return task.then(()=>{throw Error('lost resolution ACK');});});
 await fixture(f=>httpFixture(async(http)=>{const first=await choice(f),second=await choice(f),one=await stage(f,first,actor.discordMessageId,firstAction),two=await stage(f,second,actor.discordMessageId+1n,secondAction),lease=await f.queue.locks.acquire('t');let locked=0;const lock=ControlTurnVerifier.prototype.lock;t.mock.method(ControlTurnVerifier.prototype,'lock',function(this:ControlTurnVerifier,...args:Parameters<typeof lock>){locked++;return lock.apply(this,args);});
  const firstWork=prepare(f,http,one),firstFailed=assert.rejects(firstWork,e=>busyKind(e)==='ActionOutcomeIndeterminate');let secondWork:Promise<unknown>|undefined,secondFailed:Promise<void>|undefined;
  try{const deadline=AbortSignal.timeout(5000);while(locked<1){deadline.throwIfAborted();await sleep(5);}secondWork=prepare(f,http,two);secondFailed=assert.rejects(secondWork,e=>busyKind(e)==='ActionOutcomeIndeterminate');while(locked<2){deadline.throwIfAborted();await sleep(5);}assert.equal((await state.readBusyChoiceState(f.path,first.choiceId,now()))!.claimed,true);assert.equal((await state.readBusyChoiceState(f.path,second.choiceId,now()))!.claimed,true);lease.release();await firstFailed;await secondFailed;assert.equal(resolutions,1);assert.deepEqual(await f.seen(),[]);assert.deepEqual(markers(f.path),[]);assert.equal(await ready(f,first),false);assert.equal(await ready(f,second),false);assert.equal((await state.readBusyChoiceState(f.path,second.choiceId,now()))!.claimed,true);assert.equal(f.queue.locks.activeTargetCount,0);
  }finally{lease.release();await Promise.allSettled([firstFailed,secondFailed]);one.admissionPermit!.release();two.admissionPermit!.release();}
 }));
});
