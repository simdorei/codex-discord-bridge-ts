import {DatabaseSync} from 'node:sqlite';import {MirrorSnapshotOwner} from '../../../src/runtime/session-mirror/snapshot-owner.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile,readFile,rename} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {discoverMirrorStore,type MirrorStoreSnapshot} from '../../../src/runtime/session-mirror/store-discovery.ts';import {pollBoundMirrorTarget as poll,MirrorBoundCursorRequiredError,MirrorRolloutBindingError} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';import {MirrorBatchExecutionError} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';
const options={read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}},discovery={...options.ownership,maxTargets:32n,maxOutputBytes:1048576};
const event=(text:string)=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:text}})+'\n';
async function fixture(run:(path:string,file:string,cursor:NativeMirrorCursorStore,jobs:MirrorStoreSnapshot['jobs'])=>Promise<void>,initialize=true,turn='turn'){await storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1)}finally{db.close()}
 const cursor=new NativeMirrorCursorStore(path);try{await cursor.initializeSchema();if(initialize)await cursor.initializeFresh('thread',(await captureMirrorCursorAnchor(file,0n)).anchor,turn,1,'init');const jobs=(await discoverMirrorStore(path,discovery)).jobs;await run(path,file,cursor,jobs)}finally{await cursor.close()}
})}
test('bound poll reads cursor, native mode and rollout then commits one batch; repeat at EOF performs no send or write',async()=>fixture(async(path,file,cursor,jobs)=>{
 await appendFile(file,event('hello'));let calls=0;const transport={async sendValidated(){calls++;return 10n}};
 assert.deepEqual(await poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),{targets:1n,events:1n,sent:1n});const expected=await cursor.read('thread');assert.equal(expected!.revision,2n);assert.equal(calls,1);
 assert.deepEqual(await poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),{targets:0n,events:0n,sent:0n});assert.deepEqual(await cursor.read('thread'),expected);assert.equal(calls,1);assert.equal(ownedWorkerUsage().Background,0);assert.equal(activeMirrorFileReads(),0);
}));
test('one record budget commits complete prefix only and later poll continues without resending',async()=>fixture(async(path,file,cursor,jobs)=>{
 await appendFile(file,event('first')+event('second'));let calls=0;const transport={async sendValidated(){return BigInt(++calls)}},limited={...options,read:{...options.read,maxRecords:1}};
 assert.equal((await poll(path,{id:'thread',rolloutPath:file},42n,jobs,limited,transport)).events,1n);assert.equal((await cursor.read('thread'))!.anchor.offset,BigInt(Buffer.byteLength(event('first'))));
 assert.equal((await poll(path,{id:'thread',rolloutPath:file},42n,jobs,limited,transport)).sent,1n);assert.equal(calls,2);assert.equal((await cursor.read('thread'))!.anchor.offset,BigInt((await readFile(file)).length));
}));
test('incomplete suffix stays uncommitted until completed; unchanged prefix is not sent twice',async()=>fixture(async(path,file,cursor,jobs)=>{
 const partial=event('second').slice(0,-1);await appendFile(file,event('first')+partial);let calls=0;const transport={async sendValidated(){return BigInt(++calls)}};
 await poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport);const prefix=await cursor.read('thread');assert.equal(prefix!.anchor.offset,BigInt(Buffer.byteLength(event('first'))));
 assert.deepEqual(await poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),{targets:0n,events:0n,sent:0n});assert.deepEqual(await cursor.read('thread'),prefix);
 await appendFile(file,'\n');await poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport);assert.equal(calls,2);
}));
test('missing bound cursor refuses adoption even when discovery and rollout exist',async()=>fixture(async(path,file,cursor,jobs)=>{
 await appendFile(file,event('old'));let calls=0;await assert.rejects(poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,{async sendValidated(){calls++;return 1n}}),MirrorBoundCursorRequiredError);assert.equal(await cursor.read('thread'),null);assert.equal(calls,0);
},false));
test('different discovered rollout and replaced file hold without resetting cursor or HTTP',async()=>fixture(async(path,file,cursor,jobs)=>{
 let calls=0;const transport={async sendValidated(){calls++;return 1n}},before=await cursor.read('thread');
 await assert.rejects(poll(path,{id:'thread',rolloutPath:file+'-other'},42n,jobs,options,transport),MirrorRolloutBindingError);
 await assert.rejects(poll(path,{id:'thread',rolloutPath:file},42n,[...jobs],options,transport),TypeError);await rename(file,file+'.old');await writeFile(file,event('replacement'));await assert.rejects(poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),/changed/);assert.equal(calls,0);assert.deepEqual(await cursor.read('thread'),before);
}));
test('unknown HTTP remains held across independently observed polls and owned work always joins',async()=>fixture(async(path,file,cursor,jobs)=>{
 await appendFile(file,event('unknown'));let calls=0;const transport={async sendValidated():Promise<bigint>{calls++;throw new DiscordTransportFault('Transport','unknown')}};
 for(let n=0;n<2;n++)await assert.rejects(poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),e=>e instanceof MirrorBatchExecutionError&&e.packet!==null);
 assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,1n);assert.equal(ownedWorkerUsage().Background,0);assert.equal(activeMirrorFileReads(),0);
}));
test('preabort, getter/proxy and invalid channel fail before transport or cursor work',async()=>fixture(async(path,file,cursor,jobs)=>{
 let hooks=0,calls=0;const transport={async sendValidated(){calls++;return 1n}},controller=new AbortController(),reason=Error('pre');controller.abort(reason);
 await assert.rejects(poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport,controller.signal),e=>e===reason);
 await assert.rejects(poll(path,{get id(){hooks++;return 'thread'},rolloutPath:file},42n,jobs,options,transport),TypeError);
 await assert.rejects(poll(path,new Proxy({id:'thread',rolloutPath:file},{get(){hooks++;throw Error('trap')}}),42n,jobs,options,transport),TypeError);
 await assert.rejects(poll(path,{id:'thread',rolloutPath:file},0n,jobs,options,transport),RangeError);assert.equal(hooks,0);assert.equal(calls,0);assert.equal((await cursor.read('thread'))!.revision,1n);
}));

test('persisted All includes tool activity while absent mode consumes it without sending; empty turn is valid',async()=>{
 for(const mode of ['send','all'])await fixture(async(path,file,cursor,jobs)=>{
  const db=await openInitialized(path);try{db.prepare('INSERT INTO session_mirror_details VALUES(?,?)').run('thread',mode)}finally{db.close()}
  await appendFile(file,JSON.stringify({type:'response_item',payload:{type:'function_call',name:'tool'}})+'\n');let calls=0;
  const result=await poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,{async sendValidated(){calls++;return 1n}});assert.equal(calls,mode==='all'?1:0);assert.equal(result.events,1n);assert.equal((await cursor.read('thread'))!.revision,2n);
 },true,'');
});

test('actual native discovery and target owner drive bound polling through receipt and cursor commit',async()=>fixture(async(path,file,cursor,_jobs)=>{
 await appendFile(file,event('owned'));const state=join(dirname(path),'state.sqlite'),db=new DatabaseSync(state);try{db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare('INSERT INTO threads(id,rollout_path,archived)VALUES(?,?,0)').run('thread',file)}finally{db.close()}
 let calls=0;const owner=new MirrorSnapshotOwner(state,path,{threads:{maxRows:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},store:discovery},{maxTargets:32,maxBytes:1048576},(hint,channel,jobs,signal)=>poll(path,hint,channel,jobs,options,{async sendValidated(){calls++;return 1n}},signal),()=> 'poll failed');
 try{await owner.refresh();assert.equal(owner.dispatch(),1);await owner.waitForSettlement();const result=owner.harvest();assert.equal(result.length,1);assert.equal(result[0]!.finished.outcome.kind,'Completed');assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,2n)}finally{await owner.close()}
 assert.equal(owner.activeCount,0);assert.equal(ownedWorkerUsage().Background,0);
}));

test('invalid first record is an explicit held failure and never an idle success or cursor reset',async()=>fixture(async(path,file,cursor,jobs)=>{
 await appendFile(file,'not JSON\n');const before=await cursor.read('thread');let calls=0;
 await assert.rejects(poll(path,{id:'thread',rolloutPath:file},42n,jobs,options,{async sendValidated(){calls++;return 1n}}),e=>e instanceof Error&&e.name==='MirrorPollRecordHeldError'&&Object.getOwnPropertyDescriptor(e,'stop')?.value==='InvalidJson');assert.equal(calls,0);assert.deepEqual(await cursor.read('thread'),before);
}));
