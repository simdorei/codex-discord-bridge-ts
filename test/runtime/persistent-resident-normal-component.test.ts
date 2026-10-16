import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,realpathSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {ResponseAttempt,type DurableResponseClaim} from '../../src/app-server/response-attempt.ts';
import {pinResidentNativeResponseCompletion,type ResidentNativeResponseCompletion} from '../../src/app-server/resident-native-response-completion.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {PERSISTENT_RESIDENT_SCENARIOS,capturePersistentResidentFixtureCommand} from '../../src/runtime/persistent-resident-bootstrap.ts';
import {SERVICE_PROFILES,SERVICE_RESERVATION,SERVICE_LIMITS,captureServicePayload,measurePassiveValue,checkExchangeHeadroom} from '../../src/runtime/persistent-resident-services-protocol.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {anyStoreAuthorityEnrolled} from '../../src/store/store-authority-domain.ts';

function originalRequest(){return Object.freeze({id:'fixture-response-1',occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:'item/commandExecution/requestApproval',params:Object.freeze({threadId:'fixture-target',turnId:'fixture-turn'})});}
function claim():DurableResponseClaim{return Object.freeze({ownerId:'fixture-owner',generation:1n,request:originalRequest(),authority:Object.freeze({key:'local-test'}),payload:Object.freeze({decision:'accept'})});}
function responseFixture(release?:(receipt:object)=>void){
 const receipt=Object.freeze({}),finished:string[]=[],released:object[]=[];let captured=0,begun=0;
 const native:ResidentNativeResponseCompletion={captureResponse(){captured++;return receipt;},finishResponse:async(r,outcome)=>{assert.equal(r,receipt);finished.push(outcome);},close:async()=>{},releaseResponse(r){released.push(r);release?.(r);}};
 const make=()=>new ResponseAttempt('fixture-owner',1n,originalRequest(),{value:{key:'local-test'}},{decision:'accept'},{beginResponse:()=>{begun++;},finishResponse:()=>{throw new Error('Legacy durable finish must not run');}},()=>{},()=> 'fixed response failure',native);
 return {receipt,native,make,finished,released,counts:()=>({captured,begun})};
}

const PROTOCOL_MODES=Object.freeze(['duplicate-bootstrap','duplicate-initialized','unrelated-after-ready'] as const);
type ProtocolMode=typeof PROTOCOL_MODES[number];
const protocolMode=process.env.CDR_NORMAL_COMPONENT_PROTOCOL_NEGATIVE;
if(protocolMode!==undefined&&!PROTOCOL_MODES.includes(protocolMode as ProtocolMode))throw new TypeError('Unknown fixed protocol-negative fixture');
const protocolRunNonce=process.env.CDR_NORMAL_COMPONENT_PROTOCOL_NONCE;
if(protocolMode===undefined){
 if(protocolRunNonce!==undefined)throw new TypeError('Protocol nonce requires a fixed negative mode');
}else if(protocolRunNonce===undefined||!/^[0-9a-f]{32}$/.test(protocolRunNonce))throw new TypeError('Protocol fixture requires a parent-generated nonce');

const PROTOCOL_WITNESS_MARKER='CDR_PROTOCOL_WITNESS_V1 ';
function protocolWitness(mode:ProtocolMode,runNonce:string,servicesClosed:boolean,mutationJoined:boolean){
 return Object.freeze({
  version:1,mode,runNonce,scope:'protocol-invariants-only',protocolAssertions:'passed',
  injectionCount:1,requesterExited:true,requesterExitCode:1,componentJoin:'fulfilled',
  state:'quarantined',registrationLive:false,rootDebt:true,servicesClosed,mutationJoined,
  temporaryRoot:'retained',temporaryRootIdentity:'verified',responderClosure:'unconfirmed',
  cleanupQualified:false,componentQualified:false,
 } as const);
}
type ProtocolWitness=ReturnType<typeof protocolWitness>;
function readProtocolWitness(stdout:string,stderr:string,mode:ProtocolMode,nonce:string):ProtocolWitness{
 const output=stdout+stderr;
 assert.equal(output.split('CDR_PROTOCOL_WITNESS_V1').length-1,1,'Expected exactly one protocol witness marker');
 assert.equal(stderr.includes('CDR_PROTOCOL_WITNESS_V1'),false,'Protocol witness cannot arrive on stderr');
 const lines=stdout.split(/\r?\n/),witnessLines=lines.filter(line=>line.includes('CDR_PROTOCOL_WITNESS_V1'));
 assert.equal(witnessLines.length,1,'Expected one complete protocol witness diagnostic');
 const line=witnessLines[0]!;
 // Only node:test TAP diagnostic framing is accepted. Actual emitted framing
 // remains unverified until the held exact-argv qualification can run.
 assert.ok(line.startsWith(`# ${PROTOCOL_WITNESS_MARKER}`),'Invalid TAP witness framing');
 const payload=line.slice(2+PROTOCOL_WITNESS_MARKER.length);
 assert.ok(payload.length<=2048&&/^[\x20-\x7e]+$/.test(payload),'Witness exceeds the fixed ASCII profile');
 const parsed:unknown=JSON.parse(payload);
 assert.ok(parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed),'Witness must be an exact record');
 const fields=parsed as Record<string,unknown>;
 assert.equal(typeof fields.servicesClosed,'boolean','Invalid service closure observation');
 assert.equal(typeof fields.mutationJoined,'boolean','Invalid mutation join observation');
 const expected=protocolWitness(mode,nonce,fields.servicesClosed as boolean,fields.mutationJoined as boolean);
 // Exact canonical bytes also reject duplicate JSON keys, extra keys, altered
 // types/constants, a different launch nonce and contradictory qualification.
 assert.equal(payload,JSON.stringify(expected),'Noncanonical or contradictory protocol witness');
 return expected;
}


if(protocolMode===undefined){
test('response release pins the original callback and receiver',()=>{
 const receipt=Object.freeze({});let calls=0;
 const native:ResidentNativeResponseCompletion={captureResponse:()=>receipt,finishResponse:async()=>{},close:async()=>{},releaseResponse(r){assert.equal(this,native);assert.equal(r,receipt);calls++;}};
 const pinned=pinResidentNativeResponseCompletion(native);native.releaseResponse=()=>{throw new Error('Replacement callback invoked');};
 const detached=pinned.releaseResponse!;detached(receipt);assert.equal(calls,1);assert.equal(pinned.captureResponse(claim()),receipt);
});
test('response release rejects async and proxy callbacks without invoking them',()=>{
 let calls=0;const f=responseFixture();
 for(const releaseResponse of [async()=>{calls++;},new Proxy(()=>{calls++;},{})])assert.throws(()=>pinResidentNativeResponseCompletion({...f.native,releaseResponse}),TypeError);
 assert.equal(calls,0);
});
test('response release rejects nonvoid and promise returns synchronously',()=>{
 const f=responseFixture();
 const nonvoid=pinResidentNativeResponseCompletion({...f.native,releaseResponse:()=>1});assert.throws(()=>nonvoid.releaseResponse!(f.receipt),TypeError);
 const promise=pinResidentNativeResponseCompletion({...f.native,releaseResponse:()=>Promise.resolve()});assert.throws(()=>promise.releaseResponse!(f.receipt),TypeError);
});
test('thrown undefined survives release and disposal is one-shot even after failure',async()=>{
 const f=responseFixture(()=>{throw undefined;}),attempt=f.make();let caught=false;
 try{attempt.dispose();}catch(error){caught=true;assert.equal(error,undefined);}assert.equal(caught,true);
 attempt.dispose();assert.deepEqual(f.released,[f.receipt]);assert.deepEqual(f.finished,[]);
 assert.throws(()=>attempt.begin(),TypeError);assert.throws(()=>attempt.writeStarted(),TypeError);await assert.rejects(attempt.finishOwned({ok:true}),TypeError);
});
test('unbegun receipt disposal never creates durable not_sent completion',async()=>{
 const f=responseFixture(),attempt=f.make();attempt.dispose();attempt.dispose();
 assert.deepEqual(f.counts(),{captured:1,begun:0});assert.deepEqual(f.released,[f.receipt]);assert.deepEqual(f.finished,[]);await assert.rejects(attempt.finishOwned({ok:true}),TypeError);
});
test('admitted ambiguous response disposal does not fabricate durable completion',async()=>{
 const f=responseFixture(),attempt=f.make();attempt.begin();attempt.writeStarted();const result=await attempt.finishOwned({ok:false,error:new Error('ambiguous write')});
 assert.equal(result.ok,false);attempt.dispose();assert.deepEqual(f.finished,[]);assert.deepEqual(f.released,[f.receipt]);
});
test('flushed response retains its original completion and releases once',async()=>{
 const f=responseFixture(),attempt=f.make();attempt.begin();attempt.writeStarted();assert.deepEqual(await attempt.finishOwned({ok:true}),{ok:true});attempt.dispose();attempt.dispose();
 assert.deepEqual(f.finished,['flushed']);assert.deepEqual(f.released,[f.receipt]);assert.throws(()=>attempt.begin(),TypeError);
});
test('legacy response owner without release callback remains accepted',()=>{
 const f=responseFixture(),native:ResidentNativeResponseCompletion={captureResponse:f.native.captureResponse,finishResponse:f.native.finishResponse,close:f.native.close};
 const pinned=pinResidentNativeResponseCompletion(native);assert.equal(Object.hasOwn(pinned,'releaseResponse'),false);
 const attempt=new ResponseAttempt('fixture-owner',1n,originalRequest(),{value:null},null,{beginResponse:()=>{},finishResponse:()=>{}},()=>{},()=> 'fixed',native);
 attempt.dispose();attempt.dispose();assert.throws(()=>attempt.begin(),TypeError);
});

test('fixed fixture dispatcher rejects dynamic input and nonpassive records before access',()=>{
 assert.deepEqual(capturePersistentResidentFixtureCommand({kind:'run-fixture',scenario:'normal-start-close'}),{kind:'run-fixture',scenario:'normal-start-close'});
 assert.deepEqual(capturePersistentResidentFixtureCommand({kind:'close-component'}),{kind:'close-component'});
 let gets=0;const accessor=Object.defineProperty({kind:'run-fixture'},'scenario',{enumerable:true,get(){gets++;return 'normal-start-close';}});
 for(const value of [accessor,new Proxy({kind:'close-component'},{}),{kind:'run-fixture',scenario:'arbitrary'},{kind:'run-fixture',scenario:'normal-start-close',sql:'SELECT 1'},{kind:'close-component',callback:()=>{}},Object.assign(Object.create({}),{kind:'close-component'})])assert.throws(()=>capturePersistentResidentFixtureCommand(value));
 assert.equal(gets,0);
});
test('frozen transport ledger and exchange reservations preserve the exact finite profile',()=>{
 assert.deepEqual(SERVICE_RESERVATION.total,{bytes:389939328,nodes:4130192,edges:4130188});assert.equal(Object.isFrozen(SERVICE_PROFILES),true);assert.equal(Object.isFrozen(SERVICE_PROFILES.response.input),true);
 assert.deepEqual(SERVICE_RESERVATION.perService.response,{bytes:163842048,nodes:1574144,edges:1574144});
 const needed=SERVICE_LIMITS.operationExchangeReserve+SERVICE_LIMITS.controlExchangeReserve;
 checkExchangeHeadroom(SERVICE_LIMITS.maxId-needed,0);assert.throws(()=>checkExchangeHeadroom(SERVICE_LIMITS.maxId-needed+1,0),RangeError);
 assert.throws(()=>checkExchangeHeadroom(SERVICE_LIMITS.maxId-needed,1),RangeError);
});
test('response passive admission accepts two MiB content and rejects accessors before copying',()=>{
 const payload={op:'response-finish' as const,scope:{runtime:'fixture-runtime',resident:'fixture-owner',generation:1n,request:{id:'fixture-response-1',occurrence:Array.from({length:16},()=>0n),method:'item/commandExecution/requestApproval',params:{threadId:'fixture-target',turnId:'fixture-turn'}}},authority:null,payload:{result:'x'.repeat(2*1024*1024)},outcome:'flushed' as const};
 const copy=captureServicePayload('response',payload,'fixture-runtime');assert.notEqual(copy,payload);assert.equal(Object.isFrozen(copy),true);assert.ok(measurePassiveValue(payload,SERVICE_PROFILES.response.input).bytes>2*1024*1024);
 let gets=0;const bad=Object.defineProperty({...payload},'authority',{enumerable:true,get(){gets++;return null;}});assert.throws(()=>captureServicePayload('response',bad,'fixture-runtime'));assert.equal(gets,0);
 const cycle:unknown[]=[];cycle.push(cycle);assert.throws(()=>measurePassiveValue(cycle,SERVICE_PROFILES.response.input));assert.throws(()=>measurePassiveValue([,],SERVICE_PROFILES.response.input));assert.throws(()=>measurePassiveValue({bad:'\ud800'},SERVICE_PROFILES.response.input));
});

// These are serial real worker + real child + disposable SQLite scenarios, not
// fake mutation owners. The singleton prerequisite is deliberately not exercised.
// Fixed service/observation deadlines remain 5000/10000ms; no timeout inflation.
for(const scenario of PERSISTENT_RESIDENT_SCENARIOS)test(`actual disposable normal component: ${scenario}${scenario==='response-concurrent'?' (partial: child-reply wait only; no held native-status or same-target claim)':''}`,{concurrency:false,timeout:10000},async()=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-normal-component-'));
 const initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
 let component:import('../../src/runtime/persistent-resident-store-role.ts').PersistentResidentNormalComponent|null=null;
 let hasPrimary=false,primary:unknown,joinFulfilled=false;
 try{
  assert.equal(anyStoreAuthorityEnrolled(),false);(await openInitialized(path)).close();
  const {createPersistentResidentRegistration,createPersistentResidentNormalComponent}=await import('../../src/runtime/persistent-resident-store-role.ts');
  component=createPersistentResidentNormalComponent(createPersistentResidentRegistration(path),'fixture-runtime');
  assert.equal(component.snapshot().registrationLive,true);assert.equal(component.snapshot().rootDebt,true);
  await component.ready();assert.equal(component.snapshot().state,'ready');assert.equal(component.snapshot().runtimeStarted,true);assert.equal(anyStoreAuthorityEnrolled(),false);
  const result=await component.runFixture(scenario);assert.deepEqual(result,{scenario,passed:true});
  assert.equal(component.snapshot().state,'fixture-done');assert.equal(component.snapshot().registrationLive,true);
  await assert.rejects(component.runFixture(scenario),TypeError);assert.equal(component.snapshot().state,'fixture-done');
  const closing=component.closeComponent();assert.equal(component.snapshot().registrationLive,true);assert.equal(component.snapshot().rootDebt,true);
  await closing;await component.join();
  assert.deepEqual(component.snapshot(),{state:'joined',submitted:true,exited:true,registrationLive:false,rootDebt:false,runtimeStarted:true,servicesClosed:true,mutationJoined:true});
  await component.closeComponent();await component.join();assert.equal(anyStoreAuthorityEnrolled(),false);
 }catch(error){hasPrimary=true;primary=error;throw error;}finally{
  const cleanupErrors:unknown[]=[],state=component?.snapshot().state;
  // Ready does not grant the worker's post-fixture close transition. Do not
  // manufacture a scenario or close command to cover an assertion failure.
  if(component!==null&&(state==='fixture-done'||state==='closing'||state==='disposed')){try{await component.closeComponent();}catch(error){cleanupErrors.push(error);}}
  if(state==='ready'||state==='running')cleanupErrors.push(new Error('Original fixture has not reached its legal normal-close phase; ownership retained'));
  // A deadline or rejection is never substituted for an actual requester join.
  // Keep the disposable directory owned while this original join is pending.
  if(component!==null){try{await component.join();joinFulfilled=true;}catch(error){cleanupErrors.push(error);}}
  // Requester exit and a fulfilled join alone do not establish child closure.
  // Quarantined joins may resolve while unresolved root debt remains.
  const settled=component?.snapshot();
  if(joinFulfilled&&settled?.state==='joined'&&settled.exited===true&&settled.rootDebt===false&&settled.registrationLive===false&&settled.servicesClosed===true&&settled.mutationJoined===true){
   try{
    assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);
    const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);
    assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
    rmSync(root,{recursive:true});
   }catch(error){cleanupErrors.push(error);}
  }else cleanupErrors.push(new Error(`Disposable normal fixture retained without confirmed debt-free normal closure: ${root}`));
  if(cleanupErrors.length!==0)throw new AggregateError(hasPrimary?[primary,...cleanupErrors]:cleanupErrors,'Normal component test cleanup remains unconfirmed',hasPrimary?{cause:primary}:undefined);
 }
});


// Separate normal processes isolate deliberate retained root debt. Protocol
// assertions may be observed without granting physical cleanup qualification.
const protocolWitnesses=new Map<ProtocolMode,ProtocolWitness>();
for(const mode of PROTOCOL_MODES)test(`isolated protocol-only invariants: ${mode}`,{concurrency:false,timeout:10000},async()=>{
 assert.ok(PROTOCOL_MODES.includes(mode));
 const nonce=randomBytes(16).toString('hex');
 const file=fileURLToPath(import.meta.url),argv=['--test','--test-reporter=tap','--test-concurrency=1',file];assert.ok(argv.length>0&&file.length>0);
 const childEnv:NodeJS.ProcessEnv={...process.env,CDR_NORMAL_COMPONENT_PROTOCOL_NEGATIVE:mode,CDR_NORMAL_COMPONENT_PROTOCOL_NONCE:nonce};
 // The isolated child must establish its own node:test runner context. The
 // inherited internal context can otherwise suppress this file's actual tests.
 delete childEnv.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,argv,{env:childEnv,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',bytes=0,overflow=false,processExited=false;
 const retain=(chunk:Buffer,isStdout:boolean)=>{bytes+=chunk.length;if(bytes>128*1024){overflow=true;return;}if(isStdout)stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');};
 child.stdout.on('data',(chunk:Buffer)=>retain(chunk,true));child.stderr.on('data',(chunk:Buffer)=>retain(chunk,false));
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>{processExited=true;});child.once('close',(code,signal)=>resolve({code,signal}));});
 assert.equal(overflow,false,'Protocol fixture diagnostics exceeded fixed bound');
 assert.equal(processExited,true,'Protocol child exit event missing');assert.equal(result.signal,null,'Protocol child ended by signal');assert.equal(result.code,0,'Protocol-only child assertions failed');
 const lines=stdout.split(/\r?\n/);
 assert.deepEqual(lines.filter(line=>/^\s*(?:ok|not ok)\b/.test(line)),[`ok 1 - fixed protocol-only child: ${mode}`],'Expected exactly one named TAP result');
 assert.deepEqual(lines.filter(line=>/^\s*\d+\.\.\d+/.test(line)),['1..1'],'Expected exactly one TAP test plan');
 for(const [name,value] of [['tests',1],['pass',1],['fail',0],['cancelled',0],['skipped',0],['todo',0]] as const){
  assert.deepEqual(lines.filter(line=>line.startsWith(`# ${name} `)),[`# ${name} ${value}`],`Invalid TAP ${name} total`);
 }
 const witness=readProtocolWitness(stdout,stderr,mode,nonce);
 assert.equal(protocolWitnesses.has(mode),false,'Duplicate mode result');protocolWitnesses.set(mode,witness);
});

// This acceptance gate is mandatory in the same exact test entry. A protocol
// success with retained debt must keep the complete test argv nonzero; neither
// a missing case nor successful isolated assertions can imply component PASS.
test('mandatory protocol-negative cleanup and component qualification',{concurrency:false},()=>{
 assert.deepEqual([...protocolWitnesses.keys()].sort(),[...PROTOCOL_MODES].sort(),'Missing protocol-negative qualification coverage');
 for(const mode of PROTOCOL_MODES){
  const witness=protocolWitnesses.get(mode)!;
  assert.equal(witness.cleanupQualified,true,`${mode}: retained cleanup debt remains unqualified`);
  assert.equal(witness.componentQualified,true,`${mode}: protocol-only evidence is not component qualification`);
 }
});
}else{
 test(`fixed protocol-only child: ${protocolMode}`,{concurrency:false,timeout:10000},async(t)=>{
  const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-normal-protocol-negative-'));
  const initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
  const originalPost=Worker.prototype.postMessage;
  let component:import('../../src/runtime/persistent-resident-store-role.ts').PersistentResidentNormalComponent|null=null;
  let hasPrimary=false,primary:unknown,joinFulfilled=false;
  let requester:Worker|null=null,injectionCount=0,actualExit=false,exitCode:number|undefined;
  let retainedWitness:ProtocolWitness|undefined;
  const observe=(worker:Worker)=>{if(requester!==null)return;requester=worker;worker.once('exit',code=>{actualExit=true;exitCode=code;});};
  try{
   (await openInitialized(path)).close();
   Worker.prototype.postMessage=function(this:Worker,...args:Parameters<Worker['postMessage']>):ReturnType<Worker['postMessage']>{
   const frame=args[0] as unknown;
   const kind=frame!==null&&typeof frame==='object'?Object.getOwnPropertyDescriptor(frame,'kind')?.value:undefined;
   if(kind==='native-services')observe(this);
   // Always deliver the real original frame and its original transfer list.
   const result=Reflect.apply(originalPost,this,args);
   if(injectionCount===0&&requester===this&&((protocolMode==='duplicate-bootstrap'&&kind==='sequential-mutation-broker-bootstrap')||(protocolMode==='duplicate-initialized'&&kind==='services-initialized'))){
    injectionCount++;Worker.prototype.postMessage=originalPost;
    const duplicate=protocolMode==='duplicate-bootstrap'?{version:2,kind:'sequential-mutation-broker-bootstrap'}:{version:1,kind:'services-initialized'};
    // No second transfer or fabricated native success accompanies the duplicate.
    Reflect.apply(originalPost,this,[duplicate]);
   }
   return result;
   };
   // 948 captures Worker.prototype.postMessage at module evaluation. Import
   // only after this fixture interceptor is installed, never patch production.
   const {createPersistentResidentRegistration,createPersistentResidentNormalComponent}=await import('../../src/runtime/persistent-resident-store-role.ts');
   component=createPersistentResidentNormalComponent(createPersistentResidentRegistration(path),'fixture-runtime');
   if(protocolMode==='unrelated-after-ready'){
    await component.ready();assert.equal(component.snapshot().state,'ready');assert.notEqual(requester,null);Worker.prototype.postMessage=originalPost;injectionCount++;
    Reflect.apply(originalPost,requester!,[{kind:'unrelated-passive-fixture-frame'}]);
   }else await assert.rejects(component.ready());
   await component.join();joinFulfilled=true;assert.equal(injectionCount,1);assert.equal(actualExit,true);assert.equal(exitCode,1);
   const snapshot=component.snapshot();assert.equal(snapshot.state,'quarantined');assert.equal(snapshot.exited,true);assert.equal(snapshot.registrationLive,false);assert.equal(snapshot.rootDebt,true);
   await assert.rejects(component.closeComponent());assert.throws(()=>createPersistentResidentRegistration(path),/debt/);
  }catch(error){hasPrimary=true;primary=error;throw error;}finally{
   const cleanupErrors:unknown[]=[];
   try{Worker.prototype.postMessage=originalPost;}catch(error){cleanupErrors.push(error);}
   // A returned handle retains its one original join even when the test's
   // primary assertion failed. No synthetic close, scenario, or terminate.
   if(component!==null){try{await component.join();joinFulfilled=true;}catch(error){cleanupErrors.push(error);}}
   const settled=component?.snapshot();
   if(joinFulfilled&&actualExit&&settled?.state==='joined'&&settled.exited===true&&settled.rootDebt===false&&settled.registrationLive===false&&settled.servicesClosed===true&&settled.mutationJoined===true){
    try{
     assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);
     const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);
     assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
     rmSync(root,{recursive:true});
    }catch(error){cleanupErrors.push(error);}
   }else if(!hasPrimary&&cleanupErrors.length===0&&joinFulfilled&&actualExit&&exitCode===1&&injectionCount===1&&settled?.state==='quarantined'&&settled.exited===true&&settled.registrationLive===false&&settled.rootDebt===true){
    // Expected quarantine is an explicit retained outcome, never permission to
    // delete a root or infer responder/native closure from requester exit.
    try{
     assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);
     const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);
     assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
     assert.equal(typeof settled.servicesClosed,'boolean');assert.equal(typeof settled.mutationJoined,'boolean');
     retainedWitness=protocolWitness(protocolMode as ProtocolMode,protocolRunNonce!,settled.servicesClosed,settled.mutationJoined);
    }catch(error){cleanupErrors.push(error);}
   }else cleanupErrors.push(new Error(`Disposable protocol fixture retained without confirmed debt-free normal closure: ${root}`));
   if(cleanupErrors.length!==0)throw new AggregateError(hasPrimary?[primary,...cleanupErrors]:cleanupErrors,'Protocol-negative fixture cleanup remains unconfirmed',hasPrimary?{cause:primary}:undefined);
  }
  assert.notEqual(retainedWitness,undefined,'Expected retained-quarantine witness is missing');
  // Only fixed scalars leave this child: no filesystem paths, raw errors or
  // fabricated physical cleanup success. The aggregate gate remains unmet.
  t.diagnostic(PROTOCOL_WITNESS_MARKER+JSON.stringify(retainedWitness));
 });
}

