import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createMainNativeCodecBroker,type MainNativeCodecBroker} from '../../src/runtime/native-codec-broker-owner.ts';
import {
 calculateBrokerReservation,validateBrokerLimits,isGatewayInput,validateGatewayResult,validateAndFreezeGatewayResult,
 validateRequestEnvelope,validateReplyEnvelope,isBrokerCounter,isBrokerEpoch,
 type NativeCodecBrokerLimits,
} from '../../src/runtime/native-codec-broker-protocol.ts';
import {RemoteNativeCodecOwner} from '../../src/remote-agent/native-decode.ts';
import {ownedWorkerUsage,OWNED_WORKER_LIMITS,OwnedWorkerBudgetError,OwnedWorkerSlot} from '../../src/runtime/owned-worker-slot.ts';

/** This qualification never exposes a private broker port, mutates an adapter,
 * changes the original native timeout, terminates a requester, or induces crash.
 * Fixed malformed sender cases qualify only their explicit owner transitions.
 * Actual counter exhaustion, malformed client replies, arbitrary cross-thread
 * acceptance loss, constructor-transfer failure, native-deadline timeout, direct
 * worker guard, and abrupt requester death remain unqualified. The synthetic
 * main-stall case observes timeout, not production latency or no-late-start. */
const HELLO='{"type":"hello_ack","protocol_version":10}';
const COMMAND='{"type":"read_file","request_id":"request-1","thread_id":"thread-1","deadline_at":"2026-01-02T03:04:05Z","path":"ordinary/data.txt","start_line":1,"max_lines":20}';
const EPOCH='0123456789abcdef0123456789abcdef';
const BASE:NativeCodecBrokerLimits=Object.freeze({
 maxInputBytes:2048,maxResultStringUnits:2048+32768,
 maxRetainedPayloadBytes:calculateBrokerReservation(2048).requiredPayloadBytes,
 nativeTimeoutMs:6000,handshakeTimeoutMs:5000,exchangeTimeoutMs:5000,terminalRetentionMs:5000,minStatusIntervalMs:5,
});
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function fixtureUrl():URL {
 const url=new URL('./fixtures/native-codec-broker-client-worker.ts',import.meta.url);
 if(import.meta.url.endsWith('.js'))url.pathname=url.pathname.slice(0,-3)+'.js';
 return url;
}
interface Report {sequence:number;kind:string;body:any;}
interface Fixture {worker:Worker;reports:Report[];exit:Promise<number>;waitFor(kind:string,count?:number):Promise<Report>;}
function startFixture(scenario:string,frames:readonly string[]=[HELLO],pauseMs=0):Fixture {
 const worker=new Worker(fixtureUrl(),{workerData:{scenario,frames,pauseMs}}),reports:Report[]=[];
 let failure:Error|undefined;
 worker.on('error',error=>{failure=error;});
 worker.on('message',(value:Report)=>{reports.push(value);});
 const exit=new Promise<number>(resolve=>worker.once('exit',resolve));
 async function waitFor(kind:string,count=1):Promise<Report>{
  const deadline=performance.now()+14000;
  while(performance.now()<deadline){
   if(failure!==undefined)throw failure;
   const found=reports.filter(report=>report.kind===kind)[count-1];if(found!==undefined)return found;
   const failed=reports.find(report=>report.kind==='fixture-error'||report.kind==='fixture-expired');
   if(failed!==undefined)throw new Error('Requester fixture failed: '+JSON.stringify(failed));
   await delay(5);
  }
  throw new Error('Requester report deadline: '+kind);
 }
 return {worker,reports,exit,waitFor};
}
async function finish(root:MainNativeCodecBroker,fixture:Fixture):Promise<void> {
 root.close();root.close();await root.join();assert.equal(await fixture.exit,0);
 assert.equal(root.status().state,'closed-joined');assert.equal(root.status().nativeRetention,false);
 assert.equal(root.status().retainedRequestId,null);assert.equal(root.status().reservedPayloadBytes,0);
 assert.equal(root.status().queuedSubmissions,0);
 assert.deepEqual(fixture.reports.map(report=>report.sequence),fixture.reports.map((_,i)=>i+1));
 assert.ok(fixture.reports.length<=32);
}
function assertFailure(value:any,error:string):void{assert.deepEqual(value,{ok:false,error});}
function envelope(kind:string,requestId:number|null,body:unknown=null):unknown{return {v:1,epoch:EPOCH,exchangeId:1,kind,requestId,body};}

// Pure config/accounting and passive-data tests run no native work.
test('broker construction limits preserve full source output and clone-overlap reservation',()=>{
 for(const bytes of [1,2048,12000000]){
  const reservation=calculateBrokerReservation(bytes);
  assert.equal(reservation.inputPayloadBytes,2*bytes);
  assert.equal(reservation.resultPayloadBytes,2*(bytes+32768)+8*4096+4096);
  assert.equal(reservation.requiredPayloadBytes,3*reservation.inputPayloadBytes+4*reservation.resultPayloadBytes+4096);
  assert.equal(reservation.requiredPayloadBytes,14*bytes+413696);
  assert.equal(reservation.reservedResultValues,4*4096);assert.equal(reservation.reservedResultEdges,4*4095);
  assert.equal(reservation.reservedEnvelopeValues,256);assert.equal(reservation.reservedEnvelopeEdges,256);
  assert.equal(reservation.requiredGraphValues,16640);assert.equal(reservation.requiredGraphEdges,16636);
  const copy=validateBrokerLimits({...BASE,maxInputBytes:bytes,maxResultStringUnits:1,maxRetainedPayloadBytes:reservation.requiredPayloadBytes});
  assert.ok(Object.isFrozen(copy));assert.equal(copy.maxRetainedPayloadBytes,reservation.requiredPayloadBytes);
 }
 assert.notEqual(validateBrokerLimits(BASE),BASE);
 for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER,12000001])assert.throws(()=>calculateBrokerReservation(value));
 for(const field of Object.keys(BASE) as (keyof NativeCodecBrokerLimits)[]){
  const missing:Record<string,unknown>={...BASE};delete missing[field];assert.throws(()=>validateBrokerLimits(missing));
  for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateBrokerLimits({...BASE,[field]:value}));
 }
 for(const change of [{maxInputBytes:12000001},{maxResultStringUnits:BASE.maxInputBytes+32769},{maxRetainedPayloadBytes:BASE.maxRetainedPayloadBytes-1},{nativeTimeoutMs:10001},{exchangeTimeoutMs:2147483648},{extra:true}])assert.throws(()=>validateBrokerLimits({...BASE,...change}));
 const maximum=validateBrokerLimits({...BASE,nativeTimeoutMs:10000,handshakeTimeoutMs:2147483647,exchangeTimeoutMs:2147483647,terminalRetentionMs:2147483647,minStatusIntervalMs:2147483647,maxRetainedPayloadBytes:Number.MAX_SAFE_INTEGER});
 assert.equal(maximum.nativeTimeoutMs,10000);
});

test('primitive UTF-8 input and passive config reject active behavior before reflection',()=>{
 let traps=0;const active=new Proxy({}, {get(){traps++;throw new Error('get');},ownKeys(){traps++;throw new Error('keys');},getPrototypeOf(){traps++;throw new Error('proto');}});
 assert.equal(isGatewayInput(active,8),false);assert.throws(()=>validateBrokerLimits(active));
 const getter={...BASE};Object.defineProperty(getter,'maxInputBytes',{enumerable:true,get(){traps++;return 2048;}});
 assert.throws(()=>validateBrokerLimits(getter));assert.equal(traps,0);
 assert.equal(isGatewayInput('é',1),false);assert.equal(isGatewayInput('é',2),true);
 assert.equal(isGatewayInput('😀',3),false);assert.equal(isGatewayInput('😀',4),true);
 assert.equal(isGatewayInput('abc',2),false);assert.equal(isGatewayInput(new String('abc'),3),false);
 assert.equal(isGatewayInput('',1),true); // The original parser decides whether empty JSON is valid.
});

test('result graph accounting is bounded, passive and frozen only after full validation',()=>{
 const result={type:'hello_ack',protocol_version:10n};
 assert.deepEqual(validateGatewayResult(result,29),{visitedValues:3,edges:2,stringUnits:29,bigintCount:1,booleanCount:0,payloadBytes:66});
 assert.throws(()=>validateGatewayResult(result,28));assert.equal(Object.isFrozen(result),false);
 assert.equal(validateAndFreezeGatewayResult(result,29),result);assert.ok(Object.isFrozen(result));
 const nested={type:'project_info',data:[null,true,false,-9223372036854775808n,18446744073709551615n,{text:'é'}]};
 validateAndFreezeGatewayResult(nested,1000);assert.ok(Object.isFrozen(nested.data));assert.ok(Object.isFrozen(nested.data[5]));
 const plain=Object.assign(Object.create(null),{type:'hello_ack',protocol_version:10n});assert.doesNotThrow(()=>validateGatewayResult(plain,100));
 const cycle:any={type:'hello_ack'};cycle.self=cycle;
 const sparse=Array(2);sparse[1]=null;
 const extended:any[]=[null];Object.assign(extended,{extra:null});
 for(const bad of [cycle,{type:'unknown'},{type:'hello_ack',value:1},{type:'hello_ack',value:undefined},{type:'hello_ack',value:new Date()},{type:'hello_ack',value:new Uint8Array(1)},{type:'hello_ack',value:sparse},{type:'hello_ack',value:extended},{type:'hello_ack',value:18446744073709551616n},{type:'hello_ack',value:-9223372036854775809n}])assert.throws(()=>validateGatewayResult(bad,10000));
 let traps=0;const proxy=new Proxy({type:'hello_ack'},{getPrototypeOf(){traps++;throw new Error('proxy');},ownKeys(){traps++;throw new Error('proxy');}});
 const getter={type:'hello_ack'};Object.defineProperty(getter,'active',{enumerable:true,get(){traps++;return null;}});
 const symbol={type:'hello_ack',[Symbol('extra')]:null};
 const hidden={type:'hello_ack'};Object.defineProperty(hidden,'hidden',{value:null});
 for(const bad of [proxy,getter,symbol,hidden])assert.throws(()=>validateGatewayResult(bad,1000));assert.equal(traps,0);
 const safe={value:null},invalid={type:'hello_ack',safe,bad:undefined};assert.throws(()=>validateAndFreezeGatewayResult(invalid,100));assert.equal(Object.isFrozen(safe),false);assert.equal(Object.isFrozen(invalid),false);
 const values={type:'hello_ack',values:Array.from({length:4094},()=>null)};assert.throws(()=>validateGatewayResult(values,20000));
 let deep:unknown=null;for(let i=0;i<17;i++)deep={next:deep};assert.throws(()=>validateGatewayResult({type:'hello_ack',deep},1000));
});

test('closed envelope validators reject malformed data but do not claim sequence-state qualification',()=>{
 assert.ok(isBrokerEpoch(EPOCH));assert.equal(isBrokerEpoch(EPOCH.toUpperCase()),false);
 assert.ok(isBrokerCounter(Number.MAX_SAFE_INTEGER));for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(isBrokerCounter(value),false);
 for(const value of [envelope('ready',null),envelope('close',null),envelope('status',1),envelope('cancel',1),envelope('acknowledge-terminal',1),envelope('submit',1,{operation:'remote.gateway.decode.v1',raw:HELLO})])assert.ok(validateRequestEnvelope(value,EPOCH));
 const good=envelope('status',1) as Record<string,unknown>;
 for(const value of [{...good,extra:true},{...good,epoch:'f'.repeat(32)},{...good,exchangeId:0},{...good,requestId:null},{...good,body:{}},{...good,kind:'retry'},envelope('submit',1,{operation:'other',raw:HELLO}),envelope('submit',1,{operation:'remote.gateway.decode.v1',raw:HELLO,callback:null})])assert.equal(validateRequestEnvelope(value,EPOCH),null);
 for(const value of [envelope('ready-ack',null),envelope('accepted',1,{accepted:true}),envelope('not-accepted',1,{reason:'invalid-input'}),envelope('status',1,{state:'pending',cancellationRequested:false,nativeOwnership:'retained-or-not-started'}),envelope('status',1,{state:'joined-result',cancellationRequested:false,result:{type:'hello_ack',protocol_version:10n}}),envelope('status',1,{state:'joined-error',cancellationRequested:false,error:'adapter-failed'}),envelope('status',1,{state:'delivered-await-ack',cancellationRequested:true}),envelope('status',1,{state:'retired-no-replay'}),envelope('terminal-ack',1),envelope('close-status',null,{state:'closing-retained'}),envelope('protocol-error',null,{code:'invalid-protocol'})])assert.ok(validateReplyEnvelope(value,EPOCH,1000));
 for(const value of [envelope('status',1,{state:'pending',cancellationRequested:false,nativeOwnership:'started'}),envelope('status',1,{state:'joined-error',cancellationRequested:false,error:new Error('opaque')}),envelope('status',1,{state:'joined-result',cancellationRequested:false,result:{type:'hello_ack',opaque:1}}),envelope('terminal-ack',1,{result:null}),envelope('protocol-error',null,{code:'arbitrary'})])assert.equal(validateReplyEnvelope(value,EPOCH,1000),null);
 let traps=0;const proxy=new Proxy(good,{getPrototypeOf(){traps++;throw new Error('proxy');}});assert.equal(validateRequestEnvelope(proxy,EPOCH),null);
 const getter={...good};Object.defineProperty(getter,'kind',{enumerable:true,get(){traps++;return 'status';}});assert.equal(validateRequestEnvelope(getter,EPOCH),null);assert.equal(traps,0);
});

test('one main root and endpoint lifetime reject proxies and duplicate binding before extra work',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE);let traps=0;
 const proxy=new Proxy({}, {getPrototypeOf(){traps++;throw new Error('proxy');},ownKeys(){traps++;throw new Error('proxy');}});
 assert.throws(()=>root.bindRequester(proxy as Worker));assert.equal(traps,0);assert.equal(root.status().endpointBound,false);
 assert.throws(()=>createMainNativeCodecBroker(BASE));
 const fixture=startFixture('idle',[],100);
 try{
  let overridden=0;Object.defineProperty(fixture.worker,'postMessage',{value(){overridden++;throw new Error('override must not run');},configurable:true});
  root.bindRequester(fixture.worker);assert.throws(()=>root.bindRequester(fixture.worker));
  await fixture.waitFor('ready');assert.equal(overridden,0);assert.equal(root.status().endpointBound,true);
  await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
 assert.throws(()=>root.bindRequester(fixture.worker));
 const replacement=createMainNativeCodecBroker(BASE);replacement.close();await replacement.join();
});

test('persistent requester decodes hello and command through original native workers and acknowledges each terminal once',{timeout:25000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('round-trip',[HELLO,COMMAND]);
 const nativeWorkers:Worker[]=[],exits:number[]=[];
 const observe=(worker:Worker)=>{if(worker===fixture.worker)return;nativeWorkers.push(worker);worker.once('exit',code=>exits.push(code));};
 process.on('worker',observe);
 try{
  root.bindRequester(fixture.worker);
  const first=(await fixture.waitFor('terminal',1)).body,second=(await fixture.waitFor('terminal',2)).body;
  assert.deepEqual(first.submission,{accepted:true,requestId:1});assert.deepEqual(second.submission,{accepted:true,requestId:2});
  assert.deepEqual(first.status,{state:'joined-result',cancellationRequested:false,result:{type:'hello_ack',protocol_version:10n}});
  assert.equal(second.status.state,'joined-result');assert.equal(second.status.result.type,'read_file');
  assert.equal(second.status.result.path,'ordinary/data.txt');assert.equal(second.status.result.start_line,1n);assert.equal(second.status.result.max_lines,20n);
  assert.deepEqual(second.status.result.deadline_at,{seconds:1767323045n,nanosecond:0n});
  for(const report of [first,second]){
   assert.equal(report.frozen,true);assertFailure(report.earlyAcknowledgement,'InvalidRequest');assertFailure(report.retainedSubmit,'Busy');
   assert.deepEqual(report.delivered,{state:'delivered-await-ack',cancellationRequested:false});assert.deepEqual(report.lateCancel,{state:'delivered-await-ack',cancellationRequested:true});
  }
  await fixture.waitFor('done');
  assert.equal(nativeWorkers.length,2);assert.deepEqual(exits,[0,0]);
  for(const report of fixture.reports.filter(report=>report.kind==='retired')){
   assert.deepEqual(report.body.retired,{state:'retired-no-replay'});assert.deepEqual(report.body.cancelledRetired,{state:'retired-no-replay'});
  }
 }finally{process.off('worker',observe);await finish(root,fixture);}
 assert.equal(ownedWorkerUsage().Background,0);
});

test('invalid JSON is accepted responsibility then reports the original joined adapter failure',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('invalid-json',['{']);
 let constructed=0,exited=0;const observe=(worker:Worker)=>{if(worker!==fixture.worker){constructed++;worker.once('exit',()=>{exited++;});}};process.on('worker',observe);
 try{
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('terminal')).body;
  assert.equal(report.submission.accepted,true);assert.deepEqual(report.status,{state:'joined-error',cancellationRequested:false,error:'adapter-failed'});
  assert.equal(constructed,1);assert.equal(exited,1);await fixture.waitFor('done');
 }finally{process.off('worker',observe);await finish(root,fixture);}
});

test('local input and credit refusals allocate no request holes and status polls are rate limited',{timeout:25000},async()=>{
 // A day-scale local limit makes this independent of message round-trip timing.
 // The fixture uses explicit cancel observations to finish after this one poll.
 const root=createMainNativeCodecBroker({...BASE,minStatusIntervalMs:2147483647}),fixture=startFixture('local-credit');
 try{
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('credit')).body;
  assert.equal(report.activeBehavior,0);assertFailure(report.invalidObject,'InvalidInput');assertFailure(report.invalidUtf8,'InvalidInput');
  assert.deepEqual(report.submission,{accepted:true,requestId:1});assertFailure(report.concurrent,'Busy');assertFailure(report.concurrentStatus,'Busy');assertFailure(report.rateLimited,'StatusRateLimited');
  assert.deepEqual((await fixture.waitFor('next')).body,{accepted:true,requestId:2});await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
});

test('cancel and close latches are shared, bounded and preserve close priority',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('cancel-close');
 try{
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('latches')).body;
  assert.equal(report.sameCancel,true);assert.equal(report.sameClose,true);assertFailure(report.cancel,'EndpointClosed');
  assert.deepEqual(report.close,{ok:true,value:{state:'closing-retained'}});assertFailure(report.blockedSubmit,'EndpointClosed');
  assert.equal(root.status().queuedSubmissions,0);await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
});

test('immediate detach reports unknown acceptance without replay and joins original ownership',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('detach');
 try{
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('detached')).body;
  assertFailure(report.submission,'OutcomeUnknown');assertFailure(report.next,'EndpointClosed');assertFailure(report.priorStatus,'OutcomeUnknown');await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
 assert.equal(ownedWorkerUsage().Background,0);
});

test('TTL disposes terminal reservation without assuming result versus close ordering',{timeout:20000},async context=>{
 const root=createMainNativeCodecBroker({...BASE,terminalRetentionMs:500}),fixture=startFixture('retain-terminal',[HELLO],1200);
 try{
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('terminal')).body;
  assert.equal(report.status.state,'joined-result');assert.equal(report.frozen,true);
  const retained=root.status();assert.equal(retained.nativeRetention,false);
  // Main may observe this report after the TTL has already fired. Assert the
  // observed branch; never manufacture cross-thread result/close ordering.
  if(retained.retainedRequestId===1){
   context.diagnostic('Observed terminal reservation before endpoint disposal.');
   assert.equal(retained.reservedPayloadBytes,BASE.maxRetainedPayloadBytes);
   assert.equal(retained.reservedGraphValues,16640);assert.equal(retained.reservedGraphEdges,16636);
   assert.throws(()=>createMainNativeCodecBroker(BASE));
  }else{
   context.diagnostic('TTL disposed before the report was observed; this run does not establish the pre-disposal retention observation.');
   assert.equal(retained.state,'closed-joined');assert.equal(retained.reservedPayloadBytes,0);
  }
  await root.join();assert.equal(root.status().state,'closed-joined');assert.equal(root.status().reservedPayloadBytes,0);
  const after=(await fixture.waitFor('after-retention')).body;
  assertFailure(after.status,'EndpointClosed');assertFailure(after.submit,'EndpointClosed');assertFailure(after.ack,'EndpointClosed');
  assert.throws(()=>root.bindRequester(fixture.worker));await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
});

test('broker and direct original codecs share exactly Background3 and release on actual exits',{timeout:25000},async()=>{
 assert.deepEqual(OWNED_WORKER_LIMITS,{Background:3,Control:1,Bridge:1,Observation:2,Discovery:1,Maintenance:1});assert.equal(ownedWorkerUsage().Background,0);
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('round-trip',[HELLO]);
 const direct=Array.from({length:3},()=>new RemoteNativeCodecOwner());
 const nativeWorkers:Worker[]=[],exitCodes:number[]=[];let launched=false,observedAtLaunch=-1;
 let directResults:Promise<{ok:boolean;error?:unknown}>[]=[];
 const observe=(worker:Worker):void=>{
  if(worker===fixture.worker)return;
  nativeWorkers.push(worker);worker.once('exit',code=>exitCodes.push(code));
  if(launched)return;launched=true;observedAtLaunch=ownedWorkerUsage().Background;
  // The process worker event is construction observation. Set the guard BEFORE
  // constructing two additional original workers so recursive events are finite.
  directResults=direct.map(owner=>owner.decodeGatewayMessageOffThread(HELLO,BASE.maxInputBytes,undefined,BASE.nativeTimeoutMs).then(()=>({ok:true}),error=>({ok:false,error})));
 };
 process.on('worker',observe);
 try{
  root.bindRequester(fixture.worker);await fixture.waitFor('terminal');await fixture.waitFor('done');
  assert.equal(launched,true);assert.equal(observedAtLaunch,1);
  const results=await Promise.all(directResults);assert.equal(results.length,3);
  assert.equal(results.filter(result=>result.ok).length,2);
  const refused=results.filter(result=>!result.ok);assert.equal(refused.length,1);assert.ok(refused[0]!.error instanceof OwnedWorkerBudgetError);
  await Promise.all(direct.map(owner=>owner.join()));
  assert.equal(nativeWorkers.length,3);assert.deepEqual(exitCodes,[0,0,0]);
  assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
 }finally{process.off('worker',observe);await Promise.all(direct.map(owner=>owner.join()));await finish(root,fixture);}
});

test('repeated owner close shares one join and preserves singleton until actual native exit and transport disposal',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('round-trip');
 const join=root.join();let constructions=0,exits=0,sameJoin=true,retainedWhileClosing=false,singletonRefused=false;
 const observe=(worker:Worker):void=>{
  if(worker===fixture.worker)return;
  constructions++;worker.once('exit',()=>{exits++;});
  for(let count=0;count<1000;count++){root.close();sameJoin&&=root.join()===join;}
  retainedWhileClosing=root.status().nativeRetention&&root.status().reservedPayloadBytes===BASE.maxRetainedPayloadBytes;
  try{createMainNativeCodecBroker(BASE);}catch{singletonRefused=true;}
 };
 process.on('worker',observe);
 try{
  root.bindRequester(fixture.worker);
  // Closing can beat the submit ACK or its first status. The fixture catches
  // that transport loss; neither possible observation is a replay certificate.
  assert.equal(await fixture.exit,0);await join;
  const errors=fixture.reports.filter(report=>report.kind==='fixture-error');
  assert.equal(errors.length,1);assert.ok(['OutcomeUnknown','EndpointClosed'].includes(errors[0]!.body.error));
  assert.equal(fixture.reports.some(report=>report.kind==='fixture-expired'),false);
  assert.equal(constructions,1);assert.equal(exits,1);assert.equal(sameJoin,true);
  assert.equal(retainedWhileClosing,true);assert.equal(singletonRefused,true);
  assert.equal(root.join(),join);assert.equal(root.status().state,'closed-joined');
  assert.equal(root.status().reservedGraphValues,0);assert.equal(root.status().reservedGraphEdges,0);
 }finally{process.off('worker',observe);await finish(root,fixture);}
 const replacement=createMainNativeCodecBroker(BASE);replacement.close();await replacement.join();
});

test('narrow result limit rejects the joined result without reducing the original output reservation',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker({...BASE,maxResultStringUnits:1}),fixture=startFixture('invalid-json',[HELLO]);
 try{
  assert.equal(root.status().reservationCapacityBytes,BASE.maxRetainedPayloadBytes);
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('terminal')).body;
  assert.deepEqual(report.status,{state:'joined-error',cancellationRequested:false,error:'invalid-result'});
  await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
});

test('handshake deadline closes a deliberately deferred bootstrap without native submission',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker({...BASE,handshakeTimeoutMs:50}),fixture=startFixture('delayed-bootstrap',[],500);
 let constructions=0;const observe=(worker:Worker)=>{if(worker!==fixture.worker)constructions++;};process.on('worker',observe);
 try{
  root.bindRequester(fixture.worker);await root.join();assert.equal(await fixture.exit,0);
  assert.equal(root.status().state,'closed-joined');assert.equal(constructions,0);
  assert.equal(fixture.reports.some(report=>report.kind==='ready'),false);
  assert.ok(fixture.reports.some(report=>report.kind==='fixture-error'));
  assert.throws(()=>root.bindRequester(fixture.worker));
 }finally{process.off('worker',observe);await finish(root,fixture);}
});

test('unexpected parent input after initialization fails the fixed bootstrap closed',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('idle',[],500);
 try{
  root.bindRequester(fixture.worker);await fixture.waitFor('ready');
  // Deliberate invalid bootstrap input, never an application instruction.
  fixture.worker.postMessage({v:1,kind:'unexpected-bootstrap-input'});
  await root.join();assert.equal(root.status().retainedRequestId,null);
  const close=(await fixture.waitFor('close')).body;assertFailure(close,'EndpointClosed');await fixture.waitFor('done');
 }finally{await finish(root,fixture);}
});

for(const [scenario,nativeCount] of [
 ['negative-epoch',0],['negative-sequence',0],['negative-surplus',0],['negative-kind',0],
 ['negative-request-id',0],['negative-ready',0],['negative-stale',0],['negative-counter',0],
 ['negative-duplicate',1],['negative-duplicate-submit',1],['negative-busy',1],
 ['negative-retirement-hole',1],['negative-early-ack',1],
] as const){
 test('fixed malformed sender closes owner without extra admission: '+scenario,{timeout:20000},async()=>{
  const root=createMainNativeCodecBroker(BASE),fixture=startFixture(scenario);
  let constructions=0;const exits:number[]=[];
  const observe=(worker:Worker)=>{if(worker!==fixture.worker){constructions++;worker.once('exit',code=>exits.push(code));}};
  process.on('worker',observe);
  try{
   root.bindRequester(fixture.worker);await fixture.waitFor('wire-closed');await fixture.waitFor('done');await root.join();
   const replies=fixture.reports.filter(report=>report.kind==='wire-response').map(report=>report.body);
   assert.equal(replies[0]?.kind,'ready-ack');
   assert.equal(replies.filter(reply=>reply.kind==='accepted').length,nativeCount);
   assert.equal(replies.filter(reply=>reply.kind==='status').length,0);
   for(const reply of replies.filter(reply=>reply.kind==='protocol-error'))assert.deepEqual(reply.body,{code:'invalid-protocol'});
   assert.equal(constructions,nativeCount);assert.deepEqual(exits,Array.from({length:nativeCount},()=>0));
   assert.equal(root.status().retiredThrough,0);assert.equal(root.status().queuedSubmissions,0);
   assert.equal(root.status().nativeRetention,false);assert.equal(root.status().reservedPayloadBytes,0);
   assert.throws(()=>root.bindRequester(fixture.worker));
  }finally{process.off('worker',observe);await finish(root,fixture);}
 });
}

test('main-side UTF-8 refusal retires exactly its request without invoking original adapter',{timeout:20000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('negative-input');
 let constructions=0;const observe=(worker:Worker)=>{if(worker!==fixture.worker)constructions++;};process.on('worker',observe);
 try{
  root.bindRequester(fixture.worker);await fixture.waitFor('wire-closed');await fixture.waitFor('done');await root.join();
  const replies=fixture.reports.filter(report=>report.kind==='wire-response').map(report=>report.body);
  assert.deepEqual(replies.map(reply=>reply.kind),['ready-ack','not-accepted','status','close-status']);
  assert.equal(replies[1]!.requestId,1);assert.deepEqual(replies[1]!.body,{reason:'invalid-input'});
  assert.deepEqual(replies[2]!.body,{state:'retired-no-replay'});assert.equal(root.status().retiredThrough,1);
  assert.equal(constructions,0);
 }finally{process.off('worker',observe);await finish(root,fixture);}
});

test('fixed synthetic main stall yields exchange timeout and unknown outcome without replay',{timeout:20000},async context=>{
 const root=createMainNativeCodecBroker({...BASE,exchangeTimeoutMs:20}),fixture=startFixture('exchange-timeout');
 const gate=new Int32Array(new SharedArrayBuffer(4));let stalls=0,stallResult='',stallElapsed=0,constructions=0;
 const exits:number[]=[];
 const observe=(worker:Worker)=>{if(worker!==fixture.worker){constructions++;worker.once('exit',code=>exits.push(code));}};
 const stall=(report:Report):void=>{
  if(report.kind!=='ready-for-stall')return;
  stalls++;const start=performance.now();stallResult=Atomics.wait(gate,0,0,100);stallElapsed=performance.now()-start;
 };
 process.on('worker',observe);fixture.worker.on('message',stall);
 try{
  // Listener is attached before bootstrap. Requester waits exactly 25 ms after
  // its report; the client has a 20 ms exchange timer while main stalls 100 ms.
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('timed-out')).body;
  assert.equal(stalls,1);assert.equal(stallResult,'timed-out');
  assertFailure(report.submission,'OutcomeUnknown');assertFailure(report.next,'EndpointClosed');assertFailure(report.priorStatus,'OutcomeUnknown');
  await fixture.waitFor('done');await root.join();
  assert.ok(constructions===0||constructions===1);assert.deepEqual(exits,Array.from({length:constructions},()=>0));
  context.diagnostic('Synthetic main stall observed '+stallElapsed.toFixed(1)+' ms; actual native constructions '+constructions+'. Neither number is a production latency or no-late-start guarantee.');
 }finally{fixture.worker.off('message',stall);process.off('worker',observe);await finish(root,fixture);}
});

test('three gated actual Background workers make broker adapter fail without a fourth native construction',{timeout:25000},async()=>{
 const root=createMainNativeCodecBroker(BASE),fixture=startFixture('invalid-json',[HELLO]);
 const helper=new URL('../helpers/native-mixed-lane-worker.ts',import.meta.url);
 if(import.meta.url.endsWith('.js'))helper.pathname=helper.pathname.slice(0,-3)+'.js';
 const slots=Array.from({length:3},()=>new OwnedWorkerSlot('Background'));
 const states=Array.from({length:3},()=>new Int32Array(new SharedArrayBuffer(16)));
 const pending:Promise<{ok:true;value:unknown}|{ok:false;error:unknown}>[]=[];
 let constructions=0;const exits:number[]=[];
 const observe=(worker:Worker)=>{if(worker!==fixture.worker){constructions++;worker.once('exit',code=>exits.push(code));}};
 process.on('worker',observe);
 try{
  for(let index=0;index<3;index++){
   // Attach failure handling immediately: a run timeout is not actual exit.
   pending.push(slots[index]!.run(helper,{id:'broker-load-'+index,shared:states[index]!.buffer,offered:'bounded'},6000).then(value=>({ok:true as const,value}),error=>({ok:false as const,error})));
  }
  const deadline=performance.now()+2000;
  while(states.some(state=>Atomics.load(state,1)!==1)&&performance.now()<deadline)await delay(5);
  assert.ok(states.every(state=>Atomics.load(state,1)===1));
  assert.equal(constructions,3);assert.equal(ownedWorkerUsage().Background,3);
  root.bindRequester(fixture.worker);const report=(await fixture.waitFor('terminal')).body;
  assert.deepEqual(report.submission,{accepted:true,requestId:1});
  assert.deepEqual(report.status,{state:'joined-error',cancellationRequested:false,error:'adapter-failed'});
  assert.equal(constructions,3);assert.equal(exits.length,0);assert.equal(ownedWorkerUsage().Background,3);
  assert.ok(states.every(state=>Atomics.load(state,0)===0&&Atomics.load(state,3)===0));
  await fixture.waitFor('done');
 }finally{
  // Both gates must open even if an assertion fails or run() timed out. The
  // original slot joins remain awaited until those actual workers have exited.
  for(const state of states){Atomics.store(state,0,1);Atomics.store(state,3,1);Atomics.notify(state,0);Atomics.notify(state,3);}
  await Promise.all(pending);await Promise.all(slots.map(slot=>slot.join()));
  process.off('worker',observe);await finish(root,fixture);
 }
 const results=await Promise.all(pending);assert.ok(results.every(result=>result.ok));
 assert.equal(constructions,3);assert.deepEqual(exits,[0,0,0]);
 assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
});
