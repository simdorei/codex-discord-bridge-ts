import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {StoreIntegrityError,UnsupportedVersionError} from '../../src/store/schema-assembly.ts';
import {InvalidQueueStateError,StoreJsonError} from '../../src/store/queue-read.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {captureNativeStoreReadDiagnostic,captureNativeStoreReadFailure,projectNativeStoreReadDiagnostic,NativeStoreReadError,NATIVE_STORE_READ_DIAGNOSTIC_BYTES} from '../../src/runtime/native-store-read-diagnostic.ts';
import {NativeControlEvidenceReader,NativeControlEvidenceUnavailable,joinedControlEvidenceStoreCause} from '../../src/runtime/action-executor/control-evidence-native.ts';
import {createNativeQueueReadState,NativeQueueReadUnavailableError,joinedQueueReadStoreCause} from '../../src/runtime/queue-runner/native-read-state.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError,joinedPromptIntakeStoreCause} from '../../src/runtime/prompt-intake/native-state.ts';
import {capturePromptAuthorityReads,createNativePromptAuthorityReads} from '../../src/runtime/server-prompt-authority-reads.ts';
import {verifyPromptAuthority,PromptAuthorityError} from '../../src/runtime/server-prompt-authority.ts';
import {prepareOneServerPrompt} from '../../src/runtime/server-prompt-redisplay.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {pendingServerRequestEqual} from '../../src/app-server/server-request-state.ts';
import {startRuntimeResident} from '../../src/runtime/discord-runtime/resident-startup.ts';
import {OwnedWorkerBudgetError,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../src/core/serde-byte-count.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

const secret='DO_NOT_TRANSPORT_ROW_OR_SQL_OR_PATH';
const sqlite=(errcode?:number)=>Object.assign(new Error(secret),{code:'ERR_SQLITE_ERROR',...(errcode===undefined?{}:{errcode}),errstr:secret});
async function rejected(p:Promise<unknown>):Promise<unknown>{try{await p;}catch(error){return error;}assert.fail('Expected rejection');}
function storeKind(error:unknown,kind:string):boolean{return error instanceof NativeStoreReadError&&error.diagnostic.kind===kind&&!(error instanceof PromptAuthorityError)&&!error.message.includes(secret);}
function idle(){assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});}

test('passive projection keeps known classifications and never reads sensitive diagnostic fields',()=>{
 const integrity=new StoreIntegrityError(secret),invalid=new InvalidQueueStateError(secret),json=new StoreJsonError(),db=sqlite(5);
 for(const value of [integrity,invalid,json,db])for(const key of ['message','stack','result','errstr','cause'])Object.defineProperty(value,key,{get(){assert.fail(`sensitive field ${key}`);},configurable:true});
 assert.deepEqual(projectNativeStoreReadDiagnostic(integrity),{kind:'Integrity'});
 assert.deepEqual(projectNativeStoreReadDiagnostic(invalid),{kind:'InvalidQueueState'});
 assert.deepEqual(projectNativeStoreReadDiagnostic(json),{kind:'Json'});
 assert.equal(projectNativeStoreReadDiagnostic(new SyntaxError(secret)),null,'only the store source category enters this diagnostic');
 assert.equal(projectNativeStoreReadDiagnostic(new RangeError(secret)),null);
 assert.deepEqual(projectNativeStoreReadDiagnostic(db),{kind:'Database',errcode:5});
 assert.deepEqual(projectNativeStoreReadDiagnostic(sqlite()),{kind:'Database',errcode:null});
 assert.deepEqual(projectNativeStoreReadDiagnostic(new UnsupportedVersionError(-1n,2n)),{kind:'UnsupportedVersion',found:-1n,supported:2n});
 assert.equal(projectNativeStoreReadDiagnostic(new Error(secret)),null);
 assert.equal(projectNativeStoreReadDiagnostic(new Proxy(integrity,{get(){assert.fail('proxy');}})),null);
 const getter=new Error();Object.defineProperty(getter,'code',{get(){assert.fail('code accessor');}});assert.equal(projectNativeStoreReadDiagnostic(getter),null);
 assert.equal(projectNativeStoreReadDiagnostic(sqlite(-1)),null);
});
test('passive aggregate projection preserves primary-close order and rejects every unknown/nested child',()=>{
 const first=new InvalidQueueStateError(secret),last=sqlite(5);
 assert.deepEqual(projectNativeStoreReadDiagnostic(new AggregateError([first,last],secret)),{kind:'ScopeCleanup',errors:[{kind:'InvalidQueueState'},{kind:'Database',errcode:5}]});
 assert.deepEqual(projectNativeStoreReadDiagnostic(new AggregateError([new StoreJsonError(),last],secret)),{kind:'ScopeCleanup',errors:[{kind:'Json'},{kind:'Database',errcode:5}]});
 for(const errors of [[first],[first,new Error(secret)],[first,last,last],[new AggregateError([first]),last]])assert.equal(projectNativeStoreReadDiagnostic(new AggregateError(errors)),null);
 const sparse=new AggregateError([]);Object.defineProperty(sparse,'errors',{value:Array(1)});assert.equal(projectNativeStoreReadDiagnostic(sparse),null);
 const active=new AggregateError([]);Object.defineProperty(active,'errors',{get(){assert.fail('aggregate accessor');}});assert.equal(projectNativeStoreReadDiagnostic(active),null);
});
test('passive decoder is closed, shallow, bounded, frozen and grants no joined provenance',()=>{
 const largest=captureNativeStoreReadDiagnostic({kind:'ScopeCleanup',errors:[{kind:'UnsupportedVersion',found:-(1n<<63n),supported:(1n<<63n)-1n},{kind:'UnsupportedVersion',found:-(1n<<63n),supported:(1n<<63n)-1n}]});
 assert.notEqual(boundedSerdeByteCount(largest,NATIVE_STORE_READ_DIAGNOSTIC_BYTES),null);assert.ok(Object.isFrozen(largest));
 assert.deepEqual(captureNativeStoreReadDiagnostic({kind:'Json'}),{kind:'Json'});
 assert.equal(new NativeStoreReadError({kind:'Json'}).message,'stored JSON decoding failed');
 for(const bad of [{kind:'Integrity',message:secret},{kind:'Json',message:secret},{kind:'Json',cause:secret},{kind:'Database',errcode:-0},{kind:'Database',errcode:Infinity},{kind:'UnsupportedVersion',found:1n<<63n,supported:2n},{kind:'ScopeCleanup',errors:[{kind:'ScopeCleanup',errors:[{kind:'Integrity'}]}]},{kind:'ScopeCleanup',errors:Array(3).fill({kind:'Integrity'})},{kind:'Unknown'},new Proxy({kind:'Integrity'},{get(){assert.fail('proxy');}})])assert.throws(()=>captureNativeStoreReadDiagnostic(bad),TypeError);
 const active={};Object.defineProperty(active,'kind',{get(){assert.fail('accessor');},enumerable:true});assert.throws(()=>captureNativeStoreReadDiagnostic(active),TypeError);
 const fake=new NativeStoreReadError({kind:'Integrity'});
 assert.equal(joinedControlEvidenceStoreCause(new NativeControlEvidenceUnavailable(fake)),undefined);
 assert.equal(joinedQueueReadStoreCause(new NativeQueueReadUnavailableError('List',fake)),undefined);
 assert.equal(joinedPromptIntakeStoreCause(new NativePromptIntakeUnavailableError('MirrorTarget',fake)),undefined);
});
test('negative diagnostic envelopes bind every captured field without creating provenance',()=>{
 const binding={operation:'List',target:null,generation:null},reply={...binding,ok:false,storeDiagnostic:{kind:'Integrity'}};
 assert.deepEqual(captureNativeStoreReadFailure(reply,binding),{kind:'Integrity'});
 assert.deepEqual(captureNativeStoreReadFailure({...reply,storeDiagnostic:{kind:'Json'}},binding),{kind:'Json'});
 for(const bad of [{...reply,target:'other'},{...reply,operation:'Eligible'},{...reply,ok:true},{...reply,extra:secret},{...reply,storeDiagnostic:{kind:'Integrity',payload:secret}}])assert.throws(()=>captureNativeStoreReadFailure(bad,binding),TypeError);
});
test('direct passive prompt port preserves exact original failure identity',async()=>{
 const failure=new Error(secret),input={hasObservedCompletion:async()=>{throw failure;},listQueueJobs:async()=>[],mirroredThreadId:async()=>null};
 const port=capturePromptAuthorityReads('/original',input);assert.equal(await rejected(port.hasObservedCompletion('/original','T','V')),failure);assert.throws(()=>port.listQueueJobs('/different'),TypeError);
});
test('real missing SQLite failures keep shared outer classes and prompt-only Store classification without creation',{timeout:20000},()=>storeFixture(async path=>{
 const control=new NativeControlEvidenceReader(path),queue=createNativeQueueReadState(path),mapping=createNativePromptIntakeState(path);
 const a=await rejected(control.observed('T','V')),b=await rejected(queue.listFiltered(path,null,null)),c=await rejected(mapping.mirroredThreadId(path,42n));
 assert.ok(a instanceof NativeControlEvidenceUnavailable);assert.ok(b instanceof NativeQueueReadUnavailableError);assert.ok(c instanceof NativePromptIntakeUnavailableError);
 for(const [outer,cause] of [[a,joinedControlEvidenceStoreCause(a)],[b,joinedQueueReadStoreCause(b)],[c,joinedPromptIntakeStoreCause(c)]] as const){assert.ok(storeKind(cause,'Database'));assert.equal((outer as Error).cause,cause);}
 const prompt=createNativePromptAuthorityReads(path);
 for(const p of [()=>prompt.hasObservedCompletion(path,'T','V'),()=>prompt.listQueueJobs(path),()=>prompt.mirroredThreadId(path,42n)]){assert.ok(storeKind(await rejected(p()),'Database'));idle();}
 assert.equal(existsSync(path),false);
}));
test('real List failures retain distinct invalid-state and JSON classifications with no raw row disclosure',{timeout:20000},()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1)");
  const port=createNativePromptAuthorityReads(path),shared=createNativeQueueReadState(path);
  db.exec('PRAGMA ignore_check_constraints=ON');db.prepare('UPDATE codex_turn_queue SET state=?').run(secret);
  const outer=await rejected(shared.listFiltered(path,null,null));assert.ok(outer instanceof NativeQueueReadUnavailableError);assert.ok(storeKind(joinedQueueReadStoreCause(outer),'InvalidQueueState'));assert.ok(storeKind(await rejected(port.listQueueJobs(path)),'InvalidQueueState'));
  db.prepare("UPDATE codex_turn_queue SET state='running',baseline_turn_ids=?").run(secret);
  const jsonOuter=await rejected(shared.listFiltered(path,null,null));assert.ok(jsonOuter instanceof NativeQueueReadUnavailableError);assert.ok(storeKind(joinedQueueReadStoreCause(jsonOuter),'Json'));assert.equal((jsonOuter as Error).cause,joinedQueueReadStoreCause(jsonOuter));
  assert.ok(storeKind(await rejected(port.listQueueJobs(path)),'Json'),'baseline parser failure keeps the Rust StoreError::Json category');
  db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='[]'");assert.equal((await port.listQueueJobs(path)).length,1);idle();
 }finally{db.close();}
}));
test('real mapping duplicate and schema failures are Store diagnostics; shared mapping callers keep their outer class',{timeout:20000},()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec("INSERT INTO mirror_threads VALUES('T','P','title',10,42,1),('U','P','title',10,42,1)");
  const port=createNativePromptAuthorityReads(path),shared=createNativePromptIntakeState(path),outer=await rejected(shared.mirroredThreadId(path,42n));
  assert.ok(outer instanceof NativePromptIntakeUnavailableError);assert.ok(storeKind(joinedPromptIntakeStoreCause(outer),'Integrity'));assert.ok(storeKind(await rejected(port.mirroredThreadId(path,42n)),'Integrity'));
  db.exec('PRAGMA user_version=99');const schema=await rejected(port.mirroredThreadId(path,42n));assert.ok(storeKind(schema,'UnsupportedVersion'));assert.deepEqual((schema as NativeStoreReadError).diagnostic,{kind:'UnsupportedVersion',found:99n,supported:2n});idle();
 }finally{db.close();}
}));
test('all three real read deadlines retain joins and reject late store provenance; Control stays zero-queue',{timeout:30000},async()=>{
 for(const kind of ['Observed','List','MirrorTarget'] as const)await storeFixture(async path=>{
  const db=await openInitialized(path);db.exec('DROP TABLE codex_observed_completions; DROP TABLE codex_turn_queue; BEGIN EXCLUSIVE');
  let unlock:ReturnType<typeof setTimeout>|undefined;
  const cause=kind==='Observed'?joinedControlEvidenceStoreCause:kind==='List'?joinedQueueReadStoreCause:joinedPromptIntakeStoreCause;
  try{
   const pending=kind==='Observed'?new NativeControlEvidenceReader(path).observed('T','V',undefined,50):kind==='List'?createNativeQueueReadState(path,50).listFiltered(path,null,null):createNativePromptIntakeState(path,50).mirroredThreadId(path,42n);
   const overlap=await rejected(createNativePromptAuthorityReads(path).hasObservedCompletion(path,'T','V'));assert.ok(overlap instanceof OwnedWorkerBudgetError);assert.equal(joinedControlEvidenceStoreCause(overlap),undefined);
   unlock=setTimeout(()=>{if(db.isTransaction)db.exec('ROLLBACK');},200);
   const timedOut=await rejected(pending);assert.ok(kind==='Observed'?timedOut instanceof NativeControlEvidenceUnavailable:kind==='List'?timedOut instanceof NativeQueueReadUnavailableError:timedOut instanceof NativePromptIntakeUnavailableError);assert.equal(cause(timedOut),undefined);idle();
   const port=createNativePromptAuthorityReads(path),fresh=kind==='Observed'?port.hasObservedCompletion(path,'T','V'):kind==='List'?port.listQueueJobs(path):port.mirroredThreadId(path,42n);
   assert.ok(storeKind(await rejected(fresh),kind==='MirrorTarget'?'Integrity':'Database'),'a separate completed read may classify only its own failure');
  }finally{clearTimeout(unlock);if(db.isTransaction)db.exec('ROLLBACK');db.close();}
 });
});
test('original resident delivery retains JSON-failed requests and recovers native receipts through a passive transport',{timeout:30000},async t=>storeFixture(async path=>{
 const child="import readline from 'node:readline';const answers=[],emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method===undefined&&m.id==='approval'){answers.push(m);return;}if(m.method==='ask'){emit({method:'turn/started',params:{threadId:'T',turnId:'V'}});emit({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'T',turnId:'V'}});}if(m.id!==undefined)emit({id:m.id,result:m.method==='answers'?answers:{}});});";
 const owner=await startRuntimeResident({process:{executable:process.execPath,arguments:['--no-strip-types','--input-type=module','-e',child],environment:{}},clientInfo:{name:'store-diagnostic-fixture',title:'Fixture',version:'968'}},path,'runtime',null,()=> 'safe fixture',t.signal);
 let db:DatabaseSync|undefined;const receiver=owner.subscribeServerRequests();
 const call=async(method:string)=>{const admission=owner.admitResponse(1n);try{return await admission.client.requestAdmitted(admission.permit,method,{},2000);}finally{admission.release();}};
 try{
  db=await openInitialized(path);db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1); INSERT INTO mirror_threads VALUES('T','P','title',10,42,1)");
  await call('ask');const event=await receiver.receive(t.signal);assert.equal(event.kind,'Request');if(event.kind!=='Request')throw Error('missing request');const port=createNativePromptAuthorityReads(path);
  (await verifyPromptAuthority(path,owner,event.request,1n,port)).requireActor(42n,3n);
  const invalid=await prepareOneServerPrompt(path,owner,event.request,1n,42n,4n,port);assert.equal(invalid.unavailable,true,'only Invalid produces unavailable UI');
  db.prepare('UPDATE codex_turn_queue SET channel_id=?').run(1.5);
  assert.ok(storeKind(await rejected(verifyPromptAuthority(path,owner,event.request,1n,port)),'Integrity'));
  assert.ok(storeKind(await rejected(prepareOneServerPrompt(path,owner,event.request,1n,42n,3n,port)),'Integrity'),'Store failure is not converted to unavailable UI');
  assert.deepEqual(await call('answers'),[]);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);assert.equal(owner.pendingServerRequests('T').length,1);
  db.exec('UPDATE codex_turn_queue SET channel_id=42');
  // Original resident, SQLite/native readers and receipts are genuine. This
  // callback is a passive branch witness, not HTTP or remote acceptance proof.
  let sends=0;const delivery=new ServerRequestDelivery(path,owner,{async sendValidated(){sends++;return 97n;}},true,port);
  const pendingUnchanged=()=>{const requests=owner.pendingServerRequests('T');assert.equal(requests.length,1);assert.equal(pendingServerRequestEqual(requests[0]!,event.request),true);};
  for(const baseline of ['{','[1e999]']){
   db.prepare('UPDATE codex_turn_queue SET baseline_turn_ids=?').run(baseline);
   assert.ok(storeKind(await rejected(verifyPromptAuthority(path,owner,event.request,1n,port)),'Json'));
   assert.ok(storeKind(await rejected(prepareOneServerPrompt(path,owner,event.request,1n,42n,3n,port)),'Json'),'Json is not unavailable-authority UI');
   assert.ok(storeKind(await rejected(delivery.process(1n,event.request,t.signal)),'Json'));
   assert.ok(storeKind(await rejected(delivery.recover(t.signal)),'Json'));
   assert.equal(sends,0);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_delivery_receipts').get()!.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);
   assert.deepEqual(await call('answers'),[]);pendingUnchanged();idle();
  }
  db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='[]'");
  await delivery.recover(t.signal);assert.equal(sends,1);assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,'97');
  await delivery.recover(t.signal);assert.equal(sends,1,'same original request reuses its confirmed receipt/cache');
  assert.deepEqual(await call('answers'),[]);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);pendingUnchanged();idle();
 }finally{receiver.dispose();try{await owner.dispose();}finally{db?.close();}assert.equal(owner.lifecycleSnapshot().processId,null);idle();}
}));
