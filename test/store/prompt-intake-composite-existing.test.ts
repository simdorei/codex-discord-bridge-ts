import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {admitBusyQueueExisting as busy} from '../../src/store/prompt-intake-busy.ts';import {admitPromptIntakeWithIngressExisting as newIntake,type NewReplySeed} from '../../src/store/prompt-intake-new-thread.ts';
const choice=()=>({choiceId:'choice',ownerUserId:2n,channelId:1n,targetThreadId:'target',prompt:'raw',allowSteer:false,createdAt:1,expiresAt:100});
const request=()=>({jobId:'job',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:5});
function edit<T>(path:string,fn:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
async function init(path:string){const db=await openInitialized(path);db.close();}
test('composite existing APIs do not create missing stores and reject invalid inputs first',async()=>storeFixture(async path=>{
 assert.throws(()=>busy(path,choice(),'target',false,'key',NaN),/invalid busy queue admission/);assert.throws(()=>newIntake(path,request(),'i',1n<<63n),TypeError);assert.equal(existsSync(path),false);assert.throws(()=>busy(path,choice(),'target',false,'key',10));assert.throws(()=>newIntake(path,request(),'i',1n));assert.equal(existsSync(path),false);
}));
test('composite current-catalog refusal neither repairs an index nor authorizes an old receipt',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec("INSERT INTO persistent_component_claims(claim_key,created_at,expires_at) VALUES('key',0,100);DROP INDEX codex_prompt_intakes_message_id"));assert.throws(()=>busy(path,choice(),'target',false,'key',10));assert.throws(()=>newIntake(path,request(),'i',7n));assert.equal(edit(path,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_prompt_intakes_message_id'").get()?.n),0);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM discord_ingress_owner_receipts').get()?.n),0);
}));
test('new first-reply seed preserves original lossy native-path conversion and pre-open passive capture',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,outcome_json,created_at,updated_at) VALUES('i','action',3,1,2,'{"command":"new","prompt":"raw"}','executing','thread/created','target','{"thread_start_generation":7,"new_creation":{"version":1}}',0,0)`));
 let hooks=0;const poisoned=Object.defineProperty({stateDb:{platform:'windows-utf16',units:[65]}},'acknowledgement',{get(){hooks++;return 'bad';}});assert.throws(()=>newIntake(path,request(),'i',7n,poisoned as unknown as NewReplySeed),TypeError);assert.equal(hooks,0);
 const result=newIntake(path,request(),'i',7n,{stateDb:{platform:'windows-utf16',units:[0xd800,65]},acknowledgement:'created'});assert.equal(result.created,true);const text=edit(path,db=>db.prepare("SELECT json_extract(outcome_json,'$.new_reply_seed.state_db') AS path FROM discord_ingress_journal WHERE ingress_id='i'").get()?.path);assert.equal(text,'\uFFFDA');
}));
