import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';

// Each scenario uses a fresh ordinary process. There is no quarantine reset API,
// forced worker termination, fake runtime guard or replacement native transport.
const scenarios=['drain','raw-prepared-expiry','bootstrap-stop','nonzero-close','receipts','row-changed','normal','busy','invalid-local','finite','headroom','unknown','sql-finish-failure','hold-requester','lost-begin','lost-begin-ack','lost-finish','lost-terminal-ack','raw-old-epoch','raw-exchange','raw-future-id','raw-kind','raw-early-finish','raw-duplicate-begin','raw-duplicate-ready','raw-extra-field','raw-retired-id'] as const;
for(const scenario of scenarios)test(`sequential SQLite component in isolated process: ${scenario}`,async()=>{
 const entry=ownedWorkerModuleUrl(new URL('./fixtures/sequential-resident-scenario.ts',import.meta.url),import.meta.url);
 const child=spawn(process.execPath,['--no-strip-types',fileURLToPath(entry),scenario],{stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{
  // Every fixture report begins the next exact 10000ms observation window. A
  // timeout rejects only; it neither kills a process nor certifies any join.
  let timer:ReturnType<typeof setTimeout>;
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>reject(Error(`Frozen child event/exit observation deadline: ${scenario}\n${output}\n${errors}`)),10000);};
  arm();child.stdout.on('data',arm);
  const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',arm);};
  child.once('error',error=>{cleanup();reject(error);});child.once('exit',code=>{cleanup();resolve(code);});
 });
 assert.equal(code,0,`${scenario}\n${output}\n${errors}`);assert.match(output,/"event":"passed"/);
});

import {calculateSequentialMutationBrokerReservation,validateSequentialMutationBrokerLimits,captureSequentialMutationClaim,validateSequentialMutationNativeResult,validateSequentialMutationRequest,validateSequentialMutationReply,sequentialMutationExchangeReservation,type SequentialMutationBrokerLimits} from '../../src/runtime/sequential-mutation-broker-protocol.ts';
const profile=Object.freeze({maxClaimUtf8Bytes:1048576,maxClaimStringUnits:1048576,maxClaimNodes:65536,maxClaimEdges:65536,maxClaimDepth:64,maxContainerEntries:65536,maxNativeResultUtf8Bytes:16384,maxRetainedLogicalBytes:22249600,maxRetainedNodes:393488,maxRetainedEdges:393484,nativeTimeoutMs:5000,handshakeTimeoutMs:5000,exchangeTimeoutMs:5000,preparedAwaitFinishTimeoutMs:5000,terminalRetentionMs:5000,minStatusIntervalMs:1,phaseObservationTimeoutMs:10000,maxOperationId:2147483647,maxExchangeId:2147483647} satisfies SequentialMutationBrokerLimits);
test('frozen sequential profile has exact reservation and finite complete-operation headroom',()=>{
 const limits=validateSequentialMutationBrokerLimits(profile);assert.ok(Object.isFrozen(limits));
 assert.deepEqual(calculateSequentialMutationBrokerReservation(limits),{lifecycleLogicalBytes:22249600,lifecycleNodes:393488,lifecycleEdges:393484,rootLogicalBytes:49152,rootNodes:192,rootEdges:192});
 assert.equal(sequentialMutationExchangeReservation({...profile,maxOperationId:2,maxExchangeId:64,minStatusIntervalMs:1000}),28);
 for(const key of Object.keys(profile)){const missing:Record<string,unknown>={...profile};delete missing[key];assert.throws(()=>validateSequentialMutationBrokerLimits(missing));assert.throws(()=>validateSequentialMutationBrokerLimits({...profile,[key]:0}));}
 assert.throws(()=>validateSequentialMutationBrokerLimits({...profile,extra:1}));
});
test('all three passive schemas reject extra identity, unsupported wires and expanded graph overflow',()=>{
 const ordinary={ownerId:'resident',generation:1n,attemptId:'a',wire:1n,method:'thread/settings/update',params:null,scoped:true,origin:null};
 const queue={ownerId:'resident',generation:1n,attemptId:'q',wire:'q-wire',method:'turn/start',params:null,claim:null};
 const stop={ownerId:'resident',generation:1n,attemptId:'s',wire:3n,params:null,claim:null};
 for(const [operation,input] of [['ordinary',ordinary],['queue',queue],['stop',stop]] as const){
  assert.ok(Object.isFrozen(captureSequentialMutationClaim(operation,input,profile)));
  assert.throws(()=>captureSequentialMutationClaim(operation,{...input,extra:true},profile));
  assert.throws(()=>captureSequentialMutationClaim(operation,{...input,wire:1},profile));
  assert.throws(()=>captureSequentialMutationClaim(operation,{...input,generation:9223372036854775808n},profile));
 }
 assert.throws(()=>captureSequentialMutationClaim('queue',{...queue,method:'thread/settings/update'},profile));
 assert.throws(()=>captureSequentialMutationClaim('stop',{...stop,method:'turn/interrupt'},profile));
 let reads=0;assert.throws(()=>captureSequentialMutationClaim('ordinary',new Proxy(ordinary,{get(){reads++;throw Error('must not read');}}),profile));
 assert.throws(()=>captureSequentialMutationClaim('ordinary',{...ordinary,params:Object.defineProperty({},'x',{enumerable:true,get(){reads++;return 1;}})},profile));assert.equal(reads,0);
 const cyclic:any={};cyclic.self=cyclic;assert.throws(()=>captureSequentialMutationClaim('ordinary',{...ordinary,params:cyclic},profile));
 let deep:unknown=null;for(let i=0;i<65;i++)deep={nested:deep};assert.throws(()=>captureSequentialMutationClaim('ordinary',{...ordinary,params:deep},profile));
 const alias={x:'value'};assert.throws(()=>captureSequentialMutationClaim('ordinary',{...ordinary,params:Array(32768).fill(alias)},profile));
 for(const params of [[,],new Date(),Number.NaN,Infinity,18446744073709551616n,'x'.repeat(1048577)])assert.throws(()=>captureSequentialMutationClaim('ordinary',{...ordinary,params},profile));
});
test('v2 wire and native success are exact, passive and bounded',()=>{
 const epoch='a'.repeat(32),frame={version:2,epoch,exchange:1,body:{kind:'ready'}};
 assert.ok(validateSequentialMutationRequest(frame,epoch,profile));
 for(const changed of [{...frame,version:1},{...frame,extra:true},{...frame,exchange:0},{...frame,exchange:2147483648},{...frame,body:{kind:'ready',operationId:1}}])assert.equal(validateSequentialMutationRequest(changed,epoch,profile),null);
 assert.ok(validateSequentialMutationReply({...frame,body:{kind:'ready',retiredThrough:0}},epoch));
 assert.equal(validateSequentialMutationReply({...frame,body:{kind:'rejected',reason:'busy'}},epoch),null);
 assert.equal(validateSequentialMutationNativeResult({ok:true},profile),true);
 for(const value of [{ok:true,extra:1},{ok:1},{ok:false},null,new Proxy({ok:true},{})]){let valid=false;try{valid=validateSequentialMutationNativeResult(value,profile);}catch{}assert.equal(valid,false);}
});
