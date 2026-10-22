import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {writeFile,appendFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade} from '../../../src/store/state-access-facade.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {runBoundMirrorWorker} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {createVerifiedLocalSessionMirrorProfile} from '../../../src/runtime/discord-runtime/local-session-mirror-profile.ts';
import {ownedWorkerUsage,withOwnedWorkerBackpressure,withOwnedWorkerReuse,closeOwnedWorkerPool} from '../../../src/runtime/owned-worker-slot.ts';

test('21 unbound legacy mirrors release ownership while a healthy peer and a real queued start progress; retries read no history', {timeout:60000},async t=>withOwnedWorkerBackpressure(()=>withOwnedWorkerReuse(()=>storeFixture(async bridge=>{
 const file=join(dirname(bridge),'good.jsonl'),absent=join(dirname(bridge),'must-not-read-history.jsonl'),state=join(dirname(bridge),'state.sqlite');
 await writeFile(file,'');const db=await openInitialized(bridge),codex=new DatabaseSync(state);
 codex.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');
 const bad=Array.from({length:21},(_,i)=>'bad-'+String(i).padStart(2,'0'));
 for(const [i,id]of[...bad,'good'].entries()){
  db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(id,'project','fixture',1,100+i,1);
  codex.prepare('INSERT INTO threads(id,rollout_path,archived)VALUES(?,?,0)').run(id,id==='good'?file:absent);
  if(id!=='good')db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run(id,absent,2,123,null);
 }
 codex.close();const original=db.prepare('SELECT * FROM codex_session_mirror_offsets ORDER BY codex_thread_id').all();db.close();
 const cursors=new NativeMirrorCursorStore(bridge),intents=new NativeMirrorStartupIntentStore(bridge);
 const controller=new AbortController(),failures=new Map<string,number>();let sent=0,reports=0,starts=0,goodDone=false,queueDone=false,queueTask:Promise<void>|undefined,appendTask:Promise<void>|undefined,appendStarted=0,appendDeliveredMs:number|undefined;
 const queue=new QueueStartCoordinator(bridge,{generation:()=>1n,residentInstanceId:()=> 'fixture-resident',activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async claim=>{assert.equal(claim.targetThreadId,bad[0]);starts++;return 'queue-ack';}});
 const done=()=>{if(goodDone&&queueDone&&bad.every(id=>(failures.get(id)??0)>=2)){
  if(appendTask===undefined){appendStarted=performance.now();appendTask=appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'healthy append during backoff'}})+'\n').catch(error=>{controller.abort(error);});}
  if(sent===2)controller.abort('verified progress');
 }};
 const started=performance.now();let firstHealthyMs:number|undefined;
 const timeout=setTimeout(()=>controller.abort(Error('Fixture progress deadline exceeded')),45000);
 try{
  await cursors.initializeSchema();await intents.initializeSchema();
  await cursors.initializeFresh('good',(await captureMirrorCursorAnchor(file,0n,undefined,true)).anchor,'turn',1,'init');
  await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'healthy peer'}})+'\n');
  await StateAccessFacade.enqueue(bridge,queueJob({jobId:'queue-job',targetThreadId:bad[0]!,channelId:100n}));
  const config=createVerifiedLocalSessionMirrorProfile({stateDb:state,mirrorDb:bridge}).worker;
  const settled=await runBoundMirrorWorker(config,{async sendValidated(request){assert.equal(request.path,'channels/121/messages');sent++;if(sent===2)appendDeliveredMs=performance.now()-appendStarted;return 987n+BigInt(sent);}},e=>e instanceof Error?e.message:String(e),event=>{
   assert.equal(event.kind,'Targets');if(event.kind!=='Targets')return;
   for(const row of event.rows){const id=row.finished.target.thread;
    if(id==='good'&&row.finished.outcome.kind==='Completed'){goodDone=true;firstHealthyMs??=performance.now()-started;}
    else if(bad.includes(id)){
     assert.equal(row.finished.outcome.kind,'Failed');if(row.finished.outcome.kind==='Failed')assert.match(String(row.finished.outcome.error),/Legacy mirror cursor has no generation binding/);
     failures.set(id,(failures.get(id)??0)+1);if(row.report!==null)reports++;
     if(id===bad[0]&&queueTask===undefined)queueTask=queue.kickTarget(id).then(()=>{queueDone=true;done();},error=>{controller.abort(error);throw error;});
    }
   }
   done();
  },controller.signal,queue);
  await queueTask;assert.equal(controller.signal.reason,'verified progress');assert.ok(bad.every(id=>(failures.get(id)??0)>=2));
  assert.equal(starts,1);assert.equal(sent,2);assert.equal(reports,21);assert.equal(goodDone,true);
  assert.ok(settled.every(r=>r.outcome.kind==='Cancelled'||r.outcome.kind==='Completed'||r.outcome.kind==='Failed'));
  const job=(await StateAccessFacade.listFiltered(bridge,bad[0]!,null))[0]!;assert.equal(job.state,'Running');assert.equal(job.turnId,'queue-ack');
  const check=new DatabaseSync(bridge,{readOnly:true});try{
   assert.deepEqual(check.prepare("SELECT * FROM codex_session_mirror_offsets WHERE codex_thread_id!='good' ORDER BY codex_thread_id").all(),original);
   assert.deepEqual(check.prepare('SELECT thread_id FROM cdr_ts_mirror_cursor_anchors_v1').all().map(r=>r.thread_id),['good']);
   assert.equal(check.prepare('SELECT COUNT(*) n FROM cdr_ts_mirror_startup_intents_v1').get()!.n,0);
   assert.equal(check.prepare('SELECT COUNT(*) n FROM codex_delivery_receipts').get()!.n,2);
  }finally{check.close();}
  assert.equal(queue.locks.activeTargetCount,0);
  t.diagnostic(JSON.stringify({deferredTargets:21,minimumFailedPolls:Math.min(...failures.values()),diagnostics:reports,healthyDeliveryMs:Math.round(firstHealthyMs!),appendDuringBackoffMs:Math.round(appendDeliveredMs!),elapsedMs:Math.round(performance.now()-started),historyFilesForDeferred:'absent; rejected before opening'}));
 }finally{clearTimeout(timeout);controller.abort('cleanup');await Promise.allSettled([queueTask,appendTask]);await intents.close();await cursors.close();await closeOwnedWorkerPool();}
 assert.equal(ownedWorkerUsage().Background,0);
}))));
