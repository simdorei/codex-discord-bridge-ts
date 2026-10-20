import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {BusyQueueExecutor} from '../../../src/runtime/action-executor/busy-queue.ts';
const choice=()=>({choiceId:'choice',ownerUserId:2n,channelId:1n,targetThreadId:'target',prompt:'raw',allowSteer:false,createdAt:1,expiresAt:100});
const request=()=>({jobId:'job',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:5});
function edit<T>(path:string,f:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return f(db);}finally{db.close();}}
async function seed(path:string,kind:'busy'|'new'){const db=await openInitialized(path);try{
 if(kind==='busy')db.exec("INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror) VALUES('choice',2,1,'target','raw',0,1,100,NULL,0)");
 else db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,outcome_json,created_at,updated_at) VALUES('i','action',3,1,2,'{"command":"new","prompt":"raw"}','executing','thread/created','target','{"thread_start_generation":7,"new_creation":{"version":1}}',0,0)`);
 }finally{db.close();}}
test('native busy transaction pins choice and receipt repeat never grants another preparation',async()=>storeFixture(async path=>{
 await seed(path,'busy');const native=createNativePromptIntakeState(path),c=choice(),p=native.admitBusyQueue(path,c,'target',false,'confirm',10);c.prompt='mutated';c.ownerUserId=9n;
 const a=await p;assert.equal(a.jobId,'busy-choice:choice');assert.equal(a.intake?.rawPrompt,'raw');assert.equal(a.intake?.ownerUserId,2n);
 edit(path,db=>db.exec('DELETE FROM busy_choices;DELETE FROM codex_prompt_intakes'));
 assert.deepEqual(await native.admitBusyQueue(path,choice(),'target',false,'confirm',20),{jobId:a.jobId,intake:null});assert.equal(ownedWorkerUsage().Control,0);
}));
test('actual BusyQueueExecutor receives native admission and preserves no-repeat behavior',async()=>storeFixture(async path=>{
 await seed(path,'busy');let calls=0;const native=createNativePromptIntakeState(path),executor=new BusyQueueExecutor(path,{async processAdmittedPrompt(intake){calls++;assert.equal(intake.rawPrompt,'raw');return {text:'accepted',waitsForFinal:true,ui:null};}},()=>10,native.admitBusyQueue);
 assert.equal((await executor.enqueueBusyChoice(choice())).text,'accepted');assert.match((await executor.enqueueBusyChoice(choice())).text,/already accepted/);assert.equal(calls,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native new admission captures reply seed and retains complete original recorded creation',async()=>storeFixture(async path=>{
 await seed(path,'new');const native=createNativePromptIntakeState(path),i=request(),units=[0xd800,65],reply={stateDb:{platform:'windows-utf16' as const,units},acknowledgement:'created'};
 const pending=native.admitPromptIntakeWithIngress(path,i,'i',7n,reply);i.rawPrompt='mutated';reply.acknowledgement='mutated';units[0]=66;const result=await pending;assert.equal(result.created,true);assert.equal(result.intake.rawPrompt,'raw');
 const ingress=await state.getIngress(path,'i');assert.equal(ingress?.ownerId,'job');assert.deepEqual((ingress?.outcome as {new_reply_seed:unknown}).new_reply_seed,{acknowledgement:'created',state_db:'\uFFFDA'});assert.equal(ownedWorkerUsage().Control,0);
}));
test('native composite downstream receipt or seed failure rolls back all original custody writes',async()=>{
 for(const kind of ['busy','new'] as const)await storeFixture(async path=>{await seed(path,kind);const native=createNativePromptIntakeState(path);
 if(kind==='busy'){edit(path,db=>db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON discord_ingress_owner_receipts BEGIN SELECT RAISE(ABORT,'no receipt'); END"));await assert.rejects(native.admitBusyQueue(path,choice(),'target',false,'confirm',10),NativePromptIntakeUnavailableError);assert.equal(edit(path,db=>db.prepare("SELECT claimed_at FROM busy_choices WHERE choice_id='choice'").get()?.claimed_at),null);}
 else{edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json='{"+'"thread_start_generation":7'+"}'"));await assert.rejects(native.admitPromptIntakeWithIngress(path,request(),'i',7n,{stateDb:{platform:'windows-utf16',units:[65]},acknowledgement:'created'}),NativePromptIntakeUnavailableError);assert.equal((await state.getIngress(path,'i'))?.ownerId,null);}
 assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_prompt_intakes').get()?.n),0);assert.equal(ownedWorkerUsage().Control,0);
 });
});
test('late composite commit retains Control until native exit and does not mint an acknowledgement',async()=>{
 for(const kind of ['busy','new'] as const)await storeFixture(async path=>{await seed(path,kind);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,10);const pending=kind==='busy'?native.admitBusyQueue(path,choice(),'target',false,'confirm',10):native.admitPromptIntakeWithIngress(path,request(),'i',7n);const rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let finished=false;void pending.then(()=>{finished=true;},()=>{finished=true;});
 try{await new Promise(r=>setTimeout(r,100));assert.equal(finished,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.getPromptIntake(path,'missing'),OwnedWorkerBudgetError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_prompt_intakes').get()?.n),1);}
 finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
 });
});
test('native composites reject passive input violations without creating a missing database',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);let hooks=0;const c=Object.defineProperty(choice(),'prompt',{get(){hooks++;return 'bad';}});await assert.rejects(native.admitBusyQueue(path,c,'target',false,'confirm',10),TypeError);
 const reply=Object.defineProperty({stateDb:{platform:'windows-utf16' as const,units:[65]},acknowledgement:'a'},'acknowledgement',{get(){hooks++;return 'bad';}});await assert.rejects(native.admitPromptIntakeWithIngress(path,request(),'i',7n,reply),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);
}));
test('malformed and crossed composite replies cannot grant preparation authority',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState('missing');
 for(raw of [{ok:true,operation:'AdmitBusy',value:{jobId:'other',intake:null}},{ok:true,operation:'AdmitWithIngress',value:{jobId:'busy-choice:choice',intake:null}},{ok:false}])await assert.rejects(native.admitBusyQueue('missing',choice(),'target',false,'confirm',10),NativePromptIntakeUnavailableError);
 for(raw of [{ok:true,operation:'AdmitWithIngress',value:{created:'yes',intake:null}},{ok:true,operation:'Admit',value:null}])await assert.rejects(native.admitPromptIntakeWithIngress('missing',request(),'i',7n),NativePromptIntakeUnavailableError);
});
