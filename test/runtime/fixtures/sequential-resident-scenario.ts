import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {createMainSequentialMutationBroker} from '../../../src/runtime/sequential-mutation-broker-owner.ts';
import type {SequentialMutationBrokerLimits} from '../../../src/runtime/sequential-mutation-broker-protocol.ts';
import {ownedWorkerModuleUrl,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
import {selectJob,serializeStoredQueueJob} from '../../../src/store/queue-read.ts';
import {parseSerdeValue} from '../../../src/core/serde-json-parse.ts';
import {claimStopControl,serializeStopControl} from '../../../src/store/stop-control-dispatch.ts';
import type {MaintenanceClaim} from '../../../src/app-server/maintenance-attempt.ts';

// Frozen section 12.5 qualification values. Never tune these after a failure.
const profile=Object.freeze({maxClaimUtf8Bytes:1048576,maxClaimStringUnits:1048576,maxClaimNodes:65536,maxClaimEdges:65536,maxClaimDepth:64,maxContainerEntries:65536,maxNativeResultUtf8Bytes:16384,maxRetainedLogicalBytes:22249600,maxRetainedNodes:393488,maxRetainedEdges:393484,nativeTimeoutMs:5000,handshakeTimeoutMs:5000,exchangeTimeoutMs:5000,preparedAwaitFinishTimeoutMs:5000,terminalRetentionMs:5000,minStatusIntervalMs:1,phaseObservationTimeoutMs:10000,maxOperationId:2147483647,maxExchangeId:2147483647} satisfies SequentialMutationBrokerLimits);
const scenario=process.argv[2];if(!scenario)throw new Error('Explicit scenario required');
const limits=scenario==='finite'?Object.freeze({...profile,maxOperationId:2,maxExchangeId:64,minStatusIntervalMs:1000}):scenario==='headroom'?Object.freeze({...profile,maxOperationId:2,maxExchangeId:8,minStatusIntervalMs:1000}):profile;
const report=(event:string)=>process.stdout.write(JSON.stringify({event})+'\n');
async function observeJoin(pending:Promise<void>,name:string):Promise<void>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([pending,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(`Frozen join observation deadline: ${name}`)),10000);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
await storeFixture(async path=>{
 const db=await openInitialized(path);
 db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
 const fence=createMutationCustodyFence(path,'runtime',()=> 'safe');
 const ordinary:MaintenanceClaim[]=Array.from({length:12},(_,i)=>{const params={threadId:`ordinary-${i}`};return {ownerId:'resident',generation:1n,attemptId:`ordinary-${i}`,wire:BigInt(i+1),method:'thread/settings/update',params,scoped:true,origin:fence.requestOrigin('thread/settings/update',params)};});
 // Queue and stop claims are captured through the existing original store constructors.
 db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('queue-job','queue-target',42,3,1,1,'input',0,1,'starting',1,'[]',1,1)");
 const queue={ownerId:'resident',generation:1n,attemptId:'queue-attempt',wire:101n,method:'turn/start',params:{threadId:'queue-target'},claim:parseSerdeValue(serializeStoredQueueJob(selectJob(db,'queue-job')))};
 db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,turn_observation_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('stop-job','stop-target',42,3,1,1,1,'input',0,1,'running',1,'V','[]',1,1); INSERT INTO cdr_execution_holds VALUES('stop-job','stop-target','stop','{}',0)");
 const control={operation_id:'stop-original',target:'stop-target',channel:42n,owner:3n,resident:'resident',generation:1n,turn:'V',binding:{target:'stop-target',route:'Selected',command:{Stop:{reference:null}}},jobs:[serializeStoredQueueJob(selectJob(db,'stop-job'))],can_settle:true};
 db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('stop-original','stop-target','resident',1,'V',?,'accepted')").run(serializeStopControl(control));
 const stop={ownerId:'resident',generation:1n,attemptId:'stop-attempt',wire:102n,params:{threadId:'stop-target',turnId:'V'},claim:claimStopControl(path,control,()=>{})};assert.ok(stop.claim);
 const broker=createMainSequentialMutationBroker(path,'runtime',limits);
 if(scenario==='bootstrap-stop'){broker.stopNewWork();await observeJoin(broker.join(),'native/port/requester join');assert.equal(broker.snapshot().state,'Q');assert.equal(broker.snapshot().rootLogicalBytes,49152);assert.equal(broker.snapshot().resourceJoined,true);assert.throws(()=>createMainSequentialMutationBroker(path,'runtime',profile));db.close();report('passed');return;}
 const gate=new Int32Array(new SharedArrayBuffer(4));
 const worker=new Worker(ownedWorkerModuleUrl(new URL('./sequential-resident-requester.ts',import.meta.url),import.meta.url),{workerData:{scenario,path,ordinary,queue,stop,gate:gate.buffer}});
 const reports:{event:string;value:any}[]=[];let exit=false;
 const joined=new Promise<void>((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>{exit=true;code===(scenario==='nonzero-close'?1:0)?resolve():reject(new Error(`Requester exit ${code}`));});});
 worker.on('message',value=>{reports.push(value);report(value.event);});broker.bindRequester(worker);
 const advance=(n:number)=>Atomics.store(gate,0,n);
 async function event(name:string):Promise<any>{const deadline=Date.now()+10000;for(;;){const error=reports.find(r=>r.event==='error');if(error)throw Error(JSON.stringify(error.value));const found=reports.find(r=>r.event===name);if(found)return found.value;if(exit)throw Error(`Requester exited before ${name}`);if(Date.now()>=deadline)throw Error(`Frozen observation deadline: ${name}`);await delay(2);}}
 function retained(){const s=broker.snapshot();assert.equal(s.lifecycleLogicalBytes,22249600);assert.equal(s.lifecycleNodes,393488);assert.equal(s.lifecycleEdges,393484);assert.equal(s.rootLogicalBytes,49152);assert.equal(s.rootNodes,192);assert.equal(s.rootEdges,192);}
 function row(){return db.prepare("SELECT state FROM codex_mutation_attempts WHERE attempt_id='ordinary-0'").get();}
 try{
  await event('ready');retained();advance(1);
  if(scenario==='normal'||scenario==='busy'||scenario==='invalid-local'||scenario==='finite'||scenario==='receipts'||scenario==='drain'){
   const count=scenario==='normal'?14:scenario==='finite'?2:1;
   for(let i=1;i<=count;i++){
    await event(`prepared-${i}`);retained();assert.equal(ownedWorkerUsage().Control,0,'begin success requires actual native exit');assert.equal(broker.snapshot().retainedClaims,1);assert.equal(broker.snapshot().queuedSubmissions,0);if(scenario==='drain')broker.stopNewWork();advance(2*i);
    await event(`retired-${i}`);retained();assert.equal(ownedWorkerUsage().Control,0,'finish success requires actual native exit');assert.equal(broker.snapshot().retiredThrough,i);assert.equal(broker.snapshot().retainedClaims,0);assert.equal(broker.snapshot().operationId,null);advance(2*i+1);
   }
   if(scenario==='normal'){
    assert.equal(db.prepare('SELECT count(*) AS n FROM codex_mutation_attempts').get()!.n,13);
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts WHERE state='reply_ok'").get()!.n,13);
    assert.equal(db.prepare('SELECT phase FROM cdr_stop_controls').get()!.phase,'acknowledged');
    assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_execution_holds').get()!.n,1);
    assert.equal(broker.snapshot().nativeInvocations,28);
   }
   await event('closed');await observeJoin(joined,'original requester exit');await observeJoin(broker.join(),'native/port/requester join');assert.equal(broker.snapshot().rootLogicalBytes,0);assert.equal(broker.snapshot().lifecycleLogicalBytes,0);
   const replacement=createMainSequentialMutationBroker(path,'runtime',profile);replacement.quarantine();await observeJoin(replacement.join(),'unused replacement native join');
  }else if(scenario==='headroom'){
   await event('exhausted');await event('closed');await observeJoin(joined,'original requester exit');await observeJoin(broker.join(),'native/port/requester join');assert.equal(broker.snapshot().nativeInvocations,0);assert.equal(row(),undefined);assert.equal(broker.snapshot().rootLogicalBytes,0);
  }else{
   if(scenario==='row-changed'){await event('prepared-1');db.exec("DELETE FROM codex_mutation_attempts WHERE attempt_id='ordinary-0'");advance(2);}
   if(scenario==='sql-finish-failure'){await event('prepared');db.exec("CREATE TRIGGER reject_finish BEFORE UPDATE ON codex_mutation_attempts BEGIN SELECT RAISE(ABORT,'fixture denied'); END");advance(2);}
   if(scenario==='hold-requester'){await event('holding');retained();assert.equal(broker.snapshot().requesterRetention,true);assert.throws(()=>createMainSequentialMutationBroker(path,'runtime',profile));advance(2);}
   await event('quarantined');await observeJoin(joined,'original requester exit');await observeJoin(broker.join(),'native/port/requester join');
   assert.equal(broker.snapshot().rootLogicalBytes,49152,'permanent quarantine root remains charged after real joins');assert.equal(broker.snapshot().lifecycleLogicalBytes,0);assert.equal(broker.snapshot().requesterRetention,false);assert.equal(broker.snapshot().resourceJoined,true);assert.equal(broker.snapshot().portRetention,false);assert.equal(ownedWorkerUsage().Control,0);
   assert.throws(()=>createMainSequentialMutationBroker(path,'runtime',profile),'same isolate cannot replace quarantine');
   if(['raw-old-epoch','raw-exchange','raw-future-id','raw-kind','raw-early-finish','raw-duplicate-ready','raw-extra-field','nonzero-close'].includes(scenario)){assert.equal(broker.snapshot().nativeInvocations,0);assert.equal(row(),undefined);}
   if(scenario==='raw-retired-id'){assert.equal(broker.snapshot().nativeInvocations,2);assert.equal(broker.snapshot().retiredThrough,1);assert.equal(row()?.state,'reply_ok');}
   if(scenario==='raw-duplicate-begin')assert.equal(broker.snapshot().nativeInvocations,1);
   if(scenario==='lost-finish'||scenario==='lost-terminal-ack'){assert.equal(row()?.state,'reply_ok');assert.equal(broker.snapshot().nativeInvocations,2);}
   if(scenario==='lost-terminal-ack')assert.equal(broker.snapshot().retiredThrough,1);
   if(['lost-begin','lost-begin-ack','sql-finish-failure','hold-requester','unknown','raw-prepared-expiry'].includes(scenario))assert.equal(row()?.state,'prepared');
  }
  report('passed');
 }finally{advance(100);if(!exit)broker.quarantine();await observeJoin(joined,'original requester exit');await observeJoin(broker.join(),'native/port/requester join');db.close();}
});
