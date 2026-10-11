import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {runBoundMirrorWorker,type BoundMirrorWorkerConfig} from '../../../src/runtime/session-mirror/bound-poll.ts';import {mirrorRunnerBusy} from '../../../src/runtime/session-mirror/runner.ts';import {MirrorEpochError} from '../../../src/runtime/session-mirror/epoch.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
async function fixture(run:(config:BoundMirrorWorkerConfig,cursor:NativeMirrorCursorStore)=>Promise<void>){await storeFixture(async bridge=>{
 const file=join(dirname(bridge),'rollout.jsonl'),state=join(dirname(bridge),'state.sqlite');await writeFile(file,'');let db=await openInitialized(bridge);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1)}finally{db.close()}
 db=new DatabaseSync(state);try{db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare('INSERT INTO threads(id,rollout_path,archived)VALUES(?,?,0)').run('thread',file)}finally{db.close()}
 const cursor=new NativeMirrorCursorStore(bridge);try{await cursor.initializeSchema();await cursor.initializeFresh('thread',(await captureMirrorCursorAnchor(file,0n)).anchor,'turn',1,'init');await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'runner'}})+'\n');
 await run({stateDatabasePath:state,bridgeDatabasePath:bridge,discovery:{threads:{maxRows:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},store:{maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000}},ready:{maxTargets:32,maxBytes:1048576},poll:{read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}}},cursor);
 }finally{await cursor.close()}
})}
test('concrete runner captures configuration, sends one native observed batch, reports and joins shutdown',async()=>fixture(async(config,cursor)=>{
 const controller=new AbortController();let calls=0,reports=0;const originalBridge=config.bridgeDatabasePath;
 const pending=runBoundMirrorWorker(config,{async sendValidated(request){calls++;assert.equal(request.path,'channels/42/messages');return 123n}},()=> 'bounded failure',event=>{assert.equal(event.kind,'Targets');if(event.kind==='Targets'){assert.equal(event.rows[0]!.finished.outcome.kind,'Completed');reports++;controller.abort('done')}},controller.signal);
 // Caller mutation after the invocation cannot change the in-flight paths/options.
 Object.assign(config,{bridgeDatabasePath:originalBridge+'.wrong'});Object.assign(config.poll.read,{maxRecords:0});
 try{await pending;assert.equal(calls,1);assert.equal(reports,1);assert.equal((await cursor.read('thread'))!.revision,2n);assert.equal(mirrorRunnerBusy(),false);assert.equal(ownedWorkerUsage().Background,0)}finally{controller.abort('cleanup');await pending.catch(()=>undefined)}
}));
test('report failure returns unreported completed evidence and does not recreate or resend',async()=>fixture(async(config,cursor)=>{
 let calls=0;const failure={report:true};await assert.rejects(runBoundMirrorWorker(config,{async sendValidated(){calls++;return 123n}},()=> 'bounded failure',()=>{throw failure},new AbortController().signal),e=>e instanceof MirrorEpochError&&e.cause===failure&&e.unreported.length===1&&e.unreported[0]!.finished.outcome.kind==='Completed');
 assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,2n);assert.equal(mirrorRunnerBusy(),false);
}));
test('preabort inspects no configuration and malformed data starts no worker',async()=>{
 let hooks=0;const config=new Proxy({},{get(){hooks++;throw Error('get')},getOwnPropertyDescriptor(){hooks++;throw Error('descriptor')}}) as BoundMirrorWorkerConfig,controller=new AbortController();controller.abort('pre');const transport={async sendValidated(){assert.fail('HTTP')}};
 assert.deepEqual(await runBoundMirrorWorker(config,transport,()=> '',()=>{},controller.signal),[]);
 await assert.rejects(runBoundMirrorWorker(config,transport,()=> '',()=>{},new AbortController().signal),TypeError);assert.equal(hooks,0);assert.equal(mirrorRunnerBusy(),false);assert.equal(ownedWorkerUsage().Background,0);
});
