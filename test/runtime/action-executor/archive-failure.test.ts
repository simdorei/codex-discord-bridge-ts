import assert from 'node:assert/strict';import {it} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {archiveDispatchFailure,originalOwnerActionError} from '../../../src/runtime/action-executor/archive-failure.ts';
import {actionExecutionErrorInfo} from '../../../src/runtime/action-executor/action-error.ts';
import {ResidentStateError,type ResidentFailure} from '../../../src/app-server/resident-state.ts';
import {AppServerRequestError} from '../../../src/app-server/request-client.ts';
const remote=(code:bigint,message:string)=>new AppServerRequestError({kind:'Remote',method:'thread/archive',code,message,data:null});
it('exact owned generation/fence rejection releases attempted operation and preserves cause',async()=>{
 for(const detail of [{kind:'GenerationMismatch',expected:1n,actual:2n},{kind:'GenerationQuarantined',generation:1n},{kind:'DeadGenerationFence',message:'cannot persist'}] as ResidentFailure[])await storeFixture(async path=>{
  const op=await state.reserveArchiveScope(path,['a','b'],null),error=new ResidentStateError(detail),result=await archiveDispatchFailure(path,op,'a',error);assert.equal(await state.archiveTargetFenced(path,'a'),false);assert.equal(await state.archiveTargetFenced(path,'b'),false);assert.equal(actionExecutionErrorInfo(result)?.kind,'AppServer');assert.equal(actionExecutionErrorInfo(result)?.source,error);
 });
});
it('exact active-writer rejection releases reservation but refuses a fork fallback',async()=>storeFixture(async path=>{
 const op=await state.reserveArchiveScope(path,['a'],null),result=await archiveDispatchFailure(path,op,'a',remote(-32600n,'thread already has an active writer'));assert.equal(await state.archiveTargetFenced(path,'a'),false);assert.equal(actionExecutionErrorInfo(result)?.kind,'Invalid');assert.match(result.message,/owns original thread a; no fork was used/);
}));
it('timeout, disconnect, other remote rejection and other resident states retain all fences',async()=>{
 const errors=[new AppServerRequestError({kind:'Timeout',method:'thread/archive',timeoutMs:5}),new AppServerRequestError({kind:'TransportClosed',method:'thread/archive',reason:'closed'}),remote(-1n,'already has an active writer'),remote(-32600n,'Already has an active writer'),new ResidentStateError({kind:'MutationHeld',message:'held'}),new Error('unknown')];
 for(const error of errors)await storeFixture(async path=>{const op=await state.reserveArchiveScope(path,['a'],null),result=await archiveDispatchFailure(path,op,'a',error);assert.equal(await state.archiveTargetFenced(path,'a'),true);assert.match(result.message,/unverified outcome.*do not automatically retry/);});
});
it('failed release keeps reservation protected and records both release and original failure',async()=>storeFixture(async path=>{
 const op=await state.reserveArchiveScope(path,['a'],null);await state.markArchiveVerified(path,op);const result=await archiveDispatchFailure(path,op,'a',new ResidentStateError({kind:'GenerationMismatch',expected:1n,actual:2n}));assert.equal(await state.archiveTargetFenced(path,'a'),true);assert.match(result.message,/could not be released.*missing rejected archive reservation.*Original error:.*generation mismatch/);
}));
it('plain forged variants, inherited error prototypes and getter/proxy traps cannot release',async()=>{
 let calls=0;const getter={get detail(){calls++;return {kind:'GenerationMismatch'};},get message(){calls++;return 'already has an active writer';}},proxy=new Proxy({},{get(){calls++;throw Error('trap');},getOwnPropertyDescriptor(){calls++;throw Error('trap');}});
 for(const error of [{detail:{kind:'GenerationMismatch'},message:'fake'},Object.create(ResidentStateError.prototype),getter,proxy])await storeFixture(async path=>{const op=await state.reserveArchiveScope(path,['a'],null),result=await archiveDispatchFailure(path,op,'a',error);assert.equal(await state.archiveTargetFenced(path,'a'),true);assert.match(result.message,/unverified outcome/);});assert.equal(calls,0);
});
it('shared original-owner renderer does not classify by message alone',()=>{
 const plain=new Error('already has an active writer');assert.equal(actionExecutionErrorInfo(originalOwnerActionError('archive','t',plain))?.kind,'AppServer');assert.match(originalOwnerActionError('archive','t',remote(-32600n,'already has an active writer')).message,/requires the app-server/);
});
