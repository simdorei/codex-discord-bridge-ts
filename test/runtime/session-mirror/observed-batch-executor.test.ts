import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {executeObservedMirrorBatch as execute,MirrorBatchExecutionError,MirrorBatchPolicyChangedError,type ObservedMirrorBatchRequest} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';
import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const discovery={maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},ownership={maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000};
async function fixture(run:(request:ObservedMirrorBatchRequest,cursor:NativeMirrorCursorStore,path:string)=>Promise<void>,prefix=''){await storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);db.close();
 const cursor=new NativeMirrorCursorStore(path);try{
  await cursor.initializeSchema();const anchor=(await capture(file,0n)).anchor,expected=await cursor.initializeFresh('thread',anchor,'turn',1,'init');await appendFile(file,prefix+['first','second'].map(message=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message}})+'\n').join(''));
  const observation=await observe(anchor,{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},{thread:'thread',detail:'All',currentTurn:'turn'}),snapshot=await discoverMirrorStore(path,discovery);
  await run({databasePath:path,expected,observation,channel:42n,updatedAt:2,operationId:'advance',pollJobs:snapshot.jobs,ownership},cursor,path);
 }finally{await cursor.close()}
})}
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql)}finally{db.close()}}
test('bounded executor chooses current durable skip and sends remaining item before one cursor commit',async()=>fixture(async(request,cursor,path)=>{
 const db=await openInitialized(path);try{db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(request.observation.batch.items[0]!.digest,'thread')}finally{db.close()}
 let calls=0;const result=await execute(request,{async sendValidated(){calls++;return 10n}});assert.equal(calls,1);assert.deepEqual(result.packet.deliveryModes,['Skip','Deliver']);assert.deepEqual(result.counts,{targets:1n,events:2n,sent:1n});assert.equal((await cursor.read('thread'))!.revision,2n);assert.equal(ownedWorkerUsage().Background,0);
}));
test('historical-only owner holds before any send or packet rather than assuming a durable skip',async()=>fixture(async(request,cursor,path)=>{
 await enqueue(path,queueJob({targetThreadId:'thread'}));await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");const snapshot=await discoverMirrorStore(path,discovery);await edit(path,'DELETE FROM codex_turn_queue');let calls=0;
 await assert.rejects(execute({...request,pollJobs:snapshot.jobs},{async sendValidated(){calls++;return 10n}}),e=>e instanceof MirrorBatchExecutionError&&e.cause instanceof MirrorBatchPolicyChangedError&&e.packet===null);assert.equal(calls,0);assert.equal((await cursor.read('thread'))!.revision,1n);
}));
test('ownership acquired after first send stops the second item while retaining first receipt',async()=>fixture(async(request,cursor,path)=>{
 let calls=0;await assert.rejects(execute(request,{async sendValidated(){calls++;await enqueue(path,queueJob({targetThreadId:'thread'}));await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");return 10n}}),e=>e instanceof MirrorBatchExecutionError&&e.cause instanceof MirrorBatchPolicyChangedError&&e.packet!==null);
 assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,1n);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1)}finally{db.close()}
}));
test('unknown send holds same receipt on explicit retry and never issues a duplicate HTTP call',async()=>fixture(async(request,cursor)=>{
 let calls=0;const transport={async sendValidated():Promise<bigint>{calls++;throw new DiscordTransportFault('Transport','unknown')}};
 for(let i=0;i<2;i++)await assert.rejects(execute(request,transport),e=>e instanceof MirrorBatchExecutionError&&e.packet!==null);
 assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,1n);assert.equal(ownedWorkerUsage().Background,0);
}));
test('cancellation waits for known late acceptance to be recorded and starts no second item',async()=>fixture(async(request,cursor,path)=>{
 let enter!:()=>void,finish!:(id:bigint)=>void,calls=0;const entered=new Promise<void>(r=>enter=r),controller=new AbortController(),reason=Error('stop');
 const pending=execute(request,{async sendValidated(){calls++;enter();return new Promise<bigint>(r=>finish=r)}},controller.signal);await entered;controller.abort(reason);finish(10n);await assert.rejects(pending,MirrorBatchExecutionError);
 assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,1n);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1)}finally{db.close()}assert.equal(ownedWorkerUsage().Background,0);
}));
test('pre-abort and wrong bound observation reject without transport or cursor mutation',async()=>fixture(async(request,cursor)=>{
 let calls=0;const transport={async sendValidated(){calls++;return 10n}},controller=new AbortController(),reason=Error('pre');controller.abort(reason);
 await assert.rejects(execute(request,transport,controller.signal),e=>e===reason);await assert.rejects(execute({...request,expected:{...request.expected,turn:'wrong'}},transport),TypeError);
 assert.equal(calls,0);assert.equal((await cursor.read('thread'))!.revision,1n);
}));

test('reported events count decoded objects rather than blank and non-object records',async()=>fixture(async(request,_cursor)=>{
 const result=await execute(request,{async sendValidated(){return 10n}});assert.equal(result.counts.events,3n);assert.equal(request.observation.batch.scannedRecords,6);
},'\nnull\n[]\n{}\n'));
