import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {admitPromptIntake,PromptIntakeClaimLostError} from '../../src/store/prompt-intake-write.ts';
import {tryClaimPromptIntake,type PromptIntakeClaim} from '../../src/store/prompt-intake.ts';
import {promotePromptIntakeToQueue,promotePromptIntakeToQueueExisting} from '../../src/store/prompt-intake-promotion.ts';
import {ForkHandoffTargetMovedError} from '../../src/store/fork-handoff-admission.ts';

const intake=()=>({jobId:'job',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
const job=()=>queueJob({jobId:'job',channelId:1n,ownerUserId:2n,discordMessageId:3n,prompt:'enriched',createdAt:12});
async function claim(path:string){await admitPromptIntake(path,intake());const claim=await tryClaimPromptIntake(path,'job',10,30);assert.ok(claim);return claim;}
function read<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
test('existing promotion refuses missing catalog index without repairing or consuming intake',async()=>storeFixture(async path=>{
 const owned=await claim(path);read(path,db=>db.exec('DROP INDEX codex_prompt_intakes_message_id'));
 assert.throws(()=>promotePromptIntakeToQueueExisting(path,owned,job(),12));
 read(path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_prompt_intakes_message_id'").get()!.n,0);assert.equal(db.prepare('SELECT claim_token FROM codex_prompt_intakes').get()!.claim_token,owned.claimToken);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);});
}));
test('existing promotion rejects passive input without hooks and cannot create a missing database',async()=>storeFixture(async path=>{
 const owned:PromptIntakeClaim={claimToken:'token',intake:{...intake(),attemptCount:0n,lastError:'',retryAfter:0,claimToken:'token',claimExpiresAt:30,updatedAt:10}};let hooks=0;
 const bad=Object.defineProperty({...owned},'claimToken',{get(){hooks++;return 'token';}});assert.throws(()=>promotePromptIntakeToQueueExisting(path,bad,job(),12),TypeError);
 assert.throws(()=>promotePromptIntakeToQueueExisting(path,new Proxy(owned,{get(){hooks++;throw Error('trap');}}),job(),12),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);
 assert.throws(()=>promotePromptIntakeToQueueExisting(path,owned,job(),12));assert.equal(existsSync(path),false);
}));
test('promotion keeps inherited named-index check limits explicit in both adapters',async()=>{
 for(const existing of [false,true])await storeFixture(async path=>{
  const owned=await claim(path);read(path,db=>db.exec('DROP INDEX codex_prompt_intakes_message_id; CREATE INDEX codex_prompt_intakes_message_id ON codex_prompt_intakes(discord_message_id)'));
  const result=await (existing?async()=>promotePromptIntakeToQueueExisting(path,owned,job(),12):()=>promotePromptIntakeToQueue(path,owned,job(),12))();assert.equal(result.created,true);
  read(path,db=>{const index=db.prepare("PRAGMA index_list('codex_prompt_intakes')").all().find(r=>r.name==='codex_prompt_intakes_message_id');assert.equal(index?.unique,0);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_prompt_intakes').get()!.n,0);});
 });
});
test('final intake deletion refusal rolls back queue and prepared ingress evidence together',async()=>{
 for(const existing of [false,true])await storeFixture(async path=>{
  const db=await openInitialized(path);try{db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES ('i','action',3,1,2,'{"command":"new","prompt":"raw"}','executing','processing','target',0,0)`);}finally{db.close();}
  const owned=await claim(path);const before=read(path,db=>db.prepare('SELECT outcome_json FROM discord_ingress_journal').get()!.outcome_json);read(path,db=>db.exec('CREATE TRIGGER refuse_transfer BEFORE DELETE ON codex_prompt_intakes BEGIN SELECT RAISE(IGNORE); END'));
  await assert.rejects(async()=>existing?promotePromptIntakeToQueueExisting(path,owned,job(),12):promotePromptIntakeToQueue(path,owned,job(),12),PromptIntakeClaimLostError);
  read(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);assert.equal(db.prepare('SELECT outcome_json FROM discord_ingress_journal').get()!.outcome_json,before);assert.equal(db.prepare('SELECT claim_token FROM codex_prompt_intakes').get()!.claim_token,owned.claimToken);});
 });
});
test('current intake target movement preserves exact source refusal before queue transfer',async()=>{
 for(const existing of [false,true])await storeFixture(async path=>{
  const owned=await claim(path);read(path,db=>db.exec("UPDATE codex_prompt_intakes SET target_thread_id='new'"));
  await assert.rejects(async()=>existing?promotePromptIntakeToQueueExisting(path,owned,job(),12):promotePromptIntakeToQueue(path,owned,job(),12),(e:unknown)=>e instanceof ForkHandoffTargetMovedError&&e.sourceThreadId==='target'&&e.targetThreadId==='new');
  read(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);assert.equal(db.prepare('SELECT claim_token FROM codex_prompt_intakes').get()!.claim_token,owned.claimToken);});
 });
});
