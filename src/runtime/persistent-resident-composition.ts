import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {MessagePort} from 'node:worker_threads';
import {sha256SerdeValue} from '../core/serde-json.ts';
import {isOwnedMutationOutcomeUnknown} from '../app-server/maintenance-attempt.ts';
import {usingExistingStore} from '../store/owned-scope.ts';
import {selectJob,serializeStoredQueueJob} from '../store/queue-read.ts';
import {claimStopControl,serializeStopControl,type StopControl} from '../store/stop-control-dispatch.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {measurePassiveValue,SERVICE_PROFILES,validateServiceRequest} from './persistent-resident-services-protocol.ts';
import type {PersistentResidentScenario,PersistentResidentFixtureFailureStep,PersistentResidentFixtureResult} from './persistent-resident-bootstrap.ts';
import {ownedServerResponseFailure,type PendingServerRequest} from '../app-server/server-request-state.ts';
import {ownedResidentFailure} from '../app-server/resident-state.ts';
import {requirePersistentResidentRole} from './persistent-resident-bootstrap.ts';
import {ResidentLocalMutationOwner} from './resident-local-mutation-owner.ts';
import {ClosedBeforePost,type SequentialMutationClient} from './sequential-mutation-broker-client.ts';
import type {createPersistentResidentServicesClient} from './persistent-resident-services-client.ts';
import {installRuntimeIdleJournalNative} from './idle-release-journal.ts';
import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
import {preparePersistentResidentLocalCustody} from './persistent-resident-local-custody.ts';

const render=()=> 'Disposable resident operation unavailable';
type Services=ReturnType<typeof createPersistentResidentServicesClient>;
/** Fixed disposable worker composition. It is deliberately absent from production
 * startup and proves no singleton, physical path ownership, or external ingress. */
export function preparePersistentResidentComposition(runtime:string){
 const {path,fence,persistDeadWork}=preparePersistentResidentLocalCustody(runtime);
 let started=false;
 return Object.freeze({async start(services:Services,mutationClient:SequentialMutationClient,responsePort:MessagePort):Promise<PortableResidentLifecycle>{
  if(started)throw new TypeError('Fixed component already started');started=true;requirePersistentResidentRole();
  const mutation=new ResidentLocalMutationOwner(path,runtime,render,mutationClient);
  const fixture:FixtureBinding={path,runtime,ran:false,ledger:new FixtureWorkflowLedger(),scenario:null,responseAbort:null,captures:0,releases:0,finalRowChanged:false,responseFingerprint:null,cancelAfterPosts:0,failureStep:'none'};
  // Fixed fixture instrumentation retains the exact original receipt and invokes
  // the unchanged owner. It never supplies authority or fabricates completion.
  const nativeDispatch=Object.freeze({...mutation,beginQueueMutation:async(claim:Parameters<typeof mutation.beginQueueMutation>[0])=>{
   const receipt=await mutation.beginQueueMutation(claim);
   if(fixture.scenario==='final-row-changed'){
    assert.equal(fixture.finalRowChanged,false);
    usingExistingStore(path,db=>assert.equal(BigInt(db.prepare("UPDATE codex_turn_queue SET owner_user_id=99 WHERE job_id='fixture-job' AND owner_user_id=3").run().changes),1n));
    fixture.finalRowChanged=true;
   }
   return receipt;
  }});
  const nativeResponse=Object.freeze({...services.response,captureResponse:(claim:Parameters<typeof services.response.captureResponse>[0])=>{
   const receipt=services.response.captureResponse(claim);fixture.captures++;
   if(fixture.scenario==='response-cancel-after'){
    // Borrow the already captured original claim graph for this synchronous hash.
    // Only the branded fixed 16-byte occurrence is projected; retain only the hash.
    const request=claim.request;
    const occurrence=Array.from(ServerRequestOccurrence.prototype.asBytes.call(request.occurrence),byte=>BigInt(byte));
    assert.equal(occurrence.length,16);
    fixture.responseFingerprint=sha256SerdeValue({scope:{runtime,resident:claim.ownerId,generation:claim.generation,request:{id:request.id,occurrence,method:request.method,params:request.params}},authority:claim.authority,payload:claim.payload});
   }
   if(fixture.scenario==='response-cancel-before')fixture.responseAbort?.abort(new Error('Fixed fixture after-capture cancellation'));
   return receipt;
  },finishResponse:(receipt:object,outcome:Parameters<typeof services.response.finishResponse>[1],signal?:AbortSignal):Promise<void>=>{
   if(fixture.scenario!=='response-cancel-after')return services.response.finishResponse(receipt,outcome,signal);
   const controller=fixture.responseAbort;assert.notEqual(controller,null);assert.equal(signal,controller!.signal);
   const descriptor=Object.getOwnPropertyDescriptor(MessagePort.prototype,'postMessage')!,original=MessagePort.prototype.postMessage,brand=MessagePort.prototype.hasRef;
   let matches=0;
   Object.defineProperty(MessagePort.prototype,'postMessage',{...descriptor,value:function(this:MessagePort,...args:Parameters<MessagePort['postMessage']>){
    const raw=args[0] as {service?:unknown;epoch?:unknown;body?:{kind?:unknown}};
    if(this===responsePort&&raw?.service==='response'&&raw?.body?.kind==='submit'){
     assert.equal(typeof brand.call(this),'boolean');
     const frame=validateServiceRequest(raw,'response',raw.epoch as string,runtime);assert.equal(frame.body.kind,'submit');
     if(frame.body.kind!=='submit'||frame.body.payload.op!=='response-finish')throw new Error('Unexpected fixed response post');
     const job=frame.body.payload;
     assert.equal(sha256SerdeValue({scope:job.scope,authority:job.authority,payload:job.payload}),fixture.responseFingerprint);assert.equal(job.outcome,outcome);
     assert.equal(++matches,1);
     // The original native post returns before cancellation. Invoking the async
     // completion function alone is deliberately not considered posting proof.
     const result=Reflect.apply(original,this,args);fixture.cancelAfterPosts++;controller!.abort(new Error('Fixed fixture cancellation after original response post'));return result;
    }
    return Reflect.apply(original,this,args);
   }});
   let pending:Promise<void>;
   try{pending=services.response.finishResponse(receipt,outcome,signal);void pending.catch(()=>undefined);assert.equal(matches,1);}
   finally{Object.defineProperty(MessagePort.prototype,'postMessage',descriptor);}
   return pending;
  },releaseResponse:(receipt:object)=>{services.response.releaseResponse(receipt);fixture.releases++;}});
  const nativeObservation=Object.freeze({...services.observation,close:async()=>{await Promise.all([services.observation.close(),services.gaps.close()]);}});
  const config=Object.freeze({process:{executable:process.execPath,arguments:['--no-strip-types',fileURLToPath(new URL(import.meta.url.endsWith('.js')?'../../test/runtime/fixtures/persistent-resident-inline-responder.js':'../../test/runtime/fixtures/persistent-resident-inline-responder.ts',import.meta.url))],environment:{}},clientInfo:{name:'disposable-resident-component',title:'disposable fixture',version:'951'}});
  let resident:PortableResidentLifecycle;
  try{resident=await PortableResidentLifecycle.start(config,render,Object.freeze({persistDeadWork,oldChildExited(){}}),undefined,Object.freeze({fence,renderError:render,nativeDispatch,nativeIdle:services.idle,nativeResponseCompletion:nativeResponse,nativeObservation}),services.dead);}
  catch(primary){try{for(const close of [services.dead.close,mutation.close,services.response.close,services.idle.close,services.observation.close,services.gaps.close])await close();}catch(cleanup){throw new AggregateError([primary,cleanup],'Disposable component startup cleanup debt',{cause:primary});}throw primary;}
  try{await installRuntimeIdleJournalNative(resident,path,render,services.idle,services.observation);fixtureBindings.set(resident,fixture);return resident;}
  catch(primary){try{await resident.dispose();}catch(cleanup){throw new AggregateError([primary,cleanup],'Disposable component startup cleanup debt',{cause:primary});}throw primary;}
 }});
}


const FIXTURE_TARGET='fixture-target',FIXTURE_TURN='fixture-turn',FIXTURE_JOB='fixture-job';
type FixtureWorkflow='response'|'mutation'|'idle'|'verify'|'gap'|'control';
const FIXTURE_CAPACITY=Object.freeze({response:2,mutation:1,idle:1,verify:2,gap:1,control:1});
/** Fixed inventory, acquired synchronously before any lifecycle clone/target wait.
 * No waiter list and no claim to bound unchanged domain/native/SQLite copies. */
class FixtureWorkflowLedger {
 readonly #used={response:0,mutation:0,idle:0,verify:0,gap:0,control:0};
 acquire(kind:FixtureWorkflow):()=>void{
  if(this.#used[kind]>=FIXTURE_CAPACITY[kind])throw new Error('Fixed fixture workflow capacity exhausted');
  this.#used[kind]++;let released=false;
  return ()=>{if(released)throw new Error('Fixed fixture workflow released twice');released=true;this.#used[kind]--;};
 }
 get empty():boolean{return Object.values(this.#used).every(n=>n===0);}
}
interface FixtureBinding {readonly path:string;readonly runtime:string;readonly ledger:FixtureWorkflowLedger;ran:boolean;scenario:PersistentResidentScenario|null;responseAbort:AbortController|null;captures:number;releases:number;finalRowChanged:boolean;responseFingerprint:string|null;cancelAfterPosts:number;failureStep:PersistentResidentFixtureFailureStep}
const fixtureBindings=new WeakMap<PortableResidentLifecycle,FixtureBinding>();
/** Fixed scalar diagnostic only; no claim, graph, callback, or authority escapes. */
export function getPersistentResidentFixtureFailureStep(resident:PortableResidentLifecycle):PersistentResidentFixtureFailureStep{return fixtureBindings.get(resident)?.failureStep??'none';}
const MUTATION_FIXTURE_BOUNDS=Object.freeze({bytes:1048576,units:1048576,nodes:65536,edges:65536,depth:64,entries:65536});
function freezeFixtureInput(value:unknown):unknown{
 if(value!==null&&typeof value==='object'){for(const key of Object.keys(value))freezeFixtureInput(Object.getOwnPropertyDescriptor(value,key)!.value);Object.freeze(value);}return value;
}
async function fixtureWorkflow<T>(binding:FixtureBinding,kind:FixtureWorkflow,input:unknown,run:(owned:unknown)=>Promise<T>):Promise<T>{
 measurePassiveValue(input,kind==='response'?SERVICE_PROFILES.response.input:MUTATION_FIXTURE_BOUNDS);
 const release=binding.ledger.acquire(kind);let owned:unknown=null;
 try{owned=freezeFixtureInput(input);input=null;const result=await run(owned);if(result!==undefined)measurePassiveValue(result,SERVICE_PROFILES.verify.output);return result;}
 finally{owned=null;release();}
}
function fixtureRow(binding:FixtureBinding,generation:bigint,state:'starting'|'running'):void{
 usingExistingStore(binding.path,db=>{
  db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,turn_observation_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES(?,?,42,3,?,?,?,'fixed fixture input',0,1,?,1,?,'[]',1,1)")
   .run(FIXTURE_JOB,FIXTURE_TARGET,generation,generation,state==='running'?generation:null,state,state==='running'?FIXTURE_TURN:null);
 });
}
function fixtureCount(binding:FixtureBinding,sql:string):number{
 return usingExistingStore(binding.path,db=>{const row=db.prepare(sql).get();assert.equal(typeof row?.n,'number');return row!.n as number;});
}
async function fixtureRequest(resident:PortableResidentLifecycle,binding:FixtureBinding,method:string,params:unknown):Promise<unknown>{
 return fixtureWorkflow(binding,'mutation',{method,params,timeoutMs:5000},async input=>resident.execute(input as {method:string;params:unknown;timeoutMs:number},resident.generation()));
}
async function fixtureServerRequest(resident:PortableResidentLifecycle,binding:FixtureBinding):Promise<PendingServerRequest>{
 binding.failureStep='request';
 const source=resident.subscribeServerRequests(),controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('Fixed fixture server request deadline')),5000);
 try{
  await fixtureRequest(resident,binding,'thread/read',{threadId:FIXTURE_TARGET});
  const event=await source.receive(controller.signal);
  assert.equal(event.kind,'Request');if(event.kind!=='Request')throw new Error('Fixed fixture request gap');
  assert.equal(event.generation,resident.generation());assert.equal(event.request.id,'fixture-response-1');assert.equal(event.request.method,'item/commandExecution/requestApproval');
  assert.equal((event.request.params as {threadId:string}).threadId,FIXTURE_TARGET);
  return event.request;
 }finally{clearTimeout(timer);source.dispose();}
}
async function fixtureRespond(resident:PortableResidentLifecycle,binding:FixtureBinding,request:PendingServerRequest,result:unknown,signal?:AbortSignal):Promise<void>{
 binding.failureStep='respond';
 await fixtureWorkflow(binding,'response',{id:request.id,result},async input=>{
  const payload=input as {result:unknown};await resident.respond(request.id,request.occurrence,payload.result,resident.generation(),signal);
 });
}
async function fixtureChildResponseAck(resident:PortableResidentLifecycle,binding:FixtureBinding,run:()=>Promise<void>):Promise<void>{
 const source=resident.subscribeNotifications(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Fixed fixture response ACK deadline')),5000);
 try{
  await run();binding.failureStep='child-ack';const event=await source.receive(controller.signal);assert.equal(event.kind,'Notification');
  if(event.kind!=='Notification')throw new Error('Fixed fixture response notification gap');
  assert.equal(event.notification.method,'fixture/response-received');assert.equal((event.notification.params as {remaining:number}).remaining,0);
 }finally{clearTimeout(timer);source.dispose();}
}
async function fixtureEventually(check:()=>boolean):Promise<void>{
 const until=performance.now()+10000;
 while(!check()){if(performance.now()>=until)throw new Error('Fixed fixture observation deadline');await new Promise<void>(resolve=>setTimeout(resolve,1));}
}
/** One compiled scenario per original component. No transported SQL, callbacks,
 * executable, payload, or claim enters this driver. A pass follows real assertions. */
export async function runPersistentResidentFixture(resident:PortableResidentLifecycle,scenario:PersistentResidentScenario):Promise<PersistentResidentFixtureResult>{
 const binding=fixtureBindings.get(resident);if(!binding||binding.ran)throw new Error('Expected unused original fixed fixture resident');binding.ran=true;binding.scenario=scenario;
 requirePersistentResidentRole();const generation=resident.generation();
 assert.equal(generation,1n);assert.equal(resident.lifecycleSnapshot().healthy,true);assert.equal(resident.observationTrackingEnabled(),true);
 assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM codex_mutation_runtime"),1);
 assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM codex_app_server_runtime"),1);
 switch(scenario){
  case 'normal-start-close':break;
  case 'mutation-cancel-after-write':{
   // A real child notification proves the original wire reached the responder.
   // Cancellation uses the original lifecycle signal; no hook/owner is replaced.
   const source=resident.subscribeNotifications(),observation=new AbortController(),controller=new AbortController();
   const reason=new Error('Fixed fixture mutation cancellation after child receipt');
   const timer=setTimeout(()=>observation.abort(new Error('Fixed fixture mutation barrier deadline')),5000);
   let settled=false;
   binding.failureStep='request';
   const mutation=fixtureWorkflow(binding,'mutation',{method:'thread/settings/update',params:{threadId:'fixture-independent',model:'fixture-model'},timeoutMs:5000},async input=>resident.execute(input as {method:string;params:unknown;timeoutMs:number},generation,controller.signal));
   void mutation.then(()=>{settled=true;},()=>{settled=true;});
   try{
    const event=await source.receive(observation.signal);
    assert.equal(event.kind,'Notification');if(event.kind!=='Notification')throw new Error('Fixed fixture mutation notification gap');
    assert.equal(event.generation,generation);assert.equal(event.notification.method,'fixture/mutation-held');
    assert.equal((event.notification.params as {threadId:string}).threadId,'fixture-independent');assert.equal(settled,false);
    const read=()=>usingExistingStore(binding.path,db=>db.prepare('SELECT * FROM codex_mutation_attempts').all());
    binding.failureStep='durable-assert';const original=read();assert.equal(original.length,1);
    const row=original[0]!;assert.equal(row.runtime_id,binding.runtime);assert.equal(row.owner_id,resident.instanceId);
    assert.equal(BigInt(row.generation as number|bigint),generation);assert.equal(row.method,'thread/settings/update');
    assert.equal(row.target_thread_id,'fixture-independent');assert.equal(row.state,'prepared');
    assert.equal(typeof row.attempt_id,'string');assert.notEqual(row.attempt_id,'');assert.equal(typeof row.wire_id,'string');assert.notEqual(row.wire_id,'');
    const cancelled=assert.rejects(mutation,error=>error===reason);controller.abort(reason);await cancelled;
    assert.equal(settled,true);assert.deepEqual(read(),original);assert.equal(resident.generation(),generation);assert.equal(resident.lifecycleSnapshot().healthy,true);
    // A different, otherwise clear target reaches the real local admission
    // refusal rather than borrowing the original target's durable custody hold.
    await assert.rejects(fixtureRequest(resident,binding,'thread/settings/update',{threadId:FIXTURE_TARGET,model:'fixture-model'}),ClosedBeforePost);
    assert.deepEqual(read(),original);binding.failureStep='release-assert';
   }finally{
    clearTimeout(timer);source.dispose();if(!controller.signal.aborted)controller.abort(reason);
    await Promise.allSettled([mutation]);
   }
   // Assertions may pass, but original terminal disposal must still reject:
   // the cancelled original intent and broker quarantine cannot become clean.
   break;
  }
  case 'ordinary-queue-stop':{
   fixtureRow(binding,generation,'starting');
   await fixtureRequest(resident,binding,'thread/settings/update',{threadId:FIXTURE_TARGET,model:'fixture-model'});
   let claim:unknown=usingExistingStore(binding.path,db=>parseSerdeValue(serializeStoredQueueJob(selectJob(db,FIXTURE_JOB))));
   const request={method:'turn/start',params:{threadId:FIXTURE_TARGET,input:'fixed fixture input'},timeoutMs:5000};
   await fixtureWorkflow(binding,'mutation',{request,claim},async input=>{const value=input as {request:typeof request;claim:unknown};return resident.executeQueueTurn(value.request,generation,value.claim);});claim=null;
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM codex_mutation_attempts WHERE state='reply_ok'"),2);
   usingExistingStore(binding.path,db=>{db.prepare("UPDATE codex_turn_queue SET state='running',turn_id=?,turn_observation_generation=? WHERE job_id=?").run(FIXTURE_TURN,generation,FIXTURE_JOB);db.prepare("INSERT INTO cdr_execution_holds VALUES(?,?,'stop','{}',0)").run(FIXTURE_JOB,FIXTURE_TARGET);});
   let control:StopControl|null=usingExistingStore(binding.path,db=>({operation_id:'fixture-original-stop',target:FIXTURE_TARGET,channel:42n,owner:3n,resident:resident.instanceId,generation,turn:FIXTURE_TURN,binding:{target:FIXTURE_TARGET,route:'Selected',command:{Stop:{reference:null}}},jobs:[serializeStoredQueueJob(selectJob(db,FIXTURE_JOB))],can_settle:true}));
   usingExistingStore(binding.path,db=>{const original=control!;db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES(?,?,?,?,?,?,'accepted')").run(original.operation_id,original.target,original.resident,original.generation,original.turn,serializeStopControl(original));});
   let stopClaim=claimStopControl(binding.path,control,()=>{});control=null;assert.notEqual(stopClaim,null);
   await fixtureWorkflow(binding,'mutation',{request:{method:'turn/interrupt',params:{threadId:FIXTURE_TARGET,turnId:FIXTURE_TURN},timeoutMs:5000},claim:stopClaim},async input=>{const value=input as {request:{method:string;params:unknown;timeoutMs:number};claim:unknown};return resident.executeStopControl(value.request,generation,value.claim,()=>{});});stopClaim=null;
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_stop_controls WHERE phase='acknowledged'"),1);
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_execution_holds"),1);break;
  }
  case 'response-large':case 'response-begin-refused':case 'response-cancel-before':case 'response-unknown':case 'response-cancel-after':{
   binding.failureStep='seed';fixtureRow(binding,generation,'running');let request:PendingServerRequest|null=await fixtureServerRequest(resident,binding);
   if(scenario==='response-begin-refused'){
    usingExistingStore(binding.path,db=>db.exec("CREATE TRIGGER fixture_refuse_response BEFORE INSERT ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'fixed fixture begin refusal'); END"));
    try{
     await assert.rejects(fixtureRespond(resident,binding,request,{decision:'accept'}),error=>ownedResidentFailure(error)?.kind==='MutationHeld');
     // Normal responses claim the original occurrence before durable preflight.
     // A refused begin releases its local receipt but retains that occurrence
     // as indeterminate; it must never acquire permission to replay.
     for(let i=0;i<2;i++)await assert.rejects(fixtureRespond(resident,binding,request,{decision:'accept'}),error=>ownedServerResponseFailure(error)==='ServerRequestResponseIndeterminate');
     binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses"),0);
     binding.failureStep='release-assert';assert.equal(binding.captures,1);assert.equal(binding.releases,1);
    }
    finally{usingExistingStore(binding.path,db=>db.exec('DROP TRIGGER fixture_refuse_response'));}
   }
   if(scenario==='response-cancel-before'){
    for(let i=0;i<3;i++){const controller=new AbortController();binding.responseAbort=controller;try{await assert.rejects(fixtureRespond(resident,binding,request,{decision:'accept'},controller.signal),error=>controller.signal.aborted&&error===controller.signal.reason);}finally{binding.responseAbort=null;}}
    binding.failureStep='release-assert';assert.equal(binding.captures,3);assert.equal(binding.releases,3);
    binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses"),0);
    const read=await fixtureRequest(resident,binding,'thread/read',{threadId:FIXTURE_TARGET,includeTurns:true});assert.equal((read as {fixture:{responses:number}}).fixture.responses,0);
   }
   if(scenario==='response-cancel-after'){
    const controller=new AbortController();binding.responseAbort=controller;
    try{await fixtureChildResponseAck(resident,binding,async()=>{await assert.rejects(fixtureRespond(resident,binding,request!,{decision:'accept'},controller.signal),isOwnedMutationOutcomeUnknown);});}
    finally{binding.responseAbort=null;binding.responseFingerprint=null;}
    assert.equal(controller.signal.aborted,true);assert.equal(binding.cancelAfterPosts,1);
    // A posted cancellation may race a commit; neither outcome permits replay.
    binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses WHERE phase IN ('admitted','flushed')"),1);
    await assert.rejects(fixtureRespond(resident,binding,request,{decision:'accept'}));
   }else if(scenario==='response-unknown'){
    usingExistingStore(binding.path,db=>db.exec("CREATE TRIGGER fixture_refuse_completion BEFORE UPDATE ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'fixed fixture completion refusal'); END"));
    try{await fixtureChildResponseAck(resident,binding,async()=>{await assert.rejects(fixtureRespond(resident,binding,request!,{decision:'accept'}));});}
    finally{usingExistingStore(binding.path,db=>db.exec('DROP TRIGGER fixture_refuse_completion'));}
    binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses WHERE phase='admitted'"),1);
    await assert.rejects(fixtureRespond(resident,binding,request,{decision:'accept'}));
   }else if(scenario==='response-begin-refused'){
    // Removing the DB refusal does not reset the retained original occurrence.
    await assert.rejects(fixtureRespond(resident,binding,request,{decision:'accept'}),error=>ownedServerResponseFailure(error)==='ServerRequestResponseIndeterminate');
    binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses"),0);
    const read=await fixtureRequest(resident,binding,'thread/read',{threadId:FIXTURE_TARGET,includeTurns:true});assert.equal((read as {fixture:{responses:number}}).fixture.responses,0);
    assert.equal(resident.pendingServerRequests(FIXTURE_TARGET).length,0);assert.equal(resident.hasUnsettledServerRequests(),true);
    binding.failureStep='release-assert';assert.equal(binding.captures,1);assert.equal(binding.releases,1);
   }else{
    let result:unknown=scenario==='response-large'?{decision:'accept',content:'x'.repeat(2*1024*1024)}:{decision:'accept'};
    await fixtureChildResponseAck(resident,binding,()=>fixtureRespond(resident,binding,request!,result));result=null;
    binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses WHERE phase='flushed'"),1);
   }
   binding.failureStep='release-assert';assert.equal(binding.captures,binding.releases);request=null;break;
  }
  case 'observation-gap':{
   assert.equal(await fixtureWorkflow(binding,'verify',null,()=>resident.reconcileIdleObservationPrefixAsync(generation,0n)),true);
   let reported=false;
   const old=fixtureWorkflow(binding,'verify',null,()=>resident.reconcileIdleObservationPrefixAsync(generation,0n));void old.catch(()=>undefined);
   await fixtureWorkflow(binding,'gap',null,async()=>{resident.markIdleObservationGap(()=>{reported=true;});await fixtureEventually(()=>fixtureCount(binding,"SELECT count(*) AS n FROM cdr_observation_gaps WHERE state='Unresolved'")===1);});
   assert.equal(await old,false);assert.equal(reported,false);
   assert.equal(await fixtureWorkflow(binding,'verify',null,()=>resident.reconcileIdleObservationPrefixAsync(generation,0n)),false);break;
  }
  case 'normal-replacement':{
   const old=resident.lifecycleSnapshot();
   usingExistingStore(binding.path,db=>db.prepare("INSERT INTO cdr_idle_release VALUES('fixture-exit',?,?,'fixture-idle-exit','fixture-old-turn','fixture-old-job',1,'AwaitUnload','fixed fixture exit settlement')").run(resident.instanceId,generation));
   assert.equal(await fixtureWorkflow(binding,'control',null,()=>resident.forceRestartIfQuiescent()),true);
   const next=resident.lifecycleSnapshot();assert.equal(next.generation,generation+1n);assert.equal(next.healthy,true);assert.notEqual(next.processId,old.processId);
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_idle_release WHERE intent_id='fixture-exit' AND state='Settled' AND detail='OldServerExited' AND revision=2"),1);break;
  }
  case 'idle-transition':{
   usingExistingStore(binding.path,db=>db.prepare("INSERT INTO cdr_idle_release VALUES('fixture-resume',?,?,'fixture-target','fixture-turn','fixture-completed-job',1,'AwaitUnload','fixed acknowledged unload fixture')").run(resident.instanceId,generation));
   assert.equal(resident.subscriptionResumeRequired(FIXTURE_TARGET),true);
   await fixtureWorkflow(binding,'idle',{method:'thread/settings/update',params:{threadId:FIXTURE_TARGET},timeoutMs:5000},async input=>resident.execute(input as {method:string;params:unknown;timeoutMs:number},generation));
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_idle_release WHERE intent_id='fixture-resume' AND state='Settled' AND detail='SupersededByConfirmedResubscribe' AND revision=3"),1);
   assert.equal(resident.subscriptionResumeRequired(FIXTURE_TARGET),false);
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM codex_mutation_attempts WHERE state='reply_ok'"),2);break;
  }
  case 'final-row-changed':{
   fixtureRow(binding,generation,'starting');
   let claim:unknown=usingExistingStore(binding.path,db=>parseSerdeValue(serializeStoredQueueJob(selectJob(db,FIXTURE_JOB))));
   const request={method:'turn/start',params:{threadId:FIXTURE_TARGET,input:'fixed fixture input'},timeoutMs:5000};
   await assert.rejects(fixtureWorkflow(binding,'mutation',{request,claim},async input=>{const value=input as {request:typeof request;claim:unknown};return resident.executeQueueTurn(value.request,generation,value.claim);}));claim=null;
   assert.equal(binding.finalRowChanged,true);
   assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM codex_mutation_attempts WHERE state='not_sent'"),1);
   const read=await fixtureRequest(resident,binding,'thread/read',{threadId:FIXTURE_TARGET,includeTurns:true});
   assert.equal((read as {fixture:{turnStarts:number}}).fixture.turnStarts,0);break;
  }
  case 'response-concurrent':{
   binding.failureStep='seed';fixtureRow(binding,generation,'running');let request:PendingServerRequest|null=await fixtureServerRequest(resident,binding);
   const source=resident.subscribeNotifications(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Fixed fixture mutation barrier deadline')),5000);
   let done=false;
   const mutation=fixtureRequest(resident,binding,'thread/settings/update',{threadId:'fixture-independent',model:'fixture-model'}).finally(()=>{done=true;});void mutation.catch(()=>undefined);
   try{
    const event=await source.receive(controller.signal);assert.equal(event.kind,'Notification');if(event.kind!=='Notification')throw new Error('Fixed fixture barrier gap');assert.equal(event.notification.method,'fixture/mutation-held');
    assert.equal(done,false);
    await fixtureChildResponseAck(resident,binding,()=>fixtureRespond(resident,binding,request!,{decision:'accept'}));
    binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM cdr_server_responses WHERE phase='flushed'"),1);assert.equal(done,false);
    // The original mutation is awaiting a child reply here. This explicitly
    // does NOT establish occupied mutation-status or same-target progress.
    await fixtureWorkflow(binding,'control',{method:'thread/read',params:{threadId:FIXTURE_TARGET,includeTurns:true},timeoutMs:5000},async input=>resident.execute(input as {method:string;params:unknown;timeoutMs:number},generation));
    await mutation;binding.failureStep='durable-assert';assert.equal(fixtureCount(binding,"SELECT count(*) AS n FROM codex_mutation_attempts WHERE state='reply_ok'"),1);
   }finally{clearTimeout(timer);source.dispose();request=null;await Promise.allSettled([mutation]);}
   binding.failureStep='release-assert';assert.equal(binding.captures,binding.releases);break;
  }
  default:throw new Error('Unsupported fixed resident fixture scenario');
 }
 assert.equal(binding.ledger.empty,true);
 return scenario==='mutation-cancel-after-write'?Object.freeze({scenario,assertionsPassed:true,cleanupQualified:false,componentQualified:false}):Object.freeze({scenario,passed:true});
}
