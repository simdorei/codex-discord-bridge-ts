import assert from 'node:assert/strict';import {it} from 'node:test';
import {NativeArchiveWriter} from '../../../src/runtime/action-executor/archive-write-native.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
it('archive boundary never reads inherited kind, scope, own or operation accessors',async()=>{
 const writer=new NativeArchiveWriter('/unused-owned-archive-boundary');
 const cases:[string,unknown][]=[['kind',{}],['scope',{kind:'Reserve',own:null,unused:0}],['own',{kind:'Reserve',scope:['a'],unused:0}],['operation',{kind:'Verified',unused:0}]];
 for(const [key,input] of cases){let hooks=0;const before=Object.getOwnPropertyDescriptor(Object.prototype,key),d=Object.create(null);d.configurable=true;d.get=()=>{hooks++;throw new Error('inherited '+key);};let pending:Promise<unknown>;
  Object.defineProperty(Object.prototype,key,d);
  try{pending=writer.execute(input as any);}finally{if(before)Object.defineProperty(Object.prototype,key,before);else Reflect.deleteProperty(Object.prototype,key);}
  await assert.rejects(pending!);assert.equal(hooks,0,key);assert.equal(ownedWorkerUsage().Control,0);
 }
});
it('archive boundary rejects extra, missing and primitive inputs before submission',async()=>{
 const w=new NativeArchiveWriter('/unused-owned-archive-boundary');for(const input of [null,[],1,'Reserve',{kind:'Reserve',scope:['a'],own:null,extra:true},{kind:'Verified',operation:'a',extra:true},{kind:'Reserve',scope:['a']},{kind:'Verified'}]){const pending=w.execute(input as any),submitted=ownedWorkerUsage().Control;await assert.rejects(pending);assert.equal(submitted,0);assert.equal(ownedWorkerUsage().Control,0);}
});
