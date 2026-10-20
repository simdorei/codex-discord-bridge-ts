import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,appendFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {TargetLocks,MIRROR_SYNC_OPERATION_LOCK} from '../../../src/core/keyed-locks.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {withMirrorMappingLocks} from '../../../src/runtime/session-mirror/mapping-owner.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import type {DiscordReceiptTransport} from '../../../src/runtime/completion/receipt-sender.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const context={maxBytes:512,maxRecords:2,maxRecordBytes:512,maxWindowBytes:4096,maxTurnBytes:16384,timeoutMs:5000};
const options={read:{maxWindowBytes:4096,maxRecordBytes:512,maxRecords:4,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}};
function record(value:unknown){const json=JSON.stringify(value);return json+' '.repeat(255-Buffer.byteLength(json))+'\n';}
const event=(target:string,index:number)=>record({type:'event_msg',payload:{type:'agent_message',message:`${target}-${index}`}});

test('B commits its cursor and receipts while A has a 4 MiB backlog and a blocked HTTP send',{timeout:60000},async t=>storeFixture(async database=>{
 const targets=[{id:'A',channel:42n,rolloutPath:join(dirname(database),'A.jsonl')},{id:'B',channel:43n,rolloutPath:join(dirname(database),'B.jsonl')}];
 for(const target of targets)await writeFile(target.rolloutPath,record({type:'turn_context',payload:{turn_id:target.id+'-turn'}}));
 const db=await openInitialized(database);try{for(const target of targets)db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(target.id,'project','title',1n,target.channel,1);}finally{db.close();}
 const cursors=new NativeMirrorCursorStore(database,5000),intents=new NativeMirrorStartupIntentStore(database,5000),locks=new TargetLocks(),entered=deferred(),finish=deferred();
 let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;const sent:string[]=[];
 const transport:DiscordReceiptTransport={async sendValidated(request){
  if(request.path==='channels/42/messages'&&!sent.includes('A')){entered.resolve();await finish.promise;}
  const label=request.path==='channels/42/messages'?'A':'B';sent.push(label);return 9007199254740993n+BigInt(sent.length);
 }};
 try{
  await cursors.initializeSchema();await intents.initializeSchema();
  for(const target of targets){const bootstrap=new MirrorTargetBootstrapCoordinator({databasePath:database,thread:target.id,rolloutPath:target.rolloutPath,channel:target.channel,operationId:'bootstrap-'+target.id,createdAt:1.25,context,totalTimeoutMs:10000});try{await bootstrap.run(t.signal);}finally{await bootstrap.close();}}
  await appendFile(targets[0]!.rolloutPath,Array.from({length:16384},(_,i)=>event('A',i)).join(''));
  await appendFile(targets[1]!.rolloutPath,event('B',0));
  const snapshot=await discoverMirrorStore(database,{...options.ownership,maxTargets:2n,maxOutputBytes:1048576},t.signal);
  const poll=(index:number)=>{const target=targets[index]!;return withMirrorMappingLocks(locks,target.id,t.signal,()=>pollBoundMirrorTarget(database,target,target.channel,snapshot.jobs,options,transport,t.signal));};
  first=poll(0);await entered.promise;second=poll(1);
  assert.deepEqual(await second,{targets:1n,events:1n,sent:1n});assert.deepEqual(sent,['B']);
  assert.equal((await cursors.read('B'))?.anchor.offset,512n);assert.equal((await cursors.read('A'))?.anchor.offset,256n);
  assert.equal(locks.tryAcquire(MIRROR_SYNC_OPERATION_LOCK),undefined,'Mapping cannot redirect an in-flight delivery');
  finish.resolve();assert.deepEqual(await first,{targets:1n,events:4n,sent:4n});
  assert.equal((await cursors.read('A'))?.anchor.offset,1280n);assert.deepEqual(sent,['B','A','A','A','A']);
  const receiptDb=await openInitialized(database);try{assert.equal(receiptDb.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,5);}finally{receiptDb.close();}
 }finally{finish.resolve();await Promise.allSettled([first,second]);await cursors.close();await intents.close();}
 assert.equal(locks.activeTargetCount,0);assert.equal(activeMirrorFileReads(),0);
 assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
}));
