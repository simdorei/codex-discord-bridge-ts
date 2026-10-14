import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {MirrorTargetBootstrapCoordinator as Coordinator,MirrorBootstrapBindingError,MirrorBootstrapReconciliationRequiredError as Unconfirmed,type MirrorTargetBootstrapInput} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore as Store} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorStartupCutoff,MirrorStartupContextHeldError} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const PENDING='cdr_ts_mirror_startup_intents_v1',BOUND='cdr_ts_mirror_cursor_anchors_v1',LEGACY='codex_session_mirror_offsets';
const context={maxBytes:1048576,maxRecords:10000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000};
const line=(turn:string)=>JSON.stringify({type:'turn_context',payload:{turn_id:turn}})+'\n';
function input(path:string,file:string):MirrorTargetBootstrapInput{return {databasePath:path,thread:'thread',rolloutPath:file,channel:42n,operationId:'new',createdAt:7.25,context,totalTimeoutMs:10000};}
function sql(path:string,command:string):void{const db=new DatabaseSync(path);try{db.exec(command);}finally{db.close();}}
async function fixture(run:(q:MirrorTargetBootstrapInput,store:Store)=>Promise<void>,content=line('old'),prepare=true):Promise<void>{
 await storeFixture(async path=>{
  const file=join(dirname(path),'rollout.jsonl');await writeFile(file,content);
  const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);}finally{db.close();}
  const store=new Store(path),cursors=new NativeMirrorCursorStore(path);
  try{if(prepare){await cursors.initializeSchema();await store.initializeSchema();}await run(input(path,file),store);}
  finally{await store.close();await cursors.close();assert.equal(ownedWorkerUsage().Background,0);}
 });
}
function trace(action?:(request:Record<string,unknown>,result:unknown)=>Promise<void>){
 const seen:string[]=[],original=OwnedWorkerSlot.prototype.run;
 const patch=mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,value:unknown,timeout:number,signal?:AbortSignal){
  const q=value as Record<string,unknown>;seen.push(String(q.kind));const result=original.call(this,url,value,timeout,signal);
  return action===undefined?result:result.then(async r=>{await action(q,r);return r;});
 });return {seen,patch};
}
function fault(kind:string,options:object){
 const original=OwnedWorkerSlot.prototype.run,seen:string[]=[];
 const patch=mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,value:unknown,timeout:number,signal?:AbortSignal){
  const q=value as {kind:string};seen.push(q.kind);
  return original.call(this,q.kind===kind?new URL('./bootstrap-fault-worker.ts',import.meta.url):url,q.kind===kind?{...q,...options}:value,timeout,signal);
 });return {seen,patch};
}
async function reached(stage:Int32Array):Promise<void>{for(let n=0;n<500;n++){if(Atomics.load(stage,0)===1)return;await sleep(10);}throw Error('Fault worker never reached stage');}
async function run(q:MirrorTargetBootstrapInput){const owner=new Coordinator(q);try{return await owner.run();}finally{await owner.close();}}

test('fresh bootstrap captures once, retains before context, and initializes exact original N and turn',()=>fixture(async(q,store)=>{
 const observed=trace();try{
  const result=await run(q);assert.equal(result.kind,'Initialized');assert.equal(result.reconciled,false);assert.equal(result.cursor.anchor.offset,BigInt(Buffer.byteLength(line('old'))));assert.equal(result.cursor.turn,'old');assert.equal(result.cursor.operationId,'new');assert.equal(result.cursor.updatedAt,7.25);assert.equal(result.cursor.revision,1n);assert.equal(await store.read('thread'),null);
  assert.deepEqual(observed.seen,['ReadTarget','Capture','Retain','RecoverContext','CompleteContext','Read']);
 }finally{observed.patch.mock.restore();}
}));

test('append after retained EOF is not resampled and never changes reconstructed original context',()=>fixture(async(q)=>{
 const observed=trace(async request=>{if(request.kind==='Retain')await appendFile(q.rolloutPath,line('later'));});try{
  const result=await run(q);assert.equal(result.cursor.anchor.offset,BigInt(Buffer.byteLength(line('old'))));assert.equal(result.cursor.turn,'old');assert.equal(observed.seen.filter(k=>k==='Capture').length,1);
 }finally{observed.patch.mock.restore();}
}));

test('restart from pending uses its original operation, timestamp and cutoff with no capture',()=>fixture(async(q,store)=>{
 await store.retain(q.thread,await captureMirrorStartupCutoff(q.rolloutPath),1.5,'original');await appendFile(q.rolloutPath,line('after-restart'));
 const observed=trace();try{const result=await run(q);assert.equal(result.kind,'Resumed');assert.equal(result.cursor.operationId,'original');assert.equal(result.cursor.updatedAt,1.5);assert.equal(result.cursor.turn,'old');assert.equal(result.cursor.anchor.offset,BigInt(Buffer.byteLength(line('old'))));assert.deepEqual(observed.seen,['ReadTarget','RecoverContext','CompleteContext']);}finally{observed.patch.mock.restore();}
}));

test('existing exact bound is returned unchanged without recapture, rescan, writes or file presence',()=>fixture(async(q)=>{
 const first=await run(q);await rm(q.rolloutPath);const before=await readFile(q.databasePath),observed=trace();try{const result=await run({...q,operationId:'ignored',createdAt:99});assert.equal(result.kind,'Existing');assert.deepEqual(result.cursor,first.cursor);assert.deepEqual(observed.seen,['ReadTarget']);assert.deepEqual(await readFile(q.databasePath),before);}finally{observed.patch.mock.restore();}
}));

test('initial non-LF EOF is durable held intent and appended LF cannot upgrade its boundary',()=>fixture(async(q,store)=>{
 const observed=trace();try{
  await assert.rejects(run(q),e=>e instanceof MirrorStartupContextHeldError&&e.reason==='IncompleteBoundary');const first=await store.read(q.thread);assert.equal(first!.cutoff.anchor,null);await appendFile(q.rolloutPath,'\n');
  await assert.rejects(run(q),e=>e instanceof MirrorStartupContextHeldError&&e.reason==='IncompleteBoundary');assert.deepEqual(await store.read(q.thread),first);assert.equal(observed.seen.filter(k=>k==='Capture').length,1);assert.equal(observed.seen.filter(k=>k==='CompleteContext').length,0);
 }finally{observed.patch.mock.restore();}
},line('old').trimEnd()));

test('context budget failure preserves original pending cutoff for a bounded restart',()=>fixture(async(q,store)=>{
 await assert.rejects(run({...q,context:{...context,maxBytes:1}}),e=>e instanceof MirrorStartupContextHeldError&&e.reason==='ByteBudget');const pending=await store.read(q.thread);await appendFile(q.rolloutPath,line('later'));const result=await run(q);assert.equal(result.kind,'Resumed');assert.equal(result.cursor.anchor.offset,pending!.cutoff.offset);assert.equal(result.cursor.turn,'old');
}));

test('missing schema fails before file capture and reads never silently create either journal',()=>fixture(async(q)=>{
 const before=await readFile(q.databasePath),observed=trace();try{await assert.rejects(run(q),/schema|journal/i);assert.deepEqual(observed.seen,['ReadTarget']);assert.deepEqual(await readFile(q.databasePath),before);}finally{observed.patch.mock.restore();}
},line('old'),false));

test('exact target channel guard rejects missing, wrong and multiply mapped channels before capture',async()=>{
 for(const command of ["DELETE FROM mirror_threads","UPDATE mirror_threads SET discord_thread_id=43","INSERT INTO mirror_threads VALUES('foreign','project','title',1,42,1)"])await fixture(async q=>{
  sql(q.databasePath,command);const before=await readFile(q.databasePath),observed=trace();try{await assert.rejects(run(q),/mapping/);assert.deepEqual(observed.seen,['ReadTarget']);assert.deepEqual(await readFile(q.databasePath),before);}finally{observed.patch.mock.restore();}
 });
});

test('legacy, orphan, conflicting cursor, and pending plus either cursor hold before capture',async()=>{
 for(const variant of ['legacy','orphan','conflict','pending-legacy','pending-bound'])await fixture(async(q,store)=>{
  if(variant==='legacy'||variant==='pending-legacy'){if(variant==='pending-legacy')await store.retain(q.thread,await captureMirrorStartupCutoff(q.rolloutPath),1,'original');sql(q.databasePath,`INSERT INTO ${LEGACY} VALUES('thread','foreign',0,1,'')`);}
  else if(variant==='pending-bound'){
   await store.retain(q.thread,await captureMirrorStartupCutoff(q.rolloutPath),1,'original');const db=new DatabaseSync(q.databasePath);let packet:Record<string,unknown>;try{packet=db.prepare(`SELECT * FROM ${PENDING}`).get()!;}finally{db.close();}
   await run(q);const changed=new DatabaseSync(q.databasePath);try{changed.exec(`DELETE FROM ${LEGACY}`);changed.prepare(`INSERT INTO ${PENDING} VALUES(?,?,?,?)`).run(packet.thread_id as string,packet.cutoff_json as string,packet.operation_id as string,packet.created_at as number);}finally{changed.close();}
  }else{await run(q);sql(q.databasePath,variant==='orphan'?`DELETE FROM ${LEGACY}`:`UPDATE ${LEGACY} SET cursor=0`);}
  const before=await readFile(q.databasePath),observed=trace();try{await assert.rejects(run(q));assert.deepEqual(observed.seen,['ReadTarget']);assert.deepEqual(await readFile(q.databasePath),before);}finally{observed.patch.mock.restore();}
 });
});

test('captured rollout must match pending or bound path exactly',async()=>{
 for(const phase of ['pending','bound'])await fixture(async(q,store)=>{
  if(phase==='pending')await store.retain(q.thread,await captureMirrorStartupCutoff(q.rolloutPath),1,'original');else await run(q);
  const observed=trace();try{await assert.rejects(run({...q,rolloutPath:q.rolloutPath+'.foreign'}),MirrorBootstrapBindingError);assert.deepEqual(observed.seen,['ReadTarget']);}finally{observed.patch.mock.restore();}
 });
});

test('single-use owner rejects concurrent calls without a queue and captures mutable input once',()=>fixture(async(q)=>{
 const mutable={...q,context:{...q.context}},owner=new Coordinator(mutable);mutable.thread='foreign';mutable.rolloutPath+='foreign';mutable.databasePath+='foreign';mutable.channel=99n;mutable.operationId='foreign';mutable.createdAt=9;mutable.context.maxBytes=1;
 const first=owner.run();await assert.rejects(owner.run(),OwnedWorkerBusyError);const result=await first;assert.equal(result.cursor.thread,q.thread);assert.equal(result.cursor.anchor.path,q.rolloutPath);assert.equal(result.cursor.operationId,q.operationId);assert.equal(result.cursor.updatedAt,q.createdAt);await assert.rejects(owner.run(),/already used/);await owner.close();assert.equal(owner.busy,false);
}));

test('independent concurrent initializers cannot replace the winning original operation or acquire nested slots',()=>fixture(async(q,store)=>{
 const first=new Coordinator(q),second=new Coordinator({...q,operationId:'second'}),observed=trace();try{
  const results=await Promise.allSettled([first.run(),second.run()]),success=results.filter(r=>r.status==='fulfilled');assert.ok(success.length>=1);const final=await store.readTarget(q.thread,q.channel);assert.equal(final.kind,'Bound');if(final.kind!=='Bound')throw Error('Expected bound');
  for(const result of success)if(result.status==='fulfilled')assert.deepEqual(result.value.cursor,final.cursor);assert.ok(final.cursor.operationId==='new'||final.cursor.operationId==='second');assert.ok(observed.seen.filter(k=>k==='Retain').length<=2);assert.equal(await store.read(q.thread),null);
 }finally{await first.close();await second.close();observed.patch.mock.restore();}
}));

test('stale Absent initializer captures later but its losing retain CAS cannot replace the winner',()=>fixture(async(q,store)=>{
 let release!:()=>void,readDone!:()=>void,firstRead=true;
 const held=new Promise<void>(r=>{release=r;}),read=new Promise<void>(r=>{readDone=r;}),seen:{kind:string;operation?:string}[]=[],original=OwnedWorkerSlot.prototype.run;
 const patch=mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,value:unknown,timeout:number,signal?:AbortSignal){
  const request=value as {kind:string;intent?:{operationId:string}};seen.push({kind:request.kind,...(request.intent?{operation:request.intent.operationId}:{})});
  const hold=request.kind==='ReadTarget'&&firstRead;if(hold)firstRead=false;
  return original.call(this,url,value,timeout,signal).then(async result=>{
   if(hold){readDone();await held;}
   if(request.kind==='Retain'&&request.intent?.operationId===q.operationId)release();return result;
  });
 });
 const stale=new Coordinator({...q,operationId:'stale'}),winner=new Coordinator(q);
 try{
  const loser=assert.rejects(stale.run(),e=>e instanceof Unconfirmed&&e.operation==='Retain'&&e.pending.operationId==='stale');await read;const result=await winner.run();await loser;
  assert.equal(result.cursor.operationId,q.operationId);const actual=await store.readTarget(q.thread,q.channel);assert.equal(actual.kind,'Bound');if(actual.kind==='Bound')assert.deepEqual(actual.cursor,result.cursor);
  assert.equal(seen.filter(r=>r.kind==='Capture').length,2);assert.deepEqual(seen.filter(r=>r.kind==='Retain').map(r=>r.operation).sort(),['new','stale']);
 }finally{release();await stale.close();await winner.close();patch.mock.restore();}
}));

test('lost retain reply reconciles exact durable packet read-only and never reruns capture or retain',()=>fixture(async(q)=>{
 const observed=fault('Retain',{loseReply:true});try{const result=await run(q);assert.equal(result.kind,'Initialized');assert.equal(result.reconciled,true);assert.deepEqual(observed.seen,['ReadTarget','Capture','Retain','ReadTarget','RecoverContext','CompleteContext']);}finally{observed.patch.mock.restore();}
}));

test('uncertain retain with no durable packet exposes original cutoff and never blindly reruns a write',()=>fixture(async(q,store)=>{
 const observed=fault('Retain',{loseReply:true,beforeWrite:true});try{
  await assert.rejects(run(q),e=>e instanceof Unconfirmed&&e.operation==='Retain'&&e.pending.operationId==='new'&&e.pending.cutoff.offset===BigInt(Buffer.byteLength(line('old')))&&e.recovery===null);assert.deepEqual(observed.seen,['ReadTarget','Capture','Retain','ReadTarget']);assert.equal(await store.read(q.thread),null);
 }finally{observed.patch.mock.restore();}
}));

test('lost completion reply reconciles exact completed cursor without scanning or rerunning completion',()=>fixture(async q=>{
 const observed=fault('CompleteContext',{loseReply:true});try{const result=await run(q);assert.equal(result.reconciled,true);assert.equal(result.cursor.operationId,'new');assert.deepEqual(observed.seen,['ReadTarget','Capture','Retain','RecoverContext','CompleteContext','ReconcileContext']);}finally{observed.patch.mock.restore();}
}));

test('uncertain completion with original pending intact exposes recovery and never retries the write',()=>fixture(async(q,store)=>{
 const observed=fault('CompleteContext',{loseReply:true,beforeWrite:true});try{await assert.rejects(run(q),e=>e instanceof Unconfirmed&&e.operation==='CompleteContext'&&e.pending.operationId==='new'&&e.recovery?.context.currentTurn==='old');assert.equal(observed.seen.filter(k=>k==='CompleteContext').length,1);assert.equal(observed.seen.at(-1),'ReconcileContext');assert.equal((await store.read(q.thread))!.operationId,'new');}finally{observed.patch.mock.restore();}
}));

test('preabort and closed owner submit no workers; malformed accessors and proxies invoke no hooks',()=>fixture(async q=>{
 const controller=new AbortController(),reason=Error('preabort');controller.abort(reason);const observed=trace();let hooks=0;
 try{
  const owner=new Coordinator(q);await assert.rejects(owner.run(controller.signal),e=>e===reason);await owner.close();const closed=new Coordinator(q);await closed.close();await assert.rejects(closed.run(),/closed/);
  assert.throws(()=>new Coordinator({...q,get thread(){hooks++;return 'thread';}}),TypeError);assert.throws(()=>new Coordinator(new Proxy(q,{get(){hooks++;throw Error('trap');}})),TypeError);assert.equal(hooks,0);assert.deepEqual(observed.seen,[]);
 }finally{observed.patch.mock.restore();}
}));

test('cancellation after retain commit joins native exit and durable pending resumes without resampling',()=>fixture(async(q,store)=>{
 const stage=new Int32Array(new SharedArrayBuffer(4)),controller=new AbortController(),owner=new Coordinator(q),observed=fault('Retain',{stage:stage.buffer,delayMs:250});let settled=false;
 try{
  const failed=assert.rejects(owner.run(controller.signal),e=>e instanceof Unconfirmed&&e.operation==='Retain').then(()=>{settled=true;});await reached(stage);controller.abort(Error('cancel'));await sleep(20);assert.equal(settled,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Background,1);await failed;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Background,0);assert.equal(observed.seen.filter(k=>k==='Retain').length,1);
 }finally{await owner.close();observed.patch.mock.restore();}
 const pending=await store.read(q.thread);await appendFile(q.rolloutPath,line('later'));const result=await run(q);assert.equal(result.kind,'Resumed');assert.equal(result.cursor.anchor.offset,pending!.cutoff.offset);assert.equal(result.cursor.turn,'old');
}));

test('close after completion commit joins native exit and a fresh coordinator accepts the completed cursor',()=>fixture(async q=>{
 const stage=new Int32Array(new SharedArrayBuffer(4)),owner=new Coordinator(q),observed=fault('CompleteContext',{stage:stage.buffer,delayMs:250});
 try{const failed=assert.rejects(owner.run(),e=>e instanceof Unconfirmed&&e.operation==='CompleteContext');await reached(stage);await owner.close();await failed;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Background,0);}finally{observed.patch.mock.restore();await owner.close();}
 await rm(q.rolloutPath);assert.equal((await run(q)).kind,'Existing');
}));

test('one total deadline stops subsequent stages but does not abandon delayed native exit',()=>fixture(async q=>{
 const stage=new Int32Array(new SharedArrayBuffer(4)),observed=fault('Retain',{stage:stage.buffer,delayMs:1400});
 try{
  await assert.rejects(run({...q,totalTimeoutMs:1000}),e=>e instanceof Unconfirmed&&e.operation==='Retain');assert.equal(Atomics.load(stage,0),1);assert.equal(ownedWorkerUsage().Background,0);assert.deepEqual(observed.seen,['ReadTarget','Capture','Retain']);
 }finally{observed.patch.mock.restore();}
}));

test('a delayed main-loop timer cannot start another stage past the monotonic total deadline',()=>fixture(async q=>{
 let blocked=false;const observed=trace(async request=>{if(request.kind==='ReadTarget'){blocked=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);}});
 try{await assert.rejects(run({...q,totalTimeoutMs:500}),e=>e instanceof MirrorStartupContextHeldError&&e.reason==='Deadline');assert.equal(blocked,true);assert.deepEqual(observed.seen,['ReadTarget']);}finally{observed.patch.mock.restore();}
}));

test('native retain observes cancellation before opening its DB and leaves original intent unconfirmed',()=>fixture(async(q,store)=>{
 const original=OwnedWorkerSlot.prototype.run,seen:string[]=[];
 const patch=mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,value:unknown,timeout:number,signal?:AbortSignal){
  const request=value as {kind:string;cancel:SharedArrayBuffer};seen.push(request.kind);if(request.kind==='Retain')Atomics.store(new Int32Array(request.cancel),0,1);return original.call(this,url,value,timeout,signal);
 });
 try{await assert.rejects(run(q),e=>e instanceof Unconfirmed&&e.operation==='Retain');assert.deepEqual(seen,['ReadTarget','Capture','Retain','ReadTarget']);assert.equal(await store.read(q.thread),null);}finally{patch.mock.restore();}
}));

test('explicit reconciliation is same-owner, read-only, exact, and needs no rollout after completion',()=>fixture(async(q,store)=>{
 await store.retain(q.thread,await captureMirrorStartupCutoff(q.rolloutPath),1,'original');const observation=await store.recoverContext(q.thread,'original',context),before=await readFile(q.databasePath);
 assert.equal(await store.reconcileRecoveredContext(observation),null);assert.deepEqual(await readFile(q.databasePath),before);
 const other=new Store(q.databasePath);try{await assert.rejects(other.reconcileRecoveredContext(observation),TypeError);}finally{await other.close();}
 let traps=0;for(const forged of [{...observation},observation.captured(),new Proxy(observation,{get(){traps++;throw Error('trap');}})])await assert.rejects(store.reconcileRecoveredContext(forged as typeof observation),TypeError);assert.equal(traps,0);
 const completed=await store.completeRecoveredContext(observation);await rm(q.rolloutPath);const committed=await readFile(q.databasePath);assert.deepEqual(await store.reconcileRecoveredContext(observation),completed.cursor);assert.deepEqual(await readFile(q.databasePath),committed);
 sql(q.databasePath,`UPDATE ${BOUND} SET revision=2`);const changed=await readFile(q.databasePath);await assert.rejects(store.reconcileRecoveredContext(observation));assert.deepEqual(await readFile(q.databasePath),changed);
}));
