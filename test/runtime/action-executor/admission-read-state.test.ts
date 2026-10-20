import assert from 'node:assert/strict';
import {it} from 'node:test';
import {captureAdmissionReads,type AdmissionReads} from '../../../src/runtime/action-executor/admission-read-state.ts';
import {validateLifecycleSettingsSnapshot} from '../../../src/runtime/action-executor/settings-snapshot.ts';
const empty=():AdmissionReads=>({getIngress:async()=>null,ingressByOrigin:async()=>null,mirroredThreadId:async()=>null});
it('admission reads capture passive functions, bind every path and ignore later replacement',async()=>{
 const source=empty(),port=captureAdmissionReads('original',source);let hooks=0;
 for(const key of ['getIngress','ingressByOrigin','mirroredThreadId'] as const)(source as any)[key]=()=>{hooks++;throw Error('replacement');};
 assert.equal(await port.getIngress('original','key'),null);assert.equal(await port.ingressByOrigin('original',1n),null);assert.equal(await port.mirroredThreadId('original',1n),null);assert.ok(Object.isFrozen(port));assert.equal(hooks,0);
 assert.throws(()=>port.getIngress('other','key'),/another database/);assert.throws(()=>port.ingressByOrigin('other',1n),/another database/);assert.throws(()=>port.mirroredThreadId('other',1n),/another database/);assert.equal(hooks,0);
 for(const key of ['getIngress','ingressByOrigin','mirroredThreadId'] as const){
  const active=Object.defineProperty(empty(),key,{get(){hooks++;return async()=>null;}});assert.throws(()=>captureAdmissionReads('original',active),TypeError);
  for(const value of [function*(){hooks++;},new Proxy(()=>{hooks++;},{apply(){hooks++;}}),null])assert.throws(()=>captureAdmissionReads('original',{...empty(),[key]:value} as AdmissionReads),TypeError);
 }
 assert.throws(()=>captureAdmissionReads('original',new Proxy(empty(),{getOwnPropertyDescriptor(){hooks++;return undefined;}})),TypeError);assert.equal(hooks,0);
});
it('admission reads require genuine Promises without assimilating a thenable or substituting a fallback',async()=>{
 let hooks=0;const thenable={then(){hooks++;}};
 for(const value of [null,thenable]){
  const port=captureAdmissionReads('p',{getIngress:()=>value,ingressByOrigin:()=>value,mirroredThreadId:()=>value} as unknown as AdmissionReads);
  assert.throws(()=>port.getIngress('p','k'),/Promise/);assert.throws(()=>port.ingressByOrigin('p',1n),/Promise/);assert.throws(()=>port.mirroredThreadId('p',1n),/Promise/);
 }
 const failure=new Error('unavailable'),port=captureAdmissionReads('p',{getIngress:async()=>{throw failure;},ingressByOrigin:async()=>{throw failure;},mirroredThreadId:async()=>{throw failure;}});
 await assert.rejects(port.getIngress('p','k'),e=>e===failure);await assert.rejects(port.ingressByOrigin('p',1n),e=>e===failure);await assert.rejects(port.mirroredThreadId('p',1n),e=>e===failure);assert.equal(hooks,0);
});
it('lifecycle route cancellation joins its mapping read before rejecting and starts no selected read',async()=>{
 const cancel=new AbortController(),reason=new Error('cancel joined mapping');let release!:(value:null)=>void,selected=0,settled=false;
 const mapping=new Promise<null>(r=>{release=r;}),pending=validateLifecycleSettingsSnapshot('p',{target:'root',route:'Selected',command:{Stop:{reference:null}}},1n,{selectedThreadId(){selected++;return 'root';}},{mirroredThreadId:()=>mapping},undefined,cancel.signal);
 void pending.then(()=>{settled=true;},()=>{settled=true;});const rejected=assert.rejects(pending,e=>e===reason);cancel.abort(reason);await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(selected,0);release(null);await rejected;assert.equal(selected,0);
});
