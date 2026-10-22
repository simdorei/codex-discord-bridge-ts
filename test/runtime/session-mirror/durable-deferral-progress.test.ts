import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile,appendFile,readFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {legacyDeferralFixture} from '../../helpers/legacy-deferral-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {adminDatabase} from '../../../src/cli/admin.ts';
import {legacyMirrorRows} from '../../../src/cli/legacy-mirror-inspection.ts';
import {StateAccessFacade} from '../../../src/store/state-access-facade.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {runBoundMirrorWorker} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {createVerifiedLocalSessionMirrorProfile} from '../../../src/runtime/discord-runtime/local-session-mirror-profile.ts';
import {OwnedWorkerSlot,ownedWorkerUsage,withOwnedWorkerBackpressure,withOwnedWorkerReuse,closeOwnedWorkerPool} from '../../../src/runtime/owned-worker-slot.ts';
import {runOwnedCommand} from '../../../src/runtime/windows/owned-command.ts';
import {fileURLToPath} from 'node:url';

if(process.env.CDR_TEST_DEFERRAL_CHILD!=='1')test('four compressed bound mirrors retain zero history IO with a verified native-worker trap',{timeout:60000},async t=>{
 const environment:Record<string,string>={CDR_TEST_DEFERRAL_CHILD:'1',NODE_OPTIONS:'--no-strip-types'};
 for(const key of ['SystemRoot','TEMP','TMP','PATH','USERPROFILE','LOCALAPPDATA','PSModulePath'])if(process.env[key]!==undefined)environment[key]=process.env[key]!;
 const result=await runOwnedCommand({executable:process.execPath,inheritEnvironment:false,arguments:['--no-strip-types','--import',new URL('../../helpers/deferral-io-trap.mjs',import.meta.url).href,'--test',fileURLToPath(import.meta.url)],environment},{timeoutMs:55000,maxBytes:262144});
 assert.equal(result.exitCode,0,result.stdout.toString()+result.stderr.toString());assert.match(result.stdout.toString(),/"positiveControlBlocked":true/);t.diagnostic(result.stdout.toString().trim());
});
else test('four compressed bound mirrors, conflict and unbound targets stay blocked across materialization and worker restart while healthy mirror and queue progress',{timeout:50000},t=>legacyDeferralFixture(async f=>{
 const migration=await adminDatabase({path:f.path,statePath:f.statePath,policy:'rust-preserve'},undefined,true);assert.deepEqual(migration.held,[]);
 const originalRows=legacyMirrorRows(f.db),originalAnchors=f.db.prepare("SELECT * FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id!='good' ORDER BY thread_id").all(),holds=f.db.prepare('SELECT * FROM cdr_ts_mirror_deferrals_v1 ORDER BY thread_id').all();
 const log=join(dirname(f.path),'history-io.log');await writeFile(log,'');const oldLog=process.env.CDR_TEST_DEFERRAL_IO_LOG;
 process.env.CDR_TEST_DEFERRAL_IO_LOG=log;
 const held=[...f.bound,'drift','unbound','boundary'];let totalSent=0,starts=0;
 try{
  const probe=new OwnedWorkerSlot('Control');let probeResult;
  try{probeResult=await probe.run(new URL('../../helpers/deferral-io-probe.mjs',import.meta.url),{path:f.files.drift},5000);}finally{await probe.join();}
  assert.deepEqual(probeResult,{blocked:true});assert.match(await readFile(log,'utf8'),/promises.open/);await writeFile(log,'');
  for(let epoch=0;epoch<2;epoch++){
   if(epoch===1)for(const id of [...f.bound,'unbound'])await writeFile(f.files[id]!,f.body+'{}\n');
   await withOwnedWorkerBackpressure(()=>withOwnedWorkerReuse(async()=>{
    const controller=new AbortController(),failures=new Map<string,number>();let queueDone=false,queueTask:Promise<void>|undefined,appendTask:Promise<void>|undefined,epochSent=0,reports=0;
    const queue=new QueueStartCoordinator(f.path,{generation:()=>1n,residentInstanceId:()=> 'deferral-'+epoch,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async claim=>{assert.equal(claim.targetThreadId,epoch===0?'bound0':'bound1');starts++;return 'queue-'+epoch;}});
    const intents=new NativeMirrorStartupIntentStore(f.path),cursors=new NativeMirrorCursorStore(f.path);
    const done=()=>{if(queueDone&&epochSent>=1&&held.every(id=>(failures.get(id)??0)>=2)){
     if(appendTask===undefined)appendTask=appendFile(f.files.good!,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'healthy append '+epoch}})+'\n').catch(e=>controller.abort(e));
     if(epochSent===2)controller.abort('done');
    }};
    const timeout=setTimeout(()=>controller.abort(new Error('Progress deadline')),20000);
    try{
     await intents.initializeSchema();
     for(const id of [...f.bound,'drift','unbound']){
      await assert.rejects(cursors.read(id),/durably deferred/);
      await assert.rejects(intents.recoverContext(id,'unrelated-operation',{maxBytes:1048576,maxRecords:4096,maxRecordBytes:65536,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000}),/durably deferred/);
     }
     const target=epoch===0?'bound0':'bound1';await StateAccessFacade.enqueue(f.path,queueJob({jobId:'queue-'+epoch,targetThreadId:target,channelId:BigInt(100+epoch)}));
     await appendFile(f.files.good!,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'healthy initial '+epoch}})+'\n');
     const config=createVerifiedLocalSessionMirrorProfile({stateDb:f.statePath,mirrorDb:f.path}).worker;
     await runBoundMirrorWorker(config,{async sendValidated(request){assert.equal(request.path,'channels/107/messages');totalSent++;epochSent++;return 1000n+BigInt(totalSent);}},e=>String(e),event=>{
      if(event.kind!=='Targets')return;
      for(const row of event.rows){const id=row.finished.target.thread;if(!held.includes(id))continue;
       assert.equal(row.finished.outcome.kind,'Failed');if(row.finished.outcome.kind==='Failed')assert.match(String(row.finished.outcome.error),id==='boundary'?/no generation binding/:/durably deferred/);
       failures.set(id,(failures.get(id)??0)+1);if(row.report!==null)reports++;
       if(id===target&&queueTask===undefined)queueTask=queue.kickTarget(id).then(()=>{queueDone=true;done();},error=>{controller.abort(error);throw error;});
      }done();
     },controller.signal,queue);
     await queueTask;await appendTask;assert.equal(controller.signal.reason,'done');assert.equal(epochSent,2);assert.equal(reports,7);assert.equal(queue.locks.activeTargetCount,0);
    }finally{clearTimeout(timeout);controller.abort();await Promise.allSettled([queueTask,appendTask]);await intents.close();await cursors.close();await closeOwnedWorkerPool();}
   }));
  }
  assert.equal(starts,2);assert.equal(totalSent,4);assert.equal(await readFile(log,'utf8'),'');
  assert.deepEqual(legacyMirrorRows(f.db).filter(r=>r.codex_thread_id!=='good'),originalRows.filter(r=>r.codex_thread_id!=='good'));
  assert.deepEqual(f.db.prepare("SELECT * FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id!='good' ORDER BY thread_id").all(),originalAnchors);
  assert.deepEqual(f.db.prepare('SELECT * FROM cdr_ts_mirror_deferrals_v1 ORDER BY thread_id').all(),holds);assert.equal(ownedWorkerUsage().Background,0);
  t.diagnostic(JSON.stringify({positiveControlBlocked:true,heldHistoryOpenAttempts:0,epochs:2,healthyMessages:totalSent,queuedStarts:starts}));
 }finally{if(oldLog===undefined)delete process.env.CDR_TEST_DEFERRAL_IO_LOG;else process.env.CDR_TEST_DEFERRAL_IO_LOG=oldLog;}
}));
