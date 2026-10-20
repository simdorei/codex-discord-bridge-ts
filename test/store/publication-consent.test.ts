import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {enqueueInTransaction} from '../../src/store/queue-enqueue.ts';
import {proposePublication,bindPublicationDelivery} from '../../src/store/publication-proposal.ts';
import {recordPublicationConsent,type PublicationDecision} from '../../src/store/publication-consent.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const proposal='a'.repeat(32);
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
async function fixture(run:(path:string)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{db.exec('BEGIN IMMEDIATE');enqueueInTransaction(db,{jobId:'job',targetThreadId:'t',channelId:1n,ownerUserId:2n,discordMessageId:null,appServerGeneration:1n,prompt:'prompt',queued:true,ackSent:true,createdAt:1});db.exec("INSERT INTO mirror_threads VALUES('t','p','title',10,1,1); COMMIT");}finally{db.close();}const p=await proposePublication(path,{proposal_id:proposal,job_id:'job',application_id:3n,review_text:'review',review_context:{},now:10,expires_at:20});await bindPublicationDelivery(path,proposal,4n,p.review_sha256,11);await run(path);});}
const payload=(decision:PublicationDecision='ApproveExact',revision=1n)=>({version:1n,work:{Component:{RecoveryPublicationDecision:{proposal_id:proposal,revision,decision}}}});
function click(path:string,event=5n,decision:PublicationDecision='ApproveExact'){const id='interaction:'+event;edit(path,db=>db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at) VALUES(?,'interaction',?,3,1,2,4,?,'runtime','executing','processing','t',11,11)`).run(id,event,serializeSerdeValue(payload(decision))));return id;}
const consent=(path:string,ingress='interaction:5',now=12,revision=1n)=>recordPublicationConsent(path,{proposal_id:proposal,revision,ingress_id:ingress,now});
const count=(path:string)=>edit(path,db=>db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_decisions').get()!.n);
test('ApproveExact and KeepHeld record immutable intent without consuming Pending or starting work',async()=>{
 for(const decision of ['ApproveExact','KeepHeld'] as const)await fixture(async path=>{click(path,5n,decision);assert.deepEqual(await consent(path),{decision,original_ingress_id:'interaction:5',original_interaction_id:5n,already_recorded:false});assert.equal(count(path),1);edit(path,db=>{assert.equal(db.prepare('SELECT state FROM codex_turn_queue').get()!.state,'pending');assert.equal(db.prepare('SELECT state FROM discord_ingress_journal').get()!.state,'executing');assert.throws(()=>db.exec("UPDATE cdr_recovery_publication_decisions SET decision='keep_held'"),/immutable/);});});
});
test('exact original completed replay survives expiry and changed evidence without new intent',()=>fixture(async path=>{
 click(path);await consent(path);edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done'; UPDATE codex_turn_queue SET last_error='changed'"));const repeated=await consent(path,'interaction:5',100);assert.equal(repeated.already_recorded,true);assert.equal(repeated.original_interaction_id,5n);assert.equal(count(path),1);assert.equal((await consent(path,'interaction:5',NaN)).already_recorded,true);
}));
test('different click can observe same original decision only with live custody and freshness',()=>fixture(async path=>{
 click(path);await consent(path);click(path,6n);assert.deepEqual(await consent(path,'interaction:6'),{decision:'ApproveExact',original_ingress_id:'interaction:5',original_interaction_id:5n,already_recorded:true});await assert.rejects(()=>consent(path,'interaction:6',20),/expired/);edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='held' WHERE event_id=6"));await assert.rejects(()=>consent(path,'interaction:6'),/no current unowned/);assert.equal(count(path),1);
}));
test('conflicting decisions never overwrite existing consent',()=>fixture(async path=>{
 click(path);await consent(path);click(path,6n,'KeepHeld');await assert.rejects(()=>consent(path,'interaction:6'),/conflicting overwrite/);assert.equal(count(path),1);
}));
test('all durable actor/application/message/target/runtime bindings are rechecked',async()=>{
 for(const sql of ["kind='message'","event_id=0","application_id=9","channel_id=9","owner_user_id=9","source_message_id=9","target_thread_id='other'","runtime_id=NULL","runtime_id=' '"])await fixture(async path=>{click(path);edit(path,db=>db.exec('UPDATE discord_ingress_journal SET '+sql));await assert.rejects(()=>consent(path),/binding changed/);assert.equal(count(path),0);});
});
test('unowned executing processing custody is required for a first decision',async()=>{
 for(const sql of ["state='held'","state='completed'","phase='done'","owner_kind='job'","owner_id='job'"])await fixture(async path=>{click(path);edit(path,db=>db.exec('UPDATE discord_ingress_journal SET '+sql));await assert.rejects(()=>consent(path),/no current unowned/);assert.equal(count(path),0);});
});
test('component identity is exact including version numeric kind, revision and extra work fields',async()=>{
 for(const value of [{...payload(),version:1},{...payload(),work:{...payload().work,extra:true}},payload('ApproveExact',2n),{version:1n,work:{Component:{RecoveryPublicationDecision:{proposal_id:proposal,revision:1n,decision:'yes'}}}}])await fixture(async path=>{click(path);edit(path,db=>db.prepare('UPDATE discord_ingress_journal SET payload_json=?').run(serializeSerdeValue(value)));await assert.rejects(()=>consent(path),/component|binding changed/);assert.equal(count(path),0);});
});
test('missing or oversized ingress and malformed JSON fail closed before a decision',async()=>{
 await fixture(async path=>{await assert.rejects(()=>consent(path));assert.equal(count(path),0);});
 for(const raw of ['{',serializeSerdeValue({...payload(),padding:'x'.repeat(131072)})])await fixture(async path=>{click(path);edit(path,db=>db.prepare('UPDATE discord_ingress_journal SET payload_json=?').run(raw));await assert.rejects(()=>consent(path));assert.equal(count(path),0);});
});
test('expiry, changed local evidence and revision mismatch reject first intent',async()=>{
 await fixture(async path=>{click(path);await assert.rejects(()=>consent(path,'interaction:5',20),/expired/);await assert.rejects(()=>consent(path,'interaction:5',12,2n),/revision differs/);edit(path,db=>db.exec("UPDATE codex_turn_queue SET last_error='changed'"));await assert.rejects(()=>consent(path),/local evidence changed/);assert.equal(count(path),0);});
});
test('ignored insert and mutated ingress during commit are detected with atomic rollback',async()=>{
 await fixture(async path=>{click(path);edit(path,db=>db.exec('CREATE TRIGGER ignore_decision BEFORE INSERT ON cdr_recovery_publication_decisions BEGIN SELECT RAISE(IGNORE); END;'));await assert.rejects(()=>consent(path),/insert was ignored/);assert.equal(count(path),0);});
 await fixture(async path=>{click(path);edit(path,db=>db.exec("CREATE TRIGGER change_ingress AFTER INSERT ON cdr_recovery_publication_decisions BEGIN UPDATE discord_ingress_journal SET phase='changed'; END;"));await assert.rejects(()=>consent(path),/interaction changed/);assert.equal(count(path),0);assert.equal(edit(path,db=>db.prepare('SELECT phase FROM discord_ingress_journal').get()!.phase),'processing');});
});
test('post-insert changed local evidence is rolled back with the decision',()=>fixture(async path=>{
 click(path);edit(path,db=>db.exec("CREATE TRIGGER change_queue AFTER INSERT ON cdr_recovery_publication_decisions BEGIN UPDATE codex_turn_queue SET last_error='changed'; END;"));await assert.rejects(()=>consent(path),/local evidence changed/);assert.equal(count(path),0);assert.equal(edit(path,db=>db.prepare('SELECT last_error FROM codex_turn_queue').get()!.last_error),'');
}));
test('an exact replay never exempts changed authenticated identity',()=>fixture(async path=>{
 click(path);await consent(path);edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done',owner_user_id=9"));await assert.rejects(()=>consent(path,'interaction:5',100),/binding changed/);assert.equal(count(path),1);
}));
test('wrong timestamp persisted by an insert trigger cannot create consent',()=>fixture(async path=>{
 click(path);edit(path,db=>db.exec(`CREATE TRIGGER replace_decision BEFORE INSERT ON cdr_recovery_publication_decisions WHEN NEW.recorded_at_bits!='wrong' BEGIN INSERT INTO cdr_recovery_publication_decisions VALUES(NEW.proposal_id,NEW.revision,NEW.ingress_id,NEW.interaction_id,NEW.decision,'wrong'); SELECT RAISE(IGNORE); END;`));await assert.rejects(()=>consent(path),/insert was altered/);assert.equal(count(path),0);
}));
