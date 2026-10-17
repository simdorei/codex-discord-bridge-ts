import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storedIngressToWire,storedIngressFromWire,newIngressToWire,newIngressFromWire} from '../../../src/runtime/prompt-intake/native-journal-wire.ts';
import type {StoredIngress} from '../../../src/store/ingress-read.ts';
import type {NewIngress} from '../../../src/store/ingress-types.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
function stored():StoredIngress {return {ingressId:'action:한글😀',kind:'action',eventId:9223372036854775807n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:-9223372036854775808n,payload:{integer:1n,float:1,large:18446744073709551615n,nested:{v:'😀'}},runtimeId:'runtime',state:'held',phase:'started',targetThreadId:null,canonicalOwner:'canonical',ownerKind:'queue',ownerId:'job',outcome:undefined,confirmationDelivered:true,holdReason:'reason',createdAt:Infinity,updatedAt:-Infinity};}
function incoming():NewIngress {return {ingressId:'action:a',kind:'action',eventId:null,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{command:'new',prompt:'😀',n:18446744073709551615n,f:1},targetThreadId:null,canonicalOwner:null,now:4};}
function wire():Record<string,unknown> {return storedIngressToWire(stored()) as Record<string,unknown>;}
test('complete stored record survives structured clone with exact i64 and Serde numeric kinds',()=>{
 const source=stored(),copy=storedIngressFromWire(structuredClone(storedIngressToWire(source)));
 assert.deepEqual(Object.keys(copy).sort(),Object.keys(source).sort());assert.deepEqual(copy,source);
 assert.equal(serializeSerdeValue(copy.payload),serializeSerdeValue(source.payload));
});
test('SQL NULL outcome and JSON null, false, number, array and object remain distinct',()=>{
 for(const outcome of [undefined,null,false,0n,0,[1n,1],{x:null}]){
  const source={...stored(),outcome};const copy=storedIngressFromWire(structuredClone(storedIngressToWire(source)));
  assert.deepEqual(copy.outcome,outcome);assert.equal(Object.hasOwn(copy,'outcome'),true);
 }
 assert.throws(()=>storedIngressFromWire({...wire(),outcomePresent:false,outcomeJson:'null'}),TypeError);
 assert.throws(()=>storedIngressFromWire({...wire(),outcomePresent:true,outcomeJson:null}),TypeError);
 assert.throws(()=>storedIngressFromWire({...wire(),outcomePresent:'true'}),TypeError);
});
test('closed timestamp tags preserve NaN and infinities but reject arbitrary tags and raw nonfinite wire numbers',()=>{
 for(const n of [NaN,Infinity,-Infinity,0,-0,4.5]){
  const v=storedIngressFromWire(structuredClone(storedIngressToWire({...stored(),createdAt:n,updatedAt:n})));
  assert.ok(Object.is(v.createdAt,n));assert.ok(Object.is(v.updatedAt,n));
 }
 for(const n of ['Infinity','0',NaN,Infinity,null,undefined,1n])assert.throws(()=>storedIngressFromWire({...wire(),createdAt:n}),TypeError);
});
test('record decoder rejects missing fields, malformed identities, enum, boolean, Unicode and JSON',()=>{
 for(const key of Object.keys(wire())){const w=wire();delete w[key];assert.throws(()=>storedIngressFromWire(w),key);}
 for(const [key,value] of [['channelId',1],['channelId',1n<<63n],['eventId',-(1n<<63n)-1n],['kind','other'],['confirmationDelivered',1],['runtimeId',undefined],['holdReason','\ud800'],['payloadJson','{'],['ownerId',{}]] as const)assert.throws(()=>storedIngressFromWire({...wire(),[key]:value}),key);
});
test('wire adapters do not invoke record getters or proxy traps',()=>{
 let hooks=0;const value=stored();Object.defineProperty(value,'payload',{get(){hooks++;return {};}});
 assert.throws(()=>storedIngressToWire(value),TypeError);const w=wire();Object.defineProperty(w,'payloadJson',{get(){hooks++;return '{}';}});
 assert.throws(()=>storedIngressFromWire(w),TypeError);
 const proxy=new Proxy(stored(),{get(){hooks++;throw Error('trap');},getOwnPropertyDescriptor(){hooks++;throw Error('trap');},getPrototypeOf(){hooks++;throw Error('trap');}});
 assert.throws(()=>storedIngressToWire(proxy),TypeError);assert.throws(()=>storedIngressFromWire(proxy),TypeError);assert.equal(hooks,0);
});
test('new ingress snapshots mutable payload and preserves all fields and numeric types',()=>{
 const source=incoming(),captured=newIngressToWire(source);(source.payload as Record<string,unknown>).prompt='changed';
 const copy=newIngressFromWire(structuredClone(captured));assert.deepEqual(copy,incoming());
 assert.equal(serializeSerdeValue(copy.payload),serializeSerdeValue(incoming().payload));
});
test('new ingress adapters preserve numeric tags and validate data before worker submission',()=>{
 for(const now of [NaN,Infinity,-Infinity,0,-0,4.5])assert.ok(Object.is(newIngressFromWire(structuredClone(newIngressToWire({...incoming(),now}))).now,now));
 const w=newIngressToWire(incoming()) as Record<string,unknown>;
 for(const key of Object.keys(w)){const v={...w};delete v[key];assert.throws(()=>newIngressFromWire(v),key);}
 let hooks=0;const source=incoming();Object.defineProperty(source,'payload',{get(){hooks++;return {};}});assert.throws(()=>newIngressToWire(source),TypeError);assert.equal(hooks,0);
});
test('decoded JSON objects cannot mutate prototypes or turn inherited properties into journal fields',()=>{
 const v=storedIngressFromWire({...wire(),payloadJson:'{"__proto__":{"polluted":true},"constructor":1}'});
 assert.equal(({} as Record<string,unknown>).polluted,undefined);assert.equal(Object.hasOwn(v.payload as object,'__proto__'),true);
 const inherited=Object.create(wire());assert.throws(()=>storedIngressFromWire(inherited),TypeError);
});
