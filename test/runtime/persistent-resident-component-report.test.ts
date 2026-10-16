import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePersistentResidentComponentReport as capture,PERSISTENT_RESIDENT_COMPONENT_PHASES as phases,PERSISTENT_RESIDENT_FIXTURE_FAILURE_STEPS as steps,PERSISTENT_RESIDENT_CHILD_CLOSURES as closures,createPersistentResidentReportEvidence as initial,corruptPersistentResidentReportEvidence as corrupt,acceptPersistentResidentTerminalReport as accept,type PersistentResidentReportEvidence} from '../../src/runtime/persistent-resident-component-report.ts';

const structural='Invalid fixed resident component report';
const failure='Invalid fixed resident component failure';
const closureError='Invalid direct child closure diagnostic';
const failed=()=>({version:1,kind:'component-failed',phase:'running',category:'lifecycle',fixtureStep:'respond',childClosure:'confirmed'});
const disposed=()=>({version:1,kind:'component-disposed',childClosure:'confirmed'});
const fixture=()=>({version:1,kind:'fixture-result',scenario:'normal-start-close',passed:true});
function rejects(value:unknown,message=structural):void{assert.throws(()=>capture(value),{name:'TypeError',message});}

test('captures every schema on ordinary and null prototypes without freezing the shallow copy',()=>{
 const records=[{version:1,kind:'role-ready'},{version:1,kind:'local-fence-ready'},{version:1,kind:'custody-ready'},{version:1,kind:'mutation-ready'},{version:1,kind:'component-ready'},fixture(),failed(),disposed()];
 for(const record of records)for(const proto of [Object.prototype,null]){
  const source=Object.assign(Object.create(proto),record),result=capture(source);
  assert.equal(Object.getPrototypeOf(result),null);assert.notEqual(result,source);assert.equal(Object.isFrozen(result),false);
  assert.deepEqual({...result},record);source.kind='changed';assert.equal(result.kind,record.kind);
  result.kind='locally mutable';assert.equal(source.kind,'changed');
 }
});
test('rejects all primitive categories, arrays and exotic prototypes',()=>{
 class Example{version=1;kind='role-ready';}
 for(const value of [null,undefined,true,false,0,1,NaN,Infinity,0n,1n,'','text',Symbol('x'),()=>0,[],[1],new Date(0),new Example(),Object.create({})])rejects(value);
});
test('rejects proxies including revoked proxies before any trap',()=>{
 let traps=0;
 const proxy=new Proxy({version:1,kind:'role-ready'},{getPrototypeOf(){traps++;throw new Error('trap');},ownKeys(){traps++;throw new Error('trap');},getOwnPropertyDescriptor(){traps++;throw new Error('trap');},get(){traps++;throw new Error('trap');}});
 rejects(proxy);assert.equal(traps,0);
 const revoked=Proxy.revocable({},{});revoked.revoke();rejects(revoked.proxy);
});
test('never invokes getters, and rejects symbols, nonenumerable, extra or missing fields',()=>{
 let reads=0;
 for(const record of [{version:1,kind:'role-ready'},fixture(),failed(),disposed()]){
  for(const key of Object.keys(record)){
   const accessor={...record};Object.defineProperty(accessor,key,{get(){reads++;return (record as Record<string,unknown>)[key];},enumerable:true});rejects(accessor);
   const hidden={...record};Object.defineProperty(hidden,key,{value:(record as Record<string,unknown>)[key],enumerable:false});rejects(hidden);
   const missing:Record<string,unknown>={...record};delete missing[key];rejects(missing);
  }
  rejects({...record,extra:1});rejects({...record,[Symbol('extra')]:1});
 }
 assert.equal(reads,0);
});
test('strict version and kind, and schema-dependent exact fields',()=>{
 for(const version of [undefined,null,'1',0,2,1n,true,{},NaN])rejects({version,kind:'role-ready'});
 for(const kind of [undefined,null,1,1n,true,{},[],Symbol('kind')])rejects({version:1,kind});
 rejects({...failed(),kind:'component-disposed'});rejects({...disposed(),kind:'fixture-result'});
 rejects({...fixture(),kind:'role-ready'});
});
test('all phase, step, category and child closure labels retain exact parser behavior',()=>{
 for(const phase of phases)for(const fixtureStep of steps)for(const childClosure of closures)for(const category of ['protocol','lifecycle'])assert.deepEqual({...capture({...failed(),phase,fixtureStep,childClosure,category})},{...failed(),phase,fixtureStep,childClosure,category});
 for(const childClosure of closures)assert.equal(capture({...disposed(),childClosure}).childClosure,childClosure);
 const invalid=[undefined,null,'','RUNNING','running ','confirmed ',0,1n,true,{},[],Symbol('label')];
 for(const value of invalid){rejects({...failed(),phase:value},failure);rejects({...failed(),fixtureStep:value},failure);rejects({...failed(),category:value},failure);rejects({...failed(),childClosure:value},closureError);rejects({...disposed(),childClosure:value},closureError);}
 // Failure validation precedes closure validation, as in the original parser.
 rejects({...failed(),phase:'bad',childClosure:'bad'},failure);
});
test('unknown kinds and unvalidated fixture fields await owner validation, not runtime acceptance',()=>{
 for(const kind of ['unknown','','component-disposed ','constructor','__proto__'])assert.equal(capture({version:1,kind}).kind,kind);
 for(const scenario of [undefined,null,17,{},'not-a-scenario'])for(const passed of [undefined,null,false,0,'true',{}]){
  const result=capture({version:1,kind:'fixture-result',scenario,passed});assert.equal(result.scenario,scenario);assert.equal(result.passed,passed);
 }
 const nested={mutable:true};assert.equal(capture({version:1,kind:'fixture-result',scenario:nested,passed:false}).scenario,nested);
 // These enum members parse but are forbidden by the owner's failed-report phase checks.
 for(const phase of ['closed','failed'])assert.equal(capture({...failed(),phase}).phase,phase);
});

test('initial and single terminal diagnostics are frozen independent values',()=>{
 const start=initial();assert.deepEqual(start,{reportCorrupt:false,terminalKind:'none',directChildClosure:'unknown'});assert.equal(Object.getPrototypeOf(start),Object.prototype);assert.ok(Object.isFrozen(start));
 for(const kind of ['failed','disposed'] as const)for(const closure of closures){
  const next=accept(start,kind,closure);assert.deepEqual(next,{reportCorrupt:false,terminalKind:kind,directChildClosure:closure});assert.notEqual(next,start);assert.ok(Object.isFrozen(next));
 }
 assert.deepEqual(start,initial());
});
test('corruption is sticky before and after terminal diagnostic proposals',()=>{
 for(const kind of ['failed','disposed'] as const)for(const closure of closures){
  const before=corrupt(initial());assert.deepEqual(accept(before,kind,closure),before);
  const terminal=accept(initial(),kind,closure),after=corrupt(terminal);
  assert.deepEqual(after,{reportCorrupt:true,terminalKind:kind,directChildClosure:'unknown'});
  assert.deepEqual(corrupt(after),after);assert.deepEqual(terminal,{reportCorrupt:false,terminalKind:kind,directChildClosure:closure});
 }
});
test('duplicate or conflicting terminal proposals corrupt even when closure differs',()=>{
 for(const first of ['failed','disposed'] as const)for(const second of ['failed','disposed'] as const)for(const a of closures)for(const b of closures){
  const prior=accept(initial(),first,a),next=accept(prior,second,b);
  assert.deepEqual(next,{reportCorrupt:true,terminalKind:first,directChildClosure:'unknown'});assert.equal(prior.reportCorrupt,false);assert.equal(prior.directChildClosure,a);
 }
});
test('all diagnostic operation sequences through length five preserve the monotone model',()=>{
 type Operation={kind:'corrupt'}|{kind:'failed'|'disposed';closure:typeof closures[number]};
 const operations:Operation[]=[{kind:'corrupt'},...(['failed','disposed'] as const).flatMap(kind=>closures.map(closure=>({kind,closure})))];
 function walk(value:PersistentResidentReportEvidence,depth:number):void{
  assert.ok(Object.isFrozen(value));if(depth===0)return;
  for(const op of operations){
   const saved={...value};const next=op.kind==='corrupt'?corrupt(value):accept(value,op.kind,op.closure);
   const expectedCorrupt=value.reportCorrupt||op.kind==='corrupt'||value.terminalKind!=='none';
   assert.equal(next.reportCorrupt,expectedCorrupt);
   assert.equal(next.terminalKind,expectedCorrupt?value.terminalKind:op.kind);
   assert.equal(next.directChildClosure,expectedCorrupt?'unknown':op.closure);
   assert.deepEqual(value,saved);assert.notEqual(next,value);walk(next,depth-1);
  }
 }
 walk(initial(),5);
});
