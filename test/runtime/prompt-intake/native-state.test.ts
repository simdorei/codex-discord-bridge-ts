import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {PromptClaimLeaseRunner,type RenewalTicks} from '../../../src/runtime/prompt-intake/lease-runner.ts';
import {intakeToWire,intakeFromWire,intakeNumberWire,intakeNumberFromWire} from '../../../src/runtime/prompt-intake/native-wire.ts';
import type {PromptIntakeClaim,StoredPromptIntake} from '../../../src/store/prompt-intake.ts';
const input=()=>({jobId:'job',targetThreadId:'target',channelId:9007199254740993n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'한국어😀',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
const stored=():StoredPromptIntake=>({...input(),attemptCount:0n,lastError:'',retryAfter:0,claimToken:'token',claimExpiresAt:20,updatedAt:1});
async function seed(path:string){return (await state.admitPromptIntake(path,input())).intake;}
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
class ManualTicks implements RenewalTicks{wake:(()=>void)|undefined;closed=false;wait(){return new Promise<void>(r=>{this.wake=r;});}fire(){assert.ok(this.wake);const wake=this.wake;this.wake=undefined;wake();}close(){this.closed=true;this.wake?.();this.wake=undefined;}}
test('intake factory changes exactly twenty-two APIs, retains all other identities and rejects wrong binding',async()=>{
 const native=createNativePromptIntakeState('db'),changed=new Set(['completedAppServerForkTargetForSource','unfinishedArchiveRequest','getIngress','beginIngressThreadStart','recordIngressNewCreation','recordIngressCreatedThread','ingressByOrigin','admitIngress','holdIngress','getNewFirstReplyFinish','mirroredThreadId','admitBusyQueue','admitPromptIntakeWithIngress','releaseAllPromptIntakeClaims','recordPromptIntakeFailureIfClaimed','removePromptIntakeIfQueued','admitPromptIntake','canonicalizePromptIntakeTarget','getPromptIntake','listPromptIntakes','promptIntakeHasDurableOwner','tryClaimPromptIntake','renewPromptIntakeClaimIfCurrent']);assert.ok(Object.isFrozen(native));
 for(const key of Object.keys(state) as (keyof typeof state)[])if(changed.has(key))assert.notEqual(native[key],state[key]);else assert.equal(native[key],state[key]);
 await assert.rejects(native.getPromptIntake('other','job'),TypeError);assert.equal(ownedWorkerUsage().Control,0);
});
test('native intake reads retain i64, readiness ordering and nonfinite numeric semantics',async()=>storeFixture(async path=>{
 await seed(path);edit(path,db=>db.exec('UPDATE codex_prompt_intakes SET retry_after=2,claim_expires_at=3,updated_at=1e999'));const native=createNativePromptIntakeState(path);
 assert.deepEqual(await native.getPromptIntake(path,'job'),await state.getPromptIntake(path,'job'));assert.equal((await native.getPromptIntake(path,'job'))?.updatedAt,Infinity);assert.equal(await native.getPromptIntake(path,'missing'),null);
 for(const ready of [null,0,2,3,NaN,Infinity,-Infinity])assert.deepEqual(await native.listPromptIntakes(path,ready),await state.listPromptIntakes(path,ready));assert.equal(ownedWorkerUsage().Control,0);
}));
test('native claim and minimal captured renewal retain token and exact compare-and-swap boundary',async()=>storeFixture(async path=>{
 await seed(path);const native=createNativePromptIntakeState(path),first=await native.tryClaimPromptIntake(path,'job',10,20);assert.ok(first);assert.equal(await native.tryClaimPromptIntake(path,'job',11,30),null);
 let hooks=0;Object.defineProperty(first.intake,'rawPrompt',{get(){hooks++;throw Error('unused field');}});const pending=native.renewPromptIntakeClaimIfCurrent(path,first,11,30);first.claimToken='mutated';first.intake.jobId='mutated';const renewed=await pending;assert.ok(renewed);assert.equal(renewed.intake.jobId,'job');assert.equal(renewed.intake.claimExpiresAt,30);assert.equal(hooks,0);
 assert.equal(await native.renewPromptIntakeClaimIfCurrent(path,renewed,12,30),null);assert.equal(await native.renewPromptIntakeClaimIfCurrent(path,renewed,30,40),null);const next=await native.tryClaimPromptIntake(path,'job',30,40);assert.ok(next);assert.notEqual(next.claimToken,renewed.claimToken);
}));
test('native renewal preserves an original empty token rather than inventing a nonempty restriction',async()=>storeFixture(async path=>{
 await seed(path);edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET claim_token='',claim_expires_at=20"));const native=createNativePromptIntakeState(path),intake=(await state.getPromptIntake(path,'job'))!;const result=await native.renewPromptIntakeClaimIfCurrent(path,{intake,claimToken:''},10,30);assert.ok(result);assert.equal(result.claimToken,'');assert.equal(result.intake.claimExpiresAt,30);
}));
test('native durable owner requires intake removal and a matching queue or outbox occurrence',async()=>storeFixture(async path=>{
 await seed(path);const native=createNativePromptIntakeState(path);edit(path,db=>db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','job','target','turn',1,'final',0,0)"));assert.equal(await native.promptIntakeHasDurableOwner(path,'job'),false);edit(path,db=>db.exec('DELETE FROM codex_prompt_intakes'));assert.equal(await native.promptIntakeHasDurableOwner(path,'job'),true);assert.equal(await native.promptIntakeHasDurableOwner(path,'other'),false);
}));
test('passive input rejection and missing store never execute accessors or create a DB',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);let hooks=0;const claim={intake:stored(),claimToken:'token'};
 await assert.rejects(native.renewPromptIntakeClaimIfCurrent(path,new Proxy(claim,{get(){hooks++;throw Error('trap');}}),1,30),TypeError);
 await assert.rejects(native.renewPromptIntakeClaimIfCurrent(path,{...claim,intake:Object.defineProperty(stored(),'jobId',{get(){hooks++;throw Error('getter');}})},1,30),TypeError);assert.equal(hooks,0);
 await assert.rejects(native.getPromptIntake(path,'job'),NativePromptIntakeUnavailableError);assert.equal(existsSync(path),false);
}));
test('late native claim keeps slot until actual commit/exit; saturation never becomes a null claim',async()=>storeFixture(async path=>{
 await seed(path);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,30),pending=native.tryClaimPromptIntake(path,'job',10,20),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let finished=false;void pending.then(()=>finished=true,()=>finished=true);
 try{await new Promise(r=>setTimeout(r,200));assert.equal(finished,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.tryClaimPromptIntake(path,'job',10,20),OwnedWorkerBudgetError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.ok((await state.getPromptIntake(path,'job'))?.claimToken);}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));
test('malformed or unrelated complete acknowledgements cannot fabricate claim/read authority',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState('db'),intake=stored();
 for(raw of [{ok:false},{ok:true,operation:'Get',value:intakeToWire({...intake,jobId:'wrong'})},{ok:true,operation:'Claim',value:null}])await assert.rejects(native.getPromptIntake('db','job'));
 for(raw of [{ok:true,operation:'Claim',value:{claimToken:'token',intake:intakeToWire({...intake,claimExpiresAt:99})}},{ok:true,operation:'Claim',value:{claimToken:'token',intake:intakeToWire({...intake,claimToken:'other'})}},{ok:true,operation:'Claim',value:false}])await assert.rejects(native.tryClaimPromptIntake('db','job',10,20));
 raw={ok:true,operation:'DurableOwner',value:1};await assert.rejects(native.promptIntakeHasDurableOwner('db','job'));
});
for(const promoted of [false,true])test(`real lease runner joins ignored cancellation and preserves durable promotion=${promoted}`,async()=>storeFixture(async path=>{
 await seed(path);const native=createNativePromptIntakeState(path),claim=await native.tryClaimPromptIntake(path,'job',10,20);assert.ok(claim);const ticks=new ManualTicks(),began=deferred<void>(),work=deferred<string>(),observed=deferred<void>();let signal:AbortSignal|undefined,finished=false;
 const checked={...native,promptIntakeHasDurableOwner:async(p:string,id:string)=>{const result=await native.promptIntakeHasDurableOwner(p,id);observed.resolve();return result;}};
 const runner=new PromptClaimLeaseRunner(path,checked,()=>11,()=>ticks),pending=runner.run(claim,async(_c,s)=>{signal=s;began.resolve();return work.promise;}).then(v=>{finished=true;return v;});
 try{await began.promise;edit(path,db=>{if(promoted)db.exec("DELETE FROM codex_prompt_intakes; INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','job','target','turn',1,'final',0,0)");else db.exec("UPDATE codex_prompt_intakes SET claim_token='replacement'");});ticks.fire();await observed.promise;await new Promise<void>(r=>setImmediate(r));assert.equal(signal?.aborted,!promoted);assert.equal(finished,false);work.resolve('late');assert.deepEqual(await pending,promoted?{kind:'Finished',result:{ok:true,value:'late'}}:{kind:'Lost'});assert.equal(ticks.closed,true);assert.equal(ownedWorkerUsage().Control,0);}finally{work.resolve('cleanup');await pending;}
}));
test('numeric wire roundtrips finite, signed zero, NaN and infinities without coercion',()=>{
 for(const n of [0,-0,1.5,NaN,Infinity,-Infinity])assert.ok(Object.is(intakeNumberFromWire(intakeNumberWire(n)),n));
 for(const bad of [Infinity,NaN,'Infinity',{},null])assert.throws(()=>intakeNumberFromWire(bad),TypeError);
 const value={...stored(),retryAfter:-Infinity,claimExpiresAt:Infinity,createdAt:-0,updatedAt:NaN},copy=intakeFromWire(intakeToWire(value));assert.deepEqual(copy,value);
});
test('wire intake decoder rejects getters and proxies without invoking them',()=>{
 const raw=intakeToWire(stored()) as object;let hooks=0;assert.throws(()=>intakeFromWire(Object.defineProperty(raw,'jobId',{get(){hooks++;throw Error('getter');}})),TypeError);assert.throws(()=>intakeFromWire(new Proxy({}, {get(){hooks++;throw Error('proxy');}})),TypeError);assert.equal(hooks,0);
});
