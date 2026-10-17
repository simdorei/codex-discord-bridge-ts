import test from 'node:test';import assert from 'node:assert/strict';
import {OwnedDispatchAttempt,type OwnedDispatchMutationFence,pinOwnedDispatchMutationFence} from '../../src/app-server/owned-dispatch-attempt.ts';import {NativeMutationOwner,type NativeMutationReceipt} from '../../src/runtime/native-mutation-owner.ts';import {OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';import {isOwnedMutationOutcomeUnknown} from '../../src/app-server/maintenance-attempt.ts';import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
const input={ownerId:'owner',generation:1n,method:'thread/settings/update',params:{threadId:'T'},repair:false,queueClaim:null,stopClaim:null,origin:null};
function fence(owner:NativeMutationOwner):OwnedDispatchMutationFence{return {beginMutationWithOrigin:c=>owner.begin(c),beginQueueMutation:c=>owner.beginQueue(c),beginStopMutation:c=>owner.beginStop(c),finishMutation:(r,o)=>owner.finish(r as NativeMutationReceipt,o),wasNotSubmitted:(e,a,w,m)=>owner.ownsUnsubmittedFailure(e,a,w,m)};}
async function fixture(run:(first:NativeMutationOwner,second:NativeMutationOwner,db:Awaited<ReturnType<typeof openInitialized>>)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");const first=new NativeMutationOwner(path,'runtime',x=>x),second=new NativeMutationOwner(path,'runtime',x=>x);try{await run(first,second,db);}finally{await first.close();await second.close();db.close();}});}
function held(first:NativeMutationOwner){return first.begin({ownerId:'owner',generation:1n,attemptId:'first',wire:1n,method:'thread/settings/update',params:{threadId:'other'},scoped:true,origin:null});}
for(const sameOwner of [false,true])test('proved '+(sameOwner?'same-owner busy':'global budget saturation')+' is not invented durable uncertainty',async()=>fixture(async(first,second,db)=>{
 const pending=held(first),owner=sameOwner?first:second,adapter=fence(owner),attempt=new OwnedDispatchAttempt(input,adapter,()=> 'safe');let error:unknown;
 try{await attempt.begin(2n);assert.fail('begin should refuse');}catch(e){error=e;assert.ok(e instanceof OwnedWorkerBusyError);assert.equal(isOwnedMutationOutcomeUnknown(e),false);}
 assert.throws(()=>attempt.writeStarted(),/not ready/);await attempt.dispose(null);const result=await attempt.finish({ok:true,value:{forged:'success'}});assert.deepEqual(result,{ok:false,error});await pending;assert.equal(db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts WHERE target_thread_id='T'").get()!.n,0);assert.equal(db.prepare("SELECT state FROM codex_mutation_attempts").get()!.state,'prepared');
}));
test('proof binds exact owner, attempt, wire type and method; copied/public errors are not proof',async()=>fixture(async(first,second)=>{
 const pending=held(first),c={ownerId:'owner',generation:1n,attemptId:'second',wire:2n,method:'thread/settings/update',params:{threadId:'T'},scoped:true,origin:null};let error:unknown;try{await second.begin(c);assert.fail();}catch(e){error=e;}
 assert.equal(second.ownsUnsubmittedFailure(error,'second',2n,c.method),true);assert.equal(first.ownsUnsubmittedFailure(error,'second',2n,c.method),false);
 for(const [attempt,wire,method] of [['other',2n,c.method],['second','2',c.method],['second',2n,'turn/start']] as const)assert.equal(second.ownsUnsubmittedFailure(error,attempt,wire,method),false);
 assert.equal(second.ownsUnsubmittedFailure(new OwnedWorkerBusyError(),'second',2n,c.method),false);assert.equal(second.ownsUnsubmittedFailure({...error as object},'second',2n,c.method),false);await pending;
}));
test('an old proved refusal cannot downgrade failure of a different actual attempt',async()=>fixture(async(first,second)=>{
 const pending=held(first);let old:unknown;try{await second.begin({ownerId:'owner',generation:1n,attemptId:'old',wire:2n,method:'thread/settings/update',params:{threadId:'T'},scoped:true,origin:null});}catch(e){old=e;}await pending;
 const f=fence(second);f.beginMutationWithOrigin=async()=>{throw old;};const attempt=new OwnedDispatchAttempt(input,f,()=> 'safe');await assert.rejects(attempt.begin(2n),isOwnedMutationOutcomeUnknown);
}));
test('caller-supplied busy abort reason remains exact and never becomes owner proof',async()=>fixture(async(first)=>{
 const pending=held(first),signal=new AbortController(),reason=new OwnedWorkerBusyError();signal.abort(reason);assert.throws(()=>first.begin({ownerId:'owner',generation:1n,attemptId:'other',wire:2n,method:'thread/settings/update',params:{threadId:'T'},scoped:true,origin:null},signal.signal),e=>e===reason);assert.equal(first.ownsUnsubmittedFailure(reason,'other',2n,'thread/settings/update'),false);await pending;
}));
test('accepted native failure stays unknown even with proof callback installed',async()=>fixture(async(first,_second,db)=>{
 db.exec("CREATE TRIGGER fail BEFORE INSERT ON codex_mutation_attempts BEGIN SELECT RAISE(ABORT,'fail'); END");const a=new OwnedDispatchAttempt(input,fence(first),()=> 'safe');await assert.rejects(a.begin(2n),isOwnedMutationOutcomeUnknown);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_mutation_attempts').get()!.n,0);
}));
test('missing, throwing and non-boolean proof hooks retain conservative unknown',async()=>fixture(async(first)=>{
 for(const mode of ['absent','throw','promise','number']){const f=fence(first);f.beginMutationWithOrigin=async()=>{throw new OwnedWorkerBusyError();};if(mode==='absent')delete f.wasNotSubmitted;else f.wasNotSubmitted=(()=>{if(mode==='throw')throw Error('invalid proof');return mode==='promise'?Promise.resolve(true):1;}) as unknown as NonNullable<OwnedDispatchMutationFence['wasNotSubmitted']>;const a=new OwnedDispatchAttempt(input,f,()=> 'safe');await assert.rejects(a.begin(2n),isOwnedMutationOutcomeUnknown);}
}));
test('accessor proof is rejected without executing getter',async()=>fixture(async(first)=>{let calls=0;const f=fence(first);Object.defineProperty(f,'wasNotSubmitted',{get(){calls++;return ()=>true;}});assert.throws(()=>pinOwnedDispatchMutationFence(f));assert.equal(calls,0);}));
