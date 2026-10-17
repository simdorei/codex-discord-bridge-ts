import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {usingInitializedStore} from '../../src/store/owned-scope.ts';
import {RuntimeCommandExecutor} from '../../src/runtime/action-executor/command-executor.ts';
import {BridgeState} from '../../src/runtime/bridge-state.ts';
import {QueueStartCoordinator} from '../../src/runtime/queue-runner/start-coordinator.ts';
import {AppServerTurnBackend} from '../../src/runtime/app-server-turn-backend.ts';
import {AdmissionGate} from '../../src/admission/drain-gate.ts';
import {storeFixture} from './store-fixture.ts';
import {queueJob} from './queue-job.ts';
import {asyncChoiceServer,type Config} from './async-choice-server.ts';
import {httpFixture,work} from './interaction-worker-fixture.ts';
export const questionId='a'.repeat(64);
export function row(path:string,sql='SELECT * FROM cdr_async_questions',...values:(string|bigint)[]){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).get(...values);}finally{db.close();}}
export function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
export const mutations=(seen:any[])=>seen.filter(r=>r.method==='turn/steer'||r.method==='turn/start');
export async function nativeAsyncFixture(config:Config,run:(f:any)=>Promise<void>){
 let assertionsCompleted=false;
 try{await storeFixture(async database=>asyncChoiceServer(config,async(server,_q,seen)=>httpFixture(async(http,httpSeen)=>{
  if(config.active==='v'){await state.enqueue(database,queueJob({jobId:'job',targetThreadId:'t',channelId:1n,ownerUserId:2n}));await usingInitializedStore(database,h=>h.exec("UPDATE codex_turn_queue SET state='running',turn_id='v' WHERE job_id='job'"));}
  await usingInitializedStore(database,h=>{h.exec("INSERT INTO mirror_threads VALUES('t','p','T',10,1,0)");h.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,message_id,owner_confirmed,created_at,updated_at) VALUES(?,?,1,'t','v','item','job',1,2,?,'open','9',1,0,0)").run(questionId,server.instanceId,'{"index":0,"source_text":"context 😀","title":"Choose 😀","options":["yes 😀","no"]}');});
  const codex=join(dirname(database),'codex.sqlite'),bridgePath=join(dirname(database),'bridge.json'),db=new DatabaseSync(codex);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.close();
  const bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('t');const backend=new AppServerTurnBackend(server,()=> 'fixture',{resumeTimeoutMs:1000,historyTimeoutMs:1000});let notifications=0;
  const queue=new QueueStartCoordinator(database,backend,{notifyDeliveryReady:()=>{notifications++;}}),executor=new RuntimeCommandExecutor({paths:{state:codex,mirror:database,bridge:bridgePath},bridge,server,backend,queue,render:()=> 'fixture',preparePrompt:async p=>p,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000});
  const click=(option=0n,id=9007199254740993n,q=questionId)=>work(database,id,new AdmissionGate(),`codex_async:${q}:${option}`);
  const prepare=async(w=click())=>{assert.ok('Component'in w.work);return executor.interactionServices(http).prepareComponent(w,w.work.Component);};
  await run({database,server,http,httpSeen,seen,queue,executor,click,prepare,notifications:()=>notifications});assert.equal(queue.locks.activeTargetCount,0);assertionsCompleted=true;
 })));}catch(error){
  // Deliberately exiting the fixture child may race its stdin shutdown. Accept
  // only this exact post-assertion teardown error, never a failed test outcome.
  if(config.dispatch!=='close'||!assertionsCompleted||!(error instanceof AggregateError)||error.errors.length!==1||error.errors[0]?.code!=='ERR_STREAM_PREMATURE_CLOSE')throw error;
 }
}
