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
if((negativeMode===undefined&&negativeNonce!==undefined)||(negativeMode!==undefined&&(!PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS.includes(negativeMode as PersistentReceiverNegativeScenario)||negativeNonce===undefined||negativeNonce.length!==32||!/^[0-9a-f]{32}$/.test(negativeNonce))))throw new TypeError('Expected exact receiver negative mode and parent nonce');
const WITNESS_MARKER='CDR_RECEIVER_NEGATIVE_WITNESS_V1',WITNESS=WITNESS_MARKER+' ',NEGATIVE_OUTPUT_LIMIT=128*1024;
const negativeWitnessPayload=(scenario:PersistentReceiverNegativeScenario,nonce:string)=>JSON.stringify({version:1,scenario,nonce,assertionsPassed:true,requesterExited:true,rootDebt:true,cleanupQualified:false,componentQualified:false,receiptConfirmed:true,clientResultObserved:scenario==='receiver-ack-loss',temporaryRoot:'retained'});
function assertNegativeEvidence(stdout:Buffer,stderr:Buffer,scenario:PersistentReceiverNegativeScenario,nonce:string):void{
 assert.ok(stdout.length+stderr.length<=NEGATIVE_OUTPUT_LIMIT,'Receiver negative output exceeded the combined bound');
 const out=stdout.toString('utf8'),err=stderr.toString('utf8'),lines=out.split(/\r?\n/),errorLines=err.split(/\r?\n/);
 assert.equal(out.split(WITNESS_MARKER).length+err.split(WITNESS_MARKER).length-2,1,'Expected exactly one witness marker across both streams');
 assert.equal(err.includes(WITNESS_MARKER),false,'Receiver negative witness must be on stdout');
 const reports=lines.filter(line=>line.startsWith('# '+WITNESS));assert.equal(reports.length,1);
 const payload=reports[0]!.slice(('# '+WITNESS).length);assert.ok(payload.length<=2048&&/^[\x20-\x7e]+$/.test(payload),'Expected bounded ASCII witness payload');
 assert.ok(Buffer.from(payload,'ascii').equals(Buffer.from(negativeWitnessPayload(scenario,nonce),'ascii')),'Expected exact canonical mode/nonce-bound witness bytes');
 const result=/^\s*(?:ok|not ok)\b/,plan=/^\s*\d+\.\.\d+/,summary=/^\s*#\s*(?:tests|suites|pass|fail|cancelled|skipped|todo)\b/;
 assert.equal(errorLines.some(line=>result.test(line)||plan.test(line)||summary.test(line)),false,'Receiver negative TAP evidence must be on stdout');
 assert.deepEqual(lines.filter(line=>result.test(line)),[`ok 1 - fixed receiver negative invariants: ${scenario}`]);assert.deepEqual(lines.filter(line=>plan.test(line)),['1..1']);
 assert.deepEqual(lines.filter(line=>summary.test(line)),['# tests 1','# suites 0','# pass 1','# fail 0','# cancelled 0','# skipped 0','# todo 0']);
}
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
 // Pure parser rejections stay inside this existing test; no extra child mode or invocation.
 const scenario=PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS[0]!,nonce='0123456789abcdef0123456789abcdef',report='# '+WITNESS+negativeWitnessPayload(scenario,nonce);
 const tap=['TAP version 13',`ok 1 - fixed receiver negative invariants: ${scenario}`,report,'1..1','# tests 1','# suites 0','# pass 1','# fail 0','# cancelled 0','# skipped 0','# todo 0',''].join('\n');
 const check=(out:string,err='')=>assertNegativeEvidence(Buffer.from(out),Buffer.from(err),scenario,nonce);check(tap);
 for(const [label,out,err] of [
  ['duplicate witness',tap+report+'\n',''],['duplicate marker',tap+'# '+WITNESS_MARKER+'\n',''],['stderr witness',tap.replace(report+'\n',''),report+'\n'],
  ['wrong nonce',tap.replace(nonce,'f'.repeat(32)),''],['wrong mode',tap.replace('"scenario":"'+scenario+'"','"scenario":"receiver-arbitrary"'),''],
  ['altered field',tap.replace('"rootDebt":true','"rootDebt":false'),''],['noncanonical JSON',tap.replace('"version":1','"version": 1'),''],
  ['non-ASCII payload',tap.replace('"retained"','"retained\u00e9"'),''],['oversized payload',tap.replace('"retained"','"'+'x'.repeat(2048)+'"'),''],
  ['duplicate result',tap+`ok 1 - fixed receiver negative invariants: ${scenario}\n`,''],['duplicate plan',tap+'1..1\n',''],['stderr TAP',tap,'# fail 0\n'],
  ['combined output bound',tap,'x'.repeat(NEGATIVE_OUTPUT_LIMIT)],
 ] as const)assert.throws(()=>check(out,err),label);
 for(const summary of ['tests 1','suites 0','pass 1','fail 0','cancelled 0','skipped 0','todo 0']){
  assert.throws(()=>check(tap.replace('# '+summary,'# '+summary.slice(0,summary.lastIndexOf(' '))+' 2')),'Altered summary: '+summary);
  assert.throws(()=>check(tap.replace('# '+summary+'\n','')),'Missing summary: '+summary);
  assert.throws(()=>check(tap+'# '+summary+'\n'),'Duplicate summary: '+summary);
 }
});

const negativeWitnesses=new Set<string>();
for(const scenario of PERSISTENT_RECEIVER_NEGATIVE_SCENARIOS)test(`isolated receiver retained-debt invariants: ${scenario}`,{concurrency:false,timeout:20000},async()=>{
 const nonce=randomBytes(16).toString('hex'),env:NodeJS.ProcessEnv={...process.env,CDR_RECEIVER_NEGATIVE_MODE:scenario,CDR_RECEIVER_NEGATIVE_NONCE:nonce};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',fileURLToPath(import.meta.url)],{env,stdio:['ignore','pipe','pipe']});
 const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0,overflow=false,exited=false;
 const capture=(chunk:Buffer,target:Buffer[])=>{if(overflow)return;bytes+=chunk.length;if(bytes>NEGATIVE_OUTPUT_LIMIT){overflow=true;return;}target.push(chunk);};
 child.stdout.on('data',(chunk:Buffer)=>capture(chunk,stdout));child.stderr.on('data',(chunk:Buffer)=>capture(chunk,stderr));child.once('exit',()=>{exited=true;});
 const end=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 assert.equal(overflow,false);assert.equal(exited,true);assert.equal(end.signal,null);assert.equal(end.code,0,'Isolated retained-debt invariant assertions failed');
 assertNegativeEvidence(Buffer.concat(stdout),Buffer.concat(stderr),scenario,nonce);negativeWitnesses.add(scenario);
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
 await component.ready();assert.equal(component.receiverSnapshot().clientResultObserved,false);await assert.rejects(component.runFixture(negativeMode as PersistentReceiverNegativeScenario));await originalJoin;
 const state=component.snapshot(),receiver=component.receiverSnapshot();assert.equal(state.state,'quarantined');assert.equal(state.exited,true);assert.equal(state.registrationLive,false);assert.equal(state.rootDebt,true);
 assert.equal(receiver.quarantined,true);assert.equal(receiver.releasable,false);assert.equal(receiver.pending,false);assert.equal(receiver.calls,1);
 assert.equal(receiver.submitted,7);assert.equal(receiver.retired,6);
 assert.equal(receiver.completed,7);assert.equal(receiver.dataClosed,true);assert.equal(receiver.controlClosed,true);assert.equal(receiver.closed,false);
 // ACK-loss is direct original delivery coverage. This word is set only after
 // the actual caller-facing process Promise fulfills, never from a receipt row.
 assert.equal(receiver.clientResultObserved,negativeMode==='receiver-ack-loss');
 if(negativeMode==='receiver-data-loss')assert.equal(receiver.controlReplySent,true);
 if(negativeMode==='receiver-ack-loss')assert.equal(receiver.terminalRetained,true);
 await assert.rejects(component.closeComponent());await assert.rejects(component.runFixture(negativeMode as PersistentReceiverNegativeScenario));assert.throws(()=>createPersistentResidentRegistration(path),/debt/);
 const db=new DatabaseSync(path,{readOnly:true});try{const rows=db.prepare('SELECT receipt_key,content_hash,message_id FROM codex_delivery_receipts').all();assert.equal(rows.length,1);assert.equal(rows[0]!.message_id,'101');assert.match(rows[0]!.content_hash as string,/^[0-9a-f]{64}$/);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);}finally{db.close();}
 assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
 // Physical native/port/requester joins never clear abnormal component debt.
 // This original root remains owned and is intentionally never removed.
 t.diagnostic(WITNESS+JSON.stringify({version:1,scenario:negativeMode,nonce:negativeNonce,assertionsPassed:true,requesterExited:true,rootDebt:true,cleanupQualified:false,componentQualified:false,receiptConfirmed:true,clientResultObserved:receiver.clientResultObserved,temporaryRoot:'retained'}));
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
  assert.equal(component.receiverSnapshot().clientResultObserved,false);
  if(scenario==='receiver-native-join'){
   const receiver=component.receiverSnapshot();
   assert.equal(receiver.submitted,3);assert.equal(receiver.completed,3);assert.equal(receiver.retired,3);assert.equal(receiver.pending,false);
  }
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
  // The original newline-preferring splitter emits a header, the long first
  // option chunk, and the remaining option text for this fixed input request.
  else{assert.equal(responses.length,0);assert.equal(receipts.length,scenario==='receiver-input-prompt'?3:1);for(const row of receipts){assert.match(row.content_hash as string,/^[0-9a-f]{64}$/);assert.ok(BigInt(row.message_id as string)>=101n);}}
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
