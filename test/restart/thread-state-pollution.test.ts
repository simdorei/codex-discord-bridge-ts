import {it} from 'node:test';import assert from 'node:assert/strict';
import {classifyThreadState} from '../../src/restart/thread-state.ts';
for(const poisoned of ['get','set'] as const){
 it(`restart classifier does not read inherited descriptor ${poisoned} hooks`,()=>{
  const original=Object.getOwnPropertyDescriptor(Object.prototype,poisoned);let hooks=0;let outcome:unknown;let failure:unknown;
  const input={thread:{id:'thread',updatedAt:1n,status:{type:'active',activeFlags:['waitingOnApproval','waitingOnUserInput']}}};
  const descriptor={__proto__:null,configurable:true,get:()=>{hooks++;return undefined;}};
  Object.defineProperty(Object.prototype,poisoned,descriptor);
  try{outcome=classifyThreadState(input,'thread',0n,10n);}catch(error){failure=error;}finally{
   if(original===undefined)Reflect.deleteProperty(Object.prototype,poisoned);else{const restored=Object.assign(Object.create(null),original);Object.defineProperty(Object.prototype,poisoned,restored);}
  }
  assert.equal(failure,undefined);assert.equal(hooks,0);assert.deepEqual(outcome,{status:'Blocked',reason:'thread thread is active flags=waitingOnApproval,waitingOnUserInput'});
 });
}
