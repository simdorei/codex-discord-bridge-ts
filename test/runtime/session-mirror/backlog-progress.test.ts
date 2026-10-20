import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile,readFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';import {discoverMirrorStore,type MirrorStoreSnapshot} from '../../../src/runtime/session-mirror/store-discovery.ts';import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';import {MirrorTargetExecution} from '../../../src/runtime/session-mirror/execution.ts';import {MirrorBatchExecutionError} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';
const limits={maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},options={read:{maxWindowBytes:262144,maxRecordBytes:32768,maxRecords:1024,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}};
async function fixture(n:number,run:(path:string,file:string,cursor:NativeMirrorCursorStore,jobs:MirrorStoreSnapshot['jobs'])=>Promise<void>){await storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1)}finally{db.close()}
 const cursor=new NativeMirrorCursorStore(path);try{await cursor.initializeSchema();await cursor.initializeFresh('thread',(await captureMirrorCursorAnchor(file,0n)).anchor,'turn',1,'init');await appendFile(file,Array.from({length:n},(_,i)=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'unique-'+i}})+'\n').join(''));await run(path,file,cursor,(await discoverMirrorStore(path,limits)).jobs)}finally{await cursor.close()}
})}
test('1000-item allowed window reaches a new HTTP item in each retry under unchanged 10-second owner deadline',async()=>fixture(1000,async(path,file,cursor,jobs)=>{
 const seen=new Set<string>();
 for(let attempt=1;attempt<=2;attempt++){
  const owner=new MirrorTargetExecution(),stop=new AbortController();let calls=0;
  try{owner.tryStart({thread:'thread',channel:42n},(_hint,signal)=>pollBoundMirrorTarget(path,{id:'thread',rolloutPath:file},42n,jobs,options,{async sendValidated(request){calls++;assert.equal(seen.has(request.body),false);seen.add(request.body);stop.abort('known accepted boundary');return BigInt(attempt)}},signal),stop.signal);
   await owner.waitForSettlement();const result=owner.takeSettled()[0]!.outcome;assert.equal(calls,1);assert.equal(result.kind,'Cancelled');assert.equal((await cursor.read('thread'))!.revision,1n);
  }finally{await owner.close()}
 }
 assert.equal(seen.size,2);
}));
test('repeated known-acceptance cancellation makes forward progress across cached prefixes and finally commits without duplicate HTTP',async()=>fixture(40,async(path,file,cursor,jobs)=>{
 const seen=new Set<string>();let completed=false;
 for(let attempt=0;attempt<6&&!completed;attempt++){
  const owner=new MirrorTargetExecution(),stop=new AbortController();let calls=0;
  try{owner.tryStart({thread:'thread',channel:42n},(_hint,signal)=>pollBoundMirrorTarget(path,{id:'thread',rolloutPath:file},42n,jobs,options,{async sendValidated(request){calls++;assert.equal(seen.has(request.body),false);seen.add(request.body);if(calls===10)stop.abort('known accepted boundary');return BigInt(seen.size)}},signal),stop.signal);
   await owner.waitForSettlement();const result=owner.takeSettled()[0]!.outcome;
   if(result.kind==='Completed'){completed=true;assert.equal(calls,0)}else{assert.equal(result.kind,'Cancelled');assert.equal(calls,10);const settled=Object.getOwnPropertyDescriptor(result,'settled')?.value;assert.ok(settled.error instanceof MirrorBatchExecutionError);assert.equal((await cursor.read('thread'))!.revision,1n)}
  }finally{await owner.close()}
 }
 assert.equal(completed,true);assert.equal(seen.size,40);assert.equal((await cursor.read('thread'))!.revision,2n);assert.equal((await cursor.read('thread'))!.anchor.offset,BigInt((await readFile(file)).length));
}));
