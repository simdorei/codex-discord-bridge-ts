import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {anyStoreAuthorityEnrolled} from '../../src/store/store-authority-domain.ts';
import {PERSISTENT_RESIDENT_SCENARIOS,PERSISTENT_RECEIVER_SCENARIOS,PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS,type PersistentReceiverNegativeScenario,capturePersistentResidentFixtureCommand} from '../../src/runtime/persistent-resident-bootstrap.ts';
import {createPersistentResidentRegistration,createPersistentResidentNormalComponent,type PersistentResidentNormalComponent} from '../../src/runtime/persistent-resident-store-role.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../helpers/store-authority-worker-fixture.ts';

const negativeMode=process.env.CDR_RECEIVER_NEGATIVE_MODE,negativeNonce=process.env.CDR_RECEIVER_NEGATIVE_NONCE;
if(negativeMode!==undefined&&(!PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS.includes(negativeMode as PersistentReceiverNegativeScenario)||negativeNonce===undefined||!/^[0-9a-f]{32}$/.test(negativeNonce)))throw new TypeError('Expected exact receiver negative mode and parent nonce');
const WITNESS='CDR_RECEIVER_NEGATIVE_WITNESS_V1 ';
if(negativeMode===undefined){

// Source-review gate: this entry intentionally adds no process supervisor,
// network/socket, generic fault injector, transport callback, or runtime API.
// Execute only as the independently reviewed selected/emitted graph. Existing
// failed cleanup qualification remains separate and is not promoted by this file.
test('fixed receiver inventory preserves original scenarios and rejects transported work',()=>{
 assert.equal(PERSISTENT_RESIDENT_SCENARIOS.length,12);
 assert.deepEqual(PERSISTENT_RECEIVER_SCENARIOS,['receiver-computer-form-recovery','receiver-browser-form-event','receiver-unsupported-form-event','receiver-approval-prompt','receiver-input-prompt','receiver-late-accept','receiver-read-json','receiver-native-join']);
 for(const scenario of PERSISTENT_RECEIVER_SCENARIOS){
  assert.deepEqual(capturePersistentResidentFixtureCommand({kind:'run-fixture',scenario}),{kind:'run-fixture',scenario});
  for(const extra of [{payload:{}},{callback:()=>{}},{path:'/tmp/other.sqlite'},{transport:{}},{response:{action:'accept'}}])assert.throws(()=>capturePersistentResidentFixtureCommand({kind:'run-fixture',scenario,...extra}),TypeError);
 }
 assert.throws(()=>capturePersistentResidentFixtureCommand({kind:'run-fixture',scenario:'receiver-arbitrary'}),TypeError);
});

const negativeWitnesses=new Set<string>();
for(const scenario of PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS)test(`isolated receiver retained-debt invariants: ${scenario}`,{concurrency:false,timeout:20000},async()=>{
 const nonce=randomBytes(16).toString('hex'),env:NodeJS.ProcessEnv={...process.env,CDR_RECEIVER_NEGATIVE_MODE:scenario,CDR_RECEIVER_NEGATIVE_NONCE:nonce};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',fileURLToPath(import.meta.url)],{env,stdio:['ignore','pipe','pipe']});
 let stdout='',bytes=0,overflow=false,exited=false;
 const capture=(chunk:Buffer,keep:boolean)=>{bytes+=chunk.length;if(bytes>128*1024){overflow=true;return;}if(keep)stdout+=chunk.toString('utf8');};
 child.stdout.on('data',(chunk:Buffer)=>capture(chunk,true));child.stderr.on('data',(chunk:Buffer)=>capture(chunk,false));child.once('exit',()=>{exited=true;});
 const end=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 assert.equal(overflow,false);assert.equal(exited,true);assert.equal(end.signal,null);assert.equal(end.code,0,'Isolated retained-debt invariant assertions failed');
 const lines=stdout.split(/\r?\n/);assert.deepEqual(lines.filter(line=>/^(?:ok|not ok)\b/.test(line)),[`ok 1 - fixed receiver negative invariants: ${scenario}`]);assert.deepEqual(lines.filter(line=>/^\d+\.\.\d+/.test(line)),['1..1']);
 const reports=lines.filter(line=>line.startsWith('# '+WITNESS));assert.equal(reports.length,1);
 const report=JSON.parse(reports[0]!.slice(('# '+WITNESS).length)) as Record<string,unknown>;
 assert.deepEqual(report,{version:1,scenario,nonce,assertionsPassed:true,requesterExited:true,rootDebt:true,cleanupQualified:false,componentQualified:false,receiptConfirmed:true,temporaryRoot:'retained'});negativeWitnesses.add(scenario);
});
test('mandatory receiver-negative cleanup and component qualification',{concurrency:false},()=>{
 assert.deepEqual([...negativeWitnesses].sort(),[...PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS].sort(),'Missing original negative evidence');
 assert.equal(false,true,'Original receiver loss scenarios deliberately retain root debt; cleanup and component qualification remain unmet');
});
}else{
test(`fixed receiver negative invariants: ${negativeMode}`,{concurrency:false,timeout:20000},async t=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-receiver-negative-')),initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
 (await openInitialized(path)).close();const component=createPersistentResidentNormalComponent(createPersistentResidentRegistration(path),'fixture-runtime');
 const originalJoin=component.join();void originalJoin.catch(()=>undefined);
 await component.ready();await assert.rejects(component.runFixture(negativeMode as PersistentReceiverNegativeScenario));await originalJoin;
 const state=component.snapshot(),receiver=component.receiverSnapshot();assert.equal(state.state,'quarantined');assert.equal(state.exited,true);assert.equal(state.registrationLive,false);assert.equal(state.rootDebt,true);
 assert.equal(receiver.quarantined,true);assert.equal(receiver.releasable,false);assert.equal(receiver.pending,false);assert.equal(receiver.calls,1);
 assert.equal(receiver.submitted,7);assert.equal(receiver.retired,6);
 if(negativeMode==='receiver-ack-loss')assert.equal(receiver.terminalRetained,true);
 await assert.rejects(component.closeComponent());await assert.rejects(component.runFixture(negativeMode as PersistentReceiverNegativeScenario));assert.throws(()=>createPersistentResidentRegistration(path),/debt/);
 const db=new DatabaseSync(path,{readOnly:true});try{const rows=db.prepare('SELECT receipt_key,content_hash,message_id FROM codex_delivery_receipts').all();assert.equal(rows.length,1);assert.equal(rows[0]!.message_id,'101');assert.match(rows[0]!.content_hash as string,/^[0-9a-f]{64}$/);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);}finally{db.close();}
 assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
 // Physical native/port/requester joins never clear abnormal component debt.
 // This original root remains owned and is intentionally never removed.
 t.diagnostic(WITNESS+JSON.stringify({version:1,scenario:negativeMode,nonce:negativeNonce,assertionsPassed:true,requesterExited:true,rootDebt:true,cleanupQualified:false,componentQualified:false,receiptConfirmed:true,temporaryRoot:'retained'}));
});
}

if(negativeMode===undefined)for(const scenario of PERSISTENT_RECEIVER_SCENARIOS)test(`original persistent receiver workflow: ${scenario}`,{concurrency:false,timeout:20000},async()=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-receiver-workflow-'));
 const initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
 let component:PersistentResidentNormalComponent|null=null,joined=false,hasPrimary=false,primary:unknown;
 const trace=scenario==='receiver-native-join'?new SharedArrayBuffer(8):null;
 let restore:(()=>void)|null=null;
 const rows=(sql:string)=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};
 try{
  assert.equal(anyStoreAuthorityEnrolled(),false);(await openInitialized(path)).close();
  component=createPersistentResidentNormalComponent(createPersistentResidentRegistration(path),'fixture-runtime');
  const originalJoin=component.join();void originalJoin.catch(()=>undefined);
  await component.ready();assert.equal(component.snapshot().state,'ready');assert.equal(component.snapshot().runtimeStarted,true);
  if(trace!==null)restore=instrumentStoreWorker({match:'control-evidence-native-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts'),trace});
  let fixtureSettled=false;const fixture=component.runFixture(scenario);void fixture.then(()=>{fixtureSettled=true;},()=>{fixtureSettled=true;});
  if(trace!==null){
   await waitTrace(trace);const until=performance.now()+5000;
   while(!component.receiverSnapshot().loopStopObserved){assert.ok(performance.now()<until,'Original receiver stop observation missing');await new Promise(resolve=>setTimeout(resolve,1));}
   assert.equal(ownedWorkerUsage().Control,1);assert.equal(component.receiverSnapshot().pending,true);assert.equal(fixtureSettled,false);assert.equal(component.snapshot().state,'running');
   releaseTrace(trace);restore!();restore=null;
  }
  assert.deepEqual(await fixture,{scenario,passed:true});
  assert.equal(component.snapshot().state,'fixture-done');assert.equal(component.snapshot().rootDebt,true);
  await assert.rejects(component.runFixture(scenario),TypeError);
  // The genuine original child turn/start was durably admitted and replied.
  const turns=rows("SELECT method,state,target_thread_id FROM codex_mutation_attempts WHERE method='turn/start'");
  assert.deepEqual(turns.map(row=>({...row})),[{method:'turn/start',state:'reply_ok',target_thread_id:'fixture-target'}]);
  const local=scenario==='receiver-computer-form-recovery'||scenario==='receiver-browser-form-event'||scenario==='receiver-unsupported-form-event';
  const responses=rows('SELECT request_key,response_sha256,phase FROM cdr_server_responses');
  const receipts=rows('SELECT receipt_key,content_hash,message_id FROM codex_delivery_receipts ORDER BY receipt_key');
  if(local){assert.equal(responses.length,1);assert.equal(responses[0]!.phase,'flushed');assert.match(responses[0]!.request_key as string,/^[0-9a-f]{64}$/);assert.match(responses[0]!.response_sha256 as string,/^[0-9a-f]{64}$/);assert.equal(receipts.length,0);}
  else if(scenario==='receiver-read-json'||scenario==='receiver-native-join'){assert.equal(responses.length,0);assert.equal(receipts.length,0);}
  else{assert.equal(responses.length,0);assert.equal(receipts.length,scenario==='receiver-input-prompt'?2:1);for(const row of receipts){assert.match(row.content_hash as string,/^[0-9a-f]{64}$/);assert.ok(BigInt(row.message_id as string)>=101n);}}
  const beforeClose=JSON.stringify({responses,receipts});
  const closing=component.closeComponent();assert.equal(component.snapshot().rootDebt,true);
  await closing;await originalJoin;joined=true;assert.equal(component.join(),originalJoin);
  assert.deepEqual(component.snapshot(),{state:'joined',submitted:true,exited:true,registrationLive:false,rootDebt:false,runtimeStarted:true,servicesClosed:true,mutationJoined:true,directChildClosure:'confirmed'});
  assert.equal(JSON.stringify({responses:rows('SELECT request_key,response_sha256,phase FROM cdr_server_responses'),receipts:rows('SELECT receipt_key,content_hash,message_id FROM codex_delivery_receipts ORDER BY receipt_key')}),beforeClose,'Original joined shutdown must not replay or rewrite a durable result');
  await component.closeComponent();assert.equal(anyStoreAuthorityEnrolled(),false);
 }catch(error){hasPrimary=true;primary=error;throw error;}
 finally{
  if(trace!==null)releaseTrace(trace);restore?.();
  const cleanupErrors:unknown[]=[],state=component?.snapshot().state;
  // Never manufacture a missing scenario or treat timeout/requester exit as
  // receiver/native/child join. The original component retains its own joins.
  if(component!==null&&(state==='fixture-done'||state==='closing'||state==='disposed'))try{await component.closeComponent();}catch(error){cleanupErrors.push(error);}
  if(component!==null)try{await component.join();joined=true;}catch(error){cleanupErrors.push(error);}
  const settled=component?.snapshot();
  if(joined&&settled?.state==='joined'&&settled.exited&&settled.rootDebt===false&&settled.registrationLive===false&&settled.servicesClosed&&settled.mutationJoined&&settled.directChildClosure==='confirmed'){
   try{assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);rmSync(root,{recursive:true});}catch(error){cleanupErrors.push(error);}
  }else cleanupErrors.push(new Error('Original receiver fixture root retained without debt-free normal closure'));
  if(cleanupErrors.length!==0)throw new AggregateError(hasPrimary?[primary,...cleanupErrors]:cleanupErrors,'Receiver workflow fixture cleanup remains unconfirmed',hasPrimary?{cause:primary}:undefined);
 }
});
