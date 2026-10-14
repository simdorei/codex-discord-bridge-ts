import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {appendFileSync} from 'node:fs';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer} from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {createSessionMirrorHttpTransport} from '../../../src/runtime/discord-runtime/session-mirror-http.ts';
import {startSessionMirrorRuntimeWorker} from '../../../src/runtime/discord-runtime/session-mirror-start.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {captureBoundMirrorWorkerConfig,runBoundMirrorWorker,type BoundMirrorWorkerConfig} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {MirrorBootstrapReconciliationRequiredError} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {MirrorBootstrapWorkerHeldError,mirrorBootstrapRequiresReconciliation} from '../../../src/runtime/session-mirror/bootstrap-hold.ts';
import {prepareMirrorBootstrapSchemas} from '../../../src/runtime/session-mirror/bootstrap-schema.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorStartupCutoff} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {MirrorEpochError} from '../../../src/runtime/session-mirror/epoch.ts';
import {mirrorRunnerBusy,type MirrorRunnerObservation} from '../../../src/runtime/session-mirror/runner.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';

const context={maxBytes:1048576,maxRecords:10000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000};
const event=(message:string)=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message}})+'\n';
const history=JSON.stringify({type:'turn_context',payload:{turn_id:'original-turn'}})+'\n'+event('historical message');
const noHttp={async sendValidated():Promise<bigint>{assert.fail('Unexpected HTTP');}};
const PENDING='cdr_ts_mirror_startup_intents_v1',BOUND='cdr_ts_mirror_cursor_anchors_v1';
function sql(path:string,text:string):void{const db=new DatabaseSync(path);try{db.exec(text);}finally{db.close();}}
async function fixture(run:(config:BoundMirrorWorkerConfig,file:string,cursor:NativeMirrorCursorStore,intents:NativeMirrorStartupIntentStore)=>Promise<void>,prepared=true){
 await storeFixture(async bridge=>{
  const file=join(dirname(bridge),'rollout.jsonl'),state=join(dirname(bridge),'state.sqlite');await writeFile(file,history);
  const db=await openInitialized(bridge);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);}finally{db.close();}
  const source=new DatabaseSync(state);try{
   source.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');
   source.prepare('INSERT INTO threads(id,rollout_path,archived)VALUES(?,?,0)').run('thread',file);
  }finally{source.close();}
  const cursor=new NativeMirrorCursorStore(bridge),intents=new NativeMirrorStartupIntentStore(bridge);
  try{
   if(prepared)await prepareMirrorBootstrapSchemas(bridge);
   await run({stateDatabasePath:state,bridgeDatabasePath:bridge,discovery:{threads:{maxRows:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},store:{maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000}},ready:{maxTargets:32,maxBytes:1048576},poll:{read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}},bootstrap:{kind:'SkipExistingHistory',context:{...context},totalTimeoutMs:10000}},file,cursor,intents);
  }finally{await intents.close();await cursor.close();assert.equal(mirrorRunnerBusy(),false);assert.equal(ownedWorkerUsage().Background,0);assert.equal(activeMirrorFileReads(),0);}
 });
}
function trace(fault?:{kind:string;options:object}){
 const original=OwnedWorkerSlot.prototype.run,seen:string[]=[],requests:Record<string,unknown>[]=[];
 const patch=mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,value:unknown,timeout:number,signal?:AbortSignal){
  const q=value as {kind?:string};requests.push(q);seen.push(q.kind??url.pathname.split('/').at(-1)!);const inject=fault!==undefined&&q.kind===fault.kind;
  return original.call(this,inject?new URL('./bootstrap-fault-worker.ts',import.meta.url):url,inject?{...q,...fault!.options}:value,timeout,signal);
 });return {seen,requests,patch};
}
async function reached(stage:Int32Array):Promise<void>{for(let i=0;i<500;i++){if(Atomics.load(stage,0)===1)return;await sleep(10);}throw Error('Native fault stage not reached');}
async function once(config:BoundMirrorWorkerConfig,report:(event:MirrorRunnerObservation)=>void=()=>{},transport=noHttp){
 const stop=new AbortController(),timer=setTimeout(()=>stop.abort(Error('Test deadline')),15000);
 try{return await runBoundMirrorWorker(config,transport,String,event=>{report(event);stop.abort('one observed pass');},stop.signal);}
 finally{clearTimeout(timer);stop.abort('cleanup');}
}

test('monitored opt-in worker skips historical HTTP, sends the first append once, and reuses the bound cursor on later ticks',{timeout:25000},()=>fixture(async(config,file,cursor,intents)=>{
 const seen:{path:string;body:string;authorization:string|undefined}[]=[],rows:MirrorRunnerObservation[]=[];
 const server=createServer((req,res)=>{let body='';req.on('data',part=>body+=String(part));req.on('end',()=>{
  seen.push({path:req.url!,body,authorization:req.headers.authorization});res.end(JSON.stringify({attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:'42',content:'In progress\n\nfirst append',embeds:[],id:'123',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));
 });});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();assert.ok(address&&typeof address!=='string');
 const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}}),stop=new AbortController(),notifier=new RuntimeWorkerExitChannel(),receiver=notifier.receiver();
 const observed=trace(),timer=setTimeout(()=>stop.abort(Error('Test deadline')),15000);let passes=0;
 const worker=startSessionMirrorRuntimeWorker(true,config,createSessionMirrorHttpTransport(client,stop.signal),stop.signal,notifier,String,event=>{
  assert.equal(event.kind,'Targets');if(event.kind!=='Targets')return;rows.push(event);const outcome=event.rows[0]!.finished.outcome;assert.equal(outcome.kind,'Completed');if(outcome.kind!=='Completed')return;
  passes++;
  if(passes===1){assert.deepEqual(outcome.progress,{targets:0n,events:0n,sent:0n});assert.equal(seen.length,0);appendFileSync(file,eventText);}
  else if(passes===2)assert.deepEqual(outcome.progress,{targets:1n,events:1n,sent:1n});
  else{assert.deepEqual(outcome.progress,{targets:0n,events:0n,sent:0n});stop.abort('verified idle after send');}
 })!,eventText=event('first append');notifier.close();
 // Capture happens before the monitored task can observe caller mutation.
 Object.assign(config.bootstrap!.context,{maxBytes:1});Object.assign(config.bootstrap!,{totalTimeoutMs:1});
 try{
  assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(passes,3);assert.equal(await receiver.receive(),'session-mirror');assert.equal(await receiver.receive(),null);
  assert.equal(seen.length,1);assert.equal(seen[0]!.authorization,undefined);assert.equal(seen[0]!.path,'/api/v10/channels/42/messages');
  const body=JSON.parse(seen[0]!.body);assert.equal(body.content,'In progress\n\nfirst append');assert.equal(body.enforce_nonce,true);assert.deepEqual(body.allowed_mentions,{parse:[]});
  const saved=await cursor.read('thread');assert.equal(saved!.revision,2n);assert.equal(saved!.turn,'original-turn');assert.equal(saved!.anchor.offset,BigInt(Buffer.byteLength(history+eventText)));assert.equal(await intents.read('thread'),null);
  assert.equal(observed.seen.filter(k=>k==='Capture').length,1);assert.equal(observed.seen.filter(k=>k==='RecoverContext').length,1);assert.equal(observed.seen.filter(k=>k==='ReadTarget').length,3);assert.equal(observed.seen.includes('Schema'),false);
  const db=new DatabaseSync(config.bridgeDatabasePath);try{const receipts=db.prepare('SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts').all();assert.equal(receipts.length,1);assert.equal(receipts[0]!.message_id,'123');assert.equal(receipts[0]!.retryable,0);assert.equal(receipts[0]!.blocked_reason,null);}finally{db.close();}
  assert.equal(client.activeRequests,0);
 }finally{clearTimeout(timer);stop.abort('cleanup');worker.abort();await worker.join();observed.patch.mock.restore();receiver.dispose();await client.close();assert.equal(client.ownedSockets,0);server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}));

test('worker resumes the original pending operation and cutoff before its existing bound poll',()=>fixture(async(config,file,cursor,intents)=>{
 await intents.retain('thread',await captureMirrorStartupCutoff(file),1.25,'original');await appendFile(file,event('after pending cutoff'));
 const observed=trace();let sends=0;
 try{
  await once(config,event=>{assert.equal(event.kind,'Targets');if(event.kind==='Targets')assert.deepEqual(event.rows[0]!.finished.outcome,{kind:'Completed',progress:{targets:1n,events:1n,sent:1n}});},{async sendValidated(){sends++;return 123n;}});
  assert.equal(sends,1);assert.equal(observed.seen.includes('Capture'),false);assert.equal(observed.seen.includes('Retain'),false);assert.equal(observed.seen.filter(k=>k==='RecoverContext').length,1);assert.equal(await intents.read('thread'),null);assert.equal((await cursor.read('thread'))!.revision,2n);
  const completion=observed.requests.find(q=>q.kind==='CompleteContext')!.evidence as {pending:{operationId:string;createdAt:number;cutoff:{offset:bigint}}};assert.equal(completion.pending.operationId,'original');assert.equal(completion.pending.createdAt,1.25);assert.equal(completion.pending.cutoff.offset,BigInt(Buffer.byteLength(history)));
 }finally{observed.patch.mock.restore();}
}));

for(const variant of ['missing','incompatible','legacy'] as const)test(`worker holds ${variant} schema or cursor state without capture, DDL, or HTTP`,()=>fixture(async(config,_file,cursor)=>{
 if(variant==='incompatible')sql(config.bridgeDatabasePath,`ALTER TABLE ${PENDING} ADD COLUMN unexpected TEXT`);
 if(variant==='legacy')sql(config.bridgeDatabasePath,"INSERT INTO codex_session_mirror_offsets VALUES('thread','old',0,1,'')");
 const before=await readFile(config.bridgeDatabasePath),observed=trace();let reported=false;
 try{await once(config,event=>{assert.equal(event.kind,'Targets');if(event.kind==='Targets'){assert.equal(event.rows[0]!.finished.outcome.kind,'Failed');reported=true;}});assert.equal(reported,true);assert.deepEqual(await readFile(config.bridgeDatabasePath),before);assert.equal(observed.seen.filter(k=>k==='ReadTarget').length,1);assert.equal(observed.seen.includes('Capture'),false);assert.equal(observed.seen.includes('Schema'),false);}
 finally{observed.patch.mock.restore();}
},variant!=='missing'));

test('absent policy remains bound-only and cannot bootstrap fresh history',()=>fixture(async(config)=>{
 const {bootstrap:_ignored,...boundOnly}=config,observed=trace();let failed=false;
 try{await once(boundOnly,event=>{if(event.kind==='Targets'){const outcome=event.rows[0]!.finished.outcome;failed=outcome.kind==='Failed'&&String(outcome.error).includes('explicitly initialized');}});assert.equal(failed,true);assert.equal(observed.seen.includes('ReadTarget'),false);assert.equal(observed.seen.includes('Capture'),false);}
 finally{observed.patch.mock.restore();}
}));

test('schema preparation is explicit, sequential, abort-aware, and does not capture a target',()=>fixture(async(config)=>{
 const observed=trace();try{await prepareMirrorBootstrapSchemas(config.bridgeDatabasePath);assert.deepEqual(observed.seen,['Schema','Schema']);const before=await readFile(config.bridgeDatabasePath),stop=new AbortController();stop.abort('preabort');await assert.rejects(prepareMirrorBootstrapSchemas(config.bridgeDatabasePath,5000,stop.signal),e=>e==='preabort');assert.deepEqual(observed.seen,['Schema','Schema']);assert.deepEqual(await readFile(config.bridgeDatabasePath),before);}finally{observed.patch.mock.restore();}
},false));

test('bootstrap policy capture rejects active or malformed data without invoking hooks',()=>fixture(async(config)=>{
 let hooks=0;assert.throws(()=>captureBoundMirrorWorkerConfig({...config,get bootstrap(){hooks++;return config.bootstrap!;}}),TypeError);
 assert.throws(()=>captureBoundMirrorWorkerConfig({...config,bootstrap:new Proxy(config.bootstrap!,{get(){hooks++;throw Error('trap');}})}),TypeError);
 assert.throws(()=>captureBoundMirrorWorkerConfig({...config,bootstrap:{...config.bootstrap!,totalTimeoutMs:0}}),RangeError);assert.equal(hooks,0);
}));

for(const kind of ['Retain','CompleteContext'] as const)for(const mode of ['report','report-failure','abort-report-failure','render-failure'] as const)test(`uncertain ${kind} stops worker retries and retains the original packet through ${mode}`,()=>fixture(async(config,_file,_cursor,intents)=>{
 const observed=trace({kind,options:{loseReply:true,beforeWrite:true}}),reporting={failure:mode};let reports=0,original:unknown;
 const stop=new AbortController(),timer=setTimeout(()=>stop.abort('test deadline'),15000);
 try{
  await assert.rejects(runBoundMirrorWorker(config,noHttp,()=>{if(mode==='render-failure')throw reporting;return 'unknown retain';},event=>{
   reports++;assert.equal(event.kind,'Targets');if(event.kind==='Targets'){const outcome=event.rows[0]!.finished.outcome;assert.equal(outcome.kind,'Failed');if(outcome.kind==='Failed'){original=outcome.error;assert.ok(Object.isFrozen(original));assert.throws(()=>Object.assign(original as object,{pending:null}),TypeError);}}
   if(mode==='report-failure')throw reporting;
   if(mode==='abort-report-failure'){stop.abort(reporting);throw reporting;}
  },stop.signal),error=>{
   assert.ok(error instanceof MirrorEpochError);
   const finished=mode==='report'?((error.cause as MirrorBootstrapWorkerHeldError).finished):mode==='render-failure'?error.settled:error.unreported.map(row=>row.finished);
   if(mode==='report')assert.ok(error.cause instanceof MirrorBootstrapWorkerHeldError);else assert.equal(error.cause,reporting);
   assert.equal(finished.length,1);assert.equal(mirrorBootstrapRequiresReconciliation(finished[0]!),true);const outcome=finished[0]!.outcome;assert.equal(outcome.kind,'Failed');if(outcome.kind!=='Failed')return false;
   const held=outcome.error;assert.ok(held instanceof MirrorBootstrapReconciliationRequiredError);if(original!==undefined)assert.equal(held,original);assert.equal(held.operation,kind);assert.equal(held.pending.cutoff.offset,BigInt(Buffer.byteLength(history)));assert.equal(held.databasePath,config.bridgeDatabasePath);if(kind==='Retain')assert.equal(held.recovery,null);else assert.equal(held.recovery!.context.currentTurn,'original-turn');return true;
  });
  assert.equal(reports,mode==='render-failure'?0:1);assert.equal(observed.seen.filter(k=>k==='Capture').length,1);assert.equal(observed.seen.filter(k=>k==='Retain').length,1);if(kind==='Retain')assert.equal(await intents.read('thread'),null);else{assert.equal((await intents.read('thread'))!.cutoff.offset,BigInt(Buffer.byteLength(history)));assert.equal(observed.seen.filter(k=>k==='CompleteContext').length,1);}
 }finally{clearTimeout(timer);stop.abort('cleanup');observed.patch.mock.restore();}
}));

test('shared discovery failure joins an uncertain startup write and never starts another epoch',{timeout:15000},()=>fixture(async(config)=>{
 const stage=new Int32Array(new SharedArrayBuffer(4)),observed=trace({kind:'Retain',options:{stage:stage.buffer,delayMs:2000}}),stop=new AbortController(),timer=setTimeout(()=>stop.abort('test deadline'),12000);let reports=0;
 const running=runBoundMirrorWorker(config,noHttp,String,()=>{reports++;},stop.signal);
 const failed=assert.rejects(running,error=>{assert.ok(error instanceof MirrorEpochError);assert.match(String(error.cause),/threads/);assert.equal(error.settled.length,1);assert.equal(mirrorBootstrapRequiresReconciliation(error.settled[0]!),true);return true;});
 try{await reached(stage);sql(config.stateDatabasePath,'DROP TABLE threads');await failed;assert.equal(reports,0);assert.equal(observed.seen.filter(k=>k==='Capture').length,1);assert.equal(observed.seen.filter(k=>k==='Retain').length,1);}
 finally{clearTimeout(timer);stop.abort('cleanup');await running.catch(()=>undefined);observed.patch.mock.restore();}
}));

test('forced monitored shutdown joins startup completion, preserves uncertainty, and holds global runner admission',{timeout:15000},()=>fixture(async(config,_file,cursor)=>{
 const stage=new Int32Array(new SharedArrayBuffer(4)),observed=trace({kind:'CompleteContext',options:{stage:stage.buffer,delayMs:300}}),stop=new AbortController(),notifier=new RuntimeWorkerExitChannel();let reports=0;
 const worker=startSessionMirrorRuntimeWorker(true,config,noHttp,stop.signal,notifier,String,()=>{reports++;throw Error('No report may replace the retained shutdown error');})!;notifier.close();
 try{
  await reached(stage);worker.abort();await sleep(20);assert.equal(worker.peek(),undefined);assert.equal(mirrorRunnerBusy(),true);assert.equal(ownedWorkerUsage().Background,1);
  await assert.rejects(runBoundMirrorWorker(config,noHttp,String,()=>{},new AbortController().signal),/already running/);
  const result=await worker.join();assert.equal(result.kind,'Returned');if(result.kind!=='Returned'||result.result.ok)assert.fail('Expected retained startup failure');
  const error=result.result.error;assert.ok(error instanceof MirrorBootstrapWorkerHeldError);assert.equal(error.finished.length,1);const outcome=error.finished[0]!.outcome;assert.equal(outcome.kind,'Cancelled');assert.equal(mirrorBootstrapRequiresReconciliation(error.finished[0]!),true);
  if(outcome.kind!=='Cancelled'||outcome.settled.kind!=='Failed')assert.fail('Expected joined cancelled failure');const held=outcome.settled.error;assert.ok(held instanceof MirrorBootstrapReconciliationRequiredError);assert.equal(held.operation,'CompleteContext');assert.equal(held.recovery!.context.currentTurn,'original-turn');assert.equal(held.pending.cutoff.offset,BigInt(Buffer.byteLength(history)));
  assert.equal(reports,0);assert.equal((await cursor.read('thread'))!.revision,1n);assert.equal(observed.seen.filter(k=>k==='CompleteContext').length,1);assert.equal(mirrorRunnerBusy(),false);
 }finally{stop.abort('cleanup');worker.abort();await worker.join();observed.patch.mock.restore();}
}));
